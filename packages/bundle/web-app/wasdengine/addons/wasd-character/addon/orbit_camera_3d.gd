# SPDX-License-Identifier: CC0-1.0
# A third-person camera that circles what it follows: the mouse or a gamepad's right stick turns it, a spring arm
# keeps it out of walls, and it eases after its target. It builds its own arm and Camera3D. It works alone with any
# Node3D, and WasdCharacter3D adds one for itself.
class_name WasdOrbitCamera3D
extends Node3D

## What the camera circles; none follows this node's parent.
@export var target: Node3D
## How far behind the target the camera stays, in meters, unless a wall is nearer.
@export_range(0.5, 50.0, 0.1) var distance := 4.5: set = _set_distance
## How far above the target's origin the camera looks, in meters: a character's chest or head.
@export_range(0.0, 10.0, 0.05) var height := 1.5
## Shifts the view sideways, in meters: 0.5 for a look over the right shoulder.
@export_range(-3.0, 3.0, 0.05) var shoulder := 0.0
## Radians the view turns for each pixel the mouse moves.
@export_range(0.0005, 0.02, 0.0001) var mouse_sensitivity := 0.003
## Radians a second the view turns at full tilt of a gamepad's right stick.
@export_range(0.5, 10.0, 0.1) var stick_speed := 3.0
## The lowest and highest the view may look, in degrees: negative looks down on the target from above.
@export var pitch_limits := Vector2(-70.0, 35.0)
## How fast the camera catches up with its target: higher is stiffer, 0 follows at once.
@export_range(0.0, 60.0, 0.5) var follow_speed := 14.0
## true hides and holds the mouse pointer while the game has it: the first click takes it, the cancel key frees it.
@export var capture_mouse := true
## Physics layers the camera stays in front of.
@export_flags_3d_physics var collision_mask := 1: set = _set_collision_mask
## true makes this the current camera when it enters the tree.
@export var current := true

## The Camera3D at the arm's end.
var camera := Camera3D.new()

var _arm := SpringArm3D.new()
var _yaw := 0.0
var _pitch := deg_to_rad(-15.0)


func _init() -> void:
	top_level = true
	var ball := SphereShape3D.new()
	ball.radius = 0.2
	_arm.shape = ball
	_arm.spring_length = distance
	_arm.margin = 0.1
	_arm.collision_mask = collision_mask
	add_child(_arm)
	_arm.add_child(camera)


func _ready() -> void:
	camera.current = current
	var followed := _followed()
	if followed != null:
		global_position = followed.global_position + Vector3.UP * height
		# Start behind the target, looking the way it faces.
		_yaw = followed.global_rotation.y + PI
		if followed is CollisionObject3D:
			_arm.add_excluded_object((followed as CollisionObject3D).get_rid())
	_turn()


## The way the camera looks, flat on the ground: forward for whoever moves relative to the camera.
func get_forward() -> Vector3:
	return Vector3(-sin(_yaw), 0.0, -cos(_yaw))


## Turns the view to look along a direction, as after a cutscene or a respawn.
func look_along(direction: Vector3) -> void:
	if Vector2(direction.x, direction.z).length() > 0.001:
		_yaw = atan2(-direction.x, -direction.z)
		_turn()


func _unhandled_input(event: InputEvent) -> void:
	var held := Input.mouse_mode == Input.MOUSE_MODE_CAPTURED
	if event is InputEventMouseMotion and (held or not capture_mouse):
		if not capture_mouse and not Input.is_mouse_button_pressed(MOUSE_BUTTON_RIGHT):
			return
		var moved := (event as InputEventMouseMotion).relative
		_yaw -= moved.x * mouse_sensitivity
		_pitch = clampf(_pitch - moved.y * mouse_sensitivity, deg_to_rad(pitch_limits.x), deg_to_rad(pitch_limits.y))
	elif capture_mouse and event is InputEventMouseButton and (event as InputEventMouseButton).pressed and not held:
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	elif capture_mouse and held and event.is_action_pressed(&"ui_cancel"):
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE


func _process(delta: float) -> void:
	var stick := Vector2(Input.get_joy_axis(0, JOY_AXIS_RIGHT_X), Input.get_joy_axis(0, JOY_AXIS_RIGHT_Y))
	if stick.length() > 0.2:
		_yaw -= stick.x * stick_speed * delta
		_pitch = clampf(_pitch - stick.y * stick_speed * 0.7 * delta, deg_to_rad(pitch_limits.x), deg_to_rad(pitch_limits.y))
	var followed := _followed()
	if followed != null:
		var to := followed.global_position + Vector3.UP * height
		global_position = to if follow_speed <= 0.0 else global_position.lerp(to, 1.0 - exp(-follow_speed * delta))
	_turn()


func _followed() -> Node3D:
	if target != null and is_instance_valid(target):
		return target
	return get_parent() as Node3D


func _turn() -> void:
	global_basis = Basis.from_euler(Vector3(_pitch, _yaw, 0.0))
	_arm.position = Vector3(shoulder, 0.0, 0.0)


func _set_distance(value: float) -> void:
	distance = value
	_arm.spring_length = value


func _set_collision_mask(value: int) -> void:
	collision_mask = value
	_arm.collision_mask = value
