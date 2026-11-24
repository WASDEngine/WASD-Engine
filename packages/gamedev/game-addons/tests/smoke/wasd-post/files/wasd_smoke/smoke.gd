extends Node3D
## WASD Post smoke test (render run on the Compatibility renderer): the plain look changes nothing; looks and single
## properties change the picture the way they say, the drawn, old-screen, scope, dream, and night looks among them; a
## transparent object stays in the picture; a HUD above the pass keeps its colors; fades into and out of the looks
## with steps move evenly; and a look or another fade stops a running fade, whose waiters go on.

const ID := "wasd-post"

var post: WasdPost


func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("timed out"))
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


## The mean color of a part of the picture, given as fractions of its size.
func _mean(image: Image, part: Rect2) -> Color:
	var size := Vector2(image.get_size())
	var total := Color(0, 0, 0, 0)
	var count := 0
	for y: int in range(int(part.position.y * size.y), int(part.end.y * size.y), 2):
		for x: int in range(int(part.position.x * size.x), int(part.end.x * size.x), 2):
			total += image.get_pixel(x, y)
			count += 1
	return total / float(count)


func _spread(color: Color) -> float:
	return maxf(color.r, maxf(color.g, color.b)) - minf(color.r, minf(color.g, color.b))


## The darkest and the brightest pixel of a part of the picture, by luminance, as x and y.
func _range(image: Image, part: Rect2) -> Vector2:
	var size := Vector2(image.get_size())
	var found := Vector2(1.0, 0.0)
	for y: int in range(int(part.position.y * size.y), int(part.end.y * size.y)):
		for x: int in range(int(part.position.x * size.x), int(part.end.x * size.x)):
			var light := image.get_pixel(x, y).get_luminance()
			found = Vector2(minf(found.x, light), maxf(found.y, light))
	return found


## How many different shades of gray a part of the picture holds, to the nearest twentieth.
func _shades(image: Image, part: Rect2) -> int:
	var size := Vector2(image.get_size())
	var seen := {}
	for y: int in range(int(part.position.y * size.y), int(part.end.y * size.y)):
		for x: int in range(int(part.position.x * size.x), int(part.end.x * size.x)):
			seen[roundi(image.get_pixel(x, y).get_luminance() * 20.0)] = true
	return seen.size()


## The column where the ball's left rim crosses the picture's middle row, or -1.
func _ball_rim(image: Image) -> int:
	var row := image.get_height() / 2
	for x: int in range(20, image.get_width() / 2):
		if image.get_pixel(x, row).r > 0.8 and image.get_pixel(x - 1, row).r < 0.6:
			return x
	return -1


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.25, 0.45, 0.7)
	add_child(world)
	var camera := Camera3D.new()
	camera.position = Vector3(0, 0, 4)
	add_child(camera)
	# An opaque orange ball left of the centre, and a half-transparent green pane right of it.
	var ball := MeshInstance3D.new()
	ball.mesh = SphereMesh.new()
	var orange := StandardMaterial3D.new()
	orange.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	orange.albedo_color = Color(1.0, 0.5, 0.1)
	ball.material_override = orange
	ball.position = Vector3(-1.2, 0, 0)
	add_child(ball)
	var pane := MeshInstance3D.new()
	pane.mesh = QuadMesh.new()
	var glass := StandardMaterial3D.new()
	glass.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	glass.albedo_color = Color(0.1, 1.0, 0.2, 0.6)
	pane.material_override = glass
	pane.position = Vector3(1.2, 0, 0)
	add_child(pane)
	# A strip that runs from black to white, below the centre.
	var strip := MeshInstance3D.new()
	var quad := QuadMesh.new()
	quad.size = Vector2(3.0, 0.5)
	strip.mesh = quad
	var ramp := GradientTexture2D.new()
	ramp.gradient = Gradient.new()
	ramp.gradient.set_color(0, Color.BLACK)
	ramp.gradient.set_color(1, Color.WHITE)
	var shaded := StandardMaterial3D.new()
	shaded.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	shaded.albedo_texture = ramp
	strip.material_override = shaded
	strip.position = Vector3(0, -1.3, 0)
	add_child(strip)
	# A HUD above the pass: a pure red bar along the top.
	var hud := CanvasLayer.new()
	hud.layer = 5
	var bar := ColorRect.new()
	bar.color = Color(1, 0, 0)
	bar.size = Vector2(200, 24)
	hud.add_child(bar)
	add_child(hud)

	var ball_part := Rect2(0.37, 0.44, 0.04, 0.12)
	var pane_part := Rect2(0.59, 0.44, 0.04, 0.12)
	var corner := Rect2(0.9, 0.85, 0.08, 0.12)
	var centre := Rect2(0.46, 0.44, 0.08, 0.12)
	var hud_part := Rect2(0.02, 0.01, 0.1, 0.04)
	var before := await _frame("before.png")
	post = WasdPost.new()
	add_child(post)
	var plain := await _frame("plain.png")
	for part: Rect2 in [ball_part, pane_part, corner, centre]:
		var a := _mean(before, part)
		var b := _mean(plain, part)
		if absf(a.r - b.r) + absf(a.g - b.g) + absf(a.b - b.b) > 0.02:
			return _fail("the plain look changed the picture: %s became %s" % [a, b])
	if _mean(before, pane_part).g < _mean(before, pane_part).r + 0.2:
		return _fail("the transparent pane is not in the test picture")

	post.look = "noir"
	var noir := await _frame("noir.png")
	if _spread(_mean(noir, ball_part)) > 0.06 or _spread(_mean(noir, pane_part)) > 0.06:
		return _fail("noir left color in the picture: ball %s pane %s" % [_mean(noir, ball_part), _mean(noir, pane_part)])
	if _mean(noir, corner).get_luminance() > _mean(noir, centre).get_luminance() * 0.85:
		return _fail("noir did not darken the corners")
	var hud_color := _mean(noir, hud_part)
	if hud_color.r < 0.95 or hud_color.g > 0.05 or hud_color.b > 0.05:
		return _fail("the look changed the HUD above it: %s" % [hud_color])
	# The transparent pane is still told apart from the background beside it.
	if absf(_mean(noir, pane_part).get_luminance() - _mean(noir, Rect2(0.5, 0.2, 0.06, 0.1)).get_luminance()) < 0.05:
		return _fail("the transparent pane vanished under the look")

	post.look = "none"
	post.exposure = 1.0
	var brighter := await _frame("brighter.png")
	if _mean(brighter, centre).get_luminance() < _mean(before, centre).get_luminance() * 1.5:
		return _fail("an exposure of one stop left the centre at %f of %f" % [_mean(brighter, centre).get_luminance(), _mean(before, centre).get_luminance()])
	post.exposure = 0.0
	post.temperature = 1.0
	var warm := await _frame("warm.png")
	var warmed := _mean(warm, centre)
	var was := _mean(before, centre)
	if warmed.r <= was.r or warmed.b >= was.b:
		return _fail("temperature 1 turned %s into %s" % [was, warmed])
	post.temperature = 0.0
	post.pixel_size = 8.0
	var blocks := await _frame("blocks.png")
	# Inside one 8-pixel block every pixel has the block's color, also across the ball's edge.
	var differing := 0
	for y: int in range(0, blocks.get_height() - 8, 8):
		for x: int in range(0, blocks.get_width() - 8, 8):
			var first := blocks.get_pixel(x + 1, y + 1)
			var last := blocks.get_pixel(x + 6, y + 6)
			if y > 40 and absf(first.r - last.r) + absf(first.g - last.g) + absf(first.b - last.b) > 0.02:
				differing += 1
	if differing > 0:
		return _fail("%d blocks hold more than one color at pixel_size 8" % [differing])
	post.pixel_size = 1.0


	# Tone steps: the strip from black to white is drawn in four shades and nothing between them.
	var strip_part := Rect2(0.38, 0.69, 0.24, 0.04)
	var smooth_shades := _shades(before, strip_part)
	post.tone_levels = 4.0
	var stepped := await _frame("stepped.png")
	var shades := _shades(stepped, strip_part)
	if smooth_shades < 12 or shades < 3 or shades > 4:
		return _fail("tone_levels 4 drew the strip's %d shades in %d" % [smooth_shades, shades])
	post.tone_levels = 0.0
	# A vignette of 2 blackens the corners and leaves the centre.
	post.vignette = 2.0
	post.vignette_softness = 1.0
	var rimmed := await _frame("rimmed.png")
	if _mean(rimmed, corner).get_luminance() > 0.03 or _mean(rimmed, centre).get_luminance() < _mean(before, centre).get_luminance() * 0.9:
		return _fail("a vignette of 2 left the corner at %f and the centre at %f" % [_mean(rimmed, corner).get_luminance(), _mean(rimmed, centre).get_luminance()])
	post.vignette = 0.0
	post.vignette_softness = 0.55

	# Comic: an ink line round the ball, darker than the ball and than the sky beside it.
	post.look = "comic"
	var comic := await _frame("comic.png")
	var rim := _ball_rim(before)
	if rim < 0:
		return _fail("the ball's rim is not in the test picture")
	var row := before.get_height() / 2
	var inked := 1.0
	for x: int in range(rim - 3, rim + 4):
		inked = minf(inked, comic.get_pixel(x, row).get_luminance())
	if inked > comic.get_pixel(rim - 12, row).get_luminance() * 0.6 or inked > comic.get_pixel(rim + 12, row).get_luminance() * 0.6:
		return _fail("comic drew no ink at the ball's rim: %f between %f and %f" % [inked, comic.get_pixel(rim - 12, row).get_luminance(), comic.get_pixel(rim + 12, row).get_luminance()])
	# Sketch: no color, and pencil strokes on paper where the sky was.
	post.look = "sketch"
	var sketch := await _frame("sketch.png")
	var sky_part := Rect2(0.44, 0.12, 0.12, 0.12)
	var strokes := _range(sketch, sky_part)
	if _spread(_mean(sketch, sky_part)) > 0.12 or strokes.y < 0.8 or strokes.y - strokes.x < 0.12:
		return _fail("sketch drew the sky as %s, from %f to %f" % [_mean(sketch, sky_part), strokes.x, strokes.y])
	# An old television: black beyond the glass's corner, and every second line darker.
	post.look = "crt"
	var crt := await _frame("crt.png")
	var glass_corner := Rect2(0.988, 0.98, 0.012, 0.02)
	if _mean(crt, glass_corner).get_luminance() > 0.03:
		return _fail("crt left the screen's corner lit: %s" % [_mean(crt, glass_corner)])
	var lines := [0.0, 0.0]
	for y: int in range(40, 80):
		for x: int in range(300, 340):
			lines[y % 2] += crt.get_pixel(x, y).get_luminance() / 800.0
	if absf(lines[0] - lines[1]) < 0.03:
		return _fail("crt drew no scanlines: %f and %f" % [lines[0], lines[1]])
	# Night vision is green; a dream pales toward the rim; moonlight is dim and blue.
	post.look = "night_vision"
	var scope := _mean(await _frame("night_vision.png"), centre)
	if scope.g < scope.r * 1.4 or scope.g < scope.b * 1.4:
		return _fail("night_vision drew the centre %s" % [scope])
	post.look = "dream"
	var dream := await _frame("dream.png")
	if _mean(dream, corner).get_luminance() < _mean(before, corner).get_luminance() + 0.1:
		return _fail("dream left the corner at %f of %f" % [_mean(dream, corner).get_luminance(), _mean(before, corner).get_luminance()])
	post.look = "moonlight"
	var moon := _mean(await _frame("moonlight.png"), centre)
	if moon.get_luminance() > _mean(before, centre).get_luminance() * 0.6 or moon.b < moon.r * 1.3:
		return _fail("moonlight drew the centre %s of %s" % [moon, _mean(before, centre)])

	post.look = "cinematic"
	post.amount = 0.0
	var hidden := await _frame("hidden.png")
	var back := _mean(hidden, ball_part)
	var first_ball := _mean(before, ball_part)
	if absf(back.r - first_ball.r) + absf(back.g - first_ball.g) + absf(back.b - first_ball.b) > 0.02:
		return _fail("amount 0 still changed the picture")
	for name: String in WasdPostLooks.names():
		post.amount = 1.0
		post.look = name
		for _i: int in 2:
			await get_tree().process_frame
	var tween := post.fade_to("warm", 0.2)
	await tween.finished
	if post.look != "warm" or not is_equal_approx(post.temperature, 0.45):
		return _fail("fade_to ended at look %s, temperature %f" % [post.look, post.temperature])

	# Fades into and out of the looks with steps move evenly: on the way the picture never goes dark, and no tenth of
	# the fade changes it by more than a tenth of full brightness.
	for pair: Array in [["none", "retro"], ["retro", "none"], ["none", "comic"], ["comic", "none"]]:
		post.look = pair[0]
		var fade := post.fade_to(pair[1], 1.0)
		fade.pause()
		var lights: Array[float] = []
		for step: int in 11:
			lights.append(_mean(await _frame("fade.png"), centre).get_luminance())
			fade.custom_step(0.1)
		for step: int in 10:
			if lights[step + 1] < minf(lights[0], lights[10]) * 0.75 or absf(lights[step + 1] - lights[step]) > 0.1:
				return _fail("a fade from %s to %s showed the centre as %s" % [pair[0], pair[1], lights])
	# Counts of steps below 2 are off, as a game's own tween passes through them.
	post.look = "none"
	post.color_levels = 1.5
	post.tone_levels = 1.5
	var below := _mean(await _frame("below_two.png"), centre).get_luminance()
	if absf(below - _mean(before, centre).get_luminance()) > 0.02:
		return _fail("color_levels and tone_levels of 1.5 drew the centre at %f, not %f" % [below, _mean(before, centre).get_luminance()])
	# A look or another fade stops a fade where it is, and code that waits for the stopped fade to finish goes on.
	for stop: String in ["look", "fade"]:
		post.look = "none"
		var running := post.fade_to("noir", 10.0)
		var resumed: Array[bool] = [false]
		(func() -> void:
			await running.finished
			resumed[0] = true).call()
		await get_tree().process_frame
		if stop == "look":
			post.look = "warm"
		else:
			await post.fade_to("warm", 0.1).finished
		for _i: int in 3:
			await get_tree().process_frame
		if running.is_valid() or not resumed[0] or post.look != "warm" or not is_equal_approx(post.saturation, 1.08):
			return _fail("a %s during a fade left it running %s, its waiter resumed %s, saturation at %f" % [stop, running.is_valid(), resumed[0], post.saturation])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
