/**
 * The server in a Loader composition, as the app mounts it: the listener starts before the other plugins have loaded,
 * and an agent that connects then gets its answers once the Loader has settled, so the instructions name the provider
 * of a plugin whose start ends after the listener's, as the game add-ons' start ends after their catalog loads.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import GameMcpServer, { type GameMcpProvider, type GameMcpView } from '../src/index.ts'

const TIMEOUT = 30_000

const wave = defineTool({
  name: 'late_wave',
  description: 'Wave back.',
  parameters: {},
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { waved: { type: 'boolean', required: true } } },
    render: () => [{ type: 'text', text: 'waved' }],
  },
  execute: async () => ({ waved: true }),
})

const late: GameMcpProvider = {
  id: 'late',
  title: 'Late',
  description: 'Waves once its plugin has started.',
  instructions: 'Call late_wave.',
  tools: () => [{ name: 'late_wave', definition: wave, readOnly: true }],
  status: () => Promise.resolve({ state: 'ready' }),
}

let root: string
let ctx: Context
/** Lets the late plugin's start end. */
let started: PromiseWithResolvers<undefined>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-loader-'))
  started = Promise.withResolvers<undefined>()
  ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    'game-mcp': GameMcpServer,
    // A plugin whose start ends later, which offers its game tools once it has started.
    'late-plugin': {
      name: 'late-plugin',
      async apply(plugin: Context) {
        await started.promise
        plugin.inject(['gameMcp'], (inner) => { inner.effect(() => inner.gameMcp.provide(late), 'late-plugin: game MCP tools') })
      },
    },
  })
})

afterEach(async () => {
  started.resolve(undefined)
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

it('answers an agent that connects while a plugin still starts once the Loader has settled, with that plugin\'s provider', async () => {
  await ctx.loader.create({ name: 'cordis:game-mcp', config: { dataRoot: join(root, 'data'), port: 0 } })
  await ctx.loader.create({ name: 'cordis:late-plugin' })
  const server = ctx.get('gameMcp')
  if (server === undefined) throw new Error('the game MCP server is not loaded')
  const watching = new AbortController()
  const views: GameMcpView[] = []
  void (async () => {
    for await (const view of server.watch(watching.signal)) views.push(view)
  })()
  ctx.effect(() => () => { watching.abort() })
  await vi.waitFor(() => { expect(views.at(-1)?.state).toBe('listening') }, { timeout: TIMEOUT })
  const token = (await readFile(join(root, 'data', 'token'), 'utf8')).trim()

  const client = new Client({ name: 'claude-code', version: '2.1.0' })
  ctx.effect(() => () => client.close())
  const connecting = client.connect(new StreamableHTTPClientTransport(new URL(views.at(-1)?.url as string), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }))
  // The server has the agent's first request while the late plugin still starts.
  await vi.waitFor(() => { expect(views.at(-1)?.clients).toMatchObject([{ id: 'claude-code' }]) }, { timeout: TIMEOUT })
  started.resolve(undefined)
  await connecting

  expect(client.getInstructions()).toContain('\n- Late (late_*): Waves once its plugin has started.')
  expect(client.getInstructions()).toContain('\n\n## Late\n\nCall late_wave.')
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain('late_wave')
}, TIMEOUT)
