# SPDX-License-Identifier: CC0-1.0
# Wind for cloth inside a box. It blows on every SoftBody3D in the box through Area3D wind, which pushes each triangle
# along its normal, and WasdClothChains3D and the flag_wind shader read the same wind through velocity_at(). Gusts
# change its speed and turn its direction a little over time, so cloth keeps moving instead of settling.
@tool
class_name WasdClothWind3D
extends Area3D

## Group of the wind zones in the scene tree.
const GROUP := &"wasd_cloth_wind"

## World direction the wind blows toward, whatever the rotation of this zone or its parents; it is normalized.
@export var direction := Vector3(1.0, 0.0, 0.0)

## Mean wind speed in m/s: 2 is a breeze, 6 is a stiff wind, 12 is a gale.
@export_range(0.0, 30.0, 0.1, "suffix:m/s") var speed := 4.0

## How much gusts change the speed, from 0 (steady) to 1 (from calm to twice the mean).
@export_range(0.0, 1.0, 0.01) var gustiness := 0.4

## How far gusts turn the direction to each side.
@export_range(0.0, 45.0, 0.5, "suffix:°") var turbulence := 15.0

## Size of the box the wind blows in, centered on this node.
@export var box_size := Vector3(100.0, 40.0, 100.0):
	set(value):
		box_size = value.abs()
		if _shape != null:
			(_shape.shape as BoxShape3D).size = box_size

## Scales the push on soft bodies. Air pushes 0.6 N/m² times the speed squared; lower this when sheets fly too wildly.
@export_range(0.0, 4.0, 0.01) var cloth_pressure := 1.0

var _shape: CollisionShape3D
var _source: Node3D
var _time := 0.0
var _gust := 1.0
var _current := Vector3.ZERO
## The zone's own `direction` and `speed` from before a wind from WASD Weather took it over, and whether one drives it
## now.
var _own_direction := Vector3.RIGHT
var _own_speed := 0.0
var _wind_drives := false


func _ready() -> void:
	add_to_group(GROUP)
	_shape = CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = box_size
	_shape.shape = box
	add_child(_shape, false, Node.INTERNAL_MODE_BACK)
	_source = Node3D.new()
	_source.name = "WindSource"
	# Area3D takes the wind's direction from its source's local transform and the physics engine uses it as a world
	# direction, so the source ignores this zone's own rotation: direction stays a world direction when the zone or a
	# parent turns.
	_source.top_level = true
	add_child(_source, false, Node.INTERNAL_MODE_BACK)
	wind_source_path = get_path_to(_source)
	wind_attenuation_factor = 0.0
	_step(0.0)


func _physics_process(delta: float) -> void:
	if Engine.is_editor_hint():
		return
	_step(delta)


## Takes a wind in m/s along the world's axes as this zone's direction and speed. WASD Weather calls it on every
## zone the game has put in the group "wasd_wind", so that flags and capes fly harder in a storm. No wind, as WASD
## Weather tells when it leaves, gives the zone back the direction and speed it had before a wind took it over.
func set_wind(wind: Vector3) -> void:
	if wind.length() <= 0.01:
		if _wind_drives:
			_wind_drives = false
			direction = _own_direction
			speed = _own_speed
		return
	if not _wind_drives:
		_wind_drives = true
		_own_direction = direction
		_own_speed = speed
	direction = wind.normalized()
	speed = wind.length()


## Wind velocity of this zone now, in m/s.
func velocity() -> Vector3:
	return _current


## Whether a world position lies inside this zone's box.
func covers(world_position: Vector3) -> bool:
	var local := global_transform.affine_inverse() * world_position
	return absf(local.x) <= box_size.x * 0.5 and absf(local.y) <= box_size.y * 0.5 and absf(local.z) <= box_size.z * 0.5


## Wind velocity at a world position: the sum of the zones of the tree that cover it.
static func velocity_at(tree: SceneTree, world_position: Vector3) -> Vector3:
	var total := Vector3.ZERO
	for zone in tree.get_nodes_in_group(GROUP):
		if zone is WasdClothWind3D and zone.is_inside_tree() and zone.covers(world_position):
			total += zone.velocity()
	return total


func _step(delta: float) -> void:
	_time += delta
	var t := _time
	var wave := 0.55 * sin(0.9 * t) + 0.3 * sin(2.3 * t + 1.7) + 0.15 * sin(5.9 * t + 0.4)
	_gust = maxf(0.0, 1.0 + gustiness * wave)
	var base := direction.normalized() if direction.length() > 0.001 else Vector3.RIGHT
	var yaw := deg_to_rad(turbulence) * (0.7 * sin(0.53 * t + 0.3) + 0.3 * sin(1.7 * t + 2.1))
	var pitch := deg_to_rad(turbulence) * 0.35 * sin(1.1 * t + 0.9)
	var side := base.cross(Vector3.UP)
	if side.length() < 0.001:
		side = Vector3.RIGHT
	var turned := base.rotated(Vector3.UP, yaw).rotated(side.normalized(), pitch).normalized()
	_current = turned * speed * _gust
	if _source != null:
		var up := Vector3.UP if absf(turned.dot(Vector3.UP)) < 0.99 else Vector3.BACK
		_source.global_transform = Transform3D(Basis.looking_at(turned, up), global_position - turned * box_size.length())
	wind_force_magnitude = 0.6 * _current.length_squared() * cloth_pressure
