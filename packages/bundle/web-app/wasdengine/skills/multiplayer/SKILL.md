---
name: multiplayer
description: Add online multiplayer to a Godot game with WASD Engine. Load before choosing between free player-hosted lobbies and paid WASD dedicated servers, before writing networking code, and before creating, resizing, deploying, or deleting a WASD game server.
---

# Online multiplayer with WASD

## Agree on the mode first

Call `wasd_multiplayer_guide` and show the person its comparison before setting anything up. Then follow four rules:

1. Show the two-mode comparison before any setup, including that every player signs in with a WASD Engine account in both modes.
2. State the monthly price and what it includes before suggesting a server. Read sizes and prices from `wasd_server_plans`; never quote them from memory.
3. Let the person choose the size; never pick one for them.
4. Explain that a server stops for the rest of its billing month when its bandwidth runs out, after emails at 70%, 90%, and 100%, and suggest a smaller size when a server is mostly idle.

The tradeoffs to explain:

- **Player-hosted (free).** One player's game hosts and the others join with a 6-letter code or from a public list. Good for co-op and matches with friends: 2 to 8 players, 16 at most. The session ends when the host leaves, a host in a browser must keep the game's tab open and in front, the host can cheat, and players see each other's IP addresses unless their connection is relayed. The relay has a monthly fair-use amount per game; past it, players whose networks block a direct connection can't join until the next month, and `wasd_lobby_stats` says so.
- **Dedicated server (monthly price per server).** WASD runs the game's server build in Oregon. The world persists, players join any time, the server decides what happens, and players' IP addresses stay hidden. Each size has fixed CPU, memory, monthly bandwidth, and storage.

`wasd_server_create` and `wasd_server_change` never charge anything: they return a link that the person opens to confirm on wasdengine.com. Give the person the link, and report a server as created only after `wasd_server_status` shows it.

## Set up

Run `wasd_multiplayer_setup` with the chosen mode. It adds the WASD Multiplayer add-on (`res://addons/wasd_multiplayer/`, autoload `WasdMultiplayer`) and `res://wasd_multiplayer.cfg`. Release writes the game id into that file; do not edit it by hand. `addons/wasd_multiplayer/examples/lobby_menu.tscn` is a working menu to adapt.

## Structure the game

Write host-authoritative Godot multiplayer. Peer 1 (the lobby host or the dedicated server) owns the world, and the add-on only provides the connection:

- Start from a menu: on a successful `host_lobby()`, `join_lobby(code)`, `join_server()`, or `serve()`, change to the world scene. `sign_in()`, hosting, and joining open a browser window when needed, so call them from button presses.
- In the world scene's `_ready`, spawn every entry of `WasdMultiplayer.players()`, then connect `player_joined` and `player_left`. Never spawn from `multiplayer.peer_connected`: the add-on reports only signed-in players, the lobby host is player 1 itself, and a dedicated server is not a player. Name each player node after its peer id and give the client authority over nothing but its input.
- Spawn and free networked nodes only on peer 1, through a `MultiplayerSpawner`. Replicate positions and state with `MultiplayerSynchronizer`; clients send input with `@rpc("any_peer", "call_remote", "unreliable_ordered")` to peer 1, which validates it and moves the player. Check `multiplayer.is_server()` before running world logic.
- One project builds the client and the server. Branch on `WasdMultiplayer.is_server()`: the server skips cameras, UI, audio, and effects, calls `serve()`, saves the world under `user://` every few minutes and on `server_stopping`, and keys saved player data by `player.id`, which stays the same for a player across devices.
- Handle `lobby_closed` (the host left, or `dropped`: the host could not connect to this player, who may join again) and `connection_failed` by returning to the menu, show the result's `message` when a join fails, and show `server_warning` messages as a banner.
- Offer `kick(peer_id)` only for removing a player for good: a kicked account can never join that lobby again.

## Keep it fast and within bandwidth

- Run servers at 30 ticks per second (`physics/common/physics_ticks_per_second = 30`), and set synchronizers to send 20 to 30 times per second at most (`replication_interval`), with rarely changing properties on change only.
- Synchronize the fewest properties that show the game: position and a few state flags rather than whole nodes. A typical action game uses about 100 MB per player-hour in both directions; every size's monthly bandwidth assumes that.
- Above about 25 players, send each player only what is near them with `MultiplayerSynchronizer.add_visibility_filter()` or `set_visibility_for()`. Godot runs game logic on one thread, so past about 100 players split the world into zones on separate servers.

## Test

Run `wasd_multiplayer_test` after each networking change. It starts a host or server and 1 to 3 clients on this computer over a loopback connection, without WASD services or charges, and reports tick time, memory, and MB per player-hour, with the server size that fits. Player-hosted WebRTC itself runs only in Web builds, so the real online test is the released game in two browser windows.

## Release and run servers

`wasd_release_game` publishes the Web build; in dedicated mode it also uploads the server build, and the game's servers move to the new version with a 60-second warning to players. An older version on the game's page cannot join a server that runs a newer one.

Use `wasd_server_status` and `wasd_server_logs` to see a server's state, players, CPU, memory, bandwidth, and errors. `wasd_server_deploy` redeploys a release's server build and restarts the server, and `wasd_server_manage` starts, stops, restarts, backs up, or restores it: tell the person before a restart, and ask before a restore, which replaces the world with the backup.
