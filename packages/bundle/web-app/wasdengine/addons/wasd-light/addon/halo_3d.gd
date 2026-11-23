# SPDX-License-Identifier: CC0-1.0
# The glow round a small bright thing: a lamp's bulb, a candle flame, a headlight, a sign, a screen. A card that
# faces the camera and is added to the picture; it hides behind walls and fades as the camera comes close. The
# engine's own glow makes only a tight halo in Web builds, and none round a light that has no bright surface: this
# gives the wide soft one. Put it where the light comes from, as a child of the lamp's light or mesh.
class_name WasdHalo3D
extends MeshInstance3D

const SHADER := preload("res://addons/wasd_light/halo.gdshader")

## The glow's color and how bright it is: 1 is a lamp at night, 3 dazzles.
@export var color := Color(1.0, 0.82, 0.6): set = _set_color
@export_range(0.0, 16.0, 0.01) var energy := 1.0: set = _set_energy
## Meters across the whole glow.
@export_range(0.05, 200.0, 0.01) var size := 2.0: set = _set_size
## How much of it the bright core takes, and how long a streak runs sideways through it, as lenses draw (0 for none).
@export_range(0.02, 1.0, 0.01) var core := 0.18: set = _set_core
@export_range(0.0, 1.0, 0.01) var streak := 0.0: set = _set_streak
## How uneven the glow is: faint rays that slowly turn. 0 gives an even disc.
@export_range(0.0, 1.0, 0.01) var rays := 0.25: set = _set_rays
## Meters from the camera inside which it fades out, and at which it has faded away in the distance (0: never).
@export_range(0.0, 20.0, 0.01) var fade_near := 0.6: set = _set_fade_near
@export_range(0.0, 4000.0, 0.1) var fade_far := 0.0: set = _set_fade_far

var _material := ShaderMaterial.new()


func _init() -> void:
	var quad := QuadMesh.new()
	quad.size = Vector2.ONE
	mesh = quad
	_material.shader = SHADER
	material_override = _material
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	# The card turns toward the camera in its shader, so what the engine may cull is a ball round it.
	custom_aabb = AABB(Vector3(-0.5, -0.5, -0.5), Vector3.ONE)
	_set_size(size)
	for key: StringName in [&"color", &"energy", &"core", &"streak", &"rays", &"fade_near", &"fade_far"]:
		_material.set_shader_parameter(key, get(key))


func _set_color(value: Color) -> void:
	color = value
	_material.set_shader_parameter(&"color", value)


func _set_energy(value: float) -> void:
	energy = value
	_material.set_shader_parameter(&"energy", value)


func _set_size(value: float) -> void:
	size = value
	scale = Vector3.ONE * value


func _set_core(value: float) -> void:
	core = value
	_material.set_shader_parameter(&"core", value)


func _set_streak(value: float) -> void:
	streak = value
	_material.set_shader_parameter(&"streak", value)


func _set_rays(value: float) -> void:
	rays = value
	_material.set_shader_parameter(&"rays", value)


func _set_fade_near(value: float) -> void:
	fade_near = value
	_material.set_shader_parameter(&"fade_near", value)


func _set_fade_far(value: float) -> void:
	fade_far = value
	_material.set_shader_parameter(&"fade_far", value)
