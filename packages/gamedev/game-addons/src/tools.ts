/**
 * The model-facing `game_addons` tool: search the curated catalog of Godot and Blender add-ons, read an add-on's
 * usage guide, install or remove one in the game project, and list what the project has. A search without words or
 * filters returns the catalog's index, a few words on every add-on by category; one with an id, a category, or words
 * describes the best matches in full, so no result grows with the catalog. One set of definitions
 * serves the Session's own agent, whose project paths are relative to its working directory, and agents connected
 * through WASD Engine's MCP server, which name projects by absolute path and call the Blender, GIMP, and SuperCollider
 * tools by other names, which their guides and notes use. A guide comes with the `references/` files it links, and the
 * guides that go with the add-ons without being one's, such as the order in which a 3D game's look is built, show by
 * name and close the index. The agent decides when to install or remove an add-on: neither action asks the user. An
 * add-on that the user turned off in the Add-ons dialog is missing from searches, its guide and installation are
 * refused, the list marks it, and a guide that goes with the add-ons names it as turned off.
 * @module @deepseek-ai/dsh-game-addons/src/tools
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { CATEGORIES, GUIDE_FILE, guideReferences, parseGuide, type CatalogGuide } from './catalog.ts'
import type { GameAddonManager } from './manager.ts'
import { CATEGORY_TITLES, catalogIndex, GUIDES_HEADING } from './prompt.ts'
import type { GameAddonCategory, GameAddonPresence, GameAddonStage, GameAddonView } from './types.ts'

/** Name of the tool. */
export const TOOL_NAME = 'game_addons'

/** Actions of the tool. */
export const ACTIONS = ['search', 'guide', 'install', 'remove', 'list'] as const

/**
 * Most add-ons that one search describes in full. A search without words or filters gives the catalog's index instead,
 * which says a few words of every add-on, so that no result grows with the catalog.
 */
export const SEARCH_LIMIT = 8

/** Time limit of an installation or removal: a download, unpacking, and an import of the project. */
const CHANGE_TIMEOUT_MS = 15 * 60_000

/** What the tool needs from the plugin. */
export interface GameAddonToolHost {
  /** The add-on manager. */
  readonly manager: GameAddonManager
  /** The guides that go with the add-ons without being one's, by name; action guide shows them and the index names them. */
  readonly guides: ReadonlyMap<string, CatalogGuide>
  /**
   * The game project of a call.
   * @param requested - the `project` argument, or undefined for the nearest project.
   * @param exec - the call's execution.
   * @returns the absolute folder that holds `project.godot`.
   * @throws when there is no Godot project there.
   */
  project(requested: string | undefined, exec: ToolRunContext): Promise<string>
}

/** How one surface's descriptions name projects, and how its results point to add-on guides. */
export interface GameAddonToolWording {
  /** Description of the `project` parameter. */
  readonly project: string
  /**
   * The install result's sentence on where the installed add-on's guide is.
   * @param id - the add-on id.
   * @returns the sentence.
   */
  readonly installedGuide: (id: string) => string
  /** The list result's words on where each listed add-on's guide is, after its count. */
  readonly listedGuides: string
  /**
   * A text written for the Session's agent, such as a guide or an installation note, with the names this surface's
   * agent calls the tools by.
   * @param text - the text, which names the Blender, GIMP, and SuperCollider tools as a Session lists them.
   * @returns the text with this surface's tool names.
   */
  readonly toolNames: (text: string) => string
}

/** Wording of the Session's own tool, whose agent reads an installed add-on's guide as the skill of its id. */
export const SESSION_WORDING: GameAddonToolWording = {
  project: 'Folder containing project.godot, relative to the working directory. Default: the nearest project.godot.',
  installedGuide: id => `Its guide is now the skill ${id}; load it before using the add-on.`,
  listedGuides: 'each one\'s guide is listed as the skill of its id',
  toolNames: text => text,
}

const STRING = { type: 'string', required: true } as const
const STRINGS = { type: 'array', required: true, items: { type: 'string' } } as const
const BOOLEAN = { type: 'boolean', required: true } as const

const VIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: STRING,
    title: STRING,
    host: { type: 'string', enum: ['godot', 'blender'], required: true },
    version: STRING,
    category: { type: 'string', enum: CATEGORIES, required: true },
    cue: STRING,
    summary: STRING,
    useWhen: STRING,
    avoidWhen: { type: 'string' },
    tags: STRINGS,
    stages: STRINGS,
    license: STRING,
    credit: { type: 'string' },
    homepage: STRING,
    bytes: { type: 'integer', description: 'Download size, the asset pack included.' },
    shipsWith: { type: 'string', enum: ['blender', 'app'], description: 'For an add-on without a download: blender ships inside Blender, app inside WASD Engine.' },
    assets: {
      type: 'object',
      description: 'The asset pack installed with the add-on.',
      additionalProperties: false,
      properties: { license: STRING, bytes: { type: 'integer', required: true }, homepage: STRING },
    },
    conflicts: STRINGS,
    allowed: { type: 'boolean', description: 'false when the user turned the add-on off, so agents cannot use it; absent otherwise.' },
    presence: { type: 'string', enum: ['installed', 'found', 'absent'] },
    presentVersion: { type: 'string', description: 'Version the project has, when it has the add-on.' },
  },
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ACTIONS, required: true },
    projectDir: { type: 'string' },
    addons: { type: 'array', items: VIEW_SCHEMA },
    total: { type: 'integer' },
    matched: { type: 'integer', description: 'How many add-ons a search with words or filters matched; addons holds the best of them.' },
    index: {
      type: 'array',
      description: 'The catalog by category, from a search without words or filters.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          category: { type: 'string', enum: CATEGORIES, required: true },
          title: STRING,
          addons: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { id: STRING, host: { type: 'string', enum: ['godot', 'blender'], required: true }, cue: STRING, presence: { type: 'string', enum: ['installed', 'found', 'absent'] } },
            },
          },
        },
      },
    },
    guides: {
      type: 'array',
      description: 'The guides that go with the add-ons, which action guide shows by name, from a search without words or filters.',
      items: { type: 'object', additionalProperties: false, properties: { name: STRING, description: STRING } },
    },
    guide: { type: 'object', additionalProperties: false, properties: { id: STRING, title: STRING, presence: { type: 'string', enum: ['installed', 'found', 'absent'] }, text: STRING } },
    install: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: STRING,
        title: STRING,
        version: STRING,
        license: STRING,
        unchanged: BOOLEAN,
        paths: STRINGS,
        importIssues: STRINGS,
        notes: STRINGS,
      },
    },
    remove: { type: 'object', additionalProperties: false, properties: { id: STRING, removed: STRINGS, backup: { type: 'string' }, references: STRINGS } },
  },
} as const

type ToolValue = InferValue<typeof OUTPUT_SCHEMA>
type ViewValue = InferValue<typeof VIEW_SCHEMA>

function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

function presenceFields(presence: GameAddonPresence | undefined): Pick<ViewValue, 'presence' | 'presentVersion'> {
  if (presence === undefined) return {}
  if (presence.state === 'absent') return { presence: 'absent' }
  return { presence: presence.state, ...presence.version === undefined ? {} : { presentVersion: presence.version } }
}

function viewValue(view: GameAddonView): ViewValue {
  return {
    id: view.id,
    title: view.title,
    host: view.host,
    version: view.version,
    category: view.category,
    cue: view.cue,
    summary: view.summary,
    useWhen: view.useWhen,
    ...view.avoidWhen === undefined ? {} : { avoidWhen: view.avoidWhen },
    tags: [...view.tags],
    stages: [...view.stages],
    license: view.license,
    ...view.credit === undefined ? {} : { credit: view.credit },
    homepage: view.homepage,
    ...view.bytes === undefined ? {} : { bytes: view.bytes },
    ...view.shipsWith === undefined ? {} : { shipsWith: view.shipsWith },
    ...view.assets === undefined ? {} : { assets: { ...view.assets } },
    conflicts: [...view.conflicts],
    ...view.allowed ? {} : { allowed: false },
    ...presenceFields(view.presence),
  }
}

function sizeText(view: ViewValue): string {
  const bytes = view.bytes
  // Nothing is downloaded for an add-on inside Blender, or for one that WASD Engine wrote and ships.
  if (bytes === undefined) return view.shipsWith === 'blender' ? 'ships inside Blender' : 'ships with WASD Engine'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function assetsText(view: ViewValue): string {
  return view.assets === undefined ? '' : ` with ${view.assets.license} assets`
}

function presenceText(view: ViewValue): string {
  if (view.presence === 'installed') return `installed${view.presentVersion === undefined || view.presentVersion === view.version ? '' : ` (${view.presentVersion})`}`
  if (view.presence === 'found') return `in addons/ without a WASD Engine record${view.presentVersion === undefined ? '' : ` (version ${view.presentVersion})`}`
  if (view.presence === 'absent') return 'not installed'
  return ''
}

/** The search result when the user turned off every add-on. */
const NONE_ALLOWED = 'The user turned off every catalog add-on in WASD Engine\'s Add-ons dialog, so agents cannot use any. Do the work without add-ons, or ask the user to turn the ones it needs on there.'

function renderView(view: ViewValue): string {
  const state = [presenceText(view), ...view.allowed === false ? ['turned off by the user'] : []].filter(part => part !== '').join(', ')
  return [
    `- ${view.id}: ${view.title} ${view.version} (${view.host === 'godot' ? 'Godot' : 'Blender'}, ${view.license}, ${sizeText(view)}${assetsText(view)})${state === '' ? '' : ` [${state}]`}`,
    `  ${view.summary}`,
    `  Use when: ${view.useWhen}`,
    ...view.avoidWhen === undefined ? [] : [`  Skip when: ${view.avoidWhen}`],
    ...view.conflicts.length === 0 ? [] : [`  Instead of: ${view.conflicts.join(', ')}`],
    ...view.credit === undefined ? [] : [`  Required credit: ${view.credit}`],
  ].join('\n')
}

function render(value: ToolValue, wording: GameAddonToolWording): string {
  switch (value.action) {
    case 'search': {
      if (value.total === 0) return NONE_ALLOWED
      const where = value.projectDir === undefined ? '' : ` for ${value.projectDir}`
      if (value.index !== undefined) {
        const groups = value.index.map(group => [
          `${group.title} (${group.category})`,
          ...group.addons.map((addon) => {
            const state = addon.presence === 'installed' ? ' [installed]' : addon.presence === 'found' ? ' [in addons/ without a WASD Engine record]' : ''
            return `- ${addon.id}${addon.host === 'blender' ? ' (Blender)' : ''}: ${addon.cue}${state}`
          }),
        ].join('\n'))
        const guides = (value.guides ?? []).map(guide => `- ${guide.name}: ${guide.description}`)
        return `The catalog's ${value.total ?? 0} add-ons${where}, under their categories, with what each is for:\n${groups.join('\n')}\n`
          + 'Search with an add-on\'s id, a category, or words for when it helps, when to skip it, its size, license, and conflicts; read its guide with action guide, or install it with action install.'
          + (guides.length === 0 ? '' : `\n${GUIDES_HEADING}\n${guides.join('\n')}`)
      }
      const addons = value.addons ?? []
      if (addons.length === 0) return 'No catalog add-on matches. Search with other words, or without a query for the catalog\'s index; Godot and Blender may already do this without an add-on.'
      const matched = value.matched ?? addons.length
      const head = matched > addons.length
        ? `The best ${addons.length} of ${matched} matching add-ons${where}; narrow the search with more words or a category to see the others:`
        : `${addons.length} matching add-on${addons.length === 1 ? '' : 's'}${where}:`
      return `${head}\n${addons.map(renderView).join('\n')}\nRead one with action guide, or install it with action install.`
    }
    case 'list': {
      const addons = value.addons ?? []
      if (addons.length === 0) return `${value.projectDir ?? 'This project'} has no catalog add-ons. Search the catalog with action search.`
      const off = addons.some(view => view.allowed === false) ? ', except the ones the user turned off, which agents cannot use' : ''
      return `${value.projectDir ?? 'The project'} has ${addons.length} catalog add-on${addons.length === 1 ? '' : 's'}; ${wording.listedGuides}${off}:\n${addons.map(renderView).join('\n')}`
    }
    case 'guide': {
      const guide = value.guide
      if (guide === undefined) return 'No guide.'
      const state = guide.presence === 'absent' ? `${guide.title} is not installed in this project; install it with action install before following this guide.\n\n` : ''
      return `${state}${guide.text}`
    }
    case 'install': {
      const install = value.install
      if (install === undefined) return 'Nothing was installed.'
      const lines = [
        install.unchanged
          ? `${install.title} ${install.version} was already installed${value.projectDir === undefined ? '' : ` in ${value.projectDir}`}; nothing was downloaded.`
          : `Installed ${install.title} ${install.version} (${install.license})${value.projectDir === undefined ? '' : ` in ${value.projectDir}`}${install.paths.length === 0 ? '' : `: ${install.paths.join(', ')}`}.`,
        wording.installedGuide(install.id),
        ...install.notes,
        ...install.unchanged ? [] : ['Tell the user that you added it and why, with its license.'],
      ]
      if (install.importIssues.length > 0) lines.push(`The project's import reported:\n${install.importIssues.map(issue => `- ${issue}`).join('\n')}`)
      return lines.join('\n')
    }
    case 'remove': {
      const removed = value.remove
      if (removed === undefined) return 'Nothing was removed.'
      const moved = removed.backup === undefined || removed.removed.length === 0 ? '' : ` Its files moved to the backup ${removed.backup}: ${removed.removed.join(', ')}.`
      const lines = [`Removed ${removed.id} and its project.godot entries and notice.${moved}`]
      if (removed.references.length > 0) lines.push(`These files still use it and need changes:\n${removed.references.map(path => `- ${path}`).join('\n')}`)
      return lines.join('\n')
    }
  }
}

function stageOf(value: string | undefined): GameAddonStage | undefined {
  return value === 'prototype' || value === 'content' || value === 'polish' || value === 'ship' ? value : undefined
}

function categoryOf(value: string | undefined): GameAddonCategory | undefined {
  return CATEGORIES.find(category => category === value)
}

function requireId(id: string | undefined, action: string): string {
  if (id === undefined || id === '') throw new Error(`action ${action} needs id, a catalog add-on id from action search.`)
  return id
}

/**
 * A guide as action guide shows it: its text, then each file of its folder that it links, which the result's reader
 * cannot open through the link, all with the names this surface's agent calls the tools by.
 * @param folder - absolute folder of the guide.
 * @param body - the guide's Markdown.
 * @param wording - the surface's wording.
 * @returns the text.
 */
async function guideText(folder: string, body: string, wording: GameAddonToolWording): Promise<string> {
  const files = await Promise.all(guideReferences(body).map(async (reference) => {
    const text = await readFile(join(folder, ...reference.split('/')), 'utf8')
    return `The file ${reference}, which this guide links:\n\n${text.trim()}`
  }))
  return wording.toolNames([body.trim(), ...files].join('\n\n'))
}

/**
 * Build the `game_addons` tool definition for one surface.
 * @param host - the manager and the project resolution of this surface.
 * @param wording - how the descriptions name projects and the results point to add-on guides.
 * @returns the definition, not registered.
 */
export function gameAddonToolDefinition(host: GameAddonToolHost, wording: GameAddonToolWording): ToolDefinition {
  return defineTool({
    name: TOOL_NAME,
    description: 'Curated add-ons for the game, WASD Engine\'s own and third-party ones, each pinned to a version tested with this Godot (GDScript only, so Web releases keep working) or Blender: lighting, sky, weather, terrain, water, grass, scattering, roads, and dungeons; materials, effects, light shafts, mirrors, trails, fur, surface marks, and screen looks; humans, rigs, animations, a character controller, and crowds; cloth, ropes, ragdolls, vehicles, and destruction; AI, state charts, dialogue, and inventories; cameras and shake; menus, HUD, loading screens, and button prompts; 2D levels; starter kits; texture baking; and tests. '
      + 'action search without words gives the catalog\'s index, a few words on every add-on by category; with an add-on\'s id, a category, or words it says when each match helps, when to skip it, and whether the project has it. guide shows an add-on\'s usage guide, or a guide that a search without words lists; install adds one to the project; remove takes one out of the project; list shows the project\'s add-ons. '
      + 'Install an add-on yourself, without asking the user first, when the game needs what it does and Godot or Blender alone would take much longer; then tell the user what you added and its license.',
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true, description: 'search, guide, install, remove, or list.' },
      query: { type: 'string', description: 'For search: an add-on id, or what the game needs, such as "camera follow" or "dialogue". Default: the catalog\'s index.' },
      category: { type: 'string', enum: CATEGORIES, description: 'For search: only add-ons of this category, as the index names it.' },
      host: { type: 'string', enum: ['godot', 'blender'], description: 'For search: only Godot or only Blender add-ons.' },
      stage: { type: 'string', enum: ['prototype', 'content', 'polish', 'ship'], description: 'For search: only add-ons for this stage of the game.' },
      id: { type: 'string', description: 'For guide, install, and remove: the add-on id from search; for guide also the name of a guide that a search without words lists.' },
      replace: { type: 'boolean', description: 'For install: replace a copy of the add-on that is already in addons/ without a WASD Engine record. Default: false.' },
      project: { type: 'string', description: wording.project },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(render(value, wording)),
    },
    timeoutMs: CHANGE_TIMEOUT_MS,
    isConcurrencySafe: args => (args as { action?: unknown }).action !== 'install' && (args as { action?: unknown }).action !== 'remove',
    async execute(args, exec): Promise<ToolValue> {
      const { manager } = host
      switch (args.action) {
        case 'search': {
          const projectDir = await host.project(args.project, exec).catch(() => undefined)
          const stage = stageOf(args.stage)
          const category = categoryOf(args.category)
          const total = manager.allowedEntries().length
          const narrowed = (args.query ?? '').trim() !== '' || args.host !== undefined || stage !== undefined || category !== undefined
          if (!narrowed) {
            const presence = projectDir === undefined ? undefined : await manager.presence(projectDir)
            const index = catalogIndex(manager.allowedEntries()).map(group => ({
              category: group.category,
              title: CATEGORY_TITLES[group.category],
              addons: group.entries.map((addon) => {
                const state = presence?.get(addon.id)?.state
                return { id: addon.id, host: addon.host, cue: addon.cue, ...state === undefined || state === 'absent' ? {} : { presence: state } }
              }),
            }))
            const guides = [...host.guides.values()].map(guide => ({ name: guide.name, description: guide.description }))
            return { action: 'search', ...projectDir === undefined ? {} : { projectDir }, total, index, ...guides.length === 0 ? {} : { guides } }
          }
          const matches = await manager.search({
            ...args.query === undefined ? {} : { text: args.query },
            ...args.host === undefined ? {} : { host: args.host },
            ...stage === undefined ? {} : { stage },
            ...category === undefined ? {} : { category },
          }, projectDir)
          return { action: 'search', ...projectDir === undefined ? {} : { projectDir }, total, matched: matches.length, addons: matches.slice(0, SEARCH_LIMIT).map(viewValue) }
        }
        case 'list': {
          const projectDir = await host.project(args.project, exec)
          const views = await manager.views(projectDir)
          return { action: 'list', projectDir, addons: views.filter(view => view.presence !== undefined && view.presence.state !== 'absent').map(viewValue) }
        }
        case 'guide': {
          const id = requireId(args.id, 'guide')
          const own = host.guides.get(id)
          if (own !== undefined) {
            // A guide that names add-ons the user turned off says so, since agents cannot use them.
            const off = manager.catalog.entries.filter(addon => !manager.allowed(addon.id) && own.body.includes(`\`${addon.id}\``)).map(addon => addon.id)
            const note = off.length === 0 ? '' : `The user turned off ${off.join(', ')} in WASD Engine's Add-ons dialog, so agents cannot use ${off.length === 1 ? 'it' : 'them'}: do ${off.length === 1 ? 'its' : 'their'} steps without ${off.length === 1 ? 'it' : 'them'}.\n\n`
            return { action: 'guide', guide: { id, title: id, text: `${note}${await guideText(own.folder, own.body, wording)}` } }
          }
          const addon = manager.usableEntry(id)
          const projectDir = await host.project(args.project, exec).catch(() => undefined)
          const presence = projectDir === undefined ? undefined : (await manager.presence(projectDir)).get(id)
          const folder = manager.catalog.folder(id)
          const path = join(folder, GUIDE_FILE)
          const guide = parseGuide(await readFile(path, 'utf8'), path)
          return {
            action: 'guide',
            ...projectDir === undefined ? {} : { projectDir },
            guide: {
              id,
              title: addon.title,
              ...presence === undefined ? {} : { presence: presence.state },
              text: await guideText(folder, guide.body, wording),
            },
          }
        }
        case 'install': {
          const id = requireId(args.id, 'install')
          const projectDir = await host.project(args.project, exec)
          const deadline = AbortSignal.any([exec.signal, AbortSignal.timeout(CHANGE_TIMEOUT_MS)])
          const result = await manager.install(projectDir, id, { replace: args.replace === true }, deadline)
          return {
            action: 'install',
            projectDir,
            install: {
              id: result.addon.id,
              title: result.addon.title,
              version: result.addon.version,
              license: result.addon.license,
              unchanged: result.unchanged,
              paths: [...result.addon.paths],
              importIssues: [...result.importIssues],
              notes: result.notes.map(note => wording.toolNames(note)),
            },
          }
        }
        case 'remove': {
          const id = requireId(args.id, 'remove')
          const projectDir = await host.project(args.project, exec)
          const result = await manager.remove(projectDir, id, exec.signal)
          return { action: 'remove', projectDir, remove: { id: result.id, removed: [...result.removed], ...result.backup === undefined ? {} : { backup: result.backup }, references: [...result.references] } }
        }
      }
    },
  })
}
