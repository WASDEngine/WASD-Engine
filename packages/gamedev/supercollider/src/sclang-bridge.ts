/**
 * The body of the SuperCollider bridge process, the worker that the MCP server's `JsonLineWorker` starts. The bridge
 * speaks the app MCP worker protocol (protocol 1: JSON request lines on stdin, the ready line and replies on file
 * descriptor 3) and runs one sclang as its child, which reads commands from its terminal input. sclang can neither
 * read such requests nor capture the text that code posts, so the bridge does both: it writes each request's
 * parameters to a JSON file, sends sclang `WasdWorker.dispatch(<id>, "<method>", "<file>")` followed by ESC, and
 * collects sclang's output until the worker class's reply line, adding that output to the reply. sclang stays in the
 * bridge's process group, so stopping the worker's group also stops sclang and every scsynth render it started.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { decodeServerOptions } from '@deepseek-ai/dsh-app-mcp'
import type { JsonObject, JsonValue } from '@deepseek-ai/dsh-app-mcp'
import { SclangOutputParser } from './sclang-output.ts'
import type { SclangBridgePlan } from './types.ts'

/** The worker protocol revision of the app MCP runtime. */
const PROTOCOL = 1

/** Terminal input byte that makes sclang interpret the command before it without printing its value. */
const INTERPRET = '\u001b'

/** Worker method names: the tool names, which the bridge writes into sclang code. */
const METHOD = /^[a-z][a-z0-9_]*$/u

/** Whether text holds a control character, which a path written into an sclang string literal must not hold. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const PathText = z.string().min(1).refine(text => !hasControlCharacter(text), 'must not contain control characters')

const BridgePlan = z.strictObject({
  sclang: z.array(z.string().min(1)).min(1),
  env: z.strictObject({ set: z.record(z.string(), z.string()), unset: z.array(z.string()) }),
  cwd: z.string().min(1),
  requestDirectory: PathText,
  boot: z.strictObject({
    scsynth: z.string().min(1), plugins: z.string().nullable(), scratch: z.string().min(1), helpSource: z.string().nullable(),
  }),
  graceMs: z.int().min(1),
})

const Request = z.object({ id: z.int(), method: z.string(), params: z.record(z.string(), z.json()) })

const Ready = z.object({ version: z.string() })

const Reply = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.record(z.string(), z.json()) }),
  z.object({ ok: z.literal(false), error: z.object({ type: z.string(), message: z.string(), traceback: z.string().optional() }) }),
])

/**
 * Validate the plan that the MCP server passed.
 * @param value - decoded JSON from argv[2].
 * @returns the typed plan.
 * @throws Error naming each missing, invalid, or unknown field.
 */
export function parseBridgePlan(value: JsonObject): SclangBridgePlan {
  const parsed = BridgePlan.safeParse(value)
  if (!parsed.success) throw new Error(`SuperCollider bridge: the plan in argv[2] is invalid: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/**
 * An sclang string literal of a path: backslashes and quotes escaped.
 * @param text - a path without control characters.
 * @returns the literal, quotes included.
 */
export function sclangString(text: string): string {
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * Whether a JSON value holds a string with a NUL character, which sclang's JSON parser would cut off.
 * @param value - request parameters.
 * @returns true when some string in the value contains U+0000.
 */
export function containsNul(value: JsonValue): boolean {
  if (typeof value === 'string') return value.includes('\u0000')
  if (Array.isArray(value)) return value.some(containsNul)
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsNul)
  return false
}

/**
 * sclang's environment: the bridge's own without the plan's `unset` names, with its `set` values.
 * @param env - the bridge process environment.
 * @param changes - the plan's environment changes.
 * @returns the complete sclang environment.
 */
export function sclangEnvironment(env: NodeJS.ProcessEnv, changes: SclangBridgePlan['env']): NodeJS.ProcessEnv {
  const removed = new Set(changes.unset)
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !removed.has(name))), ...changes.set }
}

/** JSON text parsed, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // SyntaxError: the text is not JSON, which the caller treats as a protocol violation.
    return undefined
  }
}

/** The process facilities the bridge uses; the server entry binds them to the bridge process. */
export interface BridgeProcess {
  /** Command line; argv[2] holds the plan. */
  readonly argv: readonly string[]
  /** Environment that sclang's environment derives from. */
  readonly env: NodeJS.ProcessEnv
  /** Request lines from the server. */
  readonly stdin: NodeJS.ReadableStream
  /**
   * Write diagnostics and sclang's output, which the server keeps as the worker's log tail.
   * @param text - text or bytes to write.
   */
  log(text: string | Uint8Array): void
  /**
   * Write one protocol line to the server.
   * @param line - a JSON line with its newline.
   * @throws Error when the server no longer reads replies.
   */
  reply(line: string): void
  /**
   * End the bridge.
   * @param code - process exit code.
   */
  exit(code: number): void
}

/**
 * Run the bridge until sclang exits or the server closes stdin. The bridge ends with sclang's exit code when sclang
 * exits, with 1 when sclang cannot start or either side breaks the protocol, with 2 when argv[2] holds no valid plan,
 * and with 0 when sclang is still running `graceMs` after the end of stdin and is killed.
 * @param io - the bridge process.
 */
export function runSclangBridge(io: BridgeProcess): void {
  const diagnose = (text: string): void => { io.log(`supercollider bridge: ${text}\n`) }
  let plan: SclangBridgePlan
  try {
    plan = parseBridgePlan(decodeServerOptions(io.argv))
  } catch (error) {
    diagnose((error as Error).message)
    io.exit(2)
    return
  }
  const token = randomBytes(16).toString('hex')
  const [command = '', ...args] = plan.sclang
  const child = spawn(command, args, {
    cwd: plan.cwd, env: sclangEnvironment(io.env, plan.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  let finished = false
  let ready = false
  let closing = false
  let active: number | undefined
  /** End the bridge once; sclang's descendants are left to the worker's process group, which the server stops. */
  const finish = (code: number): void => {
    if (finished) return
    finished = true
    child.kill('SIGKILL')
    io.exit(code)
  }
  const fail = (reason: string): void => {
    diagnose(reason)
    finish(1)
  }
  const reply = (line: JsonObject): void => {
    try {
      io.reply(`${JSON.stringify(line)}\n`)
    } catch (error) {
      fail(`the server stopped reading replies: ${(error as Error).message}`)
    }
  }

  child.on('error', (error) => { fail(`sclang could not be started: ${error.message}`) })
  // 'close' follows the end of sclang's output, so its last lines reach the log first.
  child.on('close', (code, signal) => {
    if (!closing) diagnose(`sclang exited ${signal === null ? `with code ${String(code)}` : `on signal ${signal}`}`)
    finish(code ?? 1)
  })
  child.stdin.on('error', () => {
    // EPIPE after sclang exited: its 'close' event ends the bridge.
  })
  child.stderr.on('data', (chunk: Buffer) => { io.log(chunk) })

  const parser = new SclangOutputParser(token, {
    ready(payload) {
      const parsed = Ready.safeParse(parseJson(payload))
      if (!parsed.success) {
        fail(`the worker class sent an invalid ready line: ${payload.slice(0, 200)}`)
        return
      }
      ready = true
      reply({ ready: true, protocol: PROTOCOL, app: 'supercollider', version: parsed.data.version })
    },
    reply(id, payload, output) {
      if (id !== active) {
        fail(`sclang answered request ${String(id)} while ${active === undefined ? 'no request' : `request ${String(active)}`} was pending`)
        return
      }
      active = undefined
      const parsed = Reply.safeParse(parseJson(payload))
      if (!parsed.success) {
        fail(`the worker class sent an invalid reply: ${payload.slice(0, 200)}`)
        return
      }
      const answer = parsed.data
      if (answer.ok) {
        reply({ id, ok: true, result: { ...answer.result, output } })
        return
      }
      const traceback = [answer.error.traceback ?? '', output].filter(part => part !== '').join('\n\n')
      const error = { type: answer.error.type, message: answer.error.message }
      reply({ id, ok: false, error: traceback === '' ? error : { ...error, traceback } })
    },
    startupLine(line) {
      // A boot command that sclang cannot compile means the worker class is missing from the class library.
      if (line.trimEnd() === 'ERROR: Command line parse failed') fail('the WasdWorker class is not in the class library, so the worker cannot boot')
    },
  })
  child.stdout.on('data', (chunk: Buffer) => {
    io.log(chunk)
    if (!finished) parser.push(chunk)
  })

  /**
   * Ask sclang to quit, then end its input. sclang on macOS and Linux also quits at the end of its input, but sclang on
   * Windows does not notice it and runs until it is killed.
   */
  const quit = (): void => {
    if (child.stdin.writableEnded) return
    child.stdin.write(`0.exit${INTERPRET}`)
    child.stdin.end()
  }

  const bootFile = join(plan.requestDirectory, `${token}-boot.json`)
  writeFileSync(bootFile, JSON.stringify(plan.boot))
  child.stdin.write(`WasdWorker.boot("${token}", ${sclangString(bootFile)})${INTERPRET}`)

  const requests = createInterface({ input: io.stdin, crlfDelay: Infinity })
  requests.on('line', (line) => {
    if (finished) return
    const parsed = Request.safeParse(parseJson(line))
    if (!parsed.success || !ready || active !== undefined) {
      fail(`the server sent a request out of turn: ${line.slice(0, 200)}`)
      return
    }
    const { id, method, params } = parsed.data
    if (method === 'shutdown') {
      reply({ id, ok: true, result: null })
      closing = true
      quit()
      return
    }
    if (!METHOD.test(method)) {
      reply({ id, ok: false, error: { type: 'ValueError', message: `${JSON.stringify(method)} is not a SuperCollider worker method.` } })
      return
    }
    if (containsNul(params)) {
      reply({ id, ok: false, error: { type: 'ValueError', message: 'Text sent to SuperCollider must not contain NUL characters.' } })
      return
    }
    const file = join(plan.requestDirectory, `${token}-${String(id)}.json`)
    writeFileSync(file, JSON.stringify(params))
    active = id
    child.stdin.write(`WasdWorker.dispatch(${String(id)}, "${method}", ${sclangString(file)})${INTERPRET}`)
  })
  requests.on('close', () => {
    // The server is gone or closing: sclang quits, and is killed when it does not.
    closing = true
    quit()
    setTimeout(() => { finish(0) }, plan.graceMs).unref()
  })
}
