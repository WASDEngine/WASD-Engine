/** Multiplayer setup edits `project.godot` and `res://wasd_multiplayer.cfg`; local tests turn instance output into a measurement. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotInstanceReport } from '@deepseek-ai/dsh-godot'
import {
  parseMultiplayerConfig, renderMultiplayerConfig, withMultiplayerAddon, withMultiplayerConfig, writeMultiplayerConfig,
  type MultiplayerConfig,
} from '../src/multiplayer-project.ts'
import {
  clientConnected, estimateSizes, instanceProblems, instanceStats, MESSAGE_OVERHEAD_BYTES, planTest, readTestRecord, testRecord, TEST_FILE,
} from '../src/multiplayer-test.ts'
import { multiplayerProject, PLANS, removeProjects } from './multiplayer-site.ts'

afterEach(removeProjects)

const CONFIG: MultiplayerConfig = { mode: 'dedicated', maxPlayers: 40, apiOrigin: 'https://site.test', appOrigin: 'https://app.test', gameId: 'game-"1"', version: 3 }

describe('the multiplayer configuration', () => {
  it('renders the [wasd] section and reads it back, ignoring other sections and unknown keys', () => {
    const text = renderMultiplayerConfig(CONFIG)
    expect(text).toContain('[wasd]\n\nmode="dedicated"\nmax_players=40\napi_origin="https://site.test"\napp_origin="https://app.test"\ngame_id="game-\\"1\\""\nversion=3\n')
    expect(parseMultiplayerConfig(`[other]\nmode="player_hosted"\n\n${text}server_fps=20\n`)).toEqual(CONFIG)
    expect(parseMultiplayerConfig('[wasd]\r\nmode="player_hosted"\r\n')).toEqual({ mode: 'player_hosted', maxPlayers: 8, apiOrigin: '', appOrigin: '', gameId: '', version: 0 })
    expect(parseMultiplayerConfig('[wasd]\nmode="mmo"\n')).toBeUndefined()
  })

  it('sets the keys WASD Engine writes and keeps the file\'s other keys, sections, comments, and line ends', () => {
    const text = [
      '; Studio settings.', '[other]', 'mode="player_hosted"', '', '[wasd]', '', 'mode = "player_hosted"', 'max_players=40',
      'site_origins=["https://play.studio.test", "https://studio.test"]', '; Quieter servers.', 'server_fps=20', 'count_traffic=false', '',
      '[studio]', 'build="nightly"', '',
    ].join('\r\n')
    expect(withMultiplayerConfig(text, CONFIG)).toBe([
      '; Studio settings.', '[other]', 'mode="player_hosted"', '', '[wasd]', '', 'mode="dedicated"', 'max_players=40',
      'site_origins=["https://play.studio.test", "https://studio.test"]', '; Quieter servers.', 'server_fps=20', 'count_traffic=false',
      'api_origin="https://site.test"', 'app_origin="https://app.test"', 'game_id="game-\\"1\\""', 'version=3', '',
      '[studio]', 'build="nightly"', '',
    ].join('\r\n'))
    expect(parseMultiplayerConfig(withMultiplayerConfig(text, CONFIG))).toEqual(CONFIG)
    // Written again, it holds the configuration already.
    expect(withMultiplayerConfig(withMultiplayerConfig(text, CONFIG), CONFIG)).toBe(withMultiplayerConfig(text, CONFIG))
  })

  it('sets a key in every place the [wasd] section holds it, and adds the section to a file without one', () => {
    expect(withMultiplayerConfig('[wasd]\ngame_id=""\n[wasd]\ngame_id="old"\nserver_fps=30', { ...CONFIG, gameId: 'new' })).toBe(
      '[wasd]\ngame_id="new"\nmode="dedicated"\nmax_players=40\napi_origin="https://site.test"\napp_origin="https://app.test"\nversion=3\n[wasd]\ngame_id="new"\nserver_fps=30\n',
    )
    expect(withMultiplayerConfig('; Nothing yet.\n', CONFIG)).toBe(`; Nothing yet.\n\n${renderMultiplayerConfig(CONFIG).slice(renderMultiplayerConfig(CONFIG).indexOf('[wasd]'))}`)
  })

  it('writes a new file for a project without one or with an empty one, and edits an existing one', async () => {
    const dir = await multiplayerProject()
    const file = join(dir, 'wasd_multiplayer.cfg')
    await writeMultiplayerConfig(dir, CONFIG)
    expect(await readFile(file, 'utf8')).toBe(renderMultiplayerConfig(CONFIG))
    await writeFile(file, ' \n')
    await writeMultiplayerConfig(dir, CONFIG)
    expect(await readFile(file, 'utf8')).toBe(renderMultiplayerConfig(CONFIG))
    await writeFile(file, '[wasd]\nserver_idle_fps=2\n')
    await writeMultiplayerConfig(dir, CONFIG)
    expect(await readFile(file, 'utf8')).toBe('[wasd]\nserver_idle_fps=2\nmode="dedicated"\nmax_players=40\napi_origin="https://site.test"\napp_origin="https://app.test"\ngame_id="game-\\"1\\""\nversion=3\n')
  })
})

describe('withMultiplayerAddon', () => {
  it('adds the autoload and the editor plugin to a project without them and keeps every other line', () => {
    const text = withMultiplayerAddon('config_version=5\n\n[application]\n\nconfig/name="Game"\n')
    expect(text).toBe([
      'config_version=5', '', '[application]', '', 'config/name="Game"', '',
      '[autoload]', '', 'WasdMultiplayer="*res://addons/wasd_multiplayer/wasd_multiplayer.gd"', '',
      '[editor_plugins]', '', 'enabled=PackedStringArray("res://addons/wasd_multiplayer/plugin.cfg")', '',
    ].join('\n'))
    expect(withMultiplayerAddon(text)).toBe(text)
  })

  it('appends the plugin to the enabled ones, rewrites a stale autoload, and keeps CRLF line ends', () => {
    const original = '[autoload]\r\n\r\nWasdMultiplayer="res://old.gd"\r\n\r\n[editor_plugins]\r\n\r\nenabled=PackedStringArray("res://addons/dialogue_manager/plugin.cfg")\r\n\r\n[rendering]\r\n\r\nx=1\r\n'
    expect(withMultiplayerAddon(original)).toBe(
      '[autoload]\r\n\r\nWasdMultiplayer="*res://addons/wasd_multiplayer/wasd_multiplayer.gd"\r\n\r\n[editor_plugins]\r\n\r\n'
      + 'enabled=PackedStringArray("res://addons/dialogue_manager/plugin.cfg", "res://addons/wasd_multiplayer/plugin.cfg")\r\n\r\n[rendering]\r\n\r\nx=1\r\n',
    )
  })
})

function report(name: string, stdout: string, stderr = ''): GodotInstanceReport {
  return { name, exitCode: 0, timedOut: false, stdout, stderr }
}

describe('local multiplayer tests', () => {
  it('start the host first and the clients after it, each with its name and how long it stays', () => {
    const plan = planTest('player_hosted', 2, 20, 4100)
    expect(plan.clientSeconds).toBe(16)
    expect(plan.instances).toEqual([
      { name: 'host', delayMs: 0, env: { WASD_TEST_PORT: '4100', WASD_MULTIPLAYER_TEST: 'host', WASD_TEST_NAME: 'host', WASD_TEST_SECONDS: '20' } },
      { name: 'player2', delayMs: 3250, env: { WASD_TEST_PORT: '4100', WASD_MULTIPLAYER_TEST: 'client', WASD_TEST_NAME: 'player2', WASD_TEST_SECONDS: '16' } },
      { name: 'player3', delayMs: 3500, env: { WASD_TEST_PORT: '4100', WASD_MULTIPLAYER_TEST: 'client', WASD_TEST_NAME: 'player3', WASD_TEST_SECONDS: '16' } },
    ])
  })

  it('read the last statistics line and the problems an instance printed', () => {
    const output = [
      'Godot Engine v4.7.2.stable',
      'WASD_TEST_EVENT {"event":"ready","role":"host","port":4100}',
      'WASD_TEST_EVENT {"event":"warning","role":"host","message":"A player sent an unknown RPC."}',
      'WASD_TEST_EVENT {"event":"rejected","role":"host","error":"bad_ticket"}',
      'WASD_TEST_EVENT {"event":"warning","role":"host","message":"A player sent an unknown RPC."}',
      'WASD_TEST_EVENT {not json',
      'WASD_TEST_STATS {"peers":1,"bytes_in":1,"bytes_out":2,"tick_ms_avg":1,"tick_ms_max":2,"rss_bytes":3}',
      'WASD_TEST_STATS {"peers":2,"bytes_in":10,"bytes_out":20,"tick_ms_avg":1,"tick_ms_max":2,"rss_bytes":3,"connected":true}',
      'WASD_TEST_STATS {"truncated',
    ].join('\n')
    expect(instanceStats(report('host', output))).toEqual({ peers: 2, bytes_in: 10, bytes_out: 20, tick_ms_avg: 1, tick_ms_max: 2, rss_bytes: 3, connected: true })
    expect(instanceStats(report('host', 'no statistics'))).toBeUndefined()
    expect(instanceProblems(report('host', output))).toEqual(['warning: A player sent an unknown RPC.', 'rejected: bad_ticket'])
    const quiet = { bytes_in: 0, bytes_out: 0, tick_ms_avg: 0, tick_ms_max: 0, rss_bytes: 0 }
    expect(clientConnected({ ...quiet, peers: 1 })).toBe(true)
    expect(clientConnected({ ...quiet, peers: 1, connected: false })).toBe(false)
    expect(clientConnected({ ...quiet, peers: 0, connected: true })).toBe(false)
  })

  it('count every message\'s headers in the traffic per player-hour and fit the sizes to memory and processor', () => {
    const record = testRecord('dedicated', 3, 3, 100, {
      peers: 3, bytes_in: 3_000_000, bytes_out: 6_000_000, packets_in: 10_000, packets_out: 20_000,
      tick_ms_avg: 5, tick_ms_max: 9, rss_bytes: 300 * 1024 * 1024,
    })
    // (9 MB of payload + 30,000 messages of headers) for 3 players over 100 seconds.
    expect(record.mb_per_player_hour).toBe(Math.round((9_000_000 + 30_000 * MESSAGE_OVERHEAD_BYTES) / 3 / 100 * 3600 / 1e6 * 10) / 10)
    expect(record).toMatchObject({ cpu_cores: 0.3, memory_mb: 300, tick_ms_avg: 5, tick_ms_max: 9 })
    expect(estimateSizes(record, PLANS.sizes).map(estimate => [estimate.size, estimate.holdsTest])).toEqual([['small', false], ['medium', false], ['large', true], ['xl', true]])
    const idle = testRecord('player_hosted', 1, 0, 10, { peers: 0, bytes_in: 0, bytes_out: 0, tick_ms_avg: 0, tick_ms_max: 0, rss_bytes: 0 })
    expect(estimateSizes(idle, PLANS.sizes)[0]).toEqual({ size: 'small', playerHoursPerMonth: 1500, holdsTest: true })
  })

  it('treat a damaged results file as no test', async () => {
    const dir = await multiplayerProject()
    expect(await readTestRecord(dir)).toBeUndefined()
    await mkdir(join(dir, '.wasdengine'), { recursive: true })
    await writeFile(join(dir, '.wasdengine', TEST_FILE), '{"format": 2}')
    expect(await readTestRecord(dir)).toBeUndefined()
    await writeFile(join(dir, '.wasdengine', TEST_FILE), 'not json')
    expect(await readTestRecord(dir)).toBeUndefined()
  })
})
