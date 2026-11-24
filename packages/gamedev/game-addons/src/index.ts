/**
 * Game add-ons: a curated catalog of Godot add-ons and Blender add-ons, WASD Engine's own and third-party ones, each
 * pinned to an archive and a SHA-256 or shipped in the catalog, and verified with WASD Engine's Godot and Blender,
 * offered to the agent through one `game_addons` tool. The `game-addons` system prompt section lists every add-on that
 * agents may use under its category with a few words on its use, and the agent installs one when it decides that the
 * game needs it, without asking the user. Installing one unpacks it into the game project (Godot) or the shared Blender
 * add-on store, records it in the project's `.wasdengine/addons.json`, and makes its usage guide a skill of the
 * Sessions in that project; projects without it never list the guide. The `gameAddons` Remote serves the Session
 * header's Add-ons dialog, whose switches write the `allowed` setting: an add-on that the user turned off there leaves
 * the prompt section, the searches, and the guides, and agents can no longer install it or enable it in Blender. Agents
 * connected through WASD Engine's MCP server get the same tool, whose search gives them the catalog's index, and the
 * guides that go with the add-ons, such as the order in which a 3D game's look is built, through its guide action.
 * @module @deepseek-ai/dsh-game-addons
 */
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Service, type Context, type Volatile } from '@deepseek-ai/cordis'
// Type-only: the Loader's `loader/volatile-update` event and `fiber.entry`, and `ctx.settings`.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { resolveGodotProject } from '@deepseek-ai/dsh-godot'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import { bundledArchivesDir } from './archive.ts'
import { loadCatalog, loadGuides } from './catalog.ts'
import { GameAddonManager, type ImportReport } from './manager.ts'
import { gameAddonMcpProvider } from './mcp.ts'
import { PROMPT_SECTION, sessionPrompt } from './prompt.ts'
import { gameAddonSkillProvider } from './skills.ts'
import { gameAddonToolDefinition, SESSION_WORDING, type GameAddonToolHost } from './tools.ts'
import type { GameAddon, GameAddonsProjectView } from './types.ts'

export type * from './types.ts'
export { GameAddonCatalogError, loadCatalog, parseGuide, searchCatalog } from './catalog.ts'
export { GameAddonError, GameAddonManager, STORE_INDEX, STORE_MARKER } from './manager.ts'
export { GameAddonRecordError, readRecord, RECORD_FILE, STATE_DIR } from './record.ts'
export { NOTICES_FILE } from './notices.ts'
export { ProjectFile } from './project-file.ts'
export { ADDON_SKILL_RANK, SKILL_PROVIDER_NAME } from './skills.ts'
export { TOOL_NAME } from './tools.ts'

/** Plugin configuration. */
export interface Config {
  /** Absolute catalog folder: one folder per add-on with `addon.json` and `SKILL.md`. */
  catalogDir: string
  /** Absolute folder of the plugin's data: the archive cache under `archives/` and Blender asset packs under `blender-assets/`. */
  dataRoot: string
  /** Absolute folder of the Blender add-on store, which the Blender plugin's `addonStore` names too. */
  blenderStore: string
  /**
   * Absolute paths of the `SKILL.md` files of guides that go with the add-ons without being one's, such as the order in
   * which a 3D game's look is built with them: action guide shows each by the name in its frontmatter, and a search
   * without words and the MCP server's instructions list each with its description.
   */
  guides: string[]
  /** Time limit of one archive download, including its body. */
  downloadTimeoutMs: number
  /**
   * Whether agents may use each catalog add-on, by id; an add-on without an entry is on. The Add-ons dialog's switches
   * write it while the app runs, and a change applies to the next model step and tool call.
   */
  allowed: Volatile<Readonly<Record<string, boolean>>>
}

/** The configuration as a profile writes it, before the Loader turns `allowed` into a reference. */
type ConfigInput = Partial<Omit<Config, 'allowed'>> & Pick<Config, 'catalogDir' | 'dataRoot' | 'blenderStore'> & {
  allowed?: Readonly<Record<string, boolean>>
}

/** The config field that the switches write. */
const ALLOWED_FIELD = 'allowed'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The curated game add-ons and their installation in game projects. */
    gameAddons: GameAddons
  }
}

/**
 * Owner of the add-on catalog, the `game_addons` tool, the `game-addons` system prompt section, the add-on guides'
 * skill provider, the user's add-on switches, and the `gameAddons` Remote.
 */
export default class GameAddons extends TypertRemoteService {
  static inject = ['tools', 'systemPrompt', 'workingDirectory', 'skills', 'typert']
  static Config: z<ConfigInput, Config> = z.object({
    catalogDir: z.string().required(),
    dataRoot: z.string().required(),
    blenderStore: z.string().required(),
    guides: z.array(z.string().min(1)).default([]),
    downloadTimeoutMs: z.natural().min(1).max(2_147_483_647).default(600_000),
    allowed: z.dict(z.boolean()).default({}).volatile(),
  })

  private manager!: GameAddonManager
  /** Profile entry id whose `allowed` the switches write; undefined when the plugin runs without the Loader. */
  private readonly entryId: string | undefined
  /** Ends waits for the store's locks when the plugin stops. */
  private readonly lifetime = new AbortController()

  /**
   * @param ctx - plugin context; the tool, provider, and Remote live as long as it.
   * @param config - validated configuration.
   * @throws Error when a folder is not absolute.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'gameAddons', { namespace: 'gameAddons' })
    for (const key of ['catalogDir', 'dataRoot', 'blenderStore'] as const) {
      if (!isAbsolute(config[key])) throw new Error(`Game add-ons plugin: ${key} must be an absolute path, got ${JSON.stringify(config[key])}.`)
    }
    this.entryId = ctx.fiber.entry?.options.id
    ctx.effect(() => () => { this.lifetime.abort(new Error('The game add-ons plugin stopped.')) }, 'game-addons: lifetime')
  }

  /** Load the catalog, so an invalid one stops the plugin, then register the tool, the prompt section, and the guides. */
  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const catalog = await loadCatalog(this.config.catalogDir)
    const guides = await loadGuides(this.config.guides, catalog)
    let invalidate: (() => void) | undefined
    this.manager = new GameAddonManager({
      catalog,
      downloads: {
        cacheDir: join(this.config.dataRoot, 'archives'),
        // The Desktop app's packaging puts the archives of the catalog's bundled entries in this package's archives folder.
        bundledDir: bundledArchivesDir(resolve(fileURLToPath(new URL('..', import.meta.url)))),
        fetch: (url, signal) => fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.downloadTimeoutMs)]), headers: { 'User-Agent': 'WASD Engine' } }),
      },
      blenderStore: this.config.blenderStore,
      assetsDir: join(this.config.dataRoot, 'blender-assets'),
      importProject: (projectDir, signal) => this.importProject(projectDir, signal),
      now: () => new Date(),
      changed: () => { invalidate?.() },
      allowed: id => this.config.allowed.get()[id] !== false,
    })
    this.warnUnknownSwitches()
    // Every start writes the index and the setup script copies anew, which also replaces an index that an earlier
    // version wrote with catalog paths that Blender workers cannot read.
    await this.manager.writeStoreIndex(this.lifetime.signal)
    const host: GameAddonToolHost = {
      manager: this.manager,
      guides,
      project: async (requested, exec) => (await resolveGodotProject(await this.base(requested, exec), requested, exec.signal)).dir,
    }
    ctx.tools.register(gameAddonToolDefinition(host, SESSION_WORDING))
    // The Godot games section's slot. The text changes only with the shipped catalog and the user's switches, so it
    // stays in the cached prefix between switch changes.
    ctx.systemPrompt.section({ name: PROMPT_SECTION, order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text: () => sessionPrompt(this.manager.allowedEntries()), interpolate: false })
    ctx.skills.registerProvider((control) => {
      invalidate = control.invalidate
      return gameAddonSkillProvider(this.manager, async (cwd, signal) => {
        try {
          return (await resolveGodotProject(cwd, undefined, signal ?? AbortSignal.timeout(30_000))).dir
        } catch {
          // A working directory without a Godot project lists no guides.
          return undefined
        }
      }, control).provider
    })
    // A switch change reaches the guides and the Blender workers' index; the prompt section reads the switches itself.
    ctx.on('loader/volatile-update', (paths) => {
      if (!paths.some(path => path[0] === ALLOWED_FIELD)) return
      this.warnUnknownSwitches()
      invalidate?.()
      this.manager.writeStoreIndex(this.lifetime.signal).catch((error: unknown) => {
        if (this.lifetime.signal.aborted) return
        ctx.logger.warn(`game-addons: the Blender add-on index could not follow the switches: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    // Agents connected through WASD Engine's MCP server get the same tool.
    ctx.inject(['gameMcp'], (inner) => {
      const mcpHost: GameAddonToolHost = {
        manager: this.manager,
        guides,
        project: async (requested, exec) => {
          if (requested === undefined || !isAbsolute(requested)) throw new Error('Pass project as the absolute folder that holds project.godot.')
          return (await resolveGodotProject(requested, requested, exec.signal)).dir
        },
      }
      inner.effect(() => inner.gameMcp.provide(gameAddonMcpProvider(mcpHost)), 'game-addons: game MCP tools')
    })
  }

  /**
   * The catalog add-ons that agents may use, in catalog order, for plugins that name them to the model, such as the
   * graphics review; read it for each use, since the user's switches change it. The service is reachable only once its
   * catalog loaded.
   * @returns the entries that the user has not turned off.
   */
  allowedEntries(): readonly GameAddon[] {
    return this.manager.allowedEntries()
  }

  /**
   * The catalog with whether agents may use each add-on and, when the folder holds a Godot project, each add-on's
   * presence there, for the Add-ons dialog.
   * @param directory - absolute folder: the project folder or a folder up to three levels above it.
   * @param signal - cancellation.
   * @returns the project folder when there is one, every catalog add-on, and their icons.
   * @throws Error when the folder is not an absolute path.
   */
  @Remote
  async project(directory: string, signal: AbortSignal): Promise<GameAddonsProjectView> {
    if (!isAbsolute(directory)) throw new Error('directory must be an absolute path.')
    const projectDir = await this.projectIn(directory, signal)
    return {
      ...projectDir === undefined ? {} : { projectDir },
      addons: await this.manager.views(projectDir),
      icons: this.manager.catalog.icons,
    }
  }

  /**
   * Turn an add-on on or off for agents, the Session's and connected ones, as the Add-ons dialog's switch asks. The
   * choice is saved in the `allowed` setting of the plugin's profile entry and applies without a restart, to every
   * project.
   * @param id - catalog id.
   * @param allowed - whether agents may use the add-on.
   * @returns once the setting is saved and applied.
   * @throws {RemoteError} `game-addons/unknown-addon` for an id the catalog does not have, and
   *   `game-addons/settings-unavailable` when the Host runs no Settings service or the plugin has no profile entry.
   */
  @Remote
  async setAllowed(id: string, allowed: boolean): Promise<void> {
    if (this.manager.catalog.get(id) === undefined) {
      throw new RemoteError('game-addons/unknown-addon', `No catalog add-on has the id ${JSON.stringify(id)}.`, { id })
    }
    const settings = this.ctx.get('settings')
    if (settings === undefined || this.entryId === undefined) {
      throw new RemoteError('game-addons/settings-unavailable', 'Add-on switches need the Settings service and a profile entry.', {})
    }
    await settings.mutate(this.entryId, [{ op: 'set', path: [ALLOWED_FIELD, id], value: allowed }])
  }

  /** The Godot project of a folder, or undefined when it holds none. */
  private async projectIn(directory: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      return (await resolveGodotProject(directory, undefined, signal)).dir
    } catch (error) {
      // The switches apply to every project, so a folder without one shows them without presence.
      if (error instanceof Error && error.name === 'GodotProjectError') return undefined
      throw error
    }
  }

  /** Report switches that name no catalog add-on, such as one of an add-on that a later catalog dropped. */
  private warnUnknownSwitches(): void {
    const unknown = Object.keys(this.config.allowed.get()).filter(id => this.manager.catalog.get(id) === undefined)
    if (unknown.length === 0) return
    this.ctx.logger.warn(`game-addons: ${ALLOWED_FIELD} names ${unknown.join(', ')}, which the catalog does not have; those switches change nothing.`)
  }

  /** Import a project with the Godot plugin's runtime, when the plugin is loaded. */
  private async importProject(projectDir: string, signal: AbortSignal): Promise<ImportReport | undefined> {
    const godot = this.ctx.get('godot')
    if (godot === undefined) return undefined
    const report = await godot.importProject(projectDir, signal)
    return report === undefined ? undefined : { issues: report.issues.map(issue => issue.file === undefined ? issue.message : `${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}: ${issue.message}`) }
  }

  /** The folder a call's relative paths start from: none for an absolute path, else the Session's working directory. */
  private async base(requested: string | undefined, exec: ToolRunContext): Promise<string> {
    if (requested !== undefined && isAbsolute(requested)) return resolve(requested)
    if (exec.agent === undefined) throw new Error('Pass project as an absolute path.')
    return await this.ctx.workingDirectory.ensure(exec.agent, exec.signal)
  }
}
