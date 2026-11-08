/**
 * Session scope of MCP tool calls, a WASD Engine extension: a server that lists
 * {@link SESSION_SCOPE_CAPABILITY} among its experimental capabilities receives,
 * in the `_meta` of each tool call that an agent makes, the id of that agent's
 * Session under {@link SESSION_SCOPE_META_KEY}. Such a server can keep separate
 * state for each Session, such as one application worker per Session. A server
 * that does not list the capability never receives Session ids, and a call made
 * without an agent carries none.
 *
 * @module
 */

/** Experimental server capability that asks for the calling Session's id in each tool call. */
export const SESSION_SCOPE_CAPABILITY = 'io.github.wasdengine/session-scope'

/** Key, in a tool call's `_meta`, of the calling Session's id. */
export const SESSION_SCOPE_META_KEY = 'io.github.wasdengine/session'
