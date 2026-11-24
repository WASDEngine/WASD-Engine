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
    // The Blender, GIMP, and SuperCollider tools take project only with session, so the description sends the path to no
    // tool's project; the call's result says how the game tools take it.
    expect(create?.description).toBe('Create a new game project in WASD Engine: a new folder for the game, which WASD Engine lists among the user\'s '
      + 'game projects. Returns the folder\'s absolute path, where you make the game.')
    expect(Object.keys(create?.inputSchema.properties ?? {})).toEqual(['name', 'location', 'model'])
    expect(create?.inputSchema.properties).toMatchObject({
      name: {
        description: 'Name of the game project, which names its folder and its entry in WASD Engine: one folder name with a visible character, '
          + 'without / \\ : * ? " < > |, control characters, or a trailing period, and neither .git nor a device name that Windows reserves, '
          + 'such as CON or COM1.',
      },
      // The agent names the model it is where it starts a game, so the game's page can credit it.
      model: {
        type: 'string',
        description: 'The full name of the AI model you are, as its maker writes it, with its family and whole version, such as Claude Opus 5.5 '
          + 'for the model id claude-opus-5-5, not Opus 5.5 or Opus 5; never the application you run in, such as Claude Code or Cursor. '
          + 'The released game\'s page credits it for your work on the project.',
      },
    })
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
  const PURPOSE = 'WASD Engine is the game development app open on this computer, and this server gives you its game tools. '
    + 'They exist to raise the quality of the user\'s game beyond what code alone can make: real 3D models, art, sound, tested add-ons, '
    + 'and a game you run and look at. Use them by default, and when you skip a tool or add-on that fits the work, tell the user why; '
    + 'the reason must convince.'

  const WORKING = 'For a new game, create its project with create_game_project and make the game in the folder it returns. '
    + 'Before you first use a plugin\'s tools, read its guide: below, or, if your client cut these '
    + 'instructions short, from search_game_tools with plugin set to its id and no query. '
    + 'call_game_tool calls a tool your tool list lacks. '
    + 'Every tool runs on this computer with the user\'s permissions. Some guides name their own plugin\'s tools without its prefix: add it, '
    + 'as in blender_scene_info. Give each helper agent one task, and each new task to a new helper.'

  const SKIPPING = 'In your plan and your final summary, name the tools and add-ons you use. For each one that fits the work but that you skip, '
    + 'and if you use none, tell the user why. A reason convinces only when the tool cannot do what this game needs or would make it worse; '
    + 'building faster, convenience, matching what you made in code, and not having looked are not reasons.'

  it('opens with an overview: why to use the tools, where the guides are, what to say about skipped tools, then what each provider adds', () => {
    const catalog = new GameToolCatalog(() => [provider('alpha', [], { state: 'ready' }, 'Use alpha_echo first.'), provider('beta', [])], () => {})
    // A harness that cuts the instructions short cuts the end of the plugin list first.
    expect(catalog.overview()).toBe([
      PURPOSE,
      WORKING,
      SKIPPING,
      'What each plugin adds:\n- ALPHA (alpha_*): The alpha tools.\n- BETA (beta_*): The beta tools.',
    ].join('\n\n'))
    // Codex weighs the first 512 characters on their own.
    expect(PURPOSE.length).toBeLessThanOrEqual(512)
  })

  it('appends each provider\'s guide under its title after the overview', () => {
    const catalog = new GameToolCatalog(() => [provider('alpha', [], { state: 'ready' }, 'Use alpha_echo first.'), provider('beta', [])], () => {})
    expect(catalog.instructions()).toBe(`${catalog.overview()}\n\n## ALPHA\n\nUse alpha_echo first.`)
  })

  it('says when no provider offers tools', () => {
    const catalog = new GameToolCatalog(() => [], () => {})
    expect(catalog.overview()).toBe([PURPOSE, WORKING, SKIPPING, 'No plugin offers tools right now.'].join('\n\n'))
    expect(catalog.instructions()).toBe(catalog.overview())
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
    expect(text).not.toContain('guide (')
    expect(text.endsWith('Search with a query to see a tool\'s parameters, or set plugin to read that plugin\'s guide.')).toBe(true)
  })

  it('lists the matching tools with their parameters, best match first', async () => {
    const text = await catalog.search('echo text', undefined, new AbortController().signal)
    expect(text).toContain('alpha_echo (ALPHA): Echo the text back. Use it to check the connection.\n  - text (string, required): Text to echo.')
    expect(text).not.toContain('beta_fail (BETA)')
  })

  it('returns a plugin\'s guide with its tools when the search names the plugin and no words', async () => {
    const guided = new GameToolCatalog(() => [
      provider('alpha', [{ name: 'alpha_echo', definition: echoDefinition() }], { state: 'ready' }, 'Call echo first, then beta_fail.'),
      provider('beta', [], { state: 'starting', message: 'Beta starts.' }, 'Beta guide text.'),
    ], () => {})
    // The heading asks for the prefix only on the plugin's own tools, which the result lists after the guide, so a guide's full
    // name of another plugin's tool, such as beta_fail, stays as it is.
    expect(await guided.search('', 'alpha', new AbortController().signal)).toBe([
      'Plugins:\n- ALPHA (alpha_*, ready, 1 tools): The alpha tools.',
      'ALPHA guide (where it names one of the tools below without the alpha_ prefix, add the prefix):\n\nCall echo first, then beta_fail.',
      'Tools:\n- alpha_echo: Echo the text back.',
      'Search with a query to see a tool\'s parameters.',
    ].join('\n\n'))
    expect(await guided.search('', 'beta', new AbortController().signal)).toContain('Beta guide text.\n\nTools: none right now.')
    expect(await guided.search('echo', 'alpha', new AbortController().signal)).not.toContain('Call echo first.')
    expect(await catalog.search('', 'alpha', new AbortController().signal)).not.toContain('guide (')
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

  it('sends what a tool adds about its failure after the message, and the message alone when that fails', async () => {
    const catalog = new GameToolCatalog(() => [], () => {})
    const alpha = provider('alpha', [])
    const image = { type: 'image' as const, data: 'AAAA', mimeType: 'image/jpeg' }
    const added = vi.fn((_error: unknown, _args: Record<string, unknown>) => [image, { type: 'text' as const, text: 'x'.repeat(100_005) }])
    const failed = await catalog.run({ provider: alpha, tool: { name: 'alpha_fail', definition: failing, failureContent: added } }, {}, call())
    expect(failed).toMatchObject({ isError: true, content: [{ type: 'text', text: 'the tool failed on purpose' }, image, { type: 'text' }] })
    // Added text is bounded as a result's text is.
    expect(failed.content[2]?.type === 'text' ? failed.content[2].text : '').toContain('[output truncated: 5 more characters]')
    expect(added).toHaveBeenCalledWith(expect.objectContaining({ message: 'the tool failed on purpose' }), {})
    const unavailable = () => Promise.reject(new Error('no screenshot'))
    expect(await catalog.run({ provider: alpha, tool: { name: 'alpha_fail', definition: failing, failureContent: unavailable } }, {}, call()))
      .toEqual({ isError: true, content: [{ type: 'text', text: 'the tool failed on purpose' }] })
    // A failed preparation and a successful call send their own content only.
    const echo = { name: 'alpha_echo', definition: echoDefinition(), failureContent: added }
    expect(await catalog.run({ provider: alpha, tool: { ...echo, prepare: () => Promise.reject(new Error('no project')) } }, { text: 'x' }, call()))
      .toEqual({ isError: true, content: [{ type: 'text', text: 'no project' }] })
    expect(await catalog.run({ provider: alpha, tool: echo }, { text: 'hi' }, call())).toEqual({ content: [{ type: 'text', text: 'echo: hi' }] })
    expect(added).toHaveBeenCalledTimes(1)
  })

  it('reports each finished call with its provider, prepared arguments, Session, named model, and whether it failed', async () => {
    const agent = { id: brandString<SessionId>('session-1') } as Agent
    const finished: GameMcpToolResult[] = []
    const catalog = new GameToolCatalog(() => [], () => {}, (result) => { finished.push(result) })
    const alpha = provider('alpha', [])
    await catalog.run({ provider: alpha, tool: { name: 'alpha_echo', definition: echoDefinition(), prepare: async () => ({ args: { text: 'prepared' }, agent }) } }, { text: 'hi' }, call())
    await catalog.run({
      provider: alpha,
      tool: { name: 'alpha_echo', definition: echoDefinition(), prepare: async () => ({ args: { text: 'named' }, model: 'Claude Fable 5.2' }) },
    }, { text: 'hi', model: 'Claude Fable 5.2' }, call())
    await catalog.run({ provider: alpha, tool: { name: 'alpha_fail', definition: failing } }, {}, call())
    await catalog.run({ provider: alpha, tool: { name: 'alpha_echo', definition: echoDefinition(), prepare: () => Promise.reject(new Error('no project')) } }, { text: 'x' }, call())
    const client = { id: 'claude-code', title: 'Claude Code' }
    expect(finished).toEqual([
      { provider: 'alpha', tool: 'alpha_echo', args: { text: 'prepared' }, client, agent, isError: false },
      { provider: 'alpha', tool: 'alpha_echo', args: { text: 'named' }, client, model: 'Claude Fable 5.2', isError: false },
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
