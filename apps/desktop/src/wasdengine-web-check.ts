/**
 * Web check mode of the Desktop app: started by the Godot plugin with `--wasd-web-check=` and a JSON
 * {@link WebCheckLaunch}, this process opens a Godot Web build's page in one offscreen window, watches the game load
 * and run without input, prints one stdout line with what it measured, and exits. It claims no single-instance lock,
 * shows no window, Dock icon, or menu bar, on macOS by starting from the Web check bundle of
 * `wasdengine-web-check-helper.ts`, and keeps its browser profile in a temporary folder that it deletes, so it
 * runs beside the Desktop app, whose GPU process it does not share. Nothing the page does reaches the screen or leaves
 * its build: the check talks to the page without a user gesture, and the page gets no dialogs, popups, fullscreen,
 * printing, downloads, permissions, or navigation to another origin. The mode prints its result by the deadline its
 * request names, and exits at once when the process that started it ends.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  App, BrowserWindowConstructorOptions, Debugger, RenderProcessGoneDetails, WebContentsConsoleMessageEventParams,
} from 'electron'
import type { WebCheckArgument, WebCheckConsoleLine, WebCheckMarker, WebCheckRequest, WebCheckSample } from '@deepseek-ai/dsh-godot/types'
import { WASDENGINE_DESKTOP_BRAND } from './wasdengine-brand.ts'
import { WEB_CHECK_HELPER_SWITCHES, webCheckHelperExecutable } from './wasdengine-web-check-helper.ts'

/** The argument that starts this mode; `=` and the JSON request follow it. */
export const WEB_CHECK_ARGUMENT: WebCheckArgument = '--wasd-web-check'

/** The prefix of the result line on stdout. */
export const WEB_CHECK_MARKER: WebCheckMarker = 'WASD_WEB_CHECK '

/** Most console messages a result carries. */
export const MAX_CONSOLE_LINES = 2000

/** Longest console message a result carries, in UTF-16 code units. */
export const MAX_CONSOLE_CHARS = 2000

/** Most frames a result carries; a check at 60 frames per second fills it in under three minutes. */
export const MAX_FRAMES = 10_000

/** Interval between checks for the game's start, in milliseconds. */
const POLL_MS = 250

/** Frames the game draws after it started before the check begins to watch it, about a second at 60 frames per second. */
export const READY_FRAMES = 60

/** Longest wait for the page to answer one request, in milliseconds; a page that freezes while it loads answers late. */
const READ_TIMEOUT_MS = 60_000

/**
 * Shortest wait for the page to answer one request, in milliseconds, also when a deadline is nearer: a page that does
 * not answer within it has stopped answering.
 */
const ANSWER_MS = 5000

/** Time after the mode's deadline within which a mode that has not printed its result gives up, in milliseconds. */
const GIVE_UP_MS = 2000

/** Interval between checks that the process that started the mode still runs, in milliseconds. */
const PARENT_POLL_MS = 1000

/** The browser session of the check's page, which keeps nothing on disk. */
const PARTITION = 'wasd-web-check'

/**
 * Script that runs in every frame of the page before the frame's own scripts: it records main-thread tasks of 50 ms
 * or more, and after the game started (Godot's page removed its `#status` overlay) each animation frame's interval and
 * WebGL draw calls. It also takes `print()` away, which would open the system's print dialog.
 */
export const INSTRUMENTATION = `(() => {
  try {
    Object.defineProperty(window, 'print', { value: () => undefined, writable: false, configurable: false });
  } catch (error) {
    // A frame whose print() cannot be replaced keeps it; the measurements below do not depend on it.
  }
  const state = { started: false, startMs: undefined, longTasks: [], frameMs: [], drawCalls: [], programs: 0, drawn: 0 };
  Object.defineProperty(window, '__wasdWebCheck', { value: state });
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.longTasks.push([Math.round(entry.startTime), Math.round(entry.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  } catch (error) {
    // Without long task timing the result reports no freezes.
  }
  const gl = WebGL2RenderingContext.prototype;
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
    const draw = gl[name];
    gl[name] = function (...args) { state.drawn += 1; return draw.apply(this, args); };
  }
  const link = gl.linkProgram;
  gl.linkProgram = function (...args) { state.programs += 1; return link.apply(this, args); };
  let last = 0;
  const frame = (time) => {
    if (!state.started && document.readyState !== 'loading' && document.getElementById('status') === null) {
      state.started = true;
      state.startMs = Math.round(performance.now());
    } else if (state.started && last > 0 && state.frameMs.length < ${String(MAX_FRAMES)}) {
      state.frameMs.push(Math.round((time - last) * 10) / 10);
      state.drawCalls.push(state.drawn);
    }
    state.drawn = 0;
    last = time;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();`

/** The page's measurements, as the instrumentation keeps them. */
type PageState = Pick<WebCheckSample, 'started' | 'startMs' | 'longTasks' | 'frameMs' | 'drawCalls' | 'programs'>

/** The page's measurements and the page's clock when it answered. */
interface PageRead extends PageState {
  /** Milliseconds from the page's time origin when the page answered. */
  readonly nowMs: number
}

/** Expression that returns the page's measurements and clock as JSON text, or `null` before the instrumentation ran. */
const READ_STATE = 'JSON.stringify(window.__wasdWebCheck === undefined ? null : { ...window.__wasdWebCheck, nowMs: Math.round(performance.now()) })'

/** Expression that forgets the frames before the check begins to watch. */
const BEGIN_WATCH = '(() => { const state = window.__wasdWebCheck; state.frameMs.length = 0; state.drawCalls.length = 0 })()'

/** A Web check request as the Godot plugin sends it, with the mode's own deadline (`deadlineMs`). */
export type WebCheckLaunch = WebCheckRequest

/** A navigation, or a server redirect of one, that the page starts. */
export interface WebCheckNavigation {
  /** Where it goes. */
  readonly url: string
  /** Cancel it. */
  preventDefault(): void
}

/** What the mode uses of Electron's `app`. */
export type WebCheckApp = Pick<App, 'setActivationPolicy' | 'setPath' | 'whenReady' | 'exit'> & {
  /**
   * Listen to the closing of the last window.
   * @param event - `window-all-closed`.
   * @param listener - the listener.
   */
  on(event: 'window-all-closed', listener: () => void): unknown
}

/** What the mode uses of the page's browser session. */
export interface WebCheckSession {
  /**
   * Answer the page's permission requests.
   * @param handler - gets each request's permission and the callback that answers it.
   */
  setPermissionRequestHandler(
    handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details: unknown) => void) | null,
  ): void
  /**
   * Answer the page's permission checks.
   * @param handler - returns whether the page has the permission.
   */
  setPermissionCheckHandler(
    handler: ((webContents: unknown, permission: string, requestingOrigin: string, details: unknown) => boolean) | null,
  ): void
  /**
   * Answer the page's device permission checks: USB, HID, and serial devices.
   * @param handler - returns whether the page may use the device.
   */
  setDevicePermissionHandler(handler: ((details: unknown) => boolean) | null): void
  /**
   * Listen to the downloads that the page starts.
   * @param event - `will-download`.
   * @param listener - gets the event that cancels the download.
   */
  on(event: 'will-download', listener: (event: { preventDefault(): void }) => void): unknown
}

/** What the mode uses of the page's web contents. */
export interface WebCheckContents {
  /** The page's browser session. */
  readonly session: WebCheckSession
  /** The debugger that adds the instrumentation. */
  readonly debugger: Pick<Debugger, 'attach' | 'sendCommand'>
  /** @returns whether the window was destroyed. */
  isDestroyed(): boolean
  /**
   * Load a URL.
   * @param url - the URL.
   * @returns once it loaded.
   */
  loadURL(url: string): Promise<void>
  /**
   * Evaluate an expression in the page.
   * @param code - the expression.
   * @param userGesture - whether the page sees a user gesture, which the mode never gives.
   * @returns its value.
   */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  /**
   * Mute the page.
   * @param muted - whether it is muted.
   */
  setAudioMuted(muted: boolean): void
  /**
   * Set the offscreen page's frame rate.
   * @param fps - frames per second.
   */
  setFrameRate(fps: number): void
  /**
   * Answer the page's requests for new windows.
   * @param handler - gets each request and denies it.
   */
  setWindowOpenHandler(handler: (details: unknown) => { readonly action: 'deny' }): void
  /**
   * Listen to the page's console messages.
   * @param event - `console-message`.
   * @param listener - gets each message and its level.
   */
  on(event: 'console-message', listener: (details: Readonly<Pick<WebContentsConsoleMessageEventParams, 'level' | 'message'>>) => void): unknown
  /**
   * Listen to the end of the page's process.
   * @param event - `render-process-gone`.
   * @param listener - gets why it ended.
   */
  on(event: 'render-process-gone', listener: (event: unknown, details: Readonly<Pick<RenderProcessGoneDetails, 'reason'>>) => void): unknown
  /**
   * Listen to the browser's report that the page stopped answering.
   * @param event - `unresponsive`.
   * @param listener - the listener.
   */
  on(event: 'unresponsive', listener: () => void): unknown
  /**
   * Listen to the navigations that the page or one of its frames starts, or to their server redirects.
   * @param event - `will-frame-navigate` or `will-redirect`.
   * @param listener - gets each navigation or redirect, which may cancel the navigation.
   */
  on(event: 'will-frame-navigate' | 'will-redirect', listener: (details: WebCheckNavigation) => void): unknown
}

/** What the mode uses of a window. */
export interface WebCheckWindow {
  /** The window's page. */
  readonly webContents: WebCheckContents
  /** @returns whether the window was destroyed. */
  isDestroyed(): boolean
  /** Close the window at once. */
  destroy(): void
}

/** Electron's window class, as the mode uses it. */
export type WebCheckWindowClass = new (options: BrowserWindowConstructorOptions) => WebCheckWindow

/** A stream that the mode writes one line to. */
export interface WebCheckLineStream {
  /**
   * Write text.
   * @param text - the text.
   * @param done - called once the text was written.
   */
  write(text: string, done: (error?: Error | null) => void): unknown
}

/** What the mode uses of the process it runs in. */
export interface WebCheckProcess {
  /** The id of the process's parent, read when used. */
  readonly ppid: number
  /** The process's environment. */
  readonly env: NodeJS.ProcessEnv
  /** Where the result line goes. */
  readonly stdout: WebCheckLineStream
  /** Where a failure goes. */
  readonly stderr: WebCheckLineStream
  /** @returns seconds since the process started. */
  uptime(): number
  /**
   * Test that a process exists.
   * @param pid - its id.
   * @param signal - 0, which sends nothing.
   * @throws when no process has the id.
   */
  kill(pid: number, signal: 0): unknown
  /**
   * Listen to errors that nothing caught.
   * @param event - `uncaughtException`.
   * @param listener - gets the error.
   */
  on(event: 'uncaughtException', listener: (error: Error) => void): unknown
}

/**
 * The Web check request of a command line.
 * @param argv - the process's arguments.
 * @returns the request, or undefined when the command line starts the Desktop app normally.
 * @throws {Error} when the argument is present but its request is invalid.
 */
export function webCheckRequest(argv: readonly string[]): WebCheckLaunch | undefined {
  const argument = argv.find(arg => arg.startsWith(`${WEB_CHECK_ARGUMENT}=`))
  if (argument === undefined) return undefined
  const value: unknown = JSON.parse(argument.slice(WEB_CHECK_ARGUMENT.length + 1))
  if (typeof value !== 'object' || value === null) throw new Error('Web check: the request is not an object')
  const { url, seconds, startTimeoutMs, deadlineMs, width, height } = value as Record<string, unknown>
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\//u.test(url)) throw new Error('Web check: the request URL must be a loopback http URL')
  const positive = (field: unknown): field is number => typeof field === 'number' && Number.isFinite(field) && field > 0
  if (!positive(seconds) || !positive(startTimeoutMs) || !positive(deadlineMs) || !positive(width) || !positive(height)) {
    throw new Error('Web check: seconds, startTimeoutMs, deadlineMs, width, and height must be positive numbers')
  }
  return { url, seconds, startTimeoutMs, deadlineMs, width: Math.round(width), height: Math.round(height) }
}

/**
 * The command line that starts this application in Web check mode, without the check's argument: on macOS, when the
 * application bundle holds the Web check bundle, its executable with {@link WEB_CHECK_HELPER_SWITCHES}, which never
 * shows in the Dock, else the main process's executable; then the application folder when Electron runs the
 * application from one, as in development.
 * @param execPath - the main process's executable, in `<application>.app/Contents/MacOS/` on macOS.
 * @param appPath - the application folder.
 * @param defaultApp - whether Electron's default app runs the application from `appPath`.
 * @param platform - the operating system.
 * @param exists - whether a file exists.
 * @returns the command line.
 */
export function webCheckCommand(
  execPath: string, appPath: string, defaultApp: boolean, platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string[] {
  const application = defaultApp ? [appPath] : []
  if (platform === 'darwin') {
    const helper = webCheckHelperExecutable(dirname(dirname(dirname(execPath))), WASDENGINE_DESKTOP_BRAND.productName)
    if (exists(helper)) return [helper, ...WEB_CHECK_HELPER_SWITCHES, ...application]
  }
  return [execPath, ...application]
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

/** What one request to the page came back with. */
type Answer =
  /** The page answered with `value`. */
  | { readonly kind: 'answered'; readonly value: unknown }
  /** The page did not answer within the wait. */
  | { readonly kind: 'silent' }
  /** The page navigated away, its process ended, or its window closed. */
  | { readonly kind: 'gone' }

/**
 * Evaluate an expression in the page without a user gesture, which would let the page enter fullscreen, open popups,
 * and start other prompts.
 * @param contents - the page.
 * @param expression - the expression.
 * @returns the answer once the page gave it; it never rejects.
 */
function evaluate(contents: WebCheckContents, expression: string): Promise<Answer> {
  let request: Promise<unknown>
  try {
    request = contents.executeJavaScript(expression, false)
  } catch {
    // Electron throws when the window was destroyed after the caller checked it.
    return Promise.resolve({ kind: 'gone' })
  }
  // A page that navigated away or whose process ended rejects the request.
  return request.then((value): Answer => ({ kind: 'answered', value }), (): Answer => ({ kind: 'gone' }))
}

/**
 * Evaluate an expression in the page and wait for its answer.
 * @param contents - the page.
 * @param expression - the expression.
 * @param waitMs - the longest wait.
 * @returns the answer, `silent` when the page did not give it within `waitMs`.
 */
async function ask(contents: WebCheckContents, expression: string, waitMs: number): Promise<Answer> {
  if (contents.isDestroyed()) return { kind: 'gone' }
  let timer: ReturnType<typeof setTimeout> | undefined
  const silence = new Promise<Answer>((resolve) => { timer = setTimeout(() => { resolve({ kind: 'silent' }) }, waitMs) })
  try {
    return await Promise.race([evaluate(contents, expression), silence])
  } finally {
    clearTimeout(timer)
  }
}

/** The measurements of an answer to {@link READ_STATE}; undefined for any other answer. */
function pageRead(answer: Answer): PageRead | undefined {
  if (answer.kind !== 'answered' || typeof answer.value !== 'string') return undefined
  try {
    return JSON.parse(answer.value) as PageRead | null ?? undefined
  } catch {
    // A page that replaced JSON.stringify answers text that carries no measurements.
    return undefined
  }
}

/** Whether a URL is on an origin. */
function onOrigin(url: string, origin: string): boolean {
  return URL.canParse(url) && new URL(url).origin === origin
}

/**
 * Keep the page from putting anything on screen or reaching beyond its build: it may open no windows, navigate no
 * frame to another origin, download nothing, and gets no permission, which also refuses fullscreen, notifications,
 * the microphone and camera, pointer lock, and other apps' links.
 * @param contents - the page.
 * @param origin - the origin of the build.
 */
function sealPage(contents: WebCheckContents, origin: string): void {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const stay = (details: WebCheckNavigation): void => {
    if (!onOrigin(details.url, origin)) details.preventDefault()
  }
  contents.on('will-frame-navigate', stay)
  contents.on('will-redirect', stay)
  const session = contents.session
  session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  session.setPermissionCheckHandler(() => false)
  session.setDevicePermissionHandler(() => false)
  session.on('will-download', (event) => { event.preventDefault() })
}

/**
 * Open the page offscreen and measure it: wait from opening the page up to the request's start timeout for the game to
 * start and draw {@link READY_FRAMES} frames, then watch it for the request's seconds. A page that does not answer the
 * check's last request is reported unresponsive, without frames, since the frames it measured before it froze no
 * longer describe it. Every wait ends by `deadline`, so the measurement does too.
 * @param BrowserWindow - Electron's window class.
 * @param request - what to open and how long to watch.
 * @param deadline - `Date.now()` time by which the measurement ends.
 * @returns the measurements.
 */
export async function measureWebBuild(
  BrowserWindow: WebCheckWindowClass, request: WebCheckRequest, deadline: number,
): Promise<WebCheckSample> {
  const window = new BrowserWindow({
    show: false,
    // Nothing the page asks for may put the window on screen or in the taskbar.
    fullscreenable: false,
    skipTaskbar: true,
    width: request.width,
    height: request.height,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      partition: PARTITION,
      // alert(), confirm(), and prompt() return at once: Godot calls alert() when WebGL fails or its context is lost.
      disableDialogs: true,
      disableHtmlFullscreenWindowResize: true,
    },
  })
  const contents = window.webContents
  sealPage(contents, new URL(request.url).origin)
  const messages: WebCheckConsoleLine[] = []
  /** What the browser reported about the page while the check ran. */
  const reported: { crashed?: string; unresponsive: boolean } = { unresponsive: false }
  contents.setAudioMuted(true)
  contents.setFrameRate(60)
  contents.on('console-message', (details) => {
    if (messages.length < MAX_CONSOLE_LINES) messages.push({ level: details.level, text: details.message.slice(0, MAX_CONSOLE_CHARS) })
  })
  contents.on('render-process-gone', (_event, details) => { reported.crashed = details.reason })
  contents.on('unresponsive', () => { reported.unresponsive = true })
  try {
    // Debugger commands wait for a renderer process, which a window first starts when it loads a page.
    await contents.loadURL('about:blank')
    contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Page.enable')
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION })
    // A page that fails to load never starts, which the result reports.
    contents.loadURL(request.url).catch(() => undefined)
    const opened = Date.now()
    // The watch and the read that ends it fit between the start's end and the deadline.
    const startEnd = Math.min(opened + request.startTimeoutMs, deadline - request.seconds * 1000 - 2 * ANSWER_MS)
    const wait = (until: number): number => Math.min(READ_TIMEOUT_MS, Math.max(ANSWER_MS, until - Date.now()))
    let last: Answer | undefined
    let read: PageRead | undefined
    let readyMs: number | undefined
    // The game starts when Godot removes its loading overlay, often before the game's own loading, which can freeze
    // the page; the check watches once the game draws frames steadily.
    while (reported.crashed === undefined && Date.now() < startEnd) {
      last = await ask(contents, READ_STATE, wait(startEnd))
      read = pageRead(last) ?? read
      if (read?.started === true && read.frameMs.length >= READY_FRAMES) {
        readyMs = read.nowMs
        // The check does not wait for this: a page that froze runs it, and the check's later reads, once it answers.
        void evaluate(contents, BEGIN_WATCH)
        break
      }
      await delay(POLL_MS)
    }
    let watched: PageRead | undefined
    if (readyMs !== undefined && reported.crashed === undefined) {
      await delay(Math.max(0, Math.min(request.seconds * 1000, deadline - ANSWER_MS - Date.now())))
      last = await ask(contents, READ_STATE, wait(deadline))
      watched = pageRead(last)
    }
    const silent = last?.kind === 'silent'
    const latest = watched ?? read
    // The frames since the game started until it drew steadily, else the watched ones; none from a page that went silent.
    const frames = silent ? undefined : readyMs === undefined ? read : watched
    return {
      started: read?.started ?? false,
      ...read?.startMs === undefined ? {} : { startMs: read.startMs },
      ...readyMs === undefined ? {} : { readyMs },
      longTasks: latest?.longTasks ?? [],
      frameMs: frames?.frameMs ?? [],
      drawCalls: frames?.drawCalls ?? [],
      programs: latest?.programs ?? 0,
      console: messages,
      ...reported.crashed === undefined ? {} : { crashed: reported.crashed },
      unresponsive: reported.unresponsive || silent,
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * Whether the process that started this one still runs: a POSIX process whose parent ended gets another parent, and
 * on Windows the parent's id no longer names a process.
 */
function parentRuns(host: WebCheckProcess, parent: number): boolean {
  if (host.ppid !== parent) return false
  try {
    host.kill(parent, 0)
  } catch {
    // ESRCH: no process has the id; EPERM: another user's process took it over.
    return false
  }
  return true
}

/**
 * Run Web check mode: no Dock icon or menu bar, a temporary browser profile, one offscreen page; print the result line
 * and exit with 0, or print the failure to stderr and exit with 1. The mode gives up with a failure when it has printed
 * no result shortly after its deadline, exits with 1 as soon as the process that started it ends, and reports an error
 * that nothing caught as its failure, where Electron would show a dialog.
 * @param app - Electron's application.
 * @param BrowserWindow - Electron's window class.
 * @param request - what to open, how long to watch, and the deadline.
 * @param host - this process.
 */
export function runWebCheckMode(
  app: WebCheckApp, BrowserWindow: WebCheckWindowClass, request: WebCheckLaunch, host: WebCheckProcess = process,
): void {
  const deadline = Date.now() - host.uptime() * 1000 + request.deadlineMs
  const parent = host.ppid
  let profile: string | undefined
  let finished = false
  const timers: { giveUp?: ReturnType<typeof setTimeout>; watch?: ReturnType<typeof setInterval> } = {}
  const finish = (code: number): void => {
    if (finished) return
    finished = true
    clearTimeout(timers.giveUp)
    clearInterval(timers.watch)
    try {
      if (profile !== undefined) rmSync(profile, { recursive: true, force: true })
    } catch {
      // Windows refuses to delete files that a browser process still holds; the temporary folder keeps them.
    }
    app.exit(code)
  }
  const fail = (message: string): void => {
    if (finished) return
    host.stderr.write(`Web check failed: ${message}\n`, () => { finish(1) })
  }
  host.on('uncaughtException', (error) => { fail(error.message) })
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  // A development build would print Electron's security warnings into the page's console, which the result keeps.
  host.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
  try {
    profile = mkdtempSync(join(tmpdir(), 'wasd-web-check-'))
  } catch (error) {
    // Without a profile of its own, the browser would use the Desktop app's.
    fail(`no temporary browser profile: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  // The check ends the process itself; closing its window must not quit before the result is written.
  app.on('window-all-closed', () => undefined)
  timers.giveUp = setTimeout(() => {
    fail(`no result within ${String(request.deadlineMs)} ms of the start`)
  }, Math.max(0, deadline + GIVE_UP_MS - Date.now()))
  // No one reads the result of a check whose parent ended.
  timers.watch = setInterval(() => { if (!parentRuns(host, parent)) finish(1) }, PARENT_POLL_MS)
  app.whenReady()
    .then(() => measureWebBuild(BrowserWindow, request, deadline))
    .then((sample) => {
      if (finished) return
      host.stdout.write(`${WEB_CHECK_MARKER}${JSON.stringify(sample)}\n`, () => { finish(0) })
    }, (error: unknown) => {
      fail(error instanceof Error ? error.message : String(error))
    })
}
