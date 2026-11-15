/**
 * An in-memory WASD Engine site for the multiplayer specs: the public server sizes, the owner's servers API, server
 * builds, and lobby statistics, as the backend answers them, with every call recorded.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unzipSync } from 'fflate'

/** The site's origin. */
export const ORIGIN = 'https://site.test'

/** The signed-in account's token. */
export const TOKEN = 'wasd_token'

/** The released game the specs' projects link to. */
export const GAME = { id: 'game-1', slug: 'defenders-1', title: 'Defenders', url: `${ORIGIN}/games/defenders-1`, version: 2 }

/** The sizes `GET /api/v1/servers/plans` lists. */
export const PLANS = {
  currency: 'usd',
  region: { id: 'us-west-2', name: 'Oregon' },
  sizes: [
    { id: 'small', name: 'Small', price_cents: 500, interval: 'month', slots: 1, cpu: { guaranteed_cores: 0.125, burst_cores: 1 }, ram_mb: 256, bandwidth_gb: 150, storage_gb: 5, players_at_once: 10, player_hours_per_month: 1500 },
    { id: 'medium', name: 'Medium', price_cents: 1000, interval: 'month', slots: 2, cpu: { guaranteed_cores: 0.25, burst_cores: 1 }, ram_mb: 512, bandwidth_gb: 300, storage_gb: 10, players_at_once: 25, player_hours_per_month: 3000 },
    { id: 'large', name: 'Large', price_cents: 2000, interval: 'month', slots: 4, cpu: { guaranteed_cores: 0.5, burst_cores: 2 }, ram_mb: 1024, bandwidth_gb: 600, storage_gb: 20, players_at_once: 50, player_hours_per_month: 4000 },
    { id: 'xl', name: 'XL', price_cents: 5000, interval: 'month', slots: 10, cpu: { guaranteed_cores: 1.25, burst_cores: 4 }, ram_mb: 2560, bandwidth_gb: 1500, storage_gb: 50, players_at_once: 100, player_hours_per_month: 10_000 },
  ],
  bandwidth_policy: { emails_at_percent: [70, 90, 100], at_limit: 'The server stops for the rest of its billing month and starts again when the allowance resets.' },
  purchase: { requires: 'A valid payment method on the account.' },
  estimate_basis: 'About 80 MB of traffic per player-hour.',
  available: true,
  sleep: {
    after_minutes: 15,
    always_on_sizes: ['medium', 'large', 'xl'],
    summary: 'A server with no players for 15 minutes sleeps, keeping its world, and wakes in a few seconds when a player joins. Medium, Large, and XL servers can stay on instead, so the world keeps going while nobody plays.',
  },
}

/** One recorded call. */
export interface SiteCall {
  readonly method: string
  /** Path and query. */
  readonly path: string
  readonly authorized: boolean
  readonly body?: unknown
  /** The file names of an uploaded ZIP. */
  readonly files?: string[]
}

/** A server as the site keeps it. */
export interface SiteServer {
  id: string
  game_id: string
  name: string
  size: string
  state: string
  players_online: number
  version: number | null
  pending: { kind: string; size: string | null; confirm_url: string; expires_at: string } | null
  always_on?: boolean
  sleeps_after_minutes?: number | null
  granted?: boolean
}

/** Options of {@link multiplayerSite}. */
export interface SiteOptions {
  /** The sizes the site lists; `error` answers 500. */
  readonly plans?: typeof PLANS | 'error'
  /** The lobby statistics: `paused` past the relay's fair use, `unavailable` (503) while lobbies are off. */
  readonly lobbies?: 'paused' | 'unavailable'
  /** The free servers the account was given, which the sizes list only for a signed-in call. */
  readonly grants?: readonly { size: string; granted: number; in_use: number; available: number }[]
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const failure = (status: number, code: string, message: string): Response => json(status, { type: 'error', error: { type: code, code, message } })

function serverJson(server: SiteServer) {
  return {
    ...server,
    size_name: PLANS.sizes.find(size => size.id === server.size)?.name ?? server.size,
    address: server.state === 'running' ? `wss://host-1.site.test/s/${server.id}` : null,
    cpu_percent: null,
    ram_mb: null,
    bandwidth: { used_bytes: 18e9, allowance_bytes: 150e9, percent: 12, period_start: '2026-11-01T00:00:00Z', period_end: '2026-12-01T00:00:00Z' },
    storage: { used_bytes: 1e9, limit_bytes: 5e9 },
    last_backup_at: null,
    price_cents: 500,
    created_at: '2026-11-01T00:00:00Z',
  }
}

/**
 * Create a site.
 * @param options - the sizes it lists.
 * @returns the site's servers, its recorded calls, and its fetch.
 */
export function multiplayerSite(options: SiteOptions = {}) {
  const servers = new Map<string, SiteServer>()
  const calls: SiteCall[] = []
  const builds: { game: string; version: string | null; files: string[] }[] = []
  let next = 1
  const pending = (server: SiteServer, kind: string, size: string | null) => {
    server.pending = { kind, size, confirm_url: `${ORIGIN}/servers/confirm/token-${String(next++)}`, expires_at: '2026-11-13T00:00:00Z' }
    return json(202, { server: serverJson(server), confirm_url: server.pending.confirm_url, expires_at: server.pending.expires_at })
  }
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = init?.method ?? 'GET'
    const authorized = new Headers(init?.headers).get('x-dsh-auth-token') === TOKEN
    let body: unknown
    let files: string[] | undefined
    if (typeof init?.body === 'string') body = JSON.parse(init.body)
    else if (init?.body instanceof Blob) files = Object.keys(unzipSync(new Uint8Array(await init.body.arrayBuffer()))).sort()
    calls.push({ method, path: `${url.pathname}${url.search}`, authorized, ...body === undefined ? {} : { body }, ...files === undefined ? {} : { files } })
    if (init?.redirect !== 'error') throw new Error('the multiplayer API must not follow redirects')
    if (url.pathname === '/api/v1/servers/plans') {
      if (options.plans === 'error') return json(500, {})
      return json(200, { ...options.plans ?? PLANS, ...authorized && options.grants !== undefined ? { grants: options.grants } : {} })
    }
    if (!authorized) return failure(401, 'authentication_error', 'Missing, invalid, or expired WASD Engine token.')
    if (url.pathname === '/api/v1/play/stats') {
      if (options.lobbies === 'unavailable') return failure(503, 'multiplayer_unavailable', 'Online play isn\'t available yet.')
      const paused = options.lobbies === 'paused'
      const relay = { bytes_this_month: paused ? 2001.2e9 : 12.34e9, soft_cap_bytes: 2000e9, available: !paused, paused_until: paused ? '2026-12-01T00:00:00Z' : null }
      return json(200, { lobbies_open: 3, players_online: 7, relay, month: '2026-11' })
    }
    const build = /^\/api\/v1\/games\/([^/]+)\/server-builds$/u.exec(url.pathname)
    if (build !== null && method === 'POST') {
      builds.push({ game: build[1] as string, version: url.searchParams.get('version'), files: files ?? [] })
      return json(201, { build: { version: Number(url.searchParams.get('version')), bytes: 1234, sha256: 'ab'.repeat(32), created_at: '2026-11-12T00:00:00Z' } })
    }
    if (url.pathname === '/api/v1/servers' && method === 'POST') {
      const request = body as { game_id: string; size: string; name?: string }
      const server: SiteServer = { id: `server-${String(next++)}`, game_id: request.game_id, name: request.name ?? GAME.title, size: request.size, state: 'awaiting_confirmation', players_online: 0, version: null, pending: null }
      servers.set(server.id, server)
      return pending(server, 'create', request.size)
    }
    if (url.pathname === '/api/v1/servers' && method === 'GET') {
      return json(200, { servers: [...servers.values()].filter(server => server.game_id === url.searchParams.get('game_id')).map(serverJson) })
    }
    const match = /^\/api\/v1\/servers\/([^/]+)(?:\/(actions|deploy|logs|backups))?$/u.exec(url.pathname)
    const server = match === null ? undefined : servers.get(match[1] as string)
    if (match === null || server === undefined) return failure(404, 'not_found_error', 'No such server.')
    switch (`${method} ${match[2] ?? ''}`) {
      case 'GET ': return json(200, { server: serverJson(server) })
      case 'PATCH ': return pending(server, 'resize', (body as { size: string }).size)
      case 'DELETE ': return pending(server, 'delete', null)
      case 'POST actions': return json(200, { server: serverJson(server) })
      case 'POST deploy': return json(200, { server: serverJson({ ...server, version: (body as { version?: number }).version ?? 3 }) })
      case 'GET logs': return json(200, { lines: [{ at: '2026-11-12T10:00:00Z', stream: 'stdout', text: 'Server ready' }, { at: '2026-11-12T10:00:01Z', stream: 'system', text: 'Restarted' }].slice(0, Number(url.searchParams.get('limit'))) })
      case 'GET backups': return json(200, { backups: [{ id: 'backup-1', created_at: '2026-11-11T00:00:00Z', bytes: 1000, reason: 'daily' }] })
      default: return failure(405, 'invalid_request_error', 'Not allowed.')
    }
  }
  /**
   * Add a running server of the linked game.
   * @param fields - fields to change.
   * @returns the server.
   */
  const addServer = (fields: Partial<SiteServer> = {}): SiteServer => {
    const server: SiteServer = { id: `server-${String(next++)}`, game_id: GAME.id, name: 'Main', size: 'small', state: 'running', players_online: 3, version: 2, pending: null, ...fields }
    servers.set(server.id, server)
    return server
  }
  return { servers, calls, builds, addServer, fetch: fetchSite }
}

const folders: string[] = []

/** Options of {@link multiplayerProject}. */
export interface ProjectOptions {
  /** Link the project to {@link GAME}; default true. */
  readonly linked?: boolean
  /** The `wasd_multiplayer.cfg` text. */
  readonly config?: string
  /** Put the add-on's main script into the project. */
  readonly addon?: boolean
}

/**
 * A Godot project folder, optionally linked to {@link GAME} on {@link ORIGIN}.
 * @param options - whether it is linked, and a `wasd_multiplayer.cfg` text.
 * @returns the absolute folder.
 */
export async function multiplayerProject(options: ProjectOptions = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-multiplayer-'))
  folders.push(dir)
  await writeFile(join(dir, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Defenders"\nrun/main_scene="res://main.tscn"\n\n[autoload]\n\nScore="*res://score.gd"\n')
  if (options.linked !== false) {
    await mkdir(join(dir, '.wasdengine'), { recursive: true })
    await writeFile(join(dir, '.wasdengine', 'game.json'), JSON.stringify({ format: 1, games: { [ORIGIN]: GAME } }))
  }
  if (options.config !== undefined) await writeFile(join(dir, 'wasd_multiplayer.cfg'), options.config)
  if (options.addon === true) {
    await mkdir(join(dir, 'addons', 'wasd_multiplayer'), { recursive: true })
    await writeFile(join(dir, 'addons', 'wasd_multiplayer', 'wasd_multiplayer.gd'), 'extends Node\n')
  }
  return dir
}

/** Remove the folders {@link multiplayerProject} made. */
export async function removeProjects(): Promise<void> {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
}
