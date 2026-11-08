/**
 * The server side of Session-scoped tool calls. An app MCP server lists
 * {@link SESSION_SCOPE_CAPABILITY} among its experimental capabilities, and the
 * Host's MCP client then names the calling Session in each tool call's `_meta`
 * under {@link SESSION_SCOPE_META_KEY}. The names equal the constants of the
 * same names in `@deepseek-ai/dsh-mcp-client`; they are repeated here so that a
 * server process does not load the MCP client.
 *
 * @module
 */

/** Experimental server capability that asks the Host's MCP client for the calling Session in each tool call. */
export const SESSION_SCOPE_CAPABILITY = 'io.github.wasdengine/session-scope'

/** Key, in a tool call's `_meta`, of the calling Session's id. */
export const SESSION_SCOPE_META_KEY = 'io.github.wasdengine/session'

/** Longest Session id the server accepts; a longer value counts as none. */
const MAX_SESSION_ID_LENGTH = 200

/**
 * The calling Session named in a tool call's `_meta`.
 * @param meta - the request's `_meta`, if any.
 * @returns the Session id, or undefined when the call names none or the value is not a non-empty string of at most 200 characters.
 */
export function sessionOf(meta: { readonly [key: string]: unknown } | undefined): string | undefined {
  const value = meta?.[SESSION_SCOPE_META_KEY]
  return typeof value === 'string' && value !== '' && value.length <= MAX_SESSION_ID_LENGTH ? value : undefined
}
