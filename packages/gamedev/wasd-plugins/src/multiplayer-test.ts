/**
 * Local multiplayer tests: a game's host, or its dedicated server, and one to three clients run as headless instances
 * of the project on this computer and talk over loopback WebSocket in the WASD Multiplayer add-on's test mode, with no
 * WASD Engine service and made-up players. A dedicated server test also checks join tickets: the server gets a random
 * ticket key, and each client a ticket signed with it, as the site signs them. Every instance prints
 * `WASD_TEST_EVENT {json}` lines as it goes and one `WASD_TEST_STATS {json}` line at its end; the test turns the
 * host's or server's statistics into the game's traffic per player-hour, its memory, and its processor use, and saves
 * them in `.wasdengine/multiplayer-test.json`, which the server sizes are fitted to. The add-on counts multiplayer
 * payload alone, so the traffic adds {@link MESSAGE_OVERHEAD_BYTES} for each message's headers on the network.
 * @module @deepseek-ai/dsh-wasd-plugins/src/multiplayer-test
 */
import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { GodotInstanceReport, GodotInstanceSpec } from '@deepseek-ai/dsh-godot'
import { z } from 'zod'
import type { MultiplayerMode } from './multiplayer-project.ts'
import type { ServerSize } from './multiplayer-api.ts'
import { STATE_DIR } from './release.ts'

/** The test results file inside {@link STATE_DIR}. */
export const TEST_FILE = 'multiplayer-test.json'

/** The line prefix of an instance's statistics. */
export const STATS_PREFIX = 'WASD_TEST_STATS '

/** The line prefix of an instance's events. */
export const EVENT_PREFIX = 'WASD_TEST_EVENT '

/** The events that report a problem: a failed start or join, a refused ticket, or a warning. */
const PROBLEM_EVENTS: ReadonlySet<string> = new Set(['failed', 'rejected', 'warning'])

/** Most problems a test lists per instance. */
const MAX_PROBLEMS = 5

/**
 * Bytes one multiplayer message costs on the network beyond its payload, acknowledgments included: about 6 bytes of
 * WebSocket frame, 22 of TLS record, 52 of TCP/IP headers, and a share of the other side's acknowledgments. WebRTC's
 * UDP, DTLS, and SCTP headers cost about as much.
 */
export const MESSAGE_OVERHEAD_BYTES = 100

/** Milliseconds the clients wait after the host or server starts, so it listens before they connect. */
export const CLIENT_START_DELAY_MS = 3000

/** Frames per second the processor estimate assumes for the server's game loop. */
export const ESTIMATE_FPS = 60

/** One instance's statistics, as its `WASD_TEST_STATS` line reports them. */
export const InstanceStats = z.object({
  role: z.string().optional(),
  name: z.string().optional(),
  connected: z.boolean().optional(),
  peers: z.number().int().min(0),
  bytes_in: z.number().min(0),
  bytes_out: z.number().min(0),
  packets_in: z.number().min(0).optional(),
  packets_out: z.number().min(0).optional(),
  tick_ms_avg: z.number().min(0),
  tick_ms_max: z.number().min(0),
  rss_bytes: z.number().min(0),
  seconds: z.number().min(0).optional(),
})
/** One instance's statistics, as its `WASD_TEST_STATS` line reports them. */
export type InstanceStats = z.infer<typeof InstanceStats>

/** The fields of a `WASD_TEST_EVENT` line that the test reads. */
const TestEvent = z.object({ event: z.string(), message: z.string().optional(), error: z.string().optional() })

/** What a test measured, as `.wasdengine/multiplayer-test.json` keeps it. */
export const TestRecord = z.object({
  format: z.literal(1),
  measured_at: z.string(),
  mode: z.enum(['player_hosted', 'dedicated']),
  clients: z.number().int(),
  connected: z.number().int(),
  seconds: z.number(),
  mb_per_player_hour: z.number(),
  cpu_cores: z.number(),
  memory_mb: z.number(),
  tick_ms_avg: z.number(),
  tick_ms_max: z.number(),
})
/** What a test measured, as `.wasdengine/multiplayer-test.json` keeps it. */
export type TestRecord = z.infer<typeof TestRecord>

/** The instances of one test, and the values the report needs about them. */
export interface TestPlan {
  /** The host or server first, then the clients. */
  readonly instances: GodotInstanceSpec[]
  /** Seconds each client stays connected. */
  readonly clientSeconds: number
}

/**
 * Sign a join ticket as the site signs one: `wjt1.<base64url payload>.<base64url HMAC-SHA256>`.
 * @param key - the server's ticket key, raw bytes.
 * @param payload - the server id, player id, player name, and expiry.
 * @returns the ticket.
 */
export function signJoinTicket(
  key: Buffer, payload: { readonly s: string; readonly p: string; readonly n: string; readonly exp: number },
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const signature = createHmac('sha256', key).update(`wjt1.${body}`).digest('base64url')
  return `wjt1.${body}.${signature}`
}

/** A random player id in the site's form: 20 lowercase base32 characters. */
function testPlayerId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  return [...randomBytes(20)].map(byte => alphabet[byte % 32] as string).join('')
}

/**
 * Lay out one test's instances.
 * @param mode - player-hosted (a host and its clients) or dedicated (a server and its clients).
 * @param clients - 1 to 3 clients.
 * @param seconds - how long the host or server runs.
 * @param port - the loopback port the host or server listens on.
 * @returns the instances and how long the clients stay connected.
 */
export function planTest(mode: MultiplayerMode, clients: number, seconds: number, port: number): TestPlan {
  const clientSeconds = Math.max(1, seconds - Math.ceil(CLIENT_START_DELAY_MS / 1000) - 1)
  const shared = { WASD_TEST_PORT: String(port) }
  const instances: GodotInstanceSpec[] = []
  if (mode === 'player_hosted') {
    instances.push({ name: 'host', delayMs: 0, env: { ...shared, WASD_MULTIPLAYER_TEST: 'host', WASD_TEST_NAME: 'host', WASD_TEST_SECONDS: String(seconds) } })
    for (let index = 1; index <= clients; index++) {
      instances.push({
        name: `player${String(index + 1)}`,
        delayMs: CLIENT_START_DELAY_MS + index * 250,
        env: { ...shared, WASD_MULTIPLAYER_TEST: 'client', WASD_TEST_NAME: `player${String(index + 1)}`, WASD_TEST_SECONDS: String(clientSeconds) },
      })
    }
    return { instances, clientSeconds }
  }
  const key = randomBytes(32)
  const serverId = randomUUID()
  instances.push({
    name: 'server',
    delayMs: 0,
    env: {
      ...shared,
      WASD_MULTIPLAYER_TEST: 'server',
      WASD_SERVER: '1',
      WASD_SERVER_ID: serverId,
      WASD_SERVER_NAME: 'Local test server',
      WASD_PORT: String(port),
      WASD_TICKET_KEY: key.toString('base64'),
      WASD_TEST_NAME: 'server',
      WASD_TEST_SECONDS: String(seconds),
    },
  })
  const expires = Math.floor(Date.now() / 1000) + seconds + 120
  for (let index = 1; index <= clients; index++) {
    const name = `player${String(index)}`
    instances.push({
      name,
      delayMs: CLIENT_START_DELAY_MS + index * 250,
      env: {
        ...shared,
        WASD_MULTIPLAYER_TEST: 'client',
        WASD_TEST_NAME: name,
        WASD_TEST_TICKET: signJoinTicket(key, { s: serverId, p: testPlayerId(), n: name, exp: expires }),
        WASD_TEST_SECONDS: String(clientSeconds),
      },
    })
  }
  return { instances, clientSeconds }
}

/**
 * A free loopback TCP port, for the host or server of one test.
 * @returns the port.
 */
export async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { resolve() })
  })
  const address = server.address()
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  if (address === null || typeof address === 'string') throw new Error('The system gave no loopback port.')
  return address.port
}

/**
 * An instance's statistics: its last `WASD_TEST_STATS` line on standard output or standard error.
 * @param report - how the instance ended.
 * @returns the statistics, or undefined when it printed none.
 */
export function instanceStats(report: GodotInstanceReport): InstanceStats | undefined {
  const lines = `${report.stdout}\n${report.stderr}`.split(/\r?\n/u).filter(line => line.includes(STATS_PREFIX))
  for (const line of lines.reverse()) {
    try {
      const parsed = InstanceStats.safeParse(JSON.parse(line.slice(line.indexOf(STATS_PREFIX) + STATS_PREFIX.length)))
      if (parsed.success) return parsed.data
    } catch {
      // A damaged line: an earlier one may still parse.
    }
  }
  return undefined
}

/**
 * The problems an instance reported: its `failed`, `rejected`, and `warning` events, each as `<event>: <message>`.
 * @param report - how the instance ended.
 * @returns at most five problems, in the order the instance reported them.
 */
export function instanceProblems(report: GodotInstanceReport): string[] {
  const problems: string[] = []
  for (const line of `${report.stdout}\n${report.stderr}`.split(/\r?\n/u)) {
    const start = line.indexOf(EVENT_PREFIX)
    if (start < 0) continue
    let parsed: ReturnType<typeof TestEvent.safeParse>
    try {
      parsed = TestEvent.safeParse(JSON.parse(line.slice(start + EVENT_PREFIX.length)))
    } catch {
      // A damaged line reports nothing.
      continue
    }
    if (!parsed.success || !PROBLEM_EVENTS.has(parsed.data.event)) continue
    const { event, message, error } = parsed.data
    const detail = message !== undefined && message !== '' ? message : error ?? ''
    const problem = detail === '' ? event : `${event}: ${detail}`
    if (!problems.includes(problem)) problems.push(problem)
    if (problems.length === MAX_PROBLEMS) break
  }
  return problems
}

/**
 * Whether a client's statistics show that it joined: it reached the host or server, which counts as its peer.
 * @param stats - the client's statistics.
 * @returns whether it connected.
 */
export function clientConnected(stats: InstanceStats): boolean {
  return stats.peers >= 1 && stats.connected !== false
}

/** How one size of server would hold the tested game. */
export interface SizeEstimate {
  /** The size id. */
  readonly size: string
  /** Hours of play the size's monthly bandwidth lasts at the measured traffic. */
  readonly playerHoursPerMonth: number
  /** Whether the size's memory and guaranteed processor share hold what the test measured. */
  readonly holdsTest: boolean
}

/**
 * Fit the server sizes to a test.
 * @param record - what the test measured.
 * @param sizes - the site's sizes.
 * @returns one estimate per size, in the site's order.
 */
export function estimateSizes(record: TestRecord, sizes: readonly ServerSize[]): SizeEstimate[] {
  return sizes.map(size => ({
    size: size.id,
    playerHoursPerMonth: record.mb_per_player_hour <= 0
      ? size.player_hours_per_month
      : Math.floor(size.bandwidth_gb * 1000 / record.mb_per_player_hour),
    holdsTest: record.memory_mb <= size.ram_mb * 0.8 && record.cpu_cores <= size.cpu.guaranteed_cores,
  }))
}

/**
 * Turn the host's or server's statistics into what the test measured.
 * @param mode - the test's mode.
 * @param clients - the clients the test started.
 * @param connected - the clients that reported a peer.
 * @param seconds - how long the clients stayed connected.
 * @param host - the host's or server's statistics.
 * @returns the record.
 */
export function testRecord(mode: MultiplayerMode, clients: number, connected: number, seconds: number, host: InstanceStats): TestRecord {
  const traffic = host.bytes_in + host.bytes_out + MESSAGE_OVERHEAD_BYTES * ((host.packets_in ?? 0) + (host.packets_out ?? 0))
  const players = Math.max(1, connected)
  return {
    format: 1,
    measured_at: new Date().toISOString(),
    mode,
    clients,
    connected,
    seconds,
    mb_per_player_hour: Math.round(traffic / players / seconds * 3600 / 1e6 * 10) / 10,
    cpu_cores: Math.round(Math.min(1, host.tick_ms_avg / 1000 * ESTIMATE_FPS) * 1000) / 1000,
    memory_mb: Math.round(host.rss_bytes / (1024 * 1024)),
    tick_ms_avg: Math.round(host.tick_ms_avg * 100) / 100,
    tick_ms_max: Math.round(host.tick_ms_max * 100) / 100,
  }
}

/**
 * Save what a test measured.
 * @param projectDir - absolute folder holding `project.godot`.
 * @param record - the measurement.
 */
export async function saveTestRecord(projectDir: string, record: TestRecord): Promise<void> {
  await mkdir(join(projectDir, STATE_DIR), { recursive: true })
  await writeFile(join(projectDir, STATE_DIR, TEST_FILE), `${JSON.stringify(record, null, 2)}\n`)
}

/**
 * Read what the project's last test measured.
 * @param projectDir - absolute folder holding `project.godot`.
 * @returns the measurement, or undefined before the first test or for a damaged file.
 */
export async function readTestRecord(projectDir: string): Promise<TestRecord | undefined> {
  let text: string
  try {
    text = await readFile(join(projectDir, STATE_DIR, TEST_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const parsed = TestRecord.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    // Not JSON: as if the project was never tested.
    return undefined
  }
}
