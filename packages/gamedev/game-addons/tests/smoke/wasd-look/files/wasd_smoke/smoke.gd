extends Node3D
## WASD Look smoke test (render run on the Compatibility renderer, the one every Web build uses): the sky lights the
## scene as brightly as it looks, also when it is dark; every look applies; the sun casts a shadow and gets the lower
## energy this renderer needs; the day's clock, fades, the view distance, a photographed sky, and the lamp helper do
## what they say; values given as whole numbers fade; a look, an hour, or a fade stops a running fade, whose waiters
## go on; a sky with no light above 1, as Web builds hand every picture back, is read whole through a pass of its
## own; and when the wind stops, the clouds drift as they did before it.

const ID := "wasd-look"

var look: WasdLook3D
var camera: Camera3D
var changes: Array[String] = []


func _ready() -> void:
	get_tree().create_timer(70.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


func _frame(file: String, frames := 12) -> Image:
	for _i: int in frames:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	return image


## The mean brightness of a part of the picture, given as fractions of its size.
func _mean(image: Image, part: Rect2) -> float:
	var size := Vector2(image.get_size())
	var total := 0.0
	var count := 0
	for y: int in range(int(part.position.y * size.y), int(part.end.y * size.y), 2):
		for x: int in range(int(part.position.x * size.x), int(part.end.x * size.x), 2):
			total += image.get_pixel(x, y).get_luminance()
			count += 1
	return total / float(count)


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	camera = Camera3D.new()
	camera.position = Vector3(0, 1.6, 6)
	camera.rotation_degrees = Vector3(-8, 0, 0)
	add_child(camera)
	# A white matte floor and a box that throws a shadow on it.
	var ground := MeshInstance3D.new()
	var plane := PlaneMesh.new()
	plane.size = Vector2(80, 80)
	var white := StandardMaterial3D.new()
	white.albedo_color = Color.WHITE
	white.roughness = 1.0
	white.metallic_specular = 0.0
	plane.material = white
	ground.mesh = plane
	add_child(ground)
	var box := MeshInstance3D.new()
	var cube := BoxMesh.new()
	cube.size = Vector3(1, 2, 1)
	cube.material = white
	box.mesh = cube
	box.position = Vector3(0, 1, 0)
	add_child(box)

	look = WasdLook3D.new()
	look.cloud_drift = 0.0
	add_child(look)
	look.night_changed.connect(func(is_night: bool) -> void: changes.append("night" if is_night else "day"))
	if look.sun.get_parent() != look or look.bounce.get_parent() != look or look.environment == null:
		return _fail("the node did not build its sun, bounce light, and environment")
	var sky_part := Rect2(0.05, 0.02, 0.2, 0.12)
	var floor_part := Rect2(0.05, 0.86, 0.2, 0.1)

	# 1. An even sky lights the floor as brightly as the sky looks, in daylight and in the dark. Without the sky
	# shader's corrections this renderer shows the floor far darker than the sky, and black under a dark one.
	var material: ShaderMaterial = look.environment.sky.sky_material
	look.sun.visible = false
	look.bounce.visible = false
	look.environment.fog_enabled = false
	look.environment.ssao_enabled = false
	look.environment.adjustment_contrast = 1.0
	look.environment.adjustment_saturation = 1.0
	material.set_shader_parameter(&"light_gain", 1.0)
	material.set_shader_parameter(&"sun_shine", 0.0)
	material.set_shader_parameter(&"clouds", 0.0)
	material.set_shader_parameter(&"stars", 0.0)
	for level: float in [0.3, 0.03]:
		var even := Color(level, level, level).linear_to_srgb()
		for key: StringName in [&"sky_top", &"sky_horizon", &"ground_horizon", &"ground_bottom"]:
			material.set_shader_parameter(key, even)
		var picture := await _frame("even_%s.png" % [level], 30)
		var sky := _mean(picture, sky_part)
		var lit := _mean(picture, floor_part)
		if sky < 0.05 or absf(lit - sky) > maxf(0.05, sky * 0.25):
			return _fail("under an even sky of %f the sky shows %f and the floor it lights %f" % [level, sky, lit])

	# 2. Every look applies; day is brighter than night; the sun's shadow shows.
	var by_look := {}
	for name: String in WasdLookPresets.names():
		look.look = name
		look.sun_azimuth = 135.0
		var picture := await _frame("look_%s.png" % [name], 14)
		by_look[name] = picture
		if look.look != name:
			return _fail("look %s did not stay set" % [name])
	var noon: Image = by_look["noon"]
	var night: Image = by_look["night"]
	if _mean(noon, floor_part) < _mean(night, floor_part) + 0.2:
		return _fail("noon's floor (%f) is not clearly brighter than night's (%f)" % [_mean(noon, floor_part), _mean(night, floor_part)])
	if _mean(night, floor_part) < 0.04:
		return _fail("the night look leaves the floor black (%f)" % [_mean(night, floor_part)])
	look.look = "noon"
	look.sun_azimuth = 90.0
	look.sun_elevation = 45.0
	var shadowed := await _frame("shadow.png", 14)
	# The sun shines from +X at 45 degrees: the box's shadow falls on the floor to its left, toward -X.
	var in_shadow := camera.unproject_position(Vector3(-1.6, 0.0, 0.0)) / Vector2(shadowed.get_size())
	var in_sun := camera.unproject_position(Vector3(1.6, 0.0, 0.0)) / Vector2(shadowed.get_size())
	var dark := _mean(shadowed, Rect2(in_shadow - Vector2(0.01, 0.01), Vector2(0.02, 0.02)))
	var bright := _mean(shadowed, Rect2(in_sun - Vector2(0.01, 0.01), Vector2(0.02, 0.02)))
	if dark > bright - 0.1:
		return _fail("no shadow of the sun: %f in the shadow, %f beside it" % [dark, bright])
	if not look.sun.shadow_enabled or look.sun.light_energy <= 0.1:
		return _fail("the sun casts no shadow or has no energy")
	# 3. This renderer needs less energy for a sun with shadows; without shadows the look's energy stands.
	var with_shadows := look.sun.light_energy
	look.shadows = false
	var without := look.sun.light_energy
	look.shadows = true
	if not is_equal_approx(without, 1.5) or with_shadows > without * 0.75 or with_shadows < without * 0.15:
		return _fail("the sun has energy %f with shadows and %f without" % [with_shadows, without])

	# 4. The day's clock.
	look.day_peak_elevation = 60.0
	look.hour = 12.0
	if look.is_night() or absf(look.sun_elevation - 60.0) > 0.5:
		return _fail("at hour 12 the sun is at %f and night is %s" % [look.sun_elevation, look.is_night()])
	look.hour = 0.0
	if not look.is_night() or absf(look.sun_elevation - 60.0) > 0.5 or look.sun.light_energy <= 0.0:
		return _fail("at hour 0 the moon is at %f with energy %f and night is %s" % [look.sun_elevation, look.sun.light_energy, look.is_night()])
	look.hour = 18.0
	if look.sun.light_energy > 0.001:
		return _fail("at hour 18 the light still has energy %f" % [look.sun.light_energy])
	look.hour = 9.0
	# The clock's first hour tells which light is up, then each change.
	if changes != ["day", "night", "day"]:
		return _fail("night_changed told %s" % [changes])
	look.day_minutes = 0.01
	await get_tree().create_timer(0.2).timeout
	look.day_minutes = 0.0
	if look.hour <= 9.5:
		return _fail("the clock did not run: hour %f" % [look.hour])

	# 5. A fade ends at its look and stops the clock; the clock's next start tells which light is up again.
	var tween := look.fade_to("sunset", 0.2)
	await tween.finished
	if look.look != "sunset" or look.hour >= 0.0 or absf(look.sun_elevation - 5.0) > 0.01:
		return _fail("fade_to ended at look %s, hour %f, sun at %f" % [look.look, look.hour, look.sun_elevation])
	look.hour = 9.0
	if changes != ["day", "night", "day", "day"]:
		return _fail("after a fade the clock's first hour told %s" % [changes])
	# Values given as whole numbers fade like the rest: halfway from no fog to night's, the fog is half night's.
	look.look = "noon"
	look.set_values({"fog": 0, "stars": 0, "sun": 1})
	var halfway := look.fade_to("night", 10.0)
	halfway.pause()
	halfway.custom_step(5.0)
	var half_fog := look.environment.fog_density
	var half_stars := float(material.get_shader_parameter(&"stars"))
	if absf(half_fog - 0.002) > 0.0002 or absf(half_stars - 0.5) > 0.01:
		return _fail("halfway from whole numbers to night the fog is %f and the stars %f" % [half_fog, half_stars])
	# A look, a running hour, or another fade stops a fade where it is, and code that waits for the stopped fade to
	# finish goes on.
	for stop: String in ["look", "hour", "fade"]:
		look.look = "noon"
		var running := look.fade_to("night", 10.0)
		var resumed: Array[bool] = [false]
		(func() -> void:
			await running.finished
			resumed[0] = true).call()
		await get_tree().process_frame
		var other: Tween = null
		if stop == "look":
			look.look = "golden_hour"
		elif stop == "hour":
			look.hour = 12.0
		else:
			other = look.fade_to("sunset", 0.1)
			await other.finished
		for _i: int in 3:
			await get_tree().process_frame
		var wanted := {"look": 13.0, "hour": 60.0, "fade": 5.0}[stop] as float
		if running.is_valid() or not resumed[0] or absf(look.sun_elevation - wanted) > 0.01:
			return _fail("a %s during a fade left it running %s, its waiter resumed %s, the sun at %f" % [stop, running.is_valid(), resumed[0], look.sun_elevation])

	# 6. Single values change, and a view distance ends the fog there.
	look.look = "noon"
	look.set_values({"fog": 0.02, "sky_horizon": Color(0.9, 0.5, 0.2)})
	var horizon := look.get_horizon_color()
	if not is_equal_approx(look.environment.fog_density, 0.02) or horizon.r > 0.9 or horizon.r < 0.8 or absf(horizon.g / horizon.r - 0.5 / 0.9) > 0.05 or not is_equal_approx(horizon.a, 1.0):
		return _fail("set_values left fog density %f and horizon color %s" % [look.environment.fog_density, horizon])
	look.look = "noon"
	look.view_distance = 30.0
	var near := await _frame("view_distance.png", 10)
	if look.environment.fog_mode != Environment.FOG_MODE_DEPTH or not is_equal_approx(look.environment.fog_depth_end, 30.0):
		return _fail("view_distance did not set fog that ends there")
	# The floor's far edge, 40 meters off, shows the sky's horizon color: no edge between them.
	var edge := camera.unproject_position(Vector3(0.0, 0.0, -39.0)) / Vector2(near.get_size())
	var just_below := _mean(near, Rect2(Vector2(0.3, edge.y + 0.004), Vector2(0.4, 0.004)))
	var just_above := _mean(near, Rect2(Vector2(0.3, edge.y - 0.02), Vector2(0.4, 0.004)))
	if absf(just_below - just_above) > 0.06:
		return _fail("the floor's far edge shows against the sky: %f below, %f above" % [just_below, just_above])
	look.view_distance = 0.0
	if look.environment.fog_mode != Environment.FOG_MODE_EXPONENTIAL:
		return _fail("view_distance 0 did not bring back fog by density")

	# 7. A photographed sky: its sun is found, it lights the floor, and null brings the drawn sky back.
	var picture := Image.create(256, 128, false, Image.FORMAT_RGBF)
	var turn := deg_to_rad(40.0)
	var height := deg_to_rad(30.0)
	var to_sun := Vector3(sin(turn) * cos(height), sin(height), -cos(turn) * cos(height))
	for y: int in 128:
		var latitude := (0.5 - (y + 0.5) / 128.0) * PI
		for x: int in 256:
			var longitude := (x + 0.5) / 256.0 * TAU
			var direction := Vector3(sin(longitude) * cos(latitude), sin(latitude), -cos(longitude) * cos(latitude))
			var color := Color(1.2, 1.6, 2.4) if direction.y > 0.0 else Color(0.3, 0.3, 0.3)
			if direction.dot(to_sun) > cos(deg_to_rad(2.5)):
				color = Color(3000, 3000, 3000)
			picture.set_pixel(x, y, color)
	look.panorama = ImageTexture.create_from_image(picture)
	var found := look.find_sun_in_panorama()
	if absf(found.x - 40.0) > 2.0 or absf(found.y - 30.0) > 2.0:
		return _fail("the photographed sky's sun, made at (40, 30), was found at %s" % [found])
	var under_picture := await _frame("panorama.png", 30)
	if _mean(under_picture, floor_part) < 0.3 or _mean(under_picture, sky_part) < 0.3:
		return _fail("under the photographed sky the floor shows %f and the sky %f" % [_mean(under_picture, floor_part), _mean(under_picture, sky_part)])
	# A sky with no light above 1, as a Web build hands every picture back, is read whole through a pass of its own a
	# frame later: until then the sun stays, then it moves to the picture's, and the horizon keeps the sky's blue.
	var dim := Image.create(256, 128, false, Image.FORMAT_RGBF)
	for y: int in 128:
		for x: int in 256:
			dim.set_pixel(x, y, picture.get_pixel(x, y) * (0.0003 if picture.get_pixel(x, y).r > 100.0 else 0.1))
	look.sun_azimuth = 0.0
	look.sun_elevation = 60.0
	look.panorama = ImageTexture.create_from_image(dim)
	var waiting := look.find_sun_in_panorama()
	for _i: int in 3:
		await get_tree().process_frame
	var far := look.get_horizon_color()
	if waiting != Vector2(0.0, 60.0) or absf(look.sun_azimuth - 40.0) > 2.0 or absf(look.sun_elevation - 30.0) > 2.0 or far.b < far.r * 1.15:
		return _fail("a dim photographed sky left the sun at %s, then at (%f, %f), and the horizon %s" % [waiting, look.sun_azimuth, look.sun_elevation, far])
	look.panorama = null
	if look.environment.sky.sky_material != material:
		return _fail("panorama = null did not bring the drawn sky back")

	# 8. A lamp with shadows gets less energy in daylight on this renderer, and nearly all of it in a dim room.
	var lamp := OmniLight3D.new()
	lamp.shadow_enabled = true
	add_child(lamp)
	look.look = "overcast"
	look.set_shadowed_light(lamp, 4.0, Color(1.0, 0.8, 0.6))
	var by_day := lamp.light_energy
	look.look = "interior"
	look.set_shadowed_light(lamp, 4.0, Color(1.0, 0.8, 0.6))
	var indoors := lamp.light_energy
	if by_day > 2.0 or indoors < 2.0 or indoors > 4.0:
		return _fail("a lamp of energy 4 got %f in daylight and %f indoors" % [by_day, indoors])
	lamp.queue_free()

	# 9. Clouded over, the sun weakens and the sky closes; added fog brings the fog's end near and takes the sky;
	# the range for a material's own haze keeps step; the wind turns the clouds; other packs find the node.
	look.look = "noon"
	look.view_distance = 1000.0
	var clear_energy := look.sun.light_energy
	var clear_level := look.get_light_level()
	var clear_haze := look.get_haze_range()
	look.overcast = 1.0
	if look.sun.light_energy > clear_energy * 0.5 or look.get_light_level() >= clear_level or float(material.get_shader_parameter(&"clouds")) < 1.0:
		return _fail("clouded over: sun %f of %f, light level %f of %f, clouds %s" % [look.sun.light_energy, clear_energy, look.get_light_level(), clear_level, material.get_shader_parameter(&"clouds")])
	look.overcast = 0.0
	look.added_fog = 0.03
	var foggy_haze := look.get_haze_range()
	if look.environment.fog_depth_end > 100.0 or look.environment.fog_sky_affect < 0.5 or foggy_haze.y < 20.0 or foggy_haze.y > clear_haze.y * 0.2:
		return _fail("added fog: the fog ends at %f, takes %f of the sky, haze range %s (clear %s)" % [look.environment.fog_depth_end, look.environment.fog_sky_affect, foggy_haze, clear_haze])
	look.added_fog = 0.0
	if not is_equal_approx(look.environment.fog_depth_end, 1000.0) or look.environment.fog_sky_affect > 0.01:
		return _fail("without added fog the fog ends at %f and takes %f of the sky" % [look.environment.fog_depth_end, look.environment.fog_sky_affect])
	look.view_distance = 0.0
	look.cloud_drift = 2.0
	var own_drift := Vector2(look.cloud_drift, look.cloud_heading)
	look.set_wind(Vector3(6, 0, 0))
	if not is_equal_approx(look.cloud_heading, 90.0) or not is_equal_approx(look.cloud_drift, 3.0) or not look.is_in_group(&"wasd_look") or not look.is_in_group(&"wasd_wind"):
		return _fail("a wind toward +X left cloud heading %f and drift %f" % [look.cloud_heading, look.cloud_drift])
	# No wind, as a weather that leaves tells, gives the clouds back their own drift.
	look.set_wind(Vector3(0, 0, 8))
	look.set_wind(Vector3.ZERO)
	if not Vector2(look.cloud_drift, look.cloud_heading).is_equal_approx(own_drift):
		return _fail("after the wind stopped the clouds drift %f toward %f, not %s" % [look.cloud_drift, look.cloud_heading, own_drift])
	look.cloud_drift = 0.0

	# 10. Clouds drift.
	look.look = "noon"
	look.cloud_drift = 8.0
	var offset_before: Vector2 = material.get_shader_parameter(&"cloud_offset")
	await get_tree().create_timer(0.15).timeout
	if (material.get_shader_parameter(&"cloud_offset") as Vector2).is_equal_approx(offset_before):
		return _fail("the clouds did not drift")
	for quality: int in 4:
		look.quality = quality
		await get_tree().process_frame
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
