# SPDX-License-Identifier: CC0-1.0
# Settings of WASD Multiplayer: defaults, then the project settings under "wasd_multiplayer/", then
# res://wasd_multiplayer.cfg (section [wasd], written by WASD Engine's multiplayer setup and Release), then the
# environment that WASD tooling and WASD game servers set.
extends RefCounted

const CONFIG_PATH := "res://wasd_multiplayer.cfg"
const DEFAULT_ORIGIN := "https://app.wasdengine.com"
const _UUID_PATTERN := "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"

## "player_hosted" or "dedicated".
var mode := "player_hosted"
## The lobby size a host offers when host_lobby() is not told otherwise (2 to 16).
var max_players := 8
## Where the WASD play API lives, without a trailing slash.
var api_origin := DEFAULT_ORIGIN
## The WASD website, which signs players in, without a trailing slash.
var app_origin := DEFAULT_ORIGIN
## The released game's id (a UUID), or "" before the first release.
var game_id := ""
## The release this build belongs to; 0 for builds that were never released.
var version := 0
## Count the bytes the multiplayer peer sends and receives, for stats().
var count_traffic := true
## Frames per second of a dedicated server while players are connected; 0 uses the physics tick rate.
var server_fps := 0
## Frames per second of a dedicated server while nobody is connected; 0 keeps server_fps.
var server_idle_fps := 10


## Reads every source in order. Later sources override earlier ones.
func load_all() -> void:
	_load_project_settings()
	_load_file()
	_load_environment()
	_normalize()


## True when [param text] is a lowercase UUID with dashes, the form WASD uses for ids.
static func is_uuid(text: String) -> bool:
	var regex := RegEx.new()
	regex.compile(_UUID_PATTERN)
	return regex.search(text) != null


## The scheme://host[:port] part of a URL, lowercased, or "" when it has none.
static func origin_of(url: String) -> String:
	var scheme_end := url.find("://")
	if scheme_end < 0:
		return ""
	var rest := url.substr(scheme_end + 3)
	var slash := rest.find("/")
	var host := rest if slash < 0 else rest.substr(0, slash)
	return (url.substr(0, scheme_end + 3) + host).to_lower()


func _load_project_settings() -> void:
	for key in ["mode", "max_players", "api_origin", "app_origin", "game_id", "version", "count_traffic",
			"server_fps", "server_idle_fps"]:
		var setting: String = "wasd_multiplayer/config/" + key
		if ProjectSettings.has_setting(setting):
			_set_value(key, ProjectSettings.get_setting(setting))


func _load_file() -> void:
	if not FileAccess.file_exists(CONFIG_PATH):
		return
	var file := ConfigFile.new()
	var error := file.load(CONFIG_PATH)
	if error != OK:
		push_warning("WASD Multiplayer: %s could not be read (error %d), so its settings are ignored." % [
				CONFIG_PATH, error])
		return
	if not file.has_section("wasd"):
		return
	for key in file.get_section_keys("wasd"):
		_set_value(key, file.get_value("wasd", key))


func _load_environment() -> void:
	var api := OS.get_environment("WASD_API_ORIGIN").strip_edges()
	if api != "":
		api_origin = api
		if OS.get_environment("WASD_APP_ORIGIN").strip_edges() == "":
			app_origin = api
	var app := OS.get_environment("WASD_APP_ORIGIN").strip_edges()
	if app != "":
		app_origin = app
	var game := OS.get_environment("WASD_GAME_ID").strip_edges().to_lower()
	if game != "":
		game_id = game
	var build := OS.get_environment("WASD_GAME_VERSION").strip_edges()
	if build.is_valid_int():
		version = build.to_int()


func _set_value(key: String, value: Variant) -> void:
	match key:
		"mode":
			mode = str(value)
		"max_players":
			max_players = int(value)
		"api_origin":
			api_origin = str(value)
		"app_origin":
			app_origin = str(value)
		"game_id":
			game_id = str(value).strip_edges().to_lower()
		"version":
			version = int(value)
		"count_traffic":
			count_traffic = bool(value)
		"server_fps":
			server_fps = int(value)
		"server_idle_fps":
			server_idle_fps = int(value)


func _normalize() -> void:
	if mode != "player_hosted" and mode != "dedicated":
		push_warning("WASD Multiplayer: mode \"%s\" is not player_hosted or dedicated; using player_hosted." % mode)
		mode = "player_hosted"
	# A player's browser hosts at most 16; a dedicated server takes as many as WASD Engine's setup offers.
	max_players = clampi(max_players, 2, 16 if mode == "player_hosted" else 500)
	api_origin = api_origin.strip_edges().trim_suffix("/")
	app_origin = app_origin.strip_edges().trim_suffix("/")
	if api_origin == "":
		api_origin = DEFAULT_ORIGIN
	if app_origin == "":
		app_origin = api_origin
	if game_id != "" and not is_uuid(game_id):
		push_warning("WASD Multiplayer: game_id \"%s\" is not a WASD game id, so it is ignored." % game_id)
		game_id = ""
	version = maxi(version, 0)
	server_fps = maxi(server_fps, 0)
	server_idle_fps = maxi(server_idle_fps, 0)
