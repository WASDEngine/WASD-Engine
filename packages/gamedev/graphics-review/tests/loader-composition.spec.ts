/**
 * REAL-composition proof: a test-only `cordis.yml` boots the model, Session, tool, prompt, executor, Agent, agent loop,
 * filesystem, working directory, and local attachment rows, the account route `llm-deepseek-account` against a loopback
 * WASD Engine API, a fake account sign-in, and the shipped `graphics-review` row through the vendored Loader. A scripted
 * Session model calls `graphics_review` on a pixel-art checkerboard: the loopback API receives the image the attachment
 * store saved, uploaded through its Files API, and one Messages request with the reviewer's instructions, the image, the
 * agent's words, a low reasoning effort, and no temperature, and the review reaches the Session model as the tool result.
 * Signed out, or signed in while the listing holds the reviewer back for a newer WASD Engine, the tool result says so
 * before any Messages request.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as AgentRegistry from '@deepseek-ai/dsh-agent'
import * as AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import * as LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as Llm from '@deepseek-ai/dsh-llm'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as AccountRoute from '@deepseek-ai/dsh-llm-deepseek-account'
import * as SessionStore from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Tools from '@deepseek-ai/dsh-tools'
import * as WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as GraphicsReview from '../src/index.ts'
import { reviewerPrompt } from '../src/prompt.ts'
import { checkerboardDifference, writeCheckerboard } from './pixels.ts'

/** The fork's overlay that inserts the shipped `graphics-review` row. */
const GAME_TOOLS_OVERLAY = fileURLToPath(new URL('../../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml', import.meta.url))

/** The account token the fake sign-in releases to the loopback API. */
const TOKEN = 'wasd-account-token'

/** The review the loopback API's model writes. */
const REVIEW = '**How to make it better:** Outline the knight in one darker shade.\n**Tools and add-ons to consider:** GIMP for the outline.'

/** The listing's text-only model, which the review passes over. */
const PRO = { id: 'deepseek-v4-pro', input_modalities: ['text'], output_modalities: ['text'], api_capabilities: { anthropic_messages: {} } }

/**
 * The listing's model that takes images.
 * @param minVersion - the WASD Engine version it requires, if any.
 * @returns its listing entry.
 */
function vision(minVersion?: string): Record<string, unknown> {
  return {
    id: 'deepseek-flash', input_modalities: ['text', 'image'], output_modalities: ['text'], api_capabilities: { anthropic_messages: {} },
    ...minVersion === undefined ? {} : { client_requirements: { 'deepseek-harness': { min_version: minVersion } } },
  }
}

/** The loopback WASD Engine API: its listing, Files uploads, and Messages requests. */
interface LoopbackApi {
  readonly origin: string
  /** What `GET /models` answers. */
  listing: unknown
  /** Method and path of every request, in order. */
  readonly paths: string[]
  /** Bytes of each image uploaded through `POST /v1/files`. */
  readonly uploads: Buffer[]
  /** Each `POST /v1/messages` request. */
  readonly messages: { readonly body: Record<string, unknown>; readonly headers: IncomingHttpHeaders }[]
  close(): Promise<void>
}

/** The fake account sign-in. */
interface FakeAccount {
  signedIn: boolean
}

/** One booted composition. */
interface Booted {
  readonly ctx: Context
  readonly api: LoopbackApi
  readonly account: FakeAccount
  /** The game project, the Agents' working directory. */
  readonly work: string
}

let root: string | undefined
let context: Context | undefined
let loopback: LoopbackApi | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await loopback?.close()
  loopback = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

/** The Messages stream of a reply that reasons, then writes the review. */
function reviewEvents(): string {
  return [
    { type: 'message_start', message: { id: 'msg_review', model: 'deepseek-flash', usage: { input_tokens: 2400, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'The pixels are crisp.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: REVIEW } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 180 } },
    { type: 'message_stop' },
  ].map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

async function startApi(): Promise<LoopbackApi> {
  const paths: string[] = []
  const uploads: Buffer[] = []
  const messages: LoopbackApi['messages'][number][] = []
  const server = createServer((request, response) => {
    void (async () => {
      const parts: Buffer[] = []
      for await (const part of request as AsyncIterable<Buffer>) parts.push(part)
      const body = Buffer.concat(parts)
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
      paths.push(`${request.method ?? ''} ${path}`)
      if (request.method === 'GET' && path === '/models') {
        json(response, 200, api.listing)
      } else if (request.method === 'POST' && path === '/v1/files') {
        const headers = new Headers()
        for (const [name, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value)
        }
        const file = (await new Request('http://127.0.0.1/v1/files', { method: 'POST', headers, body }).formData()).get('file')
        if (!(file instanceof File)) throw new Error('the upload holds no file')
        uploads.push(Buffer.from(await file.arrayBuffer()))
        json(response, 200, {
          id: `file-${String(uploads.length)}`, type: 'file', size_bytes: file.size, created_at: new Date().toISOString(),
          filename: file.name, mime_type: file.type,
        })
      } else if (request.method === 'POST' && path === '/v1/messages') {
        messages.push({ body: JSON.parse(body.toString('utf8')) as Record<string, unknown>, headers: request.headers })
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end(reviewEvents())
      } else {
        json(response, 404, { error: { type: 'not_found_error', message: 'not found' } })
      }
    })().catch((error: unknown) => { response.destroy(error as Error) })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the loopback API has no port')
  const api: LoopbackApi = {
    origin: `http://127.0.0.1:${String(address.port)}`, listing: { data: [PRO, vision()] }, paths, uploads, messages,
    async close() {
      const closed = new Promise<void>((resolve) => { server.close(() => { resolve() }) })
      server.closeAllConnections()
      await closed
    },
  }
  return api
}

/** The shipped `graphics-review` row, as the game tools overlay inserts it. */
function shippedRow(): unknown {
  const row = loadOverlayPatches('graphics-review', GAME_TOOLS_OVERLAY)
    .flatMap(patch => patch.insert ?? [])
    .find(entry => entry.id === 'graphics-review')
  // No configuration: every profile reviews with the plugin's defaults.
  expect(row).toEqual({ id: 'graphics-review', name: '@deepseek-ai/dsh-graphics-review' })
  return row
}

/**
 * Boot the test composition through the Loader.
 * @returns the booted context, the loopback API, the fake sign-in, and the game project.
 */
async function boot(): Promise<Booted> {
  root = await mkdtemp(join(tmpdir(), 'dsh-graphics-review-loader-'))
  const work = join(root, 'game')
  const home = join(root, 'home')
  await mkdir(work)
  // The route keeps its upload index and anonymous id under the harness home.
  vi.stubEnv('DSH_HOME', home)
  const api = await startApi()
  loopback = api
  const account: FakeAccount = { signedIn: true }
  const accountPlugin = {
    name: 'test-deepseek-account',
    apply(ctx: Context) {
      ctx.provide('deepseekAccount', {
        resolveToken: (url: string) => Promise.resolve(account.signedIn && url.startsWith(api.origin) ? TOKEN : undefined),
        rejectToken: () => Promise.resolve(),
        getState: () => Promise.resolve({ status: account.signedIn ? 'credential-stored' : 'signed-out' }),
      } as never)
    },
  }
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', Llm],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjection],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', Tools],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
    ['@deepseek-ai/dsh-attachment-local', LocalAttachments],
    ['@test/deepseek-account', accountPlugin],
    ['@deepseek-ai/dsh-llm-deepseek-account', AccountRoute],
    ['@deepseek-ai/dsh-graphics-review', GraphicsReview],
  ])
  const configPath = join(root, 'cordis.yml')
  // JSON is YAML, so each configuration and the shipped row keep their exact values.
  const row = (name: string, config?: unknown): string[] => [`- name: '${name}'`, ...config === undefined ? [] : [`  config: ${JSON.stringify(config)}`]]
  await writeFile(configPath, [
    ...row('@deepseek-ai/dsh-llm'),
    ...row('@deepseek-ai/dsh-session'),
    ...row('@deepseek-ai/dsh-session-projection'),
    ...row('@deepseek-ai/dsh-system-prompt'),
    ...row('@deepseek-ai/dsh-tools'),
    ...row('@deepseek-ai/dsh-tool-executor-native'),
    ...row('@deepseek-ai/dsh-agent'),
    ...row('@deepseek-ai/dsh-agent-loop', { agents: [] }),
    ...row('@deepseek-ai/dsh-fs-local', { cwd: work }),
    ...row('@deepseek-ai/dsh-working-directory', { defaultDirectory: work }),
    ...row('@deepseek-ai/dsh-attachment-local', { dshHome: home }),
    ...row('@test/deepseek-account'),
    // The shipped account route's configuration is its API origin alone.
    ...row('@deepseek-ai/dsh-llm-deepseek-account', { baseURL: api.origin }),
    `- ${JSON.stringify(shippedRow())}`,
    '',
  ].join('\n'))
  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  // Entry trees call only the module loader's `import`; this one answers from the test's own imports.
  Reflect.set(ctx.loader, 'internal', {
    version: 'v2',
    import: (specifier: string): Promise<unknown> => modules.has(specifier)
      ? Promise.resolve(modules.get(specifier))
      : Promise.reject(new Error(`unexpected Loader import: ${specifier}`)),
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  expect(unloaded.map(entry => entry.options.name)).toEqual([])
  return { ctx, api, account, work }
}

/** The text of the tool result a model request carries. */
function toolResult(request: GenerateOptions | undefined): string {
  const message = request?.messages.find(entry => entry.role === 'tool')
  return (message?.content ?? []).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/**
 * Run one turn of a Session whose scripted model calls `graphics_review` once, then answers.
 * @param booted - the composition.
 * @param id - the Session's id, which also names its model route.
 * @param args - the call's arguments.
 * @returns the Session model's requests.
 */
async function reviewTurn(booted: Booted, id: string, args: Record<string, unknown>): Promise<GenerateOptions[]> {
  const model = new MockAdapter([toolCallResponse(`${id}-review`, 'graphics_review', args), textResponse('Done.')])
  booted.ctx.llm.registerAdapter([`mock-${id}`], model)
  const { agent } = await booted.ctx.agents.create({
    sessionId: SessionId(id), meta: { cwd: booted.work }, agentOptions: { provider: `mock-${id}`, model: 'mock' },
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Make the knight sprite and have it reviewed.' }], source: { kind: 'user' } }))
  await Promise.resolve()
  await agent.whenIdle()
  expect(model.requests).toHaveLength(2)
  return model.requests
}

describe('graphics_review in a Loader-booted composition with the account route', () => {
  it('uploads the whole-pixel image, asks the account\'s model with a low reasoning effort, and returns its review to the Session', async () => {
    const booted = await boot()
    await writeCheckerboard(join(booted.work, 'knight.png'), 32, 16)
    const [, followUp] = await reviewTurn(booted, 'review', {
      image: 'knight.png', subject: 'the knight\'s idle sprite', goal: '16-bit pixel art',
    })

    const { api } = booted
    expect(api.paths).toEqual(['GET /models', 'POST /v1/files', 'POST /v1/messages'])
    // The image the attachment store saved reaches the route without another scaling: 25 times 32×16, whole pixels.
    expect(api.uploads).toHaveLength(1)
    expect(await checkerboardDifference(api.uploads[0]!, 25)).toEqual({ width: 800, height: 400, differing: 0 })
    const [request] = api.messages
    expect(request?.headers['x-dsh-auth-token']).toBe(TOKEN)
    expect(request?.body).toMatchObject({
      model: 'deepseek-flash', stream: true, max_tokens: 16_384, thinking: { type: 'enabled' }, output_config: { effort: 'low' },
      // The composition registers none of the tools that the reviewer names besides Godot.
      system: reviewerPrompt([], []),
    })
    expect(request?.body).not.toHaveProperty('temperature')
    const [message, ...others] = request?.body.messages as { role: string; content: Record<string, unknown>[] }[]
    expect(others).toEqual([])
    expect(message?.role).toBe('user')
    const [handle, image, words] = message?.content ?? []
    expect(handle).toMatchObject({ type: 'text', text: expect.stringContaining('request preview 800x400px') as string })
    expect(image).toEqual({ type: 'image', source: { type: 'file', file_id: 'file-1' } })
    expect(words).toEqual({
      type: 'text',
      text: 'Image: knight.png, 32x16 px, shown at 800x400 px.\nWhat it shows: the knight\'s idle sprite\nThe look the game is going for: 16-bit pixel art',
    })

    expect(toolResult(followUp)).toBe(`Graphics review of ${join(booted.work, 'knight.png')}:\n\n${REVIEW}`)
  })

  it('asks for a sign-in while signed out, and says a reviewer held back for a newer WASD Engine is not available, before any Messages request', async () => {
    const booted = await boot()
    await writeCheckerboard(join(booted.work, 'knight.png'), 32, 16)
    booted.account.signedIn = false
    const [, signedOut] = await reviewTurn(booted, 'signed-out', { image: 'knight.png', subject: 'the knight\'s idle sprite' })
    expect(toolResult(signedOut)).toBe('Error: The graphics reviewer needs WASD Engine to be signed in. Ask the user to sign in to WASD Engine, '
      + 'then try again.')

    booted.account.signedIn = true
    booted.api.listing = { data: [PRO, vision('99.0.0')] }
    const [, heldBack] = await reviewTurn(booted, 'held-back', { image: 'knight.png', subject: 'the knight\'s idle sprite' })
    expect(toolResult(heldBack)).toBe('Error: The graphics reviewer is not available in this WASD Engine, and calling it again will not help. Go '
      + 'on without a review and tell the user; updating WASD Engine may bring it back.')
    expect(booted.api.paths).toEqual(['GET /models'])
  })
})
