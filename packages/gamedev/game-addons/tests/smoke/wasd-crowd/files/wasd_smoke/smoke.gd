extends Node3D
## WASD Crowd smoke test (render run on the Compatibility renderer): a pole of two bones that waves is baked; the baked
## textures hold the pole's tip where the skeleton puts it at each frame of each clip, and so do those of a pole that
## is not in the scene tree and those that bake_crowd.gd saved from the pole's scene file in the prepare step; the
## data saves to a file and loads again; a crowd of two hundred shows red poles that wave, each in its own phase, and
## keeps them when its capacity changes; members take other clips, tints only on named surfaces, and leave; a full
## crowd or an unknown clip is refused, a lower capacity drops the members it no longer holds, and a member refused
## for its clip after clear() brings back none that were there. Then a flock of each kind, birds, fish, and
## butterflies, shows creatures that move, in one draw call, takes another count, and flies apart from what startles
## it.

const ID := "wasd-crowd"


func _ready() -> void:
	get_tree().create_timer(120.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frame(file: String) -> Image:
	for _i: int in 4:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


func _red(image: Image) -> int:
	var found := 0
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel := image.get_pixel(x, y)
			if pixel.r > 0.5 and pixel.g < 0.3 and pixel.b < 0.3:
				found += 1
	return found


## Red samples in the middle third of the picture.
func _red_near_middle(image: Image) -> int:
	var found := 0
	for y: int in range(image.get_height() / 3, image.get_height() * 2 / 3, 2):
		for x: int in range(image.get_width() / 3, image.get_width() * 2 / 3, 2):
			var pixel := image.get_pixel(x, y)
			if pixel.r > 0.5 and pixel.g < 0.3 and pixel.b < 0.3:
				found += 1
	return found


## A pole two meters high of eight four-sided rings, the lower half on the bone "Root" and the upper on "Tip", with
## two clips: "Wave" swings the upper half to one side and back, "Still" does not move.
func _pole() -> Node3D:
	var model := Node3D.new()
	model.name = "Pole"
	var skeleton := Skeleton3D.new()
	skeleton.name = "Skeleton3D"
	skeleton.add_bone("Root")
	skeleton.add_bone("Tip")
	skeleton.set_bone_parent(1, 0)
	skeleton.set_bone_rest(1, Transform3D(Basis.IDENTITY, Vector3(0, 1, 0)))
	skeleton.reset_bone_poses()
	model.add_child(skeleton)
	var vertices := PackedVector3Array()
	var normals := PackedVector3Array()
	var uvs := PackedVector2Array()
	var bones := PackedInt32Array()
	var weights := PackedFloat32Array()
	var indices := PackedInt32Array()
	for ring: int in 9:
		var height := ring * 0.25
		for side: int in 4:
			var angle := side * TAU / 4.0
			vertices.append(Vector3(cos(angle) * 0.1, height, sin(angle) * 0.1))
			normals.append(Vector3(cos(angle), 0, sin(angle)))
			uvs.append(Vector2(side / 4.0, height / 2.0))
			bones.append_array([0 if height < 1.0 else 1, 0, 0, 0])
			weights.append_array([1.0, 0.0, 0.0, 0.0])
	for ring: int in 8:
		for side: int in 4:
			var a := ring * 4 + side
			var b := ring * 4 + (side + 1) % 4
			indices.append_array([a, a + 4, b, b, a + 4, b + 4])
	var arrays := []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_NORMAL] = normals
	arrays[Mesh.ARRAY_TEX_UV] = uvs
	arrays[Mesh.ARRAY_BONES] = bones
	arrays[Mesh.ARRAY_WEIGHTS] = weights
	arrays[Mesh.ARRAY_INDEX] = indices
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	var paint := StandardMaterial3D.new()
	paint.albedo_color = Color(1, 0, 0)
	paint.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mesh.surface_set_material(0, paint)
	var body := MeshInstance3D.new()
	body.name = "Body"
	body.mesh = mesh
	var skin := Skin.new()
	skin.add_bind(0, Transform3D.IDENTITY)
	skin.add_bind(1, Transform3D(Basis.IDENTITY, Vector3(0, -1, 0)))
	body.skin = skin
	skeleton.add_child(body)
	body.skeleton = NodePath("..")
	var player := AnimationPlayer.new()
	var library := AnimationLibrary.new()
	var wave := Animation.new()
	wave.length = 1.0
	wave.loop_mode = Animation.LOOP_LINEAR
	var track := wave.add_track(Animation.TYPE_ROTATION_3D)
	wave.track_set_path(track, NodePath("Skeleton3D:Tip"))
	wave.rotation_track_insert_key(track, 0.0, Quaternion.IDENTITY)
	wave.rotation_track_insert_key(track, 0.5, Quaternion(Vector3.FORWARD, PI * 0.5))
	wave.rotation_track_insert_key(track, 1.0, Quaternion.IDENTITY)
	library.add_animation(&"Wave", wave)
	var still := Animation.new()
	still.length = 0.5
	still.loop_mode = Animation.LOOP_LINEAR
	var held := still.add_track(Animation.TYPE_ROTATION_3D)
	still.track_set_path(held, NodePath("Skeleton3D:Tip"))
	still.rotation_track_insert_key(held, 0.0, Quaternion.IDENTITY)
	library.add_animation(&"Still", still)
	player.add_animation_library(&"moves", library)
	model.add_child(player)
	player.root_node = player.get_path_to(model)
	return model


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.1, 0.3, 0.8)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color.WHITE
	add_child(world)
	var camera := Camera3D.new()
	camera.projection = Camera3D.PROJECTION_ORTHOGONAL
	camera.size = 24.0
	camera.position = Vector3(0, 1, 30)
	add_child(camera)

	var pole := _pole()
	add_child(pole)
	var data := WasdCrowdBaker.bake(pole, ["moves/Wave", "moves/Still", "moves/Missing"], 10.0)
	pole.queue_free()
	if data == null:
		return _fail("the pole did not bake")
	if data.vertices != 36 or data.width != 36 or data.rows != 1 or data.mesh.get_surface_count() != 1:
		return _fail("the baked pole has %d vertices in textures %d wide with %d rows, and %d surfaces" % [data.vertices, data.width, data.rows, data.mesh.get_surface_count()])
	if data.names() != PackedStringArray(["Wave", "Still"]) or data.clips["Wave"]["frames"] != 10 or data.clips["Still"]["start"] != 10 or data.clips["Still"]["frames"] != 5:
		return _fail("the baked clips are %s" % [data.clips])
	if data.positions.get_height() != 15 or data.positions.get_image().get_format() != Image.FORMAT_RGBAH:
		return _fail("the positions are %d rows of format %d" % [data.positions.get_height(), data.positions.get_image().get_format()])
	# The top ring's first vertex stands at (0.1, 2, 0) at rest, and with the upper half turned a quarter turn about
	# -Z, which is where the wave is at its middle, at (1, 0.9, 0): one meter to the side of the joint.
	var places := data.positions.get_image()
	var at_rest := places.get_pixel(32, 0)
	var swung := places.get_pixel(32, 5)
	var still_place := places.get_pixel(32, 12)
	if Vector3(at_rest.r, at_rest.g, at_rest.b).distance_to(Vector3(0.1, 2, 0)) > 0.01:
		return _fail("at rest the tip is baked at %s" % [at_rest])
	if Vector3(swung.r, swung.g, swung.b).distance_to(Vector3(1.0, 0.9, 0)) > 0.02:
		return _fail("in mid-wave the tip is baked at %s" % [swung])
	if Vector3(still_place.r, still_place.g, still_place.b).distance_to(Vector3(0.1, 2, 0)) > 0.01:
		return _fail("in the still clip the tip is baked at %s" % [still_place])
	if data.bounds.size.x < 1.0 or data.bounds.size.y < 1.9:
		return _fail("the bounds are %s" % [data.bounds])
	# A pole that is not in the scene tree, as a game bakes an instance it made only for that, bakes the same.
	var loose := _pole()
	var outside := WasdCrowdBaker.bake(loose, ["moves/Wave", "moves/Still"], 10.0)
	loose.free()
	if outside == null:
		return _fail("the pole outside the scene tree did not bake")
	var loose_swung := outside.positions.get_image().get_pixel(32, 5)
	if (Vector3(loose_swung.r, loose_swung.g, loose_swung.b).distance_to(Vector3(1.0, 0.9, 0)) > 0.02
			or outside.positions.get_image().get_data() != places.get_data() or outside.normals.get_image().get_data() != data.normals.get_image().get_data()):
		return _fail("outside the scene tree the tip in mid-wave is baked at %s, and the textures differ from the pole's in the tree" % [loose_swung])
	# bake_crowd.gd, which the smoke test's prepare step ran on the pole's scene file as godot_script runs it, before
	# any scene tree runs, baked the wave too.
	var tool_baked := ResourceLoader.load("res://wasd_smoke/pole_tool.res", "", ResourceLoader.CACHE_MODE_IGNORE) as WasdCrowdData
	if tool_baked == null or tool_baked.names() != PackedStringArray(["Wave", "Still"]):
		return _fail("bake_crowd.gd saved %s" % [tool_baked.clips if tool_baked != null else null])
	var tool_rest := tool_baked.positions.get_image().get_pixel(32, 0)
	var tool_swung := tool_baked.positions.get_image().get_pixel(32, 5)
	if Vector3(tool_rest.r, tool_rest.g, tool_rest.b).distance_to(Vector3(0.1, 2, 0)) > 0.01 or Vector3(tool_swung.r, tool_swung.g, tool_swung.b).distance_to(Vector3(1.0, 0.9, 0)) > 0.02:
		return _fail("bake_crowd.gd baked the tip at %s at rest and at %s in mid-wave" % [tool_rest, tool_swung])
	# The data is a file of its own.
	if ResourceSaver.save(data, "res://wasd_smoke/pole.res", ResourceSaver.FLAG_COMPRESS) != OK:
		return _fail("the data did not save")
	var loaded := ResourceLoader.load("res://wasd_smoke/pole.res", "", ResourceLoader.CACHE_MODE_IGNORE) as WasdCrowdData
	if loaded == null or loaded.vertices != 36 or loaded.clips.size() != 2 or loaded.positions == null or loaded.mesh.surface_get_material(0) == null:
		return _fail("the saved data did not load whole")

	# Two hundred poles in rows, all in the still clip: thin upright red lines.
	var crowd := WasdCrowd3D.new()
	crowd.data = loaded
	crowd.capacity = 200
	add_child(crowd)
	for index: int in 200:
		var member := crowd.add(Transform3D(Basis.IDENTITY, Vector3((index % 20 - 9.5) * 1.8, (index / 20 - 5) * 2.2, 0)), "Still")
		if member != index:
			return _fail("member %d got the number %d" % [index, member])
	if crowd.add(Transform3D.IDENTITY, "Still") != -1 or crowd.count() != 200:
		return _fail("a full crowd took another member")
	# More room, and then as much as before, keeps every member where it stands and in its clip.
	var place := crowd.get_member_transform(137)
	crowd.capacity = 260
	if crowd.count() != 200 or crowd.get_member_transform(137) != place or crowd.add(Transform3D.IDENTITY, "Still") != 200:
		return _fail("with room for 260, the crowd counts %d, member 137 stands at %s, not %s" % [crowd.count(), crowd.get_member_transform(137).origin, place.origin])
	crowd.remove(200)
	crowd.capacity = 200
	if crowd.count() != 200 or crowd.add(Transform3D.IDENTITY, "Still") != -1:
		return _fail("back to room for 200, the crowd counts %d or takes another member" % [crowd.count()])
	var standing := _red(await _frame("standing.png"))
	if standing < 1500:
		return _fail("two hundred still poles show %d red samples" % [standing])
	# All in the wave, each in its own phase: the picture changes from one moment to the next.
	for index: int in 200:
		if not crowd.set_member_clip(index, "Wave"):
			return _fail("a member did not take the wave")
	var first := await _frame("wave_1.png")
	await get_tree().create_timer(0.3).timeout
	var second := await _frame("wave_2.png")
	var changed := 0
	for y: int in range(0, first.get_height(), 2):
		for x: int in range(0, first.get_width(), 2):
			if (first.get_pixel(x, y).r > 0.5) != (second.get_pixel(x, y).r > 0.5):
				changed += 1
	if changed < 300:
		return _fail("the waving crowd changed %d samples in 0.3 seconds" % [changed])
	# Tints: on every surface at first, then on none that is named otherwise.
	for index: int in 200:
		crowd.set_member_color(index, Color(0, 0, 0))
	if _red(await _frame("black.png")) > 20:
		return _fail("a black tint left the poles red")
	crowd.tint_only(["nothing"])
	if _red(await _frame("untinted.png")) < 1000:
		return _fail("surfaces that take no tint are still tinted")
	if crowd.surfaces() != PackedStringArray(["Body_0"]):
		return _fail("the surfaces are named %s" % [crowd.surfaces()])
	# Members leave, and their numbers are given out again.
	for index: int in 100:
		crowd.remove(index * 2)
	if crowd.count() != 100:
		return _fail("after a hundred left, the crowd counts %d" % [crowd.count()])
	var fewer := _red(await _frame("fewer.png"))
	if fewer > _red(first) * 0.75:
		return _fail("half the crowd left and %d red samples of %d stayed" % [fewer, _red(first)])
	var again := crowd.add(Transform3D.IDENTITY, "Wave", 2.0, 0.25)
	if again < 0 or again % 2 != 0 or crowd.count() != 101:
		return _fail("a new member got the number %d" % [again])
	if crowd.set_member_clip(again, "NoSuchClip") or crowd.add(Transform3D.IDENTITY, "NoSuchClip") != -1:
		return _fail("an unknown clip was taken")
	# Room for 100 keeps the odd members under 100, of which there are 50, and drops the new one.
	crowd.capacity = 100
	if crowd.count() != 50 or crowd.add(Transform3D.IDENTITY, "Wave") != 98:
		return _fail("with room for 100, the crowd counts %d" % [crowd.count()])
	crowd.clear()
	# A member refused for its clip takes no number, so no slot that a member left shows again.
	if crowd.add(Transform3D.IDENTITY, "NoSuchClip") != -1 or crowd.count() != 0 or crowd.multimesh.visible_instance_count != 0:
		return _fail("after clear() and a member refused for its clip, the crowd counts %d and draws %d slots" % [crowd.count(), crowd.multimesh.visible_instance_count])
	if _red(await _frame("cleared.png")) > 20:
		return _fail("clear() left members")
	crowd.queue_free()

	# Flocks: 150 red creatures within four meters of the middle of the picture.
	if WasdFlock3D.kinds() != PackedStringArray(["birds", "fish", "butterflies"]):
		return _fail("the kinds of flock are %s" % [WasdFlock3D.kinds()])
	for kind: String in WasdFlock3D.kinds():
		var flock := WasdFlock3D.new()
		flock.kind = kind
		flock.count = 150
		flock.radius = 4.0
		flock.height = 4.0
		flock.size = 1.0
		flock.color = Color(1, 0, 0)
		flock.variety = 0.0
		# The camera stands 30 m off, further than butterflies are drawn by themselves.
		flock.sight = 0.0
		flock.position.y = 1.0
		add_child(flock)
		if flock.multimesh.instance_count != 150:
			return _fail("a flock of 150 %s has %d members" % [kind, flock.multimesh.instance_count])
		var before := await _frame("%s_1.png" % [kind])
		var calls := RenderingServer.get_rendering_info(RenderingServer.RENDERING_INFO_TOTAL_DRAW_CALLS_IN_FRAME)
		# The camera looks along the ground, so birds and butterflies show the thin side of their wings.
		if _red(before) < 60:
			return _fail("150 %s show %d red samples" % [kind, _red(before)])
		if calls > 4:
			return _fail("a flock of %s took %d draw calls" % [kind, calls])
		await get_tree().create_timer(0.3).timeout
		var after := await _frame("%s_2.png" % [kind])
		var moved := 0
		for y: int in range(0, before.get_height(), 2):
			for x: int in range(0, before.get_width(), 2):
				if (before.get_pixel(x, y).r > 0.5) != (after.get_pixel(x, y).r > 0.5):
					moved += 1
		if moved < 60:
			return _fail("the %s changed %d samples in 0.3 seconds" % [kind, moved])
		if kind == "birds":
			# Startled at their middle, most of the birds leave the middle of the picture within a second.
			var near := _red_near_middle(after)
			flock.scare(flock.global_position, 3.0)
			await get_tree().create_timer(1.0).timeout
			var scattered := _red_near_middle(await _frame("birds_scared.png"))
			if near < 40 or scattered > near * 0.7:
				return _fail("startled birds: %d red samples near the middle became %d" % [near, scattered])
			flock.count = 20
			if flock.multimesh.instance_count != 20:
				return _fail("a flock told to count 20 has %d members" % [flock.multimesh.instance_count])
		flock.kind = "nothing"
		if flock.kind != kind:
			return _fail("a flock took the unknown kind \"nothing\"")
		flock.queue_free()
		await get_tree().process_frame
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
