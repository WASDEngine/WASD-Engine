/**
 * WASD Engine Plugins: WASD Engine's own features, which stay on in every profile (the plugin manager refuses to
 * switch this row off). It exports Godot games for the Web, Windows, and macOS, records their previews, and releases
 * them to the WASD Engine site the app is signed in to, as numbered versions with share links, an animated preview, and
 * desktop downloads, public on the site's Explore page or private, through the `wasd_export_web`,
 * `wasd_export_desktop`, `wasd_record_preview`, and `wasd_release_game` tools of every Session and of WASD Engine's
 * MCP server, and puts games online through the multiplayer tools: player-hosted for free, or on dedicated servers the
 * site sells by monthly size, which the user always confirms on the site. The `wasdPlugins` Remote tells the window
 * what each project released and set up for multiplayer and where the site's Explore page is, for the Export / Share
 * and Multiplayer buttons of game project Sessions and Explore Games in the sidebar, and hands windows the
 * confirmation pages the tools open.
 * Under `dataRoot` it records which folders on this computer released each game, so a copied project folder asks
 * before its release adds to the game it shares with the folder it was copied from. A project's exports, Web checks of
 * its build, preview recordings, and releases run one at a time, whether a Session's agent or a connected agent called
 * them, because each rewrites or reads the project's state folder. Each release also uploads what the
 * game was made with: the AI models and game tools that worked on the project, which the plugin records in the
 * project's `.wasdengine/credits.json` as Sessions' agents and connected agents call game tools, and its add-ons.
 * With `browser` on, as in the Desktop app, the Session's agent also gets the `browser_*` tools, which the window
 * carries out on a Browser tab in the right Sidebar through the same Remote.
 * @module @deepseek-ai/dsh-wasd-plugins
 */
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
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
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-working-directory'
import { BROWSER_PROMPT, BrowserRequestQueue, browserToolDefinitions, modelImages, sessionBrowserScreenshots } from './browser.ts'
import { CreditsLedger, isGameWork, modelName, namesProject, providerToolCredit, sessionToolCredit, WASD_PROVIDER, type ModelCredit, type ToolCredit } from './credits.ts'
import { ReleaseFolders } from './folders.ts'
import { LinkRequests } from './links.ts'
import { MultiplayerApi } from './multiplayer-api.ts'
import { readMultiplayerConfig } from './multiplayer-project.ts'
import {
  MCP_SURFACE, MULTIPLAYER_MCP_INSTRUCTIONS, MULTIPLAYER_PROMPT, multiplayerMcpTools, multiplayerToolDefinitions, type ApprovalAnswer,
  type MultiplayerSurface, type MultiplayerToolHost,
} from './multiplayer-tools.ts'
import { GameLibrary } from './library.ts'
import { startDetached, systemUnpack } from './library-process.ts'
import { encodePreview, savePreview } from './preview.ts'
import { accountKey, DESKTOP_BUILD_DIR, linkedGame, projectView, releaseGame, STATE_DIR, WEB_BUILD_DIR, type SiteAccess } from './release.ts'
import { signInLink } from './site-sign-in.ts'
import { ProjectQueue } from './state.ts'
import { wasdMcpProvider, wasdToolDefinitions, type PreviewRequest, type WasdToolHost } from './tools.ts'
import type {
  WasdBrowserOutcome, WasdBrowserRequests, WasdLibraryOutcome, WasdLibraryView, WasdLinkRequests, WasdMultiplayerView,
  WasdProjectView, WasdSiteLinks,
} from './types.ts'

export type * from './types.ts'
export { ReleaseError } from './release.ts'
export { MultiplayerError } from './multiplayer-api.ts'
export type { BrowserPageValue, BrowserScreenshotValue, BrowserToolHost, ScreenshotSaver, StoredScreenshot, WasdBrowserDone } from './browser.ts'

/** Longest preview recording in seconds: the longest recording the Godot plugin's `record()` takes. */
const MAX_PREVIEW_SECONDS = 30

/**
 * The `project` argument of a tool call.
 * @param args - the call's arguments.
 * @returns the argument when it is a string.
 */
function projectArgument(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || !('project' in args)) return undefined
  return typeof args.project === 'string' ? args.project : undefined
}

/** Plugin configuration. */
export interface Config {
  /**
   * Absolute folder of the plugin's data on this computer: which project folders released each game, and the game
   * library's games in `library/`.
   */
  dataRoot: string
  /** Path of the Explore page on the WASD Engine site. */
  explorePath: string
  /**
   * Give the Session's agent the `browser_*` tools, which a window carries out on a Browser tab in the right Sidebar;
   * the Desktop app's Browser tabs are the ones a window can drive.
   */
  browser: boolean
  /**
   * Keep a game library: games installed from the WASD Engine site as desktop builds and started from the app, as the
   * Desktop app does; elsewhere the library is empty and refuses installs.
   */
  library: boolean
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
  /**
   * Largest width or height in pixels of a preview GIF, which link previews of a game's share link show: the size of its
   * longer side.
   */
  previewWidth: number
  /**
   * Largest width or height in pixels of a preview animation, the animated WebP that Explore and a game's page play: the
   * size of its longer side.
   */
  previewWebpWidth: number
  /**
   * Smallest longer side in pixels that a preview GIF over `previewMaxGifBytes`, or a preview animation over
   * `previewMaxWebpBytes`, shrinks to before it drops frames.
   */
  previewMinWidth: number
  /** Largest width in pixels of a preview still. */
  previewStillWidth: number
  /** Largest preview GIF in bytes. */
  previewMaxGifBytes: number
  /** Largest preview animation in bytes. */
  previewMaxWebpBytes: number
  /** WebP quality of a preview animation, from 1 to 100. */
  previewWebpQuality: number
  /** JPEG quality, from 0.1 to 1, of the frames a preview recording captures; the still stays lossless. */
  previewFrameQuality: number
  /** CPU effort of the preview GIF's palette and frame optimization, from 1 (fastest) to 10 (smallest). */
  previewEffort: number
  /** Seconds that a game a preview recording starts runs before the recording begins. */
  previewStartSeconds: number
  /**
   * Largest size in bytes of the decoded frames that encoding a preview GIF holds; a recording whose frames would take
   * more at `previewWidth` makes a smaller GIF.
   */
  previewFrameBufferBytes: number
  /** Most frames of a preview that decode or encode at once. */
  previewConcurrency: number
  /**
   * Memory in bytes that must stay available, besides the decoded frames of the GIF, for a preview recording to be
   * encoded; with less, the recording fails and asks for memory to be freed.
   */
  previewMinAvailableMemoryBytes: number
  /**
   * Model providers whose models are WASD Engine's built-in AI, which a game's credits name as such rather than by the
   * model's own name.
   */
  builtinModelProviders: string[]
  /** Path of the site's page that lists the account's dedicated servers. */
  serversPath: string
  /** How long a confirmation page a multiplayer tool opens waits for a window to take it, in milliseconds. */
  linkClaimTimeoutMs: number
}

/** The answer of the library's requests where the plugin keeps no library. */
const LIBRARY_ELSEWHERE: WasdLibraryOutcome = { ok: false, message: 'Games install in the WASD Engine Desktop app.' }

/** The library stream where the plugin keeps no library: one empty view, until the stream is cancelled. */
async function * noLibrary(signal: AbortSignal): AsyncIterable<WasdLibraryView> {
  yield { games: [], tasks: [], supported: false }
  if (!signal.aborted) await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
}

/** The WASD Multiplayer add-on that `wasd_multiplayer_setup` copies into projects, shipped in this package. */
const ADDON_SOURCE = fileURLToPath(new URL('../addon/wasd_multiplayer', import.meta.url))

/** The prompt section order anchor of the multiplayer section: with the game tools. */
const MULTIPLAYER_SECTION_ANCHOR = 'TOOL_COMPUTER_USE'

/**
 * The Session's multiplayer surface: WASD Engine's approval prompt, which the Session's audit log records, and the
 * confirmation page opened in a window of the app.
 * @param ctx - plugin context with the optional approval service.
 * @param links - the queue windows open links from.
 * @returns the surface.
 */
function sessionSurface(ctx: Context, links: LinkRequests): MultiplayerSurface {
  return {
    channel: 'app',
    projectDescription: 'Folder containing project.godot, relative to the working directory. Default: the nearest one.',
    async approve(exec, toolName, prompt): Promise<ApprovalAnswer> {
      const approval = ctx.get('approval')
      if (approval === undefined || exec.agent === undefined) return 'unavailable'
      const outcome = await approval.request({
        agent: exec.agent, toolName, callId: exec.callId, reason: prompt.en, displayReason: prompt, signal: exec.signal,
      })
      switch (outcome) {
        case 'allowed-once': return 'approved'
        case 'rejected': return 'declined'
        case 'cancelled': return 'cancelled'
        case 'unavailable': return 'unavailable'
        default: throw new Error(`unexpected approval outcome ${JSON.stringify(outcome satisfies never)}`)
      }
    },
    openLink: (url, exec) => links.open(url, exec.signal),
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** WASD Engine's own features: Web and desktop exports, releases, and the site's links. */
    wasdPlugins: WasdPlugins
  }
}

/** Owner of the export, release, and Browser tools and of the `wasdPlugins` Remote. */
export default class WasdPlugins extends TypertRemoteService {
  static inject = ['tools', 'workingDirectory', 'typert']
  static Config: z<Partial<Config> & Pick<Config, 'dataRoot'>, Config> = z.object({
    dataRoot: z.string().required(),
    explorePath: z.string().pattern(/^\/[A-Za-z0-9/_-]*$/u).default('/explore'),
    browser: z.boolean().default(false),
    library: z.boolean().default(false),
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
    previewWebpWidth: z.natural().min(64).max(4096).default(960),
    previewMinWidth: z.natural().min(64).max(4096).default(240),
    previewStillWidth: z.natural().min(64).max(4096).default(1280),
    previewMaxGifBytes: z.natural().min(64 * 1024).default(5 * 1024 * 1024),
    previewMaxWebpBytes: z.natural().min(64 * 1024).default(6 * 1024 * 1024),
    previewWebpQuality: z.natural().min(1).max(100).default(75),
    previewFrameQuality: z.number().min(0.1).max(1).default(0.9),
    previewEffort: z.natural().min(1).max(10).default(4),
    previewStartSeconds: z.number().min(0).max(60).default(2),
    previewFrameBufferBytes: z.natural().min(1024 * 1024).default(64 * 1024 * 1024),
    previewConcurrency: z.natural().min(1).max(64).default(4),
    previewMinAvailableMemoryBytes: z.natural().default(256 * 1024 * 1024),
    builtinModelProviders: z.array(z.string().min(1)).default(['deepseek-account', 'deepseek-official']),
    serversPath: z.string().pattern(/^\/[A-Za-z0-9/_-]*$/u).default('/account/servers'),
    linkClaimTimeoutMs: z.natural().min(1).default(5000),
  })

  private readonly lifetime = new AbortController()
  private readonly browserRequestQueue: BrowserRequestQueue
  private readonly folders: ReleaseFolders
  private readonly credits = new CreditsLedger()
  private readonly projects = new ProjectQueue()
  private readonly linkQueue: LinkRequests
  private readonly games: GameLibrary | undefined

  /**
   * @param ctx - plugin context; the tools and the Remote live as long as it.
   * @param config - validated configuration.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'wasdPlugins', { namespace: 'wasdPlugins' })
    if (config.previewSeconds > config.previewMaxSeconds) throw new TypeError('wasd-plugins: previewSeconds must be at most previewMaxSeconds')
    if (config.previewMinWidth > config.previewWidth) throw new TypeError('wasd-plugins: previewMinWidth must be at most previewWidth')
    if (config.previewMinWidth > config.previewWebpWidth) throw new TypeError('wasd-plugins: previewMinWidth must be at most previewWebpWidth')
    if (!isAbsolute(config.dataRoot)) throw new TypeError(`wasd-plugins: dataRoot must be an absolute path, got ${JSON.stringify(config.dataRoot)}`)
    this.folders = new ReleaseFolders(join(config.dataRoot, 'release-folders'))
    ctx.effect(() => () => { this.lifetime.abort() }, 'wasd-plugins: lifetime')
    // A game's credits: the models and game tools that worked on each project, from the calls of Sessions' agents and
    // of agents connected through WASD Engine's MCP server.
    ctx.on('tools/result', (exec, result) => {
      if (result.isError || exec.agent === undefined || exec.signal.aborted || !isGameWork(exec.name)) return
      const requested = namesProject(exec.name) ? projectArgument(exec.arguments) : undefined
      this.track(this.creditSession(exec.agent, requested, sessionToolCredit(exec.name)))
    })
    ctx.on('game-mcp/tool-result', (result) => {
      const tool = providerToolCredit(result.provider)
      if (result.isError || (tool === undefined && result.provider !== WASD_PROVIDER)) return
      const requested = namesProject(result.tool) ? projectArgument(result.args) : undefined
      this.track(this.creditConnected(result.client.id, requested, result.agent, tool))
    })
    this.browserRequestQueue = new BrowserRequestQueue(config.browserClaimTimeoutMs, this.lifetime.signal)
    this.linkQueue = new LinkRequests(config.linkClaimTimeoutMs, this.lifetime.signal)
    this.games = config.library
      ? new GameLibrary({
        root: join(config.dataRoot, 'library'),
        siteOrigin: () => this.siteOrigin(),
        access: () => this.access(),
        fetch: (input, init) => fetch(input, init),
        system: process.platform,
        unpack: systemUnpack(process.platform),
        start: startDetached,
        now: () => new Date(),
      }, this.lifetime.signal)
      : undefined
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
    // The export, preview, and release tools need the Godot plugin; the Browser, the Export / Share button, and Explore
    // Games do not.
    ctx.inject(['godot', 'tools'], (scope) => {
      const record = async (agent: Agent, request: PreviewRequest, stopStarted: boolean, signal: AbortSignal) => {
        const recording = await scope.godot.record(agent, {
          project: request.projectDir,
          seconds: request.seconds,
          frameMs: config.previewFrameMs,
          // One capture serves both the GIF and the wider animation; JPEG frames keep up at that width.
          maxWidth: Math.max(config.previewWidth, config.previewWebpWidth),
          frameQuality: config.previewFrameQuality,
          stillWidth: config.previewStillWidth,
          stillAt: request.stillAt ?? request.seconds / 2,
          startSeconds: config.previewStartSeconds,
          stopStarted,
          ...request.events === undefined ? {} : { events: request.events },
          ...request.coordinateSpace === undefined ? {} : { coordinateSpace: request.coordinateSpace },
        }, signal)
        const encoding = {
          gifWidth: config.previewWidth,
          maxGifBytes: config.previewMaxGifBytes,
          webpWidth: config.previewWebpWidth,
          maxWebpBytes: config.previewMaxWebpBytes,
          webpQuality: config.previewWebpQuality,
          minWidth: config.previewMinWidth,
          effort: config.previewEffort,
          frameBufferBytes: config.previewFrameBufferBytes,
          concurrency: config.previewConcurrency,
          minAvailableMemoryBytes: config.previewMinAvailableMemoryBytes,
          availableMemory: () => process.availableMemory(),
        }
        const encoded = await encodePreview(recording, encoding, signal)
        return { recording, encoded, files: await savePreview(request.projectDir, encoded) }
      }
      // The operations that write a project's state folder, or read the builds there, take the project's turn, so the
      // Session's agent and connected agents, which share these operations, never overlap on one project.
      const host: WasdToolHost = {
        project: async (requested, exec) => {
          const base = await this.base(requested, exec)
          return (await resolveGodotProject(base, requested, exec.signal)).dir
        },
        file: async (requested, exec) => resolve(await this.base(requested, exec), requested),
        exportWeb: (projectDir, signal) => this.projects.run(projectDir, signal, () => {
          const outputDir = resolve(projectDir, STATE_DIR, WEB_BUILD_DIR)
          return scope.godot.exportWeb({ projectDir, outputDir }, signal)
        }),
        // The build's folder is the project's `.wasdengine/web`, where exportWeb writes it.
        checkWeb: (outputDir, signal) => this.projects.run(resolve(outputDir, '..', '..'), signal, () => scope.godot.checkWeb({ outputDir }, signal)),
        exportDesktop: (projectDir, platforms, signal) => this.projects.run(projectDir, signal, async () => {
          const builds = []
          const warnings = []
          for (const platform of platforms) {
            const outputDir = resolve(projectDir, STATE_DIR, DESKTOP_BUILD_DIR, platform)
            const exported = await scope.godot.exportDesktop({ projectDir, platform, outputDir }, signal)
            builds.push({ platform, file: join(exported.outputDir, exported.entry), bytes: exported.bytes })
            warnings.push(...exported.warnings)
          }
          return { projectDir, builds, warnings: [...new Set(warnings)] }
        }),
        recordPreview: (request, exec) => this.projects.run(request.projectDir, exec.signal, async () => {
          if (exec.agent === undefined) throw new Error('A preview recording runs the game in a Session; call it from one.')
          const agent = exec.agent
          const { recording, encoded, files } = await record(agent, request, false, exec.signal)
          const images = await modelImages(ctx, exec, agent)
          const view = images.kind === 'ready' ? await images.save(encoded.still, encoded.stillType, basename(files.image), exec.signal) : undefined
          return {
            gif: files.gif,
            webp: files.webp,
            image: files.image,
            frames: encoded.frames,
            seconds: encoded.durationMs / 1000,
            width: encoded.gifWidth,
            height: encoded.gifHeight,
            gifBytes: encoded.gif.length,
            webpWidth: encoded.webpWidth,
            webpHeight: encoded.webpHeight,
            webpBytes: encoded.webp.length,
            imageWidth: encoded.stillWidth,
            imageHeight: encoded.stillHeight,
            imageBytes: encoded.still.length,
            started: recording.started,
            paused: recording.paused,
            ...view === undefined ? {} : { view },
          }
        }),
        release: (request, exec, model) => this.projects.run(request.projectDir, exec.signal, () => {
          const agent = exec.agent
          return releaseGame(request, {
            access: () => this.access(),
            exportWeb: (projectDir, outputDir, exportSignal) => scope.godot.exportWeb({ projectDir, outputDir }, exportSignal),
            checkWeb: (outputDir, checkSignal) => scope.godot.checkWeb({ outputDir }, checkSignal),
            exportDesktop: (projectDir, platform, outputDir, exportSignal) => {
              return scope.godot.exportDesktop({ projectDir, platform, outputDir }, exportSignal)
            },
            exportServer: (projectDir, outputDir, exportSignal) => scope.godot.exportServer({ projectDir, outputDir }, exportSignal),
            fetch: (input, init) => fetch(input, init),
            folders: this.folders,
            tempDir: tmpdir(),
            credits: async (projectDir) => {
              let credited: ModelCredit | undefined
              if (model.kind === 'named') credited = model.name === undefined ? undefined : { name: model.name }
              else credited = agent === undefined ? undefined : await this.sessionModel(agent, exec.signal)
              return await this.credits.release(projectDir, credited)
            },
            // A release runs the game for a missing preview only in a Session, which the game plays in.
            ...agent === undefined ? {} : {
              recordPreview: async (projectDir, signal) => {
                return (await record(agent, { projectDir, seconds: config.previewSeconds }, true, signal)).files
              },
            },
          }, exec.signal)
        }),
      }
      const lengths = { seconds: config.previewSeconds, maxSeconds: config.previewMaxSeconds }
      for (const definition of wasdToolDefinitions(host, lengths)) scope.tools.register(definition)
      // Agents connected through WASD Engine's MCP server get the same tools, whose release also takes their model.
      const connected = wasdToolDefinitions(host, lengths, 'connected')
      const claim = async (client: string, project: string, signal: AbortSignal): Promise<void> => {
        const projectDir = await this.projectOf(project, undefined, signal)
        if (projectDir !== undefined) await this.credits.claim(client, projectDir)
      }
      const multiplayerHost: MultiplayerToolHost = {
        project: (requested, exec) => host.project(requested, exec),
        access: () => this.access(),
        siteOrigin: () => this.siteOrigin(),
        fetch: (input, init) => fetch(input, init),
        runInstances: (request, signal) => scope.godot.runInstances(request, signal),
        addonSource: ADDON_SOURCE,
      }
      const surface = sessionSurface(ctx, this.linkQueue)
      for (const definition of multiplayerToolDefinitions(multiplayerHost, surface)) scope.tools.register(definition)
      scope.inject(['systemPrompt'], (inner) => {
        inner.systemPrompt.section({ name: 'multiplayer', order: inner.systemPrompt.getSectionOrder(MULTIPLAYER_SECTION_ANCHOR), text: MULTIPLAYER_PROMPT })
      })
      // Connected agents get the multiplayer tools too, confirming through their own user.
      const multiplayer = multiplayerMcpTools(multiplayerToolDefinitions(multiplayerHost, MCP_SURFACE))
      scope.inject(['gameMcp'], (inner) => {
        inner.effect(() => inner.gameMcp.provide(wasdMcpProvider(connected, { claim }, multiplayer, MULTIPLAYER_MCP_INSTRUCTIONS)), 'wasd-plugins: game MCP tools')
      })
    })
  }

  /**
   * What a project folder released, for the Export / Share button.
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
   * A project's multiplayer, for the Multiplayer button: its mode, its game, and the game's dedicated servers on the
   * site the app is signed in to.
   * @param projectDir - absolute folder of a game project.
   * @param signal - cancellation.
   * @returns the view; servers that could not be read leave the list empty and name why.
   */
  @Remote
  async multiplayer(projectDir: string, signal: AbortSignal): Promise<WasdMultiplayerView> {
    if (!isAbsolute(projectDir)) throw new Error('projectDir must be an absolute path.')
    const origin = await this.siteOrigin()
    const signedIn = await this.access()
    const access = signedIn?.origin === origin ? signedIn : undefined
    const project = await projectView(projectDir, origin, this.folders, access?.account)
    const config = project.godot ? await readMultiplayerConfig(projectDir) : undefined
    const serversUrl = new URL(this.config.serversPath, origin).href
    const view = {
      godot: project.godot,
      ...config === undefined ? {} : { mode: config.mode },
      ...project.game === undefined ? {} : { game: project.game },
      serversUrl,
    }
    const game = config?.mode === 'dedicated' && access !== undefined ? await linkedGame(projectDir, origin, access.account) : undefined
    if (game === undefined || access === undefined) return { ...view, servers: [] }
    try {
      const servers = await new MultiplayerApi(access, (input, init) => fetch(input, init), signal).servers(game.id)
      return {
        ...view,
        servers: servers.filter(server => server.state !== 'deleted').map(server => ({
          id: server.id,
          name: server.name,
          size: server.size_name ?? server.size,
          state: server.state,
          players: server.players_online ?? 0,
          ...server.bandwidth === null || server.bandwidth === undefined ? {} : { bandwidthPercent: Math.round(server.bandwidth.percent) },
        })),
      }
    } catch (error) {
      signal.throwIfAborted()
      return { ...view, servers: [], error: (error as Error).message }
    }
  }

  /**
   * Follow the links the multiplayer tools ask a window to open, such as a server purchase's confirmation page.
   * @param signal - stream cancellation.
   * @returns the links no window took yet, then again after each change, until cancelled or the plugin is disposed.
   */
  @Remote({ mode: 'stream' })
  linkRequests(signal: AbortSignal): AsyncIterable<WasdLinkRequests> {
    return this.linkQueue.follow(signal)
  }

  /**
   * Take a link for the calling window, which then opens it.
   * @param id - the link.
   * @param signal - cancellation.
   * @returns whether the window took it; false when another window did or the tool stopped waiting.
   */
  @Remote
  claimLink(id: string, signal: AbortSignal): boolean {
    signal.throwIfAborted()
    return this.linkQueue.claim(id)
  }

  /**
   * Follow the game library: the games installed on this computer and the downloads in progress.
   * @param signal - stream cancellation.
   * @returns the library, then again after each change, until cancelled or the plugin is disposed; an empty library
   * that says games do not install here where the plugin keeps none.
   */
  @Remote({ mode: 'stream' })
  library(signal: AbortSignal): AsyncIterable<WasdLibraryView> {
    if (this.games === undefined) return noLibrary(signal)
    return this.games.follow(signal)
  }

  /**
   * Start installing a game from the site, or its newer version; the library's stream follows the download.
   * @param slug - the game's address on the site, `/games/<slug>`.
   * @param version - an earlier version of a single-player game; 0 installs the latest.
   * @param signal - cancellation.
   * @returns whether the install started, or why not.
   */
  @Remote
  async installGame(slug: string, version: number, signal: AbortSignal): Promise<WasdLibraryOutcome> {
    signal.throwIfAborted()
    if (this.games === undefined) return LIBRARY_ELSEWHERE
    return await this.games.install(slug, version === 0 ? undefined : version)
  }

  /**
   * Start an installed game; an online game first installs its newer version and signs in as the app's account.
   * @param id - the game's id.
   * @param signal - stops waiting; an update the start began goes on.
   * @returns once the game started, or why it did not.
   */
  @Remote
  async launchGame(id: string, signal: AbortSignal): Promise<WasdLibraryOutcome> {
    if (this.games === undefined) return LIBRARY_ELSEWHERE
    return await this.games.launch(id, signal)
  }

  /**
   * Delete an installed game and its files.
   * @param id - the game's id.
   * @param signal - cancellation.
   * @returns whether it was deleted, or why not.
   */
  @Remote
  async removeGame(id: string, signal: AbortSignal): Promise<WasdLibraryOutcome> {
    signal.throwIfAborted()
    if (this.games === undefined) return LIBRARY_ELSEWHERE
    return await this.games.remove(id)
  }

  /**
   * Forget a failed download.
   * @param slug - the game's address on the site.
   * @param signal - cancellation.
   */
  @Remote
  dismissLibraryTask(slug: string, signal: AbortSignal): void {
    signal.throwIfAborted()
    this.games?.dismiss(slug)
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
   * A one-time link that opens a page of the WASD Engine site signed in as the app's account, which the Play page opens
   * in place of the page, so the site in the app shows the app's account. It works once, within minutes; each new link
   * the site redeems ends the session an earlier one made, and the app's sign-out ends it too.
   * @param next - the page, a path on the site such as `/explore`.
   * @param signal - cancellation.
   * @returns the link, or null while the app is signed out or once the site no longer takes its sign-in.
   */
  @Remote
  async siteSignInLink(next: string, signal: AbortSignal): Promise<string | null> {
    const access = await this.access()
    if (access === undefined) return null
    return await signInLink(access, next, (input, init) => fetch(input, init), signal) ?? null
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

  /** Run a credits change in the background; a change that fails credits nothing and leaves the call's result alone. */
  private track(change: Promise<void>): void {
    change.catch((error: unknown) => {
      if (!this.lifetime.signal.aborted) this.ctx.logger.debug(`wasd-plugins: a game's credits were not updated: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  /**
   * The Godot project a credited call worked on.
   * @param requested - the project the call named, absolute or relative to `base`.
   * @param base - the calling Session's working directory; absent for a connected agent's call without a Session.
   * @param signal - cancellation.
   * @returns the absolute folder holding `project.godot`, or undefined when the call named none and `base` is absent,
   * or the project cannot be found.
   */
  private async projectOf(requested: string | undefined, base: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    const from = requested !== undefined && isAbsolute(requested) ? requested : base
    if (from === undefined) return undefined
    try {
      return (await resolveGodotProject(from, requested, signal)).dir
    } catch {
      // A call outside a Godot project, such as one before the project exists, credits no project.
      return undefined
    }
  }

  /** Credit a Session's game work to its project: the Session's model, and the tool. */
  private async creditSession(agent: Agent, requested: string | undefined, tool: ToolCredit | undefined): Promise<void> {
    const signal = this.lifetime.signal
    const projectDir = await this.projectOf(requested, await this.ctx.workingDirectory.ensure(agent, signal), signal)
    if (projectDir === undefined) return
    const model = await this.sessionModel(agent, signal)
    await this.credits.add(projectDir, model === undefined ? [] : [model], tool === undefined ? [] : [tool])
  }

  /**
   * Credit a connected agent's game tool call: the tool, to the project the call named or the call's Session works in.
   * The Session's model is the window's, not the connected agent's, so the call credits no model.
   */
  private async creditConnected(
    client: string, requested: string | undefined, agent: Agent | undefined, tool: ToolCredit | undefined,
  ): Promise<void> {
    const signal = this.lifetime.signal
    const base = agent === undefined ? undefined : await this.ctx.workingDirectory.ensure(agent, signal)
    await this.credits.connected(client, await this.projectOf(requested, base, signal), tool)
  }

  /**
   * The model a Session's agent runs on, as a game's credits name it.
   * @param agent - the Session's agent.
   * @param signal - cancellation.
   * @returns WASD Engine's built-in AI for a built-in provider's model, else the model by name; undefined without a model.
   */
  private async sessionModel(agent: Agent, signal: AbortSignal): Promise<ModelCredit | undefined> {
    const route = agent.model.current()
    if (route === undefined) return undefined
    if (this.config.builtinModelProviders.includes(route.provider)) return { builtin: true }
    let name = route.model
    try {
      name = (await this.ctx.get('llm')?.resolveModelInfo(route.provider, route.model, signal))?.name ?? name
    } catch {
      // A provider that cannot describe the model leaves its id as the name.
    }
    const cleaned = modelName(name)
    return cleaned === undefined ? undefined : { name: cleaned }
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
