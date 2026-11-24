# SPDX-License-Identifier: CC0-1.0
# Motes drifting in a box of air: dust in a sunbeam, pollen over a meadow, embers, fireflies, falling snow. Small
# glowing cards that a shader moves, with no particle system. They glow on their own, whatever light falls on
# them: for dust, put the box where a beam is and keep them faint. With `follow_camera` the box stays round the camera
# and the motes keep their places in the world, so one box fills a whole level.
class_name WasdDust3D
extends MultiMeshInstance3D

const SHADER := preload("res://addons/wasd_light/dust.gdshader")
## Seconds after which the motes' own clock starts over; the shader gives every mote paces that make whole turns in
## that time, so nothing jumps when it does.
const CLOCK_PERIOD := 600.0

## How many motes; a few hundred is plenty.
@export_range(1, 20000) var amount := 300: set = _set_amount
## The box of air in meters.
@export var size := Vector3(12, 6, 12): set = _set_size
@export var color := Color(1.0, 0.95, 0.85): set = _set_color
## How bright one mote is: 0.25 is dust in a beam, 2 embers and fireflies.
@export_range(0.0, 16.0, 0.01) var energy := 0.25: set = _set_energy
## Meters across one mote: 0.015 dust, 0.05 embers and fireflies, 0.08 snowflakes.
@export_range(0.002, 1.0, 0.001) var mote_size := 0.015: set = _set_mote_size
## Meters a second the air carries them: a slow drift for dust, (0, -1.2, 0) for snow, (0, 0.6, 0) for embers.
@export var wind := Vector3(0.05, -0.02, 0.03)
## Meters each mote wanders on its own, and how much its brightness comes and goes (1 for fireflies).
@export_range(0.0, 4.0, 0.01) var wander := 0.25: set = _set_wander
@export_range(0.0, 1.0, 0.01) var twinkle := 0.5: set = _set_twinkle
## How much the motes keep to the box's upright middle line, from 0 (the whole box) to 1: dust in a lamp's beam.
@export_range(0.0, 1.0, 0.01) var gather := 0.0: set = _set_gather
## Keeps the box round the camera that draws the scene, so the motes are wherever the player is.
@export var follow_camera := false

var _material := ShaderMaterial.new()
## How far the air has carried the motes, wrapped into the box, and the motes' own clock: both added up here each
## frame, so that a new wind carries the motes on from where they are.
var _drifted := Vector3.ZERO
var _clock := 0.0
## The `wind` the motes had before a wind from WASD Weather took them over, and whether one drives them now.
var _own_wind := Vector3.ZERO
var _wind_drives := false


func _init() -> void:
	var card := QuadMesh.new()
	card.size = Vector2.ONE
	multimesh = MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.use_custom_data = true
	multimesh.mesh = card
	_material.shader = SHADER
	material_override = _material
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	for key: StringName in [&"color", &"energy", &"mote_size", &"wander", &"twinkle", &"gather"]:
		_material.set_shader_parameter(key, get(key))
	_set_size(size)
	_set_amount(amount)


func _process(delta: float) -> void:
	var camera := get_viewport().get_camera_3d() if follow_camera else null
	if camera != null:
		global_position = camera.global_position
	# A mote a box further on is where it was: the way wraps there.
	_drifted = (_drifted + wind * delta).posmodv(size.max(Vector3.ONE * 0.001))
	_clock = fposmod(_clock + delta, CLOCK_PERIOD)
	_material.set_shader_parameter(&"box_middle", global_position)
	_material.set_shader_parameter(&"drift", _drifted)
	_material.set_shader_parameter(&"clock", _clock)


func _set_amount(value: int) -> void:
	amount = value
	multimesh.instance_count = value
	var random := RandomNumberGenerator.new()
	random.seed = 20261121
	for index: int in value:
		multimesh.set_instance_transform(index, Transform3D.IDENTITY)
		multimesh.set_instance_custom_data(index, Color(random.randf(), random.randf(), random.randf(), random.randf()))


func _set_size(value: Vector3) -> void:
	size = value
	_material.set_shader_parameter(&"box", value)
	# The shader places the motes, so what the engine may cull is the box.
	custom_aabb = AABB(-value * 0.5, value)


func _set_color(value: Color) -> void:
	color = value
	_material.set_shader_parameter(&"color", value)


func _set_energy(value: float) -> void:
	energy = value
	_material.set_shader_parameter(&"energy", value)


func _set_mote_size(value: float) -> void:
	mote_size = value
	_material.set_shader_parameter(&"mote_size", value)


## Takes a wind from WASD Weather, for a node the game has put in the group "wasd_wind": the motes are carried
## along it and keep their own rise or fall. No wind, as WASD Weather tells when it leaves, gives the motes back the
## `wind` they had before a wind took them over.
func set_wind(value: Vector3) -> void:
	if Vector2(value.x, value.z).length() <= 0.01:
		if _wind_drives:
			_wind_drives = false
			wind = _own_wind
		return
	if not _wind_drives:
		_wind_drives = true
		_own_wind = wind
	wind = Vector3(value.x, wind.y, value.z)


func _set_wander(value: float) -> void:
	wander = value
	_material.set_shader_parameter(&"wander", value)


func _set_twinkle(value: float) -> void:
	twinkle = value
	_material.set_shader_parameter(&"twinkle", value)


func _set_gather(value: float) -> void:
	gather = value
	_material.set_shader_parameter(&"gather", value)
