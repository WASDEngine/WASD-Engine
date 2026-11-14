/**
 * Web check mode starts only from its argument, accepts only a valid loopback request, starts itself the way it was
 * started, keeps its page from putting anything on screen, reports a page that stops answering, and ends by its deadline
 * or when the process that started it ends.
 */
import { existsSync, rmSync } from 'node:fs'
import { runInNewContext, Script } from 'node:vm'
import type { BrowserWindowConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WebCheckApp, WebCheckContents, WebCheckLaunch, WebCheckProcess, WebCheckSession, WebCheckWindow, WebCheckWindowClass,
} from '../src/wasdengine-web-check.ts'
import { WASDENGINE_DESKTOP_BRAND } from '../src/wasdengine-brand.ts'
import { webCheckHelperExecutable } from '../src/wasdengine-web-check-helper.ts'

vi.mock('electron', () => ({}))

const {
  INSTRUMENTATION, READY_FRAMES, WEB_CHECK_ARGUMENT, WEB_CHECK_MARKER, measureWebBuild, runWebCheckMode, webCheckCommand, webCheckRequest,
} = await import('../src/wasdengine-web-check.ts')

const REQUEST: WebCheckLaunch = {
  url: 'http://127.0.0.1:4321/index.html', seconds: 20, startTimeoutMs: 180_000, deadlineMs: 290_000, width: 1280, height: 720,
}

describe('webCheckRequest', () => {
  it('reads the request of the Web check argument, and nothing from a normal launch', () => {
    expect(webCheckRequest(['/Applications/WASD Engine.app/Contents/MacOS/WASD Engine'])).toBeUndefined()
    expect(webCheckRequest(['electron', '/app', `${WEB_CHECK_ARGUMENT}=${JSON.stringify(REQUEST)}`])).toEqual(REQUEST)
    expect(webCheckRequest(['exe', `${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, width: 1280.4 })}`])).toEqual(REQUEST)
  })

  it('refuses a request that is not JSON, not loopback, or has no positive limits', () => {
    expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}={`])).toThrow(SyntaxError)
    expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=null`])).toThrow('Web check: the request is not an object')
    expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, url: 'https://example.com/' })}`]))
      .toThrow('Web check: the request URL must be a loopback http URL')
    for (const invalid of [{ seconds: 0 }, { deadlineMs: undefined }, { deadlineMs: -1 }]) {
      expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, ...invalid })}`]))
        .toThrow('Web check: seconds, startTimeoutMs, deadlineMs, width, and height must be positive numbers')
    }
  })
})

describe('webCheckCommand', () => {
  const executable = '/Applications/WASD Engine.app/Contents/MacOS/WASD Engine'
  const helper = webCheckHelperExecutable('/Applications/WASD Engine.app', WASDENGINE_DESKTOP_BRAND.productName)

  it('starts the application folder with Electron\'s default app, and the executable alone otherwise', () => {
    expect(webCheckCommand('/dev/Electron', '/repo/apps/desktop', true, 'linux', () => false)).toEqual(['/dev/Electron', '/repo/apps/desktop'])
    expect(webCheckCommand(executable, '/ignored', false, 'win32', () => true)).toEqual([executable])
  })

  it('starts from the Web check bundle on macOS, without the sandbox, when the application holds it', () => {
    expect(webCheckCommand(executable, '/ignored', false, 'darwin', path => path === helper)).toEqual([helper, '--no-sandbox'])
    const development = '/repo/apps/desktop/.desktop-build/development/WASD Engine.app'
    const developmentHelper = webCheckHelperExecutable(development, WASDENGINE_DESKTOP_BRAND.productName)
    expect(webCheckCommand(`${development}/Contents/MacOS/Electron`, '/repo/apps/desktop', true, 'darwin', path => path === developmentHelper))
      .toEqual([developmentHelper, '--no-sandbox', '/repo/apps/desktop'])
    expect(webCheckCommand(executable, '/ignored', false, 'darwin', () => false)).toEqual([executable])
  })
})

describe('INSTRUMENTATION', () => {
  it('is a script the page can run', () => {
    expect(() => new Script(INSTRUMENTATION)).not.toThrow()
  })

  it('keeps the page from opening the print dialog', () => {
    let printed = 0
    const page: { print: () => void; [name: string]: unknown } = {
      print: () => { printed += 1 },
      PerformanceObserver: class { observe(): void { /* The stand-in reports no long tasks. */ } },
      WebGL2RenderingContext: { prototype: {} },
      requestAnimationFrame: () => 0,
      document: { readyState: 'loading', getElementById: () => null },
      performance: { now: () => 0 },
    }
    page.window = page
    runInNewContext(INSTRUMENTATION, page)
    page.print()
    expect(printed).toBe(0)
  })
})

/** The measurements of a stand-in page, as the instrumentation keeps them. */
interface PageState {
  started: boolean
  startMs?: number
  longTasks: [number, number][]
  frameMs: number[]
  drawCalls: number[]
  programs: number
}

/** A stand-in page: its measurements, its clock, and when it stops answering. */
interface Page {
  readonly state: PageState
  /** Milliseconds from the page's time origin. */
  now: number
  /** The 1-based request from which on the page answers nothing; undefined keeps it answering. */
  readonly freezeFrom?: number
  /** Runs after each request the page answered, with the request's 1-based number. */
  readonly after?: (request: number) => void
}

/** A page that drew the frames the check waits for by its first answer, 1.5 s after it started. */
function readyPage(options: Pick<Page, 'freezeFrom' | 'after'> = {}): Page {
  return {
    state: {
      started: true,
      startMs: 1500,
      longTasks: [[100, 400]],
      frameMs: Array.from({ length: READY_FRAMES }, () => 16.7),
      drawCalls: Array.from({ length: READY_FRAMES }, () => 40),
      programs: 12,
    },
    now: 2000,
    ...options,
  }
}

/** A navigation as the stand-in page reports it. */
interface Navigation {
  readonly url: string
  prevented: boolean
  preventDefault(): void
}

function navigation(url: string): Navigation {
  const details: Navigation = { url, prevented: false, preventDefault: () => { details.prevented = true } }
  return details
}

class StandInSession implements WebCheckSession {
  request: Parameters<WebCheckSession['setPermissionRequestHandler']>[0] = null
  check: Parameters<WebCheckSession['setPermissionCheckHandler']>[0] = null
  device: Parameters<WebCheckSession['setDevicePermissionHandler']>[0] = null
  readonly downloads: ((event: { preventDefault(): void }) => void)[] = []

  setPermissionRequestHandler(handler: Parameters<WebCheckSession['setPermissionRequestHandler']>[0]): void { this.request = handler }
  setPermissionCheckHandler(handler: Parameters<WebCheckSession['setPermissionCheckHandler']>[0]): void { this.check = handler }
  setDevicePermissionHandler(handler: Parameters<WebCheckSession['setDevicePermissionHandler']>[0]): void { this.device = handler }
  on(_event: 'will-download', listener: (event: { preventDefault(): void }) => void): this {
    this.downloads.push(listener)
    return this
  }
}

class StandInContents implements WebCheckContents {
  readonly session = new StandInSession()
  readonly debugger = { attach: (): void => undefined, sendCommand: (): Promise<object> => Promise.resolve({}) }
  /** The gesture flag of each request, in order. */
  readonly gestures: (boolean | undefined)[] = []
  readonly navigations: ((details: Navigation) => void)[] = []
  open: Parameters<WebCheckContents['setWindowOpenHandler']>[0] | undefined
  private requests = 0

  constructor(private readonly page: Page) {}

  isDestroyed(): boolean { return false }
  loadURL(): Promise<void> { return Promise.resolve() }
  setAudioMuted(): void { /* The stand-in plays no sound. */ }
  setFrameRate(): void { /* The stand-in draws when the test says. */ }
  setWindowOpenHandler(handler: Parameters<WebCheckContents['setWindowOpenHandler']>[0]): void { this.open = handler }

  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown> {
    this.gestures.push(userGesture)
    this.requests += 1
    const request = this.requests
    if (this.page.freezeFrom !== undefined && request >= this.page.freezeFrom) return new Promise<unknown>(() => undefined)
    const page = { window: { __wasdWebCheck: this.page.state }, performance: { now: () => this.page.now }, JSON, Math }
    const value: unknown = runInNewContext(code, page)
    this.page.after?.(request)
    return Promise.resolve(value)
  }

  on(event: string, listener: (details: never, more: never) => void): this {
    if (event === 'will-frame-navigate' || event === 'will-redirect') this.navigations.push(listener as (details: Navigation) => void)
    return this
  }
}

/** A window class whose windows show the stand-in page, and the windows it made. */
function standIn(page: Page): { readonly Window: WebCheckWindowClass; readonly windows: StandInWindow[] } {
  const windows: StandInWindow[] = []
  return {
    windows,
    Window: class implements WebCheckWindow {
      readonly webContents = new StandInContents(page)
      destroyed = false
      constructor(readonly options: BrowserWindowConstructorOptions) { windows.push(this) }
      isDestroyed(): boolean { return this.destroyed }
      destroy(): void { this.destroyed = true }
    },
  }
}

/** A window the stand-in class made. */
interface StandInWindow {
  readonly options: BrowserWindowConstructorOptions
  readonly webContents: StandInContents
  readonly destroyed: boolean
}

/** Whether a promise settled, without waiting for it. */
function settled(promise: Promise<unknown>): () => boolean {
  let done = false
  void promise.finally(() => { done = true })
  return () => done
}

describe('measureWebBuild', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the page where nothing it asks for reaches the screen, and measures the watched frames', async () => {
    const page = readyPage({
      // The game draws two frames while the check watches it.
      after: (request) => { if (request === 2) page.state.frameMs.push(16.6, 16.8) },
    })
    const { Window, windows } = standIn(page)
    const measuring = measureWebBuild(Window, REQUEST, Date.now() + REQUEST.deadlineMs)
    await vi.advanceTimersByTimeAsync(REQUEST.seconds * 1000 + 1000)
    expect(await measuring).toMatchObject({ started: true, startMs: 1500, readyMs: 2000, frameMs: [16.6, 16.8], unresponsive: false })
    const [window] = windows as [StandInWindow]
    expect(window.options).toMatchObject({
      show: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'wasd-web-check',
        disableDialogs: true, disableHtmlFullscreenWindowResize: true,
      },
    })
    expect(window.destroyed).toBe(true)
    const contents = window.webContents
    // A user gesture would let the page open fullscreen, popups, and prompts.
    expect(contents.gestures.length).toBeGreaterThan(0)
    expect(contents.gestures.every(gesture => gesture === false)).toBe(true)
    expect(contents.open?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    const elsewhere = navigation('https://example.com/')
    const custom = navigation('steam://run/1')
    const sameOrigin = navigation('http://127.0.0.1:4321/next.html')
    for (const details of [elsewhere, custom, sameOrigin]) {
      for (const listener of contents.navigations) listener(details)
    }
    expect(contents.navigations).toHaveLength(2)
    expect([elsewhere.prevented, custom.prevented, sameOrigin.prevented]).toEqual([true, true, false])
    const session = contents.session
    const answers: boolean[] = []
    for (const permission of ['fullscreen', 'media', 'notifications', 'pointerLock', 'openExternal']) {
      session.request?.(contents, permission, (granted) => { answers.push(granted) }, { requestingUrl: REQUEST.url })
    }
    expect(answers).toEqual([false, false, false, false, false])
    expect(session.check?.(contents, 'media', 'http://127.0.0.1:4321', { requestingUrl: REQUEST.url })).toBe(false)
    expect(session.device?.({ deviceType: 'usb', origin: 'http://127.0.0.1:4321' })).toBe(false)
    const download = navigation('http://127.0.0.1:4321/save.bin')
    for (const listener of session.downloads) listener(download)
    expect(download.prevented).toBe(true)
  })

  it('reports a game that stops answering while the check watches it, without the frames from before the watch', async () => {
    const page = readyPage({ freezeFrom: 3 })
    const measuring = measureWebBuild(standIn(page).Window, REQUEST, Date.now() + REQUEST.deadlineMs)
    await vi.advanceTimersByTimeAsync(REQUEST.deadlineMs)
    expect(await measuring).toEqual({
      started: true, startMs: 1500, readyMs: 2000, longTasks: [[100, 400]], frameMs: [], drawCalls: [], programs: 12, console: [],
      unresponsive: true,
    })
  })

  it('does not wait for a page that freezes as the check begins to watch it', async () => {
    const page = readyPage({ freezeFrom: 2 })
    const measuring = measureWebBuild(standIn(page).Window, REQUEST, Date.now() + REQUEST.deadlineMs)
    const done = settled(measuring)
    await vi.advanceTimersByTimeAsync(REQUEST.deadlineMs)
    expect(done()).toBe(true)
    expect(await measuring).toMatchObject({ started: true, readyMs: 2000, frameMs: [], unresponsive: true })
  })

  it('reports a game that stops answering before it draws steadily', async () => {
    const page = readyPage({ freezeFrom: 2 })
    page.state.frameMs.splice(10)
    page.state.drawCalls.splice(10)
    const measuring = measureWebBuild(standIn(page).Window, REQUEST, Date.now() + REQUEST.deadlineMs)
    await vi.advanceTimersByTimeAsync(REQUEST.deadlineMs)
    const sample = await measuring
    expect(sample).toMatchObject({ started: true, frameMs: [], drawCalls: [], unresponsive: true })
    expect(sample).not.toHaveProperty('readyMs')
  })

  it('ends by its deadline when the game does not start', async () => {
    const page = readyPage()
    page.state.started = false
    // Well under the start timeout: the check stops waiting for the start in time to watch and read before it.
    const deadlineMs = 60_000
    const measuring = measureWebBuild(standIn(page).Window, REQUEST, Date.now() + deadlineMs)
    const done = settled(measuring)
    await vi.advanceTimersByTimeAsync(deadlineMs)
    expect(done()).toBe(true)
    expect(await measuring).toMatchObject({ started: false, unresponsive: false })
  })
})

/** This process as the mode sees it, with a parent that the test can end. */
interface StandInProcess extends WebCheckProcess {
  ppid: number
}

describe('runWebCheckMode', () => {
  const profiles: string[] = []

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
    for (const profile of profiles.splice(0)) rmSync(profile, { recursive: true, force: true })
  })

  /** A stand-in for Electron's app and this process, which record what the mode does with them. */
  function host(ready: Promise<void>): {
    readonly app: WebCheckApp
    readonly process: StandInProcess
    readonly exits: number[]
    readonly stdout: string[]
    readonly stderr: string[]
    crash(error: Error): void
  } {
    const exits: number[] = []
    const stdout: string[] = []
    const stderr: string[] = []
    let onCrash: (error: Error) => void = () => undefined
    const app: WebCheckApp = {
      setActivationPolicy: () => undefined,
      setPath: (name: string, path: string) => { if (name === 'userData') profiles.push(path) },
      whenReady: () => ready,
      exit: (code?: number) => { exits.push(code ?? 0) },
      on: () => app,
    }
    const parent: StandInProcess = {
      ppid: 4242,
      env: {},
      uptime: () => 0,
      kill: (pid: number) => {
        if (pid !== 4242) throw new Error('ESRCH')
        return true
      },
      stdout: { write: (text: string, done: (error?: Error | null) => void) => { stdout.push(text); done(); return true } },
      stderr: { write: (text: string, done: (error?: Error | null) => void) => { stderr.push(text); done(); return true } },
      on: (_event: 'uncaughtException', listener: (error: Error) => void) => { onCrash = listener; return parent },
    }
    return { app, process: parent, exits, stdout, stderr, crash: (error) => { onCrash(error) } }
  }

  it('prints the measurements, deletes its profile, and exits with 0', async () => {
    const mode = host(Promise.resolve())
    runWebCheckMode(mode.app, standIn(readyPage()).Window, { ...REQUEST, seconds: 1 }, mode.process)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mode.exits).toEqual([0])
    expect(mode.stdout).toHaveLength(1)
    expect(mode.stdout[0]?.startsWith(WEB_CHECK_MARKER)).toBe(true)
    expect(JSON.parse(mode.stdout[0]?.slice(WEB_CHECK_MARKER.length) ?? '')).toMatchObject({ started: true, readyMs: 2000, unresponsive: false })
    expect(profiles).toHaveLength(1)
    expect(existsSync(profiles[0] ?? '')).toBe(false)
  })

  it('gives up at its deadline when the browser never starts', async () => {
    const mode = host(new Promise<void>(() => undefined))
    runWebCheckMode(mode.app, standIn(readyPage()).Window, { ...REQUEST, deadlineMs: 10_000 }, mode.process)
    await vi.advanceTimersByTimeAsync(9000)
    expect(mode.exits).toEqual([])
    await vi.advanceTimersByTimeAsync(4000)
    expect(mode.exits).toEqual([1])
    expect(mode.stderr.join('')).toMatch(/^Web check failed: /u)
    expect(existsSync(profiles[0] ?? '')).toBe(false)
  })

  it('exits when the process that started it ends', async () => {
    const mode = host(new Promise<void>(() => undefined))
    runWebCheckMode(mode.app, standIn(readyPage()).Window, REQUEST, mode.process)
    await vi.advanceTimersByTimeAsync(3000)
    expect(mode.exits).toEqual([])
    // A POSIX process whose parent ended gets another one.
    mode.process.ppid = 1
    await vi.advanceTimersByTimeAsync(1000)
    expect(mode.exits).toEqual([1])
    expect(mode.stdout).toEqual([])
  })

  it('reports an error of its own on stderr, where Electron would show a dialog', async () => {
    const mode = host(new Promise<void>(() => undefined))
    runWebCheckMode(mode.app, standIn(readyPage()).Window, REQUEST, mode.process)
    mode.crash(new Error('boom'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mode.stderr).toEqual(['Web check failed: boom\n'])
    expect(mode.exits).toEqual([1])
  })
})
