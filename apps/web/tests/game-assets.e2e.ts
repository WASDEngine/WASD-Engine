/**
 * Keyless assembled-Web evidence for the agent's asset tools: the shipped composition mounts the `game-assets` row and
 * the Assets tab, a real Chromium window connects, and scripted models use the tools. One model lists the project's
 * art, has the window draw a skinned and animated glTF model from two sides with its skeleton and across its clip, and
 * reads a PNG strip as a sprite grid and as that grid's frames, then shows it in the Assets tab, read as that grid and
 * playing it; a reveal of the model with a clip opens it playing that clip on the timeline. Then agents look at
 * different assets at the same time: one model turn that asks for four, three teammates of an agent team (one started
 * in a subfolder, one showing its asset in the lead's Session), subagents beside their lead, and Claude Code and Codex
 * calling through WASD Engine's MCP server. The Host sends their requests to the window together, the window draws
 * three at a time, and every call gets its own asset's picture and details. Set `DSH_ASSET_E2E_OUT` to keep the drawn
 * images and screenshots.
 */
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-team'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import type { AssetReveal } from '@deepseek-ai/dsh-game-assets/types'
import type {} from '@deepseek-ai/dsh-game-mcp'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { launchWebScaffold, type LaunchOptions, type WebScaffold } from './scaffold.ts'

const PROVIDER = 'game-assets-web-test'
const MODEL = 'scripted-vision'
const DONE = 'GAME_ASSETS_SCRIPT_DONE'

/** The scripted turn. */
const SCRIPT = [
  { name: 'asset_search', args: {} },
  { name: 'asset_view', args: { path: 'models/robot.gltf', views: ['iso', 'front'], skeleton: true, size: 768 } },
  { name: 'asset_view', args: { path: 'models/robot.gltf', animation: 'Wave', frames: 4, shading: 'solid', size: 768 } },
  { name: 'asset_view', args: { path: 'art/hero_strip.png', grid: { columns: 4, rows: 1 } } },
  { name: 'asset_view', args: { path: 'art/hero_strip.png', grid: { columns: 4, rows: 1 }, animation: 'grid', show: true } },
] as const

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) { return [{ provider, id: MODEL, name: MODEL }] }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000, inputModalities: ['text', 'image'] })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = SCRIPT[options.messages.filter(message => message.role === 'tool').length]
    if (step === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: DONE }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: DONE } }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = ToolCallId(`game-assets-${this.requests.length}`)
    const args = JSON.stringify(step.args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** POST one generated Remote unary through the authenticated Web carrier. */
async function remote<T>(target: WebScaffold, endpoint: string, args: Readonly<Record<string, unknown>>): Promise<T> {
  const response = await target.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `game-assets-${endpoint}-${randomUUID()}`, method: endpoint, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  const result = (await response.json() as { result: RpcResult<T> }).result
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** A PNG of RGBA pixels, encoded without dependencies. */
function png(width: number, height: number, pixel: (x: number, y: number) => readonly [number, number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer): number => {
    let c = 0xffffffff
    for (const byte of bytes) c = (table[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 6, 0, 0, 0], 8)
  const rows = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) rows.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4)
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

/** A two-bone skinned quad whose arm bone waves 45 degrees about Z over one second, as glTF with an embedded buffer. */
function robotGltf(): string {
  const buffer = Buffer.alloc(328)
  const floats = (offset: number, values: readonly number[]): void => {
    values.forEach((value, index) => buffer.writeFloatLE(value, offset + index * 4))
  }
  floats(0, [-0.5, 0, 0, 0.5, 0, 0, 0.5, 2, 0, -0.5, 2, 0])
  ;[0, 1, 2, 0, 2, 3].forEach((value, index) => buffer.writeUInt16LE(value, 48 + index * 2))
  buffer.set([0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 60)
  floats(76, [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])
  floats(140, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1])
  floats(268, [0, 0.5, 1])
  floats(280, [0, 0, 0, 1, 0, 0, 0.3827, 0.9239, 0, 0, 0, 1])
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Body', mesh: 0, skin: 0 }, { name: 'Root', children: [2] }, { name: 'Arm', translation: [0, 1, 0] }],
    meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1, material: 0 }] }],
    materials: [{ name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [0.85, 0.3, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.6 }, doubleSided: true }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 4 }],
    animations: [{ name: 'Wave', channels: [{ sampler: 0, target: { node: 2, path: 'rotation' } }], samplers: [{ input: 5, output: 6 }] }],
    buffers: [{ byteLength: 328, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 48, target: 34962 },
      { buffer: 0, byteOffset: 48, byteLength: 12, target: 34963 },
      { buffer: 0, byteOffset: 60, byteLength: 16, target: 34962 },
      { buffer: 0, byteOffset: 76, byteLength: 64, target: 34962 },
      { buffer: 0, byteOffset: 140, byteLength: 128 },
      { buffer: 0, byteOffset: 268, byteLength: 12 },
      { buffer: 0, byteOffset: 280, byteLength: 48 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [-0.5, 0, 0], max: [0.5, 2, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
      { bufferView: 2, componentType: 5121, count: 4, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 4, type: 'VEC4' },
      { bufferView: 4, componentType: 5126, count: 2, type: 'MAT4' },
      { bufferView: 5, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 6, componentType: 5126, count: 3, type: 'VEC4' },
    ],
  })
}

/** A 64 × 16 strip of four 16 × 16 frames: a square that moves right on a transparent ground. */
function heroStrip(): Buffer {
  const colors = [[230, 80, 60, 255], [240, 170, 40, 255], [70, 180, 90, 255], [60, 120, 230, 255]] as const
  return png(64, 16, (x, y) => {
    const frame = Math.floor(x / 16)
    const left = 2 + frame * 2
    const inside = x % 16 >= left && x % 16 < left + 8 && y >= 4 && y < 12
    return inside ? colors[frame] ?? [0, 0, 0, 255] : [0, 0, 0, 0]
  })
}

function text(blocks: readonly ContentBlock[]): string {
  return blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

function images(blocks: readonly ContentBlock[]): ImageAttachmentRef[] {
  return blocks.flatMap(block => block.type === 'image' && 'attachment' in block ? [block.attachment] : [])
}

/** A unit cube of 12 triangles on 8 corners in one wooden material, as glTF with an embedded buffer. */
function crateGltf(): string {
  const buffer = Buffer.alloc(168)
  const corners = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ]
  corners.flat().forEach((value, index) => buffer.writeFloatLE(value, index * 4))
  ;[4, 5, 6, 4, 6, 7, 1, 0, 3, 1, 3, 2, 0, 4, 7, 0, 7, 3, 5, 1, 2, 5, 2, 6, 7, 6, 2, 7, 2, 3, 0, 1, 5, 0, 5, 4]
    .forEach((value, index) => buffer.writeUInt16LE(value, 96 + index * 2))
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Crate', mesh: 0 }],
    meshes: [{ name: 'Crate', primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ name: 'Wood', pbrMetallicRoughness: { baseColorFactor: [0.55, 0.38, 0.2, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    buffers: [{ byteLength: 168, uri: `data:application/octet-stream;base64,${buffer.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 96, target: 34962 },
      { buffer: 0, byteOffset: 96, byteLength: 72, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  })
}

/**
 * Write the game project: the robot and a crate, the hero strip, a 16 × 16 coin, a 16 × 16 red icon in art/, and a
 * different 8 × 8 blue icon.png in the project folder itself.
 * @param root - the project folder.
 */
async function writeProject(root: string): Promise<void> {
  await mkdir(join(root, 'models'), { recursive: true })
  await mkdir(join(root, 'art'), { recursive: true })
  await writeFile(join(root, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Web e2e"\n')
  await writeFile(join(root, 'models', 'robot.gltf'), robotGltf())
  await writeFile(join(root, 'models', 'crate.gltf'), crateGltf())
  await writeFile(join(root, 'art', 'hero_strip.png'), heroStrip())
  await writeFile(join(root, 'art', 'coin.png'), png(16, 16, (x, y) => ((x - 7.5) ** 2 + (y - 7.5) ** 2 < 49 ? [240, 190, 40, 255] : [0, 0, 0, 0])))
  await writeFile(join(root, 'art', 'icon.png'), png(16, 16, () => [220, 40, 40, 255]))
  await writeFile(join(root, 'icon.png'), png(8, 8, () => [40, 60, 220, 255]))
}

/** One tool call of a scripted model. */
interface Call {
  readonly id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * An assistant step of tool calls, all in one message, so the agent loop may run them at once.
 * @param list - the calls.
 * @returns the stream of the step.
 */
function calls(list: readonly Call[]): StreamChunk[] {
  return [
    ...list.flatMap(({ id, name, args }, index): StreamChunk[] => {
      const callId = ToolCallId(id)
      const json = JSON.stringify(args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: json },
        { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: json } },
      ]
    }),
    { type: 'usage', usage: { inputTokens: 32, outputTokens: 12 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/**
 * An assistant step of text that ends the turn.
 * @param words - the text.
 * @returns the stream of the step.
 */
function say(words: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: words },
    { type: 'block-end', index: 0, block: { type: 'text', text: words } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 4 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * The text of a request's user messages: the prompt a Session started with, and the notices around it, such as the
 * working directory a subagent starts in.
 */
function userText(options: GenerateOptions | undefined): string {
  return (options?.messages ?? []).flatMap(message => message.role === 'user' ? [text(message.content)] : []).join('\n')
}

/** The text of a request's system prompt, wherever the request carries it. */
function systemText(options: GenerateOptions | undefined): string {
  if (options === undefined) return ''
  const messages = options.messages.flatMap(message => message.role === 'system' || message.role === 'developer' ? [text(message.content)] : [])
  return [options.system ?? '', ...messages].join('\n')
}

/** The tool results of a request, in the order of the calls. */
function toolResults(options: GenerateOptions | undefined) {
  return (options?.messages ?? []).flatMap(message => message.role === 'tool' ? [message] : [])
}

/**
 * A member of a team or a subagent that makes the asset_view call its prompt names, as `ASSET_VIEW <arguments> END`,
 * then reports.
 * @param step - the member's step.
 * @param prompt - the member's prompt.
 * @param sessionId - the member's Session.
 * @returns the stream of the step.
 */
function viewer(step: number, prompt: string, sessionId: string): StreamChunk[] {
  const args = /ASSET_VIEW (\{.*\}) END/su.exec(prompt)?.[1]
  if (args === undefined) throw new Error(`a member got a prompt without a view: ${prompt}`)
  if (step > 0) return say('VIEWED')
  const parsed = JSON.parse(args) as Record<string, unknown>
  return calls([{ id: `view-${sessionId}`, name: 'asset_view', args: parsed }])
}

/** A scripted vision model that answers the lead's Session by its script and every other Session by its prompt. */
class Router extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  /** The lead's Session. */
  lead: string | undefined
  private readonly steps = new Map<string, number>()

  constructor(
    private readonly leadScript: (step: number) => StreamChunk[],
    private readonly memberScript: (step: number, prompt: string, sessionId: string) => StreamChunk[] = viewer,
  ) {
    super()
  }

  override async listModels(provider: string) { return [{ provider, id: MODEL, name: MODEL }] }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000, inputModalities: ['text', 'image'] })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const sessionId = options.sessionId
    // A one-shot request outside a conversation, such as a title, gets a short answer.
    if (sessionId === undefined || options.purpose !== undefined) {
      yield* say('Assets')
      return
    }
    const step = this.steps.get(sessionId) ?? 0
    this.steps.set(sessionId, step + 1)
    yield* sessionId === this.lead ? this.leadScript(step) : this.memberScript(step, userText(options), sessionId)
  }

  /** The requests of one Session. */
  of(sessionId: string): GenerateOptions[] {
    return this.requests.filter(options => options.sessionId === sessionId)
  }

  /** The Sessions other than the lead's that asked the model. */
  members(): string[] {
    const others = this.requests.flatMap(({ sessionId }) => (sessionId === undefined || sessionId === this.lead ? [] : [sessionId]))
    return [...new Set(others)]
  }
}

/**
 * Hold every render request on the Host until `count` are open at once, then let them go on to the window together. A
 * Host that sent the calls one after another never reaches the count, and `ready` rejects.
 * @param ctx - the Host context.
 * @param count - the requests to hold.
 * @returns the requests seen, a promise of the overlap, and the release of the listener.
 */
function overlap(ctx: Context, count: number) {
  const seen: { readonly path: string; readonly agent: string | undefined }[] = []
  const all = Promise.withResolvers<undefined>()
  all.promise.catch(() => {
    // The spec awaits `ready` and reports the failure.
  })
  const timer = setTimeout(() => { all.reject(new Error(`the asset_view calls did not overlap: ${JSON.stringify(seen)}`)) }, 90_000)
  const off = ctx.on('game-assets/render', async (request, next) => {
    seen.push({ path: request.path, agent: request.agent?.id })
    if (seen.length === count) {
      clearTimeout(timer)
      all.resolve(undefined)
    }
    await all.promise
    return await next()
  }, true)
  return {
    seen,
    ready: all.promise,
    off: () => {
      clearTimeout(timer)
      off()
    },
  }
}

/**
 * Hold the window's file reads and count the most open at once. Reads are held until `count` are open and half a second
 * more, in which a window that draws beyond its limit would open a further one, or until ten seconds after the first
 * read when fewer come.
 * @param page - the window.
 * @param count - the reads to wait for.
 * @returns the most reads that were open at once.
 */
async function windowReads(page: Page, count: number): Promise<{ readonly peak: () => number }> {
  let open = 0
  let peak = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const all = Promise.withResolvers<undefined>()
  const release = (): void => { all.resolve(undefined) }
  await page.route(/readBytes/u, async (route) => {
    open += 1
    peak = Math.max(peak, open)
    timer ??= setTimeout(release, 10_000)
    if (open === count) {
      clearTimeout(timer)
      timer = setTimeout(release, 500)
    }
    await all.promise
    open -= 1
    await route.continue()
  })
  return { peak: () => peak }
}

/**
 * Wait for one Session's turn to end.
 * @param ctx - the Host context.
 * @param sessionId - the Session.
 * @returns a promise of the persisted turn end.
 */
function turnEnd(ctx: Context, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const off = ctx.on('session/event', (session, event) => {
      if (session.id !== sessionId || event.type !== 'turn/end') return
      off()
      ctx.sessions.flush(session).then(() => { resolve() }, reject)
    })
  })
}

/**
 * Wait until a condition holds.
 * @param check - the condition.
 * @param label - what failed, when it never holds.
 * @param timeoutMs - how long to wait.
 */
async function until(check: () => boolean, label: string, timeoutMs = 150_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`)
    await new Promise((resolve) => { setTimeout(resolve, 25) })
  }
}

let scaffold: WebScaffold | undefined
let browser: Browser | undefined
const clients: Client[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const client of clients.splice(0)) await client.close()
  await browser?.close()
  browser = undefined
  await scaffold?.close()
  scaffold = undefined
})

/**
 * Launch the Web scaffold with the scripted model and the game project, and open a real window on it.
 * @param adapter - the scripted model.
 * @param options - scaffold options.
 * @returns the scaffold, its Host context, and the window.
 */
async function boot(adapter: LlmAdapter, options: LaunchOptions = {}): Promise<{ target: WebScaffold; ctx: Context; page: Page }> {
  const target = scaffold = await launchWebScaffold(options)
  const ctx = target.ctx
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'game assets scripted model')
  await writeProject(target.workspaceCwd)
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  browser = await chromium.launch({ ...executablePath === undefined ? {} : { executablePath }, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(target.authenticatedUrl, { waitUntil: 'load' })
  // The booted window holds the owner event stream that answers the render requests.
  await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })
  return { target, ctx, page }
}

/**
 * Create the lead's Session in the project on the scripted model.
 * @param target - the scaffold.
 * @param adapter - the scripted model, which learns the lead's Session.
 * @returns the Session.
 */
async function leadSession(target: WebScaffold, adapter: Router): Promise<SessionId> {
  const created = await remote<{ sessionId: string }>(target, 'session/create', { request: { cwd: target.workspaceCwd } })
  const sessionId = SessionId(created.sessionId)
  adapter.lead = sessionId
  await remote(target, 'session/selectModel', { request: { sessionId, provider: PROVIDER, model: MODEL } })
  return sessionId
}

/**
 * Send the user's message to a Session.
 * @param target - the scaffold.
 * @param sessionId - the Session.
 * @param words - the message.
 */
async function prompt(target: WebScaffold, sessionId: SessionId, words: string): Promise<void> {
  await remote(target, 'session/prompt', { request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: words }] } })
}

it('draws models and sprites for the model in a real window, with their details, and shows one in the Assets tab', async () => {
  scaffold = await launchWebScaffold()
  const ctx = scaffold.ctx
  const adapter = new ScriptedAdapter()
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'game assets scripted model')
  await writeProject(scaffold.workspaceCwd)

  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  browser = await chromium.launch({ ...executablePath === undefined ? {} : { executablePath }, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  // The booted window holds the owner event stream that answers the render requests; the turn's first call, a search,
  // needs no window.
  await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })

  const created = await remote<{ sessionId: string }>(scaffold, 'session/create', { request: { cwd: scaffold.workspaceCwd } })
  const sessionId = SessionId(created.sessionId)
  await remote(scaffold, 'session/selectModel', { request: { sessionId, provider: PROVIDER, model: MODEL } })
  const settled = scaffold.whenTurnSettled(150_000)
  await remote(scaffold, 'session/prompt', {
    request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Look at the robot and the hero strip.' }] },
  })
  expect(await settled).toBe(sessionId)
  await ctx.agents.get(sessionId)?.whenIdle()

  expect(adapter.requests).toHaveLength(SCRIPT.length + 1)
  const results = (adapter.requests.at(-1) as GenerateOptions).messages.filter(message => message.role === 'tool').map(message => message.content)
  const [search, views, wave, grid, frames] = results as [ContentBlock[], ContentBlock[], ContentBlock[], ContentBlock[], ContentBlock[]]
  expect(text(search)).toContain('- models/robot.gltf (3D glTF')
  expect(text(search)).toContain('- art/hero_strip.png (2D PNG')

  expect(text(views)).toContain('Model models/robot.gltf (glTF')
  expect(text(views)).toContain('Geometry: 2 triangles and 4 vertices in 1 mesh')
  expect(text(views)).toContain('- Paint: MeshStandardMaterial, color #')
  expect(text(views)).toContain('Skeleton: 2 bones, each under its parent:\nRoot\n  Arm')
  expect(text(views)).toContain('- Wave: 1.00 s, 1 track on 1 bone or node: Arm')
  expect(text(views)).toContain('The image shows: iso, front views in its materials with the skeleton.')
  expect(text(wave)).toContain('4 poses of Wave across its 1.00 s, iso view as solid clay')
  expect(text(grid)).toContain('Image art/hero_strip.png (PNG')
  expect(text(grid)).toContain('64 × 16 pixels, cutout transparency')
  expect(text(grid)).toContain('- grid: the given grid, 4 frames of 16 × 16 at 12 fps (0.33 s), loops')
  expect(text(grid)).toContain('with the 4 × 1 grid and each cell\'s number')
  expect(text(frames)).toContain('all 4 frames of grid in order')
  expect(text(frames)).toContain('It is open in the user\'s Assets panel.')

  const drawn = [views, wave, grid, frames].map(images)
  expect(drawn.map(list => list.map(image => image.mediaType))).toEqual([['image/jpeg'], ['image/jpeg'], ['image/png'], ['image/png']])
  const out = process.env.DSH_ASSET_E2E_OUT
  for (const [index, [image]] of drawn.entries()) {
    const stored = await ctx.attachments.readImage(image as ImageAttachmentRef)
    // A blank picture encodes to a few hundred bytes; each of these holds a drawing.
    expect(stored.data.byteLength).toBeGreaterThan(1500)
    if (out !== undefined) await writeFile(join(out, `${String(index)}-${(image as ImageAttachmentRef).name ?? 'image'}`), stored.data)
  }

  // `show` opened the strip in the Session's Assets tab, read as the call's grid and playing it.
  const tab = page.locator('[data-game-assets]')
  await tab.waitFor({ timeout: 30_000 })
  await vi.waitFor(async () => {
    const shown = await tab.innerText()
    expect(shown).toContain('hero_strip.png')
    expect(shown).toContain('Sprite grid')
    expect(shown).toMatch(/\d+ \/ 4/u)
  }, { timeout: 30_000 })
  if (out !== undefined) await page.screenshot({ path: join(out, 'assets-tab-grid.png') })

  // A reveal of a model with a clip opens it playing that clip on the timeline.
  ctx.emit('game-assets/reveal', { sessionId, path: 'models/robot.gltf', animation: 'Wave' })
  await vi.waitFor(async () => {
    const shown = await tab.innerText()
    expect(shown).toContain('robot.gltf')
    expect(shown).toContain('Wave')
    expect(shown).toContain('/ 1.00 s')
  }, { timeout: 30_000 })
  if (out !== undefined) {
    await tab.getByRole('button', { name: 'Skeleton' }).click()
    await tab.getByRole('button', { name: 'Details' }).click()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, 'assets-tab-model.png') })
  }
}, 240_000)

it('draws four different assets that one model turn asks for at once, three at a time in the window', async () => {
  const views = [
    { path: 'models/robot.gltf', skeleton: true, size: 512 },
    { path: 'models/crate.gltf', shading: 'solid', size: 512 },
    { path: 'art/hero_strip.png', grid: { columns: 4, rows: 1 } },
    { path: 'art/coin.png' },
  ]
  const adapter = new Router(step => (step === 0 ? calls(views.map((args, index) => ({ id: `view-${String(index)}`, name: 'asset_view', args }))) : say(DONE)))
  const { target, ctx, page } = await boot(adapter)
  const reads = await windowReads(page, 3)
  const lead = await leadSession(target, adapter)
  const gate = overlap(ctx, views.length)
  const ended = turnEnd(ctx, lead)
  await prompt(target, lead, 'Look at all four assets.')
  await gate.ready
  await ended
  await ctx.agents.get(lead)?.whenIdle()
  gate.off()

  // The four requests were open on the Host at once, and the window read three of the files at once, not four.
  expect(gate.seen.map(seen => seen.path).sort()).toEqual(views.map(view => view.path).sort())
  expect(new Set(gate.seen.map(seen => seen.agent))).toEqual(new Set([lead]))
  expect(reads.peak()).toBe(3)
  const results = toolResults(adapter.of(lead).at(-1))
  expect(results.map(result => result.toolCallId)).toEqual(['view-0', 'view-1', 'view-2', 'view-3'])
  const expected = [
    ['Model models/robot.gltf (glTF', 'Skeleton: 2 bones', 'image/jpeg'],
    ['Model models/crate.gltf (glTF', 'Geometry: 12 triangles and 8 vertices in 1 mesh', 'image/jpeg'],
    ['Image art/hero_strip.png (PNG', '64 × 16 pixels', 'image/png'],
    ['Image art/coin.png (PNG', '16 × 16 pixels', 'image/png'],
  ]
  for (const [index, result] of results.entries()) {
    const [heading, measured, mediaType] = expected[index] ?? []
    expect(result.isError, text(result.content)).toBeFalsy()
    expect(text(result.content)).toContain(heading)
    expect(text(result.content)).toContain(measured)
    expect(images(result.content).map(image => image.mediaType)).toEqual([mediaType])
  }
}, 240_000)

it('lets three teammates of an agent team look at different assets at once, and shows a teammate\'s asset in the lead\'s Session', async () => {
  const team = [
    { name: 'modeler', view: { path: 'models/robot.gltf', skeleton: true, animation: 'Wave', frames: 4, size: 512 } },
    { name: 'animator', view: { path: 'art/hero_strip.png', grid: { columns: 4, rows: 1 }, animation: 'grid' } },
    // Started in art/, the artist names the icon from there; the project folder holds a different icon.png.
    { name: 'artist', cwd: 'art', view: { path: 'icon.png', show: true } },
  ]
  const adapter = new Router(step => (step === 0
    ? calls(team.map(member => ({
      id: `start-${member.name}`,
      name: 'subagent',
      args: {
        description: `View ${member.view.path}`, name: member.name, prompt: `ASSET_VIEW ${JSON.stringify(member.view)} END`,
        ...member.cwd === undefined ? {} : { cwd: member.cwd },
      },
    })))
    : say('LEAD_OK')))
  const { target, ctx, page } = await boot(adapter)
  const lead = await leadSession(target, adapter)
  const leadAgent = ctx.agents.get(lead)
  if (leadAgent === undefined) throw new Error('the lead\'s Agent is not live')
  await ctx.agentTeams.setEnabled(leadAgent, true)
  const reveals: AssetReveal[] = []
  ctx.on('game-assets/reveal', (reveal) => { reveals.push(reveal) })
  const gate = overlap(ctx, team.length)
  await prompt(target, lead, 'Split the three assets across the team.')
  await gate.ready
  gate.off()
  await until(() => adapter.members().length === team.length && adapter.members().every(id => adapter.of(id).length >= 2), 'every teammate read its view')
  const notices = () => leadAgent.session.deriveMessages().filter(message => message.role === 'user' && message.source.kind === 'subagent-settled').length
  await until(() => notices() === team.length && leadAgent.status === 'idle', 'the lead read every teammate\'s notice')
  await leadAgent.whenIdle()

  // The three teammates' requests were open on the Host at once, each from its own Session, none from the lead's.
  expect(new Set(gate.seen.map(seen => seen.agent))).toEqual(new Set(adapter.members()))
  const memberFor = (view: object): string | undefined => adapter.members()
    .find(id => userText(adapter.of(id)[0]).includes(JSON.stringify(view)))
  const expected: Record<string, readonly [string, string, string]> = {
    modeler: ['Model models/robot.gltf (glTF', '4 poses of Wave across its 1.00 s', 'image/jpeg'],
    animator: ['Image art/hero_strip.png (PNG', 'all 4 frames of grid in order', 'image/png'],
    // The red icon in art/, not the blue one in the project folder.
    artist: ['Image icon.png (PNG', '16 × 16 pixels', 'image/png'],
  }
  for (const member of team) {
    const id = memberFor(member.view)
    if (id === undefined) throw new Error(`no teammate viewed ${member.view.path}`)
    const requests = adapter.of(id)
    expect(systemText(requests[0])).toContain('Agent Teams is available in this session.')
    const [result] = toolResults(requests.at(-1))
    const [heading, measured, mediaType] = expected[member.name] ?? []
    expect(result?.isError, text(result?.content ?? [])).toBeFalsy()
    expect(text(result?.content ?? [])).toContain(heading)
    expect(text(result?.content ?? [])).toContain(measured)
    expect(images(result?.content ?? []).map(image => image.mediaType)).toEqual([mediaType])
  }
  // The artist's show opened the icon in the lead's Assets tab, named from the project folder.
  expect(reveals).toEqual([{ sessionId: lead, path: 'art/icon.png' }])
  const tab = page.locator('[data-game-assets]')
  await tab.waitFor({ timeout: 30_000 })
  await vi.waitFor(async () => {
    expect(await tab.innerText()).toContain('icon.png')
    // The tab shows in the open right sidebar of the window.
    const box = await tab.boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(300)
    expect((box?.x ?? Number.POSITIVE_INFINITY) + (box?.width ?? 0)).toBeLessThanOrEqual(1440)
  }, { timeout: 30_000 })
  const out = process.env.DSH_ASSET_E2E_OUT
  if (out !== undefined) await page.screenshot({ path: join(out, 'team-assets-tab.png') })
}, 300_000)

it('lets subagents and their lead look at different assets at once', async () => {
  const members = [
    { name: 'robot', view: { path: 'models/robot.gltf', views: ['front'], shading: 'wireframe', size: 512 } },
    { name: 'crate', view: { path: 'models/crate.gltf', size: 512 } },
    { name: 'strip', view: { path: 'art/hero_strip.png', region: { x: 16, y: 0, width: 16, height: 16 } } },
  ]
  // One step starts the three subagents and looks at the coin itself.
  const adapter = new Router(step => (step === 0
    ? calls([
      ...members.map(member => ({
        id: `start-${member.name}`,
        name: 'subagent',
        args: { description: `View ${member.view.path}`, name: member.name, prompt: `ASSET_VIEW ${JSON.stringify(member.view)} END` },
      })),
      { id: 'lead-view', name: 'asset_view', args: { path: 'art/coin.png' } },
    ])
    : say('LEAD_OK')))
  const { target, ctx } = await boot(adapter)
  const lead = await leadSession(target, adapter)
  const leadAgent = ctx.agents.get(lead)
  if (leadAgent === undefined) throw new Error('the lead\'s Agent is not live')
  const gate = overlap(ctx, members.length + 1)
  await prompt(target, lead, 'Look at the coin while three helpers look at the rest.')
  await gate.ready
  gate.off()
  await until(() => adapter.members().length === members.length && adapter.members().every(id => adapter.of(id).length >= 2), 'every subagent read its view')
  const notices = () => leadAgent.session.deriveMessages().filter(message => message.role === 'user' && message.source.kind === 'subagent-settled').length
  await until(() => notices() === members.length && leadAgent.status === 'idle', 'the lead read every subagent\'s notice')
  await leadAgent.whenIdle()

  // Four Sessions' requests were open on the Host at once: the lead's and each subagent's.
  expect(new Set(gate.seen.map(seen => seen.agent))).toEqual(new Set([lead, ...adapter.members()]))
  for (const id of adapter.members()) {
    const requests = adapter.of(id)
    expect(systemText(requests[0])).not.toContain('Agent Teams is available in this session.')
    const view = members.find(member => userText(requests[0]).includes(JSON.stringify(member.view)))?.view
    const [result] = toolResults(requests.at(-1))
    expect(result?.isError, text(result?.content ?? [])).toBeFalsy()
    expect(text(result?.content ?? [])).toContain(` ${view?.path ?? 'unknown'} (`)
    expect(images(result?.content ?? [])).toHaveLength(1)
  }
  const own = toolResults(adapter.of(lead)[1]).find(result => result.toolCallId === 'lead-view')
  expect(text(own?.content ?? [])).toContain('Image art/coin.png (PNG, ')
  expect(text(own?.content ?? [])).toContain('16 × 16 pixels')
  expect(images(own?.content ?? [])).toHaveLength(1)
}, 300_000)

it('draws different assets for Claude Code and Codex calling through WASD Engine\'s MCP server at once', async () => {
  const data = await mkdtemp(join(tmpdir(), 'dsh-asset-mcp-'))
  try {
    // A patch replaces the row's whole configuration: a data folder of its own, and any free port, as the installed app
    // may hold the usual one.
    const overlay = join(data, 'asset-mcp.patch.yml')
    await writeFile(overlay, `- id: game-mcp\n  config:\n    dataRoot: ${JSON.stringify(join(data, 'game-mcp'))}\n    port: 0\n`)
    const { target, ctx } = await boot(new Router(() => say(DONE)), { extraOverlayPath: overlay })
    // Connected agents' calls run while someone is signed in.
    const account = ctx.get('deepseekAccount')
    if (account !== undefined) vi.spyOn(account, 'getState').mockResolvedValue({ status: 'credential-stored', links: { usageUrl: '', topUpUrl: '' }, attempt: null })
    const server = ctx.get('gameMcp')
    if (server === undefined) throw new Error('the game MCP server is not loaded')
    const watching = new AbortController()
    let url: string | undefined
    for await (const view of server.watch(watching.signal)) {
      if (view.state === 'failed') throw new Error(`the game MCP server failed: ${view.message ?? ''}`)
      if (view.state !== 'listening') continue
      url = view.url
      break
    }
    watching.abort()
    if (url === undefined) throw new Error('the game MCP server has no address')
    const endpoint = new URL(url)
    const token = (await readFile(join(data, 'game-mcp', 'token'), 'utf8')).trim()
    // Each client names itself in its own User-Agent too, as Claude Code and Codex do.
    const connect = async (name: string, userAgent: string): Promise<Client> => {
      const client = new Client({ name, version: '1.0.0' })
      await client.connect(new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': userAgent } } }))
      clients.push(client)
      return client
    }
    const claude = await connect('claude-code', 'claude-code/2.1.0 (e2e)')
    const codex = await connect('codex', 'codex_cli_rs/0.1.0 (e2e)')
    const project = target.workspaceCwd
    const mcpText = (result: Awaited<ReturnType<Client['callTool']>>): string =>
      (result.content as { type: string; text?: string }[]).flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n')
    // Each agent's first call opens its own Session of the project.
    for (const client of [claude, codex]) {
      const search = await client.callTool({ name: 'asset_search', arguments: { project } })
      expect(search.isError, mcpText(search)).toBeFalsy()
    }
    const cases = [
      { client: claude, args: { path: 'models/robot.gltf', views: ['iso', 'front'], skeleton: true, size: 512 }, heading: 'iso, front views in its materials with the skeleton', mimeType: 'image/jpeg' },
      { client: claude, args: { path: 'models/crate.gltf', views: ['top'], shading: 'wireframe', size: 512 }, heading: 'Geometry: 12 triangles and 8 vertices in 1 mesh', mimeType: 'image/jpeg' },
      { client: claude, args: { path: 'art/hero_strip.png', grid: { columns: 4, rows: 1 }, animation: 'grid' }, heading: 'all 4 frames of grid in order', mimeType: 'image/png' },
      { client: codex, args: { path: 'models/robot.gltf', animation: 'Wave', frames: 4, shading: 'solid', size: 512 }, heading: '4 poses of Wave across its 1.00 s', mimeType: 'image/jpeg' },
      { client: codex, args: { path: 'art/coin.png' }, heading: 'Image art/coin.png (PNG', mimeType: 'image/png' },
      { client: codex, args: { path: 'art/icon.png', region: { x: 0, y: 0, width: 8, height: 8 } }, heading: 'pixels (0, 0) to (8, 8)', mimeType: 'image/png' },
    ]
    const gate = overlap(ctx, cases.length)
    const results = await Promise.all(cases.map(({ client, args }) => client.callTool({ name: 'asset_view', arguments: { project, ...args } }, { timeout: 170_000 })))
    await gate.ready
    gate.off()

    // The six calls were open on the Host at once, in two Sessions: Claude Code's and Codex's.
    expect(new Set(gate.seen.map(seen => seen.agent)).size).toBe(2)
    const pictures = results.map((result, index) => {
      const want = cases[index]
      expect(result.isError, mcpText(result)).toBeFalsy()
      const content = result.content as { type: string; data?: string; mimeType?: string }[]
      expect(content.map(block => block.type)).toEqual(['text', 'image'])
      expect(mcpText(result)).toContain(want?.heading)
      expect(content[1]?.mimeType).toBe(want?.mimeType)
      return content[1]?.data
    })
    // No call received another call's picture.
    expect(new Set(pictures).size).toBe(cases.length)
  } finally {
    await rm(data, { recursive: true, force: true })
  }
}, 300_000)
