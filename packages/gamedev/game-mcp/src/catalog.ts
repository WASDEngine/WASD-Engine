/**
 * The server's tools: `search_game_tools` and `call_game_tool`, then every provider's tools in provider order.
 * The catalog lists them as MCP tools, searches them, writes the server instructions, and runs one call: it
 * prepares the call through the tool's provider, runs the tool's harness definition with an execution of its own,
 * and turns the value, or the failure, into an MCP result.
 * @module @deepseek-ai/dsh-game-mcp/src/catalog
 */
import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ContentBlock, ToolCallId } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import type { ToolExecutionToken, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {
  GameMcpCall, GameMcpContent, GameMcpPreparedCall, GameMcpProvider, GameMcpProviderStatus, GameMcpTool, JsonObject,
} from './provider.ts'

/** Name of the search tool. */
export const SEARCH_TOOL = 'search_game_tools'

/** Name of the tool that calls another tool by name. */
export const CALL_TOOL = 'call_game_tool'

/** Pattern of a provider id. */
export const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9]{0,31}$/u

/** Pattern of a tool name after its provider prefix. */
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u

/** Most characters of text in one result; longer text is cut and the cut is noted. */
const MAX_TEXT_CHARS = 100_000

/** Most tools a search lists with their parameters. */
const MAX_DETAILED = 12

/** Longest parameter description quoted in a search result. */
const PARAMETER_CHARS = 160

/** One tool of the catalog with the provider that offers it. */
export interface CatalogTool {
  readonly provider: GameMcpProvider
  readonly tool: GameMcpTool
}

/** A tool as `tools/list` offers it. */
export interface McpToolListing {
  readonly name: string
  readonly title?: string
  readonly description: string
  readonly inputSchema: JsonObject
  readonly annotations?: { readonly readOnlyHint: boolean }
}

/** An MCP tool result. */
export interface McpCallResult {
  readonly content: GameMcpContent[]
  readonly isError?: boolean
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clip(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function boundText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n[output truncated: ${text.length - MAX_TEXT_CHARS} more characters]` : text
}

/** The first sentence of a description. */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/su.exec(text)
  return (match?.[1] ?? text).trim()
}

function descriptionOf(tool: GameMcpTool): string {
  return tool.description ?? tool.definition.description
}

function schemaOf(tool: GameMcpTool): JsonObject {
  // The definition's parameters are the JSON Schema the harness validates the call against.
  return tool.inputSchema ?? (tool.definition.parameters as JsonObject)
}

/**
 * A text that states why a call failed.
 * @param error - the failure.
 * @returns the error's message.
 */
function failureText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The text of rendered content: text blocks as they are, and a notice for each image.
 * @param blocks - rendered content.
 * @returns MCP text content.
 */
function textContent(blocks: readonly ContentBlock[]): GameMcpContent[] {
  return blocks.flatMap((block): GameMcpContent[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') return [{ type: 'text', text: '[image unavailable to connected agents]' }]
    return []
  })
}

/** The tools of the providers, each name once. */
export class GameToolCatalog {
  /**
   * @param providers - the registered providers, in registration order.
   * @param warn - reports a provider tool that the catalog leaves out.
   */
  constructor(
    private readonly providers: () => readonly GameMcpProvider[],
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Collect the tools that the server offers now.
   * @returns every provider tool whose name has its provider's prefix and is not taken, in provider order.
   */
  tools(): CatalogTool[] {
    return this.collect(this.providers())
  }

  private collect(providers: readonly GameMcpProvider[]): CatalogTool[] {
    const tools: CatalogTool[] = []
    const names = new Set<string>([SEARCH_TOOL, CALL_TOOL])
    for (const provider of providers) {
      for (const tool of provider.tools()) {
        if (!tool.name.startsWith(`${provider.id}_`) || !TOOL_NAME_PATTERN.test(tool.name)) {
          this.warn(`game-mcp: ${provider.title} offers the tool name ${JSON.stringify(tool.name)}, which does not start with "${provider.id}_" or is not a valid tool name; it is left out`)
          continue
        }
        if (names.has(tool.name)) {
          this.warn(`game-mcp: ${provider.title} offers the tool ${tool.name} twice; the later one is left out`)
          continue
        }
        names.add(tool.name)
        tools.push({ provider, tool })
      }
    }
    return tools
  }

  /**
   * List the tools for `tools/list`.
   * @returns the MCP tools: the search and call tools, then the provider tools.
   */
  listing(): McpToolListing[] {
    const all = this.providers()
    const providers = all.map(provider => provider.id)
    const titles = all.length === 0 ? '' : ` (${all.map(provider => provider.title).join(', ')})`
    return [
      {
        name: SEARCH_TOOL,
        title: 'Search game tools',
        description: `Search WASD Engine's game development tools${titles} by keyword. Lists the matching tools with their plugin, `
          + 'description, and parameters, and whether each plugin is ready. Without a query, lists every tool.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', description: 'Words to look for in tool names and descriptions, such as "screenshot" or "export texture".' },
            plugin: { type: 'string', enum: providers, description: 'Only the tools of this plugin.' },
          },
        },
        annotations: { readOnlyHint: true },
      },
      {
        name: CALL_TOOL,
        title: 'Call game tool',
        description: `Call one of WASD Engine's game tools by name, with its arguments. Use it for a tool that ${SEARCH_TOOL} lists but your own tool list lacks.`,
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['name'],
          properties: {
            name: { type: 'string', description: `Tool name, as ${SEARCH_TOOL} lists it.` },
            arguments: { type: 'object', description: 'The tool\'s arguments.' },
          },
        },
      },
      ...this.collect(all).map(({ provider, tool }): McpToolListing => ({
        name: tool.name,
        title: `${provider.title}: ${tool.name.slice(provider.id.length + 1).replaceAll('_', ' ')}`,
        description: descriptionOf(tool),
        inputSchema: schemaOf(tool),
        ...tool.readOnly === true ? { annotations: { readOnlyHint: true } } : {},
      })),
    ]
  }

  /**
   * Write the server instructions: what the server offers, then each provider's own instructions.
   * @returns the instructions.
   */
  instructions(): string {
    const providers = this.providers()
    const sections = [
      'WASD Engine is the game development app open on this computer. Its MCP server gives you its game tools: '
        + `${providers.map(provider => `${provider.title} (${provider.id}_* tools): ${provider.description}`).join(' ')} `
        + `${SEARCH_TOOL} lists the tools and whether each plugin is ready, and ${CALL_TOOL} calls a tool by name. `
        + 'Every tool runs on this computer with the user\'s permissions. Where a section below names a tool without its plugin prefix, add the prefix, '
        + 'as in blender_scene_info.',
      ...providers.flatMap(provider => provider.instructions === undefined ? [] : [`## ${provider.title}\n\n${provider.instructions}`]),
    ]
    return sections.join('\n\n')
  }

  /**
   * Search the tools.
   * @param query - words to look for; empty lists every tool.
   * @param plugin - provider id that limits the search.
   * @param signal - cancellation of the readiness reports.
   * @returns the plugins' readiness and the matching tools as text.
   */
  async search(query: string, plugin: string | undefined, signal: AbortSignal): Promise<string> {
    const all = this.providers()
    const providers = all.filter(provider => plugin === undefined || provider.id === plugin)
    if (providers.length === 0) return plugin === undefined ? 'WASD Engine offers no game tools right now.' : `No plugin is named ${JSON.stringify(plugin)}.`
    const tools = this.collect(all).filter(entry => providers.includes(entry.provider))
    const statuses = await Promise.all(providers.map(async (provider) => {
      try {
        return await provider.status(signal)
      } catch (error) {
        signal.throwIfAborted()
        return { state: 'unavailable' as const, message: failureText(error) }
      }
    }))
    const plugins = providers.map((provider, index) => {
      const status = statuses[index] as GameMcpProviderStatus
      const count = tools.filter(entry => entry.provider === provider).length
      return `- ${provider.title} (${provider.id}_*, ${status.state}, ${count} tools): ${provider.description}${status.message === undefined ? '' : ` ${status.message}`}`
    })
    const words = query.toLowerCase().split(/[^a-z0-9]+/u).filter(word => word !== '')
    const header = `Plugins:\n${plugins.join('\n')}`
    if (words.length === 0) {
      const lines = tools.map(({ tool }) => `- ${tool.name}: ${firstSentence(descriptionOf(tool))}`)
      return boundText(`${header}\n\nTools:\n${lines.join('\n')}\n\nSearch with a query to see a tool's parameters.`)
    }
    const scored = tools.map((entry, index) => ({ entry, index, score: score(entry, words) }))
      .filter(candidate => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.index - b.index)
    if (scored.length === 0) return `${header}\n\nNo tool matches ${JSON.stringify(query)}; search with other words or without a query.`
    const detailed = scored.slice(0, MAX_DETAILED).map(({ entry }) => describeTool(entry))
    const rest = scored.slice(MAX_DETAILED).map(({ entry }) => entry.tool.name)
    return boundText([
      header,
      `Tools matching ${JSON.stringify(query)}:\n\n${detailed.join('\n\n')}`,
      ...rest.length === 0 ? [] : [`Also matching: ${rest.join(', ')}.`],
    ].join('\n\n'))
  }

  /**
   * Run one call of a provider tool.
   * @param entry - the tool and its provider.
   * @param args - the agent's arguments.
   * @param call - the calling agent, cancellation, and the Session operations.
   * @returns the MCP result; a failure becomes an error result whose text says why.
   */
  async run(entry: CatalogTool, args: JsonObject, call: GameMcpCall): Promise<McpCallResult> {
    const { tool } = entry
    let prepared: GameMcpPreparedCall
    try {
      prepared = tool.prepare === undefined ? { args } : await tool.prepare(args, call)
    } catch (error) {
      return failureResult(error)
    }
    // The tool's own time limit applies as it does to a Session's call: its execution sees the expiry as cancellation,
    // and the result says the call ran out of time.
    const timeoutMs = tool.definition.timeoutMs
    using limit = timeoutMs === undefined ? undefined : deadline(call.signal, timeoutMs, TIMEOUT_CODE)
    const exec = execution(tool, prepared.args, prepared.agent, limit?.signal ?? call.signal)
    let result: McpCallResult
    try {
      const value = await tool.definition.execute(prepared.args, exec) as JsonValue
      const content = tool.content === undefined
        ? textContent(tool.definition.output.render(prepared.args, value))
        : [...await tool.content(value, prepared.args, exec)]
      result = { content: content.map(block => block.type === 'text' ? { type: 'text', text: boundText(block.text) } : block) }
    } catch (error) {
      result = failureResult(error)
    }
    if (limit !== undefined && timeoutOf(limit.signal, TIMEOUT_CODE) !== undefined) {
      return { isError: true, content: [{ type: 'text', text: `tool call timed out after ${String(timeoutMs)}ms` }] }
    }
    return result
  }
}

/** Code of the deadline a tool's declared time limit sets. */
const TIMEOUT_CODE = 'TOOL_TIMEOUT'

/**
 * The MCP result of a failed call.
 * @param error - the failure.
 * @returns an error result whose text says why.
 */
function failureResult(error: unknown): McpCallResult {
  return { isError: true, content: [{ type: 'text', text: boundText(failureText(error)) }] }
}

/** The execution a tool definition runs one connected agent's call with; its context deferral has no agent loop to reach. */
function execution(tool: GameMcpTool, args: JsonObject, agent: Agent | undefined, signal: AbortSignal): ToolRunContext {
  const callId = brandString<ToolCallId>(`game-mcp-${randomUUID()}`)
  return {
    callId,
    rootCallId: callId,
    name: tool.definition.name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
    signal,
    token: Symbol('game-mcp tool call') as ToolExecutionToken,
    deferContext() {},
    concludeTurn() {},
  }
}

/** How well a tool matches the query words: name words count three, the plugin two, description words one. */
function score({ provider, tool }: CatalogTool, words: readonly string[]): number {
  const name = tool.name.toLowerCase()
  const plugin = `${provider.id} ${provider.title.toLowerCase()}`
  const description = descriptionOf(tool).toLowerCase()
  let total = 0
  for (const word of words) {
    if (name.includes(word)) total += 3
    if (plugin.includes(word)) total += 2
    if (description.includes(word)) total += 1
  }
  return total
}

/** A tool's name, plugin, description, and parameters as a search lists them. */
function describeTool({ provider, tool }: CatalogTool): string {
  const schema = schemaOf(tool)
  const properties = isRecord(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter(value => typeof value === 'string') : [])
  const parameters = Object.entries(properties).map(([name, property]) => {
    const fields = isRecord(property) ? property : {}
    const type = typeof fields.type === 'string' ? fields.type : 'value'
    const description = typeof fields.description === 'string' ? `: ${clip(fields.description, PARAMETER_CHARS)}` : ''
    return `  - ${name} (${type}${required.has(name) ? ', required' : ''})${description}`
  })
  return [`${tool.name} (${provider.title}): ${descriptionOf(tool)}`, ...parameters.length === 0 ? ['  No parameters.'] : parameters].join('\n')
}
