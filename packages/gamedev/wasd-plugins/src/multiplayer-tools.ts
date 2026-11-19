/**
 * The multiplayer tools: a Godot game goes online player-hosted, free, where one player's browser hosts and WASD
 * Engine introduces the players, or on a dedicated server that WASD Engine runs for a monthly price by size. The tools
 * explain both with the site's live prices and the free servers WASD Engine gave the account, which cost nothing, set a
 * project up with the WASD Multiplayer add-on, test it on this computer, and manage the game's servers. A tool that
 * would cost money or replace a world never does it by itself: `wasd_server_create` and `wasd_server_change` return a
 * page where the user confirms on the site, and in a Session WASD Engine's approval prompt asks first, as it does
 * before `wasd_server_manage` restores a backup. Each result carries `for_user`, plain text the agent passes on. One
 * builder makes the Session's definitions, which ask through the approval prompt and open the confirmation page in a
 * window, and those of connected agents, which name projects by absolute path and confirm through their own user.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-tools
 */
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import type { GodotInstancesReport, GodotInstancesRequest } from '@deepseek-ai/dsh-godot'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { formatPrice, MultiplayerApi, MultiplayerError, type ServerPlans, type ServerRecord, type ServerSize } from './multiplayer-api.ts'
import {
  ADDON_DIR, hasMultiplayerAddon, MULTIPLAYER_MODES, pluginVersion, readMultiplayerConfig, replaceFolder, withMultiplayerAddon,
  writeMultiplayerConfig,
} from './multiplayer-project.ts'
import {
  createFreePrompt, createPrompt, deletePrompt, resizePrompt, restorePrompt, sizeLabels, type DeletedServer, type LocalizedPrompt,
  type PromptSize,
} from './multiplayer-prompts.ts'
import {
  clientConnected, estimateSizes, freePort, instanceProblems, instanceStats, planTest, readTestRecord, saveTestRecord, testRecord,
  type SizeEstimate,
} from './multiplayer-test.ts'
import { linkedGame, type SiteAccess } from './release.ts'
import { writeWhole } from './state.ts'

/** The tools' names, in the order the agent sees them. */
export const MULTIPLAYER_TOOLS = [
  'wasd_multiplayer_guide', 'wasd_multiplayer_setup', 'wasd_multiplayer_test', 'wasd_lobby_stats', 'wasd_server_plans',
  'wasd_server_create', 'wasd_server_deploy', 'wasd_server_status', 'wasd_server_logs', 'wasd_server_manage',
  'wasd_server_change',
] as const

/** Most players a player-hosted session takes: the host's browser connects to every other player. */
export const MAX_LOBBY_PLAYERS = 16

/** Most players one dedicated server may name in the add-on's configuration. */
export const MAX_SERVER_PLAYERS = 500

/** Time limit of one `wasd_multiplayer_test` call, its instances' start, run, and stop included. */
const TEST_TIMEOUT_MS = 5 * 60_000

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

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const
const JSON_VALUE = { type: 'json', required: true } as const
const FOR_USER = { type: 'string', required: true, description: 'Plain text to pass on to the user.' } as const
const SERVER = { type: 'string', description: 'Server id from wasd_server_status. Default: the game\'s only server.' } as const

function text(value: { readonly for_user: string }, extra: readonly string[] = []): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: [value.for_user, ...extra].join('\n') }]
}

/** The site's host, for prompts that name where the user confirms. */
function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url
}

/** The signed-in API, or the error that asks the user to sign in. */
async function signedIn(
  host: MultiplayerToolHost, signal: AbortSignal,
): Promise<{ readonly api: MultiplayerApi; readonly access: SiteAccess }> {
  const access = await host.access()
  if (access === undefined) throw new MultiplayerError('WASD Engine is signed out, and servers belong to a WASD Engine account. Ask the user to sign in to WASD Engine, then try again.')
  return { api: new MultiplayerApi(access, host.fetch, signal), access }
}

/** The public sizes, read with the sign-in when there is one. */
async function readPlans(host: MultiplayerToolHost, signal: AbortSignal): Promise<ServerPlans> {
  const access = await host.access() ?? { origin: await host.siteOrigin(), token: '' }
  return await new MultiplayerApi(access, host.fetch, signal).plans()
}

/** The signed-in account's game of the project on its site, or the error that asks for a first release. */
async function releasedGame(projectDir: string, access: SiteAccess): Promise<{ readonly id: string; readonly title: string }> {
  const game = await linkedGame(projectDir, access.origin, access.account)
  if (game === undefined) {
    throw new MultiplayerError('This project has no game on WASD Engine yet. Release it once with wasd_release_game: servers and lobby statistics belong to a released game, and each release uploads the server build.')
  }
  return { id: game.id, title: game.title }
}

/** The server a call names, or the game's only one. */
async function chooseServer(api: MultiplayerApi, gameId: string, requested: string | undefined): Promise<ServerRecord> {
  if (requested !== undefined) {
    const server = await api.server(requested)
    if (server.game_id !== gameId) throw new MultiplayerError(`The server ${requested} belongs to another game; call wasd_server_status for this game's servers.`)
    return server
  }
  const servers = (await api.servers(gameId)).filter(server => server.state !== 'deleted')
  if (servers.length === 1) return servers[0] as ServerRecord
  if (servers.length === 0) throw new MultiplayerError('This game has no servers. wasd_server_plans lists the sizes; create one with wasd_server_create once the user picks a size.')
  throw new MultiplayerError(`This game has ${String(servers.length)} servers; pass server, one of: ${servers.map(server => `${server.id} (${server.name})`).join(', ')}.`)
}

/** How servers sleep, for a site that does not say: older sites ran every server all the time. */
const SLEEP_FALLBACK = 'A server may sleep while nobody plays and wake when a player joins.'

/**
 * A server state as people read it.
 * @param state - the state the site reports, such as `stopped_bandwidth`.
 * @returns the words for it; a state this package does not know as the site wrote it.
 */
export function describeState(state: string): string {
  switch (state) {
    case 'awaiting_confirmation': return 'waiting for the user to confirm on the site'
    case 'waiting_for_build': return 'waiting for a release with a server build'
    case 'waiting_for_capacity': return 'waiting for one of WASD Engine\'s machines; starting a new one takes a few minutes'
    case 'starting': return 'starting'
    case 'running': return 'running'
    case 'sleeping': return 'asleep with no players; a joining player wakes it'
    case 'stopped': return 'stopped'
    case 'stopped_bandwidth': return 'stopped until its bandwidth allowance resets'
    case 'suspended': return 'suspended: no paid size or free server covers it'
    case 'crashed': return 'crashed, restarting'
    case 'deleted': return 'deleted'
    default: return state
  }
}

function gigabytes(bytes: number): string {
  const value = bytes / 1e9
  return value >= 100 ? `${String(Math.round(value))} GB` : `${value.toFixed(1)} GB`
}

/** One server as a result lists it for the model and the user. */
function serverLine(server: ServerRecord): string {
  const parts = [`${server.name} (${server.size}, ${server.id}): ${describeState(server.state)}`]
  if (server.granted === true) parts.push('free: one of the free servers WASD Engine gave the account')
  if (server.players_online !== null && server.players_online !== undefined) parts.push(`${String(server.players_online)} playing`)
  if (server.version !== null && server.version !== undefined) parts.push(`version ${String(server.version)}`)
  if (server.bandwidth !== null && server.bandwidth !== undefined) {
    parts.push(`bandwidth ${String(Math.round(server.bandwidth.percent))}% of ${gigabytes(server.bandwidth.allowance_bytes)} this month`)
  }
  if (server.storage !== null && server.storage !== undefined) parts.push(`storage ${gigabytes(server.storage.used_bytes)} of ${gigabytes(server.storage.limit_bytes)}`)
  if (server.address !== null && server.address !== undefined) parts.push(`address ${server.address}`)
  if (server.always_on === true) parts.push('Always on: stays up without players')
  else if (typeof server.sleeps_after_minutes === 'number') {
    const minutes = server.sleeps_after_minutes
    parts.push(`sleeps after ${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'} without players`)
  }
  if (server.pending !== null && server.pending !== undefined) parts.push(`waiting for confirmation at ${server.pending.confirm_url}`)
  return parts.join('; ')
}

/** A server as a result's JSON keeps it. */
function serverJson(server: ServerRecord): JsonValue {
  return JSON.parse(JSON.stringify(server)) as JsonValue
}

/** A number of processor cores as people read it. */
function cores(count: number): string {
  return `${String(count)} core${count === 1 ? '' : 's'}`
}

/** One size as people read it. */
function sizeLine(size: ServerSize, currency: string): string {
  return `${size.name} (${size.id}): ${formatPrice(size.price_cents, currency)} a month; about ${String(size.players_at_once)} players at once and ${size.player_hours_per_month.toLocaleString('en-US')} player-hours a month; `
    + `${cores(size.cpu.guaranteed_cores)} guaranteed, bursts to ${cores(size.cpu.burst_cores)}; ${String(size.ram_mb)} MB RAM; ${String(size.bandwidth_gb)} GB bandwidth a month; ${String(size.storage_gb)} GB storage`
}

/** The size a call names, or the error that lists the sizes. */
function findSize(plans: ServerPlans, id: string): ServerSize {
  const size = plans.sizes.find(candidate => candidate.id === id)
  if (size === undefined) throw new MultiplayerError(`There is no server size ${JSON.stringify(id)}; the sizes are ${plans.sizes.map(candidate => candidate.id).join(', ')}.`)
  return size
}

/**
 * How many more servers of a size the signed-in account creates free.
 * @param plans - the sizes, read with the sign-in.
 * @param size - the size id.
 * @returns 0 without free servers of the size left, or when the site sent none.
 */
function freeLeft(plans: ServerPlans, size: string): number {
  return plans.grants?.find(grant => grant.size === size)?.available ?? 0
}

/**
 * Whether the server's own pending resize to a size holds one of the account's free servers of it. The sizes no
 * longer count that one as left, but a new request for the size replaces the server's own and takes it over.
 * @param server - the server, as the site reports it.
 * @param size - the size id.
 * @returns false also for a site that does not say what a pending request holds.
 */
function holdsFree(server: ServerRecord, size: string): boolean {
  return server.pending?.kind === 'resize' && server.pending.size === size && server.pending.granted === true
}

/** The free servers WASD Engine gave the account, as one sentence, or undefined without any. */
function freeServersLine(plans: ServerPlans): string | undefined {
  const grants = (plans.grants ?? []).filter(grant => grant.granted > 0)
  if (grants.length === 0) return undefined
  const names = new Map(plans.sizes.map(size => [size.id, size.name]))
  const parts = grants.map(grant => `${String(grant.granted)} ${names.get(grant.size) ?? grant.size} (${String(grant.available)} left)`)
  return `Free servers WASD Engine gave this account: ${parts.join(', ')}. A server of a size with one left is free while one is still left when the user confirms it on the site.`
}

/**
 * What a result tells the user of a server that one of the account's free servers would cover: only the site decides,
 * when the user confirms, and it asks for the price once none is left.
 */
function freeWhileLeft(size: string, price: string): string {
  return `free while one of the free ${size} servers WASD Engine gave this account is left when you confirm; if none is left by then, the page shows its price, ${price} a month, instead.`
}

/** What the confirmation page's message says of a server that one of the account's free servers would cover. */
function freeOnConfirm(size: string): string {
  return `it is free while one of your free ${size} servers is left when you confirm.`
}

/** The text a refused approval returns. */
function notApproved(answer: Exclude<ApprovalAnswer, 'approved'>, what: string): string {
  switch (answer) {
    case 'declined': return `The user declined, so nothing was ${what}.`
    case 'cancelled': return `The question was cancelled, so nothing was ${what}.`
    case 'unavailable': return `WASD Engine could not ask the user, so nothing was ${what}. Ask the user in the conversation, then call the tool again.`
    default: return answer satisfies never
  }
}

/** The two modes as the guide describes them. */
function modes(plans: ServerPlans | undefined): JsonValue[] {
  const cheapest = plans === undefined || plans.sizes.length === 0
    ? undefined
    : plans.sizes.reduce((left, right) => left.price_cents <= right.price_cents ? left : right)
  const smallest = plans?.sizes[0]
  const largest = plans?.sizes.at(-1)
  const region = plans?.region.name ?? 'one region'
  const policy = plans === undefined
    ? 'Each size has a monthly bandwidth allowance; the owner gets emails as it runs low, and at 100% the server stops for the rest of its billing month.'
    : `Each size has a monthly bandwidth allowance; the owner gets emails at ${plans.bandwidth_policy.emails_at_percent.map(percent => `${String(percent)}%`).join(', ')}. ${plans.bandwidth_policy.at_limit}`
  return [
    {
      id: 'player_hosted',
      name: 'Player-hosted',
      cost: 'Free for the developer and the players.',
      best_for: 'Co-op and party games with friends, such as Left 4 Dead or Age of Empires style lobbies.',
      players: `2 to 8 is comfortable, ${String(MAX_LOBBY_PLAYERS)} at most.`,
      tradeoffs: [
        'One player\'s browser runs the game; WASD Engine introduces the players with a lobby code and relays connections that cannot go direct.',
        'The free relay has a monthly fair-use amount per game; past it, players whose networks block a direct connection cannot join until the next month.',
        'The host\'s game tab has to stay open and in front: browsers pause hidden tabs, which pauses the game for everyone.',
        'The session ends when the host leaves.',
        'The host\'s upload speed limits how many can join.',
        'The host\'s game decides what happens, so the host can cheat; fine for co-op, not for ranked play.',
        'Players can see each other\'s IP addresses unless their connection is relayed.',
      ],
    },
    {
      id: 'dedicated',
      name: 'Dedicated server',
      cost: cheapest === undefined ? 'A monthly price per server, by size.' : `From ${formatPrice(cheapest.price_cents, plans?.currency ?? 'usd')} a month per server, by size.`,
      best_for: 'Persistent worlds and larger games, such as a Minecraft-style server or a small MMO.',
      players: smallest === undefined || largest === undefined ? 'From about 10 players at once, by size.' : `About ${String(smallest.players_at_once)} to ${String(largest.players_at_once)} players at once, by size.`,
      tradeoffs: [
        `WASD Engine runs the game's server build, and anyone can join at any time. ${plans?.sleep?.summary ?? SLEEP_FALLBACK}`,
        'The server decides what happens, which makes cheating harder; players cannot see each other\'s IP addresses.',
        `Servers run in ${region}; players far from it notice more delay.`,
        policy,
        'Buying needs a valid payment method on the WASD Engine account, and the user confirms every purchase on the site.',
      ],
    },
  ]
}

/** The JSON of a value without undefined fields. */
function json(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/** Size estimates as results keep them. */
function estimatesJson(estimates: readonly SizeEstimate[]): JsonValue {
  return estimates.map(estimate => ({
    size: estimate.size, player_hours_per_month: estimate.playerHoursPerMonth, holds_test: estimate.holdsTest,
  }))
}

/** Whether a folder holds a file. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing or unreadable path is no file.
    return false
  }
}

/**
 * Build the multiplayer tool definitions of one surface.
 * @param host - plugin operations the tools call.
 * @param surface - how the surface asks the user and shows a confirmation page.
 * @returns the definitions, not registered.
 */
export function multiplayerToolDefinitions(host: MultiplayerToolHost, surface: MultiplayerSurface): ToolDefinition[] {
  const PROJECT = { type: 'string', description: surface.projectDescription } as const

  const guide = defineTool({
    name: 'wasd_multiplayer_guide',
    description: 'Explain the two ways a Godot game goes online with WASD Engine, with the live server sizes and prices, and recommend one for this game. Player-hosted is free: one player\'s browser hosts and friends join with a code. A dedicated server runs the game\'s server build around the clock for a monthly price by size. Players sign in with a WASD Engine account in both. Call it before setting up multiplayer, and show the user its for_user text so they choose.',
    parameters: {
      project: PROJECT,
      genre: { type: 'string', description: 'What kind of game it is, such as "co-op shooter" or "survival sandbox".' },
      players: { type: 'integer', description: 'Most players the game should have together.' },
      persistent_world: { type: 'boolean', description: 'true when the world must keep going while nobody plays.' },
      competitive: { type: 'boolean', description: 'true for ranked or competitive play, where cheating matters.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modes: JSON_VALUE,
          sizes: JSON_VALUE,
          recommendation: { type: 'object', required: true, additionalProperties: false, properties: { mode: STRING, reason: STRING } },
          current_mode: { type: 'string', description: 'The mode the project is set up for, when it is.' },
          plans_error: { type: 'string', description: 'Why the server sizes could not be read.' },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      let projectDir: string | undefined
      try {
        projectDir = await host.project(args.project, exec)
      } catch {
        // The guide also serves a conversation without a project.
        projectDir = undefined
      }
      const current = projectDir === undefined ? undefined : (await readMultiplayerConfig(projectDir))?.mode
      let plans: ServerPlans | undefined
      let plansError: string | undefined
      try {
        plans = await readPlans(host, exec.signal)
      } catch (error) {
        exec.signal.throwIfAborted()
        plansError = (error as Error).message
      }
      const players = args.players ?? 0
      const dedicated = args.persistent_world === true || args.competitive === true || players > MAX_LOBBY_PLAYERS
      const reason = args.persistent_world === true
        ? 'The world has to keep going while nobody plays, which only a dedicated server kept on (Always on) does.'
        : args.competitive === true
          ? 'In competitive play a host could cheat; a dedicated server decides what happens.'
          : players > MAX_LOBBY_PLAYERS
            ? `More than ${String(MAX_LOBBY_PLAYERS)} players together need a dedicated server.`
            : 'Sessions among friends work well player-hosted, and it costs nothing; the game can move to a dedicated server later without rewriting its networking.'
      const recommendation = { mode: dedicated ? 'dedicated' : 'player_hosted', reason }
      const sizes = plans === undefined ? [] : plans.sizes.map(size => sizeLine(size, plans.currency))
      const free = plans === undefined ? undefined : freeServersLine(plans)
      const lines = [
        'There are two ways to put this game online, and players sign in with a WASD Engine account in both:',
        '- Player-hosted (free): one player hosts from their browser and friends join with a code. 2 to 8 players works well. The session ends when the host leaves, and the host\'s game tab has to stay open and in front.',
        plans === undefined
          ? `- Dedicated server (a monthly price by size): WASD Engine runs the game's server, and anyone can join at any time. ${SLEEP_FALLBACK}`
          : `- Dedicated server (from ${formatPrice(Math.min(...plans.sizes.map(size => size.price_cents)), plans.currency)} a month): WASD Engine runs the game's server in ${plans.region.name}, and anyone can join at any time. ${plans.sleep?.summary ?? SLEEP_FALLBACK} ${plans.bandwidth_policy.at_limit}`,
        ...sizes.length === 0 ? [] : ['Server sizes:', ...sizes.map(line => `- ${line}`)],
        ...free === undefined ? [] : [free],
        `Recommendation: ${dedicated ? 'a dedicated server' : 'player-hosted'}. ${reason}`,
        ...plansError === undefined ? [] : [`The server sizes could not be read: ${plansError}`],
      ]
      return {
        modes: modes(plans),
        sizes: plans === undefined ? [] : json(plans.sizes),
        recommendation,
        ...current === undefined ? {} : { current_mode: current },
        ...plansError === undefined ? {} : { plans_error: plansError },
        for_user: lines.join('\n'),
      }
    },
  })

  const setup = defineTool({
    name: 'wasd_multiplayer_setup',
    description: 'Set the Godot project up for online multiplayer in the mode the user chose: copy the WASD Multiplayer add-on into addons/wasd_multiplayer, turn on its WasdMultiplayer autoload and editor plugin, and write res://wasd_multiplayer.cfg. The add-on handles WASD sign-in, lobbies, connections, and dedicated server joins; the game uses Godot\'s own multiplayer API (@rpc, MultiplayerSpawner, MultiplayerSynchronizer). Calling it again updates the add-on or switches the mode.',
    parameters: {
      project: PROJECT,
      mode: { type: 'string', enum: MULTIPLAYER_MODES, required: true, description: 'player_hosted (free, a player hosts) or dedicated (a server WASD Engine runs).' },
      max_players: { type: 'integer', description: `Most players together. Default: 8 for player_hosted (at most ${String(MAX_LOBBY_PLAYERS)}), 32 for dedicated.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_dir: STRING,
          mode: STRING,
          max_players: INTEGER,
          addon_version: { type: 'string', description: 'Version the add-on\'s plugin.cfg names.' },
          addon_files: INTEGER,
          project_changed: BOOLEAN,
          next_steps: { type: 'array', required: true, items: { type: 'string' } },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value, ['Next steps:', ...value.next_steps.map(step => `- ${step}`)]),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const mode = args.mode
      const limit = mode === 'player_hosted' ? MAX_LOBBY_PLAYERS : MAX_SERVER_PLAYERS
      const maxPlayers = args.max_players ?? (mode === 'player_hosted' ? 8 : 32)
      if (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > limit) throw new MultiplayerError(`max_players must be a whole number from 2 to ${String(limit)} for ${mode}.`)
      if (!await isFile(join(host.addonSource, 'wasd_multiplayer.gd'))) throw new MultiplayerError('This WASD Engine has no WASD Multiplayer add-on to install; update WASD Engine.')
      const exclusive = host.exclusive ?? (<T>(_project: string, _signal: AbortSignal, change: () => Promise<T>) => change())
      return await exclusive(projectDir, exec.signal, async () => {
        const files = await replaceFolder(host.addonSource, join(projectDir, ADDON_DIR))
        const projectFile = join(projectDir, 'project.godot')
        const before = await readFile(projectFile, 'utf8')
        const after = withMultiplayerAddon(before)
        if (after !== before) await writeWhole(projectFile, after)
        let origin: string | undefined
        try {
          origin = await host.siteOrigin()
        } catch {
          // Without an account plugin, the add-on keeps its default origins.
          origin = undefined
        }
        const existing = await readMultiplayerConfig(projectDir)
        const access = origin === undefined ? undefined : await host.access()
        const account = access !== undefined && access.origin === origin ? access.account : undefined
        const game = origin === undefined ? undefined : await linkedGame(projectDir, origin, account)
        await writeMultiplayerConfig(projectDir, {
          mode,
          maxPlayers,
          apiOrigin: origin ?? existing?.apiOrigin ?? '',
          appOrigin: origin ?? existing?.appOrigin ?? '',
          gameId: game?.id ?? existing?.gameId ?? '',
          version: existing?.version ?? 0,
        })
        let version: string | undefined
        try {
          version = pluginVersion(await readFile(join(host.addonSource, 'plugin.cfg'), 'utf8'))
        } catch {
          // A plugin.cfg without a version only leaves the version out.
          version = undefined
        }
        const nextSteps = mode === 'player_hosted'
          ? [
            'Host with `await WasdMultiplayer.host_lobby({"max_players": N, "public": true})`, show the lobby code it returns, and join with `await WasdMultiplayer.join_lobby(code)`; WasdMultiplayer.list_lobbies() lists public lobbies.',
            'Spawn players on WasdMultiplayer.player_joined(peer_id, player) and remove them on player_left; the host is peer 1 and decides what happens.',
            'Use Godot\'s own multiplayer API for game state: @rpc functions, MultiplayerSpawner, and MultiplayerSynchronizer.',
            `See ${ADDON_DIR}/examples for a lobby screen, then call wasd_multiplayer_test.`,
          ]
          : [
            'In the main scene: `if WasdMultiplayer.is_server(): WasdMultiplayer.serve()`, else `await WasdMultiplayer.join_server()`; the server build runs headless.',
            'Spawn players on WasdMultiplayer.player_joined(peer_id, player), where player.id stays the same for one account across sessions, and keep the world under user:// so it persists.',
            'Save on WasdMultiplayer.server_stopping(), calling WasdMultiplayer.delay_stop() before a save that awaits and stop_ready() after it, and warn players on server_warning(seconds, reason, message).',
            'Call wasd_multiplayer_test, then wasd_release_game, which uploads the server build; a server needs the user to pick a size from wasd_server_plans.',
          ]
        return {
          project_dir: projectDir,
          mode,
          max_players: maxPlayers,
          ...version === undefined ? {} : { addon_version: version },
          addon_files: files.length,
          project_changed: after !== before,
          next_steps: nextSteps,
          for_user: mode === 'player_hosted'
            ? `The game is set up for player-hosted multiplayer, up to ${String(maxPlayers)} players. It costs nothing: one player hosts from their browser and friends join with a code, signed in with a WASD Engine account.`
            : `The game is set up for a dedicated server, up to ${String(maxPlayers)} players. The server needs a monthly size, which you choose before anything is bought; players sign in with a WASD Engine account.`,
        }
      })
    },
  })

  const test = defineTool({
    name: 'wasd_multiplayer_test',
    description: 'Test the game\'s multiplayer on this computer: run the host, or the dedicated server, and 1 to 3 clients as headless instances that connect over loopback, with made-up players and no WASD Engine services or costs. Reports whether every client connected, the server\'s frame time, memory, processor use, and traffic per player-hour, and which server size holds the game. Needs wasd_multiplayer_setup first; the game\'s main scene must use WasdMultiplayer.',
    parameters: {
      project: PROJECT,
      clients: { type: 'integer', description: 'Clients to connect, 1 to 3. Default: 2.' },
      seconds: { type: 'integer', description: 'How long the host or server runs, 10 to 120 seconds. Default: 30.' },
      mode: { type: 'string', enum: MULTIPLAYER_MODES, description: 'Mode to test. Default: the mode the project is set up for.' },
    },
    timeoutMs: TEST_TIMEOUT_MS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project_dir: STRING,
          mode: STRING,
          clients: INTEGER,
          connected: INTEGER,
          passed: BOOLEAN,
          seconds: INTEGER,
          mb_per_player_hour: { type: 'number' },
          cpu_cores: { type: 'number' },
          memory_mb: { type: 'number' },
          tick_ms_avg: { type: 'number' },
          tick_ms_max: { type: 'number' },
          fits: { type: 'string', description: 'The smallest server size that holds what the test measured.' },
          estimates: JSON_VALUE,
          instances: JSON_VALUE,
          import_issues: { type: 'array', required: true, items: { type: 'string' } },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value, [
        ...value.import_issues.length === 0 ? [] : ['Import errors:', ...value.import_issues.map(issue => `- ${issue}`)],
        ...value.passed ? [] : [`Instances: ${JSON.stringify(value.instances)}`],
      ]),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const clients = args.clients ?? 2
      const seconds = args.seconds ?? 30
      if (!Number.isInteger(clients) || clients < 1 || clients > 3) throw new MultiplayerError('clients must be 1, 2, or 3.')
      if (!Number.isInteger(seconds) || seconds < 10 || seconds > 120) throw new MultiplayerError('seconds must be a whole number from 10 to 120.')
      if (!await hasMultiplayerAddon(projectDir)) throw new MultiplayerError('The project has no WASD Multiplayer add-on; call wasd_multiplayer_setup first.')
      const mode = args.mode ?? (await readMultiplayerConfig(projectDir))?.mode
      if (mode === undefined) throw new MultiplayerError('The project names no multiplayer mode; call wasd_multiplayer_setup first, or pass mode.')
      const plan = planTest(mode, clients, seconds, await freePort())
      const report = await host.runInstances({ projectDir, instances: plan.instances, timeoutMs: (seconds + 30) * 1000 }, exec.signal)
      const reports = report.instances.map(instance => ({ instance, stats: instanceStats(instance), problems: instanceProblems(instance) }))
      const hostStats = reports[0]?.stats
      const connected = reports.slice(1).filter(entry => entry.stats !== undefined && clientConnected(entry.stats)).length
      const summary = reports.map(({ instance, stats, problems }) => ({
        name: instance.name,
        exit_code: instance.exitCode,
        timed_out: instance.timedOut,
        ...stats === undefined ? { output_tail: `${instance.stdout}\n${instance.stderr}`.trim().split(/\r?\n/u).slice(-15).join('\n') } : { stats },
        ...problems.length === 0 ? {} : { problems },
      }))
      const firstProblem = reports.flatMap(({ instance, problems }) => problems.map(problem => `${instance.name}: ${problem}`))[0]
      if (hostStats === undefined) {
        return {
          project_dir: projectDir,
          mode,
          clients,
          connected,
          passed: false,
          seconds: plan.clientSeconds,
          estimates: [],
          instances: json(summary),
          import_issues: [...report.importIssues],
          for_user: `The ${mode === 'player_hosted' ? 'host' : 'server'} reported no test results: it did not run the WASD Multiplayer add-on's test mode, or it failed first. Check that the main scene uses WasdMultiplayer, then test again.${firstProblem === undefined ? '' : ` First problem: ${firstProblem}`}`,
        }
      }
      const record = testRecord(mode, clients, connected, plan.clientSeconds, hostStats)
      await saveTestRecord(projectDir, record)
      let estimates: SizeEstimate[] = []
      let currency = 'usd'
      let sizes: ServerSize[] = []
      try {
        const plans = await readPlans(host, exec.signal)
        sizes = plans.sizes
        currency = plans.currency
        estimates = estimateSizes(record, plans.sizes)
      } catch {
        // Without the site's sizes, the result keeps the measurement alone.
        exec.signal.throwIfAborted()
      }
      const fits = estimates.find(estimate => estimate.holdsTest)?.size
      const fitting = sizes.find(size => size.id === fits)
      const passed = connected === clients
      return {
        project_dir: projectDir,
        mode,
        clients,
        connected,
        passed,
        seconds: plan.clientSeconds,
        mb_per_player_hour: record.mb_per_player_hour,
        cpu_cores: record.cpu_cores,
        memory_mb: record.memory_mb,
        tick_ms_avg: record.tick_ms_avg,
        tick_ms_max: record.tick_ms_max,
        ...fits === undefined ? {} : { fits },
        estimates: estimatesJson(estimates),
        instances: json(summary),
        import_issues: [...report.importIssues],
        for_user: [
          `${passed ? clients === 1 ? 'The test player' : `All ${String(clients)} test players` : `${String(connected)} of ${String(clients)} test players`} connected to the ${mode === 'player_hosted' ? 'host' : 'server'}.`,
          `The ${mode === 'player_hosted' ? 'host' : 'server'} used about ${String(record.memory_mb)} MB of memory, ${String(Math.round(record.cpu_cores * 100))}% of a processor core, and ${String(record.mb_per_player_hour)} MB of traffic per player-hour.`,
          ...mode === 'dedicated' && fitting !== undefined
            ? [`At that rate a ${fitting.name} server (${formatPrice(fitting.price_cents, currency)} a month) holds it, and its bandwidth lasts about ${(estimates.find(estimate => estimate.size === fits)?.playerHoursPerMonth ?? 0).toLocaleString('en-US')} player-hours a month.`]
            : [],
          ...passed || firstProblem === undefined ? [] : [`First problem: ${firstProblem}`],
        ].join(' '),
      }
    },
  })

  const lobbyStats = defineTool({
    name: 'wasd_lobby_stats',
    description: 'Show the released game\'s player-hosted lobbies: how many are open, how many players are in them, and this month\'s relay traffic against the fair-use level, past which the relay is off for the game until the next month. Player-hosted multiplayer is free; nothing is billed.',
    parameters: { project: PROJECT },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lobbies_open: INTEGER,
          players_online: INTEGER,
          relay_gb_this_month: { type: 'number', required: true },
          relay_soft_cap_gb: { type: 'number', required: true },
          relay_available: BOOLEAN,
          relay_paused_until: { type: 'string', description: 'When the relay is back for the game, while its fair use is used up.' },
          month: STRING,
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const stats = await api.lobbyStats(game.id)
      const used = Math.round(stats.relay.bytes_this_month / 1e8) / 10
      const cap = Math.round(stats.relay.soft_cap_bytes / 1e8) / 10
      const available = stats.relay.available ?? true
      const pausedUntil = stats.relay.paused_until ?? undefined
      let relay = `Relayed traffic this month: ${String(used)} GB of the ${String(cap)} GB fair-use level.`
      if (stats.relay.soft_cap_bytes <= 0) relay = `Relayed traffic this month: ${String(used)} GB; the relay has no fair-use level.`
      else if (!available) relay = `Relayed traffic this month: ${String(used)} GB, past the ${String(cap)} GB fair-use level, so the relay is off for this game until ${pausedUntil === undefined ? 'next month' : pausedUntil.slice(0, 10)}: players whose networks block a direct connection cannot join until then.`
      return {
        lobbies_open: stats.lobbies_open,
        players_online: stats.players_online,
        relay_gb_this_month: used,
        relay_soft_cap_gb: cap,
        relay_available: available,
        ...pausedUntil === undefined ? {} : { relay_paused_until: pausedUntil },
        month: stats.month,
        for_user: `${game.title} has ${String(stats.lobbies_open)} open lobb${stats.lobbies_open === 1 ? 'y' : 'ies'} with ${String(stats.players_online)} player${stats.players_online === 1 ? '' : 's'}. ${relay} Player-hosted multiplayer costs nothing.`,
      }
    },
  })

  const plansTool = defineTool({
    name: 'wasd_server_plans',
    description: 'List the dedicated server sizes with their monthly prices, CPU, RAM, bandwidth, storage, and how many players each holds, from the WASD Engine site, and the free servers WASD Engine gave the signed-in account, which cost nothing. After wasd_multiplayer_test, it also fits each size to what the test measured. Show the user the sizes and prices and let them choose; never pick a size for them.',
    parameters: { project: PROJECT },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: BOOLEAN,
          currency: STRING,
          region: STRING,
          sizes: JSON_VALUE,
          bandwidth_policy: STRING,
          purchase: STRING,
          estimate_basis: STRING,
          measured: { type: 'json', description: 'What the project\'s last wasd_multiplayer_test measured.' },
          estimates: { type: 'json', description: 'Each size fitted to that test.' },
          free_servers: { type: 'json', description: 'The free servers WASD Engine gave the signed-in account, by size: how many, how many are in use, and how many more it creates free.' },
          for_user: FOR_USER,
        },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const plans = await readPlans(host, exec.signal)
      let projectDir: string | undefined
      try {
        projectDir = await host.project(args.project, exec)
      } catch {
        // The sizes also serve a conversation without a project.
        projectDir = undefined
      }
      const measured = projectDir === undefined ? undefined : await readTestRecord(projectDir)
      const estimates = measured === undefined ? undefined : estimateSizes(measured, plans.sizes)
      const lines = [
        ...plans.available ? [] : ['WASD Engine does not sell dedicated servers yet; these are the planned sizes.'],
        `Dedicated server sizes (${plans.region.name}):`,
        ...plans.sizes.map((size) => {
          const estimate = estimates?.find(candidate => candidate.size === size.id)
          return `- ${sizeLine(size, plans.currency)}${estimate === undefined ? '' : `; with this game, bandwidth for about ${estimate.playerHoursPerMonth.toLocaleString('en-US')} player-hours a month${estimate.holdsTest ? '' : ', but less memory or processor than the test used'}`}`
        }),
        `Bandwidth: emails at ${plans.bandwidth_policy.emails_at_percent.map(percent => `${String(percent)}%`).join(', ')}. ${plans.bandwidth_policy.at_limit}`,
        `Buying: ${plans.purchase.requires} The user confirms every purchase on the site.`,
      ]
      const free = freeServersLine(plans)
      if (free !== undefined) lines.push(free)
      const grants = (plans.grants ?? []).filter(grant => grant.granted > 0)
      return {
        available: plans.available,
        currency: plans.currency,
        region: plans.region.name,
        sizes: json(plans.sizes),
        bandwidth_policy: plans.bandwidth_policy.at_limit,
        purchase: plans.purchase.requires,
        estimate_basis: plans.estimate_basis,
        ...measured === undefined ? {} : { measured: json(measured) },
        ...estimates === undefined ? {} : { estimates: estimatesJson(estimates) },
        ...grants.length === 0 ? {} : { free_servers: json(grants) },
        for_user: lines.join('\n'),
      }
    },
  })

  const PENDING_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', required: true, enum: ['awaiting_confirmation', 'declined', 'cancelled', 'unavailable'] },
      server_id: { type: 'string' },
      size: { type: 'string' },
      price: { type: 'string', description: 'Monthly price of the size.' },
      free: { type: 'boolean', description: 'true when one of the free servers WASD Engine gave the account was left for it: it is free while one is left when the user confirms on the site.' },
      confirm_url: { type: 'string', description: 'The page where the user confirms; nothing happens before that.' },
      expires_at: { type: 'string' },
      opened: { type: 'boolean', description: 'Whether WASD Engine opened the page in the user\'s browser.' },
      confirm_message: { type: 'string', description: 'What the user confirms on the page.' },
      for_user: FOR_USER,
    },
  } as const

  /** Show the confirmation page, and the text that tells the user where to confirm. */
  const confirmation = async (
    url: string, what: string, exec: ToolRunContext,
  ): Promise<{ readonly opened: boolean; readonly forUser: string }> => {
    const opened = surface.channel === 'app' && await surface.openLink(url, exec)
    return {
      opened,
      forUser: opened
        ? `WASD Engine opened a page on ${hostOf(url)} in the browser. ${what} Nothing happens until you confirm there. If it did not open, use this link: ${url}`
        : `Open this page to confirm: ${url} ${what} Nothing happens until you confirm there.`,
    }
  }

  const create = defineTool({
    name: 'wasd_server_create',
    description: 'Create a dedicated server for the released game, of a size the user chose from wasd_server_plans. It never charges by itself: it returns a page on the WASD Engine site where the user confirms and pays, which needs a valid payment method on their account; a size of which wasd_server_plans lists free servers left for the account is free while one is left when the user confirms, and then needs no card. Tell the user the size\'s monthly price, or that it is free while one of those free servers is left, and what it includes before calling it. The server then runs the newest release\'s server build.',
    parameters: {
      project: PROJECT,
      size: { type: 'string', required: true, description: 'Size id from wasd_server_plans, such as small.' },
      name: { type: 'string', description: 'Name of the server, at most 48 characters. Default: the game\'s title.' },
    },
    output: { schema: PENDING_SCHEMA, render: (_args, value) => text(value) },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      if (args.name !== undefined && (args.name.trim() === '' || args.name.length > 48)) throw new MultiplayerError('name must be 1 to 48 characters.')
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const plans = await api.plans()
      if (!plans.available) throw new MultiplayerError('WASD Engine does not sell dedicated servers yet. Player-hosted multiplayer works without them.', 'servers_unavailable')
      const size = findSize(plans, args.size)
      const price = formatPrice(size.price_cents, plans.currency)
      const free = freeLeft(plans, size.id) > 0
      const what = free
        ? `This is a ${size.name} server for ${game.title}, ${freeWhileLeft(size.name, price)}`
        : `This is a ${size.name} server for ${game.title} at ${price} a month.`
      const site = hostOf(access.origin)
      const prompt = free ? createFreePrompt(size.name, game.title, site) : createPrompt(size.name, price, game.title, site)
      const answer = await surface.approve(exec, 'wasd_server_create', prompt)
      if (answer !== 'approved') return { status: answer, size: size.id, price, ...free ? { free } : {}, for_user: notApproved(answer, 'created or charged') }
      const pending = await api.create(game.id, size.id, args.name?.trim())
      const shown = await confirmation(pending.confirm_url, what, exec)
      return {
        status: 'awaiting_confirmation' as const,
        server_id: pending.server.id,
        size: size.id,
        price,
        ...free ? { free } : {},
        confirm_url: pending.confirm_url,
        expires_at: pending.expires_at,
        opened: shown.opened,
        confirm_message: free
          ? `Confirm the ${size.name} game server for ${game.title} on the WASD Engine site; ${freeOnConfirm(size.name)}`
          : `Confirm the ${size.name} game server for ${game.title} at ${price} a month on the WASD Engine site; nothing is charged until you confirm there.`,
        for_user: shown.forUser,
      }
    },
  })

  const deploy = defineTool({
    name: 'wasd_server_deploy',
    description: 'Deploy a release\'s server build to the game\'s server: the newest release unless version names one, such as an earlier version to roll back. Players get a 60-second warning, then the server restarts on that build; the world is kept. Releases deploy to the game\'s servers by themselves, so call this for a rollback or a server that missed one. Tell the user the server restarts.',
    parameters: {
      project: PROJECT,
      server: SERVER,
      version: { type: 'integer', description: 'Release whose server build to deploy. Default: the newest.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { server: JSON_VALUE, for_user: FOR_USER } },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const server = await chooseServer(api, game.id, args.server)
      const deployed = await api.deploy(server.id, args.version)
      return {
        server: serverJson(deployed),
        for_user: `${deployed.name} is switching to ${args.version === undefined ? 'the newest server build' : `version ${String(args.version)}`}: players get a 60-second warning, then it restarts with its world kept. ${serverLine(deployed)}`,
      }
    },
  })

  const status = defineTool({
    name: 'wasd_server_status',
    description: 'Show the game\'s dedicated servers, or one of them: state, address, release version, players, CPU and memory, this month\'s bandwidth and storage against the size\'s allowance, the last backup, and the price. A server that used all its bandwidth stops until the allowance resets with its next billing month.',
    parameters: { project: PROJECT, server: { type: 'string', description: 'Server id. Default: every server of the game.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { servers: JSON_VALUE, for_user: FOR_USER } },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const servers = args.server === undefined ? await api.servers(game.id) : [await chooseServer(api, game.id, args.server)]
      return {
        servers: servers.map(serverJson),
        for_user: servers.length === 0
          ? `${game.title} has no dedicated servers.`
          : [`${game.title}'s servers:`, ...servers.map(server => `- ${serverLine(server)}`)].join('\n'),
      }
    },
  })

  const logs = defineTool({
    name: 'wasd_server_logs',
    description: 'Read the latest lines of a dedicated server\'s log: what the game printed, its errors, and WASD Engine\'s notes such as restarts.',
    parameters: { project: PROJECT, server: SERVER, limit: { type: 'integer', description: 'Most lines, 1 to 500. Default: 200.' } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { server_id: STRING, lines: JSON_VALUE, for_user: FOR_USER } },
      render: (_args, value) => text(value, Array.isArray(value.lines)
        ? value.lines.map((line) => {
          const entry = line as { at?: string; stream?: string; text?: string }
          return `${entry.at ?? ''} [${entry.stream ?? ''}] ${entry.text ?? ''}`.trim()
        })
        : []),
    },
    async execute(args, exec) {
      const limit = args.limit ?? 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new MultiplayerError('limit must be a whole number from 1 to 500.')
      const projectDir = await host.project(args.project, exec)
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const server = await chooseServer(api, game.id, args.server)
      const lines = await api.logs(server.id, limit)
      return {
        server_id: server.id,
        lines: json(lines),
        for_user: lines.length === 0 ? `${server.name} has logged nothing yet.` : `The last ${String(lines.length)} line${lines.length === 1 ? '' : 's'} of ${server.name}'s log:`,
      }
    },
  })

  const manage = defineTool({
    name: 'wasd_server_manage',
    description: 'Start, stop, restart, back up, or restore a dedicated server. Stopping keeps the world and the monthly price; only deleting ends billing. Players get a warning before a stop or restart. restore replaces the current world with a backup from wasd_server_status or the backup list it returns, so ask the user first.',
    parameters: {
      project: PROJECT,
      server: SERVER,
      action: { type: 'string', enum: ['start', 'stop', 'restart', 'backup', 'restore', 'backups'], required: true, description: 'backups lists the backups to restore from.' },
      backup_id: { type: 'string', description: 'The backup to restore.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { status: STRING, server: { type: 'json' }, backups: { type: 'json' }, for_user: FOR_USER },
      },
      render: (_args, value) => text(value),
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const server = await chooseServer(api, game.id, args.server)
      if (args.action === 'backups') {
        const backups = await api.backups(server.id)
        return {
          status: 'listed',
          backups: json(backups),
          for_user: backups.length === 0
            ? `${server.name} has no backups yet.`
            : [`${server.name}'s backups:`, ...backups.map(backup => `- ${backup.id}: ${backup.created_at ?? 'unknown time'}${backup.reason === null || backup.reason === undefined ? '' : ` (${backup.reason})`}`)].join('\n'),
        }
      }
      if (args.action === 'restore') {
        if (args.backup_id === undefined) throw new MultiplayerError('Pass backup_id; action backups lists them.')
        const backup = (await api.backups(server.id)).find(candidate => candidate.id === args.backup_id)
        if (backup === undefined) throw new MultiplayerError(`${server.name} has no backup ${args.backup_id}; action backups lists them.`)
        const answer = await surface.approve(exec, 'wasd_server_manage', restorePrompt(server.name, backup.created_at ?? backup.id))
        if (answer !== 'approved') return { status: answer, for_user: notApproved(answer, 'restored') }
      }
      const action = args.action
      const changed = await api.act(server.id, action, action === 'restore' ? args.backup_id : undefined)
      const done: Record<typeof action, string> = {
        start: `${changed.name} is starting.`,
        stop: `${changed.name} is stopping after a warning to its players; its world and its monthly price stay.`,
        restart: `${changed.name} restarts after a warning to its players.`,
        backup: `${changed.name} is backing up its world.`,
        restore: `${changed.name} is restoring the backup; players get a warning before it restarts.`,
      }
      return { status: 'done', server: serverJson(changed), for_user: `${done[action]} ${serverLine(changed)}` }
    },
  })

  const change = defineTool({
    name: 'wasd_server_change',
    description: 'Change a dedicated server\'s size, or delete the server. It never changes the bill by itself: it returns a page on the WASD Engine site where the user confirms. For a paid server, a bigger size is charged from the confirmation, prorated, and a smaller one credited. A free server (wasd_server_status marks it) moved to a size without free servers left becomes a new purchase at that size\'s monthly price, with no credit. A size with free servers left for the account (wasd_server_plans lists them) is free while one is left when the user confirms. Deleting stops the server and deletes its world 7 days later; a paid server\'s monthly price comes off the bill unless the confirmation page says another of the account\'s servers keeps it, and a free one changes no bill. Deleting a server whose purchase still awaits confirmation cancels that purchase, which never ran or charged anything. Tell the user the price difference or what deleting loses before calling it.',
    parameters: {
      project: PROJECT,
      server: SERVER,
      size: { type: 'string', description: 'New size id from wasd_server_plans.' },
      delete: { type: 'boolean', description: 'true deletes the server.' },
    },
    output: { schema: PENDING_SCHEMA, render: (_args, value) => text(value) },
    async execute(args, exec) {
      if ((args.size === undefined) === (args.delete !== true)) throw new MultiplayerError('Pass either size or delete: true.')
      const projectDir = await host.project(args.project, exec)
      const { api, access } = await signedIn(host, exec.signal)
      const game = await releasedGame(projectDir, access)
      const server = await chooseServer(api, game.id, args.server)
      const granted = server.granted === true
      if (args.delete === true) {
        // Deleting a server whose purchase still awaits confirmation cancels that purchase, on the site's page too.
        const deleted: DeletedServer = server.state === 'awaiting_confirmation' ? 'purchase' : granted ? 'free' : 'paid'
        const answer = await surface.approve(exec, 'wasd_server_change', deletePrompt(server.name, deleted, hostOf(access.origin)))
        if (answer !== 'approved') return { status: answer, server_id: server.id, for_user: notApproved(answer, deleted === 'purchase' ? 'cancelled' : 'deleted') }
        const pending = await api.remove(server.id)
        const what: Record<DeletedServer, string> = {
          purchase: `This cancels the purchase of ${server.name}: it never ran and was never charged, so cancelling it costs nothing.`,
          free: `This deletes ${server.name}: it stops for every player and its world is deleted 7 days later; it is one of the account's free servers, so the bill does not change.`,
          paid: `This deletes ${server.name}: it stops for every player and its world is deleted 7 days later; its monthly price comes off the bill, unless the confirmation page says another of the account's servers keeps it.`,
        }
        const shown = await confirmation(pending.confirm_url, what[deleted], exec)
        return {
          status: 'awaiting_confirmation' as const,
          server_id: server.id,
          confirm_url: pending.confirm_url,
          expires_at: pending.expires_at,
          opened: shown.opened,
          confirm_message: deleted === 'purchase'
            ? `Confirm cancelling the purchase of the server ${server.name} on the WASD Engine site; nothing is charged.`
            : `Confirm deleting the server ${server.name} on the WASD Engine site; its world is deleted 7 days later.`,
          for_user: shown.forUser,
        }
      }
      const plans = await api.plans()
      const size = findSize(plans, args.size as string)
      if (size.id === server.size) throw new MultiplayerError(`${server.name} is already ${size.name}.`)
      const current = plans.sizes.find(candidate => candidate.id === server.size)
      const price = formatPrice(size.price_cents, plans.currency)
      const free = freeLeft(plans, size.id) > 0 || holdsFree(server, size.id)
      const from: PromptSize = {
        name: current?.name ?? server.size,
        price: current === undefined ? undefined : formatPrice(current.price_cents, plans.currency),
        free: granted,
      }
      const fromLabel = sizeLabels(from).en
      const answer = await surface.approve(exec, 'wasd_server_change', resizePrompt(server.name, from, { name: size.name, price, free }, hostOf(access.origin)))
      if (answer !== 'approved') return { status: answer, server_id: server.id, size: size.id, price, ...free ? { free } : {}, for_user: notApproved(answer, 'changed') }
      const pending = await api.resize(server.id, size.id)
      // A free server moved to a size without a free one left is bought at that size's price, with no credit.
      const purchase = granted && !free
      const what = free
        ? `This changes ${server.name} from ${fromLabel} to ${size.name}, ${freeWhileLeft(size.name, price)}`
        : purchase
          ? `This changes ${server.name} from ${fromLabel} to ${size.name}, a new purchase at ${price} a month; the free ${from.name} server stays on the account for another server.`
          : `This changes ${server.name} from ${fromLabel} to ${size.name} at ${price} a month.`
      const shown = await confirmation(pending.confirm_url, what, exec)
      return {
        status: 'awaiting_confirmation' as const,
        server_id: server.id,
        size: size.id,
        price,
        ...free ? { free } : {},
        confirm_url: pending.confirm_url,
        expires_at: pending.expires_at,
        opened: shown.opened,
        confirm_message: free
          ? `Confirm changing the server ${server.name} to ${size.name} on the WASD Engine site; ${freeOnConfirm(size.name)}`
          : purchase
            ? `Confirm changing the server ${server.name} to ${size.name}, a new purchase at ${price} a month, on the WASD Engine site; nothing is charged until you confirm there.`
            : `Confirm changing the server ${server.name} to ${size.name} at ${price} a month on the WASD Engine site.`,
        for_user: shown.forUser,
      }
    },
  })

  return [guide, setup, test, lobbyStats, plansTool, create, deploy, status, logs, manage, change]
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
