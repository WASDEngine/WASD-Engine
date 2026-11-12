/**
 * WASD Engine Plugins: WASD Engine's own features, which stay on in every profile (the plugin manager refuses to
 * switch this row off). It exports Godot games for the Web and releases them to the WASD Engine site the app is signed
 * in to, as numbered versions with share links, through the `wasd_export_web` and `wasd_release_game` tools of every
 * Session and of WASD Engine's MCP server. The `wasdPlugins` Remote tells the window what each project released and
 * where the site's Explore page is, for the Release button of game project Sessions and Explore Games in the sidebar.
 * With `browser` on, as in the Desktop app, the Session's agent also gets the `browser_*` tools, which the window
 * carries out on a Browser tab in the right Sidebar through the same Remote.
 * @module @deepseek-ai/dsh-wasd-plugins
 */
import { tmpdir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveGodotProject } from '@deepseek-ai/dsh-godot'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { BROWSER_PROMPT, BrowserRequestQueue, browserToolDefinitions, sessionBrowserScreenshots } from './browser.ts'
import { projectView, releaseGame, STATE_DIR, WEB_BUILD_DIR, type SiteAccess } from './release.ts'
import { wasdMcpProvider, wasdToolDefinitions, type WasdToolHost } from './tools.ts'
import type { WasdBrowserOutcome, WasdBrowserRequests, WasdProjectView, WasdSiteLinks } from './types.ts'

export type * from './types.ts'
export { ReleaseError } from './release.ts'
export type { BrowserPageValue, BrowserScreenshotValue, BrowserToolHost, ScreenshotSaver, StoredScreenshot, WasdBrowserDone } from './browser.ts'

/** Plugin configuration. */
export interface Config {
  /** Path of the Explore page on the WASD Engine site. */
  explorePath: string
  /**
   * Give the Session's agent the `browser_*` tools, which a window carries out on a Browser tab in the right Sidebar;
   * the Desktop app's Browser tabs are the ones a window can drive.
   */
  browser: boolean
  /** Cooperative timeout budget of each `browser_*` call, in milliseconds. */
  browserTimeoutMs: number
  /** How long a `browser_*` call waits for a window to take it, in milliseconds. */
  browserClaimTimeoutMs: number
  /** Longest wait for a page to finish loading after a `browser_*` call acted on it, in milliseconds. */
  browserLoadTimeoutMs: number
  /** Most characters of page text in a `browser_*` result. */
  browserMaxChars: number
  /** Largest width in pixels of a `browser_screenshot` image. */
  browserScreenshotWidth: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** WASD Engine's own features: Web exports, releases, and the site's links. */
    wasdPlugins: WasdPlugins
  }
}

/** Owner of the Web export, release, and Browser tools and of the `wasdPlugins` Remote. */
export default class WasdPlugins extends TypertRemoteService {
  static inject = ['tools', 'workingDirectory', 'typert']
  static Config: z<Partial<Config>, Config> = z.object({
    explorePath: z.string().pattern(/^\/[A-Za-z0-9/_-]*$/u).default('/explore'),
    browser: z.boolean().default(false),
    browserTimeoutMs: z.natural().min(1).default(60_000),
    browserClaimTimeoutMs: z.natural().min(1).default(5000),
    browserLoadTimeoutMs: z.natural().min(1).default(15_000),
    browserMaxChars: z.natural().min(1000).default(40_000),
    browserScreenshotWidth: z.natural().min(320).default(1280),
  })

  private readonly lifetime = new AbortController()
  private readonly browserRequestQueue: BrowserRequestQueue

  /**
   * @param ctx - plugin context; the tools and the Remote live as long as it.
   * @param config - validated configuration.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'wasdPlugins', { namespace: 'wasdPlugins' })
    ctx.effect(() => () => { this.lifetime.abort() }, 'wasd-plugins: lifetime')
    this.browserRequestQueue = new BrowserRequestQueue(config.browserClaimTimeoutMs, this.lifetime.signal)
    if (config.browser) {
      const limits = {
        maxChars: config.browserMaxChars, loadTimeoutMs: config.browserLoadTimeoutMs, screenshotWidth: config.browserScreenshotWidth,
      }
      for (const definition of browserToolDefinitions({
        send: (sessionId, command, signal) => this.browserRequestQueue.send(sessionId, command, limits, signal),
        screenshots: sessionBrowserScreenshots(ctx),
        maxChars: config.browserMaxChars,
        timeoutMs: config.browserTimeoutMs,
      })) ctx.tools.register(definition)
      ctx.inject(['systemPrompt'], (inner) => {
        inner.systemPrompt.section({ name: 'browser', order: inner.systemPrompt.getSectionOrder('TOOL_WEB_FETCH'), text: BROWSER_PROMPT })
      })
    }
    // The Web export and release tools need the Godot plugin; the Browser, the Release button, and Explore Games do not.
    ctx.inject(['godot', 'tools'], (scope) => {
      const host: WasdToolHost = {
        project: async (requested, exec) => {
          const base = await this.base(requested, exec)
          return (await resolveGodotProject(base, requested, exec.signal)).dir
        },
        file: async (requested, exec) => resolve(await this.base(requested, exec), requested),
        exportWeb: (projectDir, signal) => {
          const outputDir = resolve(projectDir, STATE_DIR, WEB_BUILD_DIR)
          return scope.godot.exportWeb({ projectDir, outputDir }, signal)
        },
        release: (request, signal) => releaseGame(request, {
          access: () => this.access(),
          exportWeb: (projectDir, outputDir, exportSignal) => scope.godot.exportWeb({ projectDir, outputDir }, exportSignal),
          fetch: (input, init) => fetch(input, init),
          tempDir: tmpdir(),
        }, signal),
      }
      const definitions = wasdToolDefinitions(host)
      for (const definition of definitions) scope.tools.register(definition)
      // Agents connected through WASD Engine's MCP server get the same tools.
      scope.inject(['gameMcp'], (inner) => {
        inner.effect(() => inner.gameMcp.provide(wasdMcpProvider(definitions)), 'wasd-plugins: game MCP tools')
      })
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

  /**
   * Follow the agents' Browser commands that no window has taken yet, for a window that can drive Browser tabs.
   * @param signal - stream cancellation.
   * @returns the waiting commands, then again after each change, until cancelled or the plugin is disposed.
   */
  @Remote({ mode: 'stream' })
  browserRequests(signal: AbortSignal): AsyncIterable<WasdBrowserRequests> {
    return this.browserRequestQueue.follow(signal)
  }

  /**
   * Take a Browser command for the calling window, which then carries it out and settles it.
   * @param id - the command.
   * @param signal - cancellation.
   * @returns whether the window took it; false when another window did or the command ended.
   */
  @Remote
  claimBrowserRequest(id: string, signal: AbortSignal): boolean {
    signal.throwIfAborted()
    return this.browserRequestQueue.claim(id)
  }

  /**
   * End a Browser command the window took, with the page afterwards or why it failed.
   * @param id - the command.
   * @param outcome - how it ended.
   * @param signal - cancellation.
   * @returns whether the outcome reached the waiting tool call; false when the call already ended.
   */
  @Remote
  settleBrowserRequest(id: string, outcome: WasdBrowserOutcome, signal: AbortSignal): boolean {
    signal.throwIfAborted()
    return this.browserRequestQueue.settle(id, outcome)
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
