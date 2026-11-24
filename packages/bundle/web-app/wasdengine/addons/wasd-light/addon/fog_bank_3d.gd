# SPDX-License-Identifier: CC0-1.0
# Fog that fills a box, thicker at its floor and soft at its sides: mist in a valley, haze in a hall, smoke in a
# room, steam over a swamp or a lake. The box is `size` meters with the node at its middle; things inside it show
# through by how much fog lies before them, and the camera may walk through it. It stands in for volumetric fog and
# FogVolume, which Web builds do not draw. It takes no light: give it the color the scene's air has, by day the
# sky's at the horizon, by night a dark blue-gray.
class_name WasdFogBank3D
extends MeshInstance3D

const SHADER := preload("res://addons/wasd_light/fog_bank.gdshader")
## Meters of fog, times its density, that hide half of what lies behind them (the natural logarithm of 2).
const HALF_HIDDEN := 0.69

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
@export var cloud_drift := Vector2(0.25, 0.1)

var _material := ShaderMaterial.new()
## How far the clouds have drifted, in meters along X and Z: added up from `cloud_drift` each frame, so that a new
## drift carries them on from where they are.
var _drifted := Vector2.ZERO
## The `cloud_drift` the bank had before a wind from WASD Weather took it over, and whether one drives it now.
var _own_drift := Vector2.ZERO
var _wind_drives := false


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
	material_override = _material
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	scale = size
	for key: StringName in [&"color", &"density", &"thinning", &"soft_edges", &"clouds", &"cloud_size"]:
		_material.set_shader_parameter(key, get(key))


func _process(delta: float) -> void:
	# Ten cloud sizes on, the clouds look as they did, so the way starts over there.
	_drifted = (_drifted + cloud_drift * delta).posmod(maxf(cloud_size, 0.01) * 10.0)
	_material.set_shader_parameter(&"cloud_offset", _drifted)
	# See-through things are drawn from the farthest to the nearest. The bank counts as far away as its nearest point,
	# and never nearer than where its fog hides half of what lies behind: what stands before it, or in it nearer than
	# that, as a torch beside a camera inside it, is drawn over it; what stands further in or behind it is veiled. A
	# bank flattened to nothing, by its size or a parent's scale, keeps its last place.
	var camera := get_viewport().get_camera_3d()
	if camera != null and absf(global_basis.determinant()) > 0.000001:
		var eye := camera.global_position
		var nearest := global_transform * (global_transform.affine_inverse() * eye).clamp(Vector3.ONE * -0.5, Vector3.ONE * 0.5)
		sorting_offset = eye.distance_to(global_position) - maxf(eye.distance_to(nearest), HALF_HIDDEN / maxf(density, 0.0001))


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
## it, slower than the wind itself. No wind, as WASD Weather tells when it leaves, gives the bank back the
## `cloud_drift` it had before a wind took it over.
func set_wind(value: Vector3) -> void:
	var flat := Vector2(value.x, value.z)
	if flat.length() <= 0.01:
		if _wind_drives:
			_wind_drives = false
			cloud_drift = _own_drift
		return
	if not _wind_drives:
		_wind_drives = true
		_own_drift = cloud_drift
	cloud_drift = flat * 0.3
