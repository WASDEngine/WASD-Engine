extends Node3D
## WASD Face smoke test (render run on the Compatibility renderer, with no sound device): a face fits a model with
## face shapes or eye bones and no other, and add_to() puts one under its skeleton; it blinks by itself and when
## told; neck, head, and eyes turn to a target beside and above it, by the shares set, each eye by itself, and back
## for one behind it; its node sits between the eyes; a WasdCharacter3D of the wasd-character add-on, which the
## suite installs beside this one, gets a face by itself when its model has one to move, and is looked at in its
## face, or at the height of its eyes, not at its feet; the mouth follows the loudness of a voice that plays, wide
## for loud syllables, less for soft ones, shut in between, moves by rhythm for a sound without a length and for a
## line of text, and takes a value from the game; WasdVoice reads the same made-up voice from a WAV, an MP3, and an
## Ogg Vorbis file, a sound started in its middle, and one that loops; expressions come and go by the model's names
## and the common ones, on shapes named as ARKit and VRM name them; a face moves only its own model's meshes; a
## face switched off rests; a shape that the face sets moves what is drawn; and at full liveliness the face does
## what a living one does unasked: eyes that look at a still thing glance about it, lids follow eyes that look down,
## and the syllables of speech take shapes of their own. Feelings come and go by name, and a human whose eyes'
## material is named as the mpfb guide's wasd_mpfb names it is dressed by the wasd-materials add-on, which the suite
## also installs, unless told not to. What the game asks for is checked with liveliness at 0, where nothing else
## moves the face.
##
## voice.wav, voice.mp3, and voice.ogg hold one made-up voice, not a recording: a pulse train through three
## resonances, as three loud syllables from 0.4 s and three at a fifth of their strength from 1.4 s, 2.4 s in all.

const ID := "wasd-face"
const SHAPES := ["blink_l", "blink_r", "mouth_open", "mouth_narrow", "mouth_wide", "smile"]

## Where the head and the eyes of each skeleton point, in its own space, as its modifiers left them.
var gaze := {}


func _ready() -> void:
	get_tree().create_timer(100.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


## Waits until a check holds, for at most some seconds of the clock on the wall: a render run draws frames as fast
## as it can. Returns whether it came to hold.
func _until(check: Callable, seconds: float) -> bool:
	var until := Time.get_ticks_msec() + int(seconds * 1000.0)
	while Time.get_ticks_msec() < until:
		if check.call():
			return true
		await get_tree().process_frame
	return check.call()


func _wait(seconds: float) -> void:
	await _until(func() -> bool: return false, seconds)


## A stand-in head: a skeleton with Godot's humanoid names for the hips, the neck, the head, and, if wanted, two
## eyes, and a mesh with the blend shapes named: a red square a quarter of a meter wide at the head's height, which
## the shape mouth_open moves aside. The mesh hangs under the skeleton, or beside it and bound to it.
func _model(shapes: Array, eyes := true, beside := false, under: Node = null) -> Skeleton3D:
	var model: Node = under if under != null else Node3D.new()
	var bones := Skeleton3D.new()
	bones.name = "GeneralSkeleton"
	model.add_child(bones, true)
	var hips := bones.add_bone("Hips")
	bones.set_bone_rest(hips, Transform3D(Basis.IDENTITY, Vector3(0, 0.9, 0)))
	var neck := bones.add_bone("Neck")
	bones.set_bone_parent(neck, hips)
	bones.set_bone_rest(neck, Transform3D(Basis.IDENTITY, Vector3(0, 0.6, 0)))
	var head := bones.add_bone("Head")
	bones.set_bone_parent(head, neck)
	bones.set_bone_rest(head, Transform3D(Basis.IDENTITY, Vector3(0, 0.1, 0)))
	if eyes:
		for side: Array in [["LeftEye", 0.03], ["RightEye", -0.03]]:
			var eye := bones.add_bone(side[0])
			bones.set_bone_parent(eye, head)
			bones.set_bone_rest(eye, Transform3D(Basis.IDENTITY, Vector3(side[1], 0.07, 0.08)))
	bones.reset_bone_poses()
	var square := QuadMesh.new()
	square.size = Vector2(0.25, 0.25)
	var arrays := square.get_mesh_arrays()
	var mesh := ArrayMesh.new()
	var moved := []
	for shape: String in shapes:
		mesh.add_blend_shape(shape)
		var arrays_of_shape := []
		arrays_of_shape.resize(Mesh.ARRAY_MAX)
		for part: int in [Mesh.ARRAY_VERTEX, Mesh.ARRAY_NORMAL, Mesh.ARRAY_TANGENT]:
			arrays_of_shape[part] = arrays[part]
		if shape == "mouth_open":
			var aside := PackedVector3Array()
			for corner: Vector3 in arrays[Mesh.ARRAY_VERTEX]:
				aside.append(corner + Vector3(0.6, 0.0, 0.0))
			arrays_of_shape[Mesh.ARRAY_VERTEX] = aside
		moved.append(arrays_of_shape)
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays, moved)
	var instance := MeshInstance3D.new()
	instance.name = "Face"
	instance.mesh = mesh
	instance.position = Vector3(0, 1.6, 0)
	var red := StandardMaterial3D.new()
	red.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	red.albedo_color = Color(0.9, 0.1, 0.1)
	instance.material_override = red
	if beside:
		model.add_child(instance, true)
		instance.skeleton = instance.get_path_to(bones)
	else:
		bones.add_child(instance)
	if under == null:
		add_child(model)
	var read := func() -> void:
		var seen := {}
		for bone: String in ["Neck", "Head", "LeftEye", "RightEye"]:
			if bones.find_bone(bone) >= 0:
				seen[bone] = bones.get_bone_global_pose(bones.find_bone(bone)).basis.z.normalized()
		gaze[bones] = seen
	bones.skeleton_updated.connect(read)
	read.call()
	return bones


func _mesh_of(bones: Skeleton3D) -> MeshInstance3D:
	var under := bones.get_node_or_null(^"Face") as MeshInstance3D
	return under if under != null else bones.get_parent().find_children("Face*", "MeshInstance3D", true, false).filter(
		func(found: MeshInstance3D) -> bool: return found.get_node_or_null(found.skeleton) == bones)[0]


func _value(bones: Skeleton3D, shape: String) -> float:
	var instance := _mesh_of(bones)
	return instance.get_blend_shape_value(instance.find_blend_shape_by_name(shape))


## How far a bone points to the model's left and up from straight ahead, in degrees.
func _turn(bones: Skeleton3D, bone: String) -> Vector2:
	var ahead: Vector3 = gaze[bones][bone]
	return Vector2(rad_to_deg(atan2(ahead.x, ahead.z)), rad_to_deg(asin(clampf(ahead.y, -1.0, 1.0))))


## A place three meters from the eyes of a model at the origin: so many degrees to its left and up.
func _place(left: float, up: float) -> Vector3:
	var flat := cos(deg_to_rad(up)) * 3.0
	return Vector3(sin(deg_to_rad(left)) * flat, 1.67 + sin(deg_to_rad(up)) * 3.0, cos(deg_to_rad(left)) * flat)


## A sound made in code: 16 bit samples, 22,050 a second, of a tone at each strength for its seconds in turn.
func _sound(parts: Array) -> AudioStreamWAV:
	var data := PackedByteArray()
	var at := 0
	for part: Array in parts:
		var count := int(float(part[1]) * 22050.0)
		var begin := data.size()
		data.resize(begin + count * 2)
		for index: int in count:
			data.encode_s16(begin + index * 2, int(sin((at + index) * TAU * 220.0 / 22050.0) * float(part[0]) * 32767.0))
		at += count
	var sound := AudioStreamWAV.new()
	sound.format = AudioStreamWAV.FORMAT_16_BITS
	sound.mix_rate = 22050
	sound.data = data
	return sound


## The most a sound's levels reach between two times.
func _most(levels: PackedFloat32Array, from: float, to: float) -> float:
	var most := 0.0
	for index: int in range(int(from * WasdVoice.RATE), mini(int(to * WasdVoice.RATE), levels.size())):
		most = maxf(most, levels[index])
	return most


## What is wrong with the levels read from a file of the made-up voice; empty when they are as the voice is.
func _misread(file: String) -> String:
	var voice := load("res://wasd_smoke/" + file) as AudioStream
	if voice == null or not WasdVoice.reads(voice):
		return "%s cannot be read" % [file]
	var levels := WasdVoice.levels(voice)
	if levels.size() < 115 or levels.size() > 130:
		return "%s gave %d levels for 2.4 s" % [file, levels.size()]
	var rests := [_most(levels, 0.0, 0.3), _most(levels, 1.12, 1.32), _most(levels, 2.14, 2.3)]
	var loud := _most(levels, 0.45, 0.95)
	var soft := _most(levels, 1.45, 1.95)
	if rests != [0.0, 0.0, 0.0] or loud < 0.9 or soft < 0.25 or soft > 0.7:
		return "%s reads as rests %s, loud syllables %.2f, soft syllables %.2f" % [file, rests, loud, soft]
	return ""


## Tells a face to blink and returns how far both lids shut. A blink is shut for a twentieth of a second, which one
## slow frame can hide, so it is told again, up to three times in all, until the lids were seen shut.
func _blink(face: WasdFace3D, bones: Skeleton3D, left: String, right: String) -> float:
	var shut := [0.0]
	var watch := func() -> bool:
		shut[0] = maxf(shut[0], minf(_value(bones, left), _value(bones, right)))
		return false
	for attempt: int in 3:
		if shut[0] < 0.9:
			face.blink()
			await _until(watch, 0.4)
	return shut[0]


## The least and the most a blend shape's value is over some seconds.
func _span(bones: Skeleton3D, shape: String, seconds: float) -> Array:
	var span := [1.0, 0.0]
	var watch := func() -> bool:
		span[0] = minf(span[0], _value(bones, shape))
		span[1] = maxf(span[1], _value(bones, shape))
		return false
	await _until(watch, seconds)
	return span


func _center_pixel() -> Color:
	for _frame: int in 3:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	return image.get_pixel(image.get_width() / 2, image.get_height() / 2)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.0, 0.0, 0.6)
	add_child(world)
	var camera := Camera3D.new()
	camera.position = Vector3(0, 1.6, 1.0)
	add_child(camera)

	# 1. What a face fits.
	var bones := _model(SHAPES)
	var only_eyes := _model([])
	var only_shapes := _model(["eyeBlinkLeft", "eyeBlinkRight", "jawOpen"], false)
	var plain := _model(["cheek_puff"], false)
	var fits := [WasdFace3D.fits(bones.get_parent()), WasdFace3D.fits(only_eyes), WasdFace3D.fits(only_shapes.get_parent()), WasdFace3D.fits(plain.get_parent()), WasdFace3D.fits(null)]
	if fits != [true, true, true, false, false] or WasdFace3D.add_to(plain.get_parent()) != null:
		return _fail("fits() is %s for a face, eyes alone, shapes alone, neither, and nothing" % [fits])
	for other: Skeleton3D in [only_eyes, plain]:
		other.get_parent().queue_free()

	# 2. The parts it finds, and blinking by itself.
	var face := WasdFace3D.new()
	face.liveliness = 0.0
	face.blink_every = 1.0
	var blinks := [0]
	face.blinked.connect(func() -> void: blinks[0] += 1)
	bones.add_child(face)
	var parts := [face.has("blink"), face.has("mouth"), face.has("eyes"), face.has("head"), face.has("ears")]
	if parts != [true, true, true, true, false] or Array(face.shapes()) != SHAPES:
		return _fail("a face with everything has %s and the shapes %s" % [parts, face.shapes()])
	if not await _until(func() -> bool: return blinks[0] >= 2, 6.0):
		return _fail("a face that blinks about once a second blinked %d times in 6 s" % [blinks[0]])
	face.blinking = false
	await _wait(0.4)

	# 3. A blink when told: both lids shut and open again.
	blinks[0] = 0
	var shut := await _blink(face, bones, "blink_l", "blink_r")
	var told: int = blinks[0]
	if shut < 0.9 or told < 1 or told > 3 or _value(bones, "blink_l") > 0.0 or _value(bones, "blink_r") > 0.0:
		return _fail("a blink shut the lids to %.2f, told of itself %d times, and left them at %.2f" % [shut, told, _value(bones, "blink_l")])
	await _wait(1.2)
	if blinks[0] != told:
		return _fail("a face that may not blink by itself blinked")

	# 4. Looking: 40 degrees to the left and 20 up, the head takes its share, more of the way up than of the way
	# to the side, and the eyes the rest.
	var target := Node3D.new()
	add_child(target)
	target.position = _place(40.0, 20.0)
	face.look_target = target
	if not await _until(func() -> bool: return (_turn(bones, "LeftEye") - Vector2(40, 20)).length() < 3.5 and (_turn(bones, "Head") - Vector2(24, 16.8)).length() < 2.5, 4.0):
		return _fail("looking 40 degrees left and 20 up turned the head by %s and the eyes to %s and %s" % [_turn(bones, "Head"), _turn(bones, "LeftEye"), _turn(bones, "RightEye")])
	# The neck takes a third of the head's turn, and each eye looks at the target from where it is.
	if (_turn(bones, "Neck") - Vector2(24, 16.8) * 0.35).length() > 1.5 or _turn(bones, "RightEye").x <= _turn(bones, "LeftEye").x:
		return _fail("the neck turned by %s, and the eyes look to %s and %s" % [_turn(bones, "Neck"), _turn(bones, "LeftEye"), _turn(bones, "RightEye")])
	# With no share for the head the eyes turn alone, as far as they reach.
	face.head_share = 0.0
	target.position = _place(-40.0, 0.0)
	if not await _until(func() -> bool: return _turn(bones, "Head").length() < 1.0 and (_turn(bones, "RightEye") - Vector2(-28, 0)).length() < 2.0, 4.0):
		return _fail("with no share the head turned by %s and the eyes to %s" % [_turn(bones, "Head"), _turn(bones, "RightEye")])
	# What is behind the head is not looked at.
	face.head_share = 0.6
	target.position = Vector3(0.3, 1.67, -3.0)
	if not await _until(func() -> bool: return _turn(bones, "Head").length() < 1.0 and _turn(bones, "LeftEye").length() < 1.0, 4.0):
		return _fail("with the target behind it the head is turned by %s and the eyes by %s" % [_turn(bones, "Head"), _turn(bones, "LeftEye")])
	# A point of the world, and ahead again, where resting eyes wander a little.
	face.look_target = null
	face.look_at_point(_place(-30.0, -10.0))
	if not await _until(func() -> bool: return (_turn(bones, "LeftEye") - Vector2(-30, -10)).length() < 3.5, 4.0):
		return _fail("looking at a point 30 degrees right and 10 down turned the eyes to %s" % [_turn(bones, "LeftEye")])
	face.look_ahead()
	if not await _until(func() -> bool: return _turn(bones, "Head").length() < 1.0 and _turn(bones, "LeftEye").length() < 8.0, 4.0):
		return _fail("looking ahead again left the head at %s and the eyes at %s" % [_turn(bones, "Head"), _turn(bones, "LeftEye")])
	# The face's node sits between the eyes and faces as the head does.
	if face.global_position.distance_to(Vector3(0, 1.67, 0.08)) > 0.02 or face.global_basis.z.angle_to(Vector3.BACK) > 0.03:
		return _fail("the face's node is at %s and faces %s" % [face.global_position, face.global_basis.z])
	var other_face := WasdFace3D.add_to(only_shapes.get_parent())
	if other_face == null or other_face.get_parent() != only_shapes or WasdFace3D.add_to(only_shapes) != other_face:
		return _fail("add_to() did not put one face under the model's skeleton")
	other_face.blinking = false
	other_face.liveliness = 0.0
	# A WasdCharacter3D, of the wasd-character add-on, gets a face by itself when its model has one to move, and is
	# looked at in it, wherever its origin is; one whose model has none is looked at where its eyes would be.
	var characters: Array[WasdCharacter3D] = []
	for with_face: bool in [true, false]:
		var model := Node3D.new()
		if with_face:
			_model(SHAPES, true, false, model)
		var character := WasdCharacter3D.new()
		character.controlled = false
		character.add_child(model)
		character.position = _place(30.0 if with_face else -25.0, 0.0) * Vector3(1, 0, 1)
		add_child(character)
		# Nothing is under its feet here.
		character.set_physics_process(false)
		characters.append(character)
	var given := characters[0].face as WasdFace3D
	if given == null or not given.has("blink") or WasdFace3D.add_to(characters[0]) != given or characters[1].face != null:
		return _fail("a WasdCharacter3D with a face to move has the face %s, and one without has %s" % [characters[0].face, characters[1].face])
	given.blinking = false
	given.liveliness = 0.0
	face.look_target = characters[0]
	if not await _until(func() -> bool: return (_turn(bones, "LeftEye") - Vector2(30, 0)).length() < 3.0, 4.0):
		return _fail("looking at a character with a face 30 degrees to the left turned the eyes to %s" % [_turn(bones, "LeftEye")])
	face.look_target = characters[1]
	if not await _until(func() -> bool: return (_turn(bones, "LeftEye") - Vector2(-25, -1)).length() < 3.0, 4.0):
		return _fail("looking at a character without a face 25 degrees to the right turned the eyes to %s" % [_turn(bones, "LeftEye")])
	face.look_ahead()
	for character: WasdCharacter3D in characters:
		character.queue_free()

	# 5. The mouth follows a voice: loud from 0.3 s, a rest, soft from 1.2 s.
	var speech := _sound([[0.0, 0.3], [0.7, 0.5], [0.0, 0.4], [0.14, 0.5], [0.0, 0.3]])
	var player := AudioStreamPlayer.new()
	player.stream = speech
	player.volume_db = -80.0
	add_child(player)
	face.speak(player)
	player.play()
	var opened := {"loud": 0.0, "rest": 1.0, "soft": 0.0}
	var listen := func() -> bool:
		var at := player.get_playback_position()
		var wide := _value(bones, "mouth_open")
		if at > 0.45 and at < 0.75:
			opened["loud"] = maxf(opened["loud"], wide)
		elif at > 1.0 and at < 1.15:
			opened["rest"] = minf(opened["rest"], wide)
		elif at > 1.35 and at < 1.65:
			opened["soft"] = maxf(opened["soft"], wide)
		return not player.playing
	await _until(listen, 4.0)
	if opened["loud"] < 0.7 or opened["rest"] > 0.08 or opened["soft"] < 0.2 or opened["soft"] > 0.6 or opened["soft"] > opened["loud"] - 0.2:
		return _fail("the mouth opened to %s with a voice that is loud, rests, and is soft" % [opened])
	if not await _until(func() -> bool: return _value(bones, "mouth_open") == 0.0, 1.5):
		return _fail("the mouth stayed open at %.2f after the voice" % [_value(bones, "mouth_open")])

	# 6. WasdVoice reads the same voice from each kind of file, and tells what it cannot read.
	for file: String in ["voice.wav", "voice.mp3", "voice.ogg"]:
		var wrong := _misread(file)
		if wrong != "":
			return _fail(wrong)
	if (load("res://wasd_smoke/voice.wav") as AudioStreamWAV).format != AudioStreamWAV.FORMAT_QOA:
		return _fail("voice.wav was not imported as Quite OK Audio, the default")
	var unread := AudioStreamGenerator.new()
	if WasdVoice.reads(unread) or WasdVoice.reads(null) or not WasdVoice.levels(unread).is_empty() or WasdVoice.level_at(unread, 0.5) != 0.0:
		return _fail("a generator's sound, which has no length, counts as read")
	# A sound asked about in its middle first is read up to there; a time past the end of a loop starts over.
	var fresh := _sound([[0.0, 0.3], [0.7, 0.5], [0.0, 0.4], [0.14, 0.5], [0.0, 0.3]])
	var middle := WasdVoice.level_at(fresh, 1.5)
	var around := WasdVoice.level_at(fresh, 2.0 + 0.6)
	if middle < 0.25 or middle > 0.7 or around < 0.9 or WasdVoice.level_at(fresh, 1.05) != 0.0:
		return _fail("a sound read from its middle gives %.2f there, and %.2f a loop later in its loud part" % [middle, around])
	if _most(WasdVoice.levels(_sound([[0.0, 1.0]])), 0.0, 1.0) != 0.0:
		return _fail("silence reads as sound")

	# 7. A sound without a length, and a line of text, move the mouth by rhythm; the game may hold it open.
	player.stream = unread
	player.play()
	var span := await _span(bones, "mouth_open", 2.0)
	player.stop()
	face.speak(null)
	if span[1] < 0.4 or span[1] - span[0] < 0.3:
		return _fail("with a sound that cannot be read the mouth moved between %s" % [span])
	await _until(func() -> bool: return _value(bones, "mouth_open") == 0.0, 1.5)
	face.talk(1.0)
	span = await _span(bones, "mouth_open", 0.9)
	if span[1] < 0.4 or not await _until(func() -> bool: return _value(bones, "mouth_open") == 0.0, 1.5):
		return _fail("talking for a second moved the mouth to %.2f and left it at %.2f" % [span[1], _value(bones, "mouth_open")])
	face.mouth = 0.6
	if not await _until(func() -> bool: return absf(_value(bones, "mouth_open") - 0.6) < 0.02, 1.5):
		return _fail("a mouth held at 0.6 is at %.2f" % [_value(bones, "mouth_open")])
	face.mouth = 0.0

	# 8. Expressions, by the model's own names and by the common ones on a model that names its shapes as ARKit does.
	if not face.express("smile", 1.0, 0.1) or face.express("wink_of_no_model", 1.0):
		return _fail("express() took a shape the model lacks, or not one it has")
	if not await _until(func() -> bool: return _value(bones, "smile") > 0.98, 1.5):
		return _fail("a smile came to %.2f" % [_value(bones, "smile")])
	var other_parts :=[other_face.has("blink"), other_face.has("mouth"), other_face.has("eyes"), other_face.has("head")]
	if other_parts != [true, true, false, true] or not other_face.express("mouth_open", 0.5, 0.05):
		return _fail("a face with ARKit's shape names has %s" % [other_parts])
	var winked := await _blink(other_face, only_shapes, "eyeBlinkLeft", "eyeBlinkRight")
	if winked < 0.9 or absf(_value(only_shapes, "jawOpen") - 0.5) > 0.02:
		return _fail("ARKit's names: the lids shut to %.2f and the jaw opened to %.2f" % [winked, _value(only_shapes, "jawOpen")])
	# VRM's names, on a mesh beside its skeleton, with another model under the same parent: each face moves its own.
	var pair := Node3D.new()
	add_child(pair)
	var first := _model(["Fcl_EYE_Close", "Fcl_MTH_A"], false, true, pair)
	var second := _model(["Fcl_EYE_Close", "Fcl_MTH_A"], false, true, pair)
	var first_face := WasdFace3D.new()
	first_face.blinking = false
	first_face.liveliness = 0.0
	first.add_child(first_face)
	if not first_face.has("blink") or not first_face.has("mouth") or not first_face.express("mouth_open", 1.0, 0.05):
		return _fail("a face beside its skeleton with VRM's shape names has blink %s and mouth %s" % [first_face.has("blink"), first_face.has("mouth")])
	if not await _until(func() -> bool: return _value(first, "Fcl_MTH_A") > 0.98, 1.5) or _value(second, "Fcl_MTH_A") != 0.0:
		return _fail("one model's face opened its mouth to %.2f and its neighbor's to %.2f" % [_value(first, "Fcl_MTH_A"), _value(second, "Fcl_MTH_A")])
	pair.queue_free()
	only_shapes.get_parent().queue_free()

	# 9. A face switched off rests, and comes back.
	face.active = false
	if not await _until(func() -> bool: return _value(bones, "smile") == 0.0, 1.0):
		return _fail("a face switched off still smiles at %.2f" % [_value(bones, "smile")])
	face.active = true
	if not await _until(func() -> bool: return _value(bones, "smile") > 0.98, 1.0):
		return _fail("a face switched on again smiles at %.2f" % [_value(bones, "smile")])
	face.express("smile", 0.0, 0.05)

	# 10. What the face sets is what is drawn: the stand-in's mouth shape moves its square out of the view's middle.
	var shut_view := await _center_pixel()
	face.mouth = 1.0
	await _until(func() -> bool: return _value(bones, "mouth_open") > 0.98, 1.5)
	var open_view := await _center_pixel()
	face.mouth = 0.0
	if shut_view.r < 0.5 or shut_view.b > 0.2 or open_view.b < 0.4 or open_view.r > 0.1:
		return _fail("the view's middle is %s with the mouth shut and %s with it open" % [shut_view, open_view])

	# 11. Feelings by name: the model has a smile and no anger. A feeling lets the others go, so the one it lacks
	# is asked for first.
	if Array(face.feelings()) != ["smile"] or face.feel("angry") or not face.feel("smile", 1.0, 0.1):
		return _fail("the face knows the feelings %s, and feel() took one the model lacks or not one it has" % [face.feelings()])
	if not await _until(func() -> bool: return _value(bones, "smile") > 0.98, 1.5) or not face.feel("smile", 0.0, 0.1):
		return _fail("a smile that is felt came to %.2f" % [_value(bones, "smile")])
	await _until(func() -> bool: return _value(bones, "smile") == 0.0, 1.5)

	# 12. What a face does unasked, at full liveliness. Eyes that look at a still thing glance about it.
	face.liveliness = 1.0
	target.position = _place(0.0, 0.0)
	face.look_target = target
	await _wait(0.5)
	var low := _turn(bones, "LeftEye")
	var high := low
	var roam := [low, high]
	var watch := func() -> bool:
		var at := _turn(bones, "LeftEye")
		roam[0] = Vector2(minf((roam[0] as Vector2).x, at.x), minf((roam[0] as Vector2).y, at.y))
		roam[1] = Vector2(maxf((roam[1] as Vector2).x, at.x), maxf((roam[1] as Vector2).y, at.y))
		return ((roam[1] as Vector2) - (roam[0] as Vector2)).length() > 1.0
	if not await _until(watch, 10.0):
		return _fail("eyes that looked at a still target for 10 s moved by %s degrees" % [(roam[1] as Vector2) - (roam[0] as Vector2)])
	# Lids follow eyes that look down, here by the eyes alone.
	face.head_share = 0.0
	face.look_target = null
	face.look_at_point(_place(0.0, -25.0))
	if not await _until(func() -> bool: return _value(bones, "blink_l") > 0.12 and _value(bones, "blink_l") < 0.5, 3.0):
		return _fail("with the eyes turned down by %s the lids are shut by %.2f" % [_turn(bones, "LeftEye"), _value(bones, "blink_l")])
	face.look_ahead()
	face.head_share = 0.6
	# The syllables of speech take shapes of their own: some widen the mouth and some narrow it.
	var shaped := [0.0]
	face.talk(4.0)
	var hear := func() -> bool:
		shaped[0] = maxf(shaped[0], maxf(_value(bones, "mouth_wide"), _value(bones, "mouth_narrow")))
		return shaped[0] > 0.05
	if not await _until(hear, 4.0):
		return _fail("four seconds of speech shaped no syllable: wide and narrow stayed under %.2f" % [shaped[0]])
	face.talk(0.0)

	# 13. A human of the mpfb guide's wasd_mpfb, told by the name of its eyes' material, is dressed by WASD Materials
	# as it gets its face, unless the game keeps its materials.
	var kept := []
	for dress: bool in [false, true]:
		var human := Node3D.new()
		var skeleton := _model(SHAPES, true, false, human)
		var ball := MeshInstance3D.new()
		ball.name = "Human_high-poly"
		ball.mesh = SphereMesh.new()
		var stock := StandardMaterial3D.new()
		stock.resource_name = "Human.eyes_brown"
		ball.mesh.surface_set_material(0, stock)
		skeleton.add_child(ball)
		add_child(human)
		human.position = Vector3(0, -40, 0)
		WasdFace3D.dress_humans = dress
		if WasdFace3D.add_to(human) == null:
			return _fail("a human with eye bones got no face")
		kept.append(ball.get_active_material(0) is ShaderMaterial)
		human.queue_free()
	WasdFace3D.dress_humans = true
	if kept != [false, true]:
		return _fail("told not to dress a human and then to, its eyes have a shader: %s" % [kept])

	# 14. The face finds the materials it drives by what their shaders take. Skin that takes a face's folds has them
	# pressed in as the face smiles, and loses them as the smile goes; an eye that takes the head's up direction
	# gets it, so that the lids' shade stays under the lids of a head that leans.
	var folded := Node3D.new()
	var folded_bones := _model(SHAPES, true, false, folded)
	var surfaces := load("res://addons/wasd_materials/surface.gd") as GDScript
	var cheek := MeshInstance3D.new()
	cheek.mesh = SphereMesh.new()
	var skin := surfaces.call(&"skin", null, {"folds": true}) as ShaderMaterial
	cheek.material_override = skin
	folded_bones.add_child(cheek)
	var pupil := MeshInstance3D.new()
	pupil.mesh = SphereMesh.new()
	var wet := surfaces.call(&"eye", null) as ShaderMaterial
	pupil.material_override = wet
	folded_bones.add_child(pupil)
	add_child(folded)
	folded.position = Vector3(0, -80, 0)
	if skin.get_shader_parameter(&"folds") != null or wet.get_shader_parameter(&"head_up") != null:
		return _fail("a new skin and a new eye already have what a face is to give them")
	var folded_face := WasdFace3D.add_to(folded)
	folded_face.liveliness = 0.0
	folded_face.feel("smile", 1.0, 0.1)
	if not await _until(func() -> bool: return skin.get_shader_parameter(&"folds") is Vector2 and (skin.get_shader_parameter(&"folds") as Vector2).x > 0.98, 1.5):
		return _fail("a smile pressed the skin's folds in by %s" % [skin.get_shader_parameter(&"folds")])
	folded_face.feel("smile", 0.0, 0.1)
	if not await _until(func() -> bool: return (skin.get_shader_parameter(&"folds") as Vector2).x < 0.02, 1.5):
		return _fail("a smile that went left the skin's folds at %s" % [skin.get_shader_parameter(&"folds")])
	var lean: Variant = wet.get_shader_parameter(&"head_up")
	if not (lean is Vector3) or absf((lean as Vector3).length() - 1.0) > 0.01 or (lean as Vector3).y < 0.7:
		return _fail("the eye was told that the head's up is %s" % [lean])
	folded.queue_free()

	print("SMOKE_PASS ", ID)
	get_tree().quit()
