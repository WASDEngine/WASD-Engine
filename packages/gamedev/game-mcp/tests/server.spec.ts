/**
 * The server with real services: it listens on loopback with a token, serves the providers' tools to the official
 * MCP client over Streamable HTTP, streams its view to the window, and withdraws a provider's tools with it.
 */
import { once } from 'node:events'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { GameProjectController } from '@deepseek-ai/dsh-api-workspace-controller'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AccountView, DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport, type Progress } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GameMcpServer, { SIGNED_OUT_MESSAGE, type Config, type GameMcpProvider, type GameMcpToolResult, type GameMcpView } from '../src/index.ts'

const TIMEOUT = 30_000

const echo = defineTool({
  name: 'echo',
  description: 'Echo the text back.',
  parameters: { text: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { echoed: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `echo: ${value.echoed}` }],
  },
  execute: async args => ({ echoed: args.text }),
})

const alpha: GameMcpProvider = {
  id: 'alpha',
  title: 'Alpha',
  description: 'Echoes text.',
  instructions: 'Call alpha_echo to check the connection.',
  tools: () => [
    { name: 'alpha_echo', definition: echo, readOnly: true },
    {
      name: 'alpha_show',
      definition: echo,
      prepare: async (args, call) => {
        call.reveal(brandString<SessionId>(`session-of-${call.client.id}`))
        return { args }
      },
    },
  ],
  status: () => Promise.resolve({ state: 'ready' }),
}

let root: string
let ctx: Context

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-server-'))
  ctx = new Context()
  await ctx.plugin(TypertRegistry)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/** A started server, its settled view, every view it sent, and the controller that ends its watch. */
interface Started {
  server: GameMcpServer
  view: GameMcpView
  views: GameMcpView[]
  stop: AbortController
}

/** Start the server and wait until its view settles in a state other than `starting`. */
async function start(config: Partial<Config> = {}): Promise<Started> {
  const fiber = ctx.plugin(GameMcpServer, GameMcpServer.Config({ dataRoot: join(root, 'data'), port: 0, ...config }))
  await fiber
  const server = ctx.get('gameMcp') as GameMcpServer
  const stop = new AbortController()
  const views: GameMcpView[] = []
  void (async () => {
    for await (const view of server.watch(stop.signal)) views.push(view)
  })()
  ctx.effect(() => () => { stop.abort() })
  await vi.waitFor(() => { expect(views.at(-1)?.state ?? 'starting').not.toBe('starting') }, { timeout: TIMEOUT })
  return { server, view: views.at(-1) as GameMcpView, views, stop }
}

async function connect(url: string, token: string, name = 'claude-code'): Promise<Client> {
  const client = new Client({ name, version: '2.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  ctx.effect(() => () => client.close())
  return client
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Send one raw request; fetch cannot set a foreign Host header. */
function raw(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    })
    sent.on('error', reject)
    sent.end('{}')
  })
}

describe('GameMcpServer', () => {
  it('serves the providers\' tools to an MCP client that has the token', async () => {
    const { server, view } = await start()
    ctx.effect(() => server.provide(alpha))
    expect(view).toMatchObject({ state: 'listening', clients: [] })
    const url = view.url as string
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/u)
    const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()
    expect(view.prompt).toContain(`URL: ${url}`)
    expect(view.prompt).toContain(`Bearer ${token}`)

    const client = await connect(url, token)
    expect(client.getServerVersion()).toMatchObject({ name: 'wasd-engine', title: 'WASD Engine' })
    const instructions = client.getInstructions() ?? ''
    expect(instructions.startsWith('WASD Engine is the game development app open on this computer, and this server gives you its game tools. ')).toBe(true)
    expect(instructions).toContain('What each plugin adds:\n- Alpha (alpha_*): Echoes text.\n\n')
    expect(instructions.endsWith('\n\n## Alpha\n\nCall alpha_echo to check the connection.')).toBe(true)
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'alpha' } })))
      .toContain('Alpha guide (where it names a tool without the alpha_ prefix, add the prefix):\n\nCall alpha_echo to check the connection.')
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['search_game_tools', 'call_game_tool', 'create_game_project', 'alpha_echo', 'alpha_show'])
    expect(tools[3]).toMatchObject({ annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['text'] } })

    expect(text(await client.callTool({ name: 'alpha_echo', arguments: { text: 'hi' } }))).toBe('echo: hi')
    expect(text(await client.callTool({ name: 'call_game_tool', arguments: { name: 'alpha_echo', arguments: { text: 'by name' } } }))).toBe('echo: by name')
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { query: 'echo' } }))).toContain('alpha_echo (Alpha): Echo the text back.')
    expect(text(await client.callTool({ name: 'call_game_tool', arguments: { name: 'search_game_tools', arguments: {} } }))).toContain('- alpha_show:')
    const unknown = await client.callTool({ name: 'call_game_tool', arguments: { name: 'nope' } })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('no game tool named "nope"')
    expect((await client.callTool({ name: 'call_game_tool', arguments: {} })).isError).toBe(true)
    expect((await client.callTool({ name: 'call_game_tool', arguments: { name: 'alpha_echo', arguments: 'x' } })).isError).toBe(true)
  }, TIMEOUT)

  it('warns when a provider\'s description makes the overview longer than agents such as Claude Code read', async () => {
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const { server } = await start()
    ctx.effect(() => server.provide(alpha))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('overview'))
    ctx.effect(() => server.provide({ ...alpha, id: 'wordy', title: 'Wordy', description: 'x'.repeat(4096), tools: () => [] }))
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(new RegExp(
      '^game-mcp: with Wordy, the overview of the server instructions comes to \\d+ characters, more than the 4096 that Claude Code '
      + 'passes to its model; shorten the providers\' descriptions$', 'u')))
  }, TIMEOUT)

  it('starts a long call\'s response at once and reports progress while it runs, on the 2026-07-28 revision', async () => {
    let finish = (): void => {}
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const slow = defineTool({
      name: 'slow',
      description: 'Wait until the test lets the call end.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { done: { type: 'boolean', required: true } } },
        render: () => [{ type: 'text', text: 'done' }],
      },
      execute: async () => {
        await finished
        return { done: true }
      },
    })
    const { server, view } = await start({ progressIntervalMs: 20 })
    ctx.effect(() => server.provide({ ...alpha, tools: () => [{ name: 'alpha_slow', definition: slow }] }))
    const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()
    // The content type of each tools/call response, recorded once its headers arrive.
    const begun: string[] = []
    const client = new Client({ name: 'claude-code', version: '2.1.0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } })
    await client.connect(new StreamableHTTPClientTransport(new URL(view.url as string), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: async (input, init) => {
        const response = await fetch(input, init)
        if (typeof init?.body === 'string' && init.body.includes('"tools/call"')) begun.push(response.headers.get('content-type') ?? '')
        return response
      },
    }))
    ctx.effect(() => () => client.close())

    // An agent that asked for no progress: the response begins while the tool still runs.
    const quiet = client.callTool({ name: 'alpha_slow', arguments: {} })
    await vi.waitFor(() => { expect(begun).toEqual([expect.stringContaining('text/event-stream')]) }, { timeout: TIMEOUT })
    // An agent that asked for progress hears from the call at every interval.
    const updates: Progress[] = []
    const reported = client.callTool({ name: 'alpha_slow', arguments: {} }, { onprogress: (update) => { updates.push(update) } })
    await vi.waitFor(() => { expect(updates.length).toBeGreaterThanOrEqual(2) }, { timeout: TIMEOUT })
    expect(updates.slice(0, 2).map(update => update.progress)).toEqual([1, 2])
    for (const update of updates) expect(update.message).toMatch(/^Still running after \d+ s\.$/u)
    finish()
    expect(text(await quiet)).toBe('done')
    expect(text(await reported)).toBe('done')
    const count = updates.length
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(updates).toHaveLength(count)
  }, TIMEOUT)

  it('refuses every tool call while WASD Engine is signed out, and runs them once someone signs in', async () => {
    let status: AccountView['status'] | 'unreadable' = 'signed-out'
    const account: Pick<DeepSeekAccount, 'getState'> = {
      getState: async () => {
        if (status === 'unreadable') throw new Error('storage unavailable')
        return { status, links: { usageUrl: '', topUpUrl: '' }, attempt: null }
      },
    }
    ctx.provide('deepseekAccount', account)
    const { server, view } = await start()
    ctx.effect(() => server.provide(alpha))
    const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()
    const client = await connect(view.url as string, token)
    // The tools stay listed, so the agent learns what signing in gives it.
    expect((await client.listTools()).tools).toHaveLength(5)
    for (const call of [
      { name: 'alpha_echo', arguments: { text: 'hi' } },
      { name: 'search_game_tools', arguments: { query: 'echo' } },
      { name: 'call_game_tool', arguments: { name: 'alpha_echo', arguments: { text: 'hi' } } },
      { name: 'create_game_project', arguments: { name: 'Game', location: root } },
    ]) {
      const refused = await client.callTool(call)
      expect(refused.isError).toBe(true)
      expect(text(refused)).toBe(SIGNED_OUT_MESSAGE)
    }
    status = 'credential-stored'
    expect(text(await client.callTool({ name: 'alpha_echo', arguments: { text: 'hi' } }))).toBe('echo: hi')
    status = 'unreadable'
    expect(text(await client.callTool({ name: 'alpha_echo', arguments: { text: 'hi' } }))).toBe(SIGNED_OUT_MESSAGE)
  }, TIMEOUT)

  it('creates game projects for a connected agent, by name and through call_game_tool, without a Session', async () => {
    const registered: string[] = []
    ctx.provide('workspaceRegistry', {
      create: async (path: string) => {
        const canonical = await realpath(path)
        registered.push(canonical)
        return { id: `w${registered.length}`, path: canonical, title: basename(canonical), sessionIds: [], createdAt: '', updatedAt: '' }
      },
    } as never)
    const createSession = vi.fn()
    ctx.provide('sessionController', { create: createSession, resolveAgent: createSession } as never)
    const documents = join(await realpath(root), 'Documents')
    new GameProjectController(ctx, { documentsDirectory: documents, documentsLookupTimeoutMs: 10_000, required: false }, () => Promise.resolve(''))
    const events: Array<GameMcpToolResult | SessionId> = []
    ctx.on('game-mcp/tool-result', (result) => { events.push(result) })
    ctx.on('game-mcp/reveal', (sessionId) => { events.push(sessionId) })
    const { server, view } = await start()
    ctx.effect(() => server.provide(alpha))
    const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()
    const client = await connect(view.url as string, token)

    const listed = (await client.listTools()).tools.find(tool => tool.name === 'create_game_project')
    expect(listed).toMatchObject({ title: 'Create game project', inputSchema: { required: ['name'], properties: { name: { type: 'string' }, location: { type: 'string' } } } })
    expect(listed?.annotations?.readOnlyHint).toBeUndefined()
    expect(client.getInstructions()).toContain('For a new game, create its project with create_game_project and make the game in the folder it returns.')

    const first = await client.callTool({ name: 'create_game_project', arguments: { name: 'Space Frogs' } })
    expect(first.isError).toBeFalsy()
    expect(text(first)).toContain(`Created the game project "Space Frogs" in ${join(documents, 'WASD Engine', 'Space Frogs')}, which WASD Engine lists among the user's game projects.`)
    const second = await client.callTool({ name: 'call_game_tool', arguments: { name: 'create_game_project', arguments: { name: 'Moon Miner', location: documents } } })
    expect(text(second)).toContain(`Created the game project "Moon Miner" in ${join(documents, 'Moon Miner')}`)
    const again = await client.callTool({ name: 'create_game_project', arguments: { name: 'Moon Miner', location: documents } })
    expect(again.isError).toBe(true)
    expect(text(again)).toBe(`${join(documents, 'Moon Miner')} already exists; pass another name or location.`)

    expect(registered).toEqual([join(documents, 'WASD Engine', 'Space Frogs'), join(documents, 'Moon Miner')])
    // The projects hold no Session, the window is asked to show none, and no provider tool ran.
    expect(createSession).not.toHaveBeenCalled()
    expect(events).toEqual([])
  }, TIMEOUT)

  it('refuses requests without the token, from foreign hosts and origins, and outside its endpoint', async () => {
    const { view } = await start()
    const url = view.url as string
    const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()
    expect(await raw(url, {})).toBe(401)
    expect(await raw(url, { authorization: 'Bearer wrong' })).toBe(401)
    expect(await raw(url, { authorization: `Bearer ${token}`, host: 'attacker.example:80' })).toBe(403)
    expect(await raw(url, { authorization: `Bearer ${token}`, origin: 'https://attacker.example' })).toBe(403)
    expect(await raw(url.replace('/mcp', '/other'), { authorization: `Bearer ${token}` })).toBe(404)
  }, TIMEOUT)

  it('reports the agents it saw and asks the window to show the Sessions their calls name', async () => {
    const { server, view, views } = await start()
    ctx.effect(() => server.provide(alpha))
    const revealed: SessionId[] = []
    ctx.on('game-mcp/reveal', (sessionId) => { revealed.push(sessionId) })
    const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()
    const client = await connect(view.url as string, token, 'codex-mcp-client')
    await vi.waitFor(() => { expect(views.at(-1)?.clients).toMatchObject([{ id: 'codex-mcp-client', title: 'Codex' }]) }, { timeout: TIMEOUT })
    await client.callTool({ name: 'alpha_show', arguments: { text: 'show' } })
    await client.callTool({ name: 'alpha_show', arguments: { text: 'again' } })
    expect(revealed).toEqual(['session-of-codex-mcp-client', 'session-of-codex-mcp-client'])
  }, TIMEOUT)

  it('withdraws a provider\'s tools when its registration is disposed, and refuses a taken or invalid id', async () => {
    const { server, view } = await start()
    const dispose = server.provide(alpha)
    expect(() => server.provide({ ...alpha })).toThrow('already has the id "alpha"')
    expect(() => server.provide({ ...alpha, id: 'Not Valid' })).toThrow('invalid provider id')
    const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()
    const client = await connect(view.url as string, token)
    expect((await client.listTools()).tools).toHaveLength(5)
    dispose()
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['search_game_tools', 'call_game_tool', 'create_game_project'])
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: {} }))).toBe('WASD Engine offers no game tools right now.')
  }, TIMEOUT)

  it('listens on a free port for the run when another program holds the configured one', async () => {
    const holder: Server = createServer()
    holder.listen(0, '127.0.0.1')
    await once(holder, 'listening')
    ctx.effect(() => () => { holder.close() })
    const taken = (holder.address() as AddressInfo).port
    const { view } = await start({ port: taken })
    expect(view.state).toBe('listening')
    expect(view.url).not.toContain(`:${taken}/`)
    expect(view.message).toBe(`Port ${taken} is in use by another program, so the server listens on port ${new URL(view.url as string).port} until WASD Engine restarts.`)
  }, TIMEOUT)

  it('reports a server that cannot start', async () => {
    await writeFile(join(root, 'data'), 'a file where the data folder belongs')
    const { view } = await start()
    expect(view).toMatchObject({ state: 'failed', clients: [] })
    expect(view.message).toMatch(/^The MCP server could not start: /u)
    expect(view.url).toBeUndefined()
    expect(view.prompt).toBeUndefined()
  }, TIMEOUT)

  it('refuses a relative data folder', () => {
    expect(() => new GameMcpServer(ctx, GameMcpServer.Config({ dataRoot: 'relative' }))).toThrow('dataRoot must be an absolute path')
  })
})
