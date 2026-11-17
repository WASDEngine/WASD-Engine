/**
 * Web check mode starts only from its argument, accepts only a valid loopback request, starts itself the way it was
 * started, keeps its page from putting anything on screen, reports a page that stops answering, and ends by its deadline
 * or when the process that started it ends.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext, Script } from 'node:vm'
import type { BrowserWindowConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WebCheckApp, WebCheckContents, WebCheckImage, WebCheckLaunch, WebCheckProcess, WebCheckSession, WebCheckWindow, WebCheckWindowClass,
} from '../src/wasdengine-web-check.ts'
import { WASDENGINE_DESKTOP_BRAND } from '../src/wasdengine-brand.ts'
import { webCheckHelperExecutable } from '../src/wasdengine-web-check-helper.ts'

vi.mock('electron', () => ({}))

const {
  ConsoleMessages, DEFAULT_RESULT_BYTES, INSTRUMENTATION, MAX_CONSOLE_CHARS, MAX_CONSOLE_LINES, READY_FRAMES, SCREENSHOT_QUALITY,
  WEB_CHECK_ARGUMENT, WEB_CHECK_MARKER, measureWebBuild, resultLine, runWebCheckMode, webCheckCommand, webCheckRequest,
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

  it('reads the absolute path where the page\'s screenshot goes, and refuses any other', () => {
    const shot = { ...REQUEST, screenshot: '/game/.wasdengine/web-check.jpg' }
    expect(webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify(shot)}`])).toEqual(shot)
    for (const screenshot of ['web-check.jpg', 7]) {
      expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, screenshot })}`]))
        .toThrow('Web check: screenshot must be an absolute file path')
    }
  })

  it('reads the bytes the result line may take, which must be a positive integer', () => {
    expect(webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, resultBytes: 4096 })}`])).toEqual({ ...REQUEST, resultBytes: 4096 })
    for (const resultBytes of [0, 1.5, '4096']) {
      expect(() => webCheckRequest([`${WEB_CHECK_ARGUMENT}=${JSON.stringify({ ...REQUEST, resultBytes })}`]))
        .toThrow('Web check: resultBytes must be a positive integer')
    }
  })
})

describe('ConsoleMessages', () => {
  it('keeps each distinct message once with how often it was printed, in order of first appearance', () => {
    const messages = new ConsoleMessages()
    messages.add('error', 'ERROR: lost')
    messages.add('info', 'hello')
    for (let index = 0; index < 5; index++) messages.add('error', 'ERROR: lost')
    messages.add('warning', `WARNING: ${'w'.repeat(MAX_CONSOLE_CHARS * 2)}`)
    messages.add('info', 'ERROR: lost')
    expect(messages.lines()).toEqual([
      { level: 'error', text: 'ERROR: lost', count: 6 },
      { level: 'info', text: 'hello' },
      { level: 'warning', text: `WARNING: ${'w'.repeat(MAX_CONSOLE_CHARS - 9)}` },
      { level: 'info', text: 'ERROR: lost' },
    ])
  })

  it('still keeps errors and warnings after the page printed as many other messages as it keeps', () => {
    const messages = new ConsoleMessages()
    for (let index = 0; index < MAX_CONSOLE_LINES + 10; index++) messages.add('info', `line ${String(index)}`)
    messages.add('error', 'ERROR: late')
    messages.add('info', 'line 0')
    const lines = messages.lines()
    expect(lines.filter(line => line.level === 'info')).toHaveLength(MAX_CONSOLE_LINES)
    expect(lines.at(-1)).toEqual({ level: 'error', text: 'ERROR: late' })
    expect(lines[0]).toEqual({ level: 'info', text: 'line 0', count: 2 })
  })
})

describe('resultLine', () => {
  const sample = (console: { level: 'debug' | 'info' | 'warning' | 'error'; text: string }[], longTasks: [number, number][] = [[10, 60]]) => ({
    started: true, startMs: 1500, readyMs: 2000, longTasks, frameMs: [16.6, 16.8], drawCalls: [3, 4], programs: 2, console,
    unresponsive: false,
  })
  const parse = (line: string): ReturnType<typeof sample> => JSON.parse(line.slice(WEB_CHECK_MARKER.length)) as ReturnType<typeof sample>

  it('prints the whole sample when it fits', () => {
    const whole = sample([{ level: 'info', text: 'hi' }])
    expect(resultLine(whole, DEFAULT_RESULT_BYTES)).toBe(`${WEB_CHECK_MARKER}${JSON.stringify(whole)}\n`)
  })

  it('keeps the errors and warnings first, then other messages, in order of first appearance, within the bytes', () => {
    const big = 'z'.repeat(1000)
    const console = [
      { level: 'info' as const, text: `first ${big}` },
      { level: 'error' as const, text: `ERROR: one ${big}` },
      { level: 'info' as const, text: `second ${big}` },
      { level: 'warning' as const, text: `WARNING: two ${big}` },
    ]
    const base = Buffer.byteLength(resultLine(sample([]), DEFAULT_RESULT_BYTES))
    // Room for three of the four messages.
    const line = resultLine(sample(console), base + 3 * 1040)
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(base + 3 * 1040)
    expect(line.endsWith('\n')).toBe(true)
    expect(parse(line).console.map(entry => entry.text.slice(0, 12))).toEqual([`first ${big}`, `ERROR: one ${big}`, `WARNING: two ${big}`].map(text => text.slice(0, 12)))
    const tight = parse(resultLine(sample(console), base + 1040))
    expect(tight.console.map(entry => entry.level)).toEqual(['error'])
  })

  it('keeps the longest tasks when even the measurements without the console are too long', () => {
    // One task of 4 s among 5,000 short ones.
    const tasks = Array.from({ length: 5000 }, (_unused, index): [number, number] => [index * 100, index === 2500 ? 4000 : 50 + index % 7])
    const line = resultLine(sample([{ level: 'error', text: 'ERROR: x' }], tasks), 20_000)
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(20_000)
    const fitted = parse(line)
    expect(fitted.longTasks).toContainEqual([250_000, 4000])
    expect(fitted.longTasks.map(task => task[0])).toEqual([...fitted.longTasks.map(task => task[0])].sort((left, right) => left - right))
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
  /** What capturing the page gives: an image of this size, an empty image, or no answer at all. Default: empty. */
  readonly capture?: { readonly width: number; readonly height: number } | 'empty' | 'never'
}

/** A page that drew the frames the check waits for by its first answer, 1.5 s after it started. */
function readyPage(options: Pick<Page, 'freezeFrom' | 'after' | 'capture'> = {}): Page {
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
  private readonly consoles: ((details: { level: 'debug' | 'info' | 'warning' | 'error'; message: string }) => void)[] = []
  open: Parameters<WebCheckContents['setWindowOpenHandler']>[0] | undefined
  private requests = 0

  constructor(private readonly page: Page) {}

  /** The JPEG qualities that the page's captures were encoded at. */
  readonly encoded: number[] = []

  isDestroyed(): boolean { return false }
  loadURL(): Promise<void> { return Promise.resolve() }
  capturePage(): Promise<WebCheckImage> {
    const capture = this.page.capture ?? 'empty'
    if (capture === 'never') return new Promise<WebCheckImage>(() => undefined)
    const size = capture === 'empty' ? { width: 0, height: 0 } : capture
    return Promise.resolve({
      isEmpty: () => capture === 'empty',
      getSize: () => size,
      toJPEG: (quality) => {
        this.encoded.push(quality)
        return new TextEncoder().encode(`jpeg ${String(size.width)}x${String(size.height)}`)
      },
    })
  }
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
    if (event === 'console-message') this.consoles.push(listener as (details: { level: 'debug' | 'info' | 'warning' | 'error'; message: string }) => void)
    return this
  }

  /** Print a console message, as the page would. */
  log(level: 'debug' | 'info' | 'warning' | 'error', message: string): void {
    for (const listener of this.consoles) listener({ level, message })
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

  it('saves the page as it last drew it where the request names a file, and reports its size', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'wasd-web-check-shot-'))
    try {
      const path = join(folder, 'web-check.jpg')
      const page = readyPage({ capture: { width: 1280, height: 720 } })
      const { Window, windows } = standIn(page)
      const measuring = measureWebBuild(Window, { ...REQUEST, screenshot: path }, Date.now() + REQUEST.deadlineMs)
      await vi.advanceTimersByTimeAsync(REQUEST.seconds * 1000 + 1000)
      expect(await measuring).toMatchObject({ started: true, screenshot: { width: 1280, height: 720 } })
      expect(readFileSync(path, 'utf8')).toBe('jpeg 1280x720')
      expect((windows[0] as StandInWindow).webContents.encoded).toEqual([SCREENSHOT_QUALITY])
      // Without a file named, the check captures nothing.
      const unasked = standIn(readyPage({ capture: { width: 1280, height: 720 } }))
      const plain = measureWebBuild(unasked.Window, REQUEST, Date.now() + REQUEST.deadlineMs)
      await vi.advanceTimersByTimeAsync(REQUEST.seconds * 1000 + 1000)
      expect(await plain).not.toHaveProperty('screenshot')
      expect((unasked.windows[0] as StandInWindow).webContents.encoded).toEqual([])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('reports no screenshot of a page that drew nothing, gave no image in time, or could not be saved', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'wasd-web-check-shot-'))
    try {
      const path = join(folder, 'web-check.jpg')
      for (const capture of ['empty', 'never'] as const) {
        const { Window } = standIn(readyPage({ capture }))
        const measuring = measureWebBuild(Window, { ...REQUEST, screenshot: path }, Date.now() + REQUEST.deadlineMs)
        const done = settled(measuring)
        await vi.advanceTimersByTimeAsync(REQUEST.deadlineMs)
        expect(done(), capture).toBe(true)
        expect(await measuring, capture).not.toHaveProperty('screenshot')
      }
      expect(existsSync(path)).toBe(false)
      const unwritable = measureWebBuild(
        standIn(readyPage({ capture: { width: 64, height: 36 } })).Window, { ...REQUEST, screenshot: join(folder, 'gone', 'web-check.jpg') }, Date.now() + REQUEST.deadlineMs,
      )
      await vi.advanceTimersByTimeAsync(REQUEST.seconds * 1000 + 1000)
      expect(await unwritable).not.toHaveProperty('screenshot')
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
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

  it('prints a result line within the bytes the request names, keeping the page\'s errors', async () => {
    const mode = host(Promise.resolve())
    let windows: StandInWindow[] = []
    // The page logs much before its error, while the check waits for it to draw.
    const page = readyPage({
      after: (request) => {
        if (request !== 1) return
        const contents = (windows[0] as StandInWindow).webContents
        for (let index = 0; index < 300; index++) contents.log('info', `spam ${String(index)} ${'s'.repeat(200)}`)
        contents.log('error', 'ERROR: the one that matters')
      },
    })
    const stand = standIn(page)
    windows = stand.windows
    runWebCheckMode(mode.app, stand.Window, { ...REQUEST, seconds: 1, resultBytes: 8192 }, mode.process)
    await vi.advanceTimersByTimeAsync(2000)
    expect(mode.exits).toEqual([0])
    expect(Buffer.byteLength(mode.stdout[0] ?? '')).toBeLessThanOrEqual(8192)
    const result = JSON.parse(mode.stdout[0]?.slice(WEB_CHECK_MARKER.length) ?? '') as { console: { text: string }[] }
    expect(result.console.map(line => line.text)).toContain('ERROR: the one that matters')
  })

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
