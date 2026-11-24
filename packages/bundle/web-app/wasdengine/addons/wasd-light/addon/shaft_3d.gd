# SPDX-License-Identifier: CC0-1.0
# A shaft of light in dusty air, pointing along the node's -Z: the beam of a spotlight or a headlight, sun through
# a window or a gap in the roof, light between trees. It looks like lit air from every side and from within, and
# things that stand in it cut it off. It stands in for volumetric fog, which Web builds do not draw. It casts no
# light: put it with a SpotLight3D, or along the sun's direction. Keep the node's scale at 1.
class_name WasdShaft3D
extends MeshInstance3D

const SHADER := preload("res://addons/wasd_light/shaft.gdshader")

## Round: a cone, for lamps. Square: a slanted box, for windows and doors.
@export_enum("Round", "Square") var shape := 0: set = _set_shape
## Meters from the source to where the shaft ends, the size of its opening at the source (a radius, or a width
## and height), and how many times wider it is at its end.
@export_range(0.1, 400.0, 0.01) var length := 8.0: set = _set_length
@export var opening := Vector2(0.5, 0.5): set = _set_opening
@export_range(0.2, 20.0, 0.01) var spread := 3.0: set = _set_spread
@export var color := Color(1.0, 0.93, 0.78): set = _set_color
## How bright: 0.3 is a lamp's beam in a dark room, 1 a searchlight; by day a third of that. The same light spread
## over a wide shaft is fainter, so a window's shaft of some meters wants 1 to 3.
@export_range(0.0, 8.0, 0.01) var energy := 0.3: set = _set_energy
## How much drifting dust breaks the shaft up.
@export_range(0.0, 1.0, 0.01) var dust := 0.35: set = _set_dust
## Where along its length it starts to fade out, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var fade_from := 0.25: set = _set_fade_from

var _material := ShaderMaterial.new()


func _init() -> void:
	var noise := FastNoiseLite.new()
	noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	noise.frequency = 0.02
	var dust_noise := NoiseTexture2D.new()
	dust_noise.noise = noise
	dust_noise.seamless = true
	dust_noise.width = 128
	dust_noise.height = 128
	dust_noise.generate_mipmaps = true
	_material.shader = SHADER
	_material.set_shader_parameter(&"dust_noise", dust_noise)
	material_override = _material
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	for key: StringName in [&"color", &"energy", &"dust", &"fade_from"]:
		_material.set_shader_parameter(key, get(key))
	_build()


## Points the shaft the way a light points and gives it the light's color: for a SpotLight3D also its length and
## the cone's width, for a DirectionalLight3D only the direction.
func match_light(light: Light3D) -> void:
	global_basis = light.global_basis.orthonormalized()
	color = light.light_color
	if light is SpotLight3D:
		var spot := light as SpotLight3D
		global_position = spot.global_position
		length = spot.spot_range
		shape = 0
		opening = Vector2(0.08, 0.08)
		spread = maxf(tan(deg_to_rad(spot.spot_angle)) * spot.spot_range / 0.08, 1.0)


## The shaft's mesh only bounds what the shader draws: a closed box that widens from the source to the end.
func _build() -> void:
	var vertices := PackedVector3Array()
	for ring: int in 2:
		var wide := 1.0 if ring == 0 else spread
		for corner: Vector2 in [Vector2(1, 1), Vector2(-1, 1), Vector2(-1, -1), Vector2(1, -1)]:
			vertices.append(Vector3(corner.x * opening.x * wide, corner.y * opening.y * wide, -length * ring))
	# Twelve triangles, wound so that the faces look outward.
	var indices := PackedInt32Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6])
	for side: int in 4:
		var next := (side + 1) % 4
		indices.append_array([side, side + 4, next, next, side + 4, next + 4])
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_INDEX] = indices
	var built := ArrayMesh.new()
	built.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	mesh = built
	_material.set_shader_parameter(&"shaft_length", length)
	_material.set_shader_parameter(&"opening", opening)
	_material.set_shader_parameter(&"spread", spread)
	_material.set_shader_parameter(&"is_round", shape == 0)


func _set_shape(value: int) -> void:
	shape = clampi(value, 0, 1)
	_build()


func _set_length(value: float) -> void:
	length = value
	_build()


func _set_opening(value: Vector2) -> void:
	opening = value
	_build()


func _set_spread(value: float) -> void:
	spread = value
	_build()


func _set_color(value: Color) -> void:
	color = value
	_material.set_shader_parameter(&"color", value)


func _set_energy(value: float) -> void:
	energy = value
	_material.set_shader_parameter(&"energy", value)


func _set_dust(value: float) -> void:
	dust = value
	_material.set_shader_parameter(&"dust", value)


func _set_fade_from(value: float) -> void:
	fade_from = value
	_material.set_shader_parameter(&"fade_from", value)
