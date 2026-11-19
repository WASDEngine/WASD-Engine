# WASD Multiplayer

English | [中文](README.zh.md)

WASD Multiplayer is the Godot 4 add-on that connects a game to WASD Engine's online play: WASD sign-in for players, player-hosted lobbies, and WASD dedicated servers. WASD Engine's multiplayer setup copies this folder into a game as `res://addons/wasd_multiplayer/`, registers the `WasdMultiplayer` autoload, and writes `res://wasd_multiplayer.cfg`. The add-on is GDScript only, so Web builds keep working, and its files carry the CC0-1.0 license so that they can ship inside any game.

## Modes

- **Player-hosted.** One player's game hosts a lobby and the other players connect to it over WebRTC. WASD brokers the connection: lobby codes, a list of public lobbies, the exchange of connection offers, and a relay for players whose networks block a direct connection. It costs nothing; the relay has a monthly fair-use amount per game, past which it is off for that game until the next month. The session ends when the host leaves, a host playing in a browser must keep the game's tab open and in front, and a native desktop build needs the webrtc-native extension for this mode. The server build can never host a lobby.
- **Dedicated server.** WASD runs the game's server build, and players join it over a secure WebSocket with a join ticket that expires after two minutes. The server decides what happens, the world stays when everyone leaves, and the game's owner pays a monthly price per server.

Both modes set `multiplayer.multiplayer_peer` and leave the rest to Godot's own multiplayer: `@rpc`, `MultiplayerSpawner`, and `MultiplayerSynchronizer`, with peer 1 as the authority. Every player signs in with a WASD Engine account.

## Use it

```gdscript
# Menu, player-hosted: call from a button press, because a browser opens the sign-in window only after a click.
var result: Dictionary = await WasdMultiplayer.host_lobby({"public": true, "max_players": 8})
if result.ok:
	show_code(result.code)  # Six characters, such as K7Q2XM.
result = await WasdMultiplayer.join_lobby("K7Q2XM")

# Menu, dedicated: the server build serves; every other build joins.
if WasdMultiplayer.is_server():
	await WasdMultiplayer.serve()
else:
	result = await WasdMultiplayer.join_server()

# World scene: spawn the players already present, then follow joins and leaves.
func _ready() -> void:
	for peer_id in WasdMultiplayer.players():
		spawn(peer_id)
	WasdMultiplayer.player_joined.connect(func(peer_id: int, _player: Dictionary) -> void: spawn(peer_id))
	WasdMultiplayer.player_left.connect(despawn)
```

React to `player_joined` and `player_left` rather than `multiplayer.peer_connected`: they report only players that WASD signed in, with each player's `{"id", "name"}`. The `id` stays the same for a player across sessions and devices in this game, so a server can key saved progress by it.

## API

Coroutines resolve to `{"ok": true, ...}` or to `{"ok": false, "error": <code>, "message": <text>}`.

| Member | What it does |
|---|---|
| `sign_in()` | Signs the player in. On a WASD game page the page answers at once; elsewhere a WASD sign-in window opens, and a desktop build that WASD Engine started signs in with the token it got. The sign-in then lasts while the game runs, up to a week. |
| `host_lobby(options)` | Hosts a lobby; `options` takes `name`, `public`, `max_players` (2 to 16), and `data`. Resolves with `lobby` and `code`. |
| `join_lobby(code)` | Joins a lobby by its code and resolves once connected to the host. |
| `list_lobbies()` | Lists the public lobbies of this release that have room, as `lobbies`. |
| `set_lobby(options)` | Changes the hosted lobby's `name`, `public`, `locked`, or `data`. |
| `kick(peer_id)` | Removes a player from the hosted lobby, which their account can't join again, or from the server. |
| `join_server(server_id)` | Joins the named server, or this release's running server with the fewest players, or else a sleeping one, which the connection wakes: `server_waking()` fires, and the join takes a few seconds longer. |
| `list_servers()` | Lists this game's dedicated servers, as `servers`; a `sleeping` server wakes when a player joins it. |
| `serve()` | In a dedicated server, listens on `WASD_PORT` and admits only players with a valid join ticket, each ticket once, up to `max_players` at a time; a player who connects again replaces their earlier connection. A refused player's join resolves with `server_full` or `ticket_used`. |
| `leave()` | Leaves the lobby or the server; a host's lobby closes for everyone. |
| `delay_stop()`, `stop_ready()` | In a dedicated server's `server_stopping()` handler, keep the server running while a save that awaits finishes, for up to 15 seconds. |
| `is_server()`, `is_signed_in()`, `player()`, `role()`, `lobby()`, `players()`, `player_info(peer_id)` | Read the current state. |
| `stats()` | Traffic in bytes and packets, connected peers, and time per frame. |

Signals: `signed_in(player)`, `sign_in_failed(reason)`, `lobby_joined(lobby)`, `lobby_updated(lobby)`, `lobby_closed(reason)`, `player_joined(peer_id, player)`, `player_left(peer_id)`, `connected()`, `connection_failed(reason)`, `server_warning(seconds, reason, message)`, `server_waking()`, and `server_stopping()`. A dedicated server receives `server_stopping()` before WASD stops it, also when it goes to sleep without players; save the world in that handler. A save that awaits, such as one that writes in a thread, calls `delay_stop()` first and `stop_ready()` once it has finished, and the server quits once every such save has, or after 15 seconds. `server_waking()` tells a joining player's game that the server is starting, so it can say so. `lobby_closed` names why the lobby ended: `host_left`, `closed`, `replaced`, `kicked` (the host removed this player), `dropped` (the host could not connect to this player in time; joining again is allowed), `left`, or `signal_lost`.

A host that does not hear from a joining player within 30 seconds drops that player, who may join again; `kick()` instead keeps the player's account out of the lobby for good. When a player's network blocks a direct connection and the relay is off for the game, a join that times out says so in its `message`. Once connected, a player stays in the game while its connection to the WASD lobby service drops and comes back: the add-on reconnects on its own, first after 2 seconds and then less often, and the host keeps the player meanwhile. A host whose connection fails four tries in a row, about 20 seconds, ends the lobby with `signal_lost`, since WASD closes a lobby 30 seconds after its host goes.

## Configuration

`res://wasd_multiplayer.cfg`, section `[wasd]`, overrides the same keys under `wasd_multiplayer/config/` in Project Settings:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `"player_hosted"` | `"player_hosted"` or `"dedicated"`. |
| `max_players` | `8` | The lobby size `host_lobby()` offers by default, 2 to 16; in `dedicated` mode, how many players the server admits at once, 2 to 500. |
| `api_origin`, `app_origin` | `"https://app.wasdengine.com"` | The WASD play API and the website that signs players in. A Web build takes sign-in messages only from a framing page or a sign-in window of `app_origin`. |
| `game_id` | `""` | The released game's id, which Release writes. |
| `version` | `0` | The release; a Web build on WASD reads it from its own address instead. |
| `count_traffic` | `true` | Count multiplayer traffic for `stats()`. |
| `server_fps`, `server_idle_fps` | `0`, `10` | A dedicated server's frame rate while players are connected (`0` uses the physics rate) and while nobody is. |

WASD tooling and WASD servers set environment variables, which override the file: `WASD_PLAY_TOKEN`, or on macOS `WASD_PLAY_TOKEN_FILE`, a file that holds the token, which the add-on deletes once it read it, `WASD_API_ORIGIN`, `WASD_GAME_ID`, and `WASD_GAME_VERSION` on the desktop, and `WASD_SERVER`, `WASD_SERVER_ID`, `WASD_PORT`, `WASD_TICKET_KEY`, `WASD_STATUS_FILE`, and `WASD_CONTROL_FILE` on a server. Without a WASD game page to ask, the add-on renews its player token through the WASD play API half an hour before it expires, for up to a week after the first sign-in. A server listens on every interface, or on `WASD_BIND_ADDRESS` when set; test runs listen on `127.0.0.1` only.

## Test runs

With `WASD_MULTIPLAYER_TEST` set to `host`, `client`, or `server`, the add-on runs over a loopback WebSocket on `WASD_TEST_PORT` without WASD services, starts on its own, and uses `WASD_TEST_NAME` as the player's name. A `server` run verifies tickets when `WASD_TICKET_KEY` is set, and a `client` run joins the server when the mode is `dedicated` or `WASD_TEST_TICKET` holds a ticket (`WASD_TEST_URL` overrides the address). The run prints `WASD_TEST_EVENT` lines (`ready`, `connected`, `player_joined`, `player_left`, `warning`, `rejected`, `stopping`, `failed`) and, after `WASD_TEST_SECONDS` (20 by default), one `WASD_TEST_STATS` line, then quits. Each line is the prefix and a JSON object.

## Known limitations

- Player-hosted play in a native desktop build needs the webrtc-native extension; a desktop test run uses the loopback WebSocket instead.
- Traffic counts cover multiplayer payloads only, not WebSocket, TLS, DTLS, or IP overhead.
- A host's lobby cannot move to another player when the host leaves.
- A Web build on a page whose origin is not `app_origin`, such as a WASD game page opened under another of the site's hostnames, signs in through the WASD sign-in window instead of the page.
- A desktop build's sign-in ends a week after WASD Engine started the game, when that WASD Engine sign-in ends, or when the computer sleeps past the token's expiry; start the game again from WASD Engine to play online.
