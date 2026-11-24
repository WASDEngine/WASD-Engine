# SPDX-License-Identifier: CC0-1.0
# A character that walks, runs, sprints, and jumps the way players expect, and plays the matching animations of its
# model: movement relative to the camera with acceleration and smooth turning, steps and stairs taken in stride, a
# jump that forgives a late or early press, stronger gravity on the way down, and clips chosen by speed and played at
# the body's pace so that feet do not slide. It reads the player's input, or code steers it for enemies and companions. With the Universal Animation
# Library installed it gives a retargeted humanoid that library's clips by itself, and it puts a humanoid's feet on
# the stairs and slopes it stands on. With WASD Face installed it gives a model that has a face to move that face.
class_name WasdCharacter3D
extends CharacterBody3D

## The character left the ground by jumping.
signal jumped
## The character came down on the ground, at this many meters a second.
signal landed(speed: float)

const UAL := "res://addons/universal_animation_library/AnimationLibrary_Godot_Standard.glb"
## The script of the wasd-face add-on's WasdFace3D, which is loaded by its path because it may not be installed.
const FACE := "res://addons/wasd_face/face_3d.gd"
## The clips each kind of movement looks for, best first, by the end of a clip's name without regard to case.
const CLIPS := {
	"idle": ["Idle", "Idle_Loop", "Stand", "Breathing"],
	"walk": ["Walk", "Walk_Fwd", "Walk_Loop", "Walking"],
	"run": ["Jog_Fwd", "Jog", "Run", "Run_Fwd", "Running"],
	"sprint": ["Sprint", "Sprint_Fwd", "Run_Fast"],
	"jump": ["Jump_Start", "Jump_Up", "JumpStart"],
	"air": ["Jump", "Fall", "Falling", "Jump_Idle", "InAir"],
	"land": ["Jump_Land", "Land", "Landing"],
}
## Ground speed at which each kind of clip keeps a foot planted, in meters a second for a skeleton whose hips are
## one meter high; the Universal Animation Library's.
const CLIP_SPEEDS := {"walk": 1.17, "run": 6.6, "sprint": 10.2}

@export_group("Movement")
## Meters a second at a walk, at a run, and at a sprint.
@export_range(0.1, 20.0, 0.05) var walk_speed := 1.4
@export_range(0.1, 30.0, 0.05) var run_speed := 5.2
@export_range(0.1, 40.0, 0.05) var sprint_speed := 8.0
## How fast the character gains and loses speed on the ground, in m/s a second.
@export_range(1.0, 200.0, 0.5) var acceleration := 28.0
@export_range(1.0, 200.0, 0.5) var deceleration := 34.0
## Share of that steering the character keeps in the air.
@export_range(0.0, 1.0, 0.01) var air_control := 0.35
## How fast the model turns toward where it goes: higher is snappier.
@export_range(1.0, 40.0, 0.5) var turn_speed := 12.0
## How high a full jump rises, in meters; 0 takes jumping away.
@export_range(0.0, 10.0, 0.05) var jump_height := 1.25
## Jumps in a row before landing: 2 is a double jump.
@export_range(1, 5, 1) var max_jumps := 1
## Gravity as a multiple of the project's, and how much more it pulls on the way down.
@export_range(0.1, 5.0, 0.05) var gravity_scale := 1.0
@export_range(1.0, 4.0, 0.05) var fall_gravity := 1.6
## Seconds after walking off an edge in which a jump still counts, and before landing in which a press is kept.
@export_range(0.0, 0.5, 0.01) var coyote_time := 0.12
@export_range(0.0, 0.5, 0.01) var jump_buffer := 0.12
## Force with which the character pushes rigid bodies it walks into; 0 leaves them be.
@export_range(0.0, 200.0, 1.0) var push := 40.0
## The highest step the character walks up without a jump, in meters: stairs, curbs, door sills. 0 stops at each.
@export_range(0.0, 1.0, 0.01) var step_height := 0.3

@export_group("Control")
## true reads the player's input; false waits for code to set `wish_direction` and `wish_gait`.
@export var controlled := true
## true adds a WasdOrbitCamera3D behind the character. With false, movement is relative to the current camera.
@export var orbit_camera := true
## The input actions the character reads. A missing action is added with its usual keys and gamepad controls.
@export var actions := {
	"left": "move_left", "right": "move_right", "forward": "move_forward", "back": "move_back",
	"jump": "jump", "sprint": "sprint", "walk": "walk",
}

@export_group("Model")
## The node that shows the character and turns toward where it goes; none takes the first Node3D child that is
## neither a shape nor a camera.
@export var model: Node3D
## Turns the model on top of its heading, in degrees: 180 for a model that faces -Z, as Kenney's do.
@export_range(-180.0, 180.0, 1.0) var model_turn := 0.0
## The animation player whose clips the character plays; none looks under the character for one.
@export var animation_player: AnimationPlayer
## Seconds one clip takes to blend into the next.
@export_range(0.0, 1.0, 0.01) var blend := 0.2
## The capsule the character gets when it has no collision shape of its own: its height and radius in meters.
@export var body_size := Vector2(1.75, 0.32)
## Puts the feet of a model with Godot's humanoid bone names on the stairs and slopes it stands on.
@export var foot_placement := true:
	set(value):
		foot_placement = value
		if feet != null:
			feet.active = value

## Where code wants the character to go, in the world, as long as 1 for full speed; read when `controlled` is false.
var wish_direction := Vector3.ZERO
## "walk", "run", or "sprint", for a character that code steers.
var wish_gait := "run"
## The camera the character added for itself, if `orbit_camera` is on.
var camera_rig: WasdOrbitCamera3D
## The clip found for each kind of movement: "idle", "walk", "run", "sprint", "jump", "air", "land".
var clips := {}
## What puts the model's feet on the ground, if the model is a humanoid: its `reach` and `sole_tilt` can be set.
var feet: WasdFootPlacement3D
## What blinks, looks, and speaks for the model: the WasdFace3D that the wasd-face add-on gives a model with a face
## to move. None without that add-on or such a model.
var face: Node3D

var _gravity := 9.8
var _since_floor := 0.0
var _since_press := 1.0
var _jumps := 0
var _was_on_floor := true
var _fall_speed := 0.0
var _acting := ""
var _acting_holds := false
## Where in its clip the action was at the last physics step: a clip that loops has played through once when it is
## back at an earlier place.
var _acting_at := 0.0
var _landing := 0.0
var _hips := 1.0
## How far the model still lags behind a step the body took, and the height it rests at.
var _lag := 0.0
var _model_y := 0.0
## Whether the last physics step put the body on a stair's edge, which holds it though no floor is under its middle.
var _on_step := false


func _ready() -> void:
	_gravity = float(ProjectSettings.get_setting("physics/3d/default_gravity", 9.8))
	if controlled:
		_add_missing_actions()
	if not _has_shape():
		var shape := CollisionShape3D.new()
		var capsule := CapsuleShape3D.new()
		capsule.height = body_size.x
		capsule.radius = body_size.y
		shape.shape = capsule
		shape.position.y = body_size.x * 0.5
		add_child(shape)
	if model == null:
		for child: Node in get_children():
			if child is Node3D and not child is CollisionShape3D and not child is Camera3D and not child is WasdOrbitCamera3D and not child is SpringArm3D:
				model = child
				break
	if model != null:
		_model_y = model.position.y
	_find_animations()
	if face == null and model != null and ResourceLoader.exists(FACE):
		face = (load(FACE) as GDScript).call(&"add_to", model)
	if orbit_camera and controlled:
		camera_rig = WasdOrbitCamera3D.new()
		camera_rig.height = body_size.x * 0.85
		add_child(camera_rig)
		if model != null:
			# Behind the model, looking the way it faces.
			var facing := _facing()
			camera_rig.look_along(Vector3(sin(facing), 0.0, cos(facing)))
	floor_snap_length = 0.3


## Leaves the ground now if the character may jump: for code that steers it. An action that holds the character keeps
## it from jumping; a jump ends one that does not. Returns whether it jumped.
func jump() -> bool:
	if jump_height <= 0.0 or (_acting != "" and _acting_holds):
		return false
	if _jumps == 0 and _since_floor > coyote_time:
		# Walked off an edge: the jump from the ground is spent, and only a second jump is left.
		_jumps = 1
	if _jumps >= max_jumps:
		return false
	velocity.y = sqrt(2.0 * _gravity * gravity_scale * jump_height)
	_jumps += 1
	_since_floor = coyote_time + 1.0
	_since_press = jump_buffer + 1.0
	_acting = ""
	_play("jump", 0.08)
	# After the jump's clip, so that an action begun on the signal plays.
	jumped.emit()
	return true


## Plays a clip of the model once, such as an attack, a wave, or picking something up, and goes back to moving when
## it ends; a clip that loops plays through once. `hold` keeps the character where it stands meanwhile, and from
## jumping. `clip` is a clip's name, with or without its library prefix. Returns whether the model has the clip.
func play_action(clip: String, hold := true) -> bool:
	var found := _find_clip([clip])
	if found == "":
		return false
	_acting = found
	_acting_holds = hold
	_acting_at = 0.0
	_landing = 0.0
	animation_player.speed_scale = 1.0
	animation_player.play(found, blend)
	return true


## Ends the action that plays, if one does: the character goes back to moving, and the clip of its movement blends in.
func stop_action() -> void:
	_acting = ""


## Puts the character somewhere at rest, with its camera: a respawn, a door to another level. `facing` is a direction in
## the world.
func teleport(to: Vector3, facing := Vector3.ZERO) -> void:
	global_position = to
	velocity = Vector3.ZERO
	if facing.length() > 0.001:
		face_toward(facing)
		if camera_rig != null:
			camera_rig.look_along(facing)
	if camera_rig != null:
		camera_rig.reset_smoothing()
	reset_physics_interpolation()


## Turns the model to look along a direction in the world at once.
func face_toward(direction: Vector3) -> void:
	if model != null and Vector2(direction.x, direction.z).length() > 0.001:
		_face(atan2(direction.x, direction.z))


## Meters a second over the ground.
func get_ground_speed() -> float:
	return Vector2(velocity.x, velocity.z).length()


## Whether the character stands: on a floor, or on the edge of a stair it is climbing. Use it where a game would ask
## `is_on_floor()`, which is false for the moments a round body rests on a stair's edge.
func is_grounded() -> bool:
	return is_on_floor() or _on_step


func _physics_process(delta: float) -> void:
	if _acting != "":
		# An action ends with its clip: when the clip ends, another replaces it, or one that loops comes round again.
		if animation_player.current_animation != _acting or animation_player.current_animation_position < _acting_at:
			_acting = ""
		else:
			_acting_at = animation_player.current_animation_position
	var wish := wish_direction
	var gait := wish_gait
	var wants_jump := false
	var holds_jump := false
	if controlled:
		var stick := Input.get_vector(actions["left"], actions["right"], actions["forward"], actions["back"])
		var forward := _camera_forward()
		var right := Vector3(-forward.z, 0.0, forward.x)
		wish = right * stick.x - forward * stick.y
		gait = "sprint" if Input.is_action_pressed(actions["sprint"]) else ("walk" if Input.is_action_pressed(actions["walk"]) or stick.length() < 0.55 else "run")
		wants_jump = Input.is_action_just_pressed(actions["jump"])
		holds_jump = Input.is_action_pressed(actions["jump"])
	wish.y = 0.0
	if wish.length() > 1.0:
		wish = wish.normalized()
	if _acting != "" and _acting_holds:
		wish = Vector3.ZERO

	var on_floor := is_grounded()
	_since_floor = 0.0 if on_floor else _since_floor + delta
	_since_press = 0.0 if wants_jump else _since_press + delta
	if on_floor and velocity.y <= 0.0:
		_jumps = 0
	if _since_press <= jump_buffer:
		jump()
	# Letting go of the jump early makes a lower jump.
	if controlled and not holds_jump and velocity.y > 0.0 and _jumps > 0:
		velocity.y = move_toward(velocity.y, 0.0, _gravity * gravity_scale * 2.0 * delta)
	if not on_floor:
		velocity.y -= _gravity * gravity_scale * (fall_gravity if velocity.y < 0.0 else 1.0) * delta
		_fall_speed = maxf(_fall_speed, -velocity.y)

	var top := sprint_speed if gait == "sprint" else (walk_speed if gait == "walk" else run_speed)
	var goal := wish * top
	var flat := Vector3(velocity.x, 0.0, velocity.z)
	var gaining := goal.length() > 0.01 and goal.dot(flat) >= 0.0
	var rate := (acceleration if gaining else deceleration) * (1.0 if on_floor else air_control)
	flat = flat.move_toward(goal, rate * delta)
	velocity.x = flat.x
	velocity.z = flat.z
	var stood := global_position
	# On a stair the body is placed on the step's edge; everywhere else it slides as bodies do.
	_on_step = on_floor and step_height > 0.0 and velocity.y <= 0.0 and _step_up(flat * delta)
	if not _on_step:
		move_and_slide()
		_on_step = on_floor and step_height > 0.0 and velocity.y <= 0.0 and not is_on_floor() and _step_down()
	# A stair taken in one physics step would jolt the model; the feet, or the model, take it up over a moment. A step
	# is a change of height that no slope the body can walk gives for the distance it went.
	if on_floor and is_grounded():
		var rose := global_position.y - stood.y
		var went := Vector2(global_position.x - stood.x, global_position.z - stood.z).length()
		if absf(rose) > went * 1.2 + 0.02 and absf(rose) < step_height + 0.1:
			_floor_moved(rose)
	if model != null and _lag != 0.0:
		_lag = lerpf(_lag, 0.0, 1.0 - exp(-14.0 * delta))
		if absf(_lag) < 0.001:
			_lag = 0.0
		model.position.y = _model_y + _lag
	if push > 0.0:
		for index: int in get_slide_collision_count():
			var hit := get_slide_collision(index)
			var body := hit.get_collider() as RigidBody3D
			if body != null:
				body.apply_central_force(-hit.get_normal() * push * body.mass)

	if is_grounded() and not _was_on_floor:
		landed.emit(_fall_speed)
		# A hard landing shows, unless an action plays.
		if _fall_speed > 3.0 and clips.has("land") and _acting == "":
			_landing = 0.25
			_play("land", 0.08)
		_fall_speed = 0.0
	_was_on_floor = is_grounded()

	if model != null and flat.length() > 0.3:
		_face(lerp_angle(_facing(), atan2(flat.x, flat.z), 1.0 - exp(-turn_speed * delta)))
	_animate(delta)


## Which way the model faces in the world, as a turn about the up axis, without `model_turn`.
func _facing() -> float:
	return _parent_yaw() + model.rotation.y - deg_to_rad(model_turn)


## Turns the model to face a heading in the world, whatever turn the body or another node above the model has.
func _face(heading: float) -> void:
	model.rotation.y = heading - _parent_yaw() + deg_to_rad(model_turn)


## The turn about the up axis, in the world, of the node that holds the model.
func _parent_yaw() -> float:
	var parent := model.get_parent_node_3d()
	return parent.global_rotation.y if parent != null and parent.is_inside_tree() else 0.0


## Moves the body onto a step that blocks its way and is no higher than `step_height`: the body goes the way it was
## going and comes to rest on the step, at first on its edge, as a foot does. Returns whether it did; the body has
## then moved for this physics step.
func _step_up(motion: Vector3) -> bool:
	if motion.length() < 0.0005:
		return false
	var here := global_transform
	# A slow walk still looks 5 cm ahead, or it would stand before the step.
	var ahead := motion.normalized() * maxf(motion.length(), 0.05)
	var block := KinematicCollision3D.new()
	if not test_move(here, ahead, block):
		return false
	# A slope the body can walk needs no step.
	if block.get_normal().angle_to(Vector3.UP) <= floor_max_angle:
		return false
	var lift := Vector3.UP * step_height
	if test_move(here, lift):
		return false
	var raised := here.translated(lift)
	if test_move(raised, motion):
		return false
	var landing := KinematicCollision3D.new()
	if not test_move(raised.translated(motion), -lift, landing):
		return false
	var rise := step_height + landing.get_travel().y
	if rise < 0.0 or rise > step_height:
		return false
	# A round body comes down on the step's edge: the edge's height is the step's, and since its slant says nothing of
	# the step, a ray just past it asks the step's top.
	var edge := landing.get_position()
	if edge.y - global_position.y > step_height + 0.01:
		return false
	var over := edge + ahead.normalized() * 0.02
	var query := PhysicsRayQueryParameters3D.create(Vector3(over.x, edge.y + 0.05, over.z), Vector3(over.x, edge.y - 0.05, over.z), collision_mask, [get_rid()])
	var top := get_world_3d().direct_space_state.intersect_ray(query)
	if top.is_empty() or (top["normal"] as Vector3).angle_to(Vector3.UP) > floor_max_angle:
		return false
	global_position += motion + Vector3.UP * rise
	velocity.y = 0.0
	return true


## Keeps the body on a stair it walks down: past a step's edge a round body has no floor under its middle and would
## fall to the next step. With ground no further below than `step_height`, it comes down onto the edge or the step
## and stays standing. Returns whether it did.
func _step_down() -> bool:
	var from := global_position + Vector3.UP * 0.05
	var query := PhysicsRayQueryParameters3D.create(from, from + Vector3.DOWN * (step_height + 0.1), collision_mask, [get_rid()])
	var below := get_world_3d().direct_space_state.intersect_ray(query)
	if below.is_empty() or (below["normal"] as Vector3).angle_to(Vector3.UP) > floor_max_angle:
		return false
	var landing := KinematicCollision3D.new()
	if not test_move(global_transform, Vector3.DOWN * (step_height + 0.05), landing):
		return false
	global_position.y += landing.get_travel().y
	velocity.y = 0.0
	return true


## The body's floor rose, or fell, by this much in one step: the model keeps its place and follows over a moment.
func _floor_moved(by: float) -> void:
	if feet != null and feet.active:
		feet.floor_moved(by)
	else:
		_lag -= by


## Picks the clip for what the body does and plays it at the body's pace.
func _animate(delta: float) -> void:
	if animation_player == null or _acting != "":
		return
	_landing = maxf(_landing - delta, 0.0)
	if _landing > 0.0:
		return
	if not is_grounded():
		if velocity.y < 0.0 or animation_player.current_animation != clips.get("jump", ""):
			_play("air")
		return
	var speed := get_ground_speed()
	if speed < 0.15:
		_play("idle")
		return
	var kind := "walk"
	if speed > (run_speed + sprint_speed) * 0.5 and clips.has("sprint"):
		kind = "sprint"
	elif speed > (walk_speed + run_speed) * 0.5 and clips.has("run"):
		kind = "run"
	# Played at the pace that keeps a foot on the ground, within what still looks like the same gait.
	var planted: float = CLIP_SPEEDS[kind] * _hips
	_play(kind, blend, clampf(speed / planted, 0.6, 1.8) if planted > 0.0 else 1.0)


func _play(kind: String, over := -1.0, pace := 1.0) -> void:
	if animation_player == null or not clips.has(kind):
		return
	var clip: String = clips[kind]
	animation_player.speed_scale = pace
	if animation_player.current_animation != clip:
		animation_player.play(clip, blend if over < 0.0 else over)


## Finds the model's animation player and the clip for each kind of movement. A humanoid retargeted for the
## Universal Animation Library that has no clips of its own gets a player with that library.
func _find_animations() -> void:
	if animation_player == null:
		animation_player = _first_player(self)
	var skeleton := (model.get_node_or_null("%GeneralSkeleton") as Skeleton3D) if model != null else null
	if skeleton != null:
		_hips = skeleton.motion_scale if skeleton.motion_scale > 0.0 else 1.0
		if feet == null and WasdFootPlacement3D.fits(skeleton):
			feet = WasdFootPlacement3D.new()
			feet.body = self
			feet.ground_mask = collision_mask
			feet.active = foot_placement
			skeleton.add_child(feet)
	if (animation_player == null or _find_clip(CLIPS["idle"]) == "") and skeleton != null and ResourceLoader.exists(UAL):
		var library := load(UAL) as AnimationLibrary
		if library != null:
			if animation_player == null:
				animation_player = AnimationPlayer.new()
				add_child(animation_player)
				animation_player.root_node = animation_player.get_path_to(model)
			if not animation_player.has_animation_library(&"ual"):
				animation_player.add_animation_library(&"ual", library)
	clips.clear()
	if animation_player == null:
		return
	for kind: String in CLIPS:
		var found := _find_clip(CLIPS[kind])
		if found != "":
			clips[kind] = found
	# A model with fewer clips walks where it would run, and stands where it would fall.
	for pair: Array in [["run", "walk"], ["walk", "run"], ["sprint", "run"], ["air", "jump"], ["air", "idle"]]:
		if not clips.has(pair[0]) and clips.has(pair[1]):
			clips[pair[0]] = clips[pair[1]]


## The first clip of the player that has one of the wanted names, or that name with `_Loop` after it, without regard
## to case. A wanted name without a library prefix is compared with the clips' names after theirs.
func _find_clip(wanted: Array) -> String:
	if animation_player == null:
		return ""
	var all := animation_player.get_animation_list()
	for want: String in wanted:
		var sought := want.to_lower()
		for clip: String in all:
			var named := clip.to_lower()
			if not sought.contains("/"):
				named = named.get_slice("/", named.get_slice_count("/") - 1)
			if named == sought or named == sought + "_loop":
				return clip
	return ""


func _first_player(under: Node) -> AnimationPlayer:
	for child: Node in under.get_children():
		if child is AnimationPlayer:
			return child
		var deeper := _first_player(child)
		if deeper != null:
			return deeper
	return null


func _has_shape() -> bool:
	for child: Node in get_children():
		if child is CollisionShape3D or child is CollisionPolygon3D:
			return true
	return false


func _camera_forward() -> Vector3:
	if camera_rig != null:
		return camera_rig.get_forward()
	var seen := get_viewport().get_camera_3d()
	if seen == null:
		return Vector3.FORWARD
	var forward := -seen.global_basis.z
	forward.y = 0.0
	if forward.length() < 0.05:
		# A camera that looks straight down: its top edge is forward.
		forward = seen.global_basis.y
		forward.y = 0.0
	return forward.normalized()


## Adds the actions the project lacks: WASD and the arrow keys, Space, Shift, C, and a gamepad's left stick, its
## bottom button, and its left stick's click. C walks rather than Ctrl, with which W closes a browser's tab.
func _add_missing_actions() -> void:
	var usual := {
		"left": {"keys": [KEY_A, KEY_LEFT], "axis": [JOY_AXIS_LEFT_X, -1.0]},
		"right": {"keys": [KEY_D, KEY_RIGHT], "axis": [JOY_AXIS_LEFT_X, 1.0]},
		"forward": {"keys": [KEY_W, KEY_UP], "axis": [JOY_AXIS_LEFT_Y, -1.0]},
		"back": {"keys": [KEY_S, KEY_DOWN], "axis": [JOY_AXIS_LEFT_Y, 1.0]},
		"jump": {"keys": [KEY_SPACE], "button": JOY_BUTTON_A},
		"sprint": {"keys": [KEY_SHIFT], "button": JOY_BUTTON_LEFT_STICK},
		"walk": {"keys": [KEY_C]},
	}
	for role: String in usual:
		var action := StringName(actions.get(role, ""))
		if action == &"" or InputMap.has_action(action):
			continue
		InputMap.add_action(action, 0.2)
		var controls: Dictionary = usual[role]
		for code: Key in controls["keys"]:
			var key := InputEventKey.new()
			key.physical_keycode = code
			InputMap.action_add_event(action, key)
		if controls.has("axis"):
			var motion := InputEventJoypadMotion.new()
			motion.axis = controls["axis"][0]
			motion.axis_value = controls["axis"][1]
			InputMap.action_add_event(action, motion)
		if controls.has("button"):
			var button := InputEventJoypadButton.new()
			button.button_index = controls["button"]
			InputMap.action_add_event(action, button)
