/**
 * Game add-ons: a curated catalog of third-party Godot add-ons and Blender add-ons, each pinned to an archive and a
 * SHA-256 and verified with WASD Engine's Godot and Blender, offered to the agent through one `game_addons` tool. The
 * `game-addons` system prompt section lists every add-on with the stages at which it helps and when to use it, and the
 * agent installs one when it decides that the game needs it, without asking the user. Installing one unpacks it into
 * the game project (Godot) or the shared Blender add-on store, records it in the project's `.wasdengine/addons.json`,
 * and makes its usage guide a skill of the Sessions in that project; projects without it never list the guide. The
 * `gameAddons` Remote serves the Session header's Add-ons dialog, and agents connected through WASD Engine's MCP server
 * get the same tool, with the catalog in the server's instructions.
 * @module @deepseek-ai/dsh-game-addons
 */
import { isAbsolute, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveGodotProject } from '@deepseek-ai/dsh-godot'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-working-directory'
import { loadCatalog } from './catalog.ts'
import { addonView, GameAddonManager, type ImportReport } from './manager.ts'
import { gameAddonMcpProvider } from './mcp.ts'
import { PROMPT_SECTION, sessionPrompt } from './prompt.ts'
import { gameAddonSkillProvider } from './skills.ts'
import { gameAddonToolDefinition, SESSION_WORDING, type GameAddonToolHost } from './tools.ts'
import type { GameAddonInstallResult, GameAddonRemoveResult, GameAddonsProjectView } from './types.ts'

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
  /** Time limit of one archive download, including its body. */
  downloadTimeoutMs: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The curated game add-ons and their installation in game projects. */
    gameAddons: GameAddons
  }
}

/**
 * Owner of the add-on catalog, the `game_addons` tool, the `game-addons` system prompt section, the add-on guides'
 * skill provider, and the `gameAddons` Remote.
 */
export default class GameAddons extends TypertRemoteService {
  static inject = ['tools', 'systemPrompt', 'workingDirectory', 'skills', 'typert']
  static Config: z<Partial<Config> & Pick<Config, 'catalogDir' | 'dataRoot' | 'blenderStore'>, Config> = z.object({
    catalogDir: z.string().required(),
    dataRoot: z.string().required(),
    blenderStore: z.string().required(),
    downloadTimeoutMs: z.natural().min(1).max(2_147_483_647).default(600_000),
  })

  private manager!: GameAddonManager

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
  }

  /** Load the catalog, so an invalid one stops the plugin, then register the tool, the prompt section, and the guides. */
  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const catalog = await loadCatalog(this.config.catalogDir)
    let invalidate: (() => void) | undefined
    this.manager = new GameAddonManager({
      catalog,
      downloads: {
        cacheDir: join(this.config.dataRoot, 'archives'),
        fetch: (url, signal) => fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.downloadTimeoutMs)]), headers: { 'User-Agent': 'WASD Engine' } }),
      },
      blenderStore: this.config.blenderStore,
      assetsDir: join(this.config.dataRoot, 'blender-assets'),
      importProject: (projectDir, signal) => this.importProject(projectDir, signal),
      now: () => new Date(),
      changed: () => { invalidate?.() },
    })
    await this.manager.writeStoreIndex()
    const host: GameAddonToolHost = {
      manager: this.manager,
      project: async (requested, exec) => (await resolveGodotProject(await this.base(requested, exec), requested, exec.signal)).dir,
    }
    ctx.tools.register(gameAddonToolDefinition(host, SESSION_WORDING))
    // The Godot games section's slot. The text changes only with the shipped catalog, so it stays in the cached prefix.
    ctx.systemPrompt.section({ name: PROMPT_SECTION, order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'), text: sessionPrompt(catalog.entries), interpolate: false })
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
    // Agents connected through WASD Engine's MCP server get the same tool.
    ctx.inject(['gameMcp'], (inner) => {
      const mcpHost: GameAddonToolHost = {
        manager: this.manager,
        project: async (requested, exec) => {
          if (requested === undefined || !isAbsolute(requested)) throw new Error('Pass project as the absolute folder that holds project.godot.')
          return (await resolveGodotProject(requested, requested, exec.signal)).dir
        },
      }
      inner.effect(() => inner.gameMcp.provide(gameAddonMcpProvider(mcpHost)), 'game-addons: game MCP tools')
    })
  }

  /**
   * The catalog with each add-on's presence in the game project of a folder, for the Add-ons dialog.
   * @param directory - absolute folder: the project folder or a folder up to three levels above it.
   * @param signal - cancellation.
   * @returns the project folder, every catalog add-on, and their icons.
   * @throws GodotProjectError when the folder has no Godot project.
   */
  @Remote
  async project(directory: string, signal: AbortSignal): Promise<GameAddonsProjectView> {
    const projectDir = await this.projectOf(directory, signal)
    const presence = await this.manager.presence(projectDir)
    const { catalog } = this.manager
    return { projectDir, addons: catalog.entries.map(addon => addonView(addon, presence.get(addon.id))), icons: catalog.icons }
  }

  /**
   * Install an add-on that the user chose in the Add-ons dialog.
   * @param directory - absolute folder of the game project, or up to three levels above it.
   * @param id - catalog id.
   * @param signal - cancellation; a cancelled installation leaves the project as it was.
   * @returns the installation.
   */
  @Remote
  async installAddon(directory: string, id: string, signal: AbortSignal): Promise<GameAddonInstallResult> {
    return await this.manager.install(await this.projectOf(directory, signal), id, {}, signal)
  }

  /**
   * Remove an add-on that the user chose in the Add-ons dialog.
   * @param directory - absolute folder of the game project, or up to three levels above it.
   * @param id - catalog id.
   * @param signal - cancellation before files are deleted.
   * @returns the removal.
   */
  @Remote
  async removeAddon(directory: string, id: string, signal: AbortSignal): Promise<GameAddonRemoveResult> {
    return await this.manager.remove(await this.projectOf(directory, signal), id, signal)
  }

  private async projectOf(directory: string, signal: AbortSignal): Promise<string> {
    if (!isAbsolute(directory)) throw new Error('directory must be an absolute path.')
    return (await resolveGodotProject(directory, undefined, signal)).dir
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
