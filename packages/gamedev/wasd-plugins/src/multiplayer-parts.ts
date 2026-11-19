/**
 * What the multiplayer tool groups share: the player limits, the schemas of their values, the account and game a call
 * acts for, and the text and JSON of servers, sizes, plans, and estimates.
 */
import { stat } from 'node:fs/promises'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { linkedGame } from './game-link.ts'
import { formatPrice, MultiplayerApi, MultiplayerError, type ServerPlans, type ServerRecord, type ServerSize } from './multiplayer-api.ts'
import type { SizeEstimate } from './multiplayer-test.ts'
import type { ApprovalAnswer, MultiplayerToolHost } from './multiplayer-tools.ts'
import type { SiteAccess } from './site-client.ts'

/** Most players a player-hosted session takes: the host's browser connects to every other player. */
export const MAX_LOBBY_PLAYERS = 16

/** Most players one dedicated server may name in the add-on's configuration. */
export const MAX_SERVER_PLAYERS = 500

/** Time limit of one `wasd_multiplayer_test` call, its instances' start, run, and stop included. */
export const TEST_TIMEOUT_MS = 5 * 60_000

/** A required string field. */
export const STRING = { type: 'string', required: true } as const

/** A required integer field. */
export const INTEGER = { type: 'integer', required: true } as const

/** A required boolean field. */
export const BOOLEAN = { type: 'boolean', required: true } as const

/** A required JSON field. */
export const JSON_VALUE = { type: 'json', required: true } as const

/** The text a result asks the agent to pass on to the user. */
export const FOR_USER = { type: 'string', required: true, description: 'Plain text to pass on to the user.' } as const

/** The server argument of the tools that act on one server. */
export const SERVER = { type: 'string', description: 'Server id from wasd_server_status. Default: the game\'s only server.' } as const

/**
 * The text a result shows the model: what to pass on to the user, then any further lines.
 * @param value - the result value.
 * @param extra - further lines.
 * @returns the text block.
 */
export function text(value: { readonly for_user: string }, extra: readonly string[] = []): [{ type: 'text'; text: string }] {
  return [{ type: 'text', text: [value.for_user, ...extra].join('\n') }]
}

/**
 * The site's host, for prompts that name where the user confirms.
 * @param url - a page of the site.
 * @returns its host, or the URL itself when it does not parse.
 */
export function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : url
}

/**
 * The signed-in API.
 * @param host - what the tools run on.
 * @param signal - cancellation.
 * @returns the API client and the sign-in.
 * @throws {MultiplayerError} that asks the user to sign in.
 */
export async function signedIn(
  host: MultiplayerToolHost, signal: AbortSignal,
): Promise<{ readonly api: MultiplayerApi; readonly access: SiteAccess }> {
  const access = await host.access()
  if (access === undefined) throw new MultiplayerError('WASD Engine is signed out, and servers belong to a WASD Engine account. Ask the user to sign in to WASD Engine, then try again.')
  return { api: new MultiplayerApi(access, host.fetch, signal), access }
}

/**
 * The public sizes, read with the sign-in when there is one.
 * @param host - what the tools run on.
 * @param signal - cancellation.
 * @returns the plans.
 */
export async function readPlans(host: MultiplayerToolHost, signal: AbortSignal): Promise<ServerPlans> {
  const access = await host.access() ?? { origin: await host.siteOrigin(), token: '' }
  return await new MultiplayerApi(access, host.fetch, signal).plans()
}

/**
 * The signed-in account's game of the project on its site.
 * @param projectDir - the project folder.
 * @param access - the sign-in.
 * @returns the game's id and title.
 * @throws {MultiplayerError} that asks for a first release.
 */
export async function releasedGame(projectDir: string, access: SiteAccess): Promise<{ readonly id: string; readonly title: string }> {
  const game = await linkedGame(projectDir, access.origin, access.account)
  if (game === undefined) {
    throw new MultiplayerError('This project has no game on WASD Engine yet. Release it once with wasd_release_game: servers and lobby statistics belong to a released game, and each release uploads the server build.')
  }
  return { id: game.id, title: game.title }
}

/**
 * The calling project's released game, with an API client of the signed-in account.
 * @param host - the tools' host.
 * @param project - the `project` argument.
 * @param exec - the tool call.
 * @returns the client, the game, the project folder, and the sign-in.
 * @throws {MultiplayerError} when WASD Engine is signed out or the project has no released game.
 */
export async function releasedGameOf(host: MultiplayerToolHost, project: string | undefined, exec: ToolRunContext): Promise<{
  readonly api: MultiplayerApi
  readonly access: SiteAccess
  readonly projectDir: string
  readonly game: { readonly id: string; readonly title: string }
}> {
  const projectDir = await host.project(project, exec)
  const { api, access } = await signedIn(host, exec.signal)
  return { api, access, projectDir, game: await releasedGame(projectDir, access) }
}

/**
 * The server a call names, or the game's only one.
 * @param api - the signed-in API.
 * @param gameId - the game.
 * @param requested - the server the call names, if any.
 * @returns the server.
 * @throws {MultiplayerError} when the named server belongs to another game, or the call names none and the game has
 * none or several.
 */
export async function chooseServer(api: MultiplayerApi, gameId: string, requested: string | undefined): Promise<ServerRecord> {
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
export const SLEEP_FALLBACK = 'A server may sleep while nobody plays and wake when a player joins.'

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

/**
 * One server as a line of a result.
 * @param server - the server.
 * @returns the line.
 */
export function serverLine(server: ServerRecord): string {
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

/**
 * One server as a result value holds it.
 * @param server - the server.
 * @returns its fields.
 */
export function serverJson(server: ServerRecord): JsonValue {
  return JSON.parse(JSON.stringify(server)) as JsonValue
}

/** A number of processor cores as people read it. */
function cores(count: number): string {
  return `${String(count)} core${count === 1 ? '' : 's'}`
}

/**
 * One size as a line of a result.
 * @param size - the size.
 * @param currency - the plans' currency.
 * @returns the line.
 */
export function sizeLine(size: ServerSize, currency: string): string {
  return `${size.name} (${size.id}): ${formatPrice(size.price_cents, currency)} a month; about ${String(size.players_at_once)} players at once and ${size.player_hours_per_month.toLocaleString('en-US')} player-hours a month; `
    + `${cores(size.cpu.guaranteed_cores)} guaranteed, bursts to ${cores(size.cpu.burst_cores)}; ${String(size.ram_mb)} MB RAM; ${String(size.bandwidth_gb)} GB bandwidth a month; ${String(size.storage_gb)} GB storage`
}

/**
 * A size of the plans by its id.
 * @param plans - the plans.
 * @param id - the size's id.
 * @returns the size.
 * @throws {MultiplayerError} that lists the sizes when there is none of that id.
 */
export function findSize(plans: ServerPlans, id: string): ServerSize {
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
export function freeLeft(plans: ServerPlans, size: string): number {
  return plans.grants?.find(grant => grant.size === size)?.available ?? 0
}

/**
 * Whether the server's own pending resize to a size holds one of the account's free servers of it. The sizes no
 * longer count that one as left, but a new request for the size replaces the server's own and takes it over.
 * @param server - the server, as the site reports it.
 * @param size - the size id.
 * @returns false also for a site that does not say what a pending request holds.
 */
export function holdsFree(server: ServerRecord, size: string): boolean {
  return server.pending?.kind === 'resize' && server.pending.size === size && server.pending.granted === true
}

/**
 * The line of a result that says which sizes the account's free servers cover.
 * @param plans - the plans.
 * @returns the line, or undefined when WASD Engine gave the account no free servers.
 */
export function freeServersLine(plans: ServerPlans): string | undefined {
  const grants = (plans.grants ?? []).filter(grant => grant.granted > 0)
  if (grants.length === 0) return undefined
  const names = new Map(plans.sizes.map(size => [size.id, size.name]))
  const parts = grants.map(grant => `${String(grant.granted)} ${names.get(grant.size) ?? grant.size} (${String(grant.available)} left)`)
  return `Free servers WASD Engine gave this account: ${parts.join(', ')}. A server of a size with one left is free while one is still left when the user confirms it on the site.`
}

/**
 * What a size costs while the account has a free server of it left.
 * @param size - the size.
 * @param price - the size's monthly price.
 * @returns the sentence.
 */
export function freeWhileLeft(size: string, price: string): string {
  return `free while one of the free ${size} servers WASD Engine gave this account is left when you confirm; if none is left by then, the page shows its price, ${price} a month, instead.`
}

/**
 * What the confirmation page says of a size that one of the account's free servers would cover.
 * @param size - the size.
 * @returns the sentence.
 */
export function freeOnConfirm(size: string): string {
  return `it is free while one of your free ${size} servers is left when you confirm.`
}

/**
 * What a result says when the user did not approve a step.
 * @param answer - the user's answer.
 * @param what - the step.
 * @returns the sentence.
 */
export function notApproved(answer: Exclude<ApprovalAnswer, 'approved'>, what: string): string {
  switch (answer) {
    case 'declined': return `The user declined, so nothing was ${what}.`
    case 'cancelled': return `The question was cancelled, so nothing was ${what}.`
    case 'unavailable': return `WASD Engine could not ask the user, so nothing was ${what}. Ask the user in the conversation, then call the tool again.`
    default: return answer satisfies never
  }
}

/**
 * The ways a game can run its multiplayer, with what each costs under the plans.
 * @param plans - the plans.
 * @returns the modes as a result value holds them.
 */
export function modes(plans: ServerPlans | undefined): JsonValue[] {
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

/**
 * A value as the JSON a tool result stores.
 * @param value - the value.
 * @returns the same fields as JSON.
 */
export function json(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

/**
 * The bandwidth estimates as a result value holds them.
 * @param estimates - the estimates.
 * @returns their fields.
 */
export function estimatesJson(estimates: readonly SizeEstimate[]): JsonValue {
  return estimates.map(estimate => ({
    size: estimate.size, player_hours_per_month: estimate.playerHoursPerMonth, holds_test: estimate.holdsTest,
  }))
}

/**
 * Whether a path holds a file.
 * @param path - absolute path.
 * @returns false also when nothing readable is there.
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing or unreadable path is no file.
    return false
  }
}
