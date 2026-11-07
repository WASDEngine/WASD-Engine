/** JSON types shared by worker requests and replies and by app MCP server options. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

export type { JsonValue }

/** A JSON object: the parameters of a worker request, or the options of an app MCP server. */
export type JsonObject = { [key: string]: JsonValue }
