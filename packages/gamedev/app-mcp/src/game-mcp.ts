/**
 * The tools of an app MCP server for agents connected through WASD Engine's MCP server: the tools that the MCP
 * client registered for the server, under the plugin's prefix, with the server's own results, images included.
 * Connected agents and the Session's agent share the one application worker the server runs.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GameMcpContent, GameMcpProviderStatus, GameMcpTool } from '@deepseek-ai/dsh-game-mcp'
import type {} from '@deepseek-ai/dsh-game-mcp'
import type { McpManagedServerStatus } from '@deepseek-ai/dsh-mcp-manager'
import type {} from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

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
 * Offer an app MCP server's tools to connected agents while WASD Engine's MCP server exists.
 * @param ctx - plugin context that injects `mcpManager`.
 * @param serverName - the server's MCP manager name.
 * @param identity - provider id, display name, description, and instructions.
 */
export function offerAppTools(ctx: Context, serverName: string, identity: AppGameMcpIdentity): void {
  const prefix = `mcp__${serverName}__`
  ctx.inject(['gameMcp', 'tools'], (inner) => {
    const tools = (): GameMcpTool[] => inner.tools.definitions()
      .filter(definition => definition.name.startsWith(prefix))
      .map(definition => ({
        name: `${identity.id}_${definition.name.slice(prefix.length)}`,
        definition,
        content: value => appToolContent(value),
      }))
    inner.effect(() => inner.gameMcp.provide({
      ...identity,
      tools,
      status: () => {
        const server = ctx.mcpManager.list().find(candidate => candidate.name === serverName)
        return Promise.resolve(appToolStatus(identity.title, server?.status))
      },
    }), `app-mcp: ${serverName} game MCP tools`)
  })
}
