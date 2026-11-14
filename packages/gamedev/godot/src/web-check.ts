/**
 * Web checks: a Web export opened in a browser, which watches it start and run without input, as players meet it.
 *
 * The plugin serves the export folder on a loopback port and starts the browser that `webCheckCommand` names, the
 * Desktop app in its Web check mode, with `--wasd-web-check=` and a JSON {@link WebCheckRequest}. That process opens the
 * page in an offscreen window with its own GPU process, measures it, and prints one stdout line, {@link WEB_CHECK_MARKER}
 * and a JSON {@link WebCheckSample}, which this module validates and turns into a {@link GodotWebCheck}: when the game
 * started, its longest main-thread freeze, its frame rate and draw calls, the errors and warnings it printed, and
 * findings that explain the ones players notice and how to fix them.
 * @module @deepseek-ai/dsh-godot/src/web-check
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { runGodotCommand } from './command.ts'
import { describeExit, formatSeconds, lastLines } from './output.ts'
import type {
  GodotWebCheck, GodotWebCheckMessage, WebCheckArgument, WebCheckMarker, WebCheckRequest, WebCheckSample,
} from './types.ts'

/** The argument that starts the Desktop app in Web check mode; `=` and the JSON request follow it. */
export const WEB_CHECK_ARGUMENT: WebCheckArgument = '--wasd-web-check'

/** The prefix of the check's result line on stdout. */
export const WEB_CHECK_MARKER: WebCheckMarker = 'WASD_WEB_CHECK '

/** Most errors and warnings a check lists; the rest are counted. */
export const WEB_CHECK_MESSAGES = 12

/** Page size of the check, in CSS pixels. */
export const WEB_CHECK_VIEWPORT = { width: 1280, height: 720 } as const

/** A main-thread task at least this long, in milliseconds, counts as a freeze. */
const FREEZE_MS = 1000

/** A longest freeze at least this long, in milliseconds, gets a finding. */
const FREEZE_FINDING_MS = 2000

/** A start slower than this, in milliseconds, gets a finding. */
const SLOW_START_MS = 20_000

/** A median frame rate below this gets a finding. */
const LOW_FPS = 30

/** A median draw call count above this gets a finding. */
const MANY_DRAW_CALLS = 1500

/** Godot's messages that mean the Web build lacks something the project uses, and what that does to the game. */
const MESSAGE_FINDINGS: readonly { readonly match: RegExp; readonly finding: string }[] = [
  {
    match: /Too many instances using shader instance variables/u,
    finding: 'Some objects render with zeros for their `instance uniform` values: browsers keep every object\'s instance uniforms in one uniform buffer of 16 to 64 KB, 16 values per object, so only about 60 to 250 objects get theirs and the rest read zeros. Give fewer objects instance uniforms: share materials, or pack per-object values into MultiMesh custom data or vertex colors.',
  },
  {
    match: /does not support manually emitting particles/u,
    finding: 'GPUParticles3D.emit_particle() does nothing on the Web, where the Compatibility renderer draws, so particles emitted with it never appear: give each effect its own one-shot CPUParticles3D or GPUParticles3D node and restart() it instead.',
  },
  {
    match: /shader type fog not supported/u,
    finding: 'FogVolume shaders (`shader_type fog`) do not run on the Web, so that fog is missing there.',
  },
  {
    match: /only available (?:when using|with) the Forward\+ renderer/u,
    finding: 'TAA and FSR exist only in Forward+, so on the Web the edges they smoothed, such as alpha-tested leaves and shadow edges, show their raw pixels.',
  },
]

/** Parameters of one Web check. */
export interface WebCheckOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Command line that starts the check's browser, before its argument; empty when this Host has none. */
  readonly command: readonly string[]
  /** Absolute folder holding the exported files. */
  readonly outputDir: string
  /** The page that starts the game, relative to `outputDir`. */
  readonly entry: string
  /** Seconds to watch the game after it started. */
  readonly seconds: number
  /** Milliseconds to wait for the game to start. */
  readonly startTimeoutMs: number
  /** Deadline of the whole check. */
  readonly timeoutMs: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream; the result line must fit. */
  readonly outputBytes: number
  /** Cancellation. */
  readonly signal: AbortSignal
}

/** A Web check that could not run or produced no result; the message says why. */
export class GodotWebCheckError extends Error {
  override name = 'GodotWebCheckError'
}

/** What a check fails with where no browser is configured. */
export const WEB_CHECK_UNAVAILABLE = 'The Web check runs in the WASD Engine Desktop app, which opens the build in a browser of its own; here none is available.'

const CONSOLE_LEVEL = z.enum(['debug', 'info', 'warning', 'error'])
const SAMPLE = z.object({
  started: z.boolean(),
  startMs: z.number().nonnegative().optional(),
  readyMs: z.number().nonnegative().optional(),
  longTasks: z.array(z.tuple([z.number(), z.number().nonnegative()])),
  frameMs: z.array(z.number().nonnegative()),
  drawCalls: z.array(z.number().int().nonnegative()),
  programs: z.number().int().nonnegative(),
  console: z.array(z.object({ level: CONSOLE_LEVEL, text: z.string() })),
  crashed: z.string().optional(),
  unresponsive: z.boolean(),
})

/**
 * Read the check's result from its stdout.
 * @param stdout - the check process's output.
 * @returns the sample, or undefined when no valid result line is present.
 */
export function parseWebCheckOutput(stdout: string): WebCheckSample | undefined {
  const line = stdout.split(/\r?\n/u).findLast(candidate => candidate.startsWith(WEB_CHECK_MARKER))
  if (line === undefined) return undefined
  let json: unknown
  try {
    json = JSON.parse(line.slice(WEB_CHECK_MARKER.length))
  } catch {
    // A truncated or garbled line is no result.
    return undefined
  }
  const parsed = SAMPLE.safeParse(json)
  if (!parsed.success) return undefined
  const { startMs, readyMs, crashed, ...sample } = parsed.data
  return {
    ...sample,
    ...startMs === undefined ? {} : { startMs },
    ...readyMs === undefined ? {} : { readyMs },
    ...crashed === undefined ? {} : { crashed },
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length - 1) / 2)] as number
}

function seconds(milliseconds: number): number {
  return Math.round(milliseconds / 100) / 10
}

/** The level of a console line Godot or the page printed as an error or warning; undefined for other output. */
function messageLevel(level: WebCheckSample['console'][number]['level'], text: string): GodotWebCheckMessage['level'] | undefined {
  if (/^(?:SCRIPT |USER |SHADER )?ERROR:/u.test(text)) return 'error'
  if (/^(?:SCRIPT |USER )?WARNING:/u.test(text)) return 'warning'
  return level === 'error' ? 'error' : undefined
}

/**
 * Collect the errors and warnings of a page's console: Godot's `ERROR:` and `WARNING:` messages, without the source
 * location line it prints after each, and the page's own errors, each with how often it was printed.
 * @param lines - the console messages, in order.
 * @returns the distinct messages in order of first appearance.
 */
export function webCheckMessages(lines: WebCheckSample['console']): GodotWebCheckMessage[] {
  const found = new Map<string, { level: GodotWebCheckMessage['level']; text: string; count: number }>()
  for (const line of lines) {
    const text = line.text.trim()
    // Godot prints the source location of an error or warning as its own message: `   at: function (file:line)`.
    if (text === '' || /^at: /u.test(text)) continue
    const level = messageLevel(line.level, text)
    if (level === undefined) continue
    const known = found.get(`${level}\n${text}`)
    if (known === undefined) found.set(`${level}\n${text}`, { level, text, count: 1 })
    else known.count += 1
  }
  return [...found.values()]
}

/**
 * Turn a check's measurements into its report.
 * @param sample - what the page measured.
 * @param watchSeconds - seconds the check watched the started game.
 * @param startTimeoutMs - how long the check waited for the game to start.
 * @returns the report, its findings included.
 */
export function summarizeWebCheck(sample: WebCheckSample, watchSeconds: number, startTimeoutMs: number): GodotWebCheck {
  const messages = webCheckMessages(sample.console)
  const longest = sample.longTasks.reduce((most, [, duration]) => Math.max(most, duration), 0)
  const freezes = sample.longTasks.filter(([, duration]) => duration >= FREEZE_MS).length
  const frames = sample.frameMs.length > 0
  // Frames over the time they took: a median interval would read alternating 17 and 33 ms frames as 60 per second.
  const fps = frames ? Math.round(1000 * sample.frameMs.length / Math.max(sample.frameMs.reduce((sum, ms) => sum + ms, 0), 1)) : undefined
  const drawCalls = sample.drawCalls.length > 0
    ? { median: median(sample.drawCalls), max: Math.max(...sample.drawCalls) }
    : undefined
  const findings: string[] = []
  if (sample.crashed !== undefined) {
    findings.push(`The page's process ended during the check (${sample.crashed}): a game that runs out of memory in a browser, which gives a page a few GB at most, stops this way.`)
  }
  if (!sample.started) {
    findings.push(`The game did not start within ${formatSeconds(startTimeoutMs)} of opening the page, so the check saw only its loading.`)
  } else if (sample.readyMs === undefined) {
    findings.push(`The game did not draw frames steadily within ${formatSeconds(startTimeoutMs)} of opening the page, so players would see it frozen or crawling that long.`)
  } else if (sample.readyMs > SLOW_START_MS) {
    findings.push(`The game took ${String(seconds(sample.readyMs))} s from opening the page to draw frames steadily, with its files already on this computer; players also wait for the download first.`)
  }
  if (longest >= FREEZE_MS && (longest >= FREEZE_FINDING_MS || freezes > 1)) {
    findings.push(`The page froze for up to ${String(seconds(longest))} s at a time (${String(freezes)} ${freezes === 1 ? 'freeze' : 'freezes'} of a second or more), drawing nothing and answering no input; browsers offer to close a page that stays frozen. Browsers run Godot's scripts and drawing on one thread, so work that takes seconds in one frame stops the whole tab: spread it over frames, for example by building a level in chunks with \`await get_tree().process_frame\` between them. Many new materials or lights appearing at once also freeze it while their shaders compile.`)
  }
  if (drawCalls !== undefined && drawCalls.median > MANY_DRAW_CALLS) {
    findings.push(`It drew about ${String(drawCalls.median)} meshes per frame (WebGL draw calls, up to ${String(drawCalls.max)}); a browser spends far longer on each draw call than a desktop driver, so above about ${MANY_DRAW_CALLS.toLocaleString('en-US')} the frame rate falls. Merge static meshes, draw repeated objects with MultiMeshInstance3D, and give small distant objects visibility ranges.`)
  }
  if (fps !== undefined && fps < LOW_FPS) {
    findings.push(`It ran at ${String(fps)} frames per second in a ${String(WEB_CHECK_VIEWPORT.width)}x${String(WEB_CHECK_VIEWPORT.height)} page.`)
  }
  for (const { match, finding } of MESSAGE_FINDINGS) {
    if (messages.some(message => match.test(message.text))) findings.push(finding)
  }
  return {
    seconds: watchSeconds,
    started: sample.started,
    ...sample.started && sample.startMs !== undefined ? { startSeconds: seconds(sample.startMs) } : {},
    ...sample.started && sample.readyMs !== undefined ? { readySeconds: seconds(sample.readyMs) } : {},
    longestFreezeSeconds: seconds(longest),
    freezes,
    ...fps === undefined ? {} : { fps, slowestFrameMs: Math.round(Math.max(...sample.frameMs)) },
    ...drawCalls === undefined ? {} : { drawCalls },
    programs: sample.programs,
    messages: messages.slice(0, WEB_CHECK_MESSAGES),
    moreMessages: Math.max(0, messages.length - WEB_CHECK_MESSAGES),
    findings,
    ...sample.crashed === undefined ? {} : { crashed: sample.crashed },
  }
}

/** Content types of the files a Web export writes. */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/** A folder served on a loopback port. */
interface ServedFolder {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string
  /** Stop serving and drop open connections. */
  close(): Promise<void>
}

/**
 * Serve a folder's files over HTTP on a loopback port: GET and HEAD of the files inside it, nothing else.
 * @param dir - absolute folder.
 * @returns the origin and its closer.
 */
export async function serveFolder(dir: string): Promise<ServedFolder> {
  const root = resolve(dir)
  const respond = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }
    let path: string
    try {
      path = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
    } catch {
      // A malformed escape names no file.
      response.writeHead(400).end()
      return
    }
    const file = resolve(join(root, path))
    const inside = relative(root, file)
    if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      response.writeHead(404).end()
      return
    }
    const found = await stat(file).catch(() => undefined)
    if (found === undefined || !found.isFile()) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(found.size),
      'cache-control': 'no-store',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    const stream = createReadStream(file)
    stream.on('error', () => { response.destroy() })
    stream.pipe(response)
  }
  const server = createServer((request, response) => {
    respond(request, response).catch(() => { response.destroy() })
  })
  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', fail)
      done()
    })
  })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((done) => {
      server.close(() => { done() })
      server.closeAllConnections()
    }),
  }
}

/**
 * Check a Web export: serve it, open it in the check's browser, and report what the browser saw.
 * @param options - the build, the browser, and the limits.
 * @returns the report.
 * @throws {GodotWebCheckError} when no browser is configured, or the browser ends without a result.
 */
export async function checkWebBuild(options: WebCheckOptions): Promise<GodotWebCheck> {
  if (options.command.length === 0) throw new GodotWebCheckError(WEB_CHECK_UNAVAILABLE)
  const served = await serveFolder(options.outputDir)
  try {
    const request: WebCheckRequest = {
      url: `${served.origin}/${options.entry.split('/').map(encodeURIComponent).join('/')}`,
      seconds: options.seconds,
      startTimeoutMs: options.startTimeoutMs,
      ...WEB_CHECK_VIEWPORT,
    }
    const outcome = await runGodotCommand({
      subprocess: options.subprocess,
      argv: [...options.command, `${WEB_CHECK_ARGUMENT}=${JSON.stringify(request)}`],
      cwd: options.outputDir,
      timeoutMs: options.timeoutMs,
      graceMs: options.graceMs,
      outputBytes: options.outputBytes,
      signal: options.signal,
    })
    options.signal.throwIfAborted()
    const sample = parseWebCheckOutput(outcome.stdout)
    if (sample === undefined) {
      const ended = outcome.timedOut ? `did not finish within ${formatSeconds(options.timeoutMs)}` : `ended (${describeExit(outcome.exit)})`
      const tail = lastLines(outcome.stderr, 10) || lastLines(outcome.stdout, 10)
      throw new GodotWebCheckError(`The Web check's browser ${ended} without a result.${tail === '' ? '' : `\nLast output:\n${tail}`}`)
    }
    return summarizeWebCheck(sample, options.seconds, options.startTimeoutMs)
  } finally {
    await served.close()
  }
}

/** A Web check report whose message levels are plain strings, as tool results carry it. */
export type GodotWebCheckView = Omit<GodotWebCheck, 'messages'> & {
  readonly messages: readonly { readonly level: string; readonly text: string; readonly count: number }[]
}

/**
 * Describe a Web check: what it did, what it measured, the errors and warnings, and the findings.
 * @param check - the report.
 * @returns the text, one paragraph or list item per line.
 */
export function formatWebCheck(check: GodotWebCheckView): string {
  const measured = [
    `longest freeze ${String(check.longestFreezeSeconds)} s${check.freezes > 0 ? ` (${String(check.freezes)} of a second or more)` : ''}`,
    ...check.fps === undefined ? [] : [`${String(check.fps)} fps, slowest frame ${String(check.slowestFrameMs ?? 0)} ms`],
    ...check.drawCalls === undefined ? [] : [`${String(check.drawCalls.median)} draw calls per frame (median, up to ${String(check.drawCalls.max)})`],
    `${String(check.programs)} shader programs`,
    ...check.crashed === undefined ? [] : [`the page's process ended (${check.crashed})`],
  ].join('; ')
  let opening: string
  if (!check.started) opening = 'Web check: a browser opened the build, and the game did not start'
  else if (check.readySeconds === undefined) opening = `Web check: a browser opened the build, Godot started the game after ${String(check.startSeconds ?? 0)} s, and it never drew frames steadily`
  else opening = `Web check: a browser opened the build, Godot started the game after ${String(check.startSeconds ?? 0)} s, it drew frames steadily from ${String(check.readySeconds)} s on, and the check watched it run for ${String(check.seconds)} s without input`
  const lines = [`${opening}: ${measured}.`]
  if (check.messages.length === 0) {
    lines.push('The build printed no errors or warnings.')
  } else {
    lines.push('Errors and warnings the build printed:', ...check.messages.map(message => `- ${message.text}${message.count > 1 ? ` (${String(message.count)} times)` : ''}`))
    if (check.moreMessages > 0) lines.push(`- … and ${String(check.moreMessages)} more.`)
  }
  if (check.findings.length > 0) lines.push('Findings:', ...check.findings.map(finding => `- ${finding}`))
  return lines.join('\n')
}
