/**
 * The tools of an app MCP server for agents connected through WASD Engine's MCP server: the tools that the MCP
 * client registered for the server, under the plugin's prefix, with the server's own results, images included, and
 * two parameters of their own. A call without `session` names no Session, so connected agents share one application
 * worker among themselves, apart from the worker of each WASD Engine Session. A call with `session`, a name, runs in
 * the connected agent's Session of that name in the game project that `project` names, created on first use, and so
 * in that Session's own worker; agents that work at the same time pass different names. Their instructions say so.
 *
 * @module
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { GameMcpCall, GameMcpContent, GameMcpPreparedCall, GameMcpProviderStatus, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonObject } from './types.ts'

/** How connected agents find an app's tools. */
export interface AppGameMcpIdentity {
  /** Lowercase provider id that prefixes the tool names, such as `blender`. */
  readonly id: string
  /** Display name, such as Blender. */
  readonly title: string
  /** One sentence on what the tools do. */
  readonly description: string
  /** The server's instructions, which name the tools without the prefix. */
  readonly instructions: string
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The MCP content of the canonical value that the MCP client's tool returns: the server's text and image blocks,
 * and a notice for each block of another type.
 * @param value - `{ content, structuredContent? }` as the MCP client keeps it.
 * @returns the content.
 */
export function appToolContent(value: JsonValue): GameMcpContent[] {
  const blocks = isRecord(value) && Array.isArray(value.content) ? value.content : []
  return blocks.flatMap((block): GameMcpContent[] => {
    if (!isRecord(block)) return []
    if (block.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
    if (block.type === 'image' && typeof block.data === 'string' && typeof block.mimeType === 'string') {
      return [{ type: 'image', data: block.data, mimeType: block.mimeType }]
    }
    return [{ type: 'text', text: `[${typeof block.type === 'string' ? block.type : 'unknown'} content omitted]` }]
  })
}

/**
 * The provider readiness of an app MCP server from its manager status.
 * @param title - the app's display name.
 * @param status - the server's status, absent before the manager lists it.
 * @returns the readiness.
 */
export function appToolStatus(title: string, status: McpManagedServerStatus | undefined): GameMcpProviderStatus {
  switch (status?.state) {
    case 'connected':
      return { state: 'ready', message: `The first call starts ${title}.` }
    case undefined:
    case 'connecting':
    case 'reconnecting':
      return { state: 'starting', message: `${title}'s tools appear once its MCP server has started.` }
    case 'waiting-credentials':
    case 'failed': {
      const lastError = 'lastError' in status ? status.lastError : undefined
      return { state: 'unavailable', message: `${title}'s MCP server is not running${lastError === undefined ? '' : `: ${lastError}`}.` }
    }
    case 'closed':
    case 'disabled':
      return { state: 'unavailable', message: `${title}'s MCP server is off.` }
  }
}

/**
 * What connected agents learn about the application sessions they share or keep apart.
 * @param identity - the provider id, such as `blender`, and the application's display name, such as Blender.
 * @returns the note that follows the server's instructions.
 */
export function sessionNote(identity: Pick<AppGameMcpIdentity, 'id' | 'title'>): string {
  const { id, title } = identity
  return `Agents connected through WASD Engine's MCP server, such as you, share one ${title} session among themselves, `
    + 'apart from the sessions of WASD Engine\'s own conversations, so another connected agent can change its state between your calls. '
    + `Agents that work at the same time, such as the subagents of one session, each get a ${title} session of their own by passing `
    + `session, a name such as their task, to every ${id}_* call, and project, the absolute path of the game project folder, to the first.`
}

/**
 * The parameters that every offered tool adds to the server's own; the instructions say more, once.
 * @param identity - the application's display name.
 * @returns the JSON Schema properties `session` and `project`.
 */
function sessionParameters(identity: Pick<AppGameMcpIdentity, 'title'>): JsonObject {
  const { title } = identity
  return {
    session: {
      type: 'string',
      description: `Name of a ${title} session of your own, for agents that work at the same time. Default: the ${title} session that connected `
        + 'agents share.',
    },
    project: { type: 'string', description: 'With session: absolute path of its game project folder. Default: your previous one.' },
  }
}

/**
 * The key of an agent's most recent project for one Session name.
 * @param client - the agent's id.
 * @param session - the Session name as the call gave it.
 * @returns the key; names that differ only in case or surrounding spaces share it, as they share the Session.
 */
function projectKey(client: string, session: string): string {
  return `${client}\n${session.trim().toLowerCase()}`
}

/**
 * The input schema of one offered tool: the server's schema with `session` and `project` added.
 * @param definition - the tool that the MCP client registered.
 * @param identity - the application's display name.
 * @returns the schema.
 */
function offeredSchema(definition: ToolDefinition, identity: Pick<AppGameMcpIdentity, 'title'>): JsonObject {
  // The MCP client registers the server's input schema, a JSON object schema, as the definition's parameters.
  const schema = definition.parameters as JsonObject
  const properties = isRecord(schema.properties) ? schema.properties : {}
  return { ...schema, properties: { ...properties, ...sessionParameters(identity) } }
}

/**
 * Choose the Session that one call runs in, and remove `session` and `project` from its arguments.
 * @param args - the agent's arguments.
 * @param call - the calling agent and the Session operations.
 * @param title - the application's display name.
 * @param projects - each agent's most recent project under its id, and for each Session name under {@link projectKey}.
 * @returns the server's arguments, and the Agent of the named Session for a call with `session`.
 * @throws Error that tells the agent what to pass, for a `session` or `project` that is not a string, a `project`
 *   without `session`, a first `session` call without `project`, or a relative `project`; the errors of `call.session`.
 */
async function prepareCall(
  args: JsonObject, call: GameMcpCall, title: string, projects: Map<string, string>,
): Promise<GameMcpPreparedCall> {
  const { session, project, ...rest } = args
  if (session !== undefined && typeof session !== 'string') throw new Error('session must be a string.')
  if (project !== undefined && typeof project !== 'string') throw new Error('project must be a string.')
  if (session === undefined) {
    if (project === undefined) return { args: rest }
    throw new Error(`project needs session: pass session, a name for a ${title} session of your own, or leave project out to use the `
      + `${title} session that connected agents share.`)
  }
  const key = projectKey(call.client.id, session)
  // A name's first call without project uses the agent's most recent project under any name.
  const folder = project ?? projects.get(key) ?? projects.get(call.client.id)
  if (folder === undefined) throw new Error('Pass project, the absolute path of the game project folder, with your first call that names a session.')
  if (!isAbsolute(folder)) throw new Error(`project must be an absolute path, got ${JSON.stringify(folder)}.`)
  const agent = await call.session(folder, session)
  projects.set(key, folder)
  projects.set(call.client.id, folder)
  return { args: rest, agent }
}

/**
 * Offer an app MCP server's tools to connected agents while WASD Engine's MCP server exists. Each tool takes the
 * server's parameters, which must not include `session` or `project`, and those two, which choose the Session whose
 * worker runs the call (see the module documentation).
 * @param ctx - plugin context that injects `mcpManager`.
 * @param serverName - the server's MCP manager name.
 * @param identity - provider id, display name, description, and instructions.
 */
export function offerAppTools(ctx: Context, serverName: string, identity: AppGameMcpIdentity): void {
  const prefix = `mcp__${serverName}__`
  const projects = new Map<string, string>()
  ctx.inject(['gameMcp', 'tools'], (inner) => {
    const tools = (): GameMcpTool[] => inner.tools.definitions()
      .filter(definition => definition.name.startsWith(prefix))
      .map(definition => ({
        name: `${identity.id}_${definition.name.slice(prefix.length)}`,
        definition,
        inputSchema: offeredSchema(definition, identity),
        prepare: async (args, call) => await prepareCall(args, call, identity.title, projects),
        content: value => appToolContent(value),
      }))
    inner.effect(() => inner.gameMcp.provide({
      ...identity,
      instructions: `${identity.instructions}\n\n${sessionNote(identity)}`,
      tools,
      status: () => {
        const server = ctx.mcpManager.list().find(candidate => candidate.name === serverName)
        return Promise.resolve(appToolStatus(identity.title, server?.status))
      },
    }), `app-mcp: ${serverName} game MCP tools`)
  })
}
