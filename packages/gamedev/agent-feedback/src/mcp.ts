/**
 * The feedback tool for agents connected through WASD Engine's MCP server: the provider `feedback`, whose
 * `feedback_send` needs no Session and names the calling agent by the client the server identified.
 * @module @deepseek-ai/dsh-agent-feedback/src/mcp
 */
import type { GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { feedbackToolDefinitions, SERVER_SET_PARAMETERS, type FeedbackToolHost } from './tools.ts'

/** How connected agents use the feedback tool. */
export const MCP_INSTRUCTIONS = 'feedback_send sends feedback about WASD Engine and its game tools to the team that makes it: a bug, a missing tool or capability, a confusing description, error, or result, or a suggestion. '
  + 'Use it when WASD Engine\'s tools get in your way or the user asks you to send feedback, once for each problem, and pass model, the full name of the AI model you are, such as Claude Opus 5.5. '
  + 'WASD Engine sends it as the account it is signed in to; leave out the user\'s personal information and secrets.'

/** The names of the parameters the server sets. */
const SERVER_SET: ReadonlySet<string> = new Set(SERVER_SET_PARAMETERS)

/**
 * The tool's JSON Schema without the parameters the server sets.
 * @param definition - the connected agents' definition.
 * @returns the schema connected agents see.
 */
function offeredSchema(definition: ToolDefinition): JsonObject {
  // The definition's parameters are the JSON Schema the harness validates calls against.
  const schema = structuredClone(definition.parameters) as JsonObject
  const properties = Object.fromEntries(Object.entries(schema.properties as JsonObject).filter(([name]) => !SERVER_SET.has(name)))
  const required = Array.isArray(schema.required) ? schema.required.filter(name => typeof name !== 'string' || !SERVER_SET.has(name)) : undefined
  return { ...schema, properties, ...required === undefined ? {} : { required } }
}

/**
 * Offer the feedback tool definition to connected agents.
 * @param definition - the tool, built for connected agents.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition): GameMcpTool {
  return {
    name: definition.name,
    definition,
    inputSchema: offeredSchema(definition),
    readOnly: false,
    prepare(args, call) {
      const offered = Object.fromEntries(Object.entries(args).filter(([name]) => !SERVER_SET.has(name)))
      return Promise.resolve({ args: { ...offered, agent_id: call.client.id, agent_title: call.client.title } })
    },
  }
}

/**
 * The feedback provider of WASD Engine's MCP server.
 * @param host - plugin operations the tool calls.
 * @returns the provider.
 */
export function feedbackMcpProvider(host: FeedbackToolHost): GameMcpProvider {
  const tools = feedbackToolDefinitions(host, 'connected').map(mcpTool)
  return {
    id: 'feedback',
    title: 'Feedback',
    description: 'Send feedback on WASD Engine and its tools to its team.',
    instructions: MCP_INSTRUCTIONS,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
