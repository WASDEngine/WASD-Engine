/**
 * Who calls the server. An agent names itself in the client information of its requests: in every request's
 * `_meta` envelope (protocol revision 2026-07-28), or once in its `initialize` request (2025 revisions), which
 * the server remembers by the request's User-Agent because its stateless serving keeps no connection. A request
 * that names no client falls back to the User-Agent's product, then to a generic agent.
 * @module @deepseek-ai/dsh-game-mcp/src/clients
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { GameMcpClient } from './provider.ts'
import type { GameMcpClientView } from './types.ts'

/** Key of the client information in a 2026-07-28 request's `_meta` envelope. */
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo'

/** The identity of a request that names no client. */
export const UNKNOWN_CLIENT: GameMcpClient = { id: 'agent', title: 'Connected agent' }

/** Display names of the agents whose client names differ from how users call them. */
const TITLES: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  'codex': 'Codex',
  'codex-mcp-client': 'Codex',
  'codex-cli-rs': 'Codex',
  'cursor': 'Cursor',
  'cursor-vscode': 'Cursor',
  'gemini-cli': 'Gemini CLI',
  'visual-studio-code': 'VS Code',
}

/** User-Agent products of HTTP libraries, which name no agent. */
const LIBRARY_PRODUCTS: ReadonlySet<string> = new Set([
  'axios', 'curl', 'go-http-client', 'node', 'node-fetch', 'python-httpx', 'python-requests', 'reqwest', 'undici', 'wget',
])

/** Agents the directory remembers. */
const MAX_CLIENTS = 8

/** User-Agent strings whose `initialize` client information the directory remembers. */
const MAX_REMEMBERED = 32

/** Longest client id. */
const MAX_ID_CHARS = 64

/** Longest display name. */
const MAX_TITLE_CHARS = 64

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Normalize a client name to an id.
 * @param name - name as the client sent it.
 * @returns lowercase letters, digits, and single dashes, or undefined when nothing remains.
 */
function clientId(name: string): string | undefined {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, MAX_ID_CHARS)
  return id === '' ? undefined : id
}

/**
 * The identity that MCP client information names.
 * @param info - an `Implementation` object as a request carries it.
 * @returns the identity, or undefined when the object names no client.
 */
function fromInfo(info: JsonValue | undefined): GameMcpClient | undefined {
  if (!isRecord(info) || typeof info.name !== 'string') return undefined
  const id = clientId(info.name)
  if (id === undefined) return undefined
  const given = typeof info.title === 'string' && info.title.trim() !== '' ? info.title.trim() : undefined
  return { id, title: (TITLES[id] ?? given ?? info.name.trim()).slice(0, MAX_TITLE_CHARS) }
}

/** The JSON-RPC messages of a request body: one object, or the objects of a batch. */
function messagesOf(body: JsonValue | undefined): Array<{ [key: string]: JsonValue }> {
  if (Array.isArray(body)) return body.filter(isRecord)
  return isRecord(body) ? [body] : []
}

/** The client information a message's `_meta` envelope carries. */
function envelopeInfo(message: { [key: string]: JsonValue }): JsonValue | undefined {
  const params = message.params
  return isRecord(params) && isRecord(params._meta) ? params._meta[CLIENT_INFO_META_KEY] : undefined
}

/** The client information of an `initialize` request. */
function initializeInfo(message: { [key: string]: JsonValue }): JsonValue | undefined {
  const params = message.params
  return message.method === 'initialize' && isRecord(params) ? params.clientInfo : undefined
}

/**
 * The agent a User-Agent's first product names, such as `claude-code` in `claude-code/2.1.0 (cli)`.
 * @param userAgent - the header value.
 * @returns the identity, or undefined for an HTTP library or an empty header.
 */
function fromUserAgent(userAgent: string): GameMcpClient | undefined {
  const product = /^\s*([^\s/;()]+)/u.exec(userAgent)?.[1]
  if (product === undefined) return undefined
  const id = clientId(product)
  if (id === undefined || LIBRARY_PRODUCTS.has(id)) return undefined
  return { id, title: TITLES[id] ?? product.slice(0, MAX_TITLE_CHARS) }
}

/** The agents seen since the Host started, and the client information each User-Agent sent in `initialize`. */
export class ClientDirectory {
  private readonly seen = new Map<string, GameMcpClientView>()
  private readonly byUserAgent = new Map<string, GameMcpClient>()

  /**
   * Identify the agent of one request and record it as seen.
   * @param body - the parsed JSON body, or undefined for a request without one.
   * @param userAgent - the request's User-Agent header, or an empty string.
   * @param now - milliseconds since the epoch.
   * @returns the agent's identity.
   */
  identify(body: JsonValue | undefined, userAgent: string, now: number): GameMcpClient {
    let client: GameMcpClient | undefined
    for (const message of messagesOf(body)) {
      const initialized = fromInfo(initializeInfo(message))
      if (initialized !== undefined && userAgent !== '') this.remember(userAgent, initialized)
      client ??= fromInfo(envelopeInfo(message)) ?? initialized
    }
    client ??= this.byUserAgent.get(userAgent) ?? fromUserAgent(userAgent) ?? UNKNOWN_CLIENT
    this.seen.delete(client.id)
    this.seen.set(client.id, { id: client.id, title: client.title, lastSeen: now })
    while (this.seen.size > MAX_CLIENTS) this.seen.delete(this.seen.keys().next().value as string)
    return client
  }

  /**
   * List the agents that the setup panel shows.
   * @returns the agents seen since the Host started, most recent first.
   */
  list(): GameMcpClientView[] {
    return [...this.seen.values()].reverse()
  }

  private remember(userAgent: string, client: GameMcpClient): void {
    this.byUserAgent.delete(userAgent)
    this.byUserAgent.set(userAgent, client)
    while (this.byUserAgent.size > MAX_REMEMBERED) this.byUserAgent.delete(this.byUserAgent.keys().next().value as string)
  }
}
