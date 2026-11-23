extends Node3D
## WASD Character smoke test (render run on the Compatibility renderer): a character that code steers reaches its
## walk, run, and sprint speeds, stops, turns its model toward where it goes, and plays the clip of each gait at a
## pace that follows its speed; it jumps to its jump height, tells when it jumps and lands, cannot jump twice with
## one jump and can with two, jumps a moment after walking off an edge, and pushes a crate; an action clip plays once
## and holds it in place; it walks up and down a flight of stairs without leaving the ground or its walk clip, and
## stops before a step higher than it may take; a humanoid's feet stand on the slope under them, which they miss
## without foot placement, and stay as animated on level ground, and it has no face without the add-on that gives
## one; a character the player controls adds its actions,
## moves on a held key relative to its orbit camera, and gets a capsule; and the camera stays in front of a wall.

const ID := "wasd-character"


func _ready() -> void:
	get_tree().create_timer(120.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _seconds(seconds: float) -> void:
	for _i: int in int(seconds * Engine.physics_ticks_per_second):
		await get_tree().physics_frame


## A stand-in model: a box under a node, with an animation player that holds empty clips by the usual names.
func _model(clip_names: Array) -> Node3D:
	var model := Node3D.new()
	model.name = "Model"
	var mesh := MeshInstance3D.new()
	var box := BoxMesh.new()
	box.size = Vector3(0.6, 1.7, 0.4)
	mesh.mesh = box
	mesh.position.y = 0.85
	model.add_child(mesh)
	var player := AnimationPlayer.new()
	var library := AnimationLibrary.new()
	for clip_name: String in clip_names:
		var clip := Animation.new()
		clip.length = 0.5 if clip_name in ["Jump_Start", "Jump_Land", "Wave"] else 1.0
		clip.loop_mode = Animation.LOOP_NONE if clip_name in ["Jump_Start", "Jump_Land", "Wave"] else Animation.LOOP_LINEAR
		library.add_animation(clip_name, clip)
	player.add_animation_library(&"moves", library)
	model.add_child(player)
	return model


func _block(size: Vector3, at: Vector3) -> StaticBody3D:
	var body := StaticBody3D.new()
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = size
	shape.shape = box
	body.add_child(shape)
	body.position = at
	add_child(body)
	return body


## Six steps of 18 cm that rise toward -Z from z = -60, a landing behind them, and beside them a step of 50 cm.
func _stairs() -> bool:
	for index: int in 6:
		_block(Vector3(3.0, 0.18 * (index + 1), 0.3), Vector3(0, 0.09 * (index + 1), -60.0 - index * 0.3))
	_block(Vector3(3.0, 1.08, 3.0), Vector3(0, 0.54, -63.3))
	_block(Vector3(3.0, 0.5, 3.0), Vector3(6.0, 0.25, -61.5))
	var walker := WasdCharacter3D.new()
	walker.controlled = false
	walker.position = Vector3(0, 0.05, -58.5)
	walker.add_child(_model(["Idle", "Walk", "Jog_Fwd", "Jump"]))
	add_child(walker)
	var falls: Array[float] = []
	walker.landed.connect(func(speed: float) -> void: falls.append(speed))
	await _seconds(0.4)
	falls.clear()
	walker.wish_gait = "walk"
	for way: Vector3 in [Vector3(0, 0, -1), Vector3(0, 0, 1)]:
		walker.wish_direction = way
		var airborne := 0
		var other_clips := {}
		for _i: int in 330:
			await get_tree().physics_frame
			if not walker.is_grounded():
				airborne += 1
			if walker.animation_player.current_animation != "moves/Walk":
				other_clips[walker.animation_player.current_animation] = true
			if (way.z < 0.0 and walker.global_position.z < -63.0) or (way.z > 0.0 and walker.global_position.z > -58.6):
				break
		var up := way.z < 0.0
		if absf(walker.global_position.y - (1.08 if up else 0.0)) > 0.03:
			_fail("walking %s the stairs the character came to a height of %.2f m at z %.2f" % ["up" if up else "down", walker.global_position.y, walker.global_position.z])
			return false
		if airborne > 0 or not other_clips.is_empty() or not falls.is_empty():
			_fail("walking %s the stairs the character left the ground for %d steps, played %s, and landed %s" % ["up" if up else "down", airborne, other_clips.keys(), falls])
			return false
	# A step of 50 cm is more than it may take: it stops there.
	walker.teleport(Vector3(6.0, 0.05, -58.5))
	walker.wish_direction = Vector3(0, 0, -1)
	await _seconds(2.0)
	if walker.global_position.y > 0.05 or walker.global_position.z < -59.8:
		_fail("a step of 50 cm let the character through to %s" % [walker.global_position])
		return false
	walker.step_height = 0.0
	walker.teleport(Vector3(0, 0.05, -58.5))
	await _seconds(2.0)
	if walker.global_position.y > 0.05:
		_fail("with no step height the character climbed to %.2f m" % [walker.global_position.y])
		return false
	walker.queue_free()
	return true


## A stand-in humanoid: Godot's humanoid bone names for the hips and legs, the knees a little forward, and one clip
## that holds the pose. Ankles are 8 cm over the model's origin.
func _humanoid() -> Node3D:
	var model := Node3D.new()
	model.name = "Model"
	var skeleton := Skeleton3D.new()
	skeleton.name = "GeneralSkeleton"
	model.add_child(skeleton)
	skeleton.owner = model
	skeleton.unique_name_in_owner = true
	var hips := skeleton.add_bone("Hips")
	skeleton.set_bone_rest(hips, Transform3D(Basis.IDENTITY, Vector3(0, 0.9, 0)))
	for side: Array in [["Left", 0.1], ["Right", -0.1]]:
		var upper := skeleton.add_bone("%sUpperLeg" % [side[0]])
		skeleton.set_bone_parent(upper, hips)
		skeleton.set_bone_rest(upper, Transform3D(Basis.IDENTITY, Vector3(side[1], 0, 0)))
		var lower := skeleton.add_bone("%sLowerLeg" % [side[0]])
		skeleton.set_bone_parent(lower, upper)
		skeleton.set_bone_rest(lower, Transform3D(Basis.IDENTITY, Vector3(0, -0.41, 0.04)))
		var foot := skeleton.add_bone("%sFoot" % [side[0]])
		skeleton.set_bone_parent(foot, lower)
		skeleton.set_bone_rest(foot, Transform3D(Basis.IDENTITY, Vector3(0, -0.41, -0.04)))
	skeleton.reset_bone_poses()
	var player := AnimationPlayer.new()
	var library := AnimationLibrary.new()
	var clip := Animation.new()
	clip.length = 1.0
	clip.loop_mode = Animation.LOOP_LINEAR
	library.add_animation("Idle", clip)
	player.add_animation_library(&"moves", library)
	model.add_child(player)
	return model


## How high each ankle of a character stands over the ground under it, read while the skeleton holds what its
## modifiers made of the pose.
func _ankles(character: WasdCharacter3D) -> Array[float]:
	var skeleton := character.model.get_node("%GeneralSkeleton") as Skeleton3D
	var seen := {}
	var read := func() -> void:
		for bone: String in ["LeftFoot", "RightFoot"]:
			seen[bone] = skeleton.global_transform * skeleton.get_bone_global_pose(skeleton.find_bone(bone)).origin
	skeleton.skeleton_updated.connect(read)
	for _i: int in 5:
		await get_tree().process_frame
	skeleton.skeleton_updated.disconnect(read)
	if seen.size() < 2:
		# A skeleton whose pose nothing changes does not update: its bones are as they stand.
		read.call()
	var heights: Array[float] = []
	for bone: String in ["LeftFoot", "RightFoot"]:
		var at: Vector3 = seen[bone]
		var query := PhysicsRayQueryParameters3D.create(at + Vector3.UP * 0.6, at + Vector3.DOWN * 1.5, 1, [character.get_rid()])
		var hit := get_world_3d().direct_space_state.intersect_ray(query)
		heights.append(at.y - float(hit["position"].y) if not hit.is_empty() else -9.0)
	return heights


## A humanoid on level ground, then on a slope of 20 degrees that rises to its left.
func _feet() -> bool:
	var ramp := _block(Vector3(8.0, 0.4, 8.0), Vector3(0, 1.0, -90.0))
	ramp.rotation.z = deg_to_rad(-20.0)
	var human := WasdCharacter3D.new()
	human.controlled = false
	human.position = Vector3(12.0, 0.05, -90.0)
	human.add_child(_humanoid())
	add_child(human)
	await _seconds(0.6)
	if human.feet == null or not human.feet.active:
		_fail("a humanoid got no foot placement")
		return false
	# A face comes from the wasd-face add-on, which is not installed here; that add-on's smoke test has one.
	if human.face != null:
		_fail("without the wasd-face add-on the character has the face %s" % [human.face])
		return false
	var level := await _ankles(human)
	if absf(level[0] - 0.08) > 0.01 or absf(level[1] - 0.08) > 0.01:
		_fail("on level ground the ankles stand %s m over it, not 0.08" % [level])
		return false
	human.teleport(Vector3(0, 2.2, -90.0), Vector3(0, 0, -1))
	await _seconds(1.5)
	if not human.is_grounded():
		_fail("the humanoid does not stand on the slope")
		return false
	var placed := await _ankles(human)
	if absf(placed[0] - 0.08) > 0.03 or absf(placed[1] - 0.08) > 0.03:
		_fail("on the slope the ankles stand %s m over it, not 0.08" % [placed])
		return false
	# Without foot placement one foot is in the slope and the other over it.
	human.foot_placement = false
	await _seconds(0.5)
	var loose := await _ankles(human)
	if absf(loose[0] - loose[1]) < 0.05:
		_fail("without foot placement the ankles stand %s m over the slope: the slope does not tell the feet apart" % [loose])
		return false
	human.queue_free()
	return true


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var ground := StaticBody3D.new()
	var shape := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(200, 1, 200)
	shape.shape = box
	ground.add_child(shape)
	ground.position.y = -0.5
	add_child(ground)

	# A character that code steers, with clips for every gait.
	var hero := WasdCharacter3D.new()
	hero.controlled = false
	hero.add_child(_model(["Idle", "Walk", "Jog_Fwd", "Sprint", "Jump_Start", "Jump", "Jump_Land", "Wave"]))
	add_child(hero)
	var events: Array[String] = []
	hero.jumped.connect(func() -> void: events.append("jumped"))
	hero.landed.connect(func(speed: float) -> void: events.append("landed %.1f" % [speed]))
	await _seconds(0.3)
	var player := hero.animation_player
	if player == null or hero.clips.size() < 7 or hero.clips["run"] != "moves/Jog_Fwd" or hero.clips["air"] != "moves/Jump":
		return _fail("the character found the clips %s" % [hero.clips])
	if player.current_animation != "moves/Idle":
		return _fail("at rest the clip is %s" % [player.current_animation])
	var paces := {}
	for gait: String in ["walk", "run", "sprint"]:
		hero.wish_direction = Vector3(1, 0, 0)
		hero.wish_gait = gait
		await _seconds(1.2)
		var wanted: float = hero.get("%s_speed" % [gait])
		if absf(hero.get_ground_speed() - wanted) > 0.05:
			return _fail("at a %s the character moves at %.2f m/s, not %.2f" % [gait, hero.get_ground_speed(), wanted])
		if player.current_animation != hero.clips[gait]:
			return _fail("at a %s the clip is %s" % [gait, player.current_animation])
		paces[gait] = player.speed_scale
	# The walk clip keeps a foot planted at 1.17 m/s, so 1.4 m/s plays it faster; the run's 5.2 m/s is under its 6.6.
	if absf(paces["walk"] - 1.4 / 1.17) > 0.03 or absf(paces["run"] - 5.2 / 6.6) > 0.03:
		return _fail("the clips play at %s times their speed" % [paces])
	var model := hero.model
	if model == null or absf(angle_difference(model.rotation.y, PI * 0.5)) > 0.1:
		return _fail("moving toward +X turned the model to %.2f rad" % [model.rotation.y if model != null else -1.0])
	hero.wish_direction = Vector3.ZERO
	await _seconds(0.6)
	if hero.get_ground_speed() > 0.01 or player.current_animation != "moves/Idle":
		return _fail("told to stop, the character moves at %.2f m/s with the clip %s" % [hero.get_ground_speed(), player.current_animation])

	# A jump reaches its height, tells of itself, and a second press in the air does nothing with one jump.
	var from := hero.global_position.y
	var highest := from
	if not hero.jump() or hero.jump():
		return _fail("with one jump, the first jump or a second in the air went wrong")
	for _i: int in 90:
		await get_tree().physics_frame
		highest = maxf(highest, hero.global_position.y)
		if player.current_animation == "moves/Jump":
			events.append("air clip")
	if absf(highest - from - hero.jump_height) > 0.12 or not hero.is_on_floor():
		return _fail("a jump of %.2f m rose %.2f m" % [hero.jump_height, highest - from])
	if events.count("jumped") != 1 or not events.has("air clip") or events.filter(func(event: String) -> bool: return event.begins_with("landed")).size() != 1:
		return _fail("the jump told %s" % [events])
	hero.max_jumps = 2
	hero.jump()
	await _seconds(0.2)
	if not hero.jump():
		return _fail("with two jumps, the second in the air was refused")
	await _seconds(1.5)
	hero.max_jumps = 1

	# An action clip plays once and holds the character where it stands.
	if not hero.play_action("Wave") or hero.play_action("NoSuchClip"):
		return _fail("play_action found a clip that is not there, or not the one that is")
	hero.wish_direction = Vector3(0, 0, 1)
	await _seconds(0.3)
	if player.current_animation != "moves/Wave" or hero.get_ground_speed() > 0.01:
		return _fail("during an action the clip is %s and the speed %.2f" % [player.current_animation, hero.get_ground_speed()])
	await _seconds(0.6)
	if hero.get_ground_speed() < 1.0:
		return _fail("after the action the character does not walk on")
	hero.wish_direction = Vector3.ZERO
	await _seconds(0.5)

	# It pushes a crate, and jumps a moment after walking off an edge.
	var crate := RigidBody3D.new()
	var crate_shape := CollisionShape3D.new()
	var crate_box := BoxShape3D.new()
	crate_box.size = Vector3.ONE * 0.8
	crate_shape.shape = crate_box
	crate.add_child(crate_shape)
	crate.mass = 10.0
	hero.teleport(Vector3(0, 0.05, 20))
	crate.position = Vector3(2.0, 0.45, 20)
	add_child(crate)
	hero.wish_direction = Vector3(1, 0, 0)
	hero.wish_gait = "walk"
	await _seconds(2.5)
	if crate.global_position.x < 2.4:
		return _fail("the crate moved to x %.2f" % [crate.global_position.x])
	hero.wish_direction = Vector3.ZERO
	var ledge := StaticBody3D.new()
	var ledge_shape := CollisionShape3D.new()
	var ledge_box := BoxShape3D.new()
	ledge_box.size = Vector3(4, 1, 4)
	ledge_shape.shape = ledge_box
	ledge.add_child(ledge_shape)
	ledge.position = Vector3(0, 4.5, 40)
	add_child(ledge)
	hero.teleport(Vector3(1.5, 5.05, 40))
	await _seconds(0.3)
	hero.wish_direction = Vector3(1, 0, 0)
	hero.wish_gait = "run"
	var jumped_late := false
	for _i: int in 60:
		await get_tree().physics_frame
		if not hero.is_on_floor() and not jumped_late:
			# Three frames after the edge: within the forgiving moment.
			for _wait: int in 3:
				await get_tree().physics_frame
			jumped_late = hero.jump()
			break
	if not jumped_late:
		return _fail("a jump just after walking off an edge was refused")
	hero.wish_direction = Vector3.ZERO
	await _seconds(2.0)

	if not await _stairs():
		return
	if not await _feet():
		return

	# A character the player controls: it adds its actions and its capsule, and a held key moves it away from its
	# camera.
	var played := WasdCharacter3D.new()
	played.position = Vector3(0, 0.05, -30)
	played.add_child(_model(["Idle", "Walk"]))
	add_child(played)
	await _seconds(0.3)
	for action: String in ["move_left", "move_right", "move_forward", "move_back", "jump", "sprint", "walk"]:
		if not InputMap.has_action(action):
			return _fail("the action %s was not added" % [action])
	var has_capsule := false
	for child: Node in played.get_children():
		if child is CollisionShape3D and (child as CollisionShape3D).shape is CapsuleShape3D:
			has_capsule = true
	if not has_capsule or played.camera_rig == null or not played.camera_rig.camera.current:
		return _fail("the played character has a capsule %s and a current camera %s" % [has_capsule, played.camera_rig != null])
	if played.clips.get("run", "") != "moves/Walk":
		return _fail("a model with a walk clip only runs with %s" % [played.clips.get("run", "nothing")])
	var forward := played.camera_rig.get_forward()
	var start := played.global_position
	Input.action_press(&"move_forward")
	await _seconds(1.0)
	Input.action_release(&"move_forward")
	var went := played.global_position - start
	if went.length() < 2.0 or went.normalized().dot(forward) < 0.95:
		return _fail("holding forward moved the character %s, with the camera looking along %s" % [went, forward])
	await _seconds(0.5)
	# A wall just behind the character: the camera stays in front of it.
	var wall := StaticBody3D.new()
	var wall_shape := CollisionShape3D.new()
	var wall_box := BoxShape3D.new()
	wall_box.size = Vector3(20, 10, 0.5)
	wall_shape.shape = wall_box
	wall.add_child(wall_shape)
	wall.global_transform = Transform3D(Basis.looking_at(forward, Vector3.UP), played.global_position - forward * 1.5 + Vector3.UP * 2.0)
	add_child(wall)
	await _seconds(0.5)
	var back := (played.camera_rig.camera.global_position - played.global_position).dot(-forward)
	if back > 1.5 or back < 0.2:
		return _fail("with a wall 1.5 m behind, the camera is %.2f m behind the character" % [back])
	await RenderingServer.frame_post_draw
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
