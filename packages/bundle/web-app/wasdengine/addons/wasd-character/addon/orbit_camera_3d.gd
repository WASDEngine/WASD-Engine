# SPDX-License-Identifier: CC0-1.0
# A third-person camera that circles what it follows: the mouse or a gamepad's right stick turns it, a spring arm
# keeps it out of walls, and it eases after its target. It builds its own arm and Camera3D. It works alone with any
# Node3D, and WasdCharacter3D adds one for itself.
class_name WasdOrbitCamera3D
extends Node3D

## The mouse buttons whose click takes the pointer. A step of the wheel does not, and a browser would not lock the
## pointer on one.
const CLICKS: Array[MouseButton] = [MOUSE_BUTTON_LEFT, MOUSE_BUTTON_RIGHT, MOUSE_BUTTON_MIDDLE]

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
## true hides and holds the mouse pointer while the game has it: the first click of the left, right, or middle button
## takes it, the cancel key frees it. A turn of the wheel does not.
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
## Where the rig came to in the last two physics steps, when its target moves in them.
var _was := Vector3.ZERO
var _is := Vector3.ZERO
## Where the target was in the last frame, whether a physics step has run since, and whether something moved the
## target in the last frame that had no physics step, as a Tween or an AnimationPlayer does: then the rig follows it in
## every frame.
var _last := Vector3.ZERO
var _stepped := false
var _between_steps := false


func _init() -> void:
	top_level = true
	# The rig is placed in every frame, so physics interpolation must not move it as well.
	physics_interpolation_mode = Node.PHYSICS_INTERPOLATION_MODE_OFF
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
	reset_smoothing()
	var followed := _followed()
	if followed != null:
		# Start behind the target, looking the way it faces.
		_yaw = followed.global_rotation.y + PI
		if followed is CollisionObject3D:
			_arm.add_excluded_object((followed as CollisionObject3D).get_rid())
	_turn()


## The way the camera looks, flat on the ground: forward for whoever moves relative to the camera.
func get_forward() -> Vector3:
	return Vector3(-sin(_yaw), 0.0, -cos(_yaw))


## Puts the rig where it follows its target at once, without easing there: after the target was moved at once, as by a
## teleport, so that the view does not sweep across what lies between.
func reset_smoothing() -> void:
	var followed := _followed()
	if followed != null:
		global_position = followed.global_position + Vector3.UP * height
		_last = followed.global_position
	_was = global_position
	_is = global_position


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
	elif capture_mouse and not held and event is InputEventMouseButton and (event as InputEventMouseButton).pressed and (event as InputEventMouseButton).button_index in CLICKS:
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
		var at := followed.global_position
		if not _stepped:
			_between_steps = at != _last
		_stepped = false
		_last = at
		if _moves_in_steps(followed) and not _between_steps:
			# Drawn as the target is: between the last two physics steps with physics interpolation, else where the
			# last step left it.
			global_position = _was.lerp(_is, Engine.get_physics_interpolation_fraction()) if followed.is_physics_interpolated_and_enabled() else _is
		else:
			global_position = _eased(global_position, followed.get_global_transform_interpolated().origin, delta)
			_was = global_position
			_is = global_position
	_turn()


func _physics_process(delta: float) -> void:
	_stepped = true
	var followed := _followed()
	if followed != null and _moves_in_steps(followed) and not _between_steps:
		_was = _is
		_is = _eased(_is, followed.global_position, delta)


func _eased(from: Vector3, at: Vector3, delta: float) -> Vector3:
	var to := at + Vector3.UP * height
	return to if follow_speed <= 0.0 else from.lerp(to, 1.0 - exp(-follow_speed * delta))


## Whether the target moves in physics steps: a physics body, or a node under one. Unless something also moves it between
## steps, the rig then eases after it in those steps, so that the two keep together on the screen however many frames
## are drawn for each step.
func _moves_in_steps(followed: Node3D) -> bool:
	var node: Node = followed
	while node != null:
		if node is PhysicsBody3D:
			return true
		node = node.get_parent()
	return false


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
