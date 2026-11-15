/**
 * The WASD Engine site's multiplayer API as the multiplayer tools call it: the public server sizes
 * (`GET /api/v1/servers/plans`, which also lists the free servers WASD Engine gave the account when read with its
 * sign-in), a game's dedicated servers (`/api/v1/servers`), server builds
 * (`POST /api/v1/games/<id>/server-builds`), and the player-hosted lobby statistics (`GET /api/v1/play/stats`). Calls
 * carry the signed-in token in `x-dsh-auth-token`, never follow redirects, and turn the site's refusals into
 * {@link MultiplayerError}s whose messages say what the user or the agent can do. Prices and sizes always come from the
 * site, so the engine never states one of its own.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-api
 */
import { openAsBlob } from 'node:fs'
import { z } from 'zod'
import type { SiteAccess } from './release.ts'

/** A multiplayer call that could not finish; the message says what the user or the agent can do. */
export class MultiplayerError extends Error {
  override name = 'MultiplayerError'

  /**
   * @param message - what went wrong and what to do.
   * @param code - the site's error code, such as `servers_unavailable`, when it sent one.
   * @param options - the cause.
   */
  constructor(message: string, readonly code?: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** A player token of the signed-in account in one game. */
const PlayTokenJson = z.object({ token: z.string().startsWith('wpt1.') })

/** One server size, as the site sells it. */
export const ServerSize = z.object({
  id: z.string(),
  name: z.string(),
  price_cents: z.number().int(),
  interval: z.string(),
  slots: z.number(),
  cpu: z.object({ guaranteed_cores: z.number(), burst_cores: z.number() }),
  ram_mb: z.number(),
  bandwidth_gb: z.number(),
  storage_gb: z.number(),
  players_at_once: z.number(),
  player_hours_per_month: z.number(),
})
/** One server size, as the site sells it. */
export type ServerSize = z.infer<typeof ServerSize>

/** Free servers of one size that WASD Engine gave the signed-in account. */
export const ServerGrant = z.object({
  size: z.string(),
  granted: z.number().int(),
  in_use: z.number().int(),
  // How many more servers of the size the account creates free.
  available: z.number().int(),
})
/** Free servers of one size that WASD Engine gave the signed-in account. */
export type ServerGrant = z.infer<typeof ServerGrant>

/** The site's server sizes and the rules every size shares. */
export const ServerPlans = z.object({
  currency: z.string(),
  region: z.object({ id: z.string(), name: z.string() }),
  sizes: z.array(ServerSize),
  bandwidth_policy: z.object({ emails_at_percent: z.array(z.number()), at_limit: z.string() }),
  purchase: z.object({ requires: z.string() }),
  estimate_basis: z.string(),
  available: z.boolean(),
  // The signed-in account's free servers; a site reads them only with the sign-in, and sites before grants send none.
  grants: z.array(ServerGrant).optional(),
  // How servers sleep without players and which sizes may stay on; sites before sleeping send none.
  sleep: z.object({
    after_minutes: z.number().int().nullish(),
    always_on_sizes: z.array(z.string()),
    summary: z.string(),
  }).optional(),
})
/** The site's server sizes and the rules every size shares. */
export type ServerPlans = z.infer<typeof ServerPlans>

const Pending = z.object({
  kind: z.string(),
  size: z.string().nullish(),
  confirm_url: z.string(),
  expires_at: z.string(),
})

/** One dedicated server, as the site reports it. */
export const ServerRecord = z.object({
  id: z.string(),
  game_id: z.string(),
  name: z.string(),
  size: z.string(),
  size_name: z.string().nullish(),
  state: z.string(),
  address: z.string().nullish(),
  version: z.number().int().nullish(),
  players_online: z.number().int().nullish(),
  cpu_percent: z.number().nullish(),
  ram_mb: z.number().nullish(),
  bandwidth: z.object({
    used_bytes: z.number(),
    allowance_bytes: z.number(),
    percent: z.number(),
    period_start: z.string().nullish(),
    period_end: z.string().nullish(),
  }).nullish(),
  storage: z.object({ used_bytes: z.number(), limit_bytes: z.number() }).nullish(),
  last_backup_at: z.string().nullish(),
  price_cents: z.number().int().nullish(),
  // Whether a free server WASD Engine gave the account covers it; its price_cents is then 0.
  granted: z.boolean().nullish(),
  created_at: z.string().nullish(),
  always_on: z.boolean().nullish(),
  sleeps_after_minutes: z.number().int().nullish(),
  pending: Pending.nullish(),
})
/** One dedicated server, as the site reports it. */
export type ServerRecord = z.infer<typeof ServerRecord>

/** A request the person confirms on the site before anything is charged or deleted. */
export const PendingServer = z.object({ server: ServerRecord, confirm_url: z.string(), expires_at: z.string() })
/** A request the person confirms on the site before anything is charged or deleted. */
export type PendingServer = z.infer<typeof PendingServer>

const LogLine = z.object({ at: z.string().nullish(), stream: z.string(), text: z.string() })
/** One line of a server's log. */
export type ServerLogLine = z.infer<typeof LogLine>

const Backup = z.object({ id: z.string(), created_at: z.string().nullish(), bytes: z.number().nullish(), reason: z.string().nullish() })
/** One backup of a server's world. */
export type ServerBackup = z.infer<typeof Backup>

/**
 * The player-hosted lobbies of a released game. The relay's fair use (`soft_cap_bytes`, 0 for none) pauses the relay
 * for the game until `paused_until` once its traffic this month reaches it (`available: false`).
 */
export const LobbyStats = z.object({
  lobbies_open: z.number().int(),
  players_online: z.number().int(),
  relay: z.object({
    bytes_this_month: z.number(),
    soft_cap_bytes: z.number(),
    available: z.boolean().optional(),
    paused_until: z.string().nullish(),
  }),
  month: z.string(),
})
/** The player-hosted lobbies of a released game. */
export type LobbyStats = z.infer<typeof LobbyStats>

const ServerBuild = z.object({ version: z.number().int(), bytes: z.number(), sha256: z.string(), created_at: z.string().nullish() })
/** A stored server build. */
export type ServerBuild = z.infer<typeof ServerBuild>

const ErrorJson = z.object({ error: z.object({ message: z.string(), type: z.string().optional(), code: z.string().optional() }) })

/** Server actions the site performs. */
export type ServerAction = 'start' | 'stop' | 'restart' | 'backup' | 'restore'

/** The site's multiplayer API for one signed-in account, or for anyone where a route is public. */
export class MultiplayerApi {
  /**
   * @param access - the signed-in site; `token` may be empty for the public sizes.
   * @param fetchUrl - HTTP client.
   * @param signal - cancellation of every call.
   */
  constructor(private readonly access: SiteAccess, private readonly fetchUrl: typeof fetch, private readonly signal: AbortSignal) {}

  private async call(method: string, path: string, body?: { readonly data: BodyInit; readonly type: string }): Promise<Response> {
    const url = new URL(path, this.access.origin)
    try {
      return await this.fetchUrl(url, {
        method,
        redirect: 'error',
        signal: this.signal,
        headers: {
          ...this.access.token === '' ? {} : { 'x-dsh-auth-token': this.access.token },
          ...body === undefined ? {} : { 'content-type': body.type },
        },
        ...body === undefined ? {} : { body: body.data },
      })
    } catch (error) {
      if (this.signal.aborted) throw error
      throw new MultiplayerError(`Cannot reach WASD Engine at ${this.access.origin}: ${(error as Error).message}`, undefined, { cause: error })
    }
  }

  private async failure(response: Response, doing: string): Promise<MultiplayerError> {
    let message: string | undefined
    let code: string | undefined
    try {
      const parsed = ErrorJson.safeParse(await response.json())
      if (parsed.success) {
        message = parsed.data.error.message
        code = parsed.data.error.code ?? parsed.data.error.type
      }
    } catch {
      // Not a JSON error body: the status alone explains it.
    }
    if (response.status === 401) return new MultiplayerError('The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then try again.', code)
    if (code === 'servers_unavailable') return new MultiplayerError('WASD Engine does not offer dedicated servers yet. Player-hosted multiplayer works without them.', code)
    if (code === 'multiplayer_unavailable') return new MultiplayerError('WASD Engine does not run player-hosted lobbies right now, so there are no lobby statistics. Try again later.', code)
    if (response.status >= 500 || message === undefined) return new MultiplayerError(`WASD Engine could not ${doing} (HTTP ${response.status}). Try again later.`, code)
    return new MultiplayerError(`WASD Engine could not ${doing}: ${message}`, code)
  }

  private async json<T>(response: Response, schema: z.ZodType<T>, doing: string): Promise<T> {
    if (!response.ok) throw await this.failure(response, doing)
    const parsed = schema.safeParse(await response.json())
    if (!parsed.success) throw new MultiplayerError(`WASD Engine answered in an unexpected way while trying to ${doing}.`)
    return parsed.data
  }

  /**
   * Mint a player token of the signed-in account for one game, which a started desktop build signs in with.
   * @param gameId - the game.
   * @returns the token.
   */
  async playToken(gameId: string): Promise<string> {
    const body = { data: JSON.stringify({ game_id: gameId }), type: 'application/json' }
    return (await this.json(await this.call('POST', '/api/v1/play/token', body), PlayTokenJson, 'sign you in to play online')).token
  }

  /**
   * Read the server sizes, which the site serves without a sign-in too.
   * @returns the server sizes and their prices, with the account's free servers when the sign-in came along.
   */
  async plans(): Promise<ServerPlans> {
    return await this.json(await this.call('GET', '/api/v1/servers/plans'), ServerPlans, 'read the server sizes')
  }

  /**
   * Ask for a new server; nothing is charged until the person confirms on the site.
   * @param gameId - the game.
   * @param size - the size id.
   * @param name - the server's name, when the call gives one.
   * @returns the pending server and its confirmation page.
   */
  async create(gameId: string, size: string, name: string | undefined): Promise<PendingServer> {
    const body = JSON.stringify({ game_id: gameId, size, ...name === undefined ? {} : { name } })
    return await this.json(await this.call('POST', '/api/v1/servers', { data: body, type: 'application/json' }), PendingServer, 'create the server')
  }

  /**
   * List the account's servers of a game.
   * @param gameId - the game.
   * @returns the account's servers of the game.
   */
  async servers(gameId: string): Promise<ServerRecord[]> {
    const response = await this.call('GET', `/api/v1/servers?${new URLSearchParams({ game_id: gameId }).toString()}`)
    return (await this.json(response, z.object({ servers: z.array(ServerRecord) }), 'list the servers')).servers
  }

  /**
   * Read one of the account's servers.
   * @param id - the server.
   * @returns the server.
   */
  async server(id: string): Promise<ServerRecord> {
    return (await this.json(await this.call('GET', `/api/v1/servers/${encodeURIComponent(id)}`), z.object({ server: ServerRecord }), 'read the server')).server
  }

  /**
   * Ask for a new size; nothing changes until the person confirms on the site.
   * @param id - the server.
   * @param size - the new size id.
   * @returns the pending change and its confirmation page.
   */
  async resize(id: string, size: string): Promise<PendingServer> {
    const response = await this.call('PATCH', `/api/v1/servers/${encodeURIComponent(id)}`, { data: JSON.stringify({ size }), type: 'application/json' })
    return await this.json(response, PendingServer, 'change the server\'s size')
  }

  /**
   * Ask to delete a server; nothing changes until the person confirms on the site.
   * @param id - the server.
   * @returns the pending deletion and its confirmation page.
   */
  async remove(id: string): Promise<PendingServer> {
    return await this.json(await this.call('DELETE', `/api/v1/servers/${encodeURIComponent(id)}`), PendingServer, 'delete the server')
  }

  /**
   * Start, stop, restart, back up, or restore a server.
   * @param id - the server.
   * @param action - the action.
   * @param backupId - the backup to restore.
   * @returns the server afterwards.
   */
  async act(id: string, action: ServerAction, backupId: string | undefined): Promise<ServerRecord> {
    const body = JSON.stringify({ action, ...backupId === undefined ? {} : { backup_id: backupId }, ...action === 'restore' ? { confirm: true } : {} })
    const response = await this.call('POST', `/api/v1/servers/${encodeURIComponent(id)}/actions`, { data: body, type: 'application/json' })
    return (await this.json(response, z.object({ server: ServerRecord }), `${action} the server`)).server
  }

  /**
   * Deploy a release's server build to a server, which restarts it with an in-game warning.
   * @param id - the server.
   * @param version - the release; undefined deploys the newest uploaded build.
   * @returns the server afterwards.
   */
  async deploy(id: string, version: number | undefined): Promise<ServerRecord> {
    const body = JSON.stringify(version === undefined ? {} : { version })
    const response = await this.call('POST', `/api/v1/servers/${encodeURIComponent(id)}/deploy`, { data: body, type: 'application/json' })
    return (await this.json(response, z.object({ server: ServerRecord }), 'deploy the server build')).server
  }

  /**
   * Read the end of a server's log.
   * @param id - the server.
   * @param limit - most lines.
   * @returns the server's latest log lines.
   */
  async logs(id: string, limit: number): Promise<ServerLogLine[]> {
    const response = await this.call('GET', `/api/v1/servers/${encodeURIComponent(id)}/logs?limit=${String(limit)}`)
    return (await this.json(response, z.object({ lines: z.array(LogLine) }), 'read the server log')).lines
  }

  /**
   * List a server's backups.
   * @param id - the server.
   * @returns the server's backups, newest first.
   */
  async backups(id: string): Promise<ServerBackup[]> {
    const response = await this.call('GET', `/api/v1/servers/${encodeURIComponent(id)}/backups`)
    return (await this.json(response, z.object({ backups: z.array(Backup) }), 'list the server\'s backups')).backups
  }

  /**
   * Store a release's dedicated server build.
   * @param gameId - the game.
   * @param version - the release the build belongs to.
   * @param archive - absolute path of the ZIP that holds `server.x86_64`.
   * @returns the stored build.
   */
  async uploadBuild(gameId: string, version: number, archive: string): Promise<ServerBuild> {
    const response = await this.call('POST', `/api/v1/games/${encodeURIComponent(gameId)}/server-builds?version=${String(version)}`, {
      data: await openAsBlob(archive), type: 'application/zip',
    })
    return (await this.json(response, z.object({ build: ServerBuild }), 'store the server build')).build
  }

  /**
   * Read the player-hosted play of one of the account's games.
   * @param gameId - the game.
   * @returns the game's player-hosted lobbies and relay use this month.
   */
  async lobbyStats(gameId: string): Promise<LobbyStats> {
    const response = await this.call('GET', `/api/v1/play/stats?${new URLSearchParams({ game_id: gameId }).toString()}`)
    return await this.json(response, LobbyStats, 'read the lobby statistics')
  }
}

/**
 * A price in the site's currency as people read it.
 * @param cents - the price in cents.
 * @param currency - ISO currency code; only `usd` prints with `$`.
 * @returns such as `$5` or `$12.50`.
 */
export function formatPrice(cents: number, currency: string): string {
  const amount = cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)
  return currency.toLowerCase() === 'usd' ? `$${amount}` : `${amount} ${currency.toUpperCase()}`
}
