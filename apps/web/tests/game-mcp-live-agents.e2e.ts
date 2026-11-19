/**
 * Owner-local check of the new game guidance with real agents, skipped unless `WASD_LIVE_AGENTS` names them, separated
 * by commas: `claude` for Claude Code, installed and signed in on this computer. Each agent
 * connects to the MCP server of the shipped Web composition through a configuration of its run alone, gets a user's
 * request for a new game that asks for the plan before the build, and runs until it answers. The check requires that
 * the agent called `create_game_project`, that its own transcript holds the result with the overlay's guidance, and that
 * its messages do not treat the guidance as an injected instruction. Whether the plan follows the guidance is read from
 * the agent's answer next to the answer of a run with `WASD_LIVE_AGENTS_GUIDANCE=off`, which runs the server without
 * the guidance: the words of the guidance also appear in plans made without it. Each run spends the agent's own usage.
 * `WASD_LIVE_AGENTS_OUT` names the folder for each agent's transcript, error output, and answer, and for `summary.json`;
 * by default it is a new temporary folder.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { listeningGameMcp, shippedNewGameGuidance, writeGameMcpPatch } from './game-mcp-support.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

/** A user's request for a new game; asking for the plan first keeps a run short. */
const PROMPT = 'Let\'s make a new game with WASD Engine: a small 3D adventure where you explore a village and talk to the people '
  + 'who live there. Set up the project, then show me your plan for the first playable version before you build anything.'

/** Longest run of one agent, in milliseconds. */
const RUN_TIMEOUT_MS = 20 * 60_000

/** What an agent's messages say when they treat the guidance as an injected instruction. */
const FLAGGED = new RegExp([
  'prompt[- ]injection',
  'injected instruction',
  'instructions? (in|from) (a|the) tool result',
  'ignor(e|ing) (these|those|the) (additional |injected )?instructions',
].join('|'), 'iu')

/** The endpoint of the server and its access token. */
interface Endpoint {
  readonly url: string
  readonly token: string
}

/** What a transcript shows of a run. */
interface Transcript {
  /** The names of the tools the agent called, in order. */
  readonly tools: readonly string[]
  /** The texts of the agent's `create_game_project` results. */
  readonly projectResults: readonly string[]
  /** The agent's messages, its answer last. */
  readonly messages: readonly string[]
}

/** One agent's command line. */
interface AgentCli {
  /** The command on PATH. */
  readonly command: string
  /** The arguments that report the agent's sign-in. */
  readonly statusArgs: readonly string[]
  /**
   * Whether the sign-in report says the agent is signed in.
   * @param output - what the command printed.
   * @param code - its exit code.
   */
  signedIn(output: string, code: number | null): boolean
  /** The command that signs the user in. */
  readonly signIn: string
  /**
   * The arguments of a run against the server, with its configuration written to the run's folder when it needs a file.
   * @param endpoint - the server.
   * @param folder - the run's working folder.
   */
  args(endpoint: Endpoint, folder: string): Promise<string[]>
  /**
   * Read the run's JSON events.
   * @param transcript - what the agent printed, one event per line.
   */
  read(transcript: string): Transcript
}

/** A text block of an MCP result or a Messages API message. */
interface TextBlock {
  readonly type?: string
  readonly text?: string
}

/** A content block of a Claude Code event. */
interface ClaudeBlock extends TextBlock {
  readonly id?: string
  readonly name?: string
  readonly tool_use_id?: string
  readonly content?: string | readonly TextBlock[]
}

/** A line of Claude Code's `stream-json` output. */
interface ClaudeEvent {
  readonly type?: string
  readonly message?: { readonly content?: string | readonly ClaudeBlock[] }
  readonly result?: string
}

function textOf(content: string | readonly TextBlock[] | undefined): string {
  if (typeof content === 'string') return content
  return (content ?? []).map(block => block.text ?? '').join('\n')
}

function jsonLines<T>(transcript: string): T[] {
  return transcript.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line) as T)
}

/** Claude Code tools that a plan needs, by their names in a run whose server is `wasd-engine`. */
const CLAUDE_ALLOWED = ['create_game_project', 'search_game_tools', 'game_addons'].map(tool => `mcp__wasd-engine__${tool}`).join(',')

const AGENTS: Readonly<Record<string, AgentCli>> = {
  claude: {
    command: 'claude',
    statusArgs: ['auth', 'status'],
    signedIn: output => /"loggedIn":\s*true/u.test(output),
    signIn: 'claude auth login',
    async args(endpoint, folder) {
      const config = join(folder, 'mcp.json')
      await writeFile(config, JSON.stringify({ mcpServers: { 'wasd-engine': { type: 'http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } } } }))
      // The plan needs no shell, file edits, or web; the budget stops a run that builds anyway.
      return ['-p', PROMPT, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--mcp-config', config, '--strict-mcp-config',
        '--allowedTools', CLAUDE_ALLOWED, '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch', '--max-budget-usd', '5']
    },
    read(transcript) {
      const named = new Map<string, string>()
      const tools: string[] = []
      const projectResults: string[] = []
      const messages: string[] = []
      for (const event of jsonLines<ClaudeEvent>(transcript)) {
        const content = event.message?.content
        for (const block of typeof content === 'string' ? [] : content ?? []) {
          if (event.type === 'assistant' && block.type === 'text' && block.text !== undefined) messages.push(block.text)
          if (event.type === 'assistant' && block.type === 'tool_use' && block.id !== undefined && block.name !== undefined) {
            named.set(block.id, block.name)
            tools.push(block.name)
          }
          if (event.type === 'user' && block.type === 'tool_result' && named.get(block.tool_use_id ?? '')?.endsWith('__create_game_project') === true) {
            projectResults.push(textOf(block.content))
          }
        }
        if (event.type === 'result' && event.result !== undefined && event.result !== messages.at(-1)) messages.push(event.result)
      }
      return { tools, projectResults, messages }
    },
  },
}

const requested = (process.env.WASD_LIVE_AGENTS ?? '').split(',').map(name => name.trim()).filter(name => name !== '')
const withGuidance = process.env.WASD_LIVE_AGENTS_GUIDANCE !== 'off'

/** The environment of an agent's run: the user's own, without the variables of this test, Node, or a host agent. */
function agentEnv(): NodeJS.ProcessEnv {
  const kept = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']
  return Object.fromEntries(kept.flatMap((name) => {
    const value = process.env[name]
    return value === undefined ? [] : [[name, value]]
  }))
}

/** The agent process that runs now, which teardown stops. */
let running: ChildProcess | undefined
let scaffold: WebScaffold | undefined
let data: string | undefined

/**
 * Run an agent's command to its end.
 * @param command - the command.
 * @param args - its arguments.
 * @param cwd - its working folder.
 * @returns what it printed and its exit code, which is null when the time limit stopped it.
 */
function run(command: string, args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: agentEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    running = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const timer = setTimeout(() => { child.kill('SIGTERM') }, RUN_TIMEOUT_MS)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      running = undefined
      resolve({ stdout, stderr, code })
    })
  })
}

afterEach(async () => {
  running?.kill('SIGTERM')
  running = undefined
  vi.restoreAllMocks()
  await scaffold?.close()
  scaffold = undefined
  if (data !== undefined) await rm(data, { recursive: true, force: true })
  data = undefined
})

it.skipIf(requested.length === 0)(`gives ${requested.join(' and ') || 'the agents'} the new game guidance in the result of create_game_project`, async () => {
  const unknown = requested.filter(name => !(name in AGENTS))
  if (unknown.length > 0) throw new Error(`WASD_LIVE_AGENTS names no known agent: ${unknown.join(', ')}; known: ${Object.keys(AGENTS).join(', ')}`)
  for (const name of requested) {
    const agent = AGENTS[name] as AgentCli
    const status = await run(agent.command, agent.statusArgs, tmpdir())
    if (!agent.signedIn(status.stdout + status.stderr, status.code)) throw new Error(`${agent.command} is not signed in; run \`${agent.signIn}\`, then run this check again.`)
  }
  data = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-live-'))
  const out = process.env.WASD_LIVE_AGENTS_OUT ?? await mkdtemp(join(tmpdir(), 'wasd-live-agents-'))
  await mkdir(out, { recursive: true })
  const shipped = shippedNewGameGuidance()
  scaffold = await launchWebScaffold({ extraOverlayPath: await writeGameMcpPatch(data, withGuidance ? shipped : '') })
  const endpoint = await listeningGameMcp(scaffold.ctx, data)

  const runs = []
  for (const name of requested) {
    const agent = AGENTS[name] as AgentCli
    const folder = await mkdtemp(join(data, `${name}-`))
    const started = Date.now()
    const finished = await run(agent.command, await agent.args(endpoint, folder), folder)
    await writeFile(join(out, `${name}.jsonl`), finished.stdout)
    await writeFile(join(out, `${name}.stderr.txt`), finished.stderr)
    const { tools, projectResults, messages } = agent.read(finished.stdout)
    await writeFile(join(out, `${name}-answer.md`), messages.at(-1) ?? '')
    runs.push({
      agent: name,
      exitCode: finished.code,
      seconds: Math.round((Date.now() - started) / 1000),
      tools,
      delivered: projectResults.some(text => text.includes(shipped)),
      flagged: FLAGGED.test(messages.join('\n\n')),
    })
  }
  await writeFile(join(out, 'summary.json'), `${JSON.stringify({ guidance: withGuidance, prompt: PROMPT, runs }, null, 2)}\n`)

  for (const summary of runs) {
    const where = `${summary.agent}; the transcripts are in ${out}`
    expect(summary.exitCode, where).toBe(0)
    expect(summary.tools.some(tool => tool.endsWith('create_game_project')), `called create_game_project: ${where}`).toBe(true)
    expect(summary.delivered, `the guidance in its create_game_project result: ${where}`).toBe(withGuidance)
    expect(summary.flagged, `the guidance treated as an injected instruction: ${where}`).toBe(false)
  }
}, 2 * 60_000 + requested.length * RUN_TIMEOUT_MS)
