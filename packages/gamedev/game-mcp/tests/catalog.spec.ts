/** The catalog lists the providers' tools under their prefixes, searches them, writes the instructions, and runs calls. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { CALL_TOOL, CREATE_PROJECT_TOOL, GameToolCatalog, SEARCH_TOOL } from '../src/catalog.ts'
import type { GameMcpCall, GameMcpProvider, GameMcpProviderStatus, GameMcpTool, GameMcpToolResult } from '../src/provider.ts'

function echoDefinition(name = 'echo'): ToolDefinition {
  return defineTool({
    name,
    description: 'Echo the text back. Use it to check the connection.',
    parameters: { text: { type: 'string', required: true, description: 'Text to echo.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { echoed: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `echo: ${value.echoed}` }],
    },
    execute: async args => ({ echoed: args.text }),
  })
}

const failing = defineTool({
  name: 'fail',
  description: 'Always fails.',
  parameters: {},
  output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
  execute: async () => { throw new Error('the tool failed on purpose') },
})

function provider(id: string, tools: readonly GameMcpTool[], status: GameMcpProviderStatus | Error = { state: 'ready' }, instructions?: string): GameMcpProvider {
  return {
    id,
    title: id.toUpperCase(),
    description: `The ${id} tools.`,
    ...instructions === undefined ? {} : { instructions },
    tools: () => tools,
    status: () => status instanceof Error ? Promise.reject(status) : Promise.resolve(status),
  }
}

function call(overrides: Partial<GameMcpCall> = {}): GameMcpCall {
  return {
    client: { id: 'claude-code', title: 'Claude Code' },
    signal: new AbortController().signal,
    session: () => Promise.reject(new Error('no Session in this spec')),
    reveal: () => {},
    ...overrides,
  }
}

describe('GameToolCatalog.tools', () => {
  it('keeps provider tools whose names carry the provider prefix, once each, and warns about the rest', () => {
    const warn = vi.fn<(message: string) => void>()
    const catalog = new GameToolCatalog(() => [
      provider('alpha', [
        { name: 'alpha_echo', definition: echoDefinition() },
        { name: 'beta_echo', definition: echoDefinition() },
        { name: 'alpha_echo', definition: echoDefinition() },
        { name: 'alpha_bad name', definition: echoDefinition() },
      ]),
      // The server's own tool names stay the server's.
      provider('create', [{ name: CREATE_PROJECT_TOOL, definition: echoDefinition() }]),
    ], warn)
    expect(catalog.tools().map(entry => entry.tool.name)).toEqual(['alpha_echo'])
    expect(warn).toHaveBeenCalledTimes(4)
  })

  it('lists the search, call, and create tools first, then each tool with its title, schema, and read-only hint', () => {
    const catalog = new GameToolCatalog(() => [
      provider('alpha', [{ name: 'alpha_echo', definition: echoDefinition(), readOnly: true, description: 'Echo for agents.' }]),
    ], () => {})
    const [search, callTool, create, echo] = catalog.listing()
    expect(search).toMatchObject({ name: SEARCH_TOOL, annotations: { readOnlyHint: true } })
    expect(search?.inputSchema).toMatchObject({ properties: { plugin: { enum: ['alpha'] } } })
    expect(callTool).toMatchObject({ name: CALL_TOOL, inputSchema: { required: ['name'] } })
    expect(create).toMatchObject({ name: CREATE_PROJECT_TOOL, title: 'Create game project', inputSchema: { required: ['name'] } })
    expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual(['name', 'location'])
    expect(create?.annotations).toBeUndefined()
    expect(echo).toEqual({
      name: 'alpha_echo',
      title: 'ALPHA: echo',
      description: 'Echo for agents.',
      inputSchema: echoDefinition().parameters,
      annotations: { readOnlyHint: true },
    })
  })
})

describe('GameToolCatalog.instructions', () => {
  it('introduces every provider and appends each provider\'s own instructions under its title', () => {
    const catalog = new GameToolCatalog(() => [provider('alpha', [], { state: 'ready' }, 'Use alpha_echo first.'), provider('beta', [])], () => {})
    const text = catalog.instructions()
    expect(text).toContain('ALPHA (alpha_* tools): The alpha tools.')
    expect(text).toContain('BETA (beta_* tools): The beta tools.')
    expect(text).toContain('## ALPHA\n\nUse alpha_echo first.')
    expect(text).not.toContain('## BETA')
    expect(text).toContain('When the user asks for a new game, create its project with create_game_project, which WASD Engine lists among the user\'s game projects, and make the game in the folder it returns.')
  })
})

describe('GameToolCatalog.search', () => {
  const catalog = new GameToolCatalog(() => [
    provider('alpha', [{ name: 'alpha_echo', definition: echoDefinition() }], { state: 'ready' }),
    provider('beta', [{ name: 'beta_fail', definition: failing }], { state: 'unavailable', message: 'Install Beta.' }),
    provider('gamma', [], new Error('status read failed')),
  ], () => {})

  it('lists every plugin with its readiness and every tool without a query', async () => {
    const text = await catalog.search('', undefined, new AbortController().signal)
    expect(text).toContain('- ALPHA (alpha_*, ready, 1 tools): The alpha tools.')
    expect(text).toContain('- BETA (beta_*, unavailable, 1 tools): The beta tools. Install Beta.')
    expect(text).toContain('- GAMMA (gamma_*, unavailable, 0 tools): The gamma tools. status read failed')
    expect(text).toContain('- alpha_echo: Echo the text back.')
    expect(text).toContain('- beta_fail: Always fails.')
  })

  it('lists the matching tools with their parameters, best match first', async () => {
    const text = await catalog.search('echo text', undefined, new AbortController().signal)
    expect(text).toContain('alpha_echo (ALPHA): Echo the text back. Use it to check the connection.\n  - text (string, required): Text to echo.')
    expect(text).not.toContain('beta_fail (BETA)')
  })

  it('limits the search to one plugin, and says when nothing matches', async () => {
    expect(await catalog.search('', 'beta', new AbortController().signal)).not.toContain('alpha_echo')
    expect(await catalog.search('', 'delta', new AbortController().signal)).toBe('No plugin is named "delta".')
    expect(await catalog.search('nothing-like-this', undefined, new AbortController().signal)).toContain('No tool matches "nothing-like-this"')
    expect(await new GameToolCatalog(() => [], () => {}).search('', undefined, new AbortController().signal)).toBe('WASD Engine offers no game tools right now.')
  })
})

describe('GameToolCatalog.run', () => {
  it('runs the definition with the rendered text, or with the tool\'s own content', async () => {
    const catalog = new GameToolCatalog(() => [], () => {})
    const plain = { provider: provider('alpha', []), tool: { name: 'alpha_echo', definition: echoDefinition() } }
    expect(await catalog.run(plain, { text: 'hi' }, call())).toEqual({ content: [{ type: 'text', text: 'echo: hi' }] })
    const custom = {
      provider: provider('alpha', []),
      tool: { name: 'alpha_echo', definition: echoDefinition(), content: () => [{ type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }] },
    }
    expect(await catalog.run(custom, { text: 'hi' }, call())).toEqual({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] })
  })

  it('prepares the call, and runs the definition with the prepared arguments as the prepared Agent', async () => {
    const agent = { id: brandString<SessionId>('session-1') } as Agent
    const execute = vi.fn(async (_args: unknown, exec: { agent?: Agent }) => ({ echoed: exec.agent?.id ?? 'none' }))
    const definition = { ...echoDefinition(), execute } as ToolDefinition
    const catalog = new GameToolCatalog(() => [], () => {})
    const result = await catalog.run({
      provider: provider('alpha', []),
      tool: { name: 'alpha_echo', definition, prepare: async args => ({ args: { text: `${typeof args.text === 'string' ? args.text : ''}!` }, agent }) },
    }, { text: 'hi' }, call())
    expect(result).toEqual({ content: [{ type: 'text', text: 'echo: session-1' }] })
    expect(execute).toHaveBeenCalledWith({ text: 'hi!' }, expect.objectContaining({ name: 'echo', agent, arguments: { text: 'hi!' } }))
  })

  it('turns argument, preparation, and tool failures into error results', async () => {
    const catalog = new GameToolCatalog(() => [], () => {})
    const alpha = provider('alpha', [])
    const invalid = await catalog.run({ provider: alpha, tool: { name: 'alpha_echo', definition: echoDefinition() } }, {}, call())
    const [block] = invalid.content
    expect(invalid).toMatchObject({ isError: true, content: [{ type: 'text' }] })
    expect(invalid.content).toHaveLength(1)
    expect(block?.type === 'text' ? block.text : '').toContain('text')
    expect(await catalog.run({ provider: alpha, tool: { name: 'alpha_echo', definition: echoDefinition(), prepare: () => Promise.reject(new Error('no project')) } }, { text: 'x' }, call()))
      .toEqual({ isError: true, content: [{ type: 'text', text: 'no project' }] })
    expect(await catalog.run({ provider: alpha, tool: { name: 'alpha_fail', definition: failing } }, {}, call()))
      .toEqual({ isError: true, content: [{ type: 'text', text: 'the tool failed on purpose' }] })
  })

  it('reports each finished call with its provider, prepared arguments, Session, and whether it failed', async () => {
    const agent = { id: brandString<SessionId>('session-1') } as Agent
    const finished: GameMcpToolResult[] = []
    const catalog = new GameToolCatalog(() => [], () => {}, (result) => { finished.push(result) })
    const alpha = provider('alpha', [])
    await catalog.run({ provider: alpha, tool: { name: 'alpha_echo', definition: echoDefinition(), prepare: async () => ({ args: { text: 'prepared' }, agent }) } }, { text: 'hi' }, call())
    await catalog.run({ provider: alpha, tool: { name: 'alpha_fail', definition: failing } }, {}, call())
    await catalog.run({ provider: alpha, tool: { name: 'alpha_echo', definition: echoDefinition(), prepare: () => Promise.reject(new Error('no project')) } }, { text: 'x' }, call())
    const client = { id: 'claude-code', title: 'Claude Code' }
    expect(finished).toEqual([
      { provider: 'alpha', tool: 'alpha_echo', args: { text: 'prepared' }, client, agent, isError: false },
      { provider: 'alpha', tool: 'alpha_fail', args: {}, client, isError: true },
      { provider: 'alpha', tool: 'alpha_echo', args: { text: 'x' }, client, isError: true },
    ])
  })

  it('ends a call at its tool\'s time limit, as a Session\'s call ends, and tells the agent', async () => {
    const seen: AbortSignal[] = []
    const slow = defineTool({
      name: 'slow',
      description: 'Waits until it is cancelled.',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      timeoutMs: 20,
      execute: async (_args, exec) => {
        seen.push(exec.signal)
        await new Promise<void>((resolve) => { exec.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        throw exec.signal.reason
      },
    })
    const catalog = new GameToolCatalog(() => [], () => {})
    const entry = { provider: provider('alpha', []), tool: { name: 'alpha_slow', definition: slow } }
    expect(await catalog.run(entry, {}, call())).toEqual({ isError: true, content: [{ type: 'text', text: 'tool call timed out after 20ms' }] })
    expect(seen[0]?.aborted).toBe(true)
    // The agent's own cancellation is not a timeout.
    const stopped = new AbortController()
    const running = catalog.run(entry, {}, call({ signal: stopped.signal }))
    stopped.abort(new Error('the agent stopped the call'))
    expect(await running).toEqual({ isError: true, content: [{ type: 'text', text: 'the agent stopped the call' }] })
  })

  it('cuts a very long text and notes the cut', async () => {
    const catalog = new GameToolCatalog(() => [], () => {})
    const result = await catalog.run({ provider: provider('alpha', []), tool: { name: 'alpha_echo', definition: echoDefinition() } }, { text: 'x'.repeat(200_000) }, call())
    const text = (result.content[0] as { text: string }).text
    expect(text.length).toBeLessThan(110_000)
    expect(text).toMatch(/\[output truncated: \d+ more characters\]$/u)
  })
})

describe('GameToolCatalog.owner', () => {
  it('finds the provider of a tool by its server name or by the harness tool that runs it, silently skipping invalid names', () => {
    const warn = vi.fn<(message: string) => void>()
    const catalog = new GameToolCatalog(() => [
      provider('alpha', [
        { name: 'alpha_bad name', definition: echoDefinition('bad_harness_name') },
        { name: 'alpha_echo', definition: echoDefinition('mcp__wasd_alpha__echo') },
      ]),
      provider('beta', [{ name: 'beta_echo', definition: echoDefinition('beta_echo') }]),
    ], warn)
    expect(catalog.owner('alpha_echo')).toEqual({ provider: 'alpha', title: 'ALPHA', tool: 'alpha_echo' })
    expect(catalog.owner('mcp__wasd_alpha__echo')).toEqual({ provider: 'alpha', title: 'ALPHA', tool: 'alpha_echo' })
    expect(catalog.owner('beta_echo')).toEqual({ provider: 'beta', title: 'BETA', tool: 'beta_echo' })
    expect(catalog.owner('bad_harness_name')).toBeUndefined()
    expect(catalog.owner('read')).toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})
