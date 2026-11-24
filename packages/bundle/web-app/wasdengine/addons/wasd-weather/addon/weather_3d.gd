# SPDX-License-Identifier: CC0-1.0
# Weather in one node: rain, drizzle, storms with lightning, snow, blizzards, and fog by name, with a wind that
# everything shares and what the weather leaves behind, snow that settles and wet ground with puddles. The rain and
# snow fill a box of air round the camera, moved by a shader with no particle system. With a WASD Look node in the
# scene the sky goes gray and the fog thickens with the weather; without one, only what falls and blows changes.
class_name WasdWeather3D
extends Node3D

## The weather began to change to another.
signal weather_changed(weather: String)
## Lightning struck: the flash shows now, and the thunder is due after `seconds_to_thunder`.
signal lightning(seconds_to_thunder: float)

const FALL_SHADER := preload("res://addons/wasd_weather/fall.gdshader")
const SPLASH_SHADER := preload("res://addons/wasd_weather/splash.gdshader")
const COVER_SHADER := preload("res://addons/wasd_weather/cover.gdshader")

## What each weather is made of: how much rain and snow falls (0 to 1), how far the sky clouds over (0 to 1), the
## fog it adds as a density per meter, the wind in meters a second, and lightning strikes a minute.
const WEATHERS := {
	"clear": {"rain": 0.0, "snow": 0.0, "overcast": 0.0, "fog": 0.0, "wind": 1.0, "lightning": 0.0},
	"cloudy": {"rain": 0.0, "snow": 0.0, "overcast": 0.6, "fog": 0.0005, "wind": 2.0, "lightning": 0.0},
	"drizzle": {"rain": 0.3, "snow": 0.0, "overcast": 0.8, "fog": 0.0015, "wind": 2.0, "lightning": 0.0},
	"rain": {"rain": 0.7, "snow": 0.0, "overcast": 0.9, "fog": 0.003, "wind": 4.0, "lightning": 0.0},
	"storm": {"rain": 1.0, "snow": 0.0, "overcast": 1.0, "fog": 0.006, "wind": 10.0, "lightning": 6.0},
	"snow": {"rain": 0.0, "snow": 0.6, "overcast": 0.8, "fog": 0.003, "wind": 1.5, "lightning": 0.0},
	"blizzard": {"rain": 0.0, "snow": 1.0, "overcast": 1.0, "fog": 0.02, "wind": 12.0, "lightning": 0.0},
	"fog": {"rain": 0.0, "snow": 0.0, "overcast": 0.7, "fog": 0.03, "wind": 0.5, "lightning": 0.0},
}
## Nodes in this group with a method `set_wind(wind: Vector3)` are told the wind whenever it changes.
const WIND_GROUP := &"wasd_wind"
## Nodes in this group, and everything under them, never take snow or wetness.
const BARE_GROUP := &"wasd_weather_bare"
const RAIN_CARDS := 2400
const SNOW_CARDS := 2000
## The boxes of air round the camera that the rain and the snow fill, in meters.
const RAIN_BOX := Vector3(20, 14, 20)
const SNOW_BOX := Vector3(18, 10, 18)
const SPLASH_CARDS := 600

## The weather by name: one of WEATHERS. Setting it changes the weather over `change_seconds`.
@export var weather := "clear": set = set_weather
## Seconds a change of weather takes.
@export_range(0.0, 600.0, 0.1) var change_seconds := 8.0
## The compass direction the wind blows toward, in degrees (0 toward -Z, 90 toward +X), and what multiplies each
## weather's wind.
@export_range(-180.0, 360.0, 0.1) var wind_heading := 70.0
@export_range(0.0, 4.0, 0.01) var wind_strength := 1.0
## Rings where rain meets level ground, at the height `ground`. Leave them off over hills.
@export var splashes := false
@export var ground := 0.0
## True while the camera is indoors or under a roof: nothing falls before it, and the rest of the weather goes on.
@export var sheltered := false
## Seconds of steady rain or snow until the ground is soaked or covered, and how many times longer drying and
## melting take.
@export_range(1.0, 3600.0, 0.1) var settle_seconds := 40.0
@export_range(0.1, 20.0, 0.1) var clear_slowness := 3.0

## How wet things are and how much snow lies, from 0 to 1. The weather moves both; set them to begin a scene soaked
## or snowed in.
var wetness := 0.0
var snow_cover := 0.0

var _from: Dictionary = WEATHERS["clear"]
var _to: Dictionary = WEATHERS["clear"]
var _mixed := 1.0
var _mix_seconds := 0.0
var _now: Dictionary = WEATHERS["clear"].duplicate()
var _clock := 0.0
var _rain := MultiMeshInstance3D.new()
var _snow := MultiMeshInstance3D.new()
var _rings := MultiMeshInstance3D.new()
var _rain_material := ShaderMaterial.new()
var _snow_material := ShaderMaterial.new()
var _ring_material := ShaderMaterial.new()
var _cover_material := ShaderMaterial.new()
## How far the rain and the snow have come since the start: the wind changes, and what is in the air keeps its place.
var _rain_way := Vector3.ZERO
var _snow_way := Vector3.ZERO
var _cover_roots: Array[WeakRef] = []
var _covered: Array[WeakRef] = []
var _covering := false
## Plants that snow buries, each as [the node, its height without snow]: LiteTerrain's lifted grass, which an
## overlay cannot follow, and SimpleGrassTextured's tufts.
var _buried: Array[Array] = []
var _buried_at := -1.0
var _flash := DirectionalLight3D.new()
var _flash_left := 0.0
var _flash_energy := 0.0
var _flash_sky := 1.0
var _told_look := false
var _told_overcast := -1.0
var _told_fog := -1.0
var _told_wind := Vector3(INF, 0, 0)


func _init() -> void:
	_rain_material.shader = FALL_SHADER
	_rain_material.set_shader_parameter(&"box", RAIN_BOX)
	_snow_material.shader = FALL_SHADER
	_snow_material.set_shader_parameter(&"box", SNOW_BOX)
	_snow_material.set_shader_parameter(&"color", Color(0.95, 0.96, 0.98))
	_snow_material.set_shader_parameter(&"opacity", 0.95)
	_snow_material.set_shader_parameter(&"solidity", 0.9)
	_snow_material.set_shader_parameter(&"width", 0.06)
	_snow_material.set_shader_parameter(&"streak", 0.0)
	_snow_material.set_shader_parameter(&"wander", 0.35)
	_ring_material.shader = SPLASH_SHADER
	_rain.multimesh = _cards(RAIN_CARDS)
	_rain.material_override = _rain_material
	_snow.multimesh = _cards(SNOW_CARDS)
	_snow.material_override = _snow_material
	_rings.multimesh = _cards(SPLASH_CARDS)
	_rings.material_override = _ring_material
	for cards: MultiMeshInstance3D in [_rain, _snow, _rings]:
		cards.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		# The shader places the cards round the camera, wherever this node is.
		cards.custom_aabb = AABB(Vector3.ONE * -100000.0, Vector3.ONE * 200000.0)
		cards.visible = false
		cards.top_level = true
		add_child(cards)
	var noise := FastNoiseLite.new()
	noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	noise.frequency = 0.02
	noise.fractal_octaves = 3
	var uneven := NoiseTexture2D.new()
	uneven.noise = noise
	uneven.seamless = true
	uneven.width = 128
	uneven.height = 128
	uneven.generate_mipmaps = true
	_cover_material.shader = COVER_SHADER
	_cover_material.set_shader_parameter(&"noise", uneven)
	# The flash of lightning: a light that is always there at no energy, so that a strike changes nothing but its
	# brightness.
	_flash.shadow_enabled = false
	_flash.light_energy = 0.0
	_flash.light_color = Color(0.85, 0.9, 1.0)
	_flash.sky_mode = DirectionalLight3D.SKY_MODE_LIGHT_ONLY
	add_child(_flash)


func _enter_tree() -> void:
	get_tree().node_added.connect(_on_node_added)


func _exit_tree() -> void:
	get_tree().node_added.disconnect(_on_node_added)
	var look := _look()
	if _told_look and look != null:
		look.set(&"overcast", 0.0)
		look.set(&"added_fog", 0.0)
	_told_look = false
	_told_overcast = -1.0
	_told_fog = -1.0


## The names of the weathers.
static func names() -> PackedStringArray:
	return PackedStringArray(WEATHERS.keys())


## Changes the weather over `change_seconds`. An unknown name gives "clear" and a warning.
func set_weather(value: String) -> void:
	if not WEATHERS.has(value):
		push_warning("WasdWeather3D: no weather named %s; the weathers are %s." % [value, ", ".join(names())])
		value = "clear"
	weather = value
	_from = _now.duplicate()
	_to = WEATHERS[value]
	if change_seconds > 0.0 and is_inside_tree():
		_mixed = 0.0
		_mix_seconds = change_seconds
	else:
		_mixed = 1.0
		_now = _to.duplicate()
	weather_changed.emit(value)


## Changes the weather over `seconds` of its own.
func fade_to(next: String, seconds: float) -> void:
	var usual := change_seconds
	change_seconds = seconds
	weather = next
	change_seconds = usual


## The wind now with its gusts, in meters a second along the world's axes: for sails, flags, and anything else the
## game pushes itself.
func get_wind() -> Vector3:
	var gust := 1.0 + 0.25 * sin(_clock * 0.7) + 0.15 * sin(_clock * 1.9 + 1.3)
	return _steady_wind() * gust


## How much rain and snow fall now, from 0 to 1: for the loudness of a rain loop, or to send people indoors.
func get_rain() -> float:
	return _now["rain"]


func get_snow() -> float:
	return _now["snow"]


## Lets the weather leave snow and wetness on every mesh under `root`, `root` included, and on those that come
## under it later: ground, walls, roofs, props, characters. Each such mesh is drawn once more while snow lies or
## things are wet. Left bare: see-through materials, nodes of the WASD packs that draw their own surfaces or light
## (water, effects, marks), and everything in the group "wasd_weather_bare" or under such a node. Snow buries the
## grass of LiteTerrain and SimpleGrassTextured under `root`.
func cover(root: Node) -> void:
	_cover_roots.append(weakref(root))
	_cover_under(root)


## Takes the cover off every mesh under `root` again.
func uncover(root: Node) -> void:
	for index: int in range(_cover_roots.size() - 1, -1, -1):
		var kept: Object = _cover_roots[index].get_ref()
		if kept == null or kept == root:
			_cover_roots.remove_at(index)
	for index: int in range(_covered.size() - 1, -1, -1):
		var node: Node = _covered[index].get_ref()
		if node == null or node == root or root.is_ancestor_of(node):
			if node != null and (node as GeometryInstance3D).material_overlay == _cover_material:
				(node as GeometryInstance3D).material_overlay = null
			_covered.remove_at(index)
	for index: int in range(_buried.size() - 1, -1, -1):
		var plant: Node = (_buried[index][0] as WeakRef).get_ref()
		if plant == null or plant == root or root.is_ancestor_of(plant):
			if plant != null:
				_bury(_buried[index], 0.0)
			_buried.remove_at(index)


## Strikes lightning now: a flash of light over the scene and the sky, and the `lightning` signal with the seconds
## until its thunder. Storms strike by themselves.
func strike() -> void:
	if _flash_left <= 0.0:
		var shown := _environment()
		_flash_sky = shown.background_energy_multiplier if shown != null else 1.0
	_flash.rotation = Vector3(deg_to_rad(randf_range(-70.0, -35.0)), randf() * TAU, 0.0)
	_flash_energy = randf_range(1.2, 2.2)
	_flash_left = 0.35
	lightning.emit(randf_range(0.3, 4.0))


func _process(delta: float) -> void:
	_clock += delta
	if _mixed < 1.0:
		_mixed = minf(_mixed + delta / maxf(_mix_seconds, 0.001), 1.0)
		for key: String in _to:
			_now[key] = lerpf(_from[key], _to[key], smoothstep(0.0, 1.0, _mixed))
	var camera := get_viewport().get_camera_3d()
	var middle := camera.global_position if camera != null else global_position
	var wind := get_wind()
	var look := _look()
	var lit: float = look.call(&"get_light_level") if look != null and look.has_method(&"get_light_level") else 1.0
	var rain: float = _now["rain"]
	var snow: float = _now["snow"]
	_rain.visible = rain > 0.01 and not sheltered
	_snow.visible = snow > 0.01 and not sheltered
	_rings.visible = rain > 0.01 and splashes and not sheltered
	var rain_flight := wind * 0.8 + Vector3(0.0, -9.5, 0.0)
	var snow_flight := wind * 0.7 + Vector3(0.0, -1.3, 0.0)
	# The ways start over after a hundred boxes, where every card is back at its place: numbers stay small however
	# long the game runs.
	_rain_way = (_rain_way + rain_flight * delta).posmodv(RAIN_BOX * 100.0)
	_snow_way = (_snow_way + snow_flight * delta).posmodv(SNOW_BOX * 100.0)
	if _rain.visible:
		_rain.multimesh.visible_instance_count = int(RAIN_CARDS * rain)
		_rain_material.set_shader_parameter(&"box_middle", middle)
		_rain_material.set_shader_parameter(&"way", _rain_way)
		_rain_material.set_shader_parameter(&"flight", rain_flight)
		_rain_material.set_shader_parameter(&"light_level", lit)
	if _snow.visible:
		_snow.multimesh.visible_instance_count = int(SNOW_CARDS * snow)
		_snow_material.set_shader_parameter(&"box_middle", middle)
		_snow_material.set_shader_parameter(&"way", _snow_way)
		_snow_material.set_shader_parameter(&"clock", _clock)
		_snow_material.set_shader_parameter(&"flight", snow_flight)
		_snow_material.set_shader_parameter(&"light_level", lit)
	if _rings.visible:
		_rings.multimesh.visible_instance_count = int(SPLASH_CARDS * rain)
		_ring_material.set_shader_parameter(&"field_middle", middle)
		_ring_material.set_shader_parameter(&"ground", ground)
		_ring_material.set_shader_parameter(&"clock", _clock)
		_ring_material.set_shader_parameter(&"light_level", lit)

	# What the weather leaves behind.
	wetness = clampf(wetness + (delta / settle_seconds * rain if rain > 0.05 else -delta / (settle_seconds * clear_slowness)), 0.0, 1.0)
	snow_cover = clampf(snow_cover + (delta / settle_seconds * snow if snow > 0.05 else -delta / (settle_seconds * clear_slowness)), 0.0, 1.0)
	_cover_material.set_shader_parameter(&"wet", wetness)
	_cover_material.set_shader_parameter(&"snow", snow_cover)
	_cover_material.set_shader_parameter(&"rain", 0.0 if sheltered else rain)
	var covering := wetness > 0.001 or snow_cover > 0.001
	if covering != _covering:
		_covering = covering
		for index: int in range(_covered.size() - 1, -1, -1):
			var node: Object = _covered[index].get_ref()
			if node == null:
				_covered.remove_at(index)
			else:
				(node as GeometryInstance3D).material_overlay = _cover_material if covering else null
	if absf(snow_cover - _buried_at) > 0.004 or (snow_cover == 0.0 and _buried_at != 0.0):
		_buried_at = snow_cover
		for index: int in range(_buried.size() - 1, -1, -1):
			if (_buried[index][0] as WeakRef).get_ref() == null:
				_buried.remove_at(index)
			else:
				_bury(_buried[index], snow_cover)

	# Lightning: storms strike by chance, and a flash dies away in two beats, on the ground and in the sky.
	var strikes: float = _now["lightning"]
	if strikes > 0.0 and _flash_left <= 0.0 and randf() < strikes / 60.0 * delta:
		strike()
	if _flash_left > 0.0:
		_flash_left -= delta
		var beat := maxf(_flash_left, 0.0) / 0.35
		var flash := beat * beat * (1.0 if fmod(beat * 3.0, 1.0) > 0.3 else 0.35)
		_flash.light_energy = _flash_energy * flash
		var shown := _environment()
		if shown != null:
			shown.background_energy_multiplier = _flash_sky * (1.0 + 0.5 * _flash_energy * flash)

	# The sky and the fog follow, where a WASD Look node is the scene's lighting; the wind goes to whatever asks.
	if look != null:
		var overcast: float = _now["overcast"]
		var fog: float = _now["fog"]
		if absf(overcast - _told_overcast) > 0.004 or absf(fog - _told_fog) > 0.0001 or (_mixed >= 1.0 and (overcast != _told_overcast or fog != _told_fog)):
			_told_look = true
			_told_overcast = overcast
			_told_fog = fog
			look.set(&"overcast", overcast)
			look.set(&"added_fog", fog)
	var steady := _steady_wind()
	if steady.distance_to(_told_wind) > 0.2:
		_told_wind = steady
		for node: Node in get_tree().get_nodes_in_group(WIND_GROUP):
			if node.has_method(&"set_wind"):
				node.call(&"set_wind", steady)
		# SimpleGrassTextured's grass takes its wind from its autoload.
		var grass := get_node_or_null(^"/root/SimpleGrass")
		if grass != null and grass.has_method(&"set_wind_strength"):
			if steady.length() > 0.01:
				grass.call(&"set_wind_direction", steady.normalized())
			grass.call(&"set_wind_strength", clampf(steady.length() * 0.05, 0.03, 0.6))


## The wind without its gusts.
func _steady_wind() -> Vector3:
	var heading := deg_to_rad(wind_heading)
	return Vector3(sin(heading), 0.0, -cos(heading)) * float(_now["wind"]) * wind_strength


## The scene's WASD Look node, if it has one.
func _look() -> Node:
	return get_tree().get_first_node_in_group(&"wasd_look") if is_inside_tree() else null


## The environment that shows now: a WASD Look node's or the scene's own WorldEnvironment's.
func _environment() -> Environment:
	var world := get_viewport().find_world_3d() if is_inside_tree() else null
	return world.environment if world != null else null


## Whether a node and all under it stay bare: by the group, or because a WASD pack draws it by its own means.
func _is_bare(node: Node) -> bool:
	if node.is_in_group(BARE_GROUP):
		return true
	var script: Script = node.get_script()
	return script != null and script.resource_path.begins_with("res://addons/wasd_")


func _cover_under(node: Node) -> void:
	if _is_bare(node):
		return
	_cover_node(node)
	for child: Node in node.get_children():
		_cover_under(child)


## Shows a plant as deep in snow as `snow` (0 to 1) says. LiteTerrain lifts its grass out of the ground in its
## shader, where the cover would lie hidden beneath it: the lift goes as the first snow settles. SimpleGrassTextured's
## tufts sink until the snow has them.
func _bury(plant: Array, snow: float) -> void:
	var node: Node = (plant[0] as WeakRef).get_ref()
	if node is MultiMeshInstance3D:
		node.set(&"scale_h", float(plant[1]) * (1.0 - 0.75 * smoothstep(0.1, 0.7, snow)))
		(node as MultiMeshInstance3D).visible = snow < 0.75
		return
	var ground := node.get(&"_mat") as ShaderMaterial
	if ground == null:
		return
	if plant[1] == null:
		plant[1] = ground.get_shader_parameter(&"grass_height")
	if plant[1] != null:
		ground.set_shader_parameter(&"grass_height", float(plant[1]) * (1.0 - smoothstep(0.0, 0.2, snow)))


## Whether the scene shows through a surface of a mesh, where the cover would lie over its holes and clear parts: a
## BaseMaterial3D with transparency, or a shader that writes ALPHA, as WASD Materials' cut-out leaves, glass, hair, and
## lashes do.
static func _shows_through(mesh: GeometryInstance3D) -> bool:
	var materials: Array[Material] = [mesh.material_override]
	if mesh.material_override == null and mesh is MeshInstance3D and (mesh as MeshInstance3D).mesh != null:
		for surface: int in (mesh as MeshInstance3D).mesh.get_surface_count():
			materials.append((mesh as MeshInstance3D).get_active_material(surface))
	for material: Material in materials:
		if material is BaseMaterial3D and (material as BaseMaterial3D).transparency != BaseMaterial3D.TRANSPARENCY_DISABLED:
			return true
		if material is ShaderMaterial and (material as ShaderMaterial).shader != null and (material as ShaderMaterial).shader.code.contains("ALPHA"):
			return true
	return false


func _cover_node(node: Node) -> void:
	if not is_instance_valid(node):
		return
	var script: Script = node.get_script()
	var written := script.resource_path if script != null else ""
	if written == "res://addons/lite_terrain/chunk_terrain.gd" or written == "res://addons/simplegrasstextured/grass.gd":
		var plant := [weakref(node), node.get(&"scale_h") if node is MultiMeshInstance3D else null]
		_buried.append(plant)
		if snow_cover > 0.0:
			_bury(plant, snow_cover)
		return
	if not (node is MeshInstance3D or node is CSGShape3D):
		return
	var mesh := node as GeometryInstance3D
	if _shows_through(mesh):
		return
	if mesh.material_overlay != null and mesh.material_overlay != _cover_material:
		return
	if _covered.size() % 256 == 255:
		_covered = _covered.filter(func(kept: WeakRef) -> bool: return kept.get_ref() != null)
	_covered.append(weakref(node))
	if _covering:
		mesh.material_overlay = _cover_material


## A mesh that enters the tree under a covered root is covered too, once it has had its turn to set itself up.
func _on_node_added(node: Node) -> void:
	if _cover_roots.is_empty() or not (node is GeometryInstance3D or node is StaticBody3D):
		return
	var at := node
	while at != null:
		if _is_bare(at):
			return
		for kept: WeakRef in _cover_roots:
			if kept.get_ref() == at:
				_cover_node.call_deferred(node)
				return
		at = at.get_parent()


## Cards for a shader to place: each with four random numbers.
static func _cards(count: int) -> MultiMesh:
	var card := QuadMesh.new()
	card.size = Vector2.ONE
	var cards := MultiMesh.new()
	cards.transform_format = MultiMesh.TRANSFORM_3D
	cards.use_custom_data = true
	cards.mesh = card
	cards.instance_count = count
	var random := RandomNumberGenerator.new()
	random.seed = 4201 + count
	for index: int in count:
		cards.set_instance_transform(index, Transform3D.IDENTITY)
		cards.set_instance_custom_data(index, Color(random.randf(), random.randf(), random.randf(), random.randf()))
	return cards
