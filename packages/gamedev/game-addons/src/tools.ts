/**
 * The model-facing `game_addons` tool: search the curated catalog of Godot and Blender add-ons, read an add-on's
 * usage guide, install or remove one in the game project, and list what the project has. One set of definitions
 * serves the Session's own agent, whose project paths are relative to its working directory, and agents connected
 * through WASD Engine's MCP server, which name projects by absolute path. Installing and removing ask the user first
 * when the Session's approval policy asks.
 * @module @deepseek-ai/dsh-game-addons/src/tools
 */
import { basename, join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type InferValue, type PreToolDecision, type ToolDefinition, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'
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
    remove: { type: 'object', additionalProperties: false, properties: { id: STRING, removed: STRINGS, references: STRINGS } },
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
      return `${head}\n${addons.map(renderView).join('\n')}\nRead one with action guide, or install it with action install; tell the user its license first.`
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
      ]
      if (install.importIssues.length > 0) lines.push(`The project's import reported:\n${install.importIssues.map(issue => `- ${issue}`).join('\n')}`)
      return lines.join('\n')
    }
    case 'remove': {
      const removed = value.remove
      if (removed === undefined) return 'Nothing was removed.'
      const lines = [`Removed ${removed.id}${removed.removed.length === 0 ? '' : `: deleted ${removed.removed.join(', ')}`}, and its project.godot entries and notice.`]
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
    description: 'Curated third-party add-ons for the game, each pinned to a version tested with this Godot (GDScript only, so Web releases keep working) or Blender: cameras, dialogue, behavior trees, state charts, inventories, unit tests, tile terrain, importers for Tiled, LDtk, and sprite editors, sky, scattering, and for Blender rigging, humans, trees, landscapes, and VRM. '
      + 'action search finds add-ons for a need and says when each helps and whether the project has it; guide shows an add-on\'s usage guide; install adds one to the project, asking the user first, after which its guide is the skill named by its id; remove deletes one; list shows the project\'s add-ons. '
      + 'Prefer what Godot and Blender already do: suggest an add-on only when it replaces a system the game would otherwise build, install only what the user agreed to, and tell the user its license.',
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
          return { action: 'remove', projectDir, remove: { id: result.id, removed: [...result.removed], references: [...result.references] } }
        }
      }
    },
  })
}

/** The fields of a call that its approval question names. */
export interface ChangeCall {
  readonly action: 'install' | 'remove'
  readonly id: string
  readonly project?: string
}

function changeCall(args: unknown): ChangeCall | undefined {
  if (typeof args !== 'object' || args === null) return undefined
  const { action, id, project } = args as Record<string, unknown>
  if ((action !== 'install' && action !== 'remove') || typeof id !== 'string') return undefined
  return { action, id, ...typeof project === 'string' ? { project } : {} }
}

/**
 * The approval question of one installation or removal, naming the add-on, its license, its download, and the project.
 * @param manager - the add-on manager.
 * @param call - the call's action, id, and project.
 * @param projectName - the project folder's name, or undefined when it cannot be resolved.
 * @returns the question, or undefined for an unknown id, which the tool itself refuses.
 */
export function approvalQuestion(manager: GameAddonManager, call: ChangeCall, projectName: string | undefined): string | undefined {
  const addon = manager.catalog.get(call.id)
  if (addon === undefined) return undefined
  const where = projectName === undefined ? 'the game project' : `the game project ${projectName}`
  if (call.action === 'remove') {
    return `Remove ${addon.title} from ${where}? ${addon.host === 'godot' ? `This deletes addons/${addon.godot?.addonDir ?? ''} and its project.godot entries; scenes and scripts that use it stop working.` : 'Its guide leaves the project; the Blender add-on stays downloaded for other projects.'}`
  }
  const assets = addon.assets === undefined
    ? ''
    : ` With it comes an asset pack (${addon.assets.license}, ${addon.assets.homepage}): ${sizeText(addon.assets.bytes)} from ${new URL(addon.assets.url).host}.`
  const download = addon.archive === undefined
    ? 'It ships inside Blender, so nothing is downloaded.'
    : `It downloads ${sizeText(addon.archive.bytes)} from ${new URL(addon.archive.url).host}.${assets}`
  const runs = addon.host === 'godot' ? ' Its scripts become part of the game and run whenever the project is imported or played.' : ' Its Python code runs inside Blender when the agent enables it.'
  const credit = addon.credit === undefined ? '' : ` Its license requires a credit in the game: ${addon.credit}.`
  return `Install ${addon.title} ${addon.version} (${addon.license}, ${addon.homepage}) into ${where}? ${download}${runs}${credit}`
}

/**
 * Ask the user before an installation or removal when the Session's approval policy asks; under the `never` policy
 * the call proceeds, as other tools do under full access. Later listeners decide first, and a stricter decision
 * of theirs wins.
 * @param ctx - plugin context; the listener lives as long as it.
 * @param manager - the add-on manager.
 * @param projectName - the folder name of a call's project, or undefined when it cannot be resolved.
 */
export function registerApproval(
  ctx: Context,
  manager: GameAddonManager,
  projectName: (call: ChangeCall, exec: ToolExecution) => Promise<string | undefined>,
): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const downstream = await next()
    if (exec.name !== TOOL_NAME || downstream.kind !== 'allow' || exec.agent === undefined) return downstream
    const call = changeCall(exec.arguments)
    if (call === undefined) return downstream
    const approval = ctx.get('approval')
    const policy = approval?.overrideOf(exec.agent.session) ?? approval?.config.policy ?? 'ask'
    if (policy === 'never') return downstream
    const question = approvalQuestion(manager, call, await projectName(call, exec).catch(() => undefined))
    if (question === undefined) return downstream
    return { kind: 'ask', reason: question }
  })
}

/**
 * The folder name of a project for approval questions.
 * @param projectDir - absolute project folder.
 * @returns its last path segment.
 */
export function projectLabel(projectDir: string): string {
  return basename(projectDir)
}
