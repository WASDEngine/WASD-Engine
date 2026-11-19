/**
 * The WASD Multiplayer add-on in a real Godot: sign-in messages count only from the configured site, a player token
 * renews itself where no WASD game page frames the game and stops once the site refuses, a lobby host takes its ICE
 * servers from the lobby service's welcome and asks for fresh ones before they run out, a joiner that never connects
 * is dropped rather than kicked, a refused relay is named in a failed join, and a closed signal socket's code and
 * reason say why a join ended. Once players are connected, a dropped signal socket ends nothing: the host keeps a
 * connected joiner when the lobby service says it left, gets four tries again after each reconnect that opens, and a
 * joiner opens its socket again unless the close says no reconnect can help. The add-on talks to stand-ins of the WASD
 * play API and the signal socket, so no WASD service runs.
 *
 * Set WASD_LIBGODOT_DIR to a folder holding `godot_runner` and the LibGodot library under the name that
 * `wasdengine/libgodot/build.sh` installs: `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const GODOT_PLATFORMS: Partial<Record<NodeJS.Platform, { readonly name: string; readonly suffix: string }>> = {
  darwin: { name: 'macos', suffix: 'dylib' },
  linux: { name: 'linuxbsd', suffix: 'so' },
  win32: { name: 'windows', suffix: 'dll' },
}
const GODOT_ARCHES: Partial<Record<string, string>> = { arm64: 'arm64', x64: 'x86_64' }

const runtimeDir = process.env.WASD_LIBGODOT_DIR
const platform = GODOT_PLATFORMS[process.platform]
const arch = GODOT_ARCHES[process.arch]
const library = runtimeDir === undefined || platform === undefined || arch === undefined
  ? undefined
  : join(runtimeDir, `libgodot.${platform.name}.editor.${arch}.${platform.suffix}`)
const runner = runtimeDir === undefined ? undefined : join(runtimeDir, process.platform === 'win32' ? 'godot_runner.exe' : 'godot_runner')
const godot = runner !== undefined && library !== undefined && existsSync(runner) && existsSync(library) ? { runner, library } : undefined

const ADDON = fileURLToPath(new URL('../addon/wasd_multiplayer', import.meta.url))

const PROJECT = 'config_version=5\n\n[application]\n\nconfig/name="AddonTest"\nrun/main_scene="res://test.tscn"\nconfig/features=PackedStringArray("4.7")\n\n[autoload]\n\nWasdMultiplayer="*res://addons/wasd_multiplayer/wasd_multiplayer.gd"\n'
const SCENE = '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://test.gd" id="1"]\n\n[node name="Test" type="Node"]\nscript = ExtResource("1")\n'
const CONFIG = '[wasd]\n\napi_origin="https://site.test"\napp_origin="https://site.test"\n'

// Drives the autoload through its own methods and prints one ADDON_RESULT line of JSON.
const TEST_SCRIPT = [
  'extends Node',
  '',
  'const Tokens := preload("res://addons/wasd_multiplayer/internal/tokens.gd")',
  '',
  '',
  'class FakeApi extends "res://addons/wasd_multiplayer/internal/api.gd":',
  '\tvar calls: Array = []',
  '\tvar answers: Array = []',
  '',
  '\tfunc request(method: int, path: String, body: Variant = null, token := "", timeout := 15.0) -> Dictionary:',
  '\t\tcalls.append(path)',
  '\t\tawait _host.get_tree().process_frame',
  '\t\tif answers.is_empty():',
  '\t\t\treturn {"ok": false, "status": 0, "error": "network", "message": "offline"}',
  '\t\treturn answers.pop_front()',
  '',
  '',
  'class FakeSignal extends "res://addons/wasd_multiplayer/internal/signal_client.gd":',
  '\tvar sent: Array = []',
  '\tvar opens := 0',
  '',
  '\tfunc open(_url: String) -> Error:',
  '\t\topens += 1',
  '\t\treturn OK',
  '',
  '\tfunc send(message: Dictionary) -> bool:',
  '\t\tsent.append(message)',
  '\t\treturn true',
  '',
  '\tfunc is_open() -> bool:',
  '\t\treturn true',
  '',
  '\tfunc is_active() -> bool:',
  '\t\treturn false',
  '',
  '\tfunc poll(_now: float) -> void:',
  '\t\tpass',
  '',
  '',
  'func token(data: Dictionary) -> String:',
  '\treturn Tokens.sign("wpt1", data, "key".to_utf8_buffer())',
  '',
  '',
  'func frames(count: int) -> void:',
  '\tfor _i in count:',
  '\t\tawait get_tree().process_frame',
  '',
  '',
  'func types(messages: Array) -> Array:',
  '\treturn messages.map(func(message: Dictionary) -> String: return str(message.get("type", "")))',
  '',
  '',
  'func _ready() -> void:',
  '\t_run.call_deferred()',
  '',
  '',
  'func _run() -> void:',
  '\tvar results := {}',
  '\tvar mp: Node = get_node("/root/WasdMultiplayer")',
  '\tvar now := Time.get_unix_time_from_system()',
  '\tvar api := FakeApi.new(mp)',
  '\tapi.origin = "https://site.test"',
  '\tmp._api = api',
  '\tvar game := "11111111-2222-3333-4444-555555555555"',
  '\tvar first := token({"g": game, "p": "player1", "n": "Ann", "s": "tag", "iat": int(now), "exp": int(now) + 3600})',
  '\tmp._on_web_message("parent", "https://evil.test", {"type": "wasd:play:token", "v": 1, "token": first})',
  '\tmp._on_web_message("parent", "https://evil.test", {"type": "wasd:play:context", "v": 1, "game_id": game})',
  '\tresults["foreign_origin_ignored"] = mp._token == "" and not mp._parent_wasd',
  '\tmp._on_web_message("popup", "https://site.test", {"type": "wasd:play:token", "v": 1, "token": first})',
  '\tresults["site_origin_accepted"] = mp._token == first and str(mp.player().get("id", "")) == "player1"',
  '',
  '\tvar renewed := token({"g": game, "p": "player1", "n": "Ann", "s": "tag", "iat": int(now), "exp": int(now) + 7200})',
  '\tapi.answers = [{"ok": true, "status": 200, "data": {"token": renewed, "player": {"id": "player1", "name": "Ann"}}}]',
  '\tmp._token_exp = now + 600.0',
  '\tawait frames(5)',
  '\tresults["renewed"] = mp._token == renewed and api.calls == ["/api/v1/play/token/renew"]',
  '\tapi.answers = [{"ok": false, "status": 401, "error": "sign_in_expired", "message": "The sign-in ended."}]',
  '\tmp._token_exp = now + 600.0',
  '\tmp._refresh_asked_at = -1.0e9',
  '\tawait frames(5)',
  '\tmp._refresh_asked_at = -1.0e9',
  '\tawait frames(5)',
  '\tresults["renewals_stop_when_refused"] = mp._renew_refused == "sign_in_expired" and api.calls.size() == 2',
  '',
  '\tvar link := FakeSignal.new()',
  '\tmp._signal = link',
  '\tmp._role = 1',
  '\tmp._on_signal_message({"type": "welcome", "lobby": {"id": "lobby-1", "code": "ABC123"},',
  '\t\t\t"ice_servers": [{"urls": ["stun:relay.test:3478"]}], "relay": {"available": true, "expires_in": 60}})',
  '\tawait frames(3)',
  '\tresults["ice_from_welcome"] = mp._ice_servers.size() == 1',
  '\tresults["ice_asked_again"] = types(link.sent).has("ice")',
  '\tmp._pending[2] = {"name": "Bob", "player_id": "player2", "since": now - 31.0}',
  '\tawait frames(3)',
  '\tresults["dropped_not_kicked"] = types(link.sent).has("drop") and not types(link.sent).has("kick")',
  '\tmp._on_signal_message({"type": "ice", "ice_servers": [], "relay": {"available": false, "code": "relay_paused",',
  '\t\t\t"message": "The relay is off for this game."}})',
  '\tresults["relay_note"] = mp._relay_note()',
  '\tmp._connections[3] = "connected"',
  '\tmp._players[3] = {"id": "player3", "name": "Cal"}',
  '\tmp._connections[4] = "connecting"',
  '\tmp._pending[4] = {"name": "Dee", "player_id": "player4", "since": Time.get_unix_time_from_system()}',
  '\tmp._on_signal_message({"type": "peer_left", "peer_id": 3})',
  '\tmp._on_signal_message({"type": "peer_left", "peer_id": 4})',
  '\tresults["peer_left_keeps_connected"] = mp._connections.has(3) and not mp._connections.has(4) \\',
  '\t\t\tand not mp._pending.has(4)',
  '\tfor _i in 6:',
  '\t\tmp._on_signal_closed(1006, "")',
  '\t\tmp._on_signal_opened()',
  '\tresults["host_retries_reset"] = mp._role == 1',
  '\tfor _i in 5:',
  '\t\tmp._on_signal_closed(1006, "")',
  '\tresults["host_gives_up"] = mp._role == 0',
  '',
  '\tmp._role = 2',
  '\tvar causes := []',
  '\tfor close in [[4002, ""], [4001, ""], [4409, "lobby_full: That lobby is full."],',
  '\t\t\t[4403, "lobby_locked: The host removed you from this lobby."], [4429, "rate_limited: Too many."], [1006, ""]]:',
  '\t\tmp._connect_result = {}',
  '\t\tmp._on_signal_closed(close[0], close[1])',
  '\t\tcauses.append(str(mp._connect_result.get("error", "")))',
  '\tresults["close_causes"] = causes',
  '\tmp._connect_result = {}',
  '\tmp._on_signal_closed(4409, "lobby_locked: That lobby is locked.")',
  '\tresults["close_message"] = str(mp._connect_result.get("message", ""))',
  '\tvar rejoin := FakeSignal.new()',
  '\tmp._signal = rejoin',
  '\tmp._signal_retries = 0',
  '\tmp._connect_result = {"ok": true}',
  '\tmp._on_signal_closed(1006, "")',
  '\tawait get_tree().create_timer(2.5).timeout',
  '\tresults["joiner_reopens"] = rejoin.opens == 1 and mp._role == 2',
  '\tfor code in [4000, 4401, 4403, 4404, 4409]:',
  '\t\tmp._on_signal_closed(code, "")',
  '\tresults["joiner_stays_after_refusals"] = mp._signal_retries == 1 and mp._role == 2',
  '\tmp._on_signal_closed(4001, "")',
  '\tresults["joiner_kicked_leaves"] = mp._role == 0',
  '\tmp._role = 0',
  '\tmp._signal = null',
  '',
  '\tmp._role = 3',
  '\tmp.config.max_players = 2',
  '\tvar ticket_key := "server-key".to_utf8_buffer()',
  '\tvar ann := Tokens.sign("wjt1", {"s": "server-1", "p": "pid-ann", "n": "Ann", "exp": int(now) + 120}, ticket_key)',
  '\tvar bob := Tokens.sign("wjt1", {"s": "server-1", "p": "pid-bob", "n": "Bob", "exp": int(now) + 120}, ticket_key)',
  '\tvar cal := Tokens.sign("wjt1", {"s": "server-1", "p": "pid-cal", "n": "Cal", "exp": int(now) + 120}, ticket_key)',
  '\tvar ann_again := Tokens.sign("wjt1", {"s": "server-1", "p": "pid-ann", "n": "Ann", "exp": int(now) + 121}, ticket_key)',
  '\tvar admissions := [mp._admission(10, ann, {"id": "pid-ann", "name": "Ann"})]',
  '\tmp._players[10] = {"id": "pid-ann", "name": "Ann"}',
  '\tadmissions.append(mp._admission(11, ann, {"id": "pid-ann", "name": "Ann"}))',
  '\tadmissions.append(mp._admission(11, bob, {"id": "pid-bob", "name": "Bob"}))',
  '\tmp._players[11] = {"id": "pid-bob", "name": "Bob"}',
  '\tadmissions.append(mp._admission(12, cal, {"id": "pid-cal", "name": "Cal"}))',
  '\tadmissions.append(mp._admission(13, ann_again, {"id": "pid-ann", "name": "Ann"}))',
  '\tresults["server_admissions"] = admissions',
  '\tmp._players.clear()',
  '\tmp._role = 4',
  '\tmp._connect_result = {}',
  '\tmp._on_auth(1, "wasd_refused:server_full".to_utf8_buffer())',
  '\tresults["client_hears_full"] = str(mp._connect_result.get("error", "")) + ": " + str(mp._connect_result.get("message", ""))',
  '\tmp._connect_result = {}',
  '\tmp._role = 0',
  '\tprint("ADDON_RESULT " + JSON.stringify(results))',
  '\tget_tree().quit()',
  '',
].join('\n')

/** Run LibGodot's runner on `args`, killing it after `timeoutMs`; resolves with its exit code and output. */
function runGodot(
  tools: { readonly runner: string; readonly library: string }, args: readonly string[], timeoutMs: number,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    // The add-on reads WASD_* variables at start; the test's own settings come from its project only.
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('WASD_')))
    const child = spawn(tools.runner, ['--libgodot', tools.library, '--', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

describe.skipIf(godot === undefined)('the WASD Multiplayer add-on on the real LibGodot runner', () => {
  const folders: string[] = []
  afterAll(async () => { await Promise.all(folders.map(folder => rm(folder, { recursive: true, force: true }))) })

  it('signs in, renews its token, takes ICE from the welcome, says why a join ended, and outlasts a dropped signal socket', async () => {
    if (godot === undefined) return
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-addon-'))
    folders.push(dir)
    await cp(ADDON, join(dir, 'addons', 'wasd_multiplayer'), { recursive: true })
    await writeFile(join(dir, 'project.godot'), PROJECT)
    await writeFile(join(dir, 'test.tscn'), SCENE)
    await writeFile(join(dir, 'test.gd'), TEST_SCRIPT)
    await writeFile(join(dir, 'wasd_multiplayer.cfg'), CONFIG)
    const { output } = await runGodot(godot, ['--headless', '--path', dir], 60_000)
    const line = output.split('\n').find(entry => entry.startsWith('ADDON_RESULT '))
    expect(line, output.slice(-3000)).toBeDefined()
    expect(JSON.parse((line ?? '').slice('ADDON_RESULT '.length))).toEqual({
      foreign_origin_ignored: true,
      site_origin_accepted: true,
      renewed: true,
      renewals_stop_when_refused: true,
      ice_from_welcome: true,
      ice_asked_again: true,
      dropped_not_kicked: true,
      relay_note: ' The relay is off for this game.',
      close_causes: ['dropped', 'kicked', 'lobby_full', 'lobby_locked', 'rate_limited', 'signal_failed'],
      close_message: 'That lobby is locked.',
      peer_left_keeps_connected: true,
      host_retries_reset: true,
      host_gives_up: true,
      joiner_reopens: true,
      joiner_stays_after_refusals: true,
      joiner_kicked_leaves: true,
      // One connection per ticket, max_players at a time, and a player who connects again replaces their connection.
      server_admissions: ['', 'ticket_used', '', 'server_full', ''],
      client_hears_full: 'server_full: The server is full. Try again when a player leaves.',
    })
  })
})
