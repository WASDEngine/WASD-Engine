/**
 * The server with real services: it listens on loopback with a token, serves the providers' tools to the official
 * MCP client over Streamable HTTP, streams its view to the window, and withdraws a provider's tools with it.
 */
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GameMcpServer, { type Config, type GameMcpProvider, type GameMcpView } from '../src/index.ts'

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
    expect(client.getInstructions()).toContain('## Alpha\n\nCall alpha_echo to check the connection.')
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toEqual(['search_game_tools', 'call_game_tool', 'alpha_echo', 'alpha_show'])
    expect(tools[2]).toMatchObject({ annotations: { readOnlyHint: true }, inputSchema: { type: 'object', required: ['text'] } })

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
    expect((await client.listTools()).tools).toHaveLength(4)
    dispose()
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['search_game_tools', 'call_game_tool'])
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
