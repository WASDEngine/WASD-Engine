/**
 * The bridge against a fake sclang process: boot and the protocol ready line, replies with the output before them,
 * failure replies, shutdown, refused requests, protocol violations by either side, and how the bridge ends.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { encodeServerOptions } from '@deepseek-ai/dsh-app-mcp'
import type { JsonObject } from '@deepseek-ai/dsh-app-mcp'
import { containsNul, parseBridgePlan, runSclangBridge, sclangEnvironment, sclangString } from '../src/sclang-bridge.ts'
import type { SclangBridgePlan } from '../src/types.ts'

const FAKE_SCLANG = fileURLToPath(new URL('./fixtures/fake-sclang.mjs', import.meta.url))

let directory = ''
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-supercollider-bridge-')) })
afterAll(async () => { await rm(directory, { recursive: true, force: true }) })

function plan(overrides: Partial<SclangBridgePlan> = {}): SclangBridgePlan {
  return {
    sclang: [process.execPath, FAKE_SCLANG],
    env: { set: { FAKE_SCLANG_MODE: 'normal' }, unset: ['ELECTRON_RUN_AS_NODE'] },
    cwd: directory,
    requestDirectory: directory,
    boot: { scsynth: '/opt/sc/scsynth', plugins: null, scratch: directory, helpSource: '/opt/sc/HelpSource' },
    graceMs: 200,
    ...overrides,
  }
}

interface Bridge {
  readonly replies: JsonObject[]
  readonly log: () => string
  readonly exited: Promise<number>
  send(line: unknown): void
  close(): void
  nextReply(count: number): Promise<JsonObject>
}

interface StartOptions {
  readonly plan?: SclangBridgePlan
  readonly mode?: string
  readonly argv?: readonly string[]
  readonly failReplies?: boolean
}

function start(options: StartOptions = {}): Bridge {
  const stdin = new PassThrough()
  const logs: string[] = []
  const replies: JsonObject[] = []
  const exited = Promise.withResolvers<number>()
  const bridgePlan = options.plan ?? plan(options.mode === undefined ? {} : { env: { set: { FAKE_SCLANG_MODE: options.mode }, unset: [] } })
  runSclangBridge({
    argv: options.argv ?? [process.execPath, 'worker.ts', encodeServerOptions(bridgePlan), '--sclang-bridge'],
    env: process.env,
    stdin,
    log: (text) => { logs.push(Buffer.from(text).toString('utf8')) },
    reply: (line) => {
      if (options.failReplies === true) throw new Error('EPIPE')
      replies.push(JSON.parse(line) as JsonObject)
    },
    exit: (code) => { exited.resolve(code) },
  })
  onTestFinished(async () => {
    stdin.end()
    await exited.promise
  })
  return {
    replies,
    log: () => logs.join(''),
    exited: exited.promise,
    send: (line) => { stdin.write(`${typeof line === 'string' ? line : JSON.stringify(line)}\n`) },
    close: () => { stdin.end() },
    nextReply: async count => await vi.waitFor(() => {
      const reply = replies[count - 1]
      if (reply === undefined) throw new Error(`waiting for reply ${String(count)}; log: ${logs.join('')}`)
      return reply
    }, { timeout: 10_000, interval: 20 }),
  }
}

describe('bridge helpers', () => {
  it('validates the plan and names each problem', () => {
    expect(parseBridgePlan({ ...plan() })).toEqual(plan())
    expect(() => parseBridgePlan({ ...plan(), requestDirectory: '/tmp/a\nb' })).toThrow(/control characters[\s\S]*requestDirectory/u)
    expect(() => parseBridgePlan({ ...plan(), requestDirectory: '/tmp/\u007f' })).toThrow(/control characters/u)
    expect(() => parseBridgePlan({ ...plan(), extra: 1 })).toThrow(/^SuperCollider bridge: the plan in argv\[2\] is invalid/u)
  })

  it('writes sclang string literals, finds NUL characters, and derives sclang\'s environment', () => {
    expect(sclangString('C:\\SC "x"')).toBe('"C:\\\\SC \\"x\\""')
    expect(containsNul({ a: ['ok', { b: 'x\u0000' }] })).toBe(true)
    expect(containsNul({ a: [1, true, null, 'fine'] })).toBe(false)
    expect(sclangEnvironment({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', XDG_DATA_HOME: '/old' }, { set: { XDG_DATA_HOME: '/new' }, unset: ['ELECTRON_RUN_AS_NODE'] }))
      .toEqual({ PATH: '/bin', XDG_DATA_HOME: '/new' })
  })
})

describe('runSclangBridge', () => {
  it('reports ready, answers requests with their output, and deletes request files', async () => {
    const bridge = start()
    expect(await bridge.nextReply(1)).toEqual({ ready: true, protocol: 1, app: 'supercollider', version: '3.14.1-fake' })
    bridge.send({ id: 1, method: 'echo', params: { code: '1 + 2', n: 3 } })
    expect(await bridge.nextReply(2)).toEqual({ id: 1, ok: true, result: { params: { code: '1 + 2', n: 3 }, output: 'posted text\n' } })
    bridge.send({ id: 2, method: 'partial', params: {} })
    expect(await bridge.nextReply(3)).toEqual({ id: 2, ok: true, result: { output: 'no newline' } })
    bridge.send({ id: 3, method: 'fail', params: {} })
    expect(await bridge.nextReply(4)).toEqual({
      id: 3, ok: false, error: { type: 'Error', message: 'boom', traceback: 'receiver: 1\n\nERROR: it failed\n' },
    })
    bridge.send({ id: 4, method: 'error_only', params: {} })
    expect(await bridge.nextReply(5)).toEqual({ id: 4, ok: false, error: { type: 'Error', message: 'quiet' } })
    expect((await readdir(directory)).filter(name => name.endsWith('.json') && !name.endsWith('-boot.json'))).toEqual([])
    expect(bridge.log()).toContain('compiling class library...')
    expect(bridge.log()).toContain('fake sclang starting')
    bridge.send({ id: 5, method: 'shutdown', params: {} })
    expect(await bridge.nextReply(6)).toEqual({ id: 5, ok: true, result: null })
    expect(await bridge.exited).toBe(0)
    expect(bridge.log()).not.toContain('sclang exited')
  })

  it('refuses invalid method names and NUL characters without involving sclang', async () => {
    const bridge = start()
    await bridge.nextReply(1)
    bridge.send({ id: 1, method: 'Bad-Name', params: {} })
    expect(await bridge.nextReply(2)).toEqual({ id: 1, ok: false, error: { type: 'ValueError', message: '"Bad-Name" is not a SuperCollider worker method.' } })
    bridge.send({ id: 2, method: 'echo', params: { code: 'a\u0000b' } })
    expect(await bridge.nextReply(3)).toEqual({ id: 2, ok: false, error: { type: 'ValueError', message: 'Text sent to SuperCollider must not contain NUL characters.' } })
  })

  it.each([
    ['a request that is not JSON', (bridge: Bridge) => { bridge.send('not json') }, 'the server sent a request out of turn'],
    ['a request while another runs', (bridge: Bridge) => {
      bridge.send({ id: 1, method: 'hang', params: {} })
      bridge.send({ id: 2, method: 'echo', params: {} })
    }, 'the server sent a request out of turn'],
    ['a reply to another request', (bridge: Bridge) => { bridge.send({ id: 1, method: 'wrong_id', params: {} }) }, 'sclang answered request 2 while request 1 was pending'],
    ['a reply that is not JSON', (bridge: Bridge) => { bridge.send({ id: 1, method: 'garbage', params: {} }) }, 'the worker class sent an invalid reply: not json'],
    ['a second reply', (bridge: Bridge) => { bridge.send({ id: 1, method: 'twice', params: {} }) }, 'sclang answered request 1 while no request was pending'],
  ])('ends with code 1 after %s', async (_case, act, message) => {
    const bridge = start()
    await bridge.nextReply(1)
    act(bridge)
    expect(await bridge.exited).toBe(1)
    expect(bridge.log()).toContain(`supercollider bridge: ${message}`)
  })

  it('ends with sclang\'s exit code when sclang exits', async () => {
    const bridge = start()
    await bridge.nextReply(1)
    bridge.send({ id: 1, method: 'crash', params: {} })
    expect(await bridge.exited).toBe(3)
    expect(bridge.log()).toContain('supercollider bridge: sclang exited with code 3')
  })

  it.each([
    ['bad-ready', 'the worker class sent an invalid ready line: {"version": 3}'],
    ['no-class', 'the WasdWorker class is not in the class library, so the worker cannot boot'],
  ])('ends with code 1 when sclang boots in mode %s', async (mode, message) => {
    const bridge = start({ mode })
    expect(await bridge.exited).toBe(1)
    expect(bridge.replies).toEqual([])
    expect(bridge.log()).toContain(message)
  })

  it('kills an sclang that outlives the end of its input by the grace period', async () => {
    const bridge = start({ mode: 'stubborn' })
    await bridge.nextReply(1)
    bridge.close()
    expect(await bridge.exited).toBe(0)
  })

  it('ends with code 1 when sclang cannot start or the server stops reading replies', async () => {
    const missing = start({ plan: plan({ sclang: [join(directory, 'missing-sclang')] }) })
    expect(await missing.exited).toBe(1)
    expect(missing.log()).toContain('supercollider bridge: sclang could not be started:')
    const deaf = start({ failReplies: true })
    expect(await deaf.exited).toBe(1)
    expect(deaf.log()).toContain('supercollider bridge: the server stopped reading replies: EPIPE')
  })

  it('ends with code 2 without a valid plan', async () => {
    const bridge = start({ argv: [process.execPath, 'worker.ts'] })
    expect(await bridge.exited).toBe(2)
    expect(bridge.log()).toContain('argv[2]')
  })
})
