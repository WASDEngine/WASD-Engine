/**
 * The model-facing `game_addons` tool: search the curated catalog of Godot and Blender add-ons, read an add-on's
 * usage guide, install or remove one in the game project, and list what the project has. One set of definitions
 * serves the Session's own agent, whose project paths are relative to its working directory, and agents connected
 * through WASD Engine's MCP server, which name projects by absolute path. The agent decides when to install or remove
 * an add-on: neither action asks the user.
 * @module @deepseek-ai/dsh-game-addons/src/tools
 */
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { GUIDE_FILE, parseGuide } from './catalog.ts'
import type { GameAddonManager } from './manager.ts'
import type { GameAddonPresence, GameAddonStage, GameAddonView } from './types.ts'

/** Name of the tool. */
export const TOOL_NAME = 'game_addons'

/** Actions of the tool. */
export const ACTIONS = ['search', 'guide', 'install', 'remove', 'list'] as const

/** Time limit of an installation or removal: a download, unpacking, and an import of the project. */
const CHANGE_TIMEOUT_MS = 15 * 60_000

/** What the tool needs from the plugin. */
export interface GameAddonToolHost {
  /** The add-on manager. */
  readonly manager: GameAddonManager
  /**
   * The game project of a call.
   * @param requested - the `project` argument, or undefined for the nearest project.
   * @param exec - the call's execution.
   * @returns the absolute folder that holds `project.godot`.
   * @throws when there is no Godot project there.
   */
  project(requested: string | undefined, exec: ToolRunContext): Promise<string>
}

/** How one surface's descriptions name projects. */
export interface GameAddonToolWording {
  /** Description of the `project` parameter. */
  readonly project: string
}

/** Wording of the Session's own tool. */
export const SESSION_WORDING: GameAddonToolWording = {
  project: 'Folder containing project.godot, relative to the working directory. Default: the nearest project.godot.',
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
    summary: STRING,
    useWhen: STRING,
    avoidWhen: { type: 'string' },
    tags: STRINGS,
    stages: STRINGS,
    license: STRING,
    credit: { type: 'string' },
    homepage: STRING,
    bytes: { type: 'integer', description: 'Download size, the asset pack included.' },
    assets: {
      type: 'object',
      description: 'The asset pack installed with the add-on.',
      additionalProperties: false,
      properties: { license: STRING, bytes: { type: 'integer', required: true }, homepage: STRING },
    },
    conflicts: STRINGS,
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
    summary: view.summary,
    useWhen: view.useWhen,
    ...view.avoidWhen === undefined ? {} : { avoidWhen: view.avoidWhen },
    tags: [...view.tags],
    stages: [...view.stages],
    license: view.license,
    ...view.credit === undefined ? {} : { credit: view.credit },
    homepage: view.homepage,
    ...view.bytes === undefined ? {} : { bytes: view.bytes },
    ...view.assets === undefined ? {} : { assets: { ...view.assets } },
    conflicts: [...view.conflicts],
    ...presenceFields(view.presence),
  }
}

function sizeText(bytes: number | undefined): string {
  if (bytes === undefined) return 'ships inside Blender'
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

function renderView(view: ViewValue): string {
  const state = presenceText(view)
  return [
    `- ${view.id}: ${view.title} ${view.version} (${view.host === 'godot' ? 'Godot' : 'Blender'}, ${view.license}, ${sizeText(view.bytes)}${assetsText(view)})${state === '' ? '' : ` [${state}]`}`,
    `  ${view.summary}`,
    `  Use when: ${view.useWhen}`,
    ...view.avoidWhen === undefined ? [] : [`  Skip when: ${view.avoidWhen}`],
    ...view.conflicts.length === 0 ? [] : [`  Instead of: ${view.conflicts.join(', ')}`],
    ...view.credit === undefined ? [] : [`  Required credit: ${view.credit}`],
  ].join('\n')
}

function render(value: ToolValue): string {
  switch (value.action) {
    case 'search': {
      const addons = value.addons ?? []
      if (addons.length === 0) return 'No catalog add-on matches. Search with other words, or without a query to list the whole catalog; Godot and Blender may already do this without an add-on.'
      const head = `${addons.length} of ${value.total ?? addons.length} catalog add-ons${value.projectDir === undefined ? '' : ` for ${value.projectDir}`}:`
      return `${head}\n${addons.map(renderView).join('\n')}\nRead one with action guide, or install it with action install.`
    }
    case 'list': {
      const addons = value.addons ?? []
      if (addons.length === 0) return `${value.projectDir ?? 'This project'} has no catalog add-ons. Search the catalog with action search.`
      return `${value.projectDir ?? 'The project'} has ${addons.length} catalog add-on${addons.length === 1 ? '' : 's'}; each one's guide is listed as the skill of its id:\n${addons.map(renderView).join('\n')}`
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
        `Its guide is now the skill ${install.id}; load it before using the add-on.`,
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

function requireId(id: string | undefined, action: string): string {
  if (id === undefined || id === '') throw new Error(`action ${action} needs id, a catalog add-on id from action search.`)
  return id
}

/**
 * Build the `game_addons` tool definition for one surface.
 * @param host - the manager and the project resolution of this surface.
 * @param wording - how the descriptions name projects.
 * @returns the definition, not registered.
 */
export function gameAddonToolDefinition(host: GameAddonToolHost, wording: GameAddonToolWording): ToolDefinition {
  return defineTool({
    name: TOOL_NAME,
    description: 'Curated third-party add-ons for the game, each pinned to a version tested with this Godot (GDScript only, so Web releases keep working) or Blender: cameras, dialogue, behavior trees, state charts, inventories, unit tests, tile terrain, procedural maps, importers for Tiled, LDtk, and sprite editors, screen shake, sky, scattering, and for Blender rigging, humans, trees, landscapes, and VRM. '
      + 'action search finds add-ons for a need and says when each helps, when to skip it, and whether the project has it; guide shows an add-on\'s usage guide; install adds one to the project; remove takes one out of the project; list shows the project\'s add-ons. '
      + 'Install an add-on yourself, without asking the user first, when the game needs what it does and Godot or Blender alone would take much longer; then tell the user what you added and its license.',
    parameters: {
      action: { type: 'string', enum: ACTIONS, required: true, description: 'search, guide, install, remove, or list.' },
      query: { type: 'string', description: 'For search: what the game needs, such as "camera follow" or "dialogue". Default: the whole catalog.' },
      host: { type: 'string', enum: ['godot', 'blender'], description: 'For search: only Godot or only Blender add-ons.' },
      stage: { type: 'string', enum: ['prototype', 'content', 'polish', 'ship'], description: 'For search: only add-ons for this stage of the game.' },
      id: { type: 'string', description: 'For guide, install, and remove: the add-on id from search.' },
      replace: { type: 'boolean', description: 'For install: replace a copy of the add-on that is already in addons/ without a WASD Engine record. Default: false.' },
      project: { type: 'string', description: wording.project },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => textBlocks(render(value)),
    },
    timeoutMs: CHANGE_TIMEOUT_MS,
    isConcurrencySafe: args => (args as { action?: unknown }).action !== 'install' && (args as { action?: unknown }).action !== 'remove',
    async execute(args, exec): Promise<ToolValue> {
      const { manager } = host
      switch (args.action) {
        case 'search': {
          const projectDir = await host.project(args.project, exec).catch(() => undefined)
          const stage = stageOf(args.stage)
          const matches = await manager.search({
            ...args.query === undefined ? {} : { text: args.query },
            ...args.host === undefined ? {} : { host: args.host },
            ...stage === undefined ? {} : { stage },
          }, projectDir)
          return { action: 'search', ...projectDir === undefined ? {} : { projectDir }, total: manager.catalog.entries.length, addons: matches.map(viewValue) }
        }
        case 'list': {
          const projectDir = await host.project(args.project, exec)
          const views = await manager.search({}, projectDir)
          return { action: 'list', projectDir, addons: views.filter(view => view.presence !== undefined && view.presence.state !== 'absent').map(viewValue) }
        }
        case 'guide': {
          const id = requireId(args.id, 'guide')
          const addon = manager.entry(id)
          const projectDir = await host.project(args.project, exec).catch(() => undefined)
          const presence = projectDir === undefined ? undefined : (await manager.presence(projectDir)).get(id)
          const path = join(manager.catalog.folder(id), GUIDE_FILE)
          const guide = parseGuide(await readFile(path, 'utf8'), path)
          return {
            action: 'guide',
            ...projectDir === undefined ? {} : { projectDir },
            guide: { id, title: addon.title, ...presence === undefined ? {} : { presence: presence.state }, text: guide.body.trim() },
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
              notes: [...result.notes],
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
