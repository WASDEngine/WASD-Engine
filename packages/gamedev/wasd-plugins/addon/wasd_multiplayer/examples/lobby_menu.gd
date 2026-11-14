# SPDX-License-Identifier: CC0-1.0
# An example lobby menu for WASD Multiplayer: sign in, host a lobby or join one by its code, list public lobbies, or
# join the game's dedicated server. In a dedicated server build it starts the server instead. Copy it into the game,
# restyle it, and set world_scene to the scene that opens once this game hosts, joins, or serves.
extends Control

## The scene to open after hosting, joining, or starting the server. Empty keeps this menu open.
@export_file("*.tscn") var world_scene := ""

var _status: Label
var _code: LineEdit
var _lobbies: ItemList
var _players: Label
var _buttons: Array[Button] = []


func _ready() -> void:
	_build()
	WasdMultiplayer.signed_in.connect(func(player: Dictionary) -> void: _say("Signed in as %s." % player.get("name")))
	WasdMultiplayer.lobby_joined.connect(func(lobby: Dictionary) -> void: _say("In lobby %s." % lobby.get("code")))
	WasdMultiplayer.lobby_closed.connect(func(reason: String) -> void: _say("The lobby closed (%s)." % reason))
	WasdMultiplayer.connection_failed.connect(func(reason: String) -> void: _say("Connection failed (%s)." % reason))
	WasdMultiplayer.server_warning.connect(func(seconds: int, _reason: String, message: String) -> void:
		_say("%s The server restarts in %d seconds." % [message, seconds]))
	WasdMultiplayer.player_joined.connect(func(_peer: int, _player: Dictionary) -> void: _show_players())
	WasdMultiplayer.player_left.connect(func(_peer: int) -> void: _show_players())
	if WasdMultiplayer.is_server():
		_set_buttons_enabled(false)
		_say("Starting the server...")
		var result: Dictionary = await WasdMultiplayer.serve()
		_say("Serving on port %d." % result.get("port") if result.get("ok") else str(result.get("message")))
		if result.get("ok"):
			_open_world()
		return
	_say("Sign in with WASD to play online." if not WasdMultiplayer.is_signed_in() else "Ready.")
	_show_players()


func _build() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(center)
	var column := VBoxContainer.new()
	column.custom_minimum_size = Vector2(360, 0)
	column.add_theme_constant_override("separation", 8)
	center.add_child(column)
	_status = Label.new()
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	column.add_child(_status)
	column.add_child(_button("Sign in", _on_sign_in))
	column.add_child(_button("Host a lobby", _on_host))
	var row := HBoxContainer.new()
	_code = LineEdit.new()
	_code.placeholder_text = "Lobby code"
	_code.max_length = 6
	_code.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_code.text_submitted.connect(func(_text: String) -> void: _on_join_code())
	row.add_child(_code)
	row.add_child(_button("Join", _on_join_code))
	column.add_child(row)
	column.add_child(_button("Find public lobbies", _on_find))
	_lobbies = ItemList.new()
	_lobbies.custom_minimum_size = Vector2(0, 120)
	_lobbies.item_activated.connect(_on_lobby_chosen)
	column.add_child(_lobbies)
	column.add_child(_button("Join the game's server", _on_join_server))
	column.add_child(_button("Leave", _on_leave))
	_players = Label.new()
	_players.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	column.add_child(_players)


func _button(text: String, action: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.pressed.connect(action)
	_buttons.append(button)
	return button


func _on_sign_in() -> void:
	_say("Signing in...")
	var result: Dictionary = await WasdMultiplayer.sign_in()
	if not result.get("ok"):
		_say(str(result.get("message")))


func _on_host() -> void:
	_say("Opening a lobby...")
	var result: Dictionary = await WasdMultiplayer.host_lobby({"public": true, "name": "%s's game" % _my_name()})
	if result.get("ok"):
		_say("Lobby code: %s. Share it with friends." % result.get("code"))
		_open_world()
	else:
		_say(str(result.get("message")))


func _on_join_code() -> void:
	var code := _code.text.strip_edges().to_upper()
	if code.length() != 6:
		_say("A lobby code has 6 characters.")
		return
	await _join(code)


func _on_find() -> void:
	_say("Looking for lobbies...")
	var result: Dictionary = await WasdMultiplayer.list_lobbies()
	_lobbies.clear()
	if not result.get("ok"):
		_say(str(result.get("message")))
		return
	for lobby: Dictionary in result.get("lobbies", []):
		var index := _lobbies.add_item("%s  (%d/%d)" % [lobby.get("name", "Lobby"), int(lobby.get("players", 0)),
				int(lobby.get("max_players", 0))])
		_lobbies.set_item_metadata(index, str(lobby.get("code", "")))
	_say("%d open lobbies." % _lobbies.item_count if _lobbies.item_count > 0 else "No open lobbies. Host one!")


func _on_lobby_chosen(index: int) -> void:
	await _join(str(_lobbies.get_item_metadata(index)))


func _join(code: String) -> void:
	_say("Joining %s..." % code)
	var result: Dictionary = await WasdMultiplayer.join_lobby(code)
	if result.get("ok"):
		_open_world()
	else:
		_say(str(result.get("message")))


func _on_join_server() -> void:
	_say("Joining the server...")
	var result: Dictionary = await WasdMultiplayer.join_server()
	if result.get("ok"):
		_say("Connected to %s." % result.get("server", {}).get("name", "the server"))
		_open_world()
	else:
		_say(str(result.get("message")))


func _on_leave() -> void:
	WasdMultiplayer.leave()
	_say("Left.")
	_show_players()


func _open_world() -> void:
	if world_scene != "":
		get_tree().change_scene_to_file(world_scene)


func _show_players() -> void:
	var names: Array[String] = []
	for player: Dictionary in WasdMultiplayer.players().values():
		names.append(str(player.get("name", "")))
	_players.text = "Players: " + (", ".join(names) if not names.is_empty() else "none yet")


func _my_name() -> String:
	return str(WasdMultiplayer.player().get("name", "Player"))


func _set_buttons_enabled(enabled: bool) -> void:
	for button in _buttons:
		button.disabled = not enabled


func _say(text: String) -> void:
	_status.text = text
