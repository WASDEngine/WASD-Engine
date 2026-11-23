# SPDX-License-Identifier: CC0-1.0
# A card with holes that is never seen and only throws a shadow: put it between a light and the scene and the light
# falls through leaves, bars, or a grid. Level above the ground for tree shade under the sun; upright before a lamp
# or in a window for bars and blinds. It stands in for light projectors, which Web builds do not draw. The light
# must cast shadows.
class_name WasdGobo3D
extends MeshInstance3D

const SHADER := preload("res://addons/wasd_light/gobo.gdshader")

enum Kind { LEAVES, BARS, GRID }

@export var kind := Kind.LEAVES: set = _set_kind
## Meters along the card's two sides. The card lies level; turn the node to stand it up.
@export var size := Vector2(30, 30): set = _set_size
## How much of the light the card stops, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var cover := 0.55: set = _set_cover
## Meters across one repeat of the pattern: 3 for a tree's leaves, 0.3 for bars.
@export_range(0.05, 100.0, 0.01) var pattern_size := 3.0: set = _set_pattern_size
## Meters and turns a second the pattern sways, as leaves do in wind; 0 keeps bars still.
@export_range(0.0, 2.0, 0.01) var sway := 0.15: set = _set_sway
@export_range(0.0, 4.0, 0.01) var sway_speed := 0.12: set = _set_sway_speed

var _material := ShaderMaterial.new()


func _init() -> void:
	var noise := FastNoiseLite.new()
	noise.noise_type = FastNoiseLite.TYPE_CELLULAR
	noise.frequency = 0.05
	noise.cellular_return_type = FastNoiseLite.RETURN_DISTANCE
	var pattern := NoiseTexture2D.new()
	pattern.noise = noise
	pattern.seamless = true
	pattern.width = 256
	pattern.height = 256
	pattern.generate_mipmaps = true
	var card := PlaneMesh.new()
	card.size = Vector2.ONE
	mesh = card
	_material.shader = SHADER
	_material.set_shader_parameter(&"pattern", pattern)
	material_override = _material
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_SHADOWS_ONLY
	for key: StringName in [&"cover", &"pattern_size", &"sway", &"sway_speed"]:
		_material.set_shader_parameter(key, get(key))
	_material.set_shader_parameter(&"kind", int(kind))
	_set_size(size)


func _set_kind(value: Kind) -> void:
	kind = value
	_material.set_shader_parameter(&"kind", int(value))


func _set_size(value: Vector2) -> void:
	size = value
	scale = Vector3(value.x, 1.0, value.y)


func _set_cover(value: float) -> void:
	cover = value
	_material.set_shader_parameter(&"cover", value)


func _set_pattern_size(value: float) -> void:
	pattern_size = value
	_material.set_shader_parameter(&"pattern_size", value)


func _set_sway(value: float) -> void:
	sway = value
	_material.set_shader_parameter(&"sway", value)


func _set_sway_speed(value: float) -> void:
	sway_speed = value
	_material.set_shader_parameter(&"sway_speed", value)
