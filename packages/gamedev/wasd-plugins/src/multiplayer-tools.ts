
import { isAbsolute } from 'node:path'
import type { GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { GodotInstancesReport, GodotInstancesRequest } from '@deepseek-ai/dsh-godot'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { LocalizedPrompt } from './multiplayer-prompts.ts'
import type { SiteAccess } from './site-client.ts'
import { gameTools } from './multiplayer-game-tools.ts'
import { serverTools } from './server-tools.ts'

/** The tools' names, in the order the agent sees them. */
export const MULTIPLAYER_TOOLS = [
  'wasd_multiplayer_guide', 'wasd_multiplayer_setup', 'wasd_multiplayer_test', 'wasd_lobby_stats', 'wasd_server_plans',
  'wasd_server_create', 'wasd_server_deploy', 'wasd_server_status', 'wasd_server_logs', 'wasd_server_manage',
  'wasd_server_change',
] as const

/** How the user answered an approval prompt. */
export type ApprovalAnswer = 'approved' | 'declined' | 'cancelled' | 'unavailable'

/** What the tools need from the plugin. */
export interface MultiplayerToolHost {
  /**
   * The project folder of one call.
   * @param requested - the folder the call names, or undefined for the nearest project.
   * @param exec - the call's execution.
   * @returns the absolute folder holding `project.godot`.
   */
  project(requested: string | undefined, exec: ToolRunContext): Promise<string>
  /** @returns the signed-in site, or undefined while the app is signed out. */
  access(): Promise<SiteAccess | undefined>
  /** @returns the site's origin, also while signed out. */
  siteOrigin(): Promise<string>
  /** HTTP client of the site calls. */
  readonly fetch: typeof fetch
  /**
   * Run a group of headless instances of a project.
   * @param request - the project, the instances, and the deadline.
   * @param signal - cancellation.
   * @returns how each instance ended.
   */
  runInstances(request: GodotInstancesRequest, signal: AbortSignal): Promise<GodotInstancesReport>
  /** Absolute folder of the WASD Multiplayer add-on this package ships. */
  readonly addonSource: string
  /**
   * Run a change of a project's files after the project's exports and releases that started before it, and before
   * those that start later, so a setup never rewrites `wasd_multiplayer.cfg` while a release writes it. Without it the
   * change runs at once.
   * @param projectDir - absolute project folder.
   * @param signal - cancellation of the wait.
   * @param change - the change.
   * @returns the change's result.
   */
  readonly exclusive?: <T>(projectDir: string, signal: AbortSignal, change: () => Promise<T>) => Promise<T>
}

/** How one surface asks the user and shows a confirmation page. */
export interface MultiplayerSurface {
  /** `app`: a Session of WASD Engine; `mcp`: an agent connected through WASD Engine's MCP server. */
  readonly channel: 'app' | 'mcp'
  /** Description of the `project` parameter. */
  readonly projectDescription: string
  /**
   * Ask the user to approve a purchase, a change, or a restore.
   * @param exec - the call's execution.
   * @param toolName - the calling tool.
   * @param prompt - the question.
   * @returns how the user answered.
   */
  approve(exec: ToolRunContext, toolName: string, prompt: LocalizedPrompt): Promise<ApprovalAnswer>
  /**
   * Show the user a confirmation page.
   * @param url - the page.
   * @param exec - the call's execution.
   * @returns whether a window opened it.
   */
  openLink(url: string, exec: ToolRunContext): Promise<boolean>
}

/**
 * Build the multiplayer tool definitions of one surface.
 * @param host - plugin operations the tools call.
 * @param surface - how the surface asks the user and shows a confirmation page.
 * @returns the definitions, not registered.
 */
export function multiplayerToolDefinitions(host: MultiplayerToolHost, surface: MultiplayerSurface): ToolDefinition[] {
  return [...gameTools(host, surface), ...serverTools(host, surface)]
}

/** The `multiplayer` system prompt section of the Session's agent. */
export const MULTIPLAYER_PROMPT = `# Multiplayer

WASD Engine puts Godot games online two ways, and players sign in with a WASD Engine account in both. Player-hosted is free: one player's browser hosts and friends join with a code, which suits co-op and party games of 2 to 8 players. A dedicated server runs the game's server build for a monthly price by size and suits persistent worlds and larger games: it sleeps while nobody plays and wakes when a player joins, and on the larger sizes its owner can keep it on (Always on) so the world keeps going.

When the user wants multiplayer:
1. Call wasd_multiplayer_guide first and show the user its comparison with the costs before setting anything up; then call wasd_multiplayer_setup with the mode they choose, and wasd_multiplayer_test once the game connects players.
2. State the monthly price and what it includes before suggesting a server; when wasd_server_plans lists free servers of a size left for the account, a server of that size is free while one is left when the user confirms, so say that instead.
3. Let the user choose the size from wasd_server_plans; never pick one for them. wasd_server_create and wasd_server_change only open a page where the user confirms on the WASD Engine site; nothing is charged before that.
4. Explain that the owner gets emails at 70%, 90%, and 100% of a server's monthly bandwidth, and that at 100% the server stops until its next billing month; suggest a smaller size when a server is mostly idle.
5. When the world must keep going while nobody plays, tell the user to turn on Always on for the server on the WASD Engine site; only the sizes wasd_server_plans names offer it.`

/** The multiplayer part of the `wasd` provider's MCP instructions. */
export const MULTIPLAYER_MCP_INSTRUCTIONS = 'Multiplayer: a game goes online player-hosted, free, where one player\'s browser hosts and friends join with a code, or on a dedicated server that WASD Engine runs for a monthly price by size; players sign in with a WASD Engine account in both. Call wasd_multiplayer_guide first and show your user the comparison with its costs before wasd_multiplayer_setup. State the monthly price and what it includes before suggesting a server, or that it is free while one is left when your user confirms, if wasd_server_plans lists free servers of that size left for your user\'s account, and let your user choose the size from wasd_server_plans; never pick one. wasd_server_create and wasd_server_change return a page where your user confirms on the WASD Engine site, and nothing is charged before that: give them the page. Explain that the owner gets emails at 70%, 90%, and 100% of a server\'s monthly bandwidth and that at 100% the server stops until its next billing month. Pass confirm: true to wasd_server_manage restore only after your user agreed to replace the world.'

/** Description of the `project` parameter for agents connected through WASD Engine's MCP server. */
const MCP_PROJECT = 'Absolute path of the folder that holds project.godot.'

/** How connected agents confirm: their own user, then the site's confirmation page; WASD Engine opens no page for them. */
export const MCP_SURFACE: MultiplayerSurface = {
  channel: 'mcp',
  projectDescription: MCP_PROJECT,
  // A connected agent's purchase waits for the site's confirmation page, and its restore for `confirm: true`.
  approve: () => Promise.resolve('approved'),
  openLink: () => Promise.resolve(false),
}

/** The tools that only read. */
const READ_ONLY: ReadonlySet<string> = new Set(['wasd_multiplayer_guide', 'wasd_lobby_stats', 'wasd_server_plans', 'wasd_server_status', 'wasd_server_logs'])

/** The tools whose `project` a connected agent may leave out. */
const PROJECT_OPTIONAL: ReadonlySet<string> = new Set(['wasd_multiplayer_guide', 'wasd_server_plans'])

/** The `confirm` parameter of `wasd_server_manage` for connected agents. */
const CONFIRM_PARAMETER = { type: 'boolean', description: 'true only once your user agreed to replace the server\'s world with the backup; needed for restore.' } as const

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Offer the multiplayer tools to agents connected through WASD Engine's MCP server, which name projects by absolute
 * path, confirm restores with `confirm: true`, and receive a purchase's confirmation page as a URL elicitation where
 * their client supports it.
 * @param definitions - the definitions built with {@link MCP_SURFACE}.
 * @returns the server tools.
 */
export function multiplayerMcpTools(definitions: readonly ToolDefinition[]): GameMcpTool[] {
  return definitions.map((definition): GameMcpTool => {
    const { properties } = definition.parameters as { readonly properties: Readonly<Record<string, JsonObject>> }
    const optional = PROJECT_OPTIONAL.has(definition.name)
    const manage = definition.name === 'wasd_server_manage'
    const paid = definition.name === 'wasd_server_create' || definition.name === 'wasd_server_change'
    return {
      name: definition.name,
      definition,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { ...properties, project: { type: 'string', description: MCP_PROJECT }, ...manage ? { confirm: CONFIRM_PARAMETER } : {} },
        required: [...optional ? [] : ['project'], ...(definition.parameters as { readonly required?: readonly string[] }).required ?? []]
          .filter((name, index, all) => all.indexOf(name) === index),
      },
      readOnly: READ_ONLY.has(definition.name),
      prepare(args) {
        const project = args.project
        if (project === undefined ? !optional : typeof project !== 'string' || !isAbsolute(project)) return Promise.reject(new Error('project must be an absolute path.'))
        if (!manage) return Promise.resolve({ args })
        const { confirm, ...rest } = args
        if (rest.action === 'restore' && confirm !== true) {
          return Promise.reject(new Error('Pass confirm: true only after your user agreed to replace the server\'s world with the backup; nothing was restored.'))
        }
        return Promise.resolve({ args: rest })
      },
      ...paid
        ? {
          confirmation: (value: JsonValue) => isRecord(value) && value.status === 'awaiting_confirmation' && typeof value.confirm_url === 'string'
            ? { url: value.confirm_url, message: typeof value.confirm_message === 'string' ? value.confirm_message : 'Confirm on the WASD Engine site.' }
            : undefined,
        }
        : {},
    }
  })
}
