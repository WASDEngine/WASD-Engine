# SPDX-License-Identifier: CC0-1.0
# Fog that fills a box, thicker at its floor and soft at its sides: mist in a valley, haze in a hall, smoke in a
# room, steam over a swamp or a lake. The box is `size` meters with the node at its middle; things inside it show
# through by how much fog lies before them, and the camera may walk through it. It stands in for volumetric fog and
# FogVolume, which Web builds do not draw. It takes no light: give it the color the scene's air has, by day the
# sky's at the horizon, by night a dark blue-gray.
class_name WasdFogBank3D
extends MeshInstance3D

const SHADER := preload("res://addons/wasd_light/fog_bank.gdshader")

## Meters along X, Y, and Z.
@export var size := Vector3(30, 6, 30): set = _set_size
@export var color := Color(0.78, 0.83, 0.88): set = _set_color
## How much a meter of fog at the box's floor hides: 0.02 is haze, 0.1 mist, 0.4 thick smoke.
@export_range(0.0, 2.0, 0.001) var density := 0.08: set = _set_density
## How fast it thins toward the top: 0 fills the box evenly, 4 leaves fog only near the floor.
@export_range(0.0, 8.0, 0.01) var thinning := 3.0: set = _set_thinning
## How far in from the sides it thins out, as a part of the box: 0 gives it hard walls.
@export_range(0.0, 0.5, 0.01) var soft_edges := 0.25: set = _set_soft_edges
## Drifting clouds in it: how strong, how large in meters, and their speed in meters a second along X and Z.
@export_range(0.0, 1.0, 0.01) var clouds := 0.6: set = _set_clouds
@export_range(0.5, 200.0, 0.1) var cloud_size := 14.0: set = _set_cloud_size
@export var cloud_drift := Vector2(0.25, 0.1): set = _set_cloud_drift

var _material := ShaderMaterial.new()


func _init() -> void:
	var noise := FastNoiseLite.new()
	noise.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	noise.frequency = 0.016
	var cloud_noise := NoiseTexture2D.new()
	cloud_noise.noise = noise
	cloud_noise.seamless = true
	cloud_noise.width = 128
	cloud_noise.height = 128
	cloud_noise.generate_mipmaps = true
	var box := BoxMesh.new()
	box.size = Vector3.ONE
	mesh = box
	_material.shader = SHADER
	_material.set_shader_parameter(&"cloud_noise", cloud_noise)
	# After other see-through things nearer the ground's level, such as water, and before what stands inside it.
	_material.render_priority = 1
	material_override = _material
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	scale = size
	for key: StringName in [&"color", &"density", &"thinning", &"soft_edges", &"clouds", &"cloud_size", &"cloud_drift"]:
		_material.set_shader_parameter(key, get(key))


func _set_size(value: Vector3) -> void:
	size = value
	scale = value


func _set_color(value: Color) -> void:
	color = value
	_material.set_shader_parameter(&"color", value)


func _set_density(value: float) -> void:
	density = value
	_material.set_shader_parameter(&"density", value)


func _set_thinning(value: float) -> void:
	thinning = value
	_material.set_shader_parameter(&"thinning", value)


func _set_soft_edges(value: float) -> void:
	soft_edges = value
	_material.set_shader_parameter(&"soft_edges", value)


func _set_clouds(value: float) -> void:
	clouds = value
	_material.set_shader_parameter(&"clouds", value)


func _set_cloud_size(value: float) -> void:
	cloud_size = value
	_material.set_shader_parameter(&"cloud_size", value)


## Takes a wind from WASD Weather, for a node the game has put in the group "wasd_wind": the banks drift along
## it, slower than the wind itself.
func set_wind(value: Vector3) -> void:
	cloud_drift = Vector2(value.x, value.z) * 0.3


func _set_cloud_drift(value: Vector2) -> void:
	cloud_drift = value
	_material.set_shader_parameter(&"cloud_drift", value)
