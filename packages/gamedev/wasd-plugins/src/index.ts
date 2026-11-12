/**
 * WASD Engine Plugins: WASD Engine's own features, which stay on in every profile (the plugin manager refuses to
 * switch this row off). It exports Godot games for the Web and releases them to the WASD Engine site the app is signed
 * in to, as numbered versions with share links, through the `wasd_export_web` and `wasd_release_game` tools of every
 * Session and of WASD Engine's MCP server. The `wasdPlugins` Remote tells the window what each project released and
 * where the site's Explore page is, for the Release button of game project Sessions and Explore Games in the sidebar.
 * @module @deepseek-ai/dsh-wasd-plugins
 */
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveGodotProject } from '@deepseek-ai/dsh-godot'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { projectView, releaseGame, STATE_DIR, WEB_BUILD_DIR, type SiteAccess } from './release.ts'
import { wasdMcpProvider, wasdToolDefinitions, type WasdToolHost } from './tools.ts'
import type { WasdProjectView, WasdSiteLinks } from './types.ts'

export type * from './types.ts'
export { ReleaseError } from './release.ts'

/** Plugin configuration. */
export interface Config {
  /** Path of the Explore page on the WASD Engine site. */
  explorePath: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** WASD Engine's own features: Web exports, releases, and the site's links. */
    wasdPlugins: WasdPlugins
  }
}

/** Owner of the Web export and release tools and of the `wasdPlugins` Remote. */
export default class WasdPlugins extends TypertRemoteService {
  static inject = ['tools', 'godot', 'workingDirectory', 'typert']
  static Config: z<Partial<Config>, Config> = z.object({
    explorePath: z.string().pattern(/^\/[A-Za-z0-9/_-]*$/u).default('/explore'),
  })

  /**
   * @param ctx - plugin context; the tools and the Remote live as long as it.
   * @param config - validated configuration.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'wasdPlugins', { namespace: 'wasdPlugins' })
    const host: WasdToolHost = {
      project: async (requested, exec) => {
        const base = await this.base(requested, exec)
        return (await resolveGodotProject(base, requested, exec.signal)).dir
      },
      file: async (requested, exec) => resolve(await this.base(requested, exec), requested),
      exportWeb: (projectDir, signal) => {
        const outputDir = resolve(projectDir, STATE_DIR, WEB_BUILD_DIR)
        return ctx.godot.exportWeb({ projectDir, outputDir }, signal)
      },
      release: (request, signal) => releaseGame(request, {
        access: () => this.access(),
        exportWeb: (projectDir, outputDir, exportSignal) => ctx.godot.exportWeb({ projectDir, outputDir }, exportSignal),
        fetch: (input, init) => fetch(input, init),
        tempDir: tmpdir(),
      }, signal),
    }
    const definitions = wasdToolDefinitions(host)
    for (const definition of definitions) ctx.tools.register(definition)
    // Agents connected through WASD Engine's MCP server get the same tools.
    ctx.inject(['gameMcp'], (inner) => {
      inner.effect(() => inner.gameMcp.provide(wasdMcpProvider(definitions)), 'wasd-plugins: game MCP tools')
    })
  }

  /**
   * What a project folder released, for the Release button.
   * @param projectDir - absolute folder of a game project.
   * @param signal - cancellation.
   * @returns whether it is a Godot project, and its game on the site the app is signed in to.
   */
  @Remote
  async project(projectDir: string, signal: AbortSignal): Promise<WasdProjectView> {
    if (!isAbsolute(projectDir)) throw new Error('projectDir must be an absolute path.')
    const origin = await this.siteOrigin()
    signal.throwIfAborted()
    return await projectView(projectDir, origin)
  }

  /**
   * Pages of the WASD Engine site the app is signed in to, or would sign in to.
   * @param signal - cancellation.
   * @returns the Explore page.
   */
  @Remote
  async links(signal: AbortSignal): Promise<WasdSiteLinks> {
    const origin = await this.siteOrigin()
    signal.throwIfAborted()
    return { explore: new URL(this.config.explorePath, origin).href }
  }

  /** The folder a call's relative paths start from: none for an absolute path, else the Session's working directory. */
  private async base(requested: string | undefined, exec: ToolRunContext): Promise<string> {
    if (requested !== undefined && isAbsolute(requested)) return requested
    if (exec.agent === undefined) throw new Error('Pass project as an absolute path.')
    return await this.ctx.workingDirectory.ensure(exec.agent, exec.signal)
  }

  /** The site's origin from the account plugin's links; they exist while signed out too. */
  private async siteOrigin(): Promise<string> {
    const account = this.ctx.get('deepseekAccount')
    if (account === undefined) throw new Error('This WASD Engine has no account sign-in, so it has no WASD Engine site.')
    return new URL((await account.getState()).links.usageUrl).origin
  }

  private async access(): Promise<SiteAccess | undefined> {
    const session = await this.ctx.get('deepseekAccount')?.getPlatformSession()
    return session === null || session === undefined ? undefined : { origin: new URL(session.origin).origin, token: session.token }
  }
}
