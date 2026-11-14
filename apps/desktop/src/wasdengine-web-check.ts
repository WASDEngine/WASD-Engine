/**
 * Web check mode of the Desktop app: started by the Godot plugin with `--wasd-web-check=` and a JSON
 * `WebCheckRequest`, this process opens a Godot Web build's page in one offscreen window, watches the game load and run
 * without input, prints one stdout line with what it measured, and exits. It claims no single-instance lock, shows no
 * window, Dock icon, or menu bar, and keeps its browser profile in a temporary folder that it deletes, so it runs beside
 * the Desktop app, whose GPU process it does not share.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { App, BrowserWindow as BrowserWindowClass, WebContents } from 'electron'
import type { WebCheckArgument, WebCheckConsoleLine, WebCheckMarker, WebCheckRequest, WebCheckSample } from '@deepseek-ai/dsh-godot/types'

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

/** Longest wait for one read of the page's measurements, in milliseconds; a frozen page answers late. */
const READ_TIMEOUT_MS = 60_000

/**
 * Script that runs in the page before its own scripts: it records main-thread tasks of 50 ms or more, and after the
 * game started (Godot's page removed its `#status` overlay) each animation frame's interval and WebGL draw calls.
 */
export const INSTRUMENTATION = `(() => {
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

/** Expression that returns the page's measurements as JSON text. */
const READ_STATE = 'JSON.stringify(window.__wasdWebCheck ?? null)'

/** Expression that forgets the frames before the check begins to watch, and returns that moment. */
const BEGIN_WATCH = '(() => { const state = window.__wasdWebCheck; state.frameMs.length = 0; state.drawCalls.length = 0; return Math.round(performance.now()) })()'

/**
 * The Web check request of a command line.
 * @param argv - the process's arguments.
 * @returns the request, or undefined when the command line starts the Desktop app normally.
 * @throws {Error} when the argument is present but its request is invalid.
 */
export function webCheckRequest(argv: readonly string[]): WebCheckRequest | undefined {
  const argument = argv.find(arg => arg.startsWith(`${WEB_CHECK_ARGUMENT}=`))
  if (argument === undefined) return undefined
  const value: unknown = JSON.parse(argument.slice(WEB_CHECK_ARGUMENT.length + 1))
  if (typeof value !== 'object' || value === null) throw new Error('Web check: the request is not an object')
  const { url, seconds, startTimeoutMs, width, height } = value as Record<string, unknown>
  if (typeof url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\//u.test(url)) throw new Error('Web check: the request URL must be a loopback http URL')
  const positive = (field: unknown): field is number => typeof field === 'number' && Number.isFinite(field) && field > 0
  if (!positive(seconds) || !positive(startTimeoutMs) || !positive(width) || !positive(height)) {
    throw new Error('Web check: seconds, startTimeoutMs, width, and height must be positive numbers')
  }
  return { url, seconds, startTimeoutMs, width: Math.round(width), height: Math.round(height) }
}

/**
 * The command line that starts this application in Web check mode, without the check's argument: the executable, and
 * the application folder when Electron runs the application from one, as in development.
 * @param execPath - the main process's executable.
 * @param appPath - the application folder.
 * @param defaultApp - whether Electron's default app runs the application from `appPath`.
 * @returns the command line.
 */
export function webCheckCommand(execPath: string, appPath: string, defaultApp: boolean): string[] {
  return defaultApp ? [execPath, appPath] : [execPath]
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function readState(contents: WebContents): Promise<PageState | undefined> {
  if (contents.isDestroyed()) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined) }, READ_TIMEOUT_MS) })
  try {
    const text: unknown = await Promise.race([contents.executeJavaScript(READ_STATE, true), timeout])
    return typeof text === 'string' ? JSON.parse(text) as PageState | null ?? undefined : undefined
  } catch {
    // A page that navigated away or whose process ended has no measurements.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

async function beginWatch(contents: WebContents): Promise<number | undefined> {
  try {
    const time: unknown = await contents.executeJavaScript(BEGIN_WATCH, true)
    return typeof time === 'number' ? time : undefined
  } catch {
    // A page that navigated away or whose process ended is not watched.
    return undefined
  }
}

/**
 * Open the page offscreen and measure it.
 * @param BrowserWindow - Electron's window class.
 * @param request - what to open and how long to watch.
 * @returns the measurements.
 */
export async function measureWebBuild(BrowserWindow: typeof BrowserWindowClass, request: WebCheckRequest): Promise<WebCheckSample> {
  const window = new BrowserWindow({
    show: false,
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
      partition: 'wasd-web-check',
    },
  })
  const contents = window.webContents
  const messages: WebCheckConsoleLine[] = []
  let crashed: string | undefined
  let unresponsive = false
  contents.setAudioMuted(true)
  contents.setFrameRate(60)
  contents.on('console-message', (details) => {
    if (messages.length < MAX_CONSOLE_LINES) messages.push({ level: details.level, text: details.message.slice(0, MAX_CONSOLE_CHARS) })
  })
  contents.on('render-process-gone', (_event, details) => { crashed = details.reason })
  contents.on('unresponsive', () => { unresponsive = true })
  try {
    // Debugger commands wait for a renderer process, which a window first starts when it loads a page.
    await contents.loadURL('about:blank')
    contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('Page.enable')
    await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENTATION })
    // A page that fails to load never starts, which the result reports.
    contents.loadURL(request.url).catch(() => undefined)
    const opened = Date.now()
    const waiting = (): boolean => crashed === undefined && Date.now() - opened < request.startTimeoutMs
    let state: PageState | undefined
    // The game starts when Godot removes its loading overlay, often before the game's own loading, which can freeze
    // the page; the check watches once the game draws frames steadily.
    let readyMs: number | undefined
    while (waiting()) {
      state = await readState(contents) ?? state
      if (state?.started === true && state.frameMs.length >= READY_FRAMES) {
        readyMs = await beginWatch(contents)
        break
      }
      await delay(POLL_MS)
    }
    if (readyMs !== undefined && crashed === undefined) {
      await delay(request.seconds * 1000)
      state = await readState(contents) ?? state
    }
    return {
      started: state?.started ?? false,
      ...state?.startMs === undefined ? {} : { startMs: state.startMs },
      ...readyMs === undefined ? {} : { readyMs },
      longTasks: state?.longTasks ?? [],
      frameMs: state?.frameMs ?? [],
      drawCalls: state?.drawCalls ?? [],
      programs: state?.programs ?? 0,
      console: messages,
      ...crashed === undefined ? {} : { crashed },
      unresponsive,
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * Run Web check mode: no Dock icon or menu bar, a temporary browser profile, one offscreen page; print the result line
 * and exit with 0, or print the failure to stderr and exit with 1.
 * @param app - Electron's application.
 * @param BrowserWindow - Electron's window class.
 * @param request - what to open and how long to watch.
 */
export function runWebCheckMode(app: App, BrowserWindow: typeof BrowserWindowClass, request: WebCheckRequest): void {
  if (process.platform === 'darwin') app.setActivationPolicy('accessory')
  // A development build would print Electron's security warnings into the page's console, which the result keeps.
  process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true'
  const profile = mkdtempSync(join(tmpdir(), 'wasd-web-check-'))
  app.setPath('userData', profile)
  app.setPath('sessionData', profile)
  // The check ends the process itself; closing its window must not quit before the result is written.
  app.on('window-all-closed', () => undefined)
  const finish = (code: number): void => {
    rmSync(profile, { recursive: true, force: true })
    app.exit(code)
  }
  app.whenReady()
    .then(() => measureWebBuild(BrowserWindow, request))
    .then((sample) => {
      process.stdout.write(`${WEB_CHECK_MARKER}${JSON.stringify(sample)}\n`, () => { finish(0) })
    }, (error: unknown) => {
      process.stderr.write(`Web check failed: ${error instanceof Error ? error.message : String(error)}\n`, () => { finish(1) })
    })
}
