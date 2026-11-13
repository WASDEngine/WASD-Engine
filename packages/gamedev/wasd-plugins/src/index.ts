/**
 * WASD Engine Plugins: WASD Engine's own features, which stay on in every profile (the plugin manager refuses to
 * switch this row off). It exports Godot games for the Web, records their previews, and releases them to the WASD
 * Engine site the app is signed in to, as numbered versions with share links and an animated preview, through the
 * `wasd_export_web`, `wasd_record_preview`, and `wasd_release_game` tools of every Session and of WASD Engine's MCP
 * server. The `wasdPlugins` Remote tells the window what each project released and
 * where the site's Explore page is, for the Release button of game project Sessions and Explore Games in the sidebar.
 * Under `dataRoot` it records which folders on this computer released each game, so a copied project folder asks
 * before its release adds to the game it shares with the folder it was copied from.
 * With `browser` on, as in the Desktop app, the Session's agent also gets the `browser_*` tools, which the window
 * carries out on a Browser tab in the right Sidebar through the same Remote.
 * @module @deepseek-ai/dsh-wasd-plugins
 */
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
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
import { BROWSER_PROMPT, BrowserRequestQueue, browserToolDefinitions, modelImages, sessionBrowserScreenshots } from './browser.ts'
import { ReleaseFolders } from './folders.ts'
import { encodePreview, savePreview } from './preview.ts'
import { accountKey, projectView, releaseGame, STATE_DIR, WEB_BUILD_DIR, type SiteAccess } from './release.ts'
import { wasdMcpProvider, wasdToolDefinitions, type PreviewRequest, type WasdToolHost } from './tools.ts'
import type { WasdBrowserOutcome, WasdBrowserRequests, WasdProjectView, WasdSiteLinks } from './types.ts'

export type * from './types.ts'
export { ReleaseError } from './release.ts'
export type { BrowserPageValue, BrowserScreenshotValue, BrowserToolHost, ScreenshotSaver, StoredScreenshot, WasdBrowserDone } from './browser.ts'

/** Longest preview recording in seconds: the longest recording the Godot plugin's `record()` takes. */
const MAX_PREVIEW_SECONDS = 30

/** Plugin configuration. */
export interface Config {
  /** Absolute folder of the plugin's data on this computer: which project folders released each game. */
  dataRoot: string
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
  /**
   * Longest wait for one operation on the page of a `browser_*` call, such as a script, a screenshot, or an input event,
   * in milliseconds; it must be shorter than `browserTimeoutMs`.
   */
  browserOperationTimeoutMs: number
  /** Most characters of page text in a `browser_*` result. */
  browserMaxChars: number
  /** Largest width in pixels of a `browser_screenshot` image. */
  browserScreenshotWidth: number
  /** Length in seconds of a preview recording that names none, and of the one a release records for a game without a preview. */
  previewSeconds: number
  /** Longest preview recording `wasd_record_preview` takes, in seconds; at most the Godot plugin's longest recording. */
  previewMaxSeconds: number
  /** Milliseconds from one frame of a preview GIF to the next. */
  previewFrameMs: number
  /** Largest width in pixels of a preview GIF. */
  previewWidth: number
  /** Smallest width in pixels that a preview GIF over `previewMaxGifBytes` shrinks to before it drops frames. */
  previewMinWidth: number
  /** Largest width in pixels of a preview still. */
  previewStillWidth: number
  /** Largest preview GIF in bytes. */
  previewMaxGifBytes: number
  /** CPU effort of the preview GIF's palette and frame optimization, from 1 (fastest) to 10 (smallest). */
  previewEffort: number
  /** Seconds that a game a preview recording starts runs before the recording begins. */
  previewStartSeconds: number
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
  static Config: z<Partial<Config> & Pick<Config, 'dataRoot'>, Config> = z.object({
    dataRoot: z.string().required(),
    explorePath: z.string().pattern(/^\/[A-Za-z0-9/_-]*$/u).default('/explore'),
    browser: z.boolean().default(false),
    browserTimeoutMs: z.natural().min(1).default(60_000),
    browserClaimTimeoutMs: z.natural().min(1).default(5000),
    browserLoadTimeoutMs: z.natural().min(1).default(15_000),
    browserOperationTimeoutMs: z.natural().min(1).default(10_000),
    browserMaxChars: z.natural().min(1000).default(40_000),
    browserScreenshotWidth: z.natural().min(320).default(1280),
    previewSeconds: z.number().min(1).max(MAX_PREVIEW_SECONDS).default(4),
    previewMaxSeconds: z.number().min(1).max(MAX_PREVIEW_SECONDS).default(10),
    previewFrameMs: z.natural().min(20).max(1000).default(80),
    previewWidth: z.natural().min(64).max(4096).default(480),
    previewMinWidth: z.natural().min(64).max(4096).default(240),
    previewStillWidth: z.natural().min(64).max(4096).default(1280),
    previewMaxGifBytes: z.natural().min(64 * 1024).default(5 * 1024 * 1024),
    previewEffort: z.natural().min(1).max(10).default(4),
    previewStartSeconds: z.number().min(0).max(60).default(2),
  })

  private readonly lifetime = new AbortController()
  private readonly browserRequestQueue: BrowserRequestQueue
  private readonly folders: ReleaseFolders

  /**
   * @param ctx - plugin context; the tools and the Remote live as long as it.
   * @param config - validated configuration.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'wasdPlugins', { namespace: 'wasdPlugins' })
    if (config.previewSeconds > config.previewMaxSeconds) throw new TypeError('wasd-plugins: previewSeconds must be at most previewMaxSeconds')
    if (config.previewMinWidth > config.previewWidth) throw new TypeError('wasd-plugins: previewMinWidth must be at most previewWidth')
    if (!isAbsolute(config.dataRoot)) throw new TypeError(`wasd-plugins: dataRoot must be an absolute path, got ${JSON.stringify(config.dataRoot)}`)
    this.folders = new ReleaseFolders(join(config.dataRoot, 'release-folders'))
    ctx.effect(() => () => { this.lifetime.abort() }, 'wasd-plugins: lifetime')
    this.browserRequestQueue = new BrowserRequestQueue(config.browserClaimTimeoutMs, this.lifetime.signal)
    if (config.browser) {
      if (config.browserOperationTimeoutMs >= config.browserTimeoutMs) {
        throw new TypeError('wasd-plugins: browserOperationTimeoutMs must be shorter than browserTimeoutMs')
      }
      const limits = {
        maxChars: config.browserMaxChars,
        loadTimeoutMs: config.browserLoadTimeoutMs,
        operationTimeoutMs: config.browserOperationTimeoutMs,
        screenshotWidth: config.browserScreenshotWidth,
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
    // The Web export, preview, and release tools need the Godot plugin; the Browser, the Release button, and Explore
    // Games do not.
    ctx.inject(['godot', 'tools'], (scope) => {
      const record = async (agent: Agent, request: PreviewRequest, stopStarted: boolean, signal: AbortSignal) => {
        const recording = await scope.godot.record(agent, {
          project: request.projectDir,
          seconds: request.seconds,
          frameMs: config.previewFrameMs,
          maxWidth: config.previewWidth,
          stillWidth: config.previewStillWidth,
          stillAt: request.stillAt ?? request.seconds / 2,
          startSeconds: config.previewStartSeconds,
          stopStarted,
          ...request.events === undefined ? {} : { events: request.events },
          ...request.coordinateSpace === undefined ? {} : { coordinateSpace: request.coordinateSpace },
        }, signal)
        const encoding = { maxGifBytes: config.previewMaxGifBytes, minWidth: config.previewMinWidth, effort: config.previewEffort }
        const encoded = await encodePreview(recording, encoding, signal)
        return { recording, encoded, files: await savePreview(request.projectDir, encoded) }
      }
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
        recordPreview: async (request, exec) => {
          if (exec.agent === undefined) throw new Error('A preview recording runs the game in a Session; call it from one.')
          const agent = exec.agent
          const { recording, encoded, files } = await record(agent, request, false, exec.signal)
          const images = await modelImages(ctx, exec, agent)
          const view = images.kind === 'ready' ? await images.save(encoded.still, encoded.stillType, basename(files.image), exec.signal) : undefined
          return {
            gif: files.gif,
            image: files.image,
            frames: encoded.frames,
            seconds: encoded.durationMs / 1000,
            width: encoded.gifWidth,
            height: encoded.gifHeight,
            gifBytes: encoded.gif.length,
            imageWidth: encoded.stillWidth,
            imageHeight: encoded.stillHeight,
            imageBytes: encoded.still.length,
            started: recording.started,
            paused: recording.paused,
            ...view === undefined ? {} : { view },
          }
        },
        release: (request, exec) => {
          const agent = exec.agent
          return releaseGame(request, {
            access: () => this.access(),
            exportWeb: (projectDir, outputDir, exportSignal) => scope.godot.exportWeb({ projectDir, outputDir }, exportSignal),
            fetch: (input, init) => fetch(input, init),
            folders: this.folders,
            tempDir: tmpdir(),
            // A release runs the game for a missing preview only in a Session, which the game plays in.
            ...agent === undefined ? {} : {
              recordPreview: async (projectDir, signal) => {
                return (await record(agent, { projectDir, seconds: config.previewSeconds }, true, signal)).files
              },
            },
          }, exec.signal)
        },
      }
      const definitions = wasdToolDefinitions(host, { seconds: config.previewSeconds, maxSeconds: config.previewMaxSeconds })
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
   * @returns whether it is a Godot project, the signed-in account's game on the site the app is signed in to, and
   * another folder on this computer that releases the same game.
   */
  @Remote
  async project(projectDir: string, signal: AbortSignal): Promise<WasdProjectView> {
    if (!isAbsolute(projectDir)) throw new Error('projectDir must be an absolute path.')
    const origin = await this.siteOrigin()
    const access = await this.access()
    signal.throwIfAborted()
    return await projectView(projectDir, origin, this.folders, access?.origin === origin ? access.account : undefined)
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
   * Follow the agents' Browser commands for a window that can drive Browser tabs: those no window has taken yet, and
   * the ids of taken ones whose call still waits, so a window stops a command whose call ended, with the stream's own
   * id, through which the window takes commands; the commands taken through a stream fail once it ends.
   * @param signal - stream cancellation.
   * @returns both lists, then again after each change, until cancelled or the plugin is disposed.
   */
  @Remote({ mode: 'stream' })
  browserRequests(signal: AbortSignal): AsyncIterable<WasdBrowserRequests> {
    return this.browserRequestQueue.follow(signal)
  }

  /**
   * Take a Browser command for the calling window, which then carries it out and settles it. The command fails at once
   * if the window's command stream ends before it settles.
   * @param id - the command.
   * @param follower - the `follower` id of the latest list the window's command stream yielded.
   * @param signal - cancellation.
   * @returns whether the window took it; false when another window did, the command ended, or that stream ended.
   */
  @Remote
  claimBrowserRequest(id: string, follower: string, signal: AbortSignal): boolean {
    signal.throwIfAborted()
    return this.browserRequestQueue.claim(id, follower)
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
    if (session === null || session === undefined) return undefined
    const account = session.userId === null ? {} : { account: accountKey(session.userId) }
    return { origin: new URL(session.origin).origin, token: session.token, ...account }
  }
}
