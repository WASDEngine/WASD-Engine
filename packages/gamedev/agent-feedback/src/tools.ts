/**
 * The model-facing feedback tool: `feedback_send` sends feedback about WASD Engine to the team that makes it, as the
 * account WASD Engine is signed in to. Before it is sent, the message and its subject lose the user's home folder,
 * account name, email addresses, and anything that looks like a key or token (`scrub.ts`), and the result shows every
 * field as the site received it. One set of definitions serves one surface: the Session's own agent, whose model the
 * feedback names, or agents connected through WASD Engine's MCP server, which name their model themselves and whose
 * client the server's `prepare` adds as `agent_id` and `agent_title`, parameters their tool listing leaves out.
 * @module @deepseek-ai/dsh-agent-feedback/src/tools
 */
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { scrubFeedback, type UserTraces } from './scrub.ts'
import type { FeedbackKind, FeedbackReport, ReportingAgent, SentFeedback } from './types.ts'

/** The kinds of feedback, in the order the tool lists them. */
export const FEEDBACK_KINDS = ['bug', 'missing_feature', 'confusing', 'suggestion'] as const satisfies readonly FeedbackKind[]

/** Longest message, as the site takes it. */
export const MAX_MESSAGE_CHARACTERS = 4000

/** Longest `about`, as the site takes it. */
export const MAX_ABOUT_CHARACTERS = 120

/** Longest model name, as the site takes it. */
export const MAX_MODEL_CHARACTERS = 80

/** WASD Engine's own agent, as feedback and usage reports name it. */
export const WASD_ENGINE_AGENT: ReportingAgent = { connected: false, id: 'wasd-engine', title: 'WASD Engine' }

/** A connected agent's call that the server did not identify. */
const UNKNOWN_AGENT: ReportingAgent = { connected: true, id: 'agent', title: 'Connected agent' }

/** How a result names each kind. */
const KIND_NAMES: Readonly<Record<FeedbackKind, string>> = {
  bug: 'bug report',
  missing_feature: 'request for a missing feature',
  confusing: 'report of something confusing',
  suggestion: 'suggestion',
}

/** Which callers one set of definitions serves. */
export type FeedbackSurface = 'session' | 'connected'

/** What the tool needs from the plugin. */
export interface FeedbackToolHost {
  /**
   * Send the feedback to the WASD Engine site.
   * @param feedback - the feedback.
   * @param signal - cancellation.
   * @returns every field the site received.
   * @throws an error whose message tells the agent why it was not sent and what to do.
   */
  send(feedback: FeedbackReport, signal: AbortSignal): Promise<SentFeedback>
  /** The user's home folder and account name, which feedback never carries. */
  readonly traces: UserTraces
  /** Whether this computer's file system ignores the case of paths, as on macOS and Windows. */
  readonly pathsIgnoreCase: boolean
  /**
   * The AI model a Session's agent runs on.
   * @param exec - the call's execution, with the Session's agent.
   * @returns the model's display name, or undefined without one.
   */
  sessionModel(exec: ToolRunContext): Promise<string | undefined>
}

const DESCRIPTION = 'Send feedback about WASD Engine itself to the team that makes it. Use it when WASD Engine gets in your way: one of its tools fails or does the wrong thing (bug), a tool, option, or capability you needed is missing (missing_feature), a tool\'s description, error, or result is unclear or wrong (confusing), or you see a change that would make WASD Engine better for making games (suggestion); and when the user asks you to send feedback. Say what you tried, what happened, and what you expected or needed, and name the tools involved, so the team can act on it without asking you. Send each problem once. Leave out the user\'s personal information and secrets, and the user\'s game content beyond what the problem needs. It is not for problems in the user\'s own game. The team reads it but does not reply, and nothing changes right away, so carry on with the user\'s task.'

function cut(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit).trimEnd() : text
}

/** The parameters of every surface. */
const PARAMETERS = {
  kind: { type: 'string', enum: [...FEEDBACK_KINDS], required: true, description: 'bug, missing_feature, confusing, or suggestion.' },
  message: { type: 'string', required: true, description: `What you tried, what happened, and what you expected or needed, at most ${MAX_MESSAGE_CHARACTERS} characters.` },
  about: { type: 'string', description: `The tool or part of WASD Engine it concerns, such as godot_run or the Blender tools, at most ${MAX_ABOUT_CHARACTERS} characters.` },
} as const

/** The parameters of connected agents: their model, and their client, which the server sets. */
const CONNECTED_PARAMETERS = {
  ...PARAMETERS,
  model: { type: 'string', description: 'The name of the AI model you are, such as Claude Opus 5.5.' },
  agent_id: { type: 'string', description: 'Set by WASD Engine\'s MCP server.' },
  agent_title: { type: 'string', description: 'Set by WASD Engine\'s MCP server.' },
} as const

/** Parameters that WASD Engine's MCP server sets and leaves out of the connected agents' tool listing. */
export const SERVER_SET_PARAMETERS = ['agent_id', 'agent_title'] as const

const STRING = { type: 'string', required: true } as const

const OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...FEEDBACK_KINDS], required: true },
      about: STRING,
      sent: {
        type: 'object',
        required: true,
        additionalProperties: false,
        description: 'Every field the WASD Engine site received.',
        properties: {
          kind: { type: 'string', enum: [...FEEDBACK_KINDS], required: true },
          message: STRING,
          about: STRING,
          connected: { type: 'boolean', required: true },
          agent: STRING,
          agent_title: STRING,
          model: STRING,
          app_version: STRING,
          platform: STRING,
        },
      },
      redacted: { type: 'boolean', required: true, description: 'Whether personal details or secrets were replaced before sending.' },
    },
  },
  render: (_args: unknown, value: FeedbackValue) => [{ type: 'text' as const, text: formatFeedback(value) }],
} as const

/** The value of `feedback_send`. */
interface FeedbackValue {
  readonly kind: FeedbackKind
  readonly about: string
  readonly sent: SentFeedback
  readonly redacted: boolean
}

/**
 * The model-facing text of sent feedback: what was sent and to whom, then every field the site received.
 * @param value - the call's value.
 * @returns the text.
 */
export function formatFeedback(value: FeedbackValue): string {
  const { sent } = value
  return [
    `Sent your ${KIND_NAMES[value.kind]}${value.about === '' ? '' : ` about ${value.about}`} to the WASD Engine team. They read it but do not reply here, so carry on with the user's task.`,
    ...value.redacted ? ['Personal details and secrets in it were replaced before sending: the home folder with ~, the user\'s account name with <user>, email addresses with <email>, and keys or tokens with <redacted>.'] : [],
    'What was sent:',
    `kind: ${sent.kind}`,
    `about: ${sent.about === '' ? '(nothing)' : sent.about}`,
    `agent: ${sent.agent_title} (${sent.agent})`,
    `model: ${sent.model === '' ? '(unknown)' : sent.model}`,
    `app version: ${sent.app_version === '' ? '(none)' : sent.app_version}`,
    `platform: ${sent.platform}`,
    'message:',
    sent.message,
  ].join('\n')
}

/** Check one call's feedback, take the user's traces and secrets out of it, and send it. */
async function send(
  host: FeedbackToolHost,
  args: { readonly kind: string; readonly message: string; readonly about?: string | undefined },
  agent: ReportingAgent,
  model: string | undefined,
  signal: AbortSignal,
): Promise<FeedbackValue> {
  const written = args.message.trim()
  if (written === '') throw new Error('message must not be empty.')
  if (written.length > MAX_MESSAGE_CHARACTERS) throw new Error(`message must be at most ${MAX_MESSAGE_CHARACTERS} characters; it has ${written.length}.`)
  const writtenAbout = (args.about ?? '').trim()
  if (writtenAbout.length > MAX_ABOUT_CHARACTERS) throw new Error(`about must be at most ${MAX_ABOUT_CHARACTERS} characters; it has ${writtenAbout.length}.`)
  const scrubbed = scrubFeedback(written, host.traces, host.pathsIgnoreCase)
  const scrubbedAbout = scrubFeedback(writtenAbout, host.traces, host.pathsIgnoreCase)
  // Placeholders can be longer than what they replace, so the cleaned text is held to the site's limits again.
  const message = cut(scrubbed, MAX_MESSAGE_CHARACTERS)
  const about = cut(scrubbedAbout, MAX_ABOUT_CHARACTERS)
  // The parameter schema's enum admits only the kinds.
  const kind = args.kind as FeedbackKind
  const sent = await host.send({ kind, message, about, agent, model: cut((model ?? '').trim(), MAX_MODEL_CHARACTERS) }, signal)
  return { kind, about, sent, redacted: scrubbed !== written || scrubbedAbout !== writtenAbout }
}

/**
 * Build the feedback tool definitions.
 * @param host - plugin operations the tool calls.
 * @param surface - the callers these definitions serve.
 * @returns the definitions, not registered.
 */
export function feedbackToolDefinitions(host: FeedbackToolHost, surface: FeedbackSurface): ToolDefinition[] {
  if (surface === 'session') {
    return [defineTool({
      name: 'feedback_send',
      description: DESCRIPTION,
      parameters: PARAMETERS,
      output: OUTPUT,
      isConcurrencySafe: () => true,
      execute: async (args, exec) => await send(host, args, WASD_ENGINE_AGENT, await host.sessionModel(exec), exec.signal),
    })]
  }
  return [defineTool({
    name: 'feedback_send',
    description: DESCRIPTION,
    parameters: CONNECTED_PARAMETERS,
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const agent = args.agent_id === undefined
        ? UNKNOWN_AGENT
        : { connected: true, id: args.agent_id, title: args.agent_title ?? args.agent_id }
      return await send(host, args, agent, args.model, exec.signal)
    },
  })]
}
