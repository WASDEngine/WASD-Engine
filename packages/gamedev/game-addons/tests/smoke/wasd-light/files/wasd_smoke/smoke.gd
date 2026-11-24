extends Node3D
## WASD Light smoke test (render run on the Compatibility renderer, the one every Web build uses): a halo glows
## round its lamp and hides behind a wall; a shaft brightens the air along a spotlight; a fog bank veils what
## stands in it by how much fog lies before it and nothing outside it, a lamp's halo before it included, and from
## inside it leaves a halo near the camera unveiled; a bank flattened to nothing leaves no error; dust shows; a new
## wind moves neither the dust nor a fog bank's clouds at once, and both get their own drift back when the wind goes;
## a flicker moves its light and the halo with it, and lets go of a halo or light that is freed; a shadow card throws
## shade that is part light, part dark; and stood upright it is striped, as blinds and a grating are.

const ID := "wasd-light"

var camera: Camera3D


func _ready() -> void:
	get_tree().create_timer(70.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frame(file: String, frames := 8) -> Image:
	for _i: int in frames:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


## The mean brightness of a square of the picture round a point of the world.
func _at(image: Image, place: Vector3, half := 4) -> float:
	var middle := Vector2i(camera.unproject_position(place) * Vector2(image.get_size()) / get_viewport().get_visible_rect().size)
	var total := 0.0
	var count := 0
	for y: int in range(middle.y - half, middle.y + half + 1):
		for x: int in range(middle.x - half, middle.x + half + 1):
			total += image.get_pixel(clampi(x, 0, image.get_width() - 1), clampi(y, 0, image.get_height() - 1)).get_luminance()
			count += 1
	return total / count


## The mean color of a square of the picture round a point of the world.
func _color_at(image: Image, place: Vector3, half := 2) -> Color:
	var middle := Vector2i(camera.unproject_position(place) * Vector2(image.get_size()) / get_viewport().get_visible_rect().size)
	var total := Color(0, 0, 0, 0)
	for y: int in range(middle.y - half, middle.y + half + 1):
		for x: int in range(middle.x - half, middle.x + half + 1):
			total += image.get_pixel(clampi(x, 0, image.get_width() - 1), clampi(y, 0, image.get_height() - 1))
	return total / float((half * 2 + 1) * (half * 2 + 1))


func _box(size: Vector3, at: Vector3, color: Color) -> MeshInstance3D:
	var item := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = 1.0
	material.metallic_specular = 0.0
	mesh.material = material
	item.mesh = mesh
	item.position = at
	add_child(item)
	return item


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.02, 0.02, 0.03)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color(0.25, 0.25, 0.25)
	add_child(world)
	camera = Camera3D.new()
	camera.position = Vector3(0, 2, 10)
	add_child(camera)
	_box(Vector3(40, 0.2, 40), Vector3(0, -0.1, 0), Color(0.4, 0.4, 0.4))
	var before := await _frame("before.png")

	# 1. A halo glows where it is and falls off outward; a wall before it hides it.
	var halo := WasdHalo3D.new()
	halo.position = Vector3(-3, 3, 0)
	halo.size = 2.0
	add_child(halo)
	var glowing := await _frame("halo.png")
	var middle := _at(glowing, halo.position, 2)
	var halfway := _at(glowing, halo.position + Vector3(0.5, 0, 0), 2)
	var outside := _at(glowing, halo.position + Vector3(1.6, 0, 0), 2)
	if middle < 0.6 or halfway > middle - 0.1 or halfway < outside + 0.02 or absf(outside - _at(before, halo.position + Vector3(1.6, 0, 0), 2)) > 0.02:
		return _fail("the halo shows %f in its middle, %f halfway out, %f outside" % [middle, halfway, outside])
	var wall := _box(Vector3(3, 3, 0.2), Vector3(-3, 3, 2), Color(0.4, 0.4, 0.4))
	var hidden := await _frame("halo_hidden.png")
	if _at(hidden, halo.position, 2) > 0.5:
		return _fail("the halo shines through a wall: %f" % [_at(hidden, halo.position, 2)])
	wall.queue_free()
	halo.energy = 0.0
	var off := await _frame("halo_off.png")
	if _at(off, halo.position, 2) > _at(before, halo.position, 2) + 0.02:
		return _fail("a halo of energy 0 still shows")

	# 2. A shaft brightens the air along a spotlight's cone, most near the lamp, and takes the lamp's place and reach.
	var spot := SpotLight3D.new()
	spot.position = Vector3(3, 6, 0)
	spot.rotation_degrees = Vector3(-90, 0, 0)
	spot.spot_range = 7.0
	spot.spot_angle = 20.0
	spot.light_color = Color(0.8, 0.9, 1.0)
	add_child(spot)
	var without_shaft := await _frame("spot.png")
	var shaft := WasdShaft3D.new()
	add_child(shaft)
	shaft.match_light(spot)
	shaft.energy = 0.6
	var with_shaft := await _frame("shaft.png")
	if not shaft.global_position.is_equal_approx(spot.global_position) or not is_equal_approx(shaft.length, 7.0):
		return _fail("match_light put the shaft at %s with length %f" % [shaft.global_position, shaft.length])
	var high := _at(with_shaft, Vector3(3, 5, 0)) - _at(without_shaft, Vector3(3, 5, 0))
	var low := _at(with_shaft, Vector3(3, 1.5, 0)) - _at(without_shaft, Vector3(3, 1.5, 0))
	var beside := _at(with_shaft, Vector3(6.5, 4, 0)) - _at(without_shaft, Vector3(6.5, 4, 0))
	if high < 0.08 or low > high or absf(beside) > 0.02:
		return _fail("the shaft adds %f near the lamp, %f near its end, %f beside it" % [high, low, beside])
	shaft.shape = 1
	await get_tree().process_frame
	shaft.queue_free()
	spot.queue_free()

	# 3. A fog bank veils a post inside it more the further back the post stands, leaves what is before it alone,
	# and still veils from inside.
	var posts: Array[MeshInstance3D] = []
	for index: int in 3:
		posts.append(_box(Vector3(0.6, 3, 0.6), Vector3(-1.5 + index * 1.5, 1.5, 5.0 - index * 5.0), Color(0.05, 0.05, 0.05)))
	# A red lamp's halo before the bank, outside it.
	var lamp_glow := WasdHalo3D.new()
	lamp_glow.position = Vector3(3, 2, 5)
	lamp_glow.color = Color(1.0, 0.1, 0.05)
	lamp_glow.energy = 2.0
	lamp_glow.size = 1.2
	lamp_glow.rays = 0.0
	add_child(lamp_glow)
	var clear := await _frame("posts.png")
	var bank := WasdFogBank3D.new()
	bank.size = Vector3(20, 6, 9)
	bank.position = Vector3(0, 3, -2.5)
	bank.color = Color(0.8, 0.8, 0.8)
	bank.density = 0.25
	bank.thinning = 0.0
	bank.clouds = 0.0
	bank.soft_edges = 0.0
	add_child(bank)
	var fogged := await _frame("fog.png")
	var veil: Array[float] = []
	for post: MeshInstance3D in posts:
		veil.append(_at(fogged, post.position) - _at(clear, post.position))
	# The first post stands before the bank, the second in its middle, the third at its far side.
	if absf(veil[0]) > 0.03 or veil[1] < 0.15 or veil[2] < veil[1] + 0.05:
		return _fail("the fog bank veils its three posts by %s" % [veil])
	# The fog is gray: in light, red over green is the halo's own, and it keeps it when the fog lies behind it.
	var red_glow := [_color_at(clear, lamp_glow.position).srgb_to_linear(), _color_at(fogged, lamp_glow.position).srgb_to_linear()]
	if (red_glow[1] as Color).r - (red_glow[1] as Color).g < ((red_glow[0] as Color).r - (red_glow[0] as Color).g) * 0.6:
		return _fail("a red halo before the fog bank shows %s in light, without the bank %s" % [red_glow[1], red_glow[0]])
	lamp_glow.queue_free()
	# From inside, a red lamp's halo in the bank 2 m from the camera, where little fog lies before it, shows over it.
	camera.position = Vector3(0, 2, 1.5)
	var near_glow := WasdHalo3D.new()
	near_glow.position = Vector3(-1.2, 2, 0)
	near_glow.color = Color(1.0, 0.1, 0.05)
	near_glow.energy = 2.0
	near_glow.size = 1.2
	near_glow.rays = 0.0
	add_child(near_glow)
	var inside := await _frame("fog_inside.png")
	if _at(inside, posts[2].position) < 0.2:
		return _fail("seen from inside, the fog bank veils the far post by only %f" % [_at(inside, posts[2].position)])
	bank.visible = false
	var inside_clear := await _frame("fog_inside_clear.png")
	bank.visible = true
	var near_red := [_color_at(inside_clear, near_glow.position).srgb_to_linear(), _color_at(inside, near_glow.position).srgb_to_linear()]
	if (near_red[1] as Color).r - (near_red[1] as Color).g < ((near_red[0] as Color).r - (near_red[0] as Color).g) * 0.6:
		return _fail("from inside the fog bank, a red halo 2 m off shows %s in light, without the bank %s" % [near_red[1], near_red[0]])
	near_glow.queue_free()
	camera.position = Vector3(0, 2, 10)
	bank.queue_free()
	for post: MeshInstance3D in posts:
		post.queue_free()
	# A bank flattened to nothing, by its size or by a parent scaled to nothing as it pops in, leaves no error.
	var flat := WasdFogBank3D.new()
	flat.size = Vector3(10, 0, 10)
	add_child(flat)
	var popping := Node3D.new()
	popping.scale = Vector3.ZERO
	add_child(popping)
	popping.add_child(WasdFogBank3D.new())
	await _frame("flat_fog.png", 4)
	flat.queue_free()
	popping.queue_free()

	# 4. Dust shows as bright specks in its box and nowhere else.
	var dust := WasdDust3D.new()
	dust.size = Vector3(6, 4, 2)
	dust.position = Vector3(0, 3, 4)
	dust.amount = 2000
	dust.energy = 4.0
	dust.mote_size = 0.06
	add_child(dust)
	var dusty := await _frame("dust.png", 12)
	var specks := 0
	var strays := 0
	for y: int in range(0, dusty.get_height(), 2):
		for x: int in range(0, dusty.get_width(), 2):
			if dusty.get_pixel(x, y).get_luminance() > before.get_pixel(x, y).get_luminance() + 0.15:
				specks += 1
				if x < dusty.get_width() / 8 or x > dusty.get_width() * 7 / 8:
					strays += 1
	if specks < 60 or strays > specks / 20:
		return _fail("the dust shows %d bright samples, %d of them outside its box" % [specks, strays])
	dust.follow_camera = true
	await get_tree().process_frame
	await get_tree().process_frame
	if not dust.global_position.is_equal_approx(camera.global_position):
		return _fail("follow_camera left the dust at %s" % [dust.global_position])
	dust.queue_free()

	# 4b. A new wind moves neither dust nor a fog bank's clouds at once: stepped a sixtieth of a second at a time in a
	# wind of 1 m/s, the frame in which the wind rises by 0.2 m/s, as WASD Weather tells it, changes the picture as
	# little as the frames before it. When the wind goes, as when WASD Weather leaves, each gets its own drift back.
	var motes := WasdDust3D.new()
	motes.size = Vector3(6, 4, 2)
	motes.position = Vector3(0, 3, 4)
	motes.amount = 2000
	motes.energy = 4.0
	motes.mote_size = 0.06
	motes.wander = 0.0
	motes.twinkle = 0.0
	motes.wind = Vector3.ZERO
	add_child(motes)
	var cloudy := WasdFogBank3D.new()
	cloudy.size = Vector3(14, 4, 4)
	cloudy.position = Vector3(0, 2, -4)
	cloudy.color = Color(0.8, 0.8, 0.8)
	cloudy.density = 0.6
	cloudy.thinning = 0.0
	cloudy.clouds = 1.0
	cloudy.cloud_size = 3.0
	cloudy.cloud_drift = Vector2.ZERO
	add_child(cloudy)
	var backdrop_wall := _box(Vector3(16, 6, 0.2), Vector3(0, 3, -6.5), Color(0.05, 0.05, 0.05))
	motes.set_wind(Vector3(1, 0, 0))
	cloudy.set_wind(Vector3(1, 0, 0))
	await _frame("calm_settle.png")
	motes.set_process(false)
	cloudy.set_process(false)
	var stepped: Array[Image] = []
	for step: int in 4:
		if step == 3:
			motes.set_wind(Vector3(1.2, 0, 0))
			cloudy.set_wind(Vector3(1.2, 0, 0))
		motes._process(1.0 / 60.0)
		cloudy._process(1.0 / 60.0)
		stepped.append(await _frame("wind_step_%d.png" % [step], 1))
	# Samples that change at all between one frame and the next.
	var moved: Array[int] = []
	for step: int in 3:
		var count := 0
		for y: int in range(0, stepped[step].get_height(), 2):
			for x: int in range(0, stepped[step].get_width(), 2):
				var a := stepped[step + 1].get_pixel(x, y)
				var b := stepped[step].get_pixel(x, y)
				if absf(a.r - b.r) + absf(a.g - b.g) + absf(a.b - b.b) > 0.02:
					count += 1
		moved.append(count)
	motes.set_process(true)
	cloudy.set_process(true)
	if moved[0] == 0 or moved[2] > maxi(moved[0], moved[1]) * 1.3 + 20:
		return _fail("frames of dust and fog clouds in the wind change %d and %d samples, the frame in which the wind rises %d" % [moved[0], moved[1], moved[2]])
	motes.set_wind(Vector3.ZERO)
	cloudy.set_wind(Vector3.ZERO)
	if motes.wind != Vector3.ZERO or cloudy.cloud_drift != Vector2.ZERO:
		return _fail("still dust and fog clouds kept %s and %s when the wind went" % [motes.wind, cloudy.cloud_drift])
	var dust_own := Vector3(0.05, -0.02, 0.03)
	var drift_own := Vector2(0.25, 0.1)
	motes.wind = dust_own
	cloudy.cloud_drift = drift_own
	motes.set_wind(Vector3(6, 0, 2))
	cloudy.set_wind(Vector3(6, 0, 2))
	var blown := [motes.wind, cloudy.cloud_drift]
	motes.set_wind(Vector3.ZERO)
	cloudy.set_wind(Vector3.ZERO)
	if not (blown[0] as Vector3).is_equal_approx(Vector3(6, -0.02, 2)) or not (blown[1] as Vector2).is_equal_approx(Vector2(1.8, 0.6)) or not motes.wind.is_equal_approx(dust_own) or not cloudy.cloud_drift.is_equal_approx(drift_own):
		return _fail("dust and a fog bank in a wind took %s; when it went they kept %s and %s" % [blown, motes.wind, cloudy.cloud_drift])
	motes.queue_free()
	cloudy.queue_free()
	backdrop_wall.queue_free()

	# 5. A flicker moves its light's energy round the light's own, and a halo under the light with it.
	var lamp := OmniLight3D.new()
	lamp.light_energy = 2.0
	add_child(lamp)
	var lamp_halo := WasdHalo3D.new()
	lamp_halo.energy = 1.5
	lamp.add_child(lamp_halo)
	var flicker := WasdFlicker.new()
	flicker.style = WasdFlicker.Style.FIRE
	flicker.amount = 1.0
	lamp.add_child(flicker)
	# One second of the flicker in steps of a sixtieth, so that how far it moves does not hang on the frame rate: at
	# any time a fire of amount 1 moves a light of energy 2 by more than 0.9 within a second.
	flicker.set_process(false)
	var lowest := 9.0
	var highest := 0.0
	var together := true
	for _i: int in 60:
		flicker._process(1.0 / 60.0)
		lowest = minf(lowest, lamp.light_energy)
		highest = maxf(highest, lamp.light_energy)
		if absf(lamp_halo.energy / 1.5 - lamp.light_energy / 2.0) > 0.001:
			together = false
	if highest - lowest < 0.5 or highest > 2.0 * 1.31 or lowest < 0.0 or not together:
		return _fail("the flicker moved the light between %f and %f, the halo with it: %s" % [lowest, highest, together])
	flicker.set_process(true)
	for style: int in WasdFlicker.Style.size():
		flicker.style = style as WasdFlicker.Style
		await get_tree().process_frame
	# A halo that the game frees is let go, and so is a light named in `light` that goes away before the flicker.
	lamp_halo.queue_free()
	for _i: int in 3:
		await get_tree().process_frame
	var far_lamp := OmniLight3D.new()
	add_child(far_lamp)
	var far_flicker := WasdFlicker.new()
	far_flicker.light = far_lamp
	add_child(far_flicker)
	await get_tree().process_frame
	far_lamp.queue_free()
	for _i: int in 3:
		await get_tree().process_frame
	far_flicker.queue_free()
	lamp.queue_free()

	# 6. A shadow card under a sun throws shade that is part light, part dark, and is not seen itself.
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-70, 20, 0)
	sun.shadow_enabled = true
	sun.light_energy = 0.6
	add_child(sun)
	var sunny := await _frame("sun.png")
	var card := WasdGobo3D.new()
	card.size = Vector2(30, 30)
	card.position = Vector3(0, 5, 0)
	card.sway = 0.0
	add_child(card)
	var shaded := await _frame("gobo.png", 12)
	var darker := 0
	var same := 0
	for y: int in range(shaded.get_height() * 6 / 10, shaded.get_height() - 4, 3):
		for x: int in range(4, shaded.get_width() - 4, 3):
			if shaded.get_pixel(x, y).get_luminance() < sunny.get_pixel(x, y).get_luminance() - 0.08:
				darker += 1
			else:
				same += 1
	if darker < (darker + same) / 5 or same < (darker + same) / 5:
		return _fail("under the shadow card %d ground samples are shaded and %d are not" % [darker, same])
	if absf(_at(shaded, Vector3(0, 6.5, 0)) - _at(sunny, Vector3(0, 6.5, 0))) > 0.02:
		return _fail("the shadow card itself shows")
	for kind: int in WasdGobo3D.Kind.size():
		card.kind = kind as WasdGobo3D.Kind
		await get_tree().process_frame

	# 7. Stood upright, as blinds at a window, a BARS card is striped across its height, and a GRID card across its
	# width too: drawn before a white wall, a line across the stripes meets both the card and the wall.
	sun.queue_free()
	var backdrop := _box(Vector3(14, 9, 0.2), Vector3(0, 2, 0), Color(1, 1, 1))
	(backdrop.mesh.material as StandardMaterial3D).shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	card.size = Vector2(6, 6)
	card.pattern_size = 1.0
	card.rotation_degrees = Vector3(90, 0, 0)
	card.position = Vector3(0, 2, 4)
	card.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	for check: Array in [[WasdGobo3D.Kind.BARS, false], [WasdGobo3D.Kind.GRID, true]]:
		card.kind = check[0] as WasdGobo3D.Kind
		var across: bool = check[1]
		var upright := await _frame("gobo_upright_%d.png" % [card.kind], 4)
		var shut := 0
		var open := 0
		for step: int in 41:
			var along := -2.4 + step * 0.12
			var luma := _at(upright, Vector3(along, 2.37, 4.0) if across else Vector3(0.37, 2.0 + along, 4.0), 1)
			if luma < 0.3:
				shut += 1
			elif luma > 0.7:
				open += 1
		if shut < 6 or open < 6:
			return _fail("an upright %s card shows %d covered and %d open samples along a line %s it" % [WasdGobo3D.Kind.keys()[card.kind], shut, open, "across" if across else "up"])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
