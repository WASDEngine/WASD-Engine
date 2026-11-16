/**
 * A Free account whose AI usage is used up, as agents connected through WASD Engine's MCP server meet it: a failed call
 * of a tool that spends the usage becomes the page that upgrades the account to Pro for a client that shows pages, where
 * declining stays on Free, or a text the agent passes on for every other client. A user who stays on Free is offered no
 * provider that spends the usage, with nothing telling the agent why, until the account has usage again; the choice
 * outlives a restart. An agent that received the server instructions before such a change gets a note, once, that
 * names the providers turned off or on. A paid plan's used-up usage, and other failures, stay as they are.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { DeepSeekAccount } from '@deepseek-ai/dsh-deepseek-account'
import { defineTool } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISMISSED, FREE_PLAN_FILE, providersNote, STAYING, UPGRADING } from '../src/free-plan.ts'
import GameMcpServer, { type GameMcpProvider, type GameMcpView } from '../src/index.ts'

const TIMEOUT = 30_000
const SITE = 'https://site.test'
const UPGRADE = `${SITE}/upgrade?plan=pro`
const USED_UP = 'Usage limit reached: the AI usage that the WASD Engine Free plan includes this month, and your credits, are used up. '
  + 'Pass this on to the user, then try again once they have upgraded their WASD Engine plan or turned on auto recharge.'

let root: string
let ctx: Context
let started: { readonly server: GameMcpServer; readonly url: string; readonly token: string } | undefined
let usage: { plan: 'free' | 'pro'; usedUp: boolean; refreshesAt: string }
let reads: number

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-20T00:00:00Z'))
  root = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-free-'))
  usage = { plan: 'free', usedUp: true, refreshesAt: '2026-12-01T00:00:00Z' }
  reads = 0
  ctx = await composition()
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

/** A Host with the typert registry and an account service that reports {@link usage}. */
async function composition(): Promise<Context> {
  started = undefined
  const host = new Context()
  await host.plugin(TypertRegistry)
  const account: Pick<DeepSeekAccount, 'getState' | 'getBalance'> = {
    getState: () => Promise.resolve({ status: 'credential-stored', links: { usageUrl: `${SITE}/usage`, topUpUrl: `${SITE}/top_up` }, attempt: null }),
    getBalance: () => {
      reads++
      return Promise.resolve({
        status: 'ready', value: [], bonusWallets: [],
        allowance: { remainingPercent: 0, remainingShare: 0, refreshesAt: usage.refreshesAt, plan: usage.plan, usedUp: usage.usedUp },
      })
    },
  }
  host.provide('deepseekAccount', account)
  return host
}

const make = defineTool({
  name: 'make',
  description: 'Make a sound.',
  parameters: { what: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { made: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `made ${value.made}` }],
  },
  execute: (args) => {
    if (args.what === 'nothing') throw new Error('what must name a sound.')
    if (usage.usedUp) throw new Error(USED_UP)
    return Promise.resolve({ made: args.what })
  },
})

const echo = defineTool({
  name: 'echo',
  description: 'Echo text.',
  parameters: { text: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
    render: (_args, value) => [{ type: 'text', text: `echo: ${value.text}` }],
  },
  execute: args => Promise.resolve({ text: args.text }),
})

const paid: GameMcpProvider = {
  id: 'voices',
  title: 'Voices',
  description: 'Make voices and sound effects.',
  instructions: 'Name the sound you want.',
  spendsUsage: true,
  tools: () => [{ name: 'voices_make', definition: make }],
  status: () => Promise.resolve({ state: 'ready' }),
}

const free: GameMcpProvider = {
  id: 'free',
  title: 'Free tools',
  description: 'Echo text.',
  tools: () => [{ name: 'free_echo', definition: echo }],
  status: () => Promise.resolve({ state: 'ready' }),
}

/** Start the server with both providers, once per composition, and return it, its URL, and its token. */
async function start(): Promise<{ readonly server: GameMcpServer; readonly url: string; readonly token: string }> {
  if (started !== undefined) return started
  await ctx.plugin(GameMcpServer, GameMcpServer.Config({ dataRoot: join(root, 'data'), port: 0 }))
  const server = ctx.get('gameMcp') as GameMcpServer
  ctx.effect(() => server.provide(paid))
  ctx.effect(() => server.provide(free))
  const stop = new AbortController()
  ctx.effect(() => () => { stop.abort() })
  const views: GameMcpView[] = []
  void (async () => {
    for await (const view of server.watch(stop.signal)) views.push(view)
  })()
  await vi.waitFor(() => { expect(views.at(-1)?.state).toBe('listening') }, { timeout: TIMEOUT })
  started = { server, url: views.at(-1)?.url as string, token: (await readFile(join(root, 'data', 'token'), 'utf8')).trim() }
  return started
}

type ClientOptions = NonNullable<ConstructorParameters<typeof Client>[1]>

async function connect(options: ClientOptions = {}, name = 'claude-code'): Promise<Client> {
  const { url, token } = await start()
  const client = new Client({ name, version: '2.1.0' }, options)
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  ctx.effect(() => () => client.close())
  return client
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function names(client: Client): Promise<string[]> {
  return (await client.listTools()).tools.map(tool => tool.name)
}

const MODERN = { versionNegotiation: { mode: { pin: '2026-07-28' } } } as const satisfies ClientOptions
const PAGES = { ...MODERN, capabilities: { elicitation: { url: {} } } } as const satisfies ClientOptions
const OFF = providersNote([{ id: 'voices', title: 'Voices' }], true)
const ON = providersNote([{ id: 'voices', title: 'Voices' }], false)

/** A client that shows pages, which answers the page that upgrades the account with `action`. */
async function asking(action: 'accept' | 'decline' | 'cancel'): Promise<{ readonly client: Client; readonly asked: unknown[] }> {
  const client = await connect(PAGES)
  const asked: unknown[] = []
  client.setRequestHandler('elicitation/create', (request) => {
    asked.push(request.params)
    return Promise.resolve({ action })
  })
  return { client, asked }
}

describe('a Free account whose usage is used up', () => {
  it('is asked to upgrade on the page, and declining keeps it on Free without the providers that spend usage', async () => {
    const { client, asked } = await asking('decline')
    expect(await names(client)).toEqual(['search_game_tools', 'call_game_tool', 'create_game_project', 'voices_make', 'free_echo'])
    const result = await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } })
    expect(asked).toEqual([expect.objectContaining({ mode: 'url', url: UPGRADE })])
    const message = (asked[0] as { readonly message: string }).message
    expect(message).toContain('Your WASD Engine Free plan has used up its AI usage for this month (it refreshes on December 1).')
    expect(message).toContain('decline to stay on Free')
    expect(message).toContain('the quality of generated audio, video, 3D models, animations, and graphics will decrease')
    // The agent learns only that the tool is not available now, and which tools are off: nothing names the plan or a price.
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(`${STAYING}\n${OFF}`)
    expect(text(result)).not.toMatch(/free|pro\b|plan|paid|pay|price|usage|upgrade/iu)

    // The provider is gone from the list, the search, and calls by name; the other tools stay.
    expect(await names(client)).toEqual(['search_game_tools', 'call_game_tool', 'create_game_project', 'free_echo'])
    const search = text(await client.callTool({ name: 'search_game_tools', arguments: {} }))
    expect(search).toContain('free_echo')
    expect(search).not.toContain('voices')
    const byName = await client.callTool({ name: 'call_game_tool', arguments: { name: 'voices_make', arguments: { what: 'a door' } } })
    expect(text(byName)).toBe('WASD Engine has no game tool named "voices_make"; search_game_tools lists the tools.')
    expect(text(await client.callTool({ name: 'free_echo', arguments: { text: 'hi' } }))).toBe('echo: hi')
    // The choice lasts until the usage refreshes.
    expect(JSON.parse(await readFile(join(root, 'data', FREE_PLAN_FILE), 'utf8'))).toEqual({ version: 1, until: '2026-12-01T00:00:00.000Z' })
  }, TIMEOUT)

  it('leaves the provider out of the instructions of an agent that connects while it stays on Free', async () => {
    const { client } = await asking('decline')
    expect(client.getInstructions()).toContain('- Voices (voices_*): Make voices and sound effects.')
    await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } })
    const later = await connect({}, 'codex')
    const instructions = later.getInstructions() ?? ''
    expect(instructions).toContain('- Free tools (free_*): Echo text.')
    expect(instructions).not.toContain('Voices')
    expect(instructions).not.toContain('Name the sound you want.')
    // Its instructions never named the provider, so no note comes with its results.
    expect(text(await later.callTool({ name: 'free_echo', arguments: { text: 'hi' } }))).toBe('echo: hi')
    // A Session's own calls of the provider's tools still count by it.
    expect((await start()).server.toolOwner('voices_make')).toEqual({ provider: 'voices', title: 'Voices', tool: 'voices_make' })
  }, TIMEOUT)

  it('tells each agent that received the instructions before a change, once, which tools turned off or came back', async () => {
    const { client: asker } = await asking('decline')
    const other = await connect(MODERN, 'codex')
    expect(text(await other.callTool({ name: 'free_echo', arguments: { text: 'hi' } }))).toBe('echo: hi')
    expect(text(await asker.callTool({ name: 'voices_make', arguments: { what: 'a door' } }))).toBe(`${STAYING}\n${OFF}`)
    // The other agent received its instructions before: its next result tells it, once.
    expect(text(await other.callTool({ name: 'free_echo', arguments: { text: 'hi' } }))).toBe(`echo: hi\n${OFF}`)
    expect(text(await other.callTool({ name: 'free_echo', arguments: { text: 'hi' } }))).toBe('echo: hi')
    expect(text(await other.callTool({ name: 'search_game_tools', arguments: { query: 'voices' } }))).not.toContain('Note:')
    // Back after an upgrade: each agent hears it once, and finds the tools again.
    usage = { ...usage, plan: 'pro', usedUp: false }
    vi.setSystemTime(new Date('2026-11-20T00:01:01Z'))
    for (const agent of [asker, other]) {
      expect(text(await agent.callTool({ name: 'free_echo', arguments: { text: 'hi' } }))).toBe(`echo: hi\n${ON}`)
      expect(text(await agent.callTool({ name: 'call_game_tool', arguments: { name: 'voices_make', arguments: { what: 'a door' } } })))
        .toBe('made a door')
    }
  }, TIMEOUT)

  it('gets the providers back once the account has usage again, and is asked again when it is used up again', async () => {
    const { client, asked } = await asking('decline')
    await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } })
    expect(await names(client)).not.toContain('voices_make')
    // The user upgrades: within a minute, the next request lists the provider again, and the choice ends.
    usage = { ...usage, plan: 'pro', usedUp: false }
    expect(await names(client)).not.toContain('voices_make')
    vi.setSystemTime(new Date('2026-11-20T00:01:01Z'))
    expect(await names(client)).toContain('voices_make')
    await expect(stat(join(root, 'data', FREE_PLAN_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    // The agent's instructions still name the provider; the note says it is back.
    expect(text(await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } }))).toBe(`made a door\n${ON}`)
    // Used up again on Free: the user is asked again.
    usage = { ...usage, plan: 'free', usedUp: true }
    await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } })
    expect(asked).toHaveLength(2)
  }, TIMEOUT)

  it('keeps the providers when the user opens the page or dismisses it, and says only what the agent should do', async () => {
    const opened = await asking('accept')
    expect(text(await opened.client.callTool({ name: 'voices_make', arguments: { what: 'a door' } }))).toBe(UPGRADING)
    expect(await names(opened.client)).toContain('voices_make')
    await ctx.fiber.dispose()
    ctx = await composition()
    const dismissed = await asking('cancel')
    expect(text(await dismissed.client.callTool({ name: 'voices_make', arguments: { what: 'a door' } }))).toBe(DISMISSED)
    expect(await names(dismissed.client)).toContain('voices_make')
    await expect(stat(join(root, 'data', FREE_PLAN_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  }, TIMEOUT)

  it('gets the offer through the agent from a client that shows no pages, and stays on Free unless the user upgrades', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Pass this on to the user, with its link, then go on with the work without this tool: Your WASD Engine Free plan has '
      + 'used up its AI usage for this month (it refreshes on December 1). To upgrade to Pro, open https://site.test/upgrade?plan=pro. Or stay '
      + 'on Free: On Free you can keep using WASD Engine, but the quality of generated audio, video, 3D models, animations, and graphics will '
      + `decrease.\n${OFF}`)
    expect(await names(client)).not.toContain('voices_make')
  }, TIMEOUT)

  it('stays on Free after a restart, until the usage refreshes', async () => {
    const { client } = await asking('decline')
    await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } })
    await ctx.fiber.dispose()
    ctx = await composition()
    const again = await connect()
    expect(await names(again)).not.toContain('voices_make')
    // The month the choice was made for ends: the provider is offered again, and a failed call asks again.
    vi.setSystemTime(new Date('2026-12-01T00:00:01Z'))
    expect(await names(again)).toContain('voices_make')
  }, TIMEOUT)
})

describe('failures that stay as they are', () => {
  it('a paid plan\'s used-up usage, and a failure that is not about usage', async () => {
    usage = { ...usage, plan: 'pro' }
    const { client, asked } = await asking('decline')
    expect(text(await client.callTool({ name: 'voices_make', arguments: { what: 'a door' } }))).toBe(USED_UP)
    usage = { ...usage, plan: 'free' }
    const before = reads
    expect(text(await client.callTool({ name: 'voices_make', arguments: { what: 'nothing' } }))).toBe('what must name a sound.')
    // Only a failure that says the limit was reached reads the account.
    expect(reads).toBe(before)
    expect(asked).toEqual([])
    expect(await names(client)).toContain('voices_make')
  }, TIMEOUT)
})
