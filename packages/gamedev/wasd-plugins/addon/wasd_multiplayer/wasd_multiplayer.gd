# SPDX-License-Identifier: CC0-1.0
# WASD Multiplayer, the autoload "WasdMultiplayer": WASD sign-in for players, player-hosted lobbies (one player's game
# hosts and the others connect to it over WebRTC), and WASD dedicated servers (a server build that WASD runs, which
# players join over a secure WebSocket). It sets multiplayer.multiplayer_peer; everything after that is Godot's own
# high-level multiplayer: @rpc, MultiplayerSpawner, and MultiplayerSynchronizer, with peer 1 as the authority.
#
# Coroutines (sign_in, host_lobby, join_lobby, list_lobbies, join_server, list_servers, serve) resolve to
# {"ok": true, ...} or {"ok": false, "error": <code>, "message": <text>}; await them. Games should react to
# player_joined and player_left, which report only players WASD signed in, rather than multiplayer.peer_connected.
#
# Test mode (environment WASD_MULTIPLAYER_TEST = host, client, or server) runs over a loopback WebSocket on
# WASD_TEST_PORT without WASD services, starts itself, prints WASD_TEST_EVENT lines as it goes, and after
# WASD_TEST_SECONDS prints one WASD_TEST_STATS line and quits.
extends Node

## The player signed in to WASD. [param player] is {"id", "name"}.
signal signed_in(player: Dictionary)
## Sign-in did not finish. [param reason] is an error code such as "signed_out", "popup_blocked", or "cancelled".
signal sign_in_failed(reason: String)
## This game hosts or joined a lobby.
signal lobby_joined(lobby: Dictionary)
## The lobby's name, visibility, lock, or data changed.
signal lobby_updated(lobby: Dictionary)
## The lobby ended: "host_left", "closed", "replaced", "kicked", "dropped" (the host could not connect to this player
## in time), "left", or "signal_lost".
signal lobby_closed(reason: String)
## A signed-in player joined. Peer 1 is the lobby host; a dedicated server is not a player.
signal player_joined(peer_id: int, player: Dictionary)
## A player left.
signal player_left(peer_id: int)
## This game connected to the lobby host or to the dedicated server.
signal connected()
## A join failed, or the connection to the dedicated server was lost ("disconnected").
signal connection_failed(reason: String)
## The dedicated server will restart or stop soon. Reasons: "restart", "stop", "bandwidth", "update", "maintenance".
signal server_warning(seconds: int, reason: String, message: String)
## join_server() picked a dedicated server that sleeps while nobody plays: connecting wakes it, which takes a few
## seconds longer. Show the player that the server is starting.
signal server_waking()
## In a dedicated server: save now, the server quits on the next frames.
signal server_stopping()

const ADDON_VERSION := "1.2.0"
const Tokens := preload("internal/tokens.gd")
const Config := preload("internal/config.gd")
const Api := preload("internal/api.gd")
const WebBridge := preload("internal/web_bridge.gd")
const SignalClient := preload("internal/signal_client.gd")
const CountingPeer := preload("internal/counting_peer.gd")
const ServerFiles := preload("internal/server_files.gd")

const _AUTH_SECONDS := 10.0
# How long a stopping server waits for the saves that handlers announced with delay_stop(), within the 20 seconds that
# WASD gives a server between asking it to stop and stopping it.
const _STOP_WAIT_SECONDS := 15.0
# What a dedicated server sends a player it turns away, before it closes the connection, followed by the reason.
const _REFUSED := "wasd_refused:"
const _REFUSALS := {
	"server_full": "The server is full. Try again when a player leaves.",
	"ticket_used": "This join ticket was used already. Join again.",
}
const _JOIN_SECONDS := 25.0
# How long joining a sleeping dedicated server waits: its host holds the connection while it wakes the server.
const _WAKE_SECONDS := 75.0
const _PENDING_SECONDS := 30.0
const _STATUS_SECONDS := 5.0
const _CONTROL_SECONDS := 1.0
# A token from the WASD game page is asked for again this long before it expires; without such a page, the add-on
# renews its token through the WASD service from this long before, trying again every minute.
const _REFRESH_MARGIN_SECONDS := 300.0
const _RENEW_MARGIN_SECONDS := 1800.0
const _RENEW_RETRY_SECONDS := 60.0
# A lobby host asks the lobby service for fresh relay credentials this long before its own run out, so players who
# join late can still be relayed; while the relay is refused, it asks again this often.
const _ICE_MARGIN_SECONDS := 3600.0
const _ICE_RETRY_SECONDS := 60.0
const _ICE_REFUSED_RETRY_SECONDS := 1800.0
# How long a joiner waits before each attempt to get its dropped signal socket back, the last one repeating.
const _REJOIN_DELAYS: Array[float] = [2.0, 4.0, 8.0, 15.0, 30.0]
# The lobby service's closes that no reconnect changes: a replacing socket of the same player (4000), a bad ticket
# (4401), a refused origin, host, or removed account (4403), a closed lobby (4404), and a locked or full one (4409).
const _SIGNAL_REFUSALS: Array[int] = [4000, 4401, 4403, 4404, 4409]
const _BUILD_PATH := "/games/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/versions/([0-9]+)/"

enum _Role { NONE, HOST, JOINER, SERVER, CLIENT }

## Settings from defaults, project settings, res://wasd_multiplayer.cfg, and the environment.
var config: Config

var _api: Api
var _web: WebBridge
var _signal: SignalClient
var _role := _Role.NONE
var _busy := false
var _leaving := false
var _test := ""
var _token := ""
var _token_exp := 0.0
var _me := {}
var _game_id := ""
var _version := 0
var _parent_wasd := false
var _token_reply := {}
var _refresh_asked_at := -1.0e9
var _renewing := false
var _renew_refused := ""
var _lobby := {}
var _peer_id := 0
var _ice_servers: Array = []
var _relay := {}
var _relay_warned := ""
var _ice_expires_at := 0.0
var _ice_asked_at := -1.0e9
var _rtc: WebRTCMultiplayerPeer
var _connections := {}
var _pending := {}
var _identities := {}
var _players := {}
var _counter: CountingPeer
var _traffic := {"bytes_in": 0, "bytes_out": 0, "packets_in": 0, "packets_out": 0}
var _hello := ""
var _connect_result := {}
var _signal_url := ""
var _signal_retries := 0
var _server := {}
var _server_id := ""
var _ticket_key := PackedByteArray()
# The join tickets this server admitted, each until it expires, so none admits a second connection.
var _used_tickets := {}
var _files: ServerFiles
var _status_at := 0.0
var _control_at := 0.0
var _active_fps := 0
var _original_fps := -1
var _stopping := false
var _stop_holds := 0
var _started_at := 0.0
var _window := {"sum": 0.0, "max": 0.0, "count": 0}
var _total := {"sum": 0.0, "max": 0.0, "count": 0}
var _peak_peers := 0
var _stats_printed := false
var _webrtc_checked := false
var _webrtc_works := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_started_at = Time.get_unix_time_from_system()
	config = Config.new()
	config.load_all()
	_game_id = config.game_id
	_version = config.version
	_api = Api.new(self)
	_api.origin = config.api_origin
	_test = OS.get_environment("WASD_MULTIPLAYER_TEST").strip_edges().to_lower()
	multiplayer.peer_connected.connect(_on_peer_connected)
	multiplayer.peer_disconnected.connect(_on_peer_disconnected)
	multiplayer.connected_to_server.connect(_on_connected_to_server)
	multiplayer.connection_failed.connect(_on_connection_failed)
	multiplayer.server_disconnected.connect(_on_server_disconnected)
	var scene := _scene_multiplayer()
	if scene != null:
		scene.peer_authenticating.connect(_on_peer_authenticating)
		scene.peer_authentication_failed.connect(_on_peer_authentication_failed)
	_web = WebBridge.new()
	if _web.available:
		_web.message.connect(_on_web_message)
		_read_build_path()
		_web.post_parent({"type": "wasd:play:hello", "v": 1}, config.app_origin)
	else:
		_read_desktop_token()
	if _test != "":
		_start_test.call_deferred()


func _process(_delta: float) -> void:
	var now := Time.get_unix_time_from_system()
	if _signal != null:
		_signal.poll(now)
	_sample_tick()
	match _role:
		_Role.HOST:
			_expire_pending(now)
			_maybe_refresh_ice(now)
		_Role.SERVER:
			_server_tick(now)
	if _role != _Role.NONE:
		_peak_peers = maxi(_peak_peers, _remote_count())
	_maybe_refresh_token(now)


# Public API ---------------------------------------------------------------------------------------------------------


## True in a WASD dedicated server: the server build, a process started with WASD_SERVER=1 or --wasd-server, or a
## "server" test run.
func is_server() -> bool:
	if _test != "":
		return _test == "server"
	return OS.get_environment("WASD_SERVER") == "1" or OS.get_cmdline_user_args().has("--wasd-server") \
			or OS.has_feature("dedicated_server")


## True while this game holds a WASD sign-in that has not expired.
func is_signed_in() -> bool:
	if _test != "":
		return true
	return _token != "" and _token_exp > Time.get_unix_time_from_system() + 30.0


## The signed-in player as {"id", "name"}, or {} before sign-in. The id is stable for this player in this game.
func player() -> Dictionary:
	if _test != "":
		return _test_identity()
	return _me.duplicate() if is_signed_in() else {}


## "none", "host", "joiner", "server", or "client".
func role() -> String:
	return ["none", "host", "joiner", "server", "client"][_role]


## The current lobby, or {} outside one.
func lobby() -> Dictionary:
	return _lobby.duplicate(true)


## Every connected player as {peer_id: {"id", "name"}}, this game's own player included.
func players() -> Dictionary:
	return _players.duplicate(true)


## One player as {"id", "name"}, or {} when no such player is connected.
func player_info(peer_id: int) -> Dictionary:
	var found: Variant = _players.get(peer_id)
	return (found as Dictionary).duplicate() if found is Dictionary else {}


## Signs the player in to WASD. In a Web build on a WASD game page the page answers at once; elsewhere a WASD
## sign-in window opens, which browsers allow only right after a click or key press, so call this from a button. A
## desktop build signs in with the token WASD Engine started it with. Either way the sign-in then lasts while the game
## runs, up to a week.
func sign_in() -> Dictionary:
	if _test != "":
		return {"ok": true, "player": _test_identity()}
	if _token_valid(120.0):
		return {"ok": true, "player": _me.duplicate()}
	if not _web.available:
		_read_desktop_token()
		if _token_valid(0.0):
			return {"ok": true, "player": _me.duplicate()}
		if _token != "":
			return _sign_in_failure("sign_in_expired", _expired_text())
		return _sign_in_failure("sign_in_unavailable", "Online play needs a WASD sign-in: play the game's Web " \
				+ "build on the WASD Engine website, or start the game from WASD Engine's game library. On this " \
				+ "computer, use a multiplayer test run.")
	var framed := _web.is_framed()
	if framed:
		framed = await _parent_is_wasd()
	if framed:
		_token_reply = {}
		_web.post_parent({"type": "wasd:play:token-request", "v": 1}, config.app_origin)
		return _finish_sign_in(await _wait_token_reply(15.0, false))
	if _game_id == "":
		return _sign_in_failure("no_game_id", "This build has no WASD game id. Release the game with WASD Engine first.")
	_token_reply = {}
	var url := "%s/play/connect?game=%s&v=%d" % [config.app_origin, _game_id, _version]
	if not _web.open_popup(url):
		return _sign_in_failure("popup_blocked", "The browser blocked the WASD sign-in window. Call sign_in() from a " \
				+ "button press.")
	var reply := await _wait_token_reply(600.0, true)
	_web.close_popup()
	return _finish_sign_in(reply)


## Hosts a player lobby: this game becomes peer 1 and the other players connect to it. [param options]: "name",
## "public" (listed in list_lobbies), "max_players" (2 to 16), and "data" (a small Dictionary shown to joiners).
## Resolves to {"ok": true, "lobby", "code"}; share the code with friends.
func host_lobby(options := {}) -> Dictionary:
	var blocked := _start_session()
	if not blocked.is_empty():
		return blocked
	if is_server():
		return _done(_failure("server_build", "A game server can't host a player lobby; call serve() instead."))
	if _test == "host":
		return _done(_test_host_lobby(options))
	if _test != "":
		return _done(_failure("test_mode", "This test run's %s can't host a lobby." % _test))
	var auth := await _ensure_token()
	if not auth.get("ok", false):
		return _done(auth)
	if not _webrtc_available():
		return _done(_webrtc_failure())
	var body := {
		"version": _version,
		"public": bool(options.get("public", false)),
		"max_players": clampi(int(options.get("max_players", config.max_players)), 2, 16),
	}
	if options.has("name"):
		body["name"] = str(options.get("name")).left(48)
	if options.get("data") is Dictionary:
		body["data"] = options.get("data")
	var response := await _api.request(HTTPClient.METHOD_POST, "/api/v1/play/lobbies", body, _token)
	if not response.get("ok", false):
		return _done(_report(response))
	var data: Dictionary = response.get("data", {})
	_lobby = data.get("lobby", {}) if data.get("lobby") is Dictionary else {}
	# The lobby service sends the ICE servers, relay credentials among them, over the signal socket (welcome).
	_forget_ice()
	_peer_id = 1
	_rtc = WebRTCMultiplayerPeer.new()
	var error := _rtc.create_server()
	if error != OK:
		_close_lobby_remote()
		_teardown()
		return _done(_failure("webrtc_failed", "The lobby host could not start WebRTC (error %d)." % error))
	_role = _Role.HOST
	_install_peer(_rtc, false)
	var opened := await _open_signal(str(data.get("signal_url", "")), str(data.get("signal_ticket", "")))
	if not opened.get("ok", false):
		_close_lobby_remote()
		_teardown()
		return _done(opened)
	_players = {1: _me.duplicate()}
	lobby_joined.emit(_lobby.duplicate(true))
	player_joined.emit(1, _me.duplicate())
	return _done({"ok": true, "lobby": _lobby.duplicate(true), "code": str(_lobby.get("code", ""))})


## Joins a lobby by its code. Resolves once connected to the host, with {"ok": true, "lobby"}.
func join_lobby(code: String) -> Dictionary:
	var blocked := _start_session()
	if not blocked.is_empty():
		return blocked
	if is_server():
		return _done(_failure("server_build", "A game server can't join a player lobby."))
	if _test == "client":
		return _done(await _test_join_lobby())
	if _test != "":
		return _done(_failure("test_mode", "This test run's %s can't join a lobby." % _test))
	var auth := await _ensure_token()
	if not auth.get("ok", false):
		return _done(auth)
	if not _webrtc_available():
		return _done(_webrtc_failure())
	var body := {"code": code.strip_edges().to_upper(), "version": _version}
	var response := await _api.request(HTTPClient.METHOD_POST, "/api/v1/play/lobbies/join", body, _token)
	if not response.get("ok", false):
		return _done(_report(response))
	var data: Dictionary = response.get("data", {})
	_lobby = data.get("lobby", {}) if data.get("lobby") is Dictionary else {}
	_forget_ice()
	_peer_id = int(data.get("peer_id", 0))
	if _peer_id < 2:
		return _done(_failure("join_failed", "The lobby service sent an invalid player number."))
	_rtc = WebRTCMultiplayerPeer.new()
	var error := _rtc.create_client(_peer_id)
	if error != OK:
		return _done(_failure("webrtc_failed", "WebRTC could not start (error %d)." % error))
	_role = _Role.JOINER
	_connect_result = {}
	_install_peer(_rtc, false)
	var opened := await _open_signal(str(data.get("signal_url", "")), str(data.get("signal_ticket", "")))
	if not opened.get("ok", false):
		_teardown()
		return _done(opened)
	var result := await _await_connection(_JOIN_SECONDS)
	if not result.get("ok", false):
		_teardown()
		connection_failed.emit(str(result.get("error", "connection_failed")))
		return _done(result)
	lobby_joined.emit(_lobby.duplicate(true))
	connected.emit()
	return _done({"ok": true, "lobby": _lobby.duplicate(true)})


## The public lobbies of this game's release that have room, newest first: {"ok": true, "lobbies": [...]}.
func list_lobbies() -> Dictionary:
	if _test != "":
		return {"ok": true, "lobbies": []}
	var auth := await _ensure_token()
	if not auth.get("ok", false):
		return auth
	var response := await _api.request(HTTPClient.METHOD_GET, "/api/v1/play/lobbies?version=%d" % _version, null, _token)
	if not response.get("ok", false):
		return _report(response)
	var data: Dictionary = response.get("data", {})
	return {"ok": true, "lobbies": data.get("lobbies", []) if data.get("lobbies") is Array else []}


## Changes the hosted lobby: "name", "public", "locked" (no new joins), and "data". Host only.
func set_lobby(options: Dictionary) -> Dictionary:
	if _role != _Role.HOST:
		return _failure("not_host", "Only the lobby host can change the lobby.")
	var update := {"type": "lobby_update"}
	for key in ["name", "public", "locked", "data"]:
		if options.has(key):
			update[key] = options.get(key)
	if update.has("name"):
		update["name"] = str(update.get("name")).left(48)
	if _test != "":
		for key in update:
			if key != "type":
				_lobby[key] = update[key]
		lobby_updated.emit(_lobby.duplicate(true))
		return {"ok": true, "lobby": _lobby.duplicate(true)}
	if _signal == null or not _signal.send(update):
		return _failure("signal_failed", "The lobby service can't be reached right now.")
	return {"ok": true}


## Removes a player from the hosted lobby or from this dedicated server. A player removed from a lobby can't join it
## again.
func kick(peer_id: int) -> Dictionary:
	if peer_id == 1 or not _players.has(peer_id):
		return _failure("no_such_player", "No player %d is connected." % peer_id)
	if _role == _Role.HOST and _test == "":
		if _signal != null:
			_signal.send({"type": "kick", "peer_id": peer_id})
		_drop_connection(peer_id)
		return {"ok": true}
	if _role == _Role.HOST or _role == _Role.SERVER:
		var scene := _scene_multiplayer()
		if scene != null:
			scene.disconnect_peer(peer_id)
		return {"ok": true}
	return _failure("not_host", "Only the lobby host or the server can remove players.")


## Joins this game's WASD dedicated server: the one named by [param server_id], or else the running server of this
## release with the fewest players, or a sleeping one, which the connection wakes (server_waking). Resolves once
## connected, with {"ok": true, "server"}.
func join_server(server_id := "") -> Dictionary:
	var blocked := _start_session()
	if not blocked.is_empty():
		return blocked
	if is_server():
		return _done(_failure("server_build", "A game server can't join another server."))
	if _test == "client":
		return _done(await _test_join_server())
	if _test != "":
		return _done(_failure("test_mode", "This test run's %s can't join a server." % _test))
	var auth := await _ensure_token()
	if not auth.get("ok", false):
		return _done(auth)
	var body := {"version": _version}
	if server_id != "":
		body["server_id"] = server_id
	var response := await _api.request(HTTPClient.METHOD_POST, "/api/v1/play/servers/join", body, _token)
	if not response.get("ok", false):
		return _done(_report(response))
	var data: Dictionary = response.get("data", {})
	var url := str(data.get("url", ""))
	var ticket := Tokens.query_param(url, "ticket")
	if url == "" or ticket == "":
		return _done(_failure("join_failed", "The WASD service sent no server address."))
	var waking := bool(data.get("waking", false))
	if waking:
		server_waking.emit()
	var result := await _connect_socket(url, ticket, _Role.CLIENT, _WAKE_SECONDS if waking else _JOIN_SECONDS)
	if result.get("ok", false):
		_server = data.get("server", {}) if data.get("server") is Dictionary else {}
		result["server"] = _server.duplicate()
		connected.emit()
	return _done(result)


## This game's dedicated servers: {"ok": true, "servers": [{"id", "name", "state", "players_online", "version"}]}.
func list_servers() -> Dictionary:
	if _test != "":
		return {"ok": true, "servers": []}
	var auth := await _ensure_token()
	if not auth.get("ok", false):
		return auth
	var response := await _api.request(HTTPClient.METHOD_GET, "/api/v1/play/servers", null, _token)
	if not response.get("ok", false):
		return _report(response)
	var data: Dictionary = response.get("data", {})
	return {"ok": true, "servers": data.get("servers", []) if data.get("servers") is Array else []}


## Starts the dedicated server: listens on WASD_PORT (8080 by default) and admits only players with a valid WASD
## join ticket. Call it from the server build's first scene when is_server() is true. Resolves to {"ok", "port"}.
func serve() -> Dictionary:
	var blocked := _start_session()
	if not blocked.is_empty():
		return blocked
	if not is_server():
		return _done(_failure("not_server", "serve() runs only in a WASD dedicated server (see is_server())."))
	var scene := _scene_multiplayer()
	if scene == null:
		return _done(_failure("multiplayer_api", "serve() needs Godot's SceneMultiplayer as the tree's multiplayer."))
	var port := _env_int("WASD_PORT", 0)
	if port <= 0:
		port = _env_int("WASD_TEST_PORT", 8080) if _test != "" else 8080
	_server_id = OS.get_environment("WASD_SERVER_ID").strip_edges().to_lower()
	var key_text := OS.get_environment("WASD_TICKET_KEY").strip_edges()
	_ticket_key = Marshalls.base64_to_raw(key_text) if key_text != "" else PackedByteArray()
	if _ticket_key.is_empty() and _test == "":
		return _done(_failure("no_ticket_key", "WASD_TICKET_KEY is not set; WASD starts game servers with it."))
	# A container's server listens on every interface, where the host's proxy reaches it; test runs and servers WASD
	# runs as local processes listen on loopback only (WASD_BIND_ADDRESS).
	var bind := OS.get_environment("WASD_BIND_ADDRESS").strip_edges()
	if bind == "":
		bind = "127.0.0.1" if _test != "" else "*"
	var socket := WebSocketMultiplayerPeer.new()
	var error := socket.create_server(port, bind)
	if error != OK:
		return _done(_failure("listen_failed", "The server could not listen on port %d (error %d)." % [port, error]))
	_role = _Role.SERVER
	_install_peer(socket, true)
	_files = ServerFiles.new(OS.get_environment("WASD_STATUS_FILE").strip_edges(),
			OS.get_environment("WASD_CONTROL_FILE").strip_edges(), _started_at)
	_original_fps = Engine.max_fps
	if config.server_fps > 0:
		_active_fps = config.server_fps
	else:
		_active_fps = Engine.max_fps if Engine.max_fps > 0 else Engine.physics_ticks_per_second
	_update_server_fps()
	_write_status(true)
	_test_event("ready", {"port": port})
	return _done({"ok": true, "port": port})


## Leaves the lobby or the server, or stops serving. A host's lobby closes for everyone.
func leave() -> void:
	var was := _role
	if was == _Role.HOST and _test == "":
		_close_lobby_remote()
	_teardown()
	if was == _Role.HOST or was == _Role.JOINER:
		lobby_closed.emit("left")


## Traffic and timing so far: "bytes_in", "bytes_out", "packets_in", and "packets_out" (multiplayer payload only,
## once per receiving peer), "peers" (connected remote peers), "tick_ms_avg" and "tick_ms_max" (process plus physics
## time per frame), "rss_bytes" (Godot's static memory), "uptime_s", "role", and "mode".
func stats() -> Dictionary:
	var traffic := _traffic_now()
	return {
		"role": role(),
		"mode": config.mode,
		"peers": _remote_count(),
		"bytes_in": traffic["bytes_in"],
		"bytes_out": traffic["bytes_out"],
		"packets_in": traffic["packets_in"],
		"packets_out": traffic["packets_out"],
		"tick_ms_avg": _average(_total),
		"tick_ms_max": float(_total["max"]),
		"rss_bytes": OS.get_static_memory_usage(),
		"uptime_s": Time.get_unix_time_from_system() - _started_at,
	}


# Sign-in ------------------------------------------------------------------------------------------------------------


func _token_valid(margin_seconds: float) -> bool:
	return _token != "" and _token_exp > Time.get_unix_time_from_system() + margin_seconds


func _read_desktop_token() -> void:
	var token := OS.get_environment("WASD_PLAY_TOKEN").strip_edges()
	# On macOS WASD Engine hands the token over in a file only this user can read, which no other program's process
	# list shows, and the game deletes it once read.
	var token_file := OS.get_environment("WASD_PLAY_TOKEN_FILE")
	if token == "" and token_file.is_absolute_path() and FileAccess.file_exists(token_file):
		token = FileAccess.get_file_as_string(token_file).strip_edges()
		DirAccess.remove_absolute(token_file)
	# The token WASD Engine started the game with; a renewed one that outlives it stays.
	if token != "" and float(Tokens.payload(token).get("exp", 0)) > _token_exp:
		_accept_token(token, {})


func _read_build_path() -> void:
	var regex := RegEx.new()
	regex.compile(_BUILD_PATH)
	var found := regex.search(_web.location_path())
	if found != null:
		_game_id = found.get_string(1)
		_version = found.get_string(2).to_int()


func _accept_token(token: String, reply: Dictionary) -> bool:
	var data := Tokens.payload(token)
	if not token.begins_with("wpt1.") or data.is_empty():
		return false
	var expires := float(data.get("exp", 0))
	if expires <= Time.get_unix_time_from_system():
		return false
	var was_signed_in := is_signed_in()
	_token = token
	_token_exp = expires
	_renew_refused = ""
	_me = {"id": str(data.get("p", "")), "name": str(data.get("n", ""))}
	var player_reply: Variant = reply.get("player")
	if player_reply is Dictionary:
		if str(player_reply.get("name", "")) != "":
			_me["name"] = str(player_reply.get("name"))
		if str(player_reply.get("id", "")) != "":
			_me["id"] = str(player_reply.get("id"))
	var game := str(data.get("g", "")).to_lower()
	if Config.is_uuid(game):
		_game_id = game
	if not was_signed_in:
		signed_in.emit(_me.duplicate())
	return true


func _parent_is_wasd() -> bool:
	if _parent_wasd:
		return true
	_web.post_parent({"type": "wasd:play:hello", "v": 1}, config.app_origin)
	var deadline := Time.get_ticks_msec() + 1500
	while not _parent_wasd and Time.get_ticks_msec() < deadline:
		await get_tree().create_timer(0.1, true, false, true).timeout
	return _parent_wasd


func _wait_token_reply(seconds: float, watch_popup: bool) -> Dictionary:
	var deadline := Time.get_ticks_msec() + int(seconds * 1000.0)
	var closed_at := -1
	while _token_reply.is_empty() and Time.get_ticks_msec() < deadline:
		await get_tree().create_timer(0.2, true, false, true).timeout
		if watch_popup and _token_reply.is_empty() and _web.popup_closed():
			if closed_at < 0:
				closed_at = Time.get_ticks_msec()
			elif Time.get_ticks_msec() - closed_at > 1000:
				return {"error": "cancelled"}
	if _token_reply.is_empty():
		return {"error": "timeout"}
	return _token_reply


func _finish_sign_in(reply: Dictionary) -> Dictionary:
	if reply.has("token"):
		if _token_valid(0.0) and _token == str(reply.get("token")):
			return {"ok": true, "player": _me.duplicate()}
		if _accept_token(str(reply.get("token")), reply):
			return {"ok": true, "player": _me.duplicate()}
		return _sign_in_failure("invalid_token", "WASD sign-in returned a token this game can't use.")
	var code := str(reply.get("error", "signed_out"))
	var text := "WASD sign-in failed (%s)." % code
	match code:
		"signed_out":
			text = "Sign in to WASD Engine to play online."
		"cancelled":
			text = "The sign-in window closed before sign-in finished."
		"timeout":
			text = "WASD sign-in did not answer in time."
	return _sign_in_failure(code, text, {"sign_in_url": str(reply.get("sign_in_url", ""))})


func _sign_in_failure(code: String, text: String, extra := {}) -> Dictionary:
	sign_in_failed.emit(code)
	return _failure(code, text, extra)


func _ensure_token() -> Dictionary:
	if _test != "" or _token_valid(60.0):
		return {"ok": true}
	if _web.available and _parent_wasd:
		return await sign_in()
	if _token_valid(0.0) and _renew_refused == "":
		await _renew_token()
		if _token_valid(60.0):
			return {"ok": true}
	if _token != "":
		return _failure("sign_in_expired", _expired_text())
	return _failure("signed_out", "Sign in first: call sign_in() from a button press.")


func _expired_text() -> String:
	if not _web.available:
		return "The WASD sign-in of this game ended. Start the game again from WASD Engine to play online."
	return "The WASD sign-in expired. Call sign_in() again from a button press."


func _maybe_refresh_token(now: float) -> void:
	if _token == "" or _test != "":
		return
	if _web.available and _parent_wasd:
		# The WASD game page mints a fresh token for the game it frames.
		if _token_exp - now > _REFRESH_MARGIN_SECONDS or now - _refresh_asked_at < 60.0:
			return
		_refresh_asked_at = now
		_web.post_parent({"type": "wasd:play:token-request", "v": 1}, config.app_origin)
		return
	# No WASD page frames the game, as in a desktop build that WASD Engine's game library started: the add-on renews
	# its token itself while it is still valid.
	if _renewing or _renew_refused != "" or _token_exp <= now:
		return
	if _token_exp - now > _RENEW_MARGIN_SECONDS or now - _refresh_asked_at < _RENEW_RETRY_SECONDS:
		return
	_refresh_asked_at = now
	_renew_token()


## Exchanges the still-valid token for a fresh one of the same player (POST /api/v1/play/token/renew). The WASD
## service refuses for good once the sign-in is a week old, or ended (signed out), and then the token runs out; network
## failures are tried again a minute later.
func _renew_token() -> void:
	if _renewing:
		while _renewing:
			await get_tree().process_frame
		return
	_renewing = true
	var token := _token
	var response := await _api.request(HTTPClient.METHOD_POST, "/api/v1/play/token/renew", null, token)
	_renewing = false
	if _token != token:
		return
	if response.get("ok", false):
		var data: Dictionary = response.get("data", {})
		if not _accept_token(str(data.get("token", "")), data):
			push_warning("WASD Multiplayer: the WASD service renewed the sign-in with a token this game can't use.")
		return
	var status := int(response.get("status", 0))
	if status == 401 or status == 403 or status == 404:
		_renew_refused = str(response.get("error", "signed_out"))
		push_warning("WASD Multiplayer: the WASD sign-in can't be renewed (%s): %s" % [_renew_refused,
				str(response.get("message", ""))])


func _on_web_message(from: String, origin: String, data: Dictionary) -> void:
	if int(data.get("v", 1)) != 1:
		return
	# Only the WASD website signs players in: messages from a framing page or a window of another origin are ignored,
	# so a page that frames the game elsewhere can't hand it a sign-in or claim to be its game page.
	if Config.origin_of(origin) != Config.origin_of(config.app_origin):
		return
	var type := str(data.get("type", ""))
	if type != "wasd:play:context" and type != "wasd:play:token":
		return
	if from == "parent":
		_parent_wasd = true
	var game := str(data.get("game_id", "")).to_lower()
	if Config.is_uuid(game):
		_game_id = game
	if data.has("version") and str(data.get("version")).is_valid_int():
		_version = maxi(int(data.get("version")), 0)
	if type == "wasd:play:token":
		_token_reply = data
		if data.has("token"):
			_accept_token(str(data.get("token")), data)


# Lobbies ------------------------------------------------------------------------------------------------------------


func _webrtc_available() -> bool:
	if OS.has_feature("web"):
		return true
	if not _webrtc_checked:
		# Native builds have WebRTC only through a GDExtension such as webrtc-native, which registers a subclass.
		_webrtc_checked = true
		_webrtc_works = not ClassDB.get_inheriters_from_class("WebRTCPeerConnectionExtension").is_empty()
	return _webrtc_works


func _webrtc_failure() -> Dictionary:
	return _failure("webrtc_unavailable", "Player-hosted online play runs in the game's Web build. On the desktop, " \
			+ "test with a multiplayer test run, or add the webrtc-native extension.")


func _open_signal(base_url: String, ticket: String) -> Dictionary:
	if base_url == "" or ticket == "":
		return _failure("signal_failed", "The lobby service sent no signal address.")
	_signal_url = base_url + ("&" if base_url.contains("?") else "?") + "ticket=" + ticket.uri_encode()
	_signal_retries = 0
	_signal = SignalClient.new()
	_signal.opened.connect(_on_signal_opened)
	_signal.received.connect(_on_signal_message)
	_signal.closed.connect(_on_signal_closed)
	if _signal.open(_signal_url) != OK:
		return _failure("signal_failed", "The lobby service could not be reached.")
	var deadline := Time.get_ticks_msec() + 10000
	while _signal != null and not _signal.is_open() and _signal.is_active() and Time.get_ticks_msec() < deadline:
		await get_tree().process_frame
	if _signal != null and _signal.is_open():
		return {"ok": true}
	return _failure("signal_failed", "The lobby service could not be reached.")


func _signal_send(message: Dictionary) -> void:
	if _signal != null:
		_signal.send(message)


func _on_signal_message(message: Dictionary) -> void:
	match str(message.get("type", "")):
		"welcome":
			if message.get("lobby") is Dictionary:
				_lobby = message.get("lobby")
			_take_ice(message)
			if _role == _Role.JOINER and not _connections.has(1):
				_create_connection(1, true)
		"ice":
			_take_ice(message)
		"peer_joined":
			if _role == _Role.HOST:
				var id := int(message.get("peer_id", 0))
				if id >= 2 and not _connections.has(id):
					_pending[id] = {"name": str(message.get("name", "")), "player_id": str(message.get("player_id", "")),
							"since": Time.get_unix_time_from_system()}
					_create_connection(id, false)
		"peer_left":
			# A connected joiner's game stays connected while its signal socket comes back, and it leaves when that
			# connection ends; only a joiner that never connected is dropped here.
			if _role == _Role.HOST:
				var id := int(message.get("peer_id", 0))
				if _pending.has(id):
					_pending.erase(id)
					_drop_connection(id)
		"offer", "answer":
			var connection: WebRTCPeerConnection = _connections.get(int(message.get("from", 0)))
			if connection != null:
				var kind := str(message.get("sdp_type", message.get("type")))
				connection.set_remote_description(kind, str(message.get("sdp", "")))
		"candidate":
			var connection: WebRTCPeerConnection = _connections.get(int(message.get("from", 0)))
			if connection != null:
				connection.add_ice_candidate(str(message.get("mid", "")), int(message.get("index", 0)),
						str(message.get("candidate", "")))
		"lobby_updated":
			if message.get("lobby") is Dictionary:
				_lobby = message.get("lobby")
				lobby_updated.emit(_lobby.duplicate(true))
		"lobby_closed":
			_end_lobby(str(message.get("reason", "closed")))
		"kicked":
			_end_lobby("kicked")
		"dropped":
			_end_lobby("dropped")
		"error":
			var code := str(message.get("code", "error"))
			var text := str(message.get("message", ""))
			# The lobby service turns a joiner away before its welcome with one error, then closes the socket.
			if _role == _Role.JOINER and _connect_result.is_empty() and code in ["lobby_locked", "lobby_full",
					"rate_limited"]:
				_connect_result = _failure(code, text)
				return
			push_warning("WASD Multiplayer: the lobby service reported %s: %s" % [code, text])


func _on_signal_opened() -> void:
	_signal_retries = 0


func _on_signal_closed(code: int, reason: String) -> void:
	if _leaving:
		return
	if _role == _Role.JOINER:
		# The close says why the lobby service turned this player away or removed it, since its last message can be
		# lost with the close: Godot's native WebSocketPeer drops a message that arrives together with the close.
		var cause := _close_cause(code, reason)
		if _connect_result.is_empty():
			if cause.is_empty():
				_connect_result = _failure("signal_failed",
						"The lobby service closed the connection before the host answered.")
			else:
				_connect_result = _failure(cause[0], cause[1])
		elif not cause.is_empty() and (cause[0] == "kicked" or cause[0] == "dropped"):
			_end_lobby(cause[0])
		elif code not in _SIGNAL_REFUSALS:
			# The game stays connected to the host without the socket, which comes back so the lobby service keeps
			# counting this player and the host can still remove it.
			_reopen_signal(_REJOIN_DELAYS[mini(_signal_retries, _REJOIN_DELAYS.size() - 1)])
		return
	if _role != _Role.HOST:
		return
	# The lobby stays open for 30 seconds after its host's signal socket drops, so try to get back in time.
	if code in _SIGNAL_REFUSALS or _signal_retries >= 4:
		_end_lobby("signal_lost")
		return
	_reopen_signal(2.0 * (_signal_retries + 1))


## Opens the signal socket again with the same ticket after [param delay] seconds, unless the session ended or a new
## session opened its own socket meanwhile. A failed attempt closes it again, which counts as the next retry.
func _reopen_signal(delay: float) -> void:
	_signal_retries += 1
	var socket := _signal
	var role := _role
	await get_tree().create_timer(delay, true, false, true).timeout
	if _role != role or _signal == null or _signal != socket or _signal.is_active():
		return
	if _signal.open(_signal_url) != OK and _role == _Role.HOST:
		_end_lobby("signal_lost")


func _create_connection(id: int, offer: bool) -> bool:
	var connection := WebRTCPeerConnection.new()
	var error := connection.initialize({"iceServers": _ice_servers})
	if error != OK:
		push_warning("WASD Multiplayer: a WebRTC connection could not start (error %d)." % error)
		return false
	connection.session_description_created.connect(_on_description_created.bind(id))
	connection.ice_candidate_created.connect(_on_candidate_created.bind(id))
	error = _rtc.add_peer(connection, id)
	if error != OK:
		push_warning("WASD Multiplayer: peer %d could not be added (error %d)." % [id, error])
		return false
	_connections[id] = connection
	if offer:
		connection.create_offer()
	return true


func _on_description_created(type: String, sdp: String, id: int) -> void:
	var connection: WebRTCPeerConnection = _connections.get(id)
	if connection == null:
		return
	connection.set_local_description(type, sdp)
	_signal_send({"type": type, "to": id, "sdp": sdp, "sdp_type": type})


func _on_candidate_created(mid: String, index: int, candidate: String, id: int) -> void:
	_signal_send({"type": "candidate", "to": id, "mid": mid, "index": index, "candidate": candidate})


func _drop_connection(id: int) -> void:
	_connections.erase(id)
	if _rtc != null and _rtc.has_peer(id):
		_rtc.remove_peer(id)


func _expire_pending(now: float) -> void:
	for id in _pending.keys():
		if now - float(_pending[id].get("since", now)) > _PENDING_SECONDS:
			_pending.erase(id)
			_drop_connection(id)
			# drop, unlike kick, lets the player try again.
			_signal_send({"type": "drop", "peer_id": id})
			push_warning("WASD Multiplayer: a player could not connect to this host in time and left the lobby.")


func _end_lobby(reason: String) -> void:
	if _role != _Role.HOST and _role != _Role.JOINER:
		return
	if _role == _Role.JOINER and _connect_result.is_empty():
		_connect_result = _failure(reason, _lobby_end_text(reason))
		return
	_teardown()
	lobby_closed.emit(reason)


## Why the lobby service closed this joiner's signal socket, as [error code, text], from the close's code and its
## reason ("<error code>: <text>"); [] when the close does not say.
func _close_cause(code: int, reason: String) -> Array:
	var parts := reason.split(": ", true, 1)
	if parts.size() == 2 and parts[0] in ["lobby_locked", "lobby_full", "rate_limited"]:
		return [parts[0], parts[1]]
	match code:
		4001:
			return ["kicked", _lobby_end_text("kicked")]
		4002:
			return ["dropped", _lobby_end_text("dropped")]
	return []


func _lobby_end_text(reason: String) -> String:
	match reason:
		"kicked":
			return "The host removed this player from the lobby."
		"dropped":
			return "The host could not connect to this player in time. A strict network or firewall may block " \
					+ "it." + _relay_note()
	return "The lobby closed (%s)." % reason


## Takes the ICE servers and the relay's state from the lobby service's welcome or ice message.
func _take_ice(message: Dictionary) -> void:
	var servers: Variant = message.get("ice_servers")
	if servers is Array:
		_ice_servers = servers
	var relay: Variant = message.get("relay")
	if not relay is Dictionary:
		return
	_relay = relay
	var expires_in := float(_relay.get("expires_in", 0))
	_ice_expires_at = Time.get_unix_time_from_system() + expires_in if expires_in > 0.0 else 0.0
	var code := str(_relay.get("code", ""))
	if bool(_relay.get("available", false)) or code == "":
		_relay_warned = ""
	elif code != _relay_warned:
		_relay_warned = code
		push_warning("WASD Multiplayer: " + str(_relay.get("message", "The relay is not available.")))


func _forget_ice() -> void:
	_ice_servers = []
	_relay = {}
	_relay_warned = ""
	_ice_expires_at = 0.0
	_ice_asked_at = -1.0e9


## A lobby host asks again for relay credentials before its own run out, or while the relay is refused, so players who
## join later can still be relayed.
func _maybe_refresh_ice(now: float) -> void:
	if _test != "" or _signal == null or not _signal.is_open() or _relay.is_empty():
		return
	if _ice_expires_at > 0.0:
		if _ice_expires_at - now > _ICE_MARGIN_SECONDS or now - _ice_asked_at < _ICE_RETRY_SECONDS:
			return
	elif str(_relay.get("code", "")) == "" or now - _ice_asked_at < _ICE_REFUSED_RETRY_SECONDS:
		return
	_ice_asked_at = now
	_signal.send({"type": "ice"})


## Why a lobby connection may not open, when the relay is refused: the lobby service's own words.
func _relay_note() -> String:
	if _relay.is_empty() or bool(_relay.get("available", false)) or str(_relay.get("message", "")) == "":
		return ""
	return " " + str(_relay.get("message"))


func _close_lobby_remote() -> void:
	var id := str(_lobby.get("id", ""))
	if id == "" or _token == "":
		return
	await _api.request(HTTPClient.METHOD_DELETE, "/api/v1/play/lobbies/" + id.uri_encode(), null, _token)


# Sessions -----------------------------------------------------------------------------------------------------------


func _start_session() -> Dictionary:
	if _busy:
		return _failure("busy", "Another join or host call is still running.")
	if _role != _Role.NONE:
		return _failure("busy", "Leave the current lobby or server first: call leave().")
	_busy = true
	return {}


func _done(result: Dictionary) -> Dictionary:
	_busy = false
	return result


func _scene_multiplayer() -> SceneMultiplayer:
	return multiplayer as SceneMultiplayer


func _install_peer(inner: MultiplayerPeer, authenticate: bool) -> void:
	var scene := _scene_multiplayer()
	if scene != null:
		scene.auth_callback = _on_auth if authenticate else Callable()
		scene.auth_timeout = _AUTH_SECONDS
		# Peer 1 never forwards one client's packets to another, so every RPC a client sends reaches only peer 1,
		# which validates it; the player list reaches clients through peer 1's own RPCs, not Godot's peer relay.
		scene.server_relay = false
	var peer: MultiplayerPeer = inner
	_counter = null
	if config.count_traffic:
		_counter = CountingPeer.new(inner)
		peer = _counter
	multiplayer.multiplayer_peer = peer


func _connect_socket(url: String, hello: String, as_role: _Role, seconds := _JOIN_SECONDS) -> Dictionary:
	var socket := WebSocketMultiplayerPeer.new()
	# A sleeping server's host answers the handshake only once the server is up.
	socket.handshake_timeout = 10.0 if seconds <= _JOIN_SECONDS else seconds - 5.0
	var error := socket.create_client(url)
	if error != OK:
		return _failure("connection_failed", "The connection could not start (error %d)." % error)
	_hello = hello
	_role = as_role
	_connect_result = {}
	_install_peer(socket, true)
	var result := await _await_connection(seconds)
	if not result.get("ok", false):
		_teardown()
		connection_failed.emit(str(result.get("error", "connection_failed")))
		return result
	return {"ok": true}


func _await_connection(seconds: float) -> Dictionary:
	var deadline := Time.get_ticks_msec() + int(seconds * 1000.0)
	while _connect_result.is_empty() and Time.get_ticks_msec() < deadline:
		await get_tree().process_frame
	if _connect_result.is_empty():
		var note := _relay_note() if _role == _Role.JOINER else ""
		return _failure("timeout", "The connection did not open in time. A strict network or firewall may block " \
				+ "it." + note)
	return _connect_result


func _on_auth(id: int, data: PackedByteArray) -> void:
	var text := data.get_string_from_utf8()
	if _role == _Role.CLIENT and text.begins_with(_REFUSED):
		# The server says why it is about to close this connection.
		if _connect_result.is_empty():
			var reason := text.substr(_REFUSED.length())
			_connect_result = _failure(reason, str(_REFUSALS.get(reason, "The server did not accept this player.")))
		return
	if _role != _Role.SERVER and _role != _Role.HOST:
		return
	var scene := _scene_multiplayer()
	var identity := _identify(text)
	if identity.is_empty():
		_test_event("rejected", {"peer_id": id})
		scene.disconnect_peer(id)
		return
	if _role == _Role.SERVER:
		var refusal := _admission(id, text, identity)
		if refusal != "":
			_test_event("rejected", {"peer_id": id, "reason": refusal})
			scene.send_auth(id, (_REFUSED + refusal).to_utf8_buffer())
			scene.disconnect_peer(id)
			return
	_identities[id] = identity
	scene.complete_auth(id)


## Why a dedicated server turns a verified player away, or "" to admit them: a join ticket admits one connection, and
## the server holds config.max_players. A player who connects again replaces their earlier connection, which a dropped
## network can leave open for a while.
func _admission(id: int, ticket: String, identity: Dictionary) -> String:
	var now := Time.get_unix_time_from_system()
	for used in _used_tickets.keys():
		if float(_used_tickets[used]) <= now:
			_used_tickets.erase(used)
	if ticket.begins_with("wjt1."):
		if _used_tickets.has(ticket):
			return "ticket_used"
		_used_tickets[ticket] = float(Tokens.payload(ticket).get("exp", now))
	var player_id := str(identity.get("id", ""))
	var earlier := []
	for peer in _players:
		if str((_players[peer] as Dictionary).get("id", "")) == player_id:
			earlier.append(peer)
	for peer in _identities:
		if peer != id and str((_identities[peer] as Dictionary).get("id", "")) == player_id:
			earlier.append(peer)
	if earlier.is_empty() and _players.size() + _identities.size() >= config.max_players:
		return "server_full"
	for peer in earlier:
		_identities.erase(peer)
		_scene_multiplayer().disconnect_peer(peer)
	return ""


func _on_peer_authenticating(id: int) -> void:
	if id != 1 or _hello == "" or (_role != _Role.CLIENT and _role != _Role.JOINER):
		return
	var scene := _scene_multiplayer()
	scene.send_auth(1, _hello.to_utf8_buffer())
	scene.complete_auth(1)


func _on_peer_authentication_failed(id: int) -> void:
	if id == 1 and _connect_result.is_empty() and (_role == _Role.CLIENT or _role == _Role.JOINER):
		_connect_result = _failure("rejected", "The server did not accept this player's ticket.")


func _identify(hello: String) -> Dictionary:
	if hello.begins_with("wjt1.") and not _ticket_key.is_empty():
		var data := Tokens.verify(hello, "wjt1", _ticket_key, Time.get_unix_time_from_system())
		if data.is_empty() or (_server_id != "" and str(data.get("s", "")).to_lower() != _server_id):
			return {}
		var player_name := str(data.get("n", ""))
		return {"id": str(data.get("p", "")), "name": player_name if player_name != "" else "Player"}
	if _test != "" and hello.begins_with("test:"):
		var test_name := hello.substr(5).strip_edges().left(32)
		if test_name == "":
			test_name = "Player"
		return {"id": "test-" + test_name.to_lower(), "name": test_name}
	return {}


func _on_peer_connected(id: int) -> void:
	match _role:
		_Role.HOST:
			var identity := {}
			if _identities.has(id):
				identity = _identities[id]
			else:
				var pending: Dictionary = _pending.get(id, {})
				identity = {"id": str(pending.get("player_id", "")), "name": str(pending.get("name", ""))}
			if str(identity.get("name", "")) == "":
				identity["name"] = "Player %d" % id
			_identities.erase(id)
			_pending.erase(id)
			_add_player(id, identity)
		_Role.SERVER:
			if not _identities.has(id):
				_scene_multiplayer().disconnect_peer(id)
				return
			var identity: Dictionary = _identities[id]
			_identities.erase(id)
			_add_player(id, identity)


func _on_peer_disconnected(id: int) -> void:
	_identities.erase(id)
	if _role != _Role.HOST and _role != _Role.SERVER:
		return
	_pending.erase(id)
	if _role == _Role.HOST:
		_connections.erase(id)
	if _players.has(id):
		_players.erase(id)
		player_left.emit(id)
		_test_event("player_left", {"peer_id": id})
		_send_roster()
		_update_server_fps()


func _on_connected_to_server() -> void:
	if _connect_result.is_empty():
		_connect_result = {"ok": true}
		_test_event("connected", {"peer_id": multiplayer.get_unique_id()})


func _on_connection_failed() -> void:
	if _connect_result.is_empty():
		_connect_result = _failure("connection_failed", "Could not connect. A strict network or firewall may block it.")


func _on_server_disconnected() -> void:
	if _role != _Role.CLIENT and _role != _Role.JOINER:
		return
	if _connect_result.is_empty():
		_connect_result = _failure("rejected", "The connection closed before it opened.")
		return
	if _role == _Role.JOINER:
		_end_lobby("host_left")
		return
	_teardown()
	connection_failed.emit("disconnected")


func _add_player(id: int, identity: Dictionary) -> void:
	_players[id] = identity
	player_joined.emit(id, identity.duplicate())
	_test_event("player_joined", {"peer_id": id, "name": str(identity.get("name", ""))})
	_send_roster()
	_update_server_fps()


func _send_roster() -> void:
	if (_role == _Role.HOST or _role == _Role.SERVER) and _remote_count() > 0:
		_wasd_roster.rpc(_players)


@rpc("authority", "call_remote", "reliable")
func _wasd_roster(roster: Dictionary) -> void:
	var updated := {}
	for key in roster:
		var entry: Variant = roster[key]
		if entry is Dictionary:
			updated[int(key)] = {"id": str(entry.get("id", "")), "name": str(entry.get("name", ""))}
	var previous := _players
	_players = updated
	for id in updated:
		if not previous.has(id):
			player_joined.emit(id, (updated[id] as Dictionary).duplicate())
	for id in previous:
		if not updated.has(id):
			player_left.emit(id)


@rpc("authority", "call_remote", "reliable")
func _wasd_warning(seconds: int, reason: String, text: String) -> void:
	_test_event("warning", {"seconds": seconds, "reason": reason})
	server_warning.emit(seconds, reason, text)


func _teardown() -> void:
	_leaving = true
	var departed := _players.keys()
	_role = _Role.NONE
	if _signal != null:
		_signal.close()
		_signal = null
	_add_traffic()
	_connections.clear()
	_pending.clear()
	_identities.clear()
	_players.clear()
	_used_tickets.clear()
	var peer := multiplayer.multiplayer_peer
	if peer != null and not peer is OfflineMultiplayerPeer:
		peer.close()
	multiplayer.multiplayer_peer = OfflineMultiplayerPeer.new()
	var scene := _scene_multiplayer()
	if scene != null:
		scene.auth_callback = Callable()
	_rtc = null
	_counter = null
	_lobby = {}
	_forget_ice()
	_peer_id = 0
	_hello = ""
	_server = {}
	_restore_fps()
	_leaving = false
	for id in departed:
		player_left.emit(id)


func _remote_count() -> int:
	match _role:
		_Role.HOST:
			return maxi(_players.size() - 1, 0)
		_Role.SERVER:
			return _players.size()
		_Role.JOINER, _Role.CLIENT:
			var peer := multiplayer.multiplayer_peer
			return 1 if peer != null and peer.get_connection_status() == MultiplayerPeer.CONNECTION_CONNECTED else 0
	return 0


# Dedicated server ---------------------------------------------------------------------------------------------------


func _server_tick(now: float) -> void:
	if now - _status_at >= _STATUS_SECONDS:
		_status_at = now
		_write_status(not _stopping)
	if now - _control_at >= _CONTROL_SECONDS:
		_control_at = now
		_read_control()


func _write_status(ready: bool) -> void:
	if _files == null:
		return
	_files.write_status({
		"v": 1,
		"at": int(Time.get_unix_time_from_system()),
		"ready": ready,
		"players": _players.size(),
		"tick_ms_avg": _average(_window),
		"tick_ms_max": float(_window["max"]),
	})
	_window = {"sum": 0.0, "max": 0.0, "count": 0}


func _read_control() -> void:
	if _files == null:
		return
	var command := _files.next_command()
	if command.is_empty():
		return
	var warn: Variant = command.get("warn")
	if warn is Dictionary:
		var seconds := int(warn.get("seconds", 60))
		var reason := str(warn.get("reason", "maintenance"))
		var text := str(warn.get("message", ""))
		server_warning.emit(seconds, reason, text)
		_test_event("warning", {"seconds": seconds, "reason": reason})
		if _remote_count() > 0:
			_wasd_warning.rpc(seconds, reason, text)
	if bool(command.get("stop", false)):
		_stop_server()


## In a server_stopping() handler, before a save that awaits, such as one that writes in a thread: keeps the server
## running until stop_ready() is called once for each delay_stop(), for up to 15 seconds.
func delay_stop() -> void:
	if _stopping:
		_stop_holds += 1


## Ends one delay_stop(), once the save it announced has finished.
func stop_ready() -> void:
	_stop_holds = maxi(_stop_holds - 1, 0)


func _stop_server() -> void:
	if _stopping:
		return
	_stopping = true
	server_stopping.emit()
	_write_status(false)
	_test_event("stopping", {})
	await get_tree().process_frame
	# Saves that a handler announced with delay_stop() finish first, within the time WASD gives a stopping server.
	var deadline := Time.get_ticks_msec() + int(_STOP_WAIT_SECONDS * 1000.0)
	while _stop_holds > 0 and Time.get_ticks_msec() < deadline:
		await get_tree().process_frame
	await get_tree().process_frame
	_print_test_stats()
	get_tree().quit()


func _update_server_fps() -> void:
	if _role != _Role.SERVER:
		return
	Engine.max_fps = config.server_idle_fps if _players.is_empty() and config.server_idle_fps > 0 else _active_fps


func _restore_fps() -> void:
	if _original_fps >= 0:
		Engine.max_fps = _original_fps
		_original_fps = -1


# Measurements -------------------------------------------------------------------------------------------------------


func _sample_tick() -> void:
	var milliseconds := (Performance.get_monitor(Performance.TIME_PROCESS) \
			+ Performance.get_monitor(Performance.TIME_PHYSICS_PROCESS)) * 1000.0
	for window in [_window, _total]:
		window["sum"] = float(window["sum"]) + milliseconds
		window["max"] = maxf(float(window["max"]), milliseconds)
		window["count"] = int(window["count"]) + 1


static func _average(window: Dictionary) -> float:
	var count := int(window["count"])
	return float(window["sum"]) / count if count > 0 else 0.0


func _traffic_now() -> Dictionary:
	var traffic := _traffic.duplicate()
	if _counter != null:
		traffic["bytes_in"] += _counter.bytes_in
		traffic["bytes_out"] += _counter.bytes_out
		traffic["packets_in"] += _counter.packets_in
		traffic["packets_out"] += _counter.packets_out
	return traffic


func _add_traffic() -> void:
	_traffic = _traffic_now()
	_counter = null


# Test mode ----------------------------------------------------------------------------------------------------------


func _start_test() -> void:
	if _test != "host" and _test != "client" and _test != "server":
		push_error("WASD Multiplayer: WASD_MULTIPLAYER_TEST must be host, client, or server, not \"%s\"." % _test)
		return
	_arm_test_end()
	var result := {}
	match _test:
		"host":
			result = await host_lobby({})
		"client":
			if config.mode == "dedicated" or OS.get_environment("WASD_TEST_TICKET") != "":
				result = await join_server()
			else:
				result = await join_lobby("TEST")
		"server":
			await get_tree().create_timer(3.0, true, false, true).timeout
			if _role != _Role.NONE or _busy:
				return
			push_warning("WASD Multiplayer: the game did not call serve() within 3 seconds, so the test run starts it.")
			result = await serve()
	if not result.get("ok", false) and str(result.get("error", "")) != "busy":
		_test_event("failed", {"error": str(result.get("error", "")), "message": str(result.get("message", ""))})


func _arm_test_end() -> void:
	var text := OS.get_environment("WASD_TEST_SECONDS").strip_edges()
	var seconds := text.to_float() if text.is_valid_float() else 20.0
	await get_tree().create_timer(maxf(seconds, 1.0), true, false, true).timeout
	_print_test_stats()
	get_tree().quit()


func _test_host_lobby(options: Dictionary) -> Dictionary:
	var port := _env_int("WASD_TEST_PORT", 0)
	if port <= 0:
		return _failure("test_port", "WASD_TEST_PORT is not set.")
	var socket := WebSocketMultiplayerPeer.new()
	var error := socket.create_server(port, "127.0.0.1")
	if error != OK:
		return _failure("listen_failed", "The test host could not listen on port %d (error %d)." % [port, error])
	_role = _Role.HOST
	_install_peer(socket, true)
	_me = _test_identity()
	_lobby = {"id": "test", "code": "TEST", "name": str(options.get("name", "Test lobby")), "public": false,
			"locked": false, "max_players": config.max_players, "players": 1, "version": _version,
			"host": {"name": _me.get("name")}, "data": {}, "created_at": ""}
	_players = {1: _me.duplicate()}
	lobby_joined.emit(_lobby.duplicate(true))
	player_joined.emit(1, _me.duplicate())
	_test_event("ready", {"port": port})
	return {"ok": true, "lobby": _lobby.duplicate(true), "code": "TEST"}


func _test_join_lobby() -> Dictionary:
	var port := _env_int("WASD_TEST_PORT", 0)
	if port <= 0:
		return _failure("test_port", "WASD_TEST_PORT is not set.")
	_me = _test_identity()
	var url := OS.get_environment("WASD_TEST_URL").strip_edges()
	if url == "":
		url = "ws://127.0.0.1:%d" % port
	var result := await _connect_socket(url, "test:" + str(_me.get("name")), _Role.JOINER)
	if not result.get("ok", false):
		return result
	_lobby = {"id": "test", "code": "TEST", "name": "Test lobby", "public": false, "locked": false,
			"max_players": config.max_players, "players": 0, "version": _version, "host": {"name": ""}, "data": {},
			"created_at": ""}
	lobby_joined.emit(_lobby.duplicate(true))
	connected.emit()
	return {"ok": true, "lobby": _lobby.duplicate(true)}


func _test_join_server() -> Dictionary:
	var port := _env_int("WASD_TEST_PORT", 0)
	var url := OS.get_environment("WASD_TEST_URL").strip_edges()
	if url == "":
		if port <= 0:
			return _failure("test_port", "WASD_TEST_PORT is not set.")
		url = "ws://127.0.0.1:%d/s/test" % port
	_me = _test_identity()
	var ticket := OS.get_environment("WASD_TEST_TICKET").strip_edges()
	var result := await _connect_socket(url, ticket if ticket != "" else "test:" + str(_me.get("name")), _Role.CLIENT)
	if result.get("ok", false):
		connected.emit()
		result["server"] = {"id": "test", "name": "Test server"}
	return result


func _test_identity() -> Dictionary:
	var player_name := OS.get_environment("WASD_TEST_NAME").strip_edges().left(32)
	if player_name == "":
		player_name = {"host": "Host", "server": "Server"}.get(_test, "Player")
	return {"id": "test-" + player_name.to_lower(), "name": player_name}


func _test_event(event: String, data: Dictionary) -> void:
	if _test == "":
		return
	var line := {"event": event, "role": role()}
	line.merge(data)
	print("WASD_TEST_EVENT " + JSON.stringify(line))


func _print_test_stats() -> void:
	if _test == "" or _stats_printed:
		return
	_stats_printed = true
	var traffic := _traffic_now()
	print("WASD_TEST_STATS " + JSON.stringify({
		"role": _test,
		"name": str(_test_identity().get("name")),
		"connected": _role != _Role.NONE,
		"peers": _peak_peers,
		"bytes_in": traffic["bytes_in"],
		"bytes_out": traffic["bytes_out"],
		"packets_in": traffic["packets_in"],
		"packets_out": traffic["packets_out"],
		"tick_ms_avg": _average(_total),
		"tick_ms_max": float(_total["max"]),
		"rss_bytes": OS.get_static_memory_usage(),
		"seconds": Time.get_unix_time_from_system() - _started_at,
	}))


# Helpers ------------------------------------------------------------------------------------------------------------


func _failure(code: String, text: String, extra := {}) -> Dictionary:
	var failure := {"ok": false, "error": code, "message": text}
	failure.merge(extra)
	if code != "busy":
		push_warning("WASD Multiplayer: " + text)
	return failure


func _report(response: Dictionary) -> Dictionary:
	push_warning("WASD Multiplayer: %s (%s)" % [str(response.get("message", "")), str(response.get("error", ""))])
	return response


static func _env_int(variable: String, fallback: int) -> int:
	var text := OS.get_environment(variable).strip_edges()
	return text.to_int() if text.is_valid_int() else fallback
