/**
 * A call that names a confirmation page reaches a 2026-07-28 client that declared URL-mode elicitation as an
 * input-required result; the client's retry returns the call's content and the user's answer without running the tool
 * again. Every other client gets the content alone.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GameMcpServer, { type GameMcpProvider, type GameMcpView } from '../src/index.ts'

const TIMEOUT = 30_000
const PAGE = 'https://site.test/servers/confirm/token-1'

let root: string
let ctx: Context
let runs: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-elicit-'))
  ctx = new Context()
  await ctx.plugin(TypertRegistry)
  runs = 0
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

const buy = defineTool({
  name: 'buy',
  description: 'Ask for a purchase the user confirms on the site.',
  parameters: { size: { type: 'string', required: true } },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { status: { type: 'string', required: true }, confirm_url: { type: 'string' }, confirm_message: { type: 'string' } },
    },
    render: (_args, value) => [{ type: 'text', text: value.status === 'awaiting_confirmation' ? `Open this page to confirm: ${value.confirm_url ?? ''}` : 'Declined.' }],
  },
  execute: (args) => {
    runs++
    return Promise.resolve(args.size === 'none'
      ? { status: 'declined' }
      : { status: 'awaiting_confirmation', confirm_url: PAGE, confirm_message: `Confirm the ${args.size} server on the WASD Engine site.` })
  },
})

const shop: GameMcpProvider = {
  id: 'shop',
  title: 'Shop',
  description: 'Purchases.',
  tools: () => [{
    name: 'shop_buy',
    definition: buy,
    confirmation: value => typeof value === 'object' && value !== null && !Array.isArray(value) && value.status === 'awaiting_confirmation'
      ? { url: PAGE, message: typeof value.confirm_message === 'string' ? value.confirm_message : '' }
      : undefined,
  }],
  status: () => Promise.resolve({ state: 'ready' }),
}

/** Start the server with the shop's tools and return its URL and token. */
async function start(): Promise<{ readonly url: string; readonly token: string }> {
  await ctx.plugin(GameMcpServer, GameMcpServer.Config({ dataRoot: join(root, 'data'), port: 0 }))
  const server = ctx.get('gameMcp') as GameMcpServer
  ctx.effect(() => server.provide(shop))
  const stop = new AbortController()
  ctx.effect(() => () => { stop.abort() })
  const views: GameMcpView[] = []
  void (async () => {
    for await (const view of server.watch(stop.signal)) views.push(view)
  })()
  await vi.waitFor(() => { expect(views.at(-1)?.state).toBe('listening') }, { timeout: TIMEOUT })
  return { url: views.at(-1)?.url as string, token: (await readFile(join(root, 'data', 'token'), 'utf8')).trim() }
}

type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[1]>

async function connect(options: ClientOptions): Promise<Client> {
  const { url, token } = await start()
  const client = new Client({ name: 'claude-code', version: '2.1.0' }, options)
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  ctx.effect(() => () => client.close())
  return client
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

const MODERN = { versionNegotiation: { mode: { pin: '2026-07-28' } } } as const satisfies ClientOptions

describe('confirmation pages', () => {
  it('reach a client that declared URL elicitation as the page, then the content and the user\'s answer', async () => {
    const client = await connect({ ...MODERN, capabilities: { elicitation: { url: {} } } })
    const asked: unknown[] = []
    client.setRequestHandler('elicitation/create', (request) => {
      asked.push(request.params)
      return Promise.resolve({ action: 'accept' as const })
    })
    const result = await client.callTool({ name: 'shop_buy', arguments: { size: 'small' } })
    expect(asked).toEqual([expect.objectContaining({ mode: 'url', url: PAGE, message: 'Confirm the small server on the WASD Engine site.' })])
    expect(result.isError).toBeFalsy()
    expect(text(result)).toBe(`Open this page to confirm: ${PAGE}\nThe user opened the confirmation page. It takes effect once they confirm there; nothing is charged or changed before that.`)
    expect(runs).toBe(1)

    client.setRequestHandler('elicitation/create', () => Promise.resolve({ action: 'decline' as const }))
    expect(text(await client.callTool({ name: 'call_game_tool', arguments: { name: 'shop_buy', arguments: { size: 'large' } } })))
      .toContain('The user declined to open the confirmation page, so nothing was charged or changed.')
    expect(text(await client.callTool({ name: 'shop_buy', arguments: { size: 'none' } }))).toBe('Declined.')
    expect(runs).toBe(3)
  }, TIMEOUT)

  it('refuse a retry whose state was changed, and answer one without state', async () => {
    const client = await connect({ ...MODERN, capabilities: { elicitation: { url: {} } }, inputRequired: { autoFulfill: false } })
    const first: object = await client.callTool({ name: 'shop_buy', arguments: { size: 'small' } }, { allowInputRequired: true })
    expect(first).toMatchObject({ resultType: 'input_required', inputRequests: { confirm: { method: 'elicitation/create', params: { mode: 'url', url: PAGE } } } })
    const state = 'requestState' in first && typeof first.requestState === 'string' ? first.requestState : ''
    expect(state).not.toBe('')
    const forged = { name: 'shop_buy', arguments: { size: 'small' }, inputResponses: { confirm: { action: 'accept' } }, requestState: `${state.slice(0, -4)}AAAA` }
    await expect(client.callTool(forged)).rejects.toThrow()
    const stateless = { name: 'shop_buy', arguments: { size: 'small' }, inputResponses: { confirm: { action: 'accept' } } }
    const refused = await client.callTool(stateless)
    expect(refused.isError).toBe(true)
    expect(text(refused)).toBe('This confirmation is no longer valid; call the tool again.')
    const retry = { name: 'shop_buy', arguments: { size: 'small' }, inputResponses: { confirm: { action: 'cancel' } }, requestState: state }
    expect(text(await client.callTool(retry))).toContain('The user dismissed the confirmation page, so nothing was charged or changed.')
    expect(runs).toBe(1)
  }, TIMEOUT)

  it('leave the page in the content for a client without URL elicitation and for a 2025 client', async () => {
    const modern = await connect({ ...MODERN, capabilities: { elicitation: { form: {} } } })
    expect(text(await modern.callTool({ name: 'shop_buy', arguments: { size: 'small' } }))).toBe(`Open this page to confirm: ${PAGE}`)
    await ctx.fiber.dispose()
    ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const legacy = await connect({ capabilities: { elicitation: { url: {} } } })
    expect(text(await legacy.callTool({ name: 'shop_buy', arguments: { size: 'small' } }))).toBe(`Open this page to confirm: ${PAGE}`)
    expect(runs).toBe(2)
  }, TIMEOUT)
})
