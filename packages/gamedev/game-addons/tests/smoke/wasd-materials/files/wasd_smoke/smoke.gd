extends Node3D
## WASD Materials smoke test (render run on the Compatibility renderer, the one every Web build uses): surfaces by
## name draw in their own colors with a pattern, take a color, a size, and other options, and share one picture; a
## folder of downloaded textures and a single picture become materials laid out from three sides; the toon look has
## its outline, glass lets what is behind it through, glow glows; paint() reaches meshes and CSG shapes; and a
## human whose materials all came in see-through is put right: skin, eyes of any color, teeth, lashes and brows
## that cast no shadow, and hair each get their shader, cloth with holes is cut out, and the inside of a proxy's
## mouth stays dark.

const ID := "wasd-materials"

var camera: Camera3D
var wall: MeshInstance3D


func _ready() -> void:
	get_tree().create_timer(80.0).timeout.connect(func() -> void: _fail("timed out"))
	_run()


func _fail(reason: String) -> void:
	print("SMOKE_FAIL ", reason)
	get_tree().quit(1)


## The picture's average color and how much its brightness varies, over the middle of the wall.
func _look_at_wall(file: String) -> Dictionary:
	for _frame: int in 4:
		await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	image.save_png(ProjectSettings.globalize_path("res://wasd_smoke/" + file))
	var size := image.get_size()
	var total := Color(0, 0, 0)
	var values: Array[float] = []
	for y: int in range(size.y * 3 / 10, size.y * 7 / 10, 3):
		for x: int in range(size.x * 3 / 10, size.x * 7 / 10, 3):
			var pixel := image.get_pixel(x, y)
			total += pixel
			values.append(pixel.get_luminance())
	var mean := total / values.size()
	var spread := 0.0
	for value: float in values:
		spread += absf(value - mean.get_luminance())
	return {"color": mean, "spread": spread / values.size()}


func _run() -> void:
	if RenderingServer.get_current_rendering_method() != "gl_compatibility":
		return _fail("the run draws with %s" % [RenderingServer.get_current_rendering_method()])
	var world := WorldEnvironment.new()
	world.environment = Environment.new()
	world.environment.background_mode = Environment.BG_COLOR
	world.environment.background_color = Color(0.0, 0.0, 0.6)
	world.environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	world.environment.ambient_light_color = Color(0.6, 0.6, 0.6)
	add_child(world)
	var sun := DirectionalLight3D.new()
	sun.rotation_degrees = Vector3(-40, 30, 0)
	add_child(sun)
	camera = Camera3D.new()
	camera.position = Vector3(0, 1.5, 4)
	add_child(camera)
	wall = MeshInstance3D.new()
	var slab := BoxMesh.new()
	slab.size = Vector3(8, 6, 0.2)
	wall.mesh = slab
	wall.position = Vector3(0, 1.5, 0)
	add_child(wall)

	# 1. The surfaces by name; an unknown one is concrete.
	var names := WasdSurface.names()
	if names.size() < 20 or not names.has("bricks") or not names.has("grid"):
		return _fail("names() is %s" % [names])
	var unknown := WasdSurface.make("unobtainium")
	if unknown.get_shader_parameter(&"color") != WasdSurface.SURFACES["concrete"]["color"]:
		return _fail("an unknown surface is not concrete")

	# 2. Each surface draws in its own color, and a patterned one is not flat.
	var bricks := WasdSurface.make("bricks")
	wall.material_override = bricks
	var red := await _look_at_wall("bricks.png")
	var brick_color: Color = red["color"]
	if brick_color.r < brick_color.b * 1.2 or brick_color.r < brick_color.g or brick_color.r < 0.2 or float(red["spread"]) < 0.02:
		return _fail("bricks draw as %s with a spread of %f" % [brick_color, red["spread"]])
	wall.material_override = WasdSurface.make("snow")
	var white := await _look_at_wall("snow.png")
	wall.material_override = WasdSurface.make("asphalt")
	var dark := await _look_at_wall("asphalt.png")
	if (white["color"] as Color).get_luminance() < 0.6 or (dark["color"] as Color).get_luminance() > 0.35:
		return _fail("snow draws as %s and asphalt as %s" % [white["color"], dark["color"]])
	for name: String in names:
		wall.material_override = WasdSurface.make(name)
		await get_tree().process_frame

	# 3. Options: a color, a size, a relief, the object's own meters, and any shader value by name; one picture
	# is shared by all.
	var green_paint := WasdSurface.make("painted_metal", {"color": Color(0.1, 0.5, 0.2), "size": 2.0, "bump": 0.5, "with_object": true, "wear": 0.0})
	var base: Dictionary = WasdSurface.SURFACES["painted_metal"]
	if (green_paint.get_shader_parameter(&"color") != Color(0.1, 0.5, 0.2)
			or not is_equal_approx(green_paint.get_shader_parameter(&"size"), float(base["size"]) * 2.0)
			or not is_equal_approx(green_paint.get_shader_parameter(&"bump_fine"), float(base["bump_fine"]) * 0.5)
			or green_paint.get_shader_parameter(&"with_object") != true
			or green_paint.get_shader_parameter(&"wear") != 0.0):
		return _fail("options left color %s, size %s, fine bump %s" % [green_paint.get_shader_parameter(&"color"), green_paint.get_shader_parameter(&"size"), green_paint.get_shader_parameter(&"bump_fine")])
	var larger := WasdSurface.make("bricks", {"size": 3.0})
	if not (larger.get_shader_parameter(&"piece") as Vector2).is_equal_approx((bricks.get_shader_parameter(&"piece") as Vector2) * 3.0):
		return _fail("a size of 3 left bricks of %s" % [larger.get_shader_parameter(&"piece")])
	if green_paint.get_shader_parameter(&"grain") == null or green_paint.get_shader_parameter(&"grain") != bricks.get_shader_parameter(&"grain"):
		return _fail("two surfaces do not share one grain picture")
	wall.material_override = green_paint
	var green := await _look_at_wall("green_paint.png")
	if (green["color"] as Color).g < (green["color"] as Color).r * 1.5:
		return _fail("paint in green draws as %s" % [green["color"]])

	# 4. A folder of downloaded textures, told apart by their names; a folder without a color picture gives none.
	var stone := WasdSurface.from_folder("res://wasd_smoke/stone", {"size": 3.0})
	if (stone == null or stone.albedo_texture == null or not stone.normal_enabled
			or not stone.normal_texture.resource_path.contains("nor_gl") or stone.roughness_texture == null
			or stone.roughness_texture_channel != BaseMaterial3D.TEXTURE_CHANNEL_GREEN or not stone.ao_enabled
			or not stone.uv1_triplanar or not stone.uv1_world_triplanar or not is_equal_approx(stone.uv1_scale.x, 1.0 / 3.0)):
		return _fail("from_folder made %s" % [stone])
	wall.material_override = stone
	var brown := await _look_at_wall("stone.png")
	if (brown["color"] as Color).r < (brown["color"] as Color).b * 1.3:
		return _fail("the folder's color picture draws as %s" % [brown["color"]])
	if WasdSurface.from_folder("res://wasd_smoke/empty") != null:
		return _fail("a folder without a color picture still gave a material")
	# ambientCG names its pictures another way, and its DirectX normal map comes first by name: the OpenGL one is taken.
	var wood := WasdSurface.from_folder("res://wasd_smoke/wood")
	if (wood == null or wood.albedo_texture == null or not wood.normal_enabled
			or not wood.normal_texture.resource_path.contains("NormalGL") or wood.roughness_texture == null
			or not wood.roughness_texture.resource_path.contains("Roughness")
			or wood.roughness_texture_channel != BaseMaterial3D.TEXTURE_CHANNEL_GRAYSCALE
			or wood.metallic_texture == null or not wood.metallic_texture.resource_path.contains("Metalness")
			or not wood.ao_enabled or not wood.ao_texture.resource_path.contains("AmbientOcclusion")):
		return _fail("from_folder read an ambientCG folder as %s" % [wood])
	# A folder with an opacity picture becomes a cut-out on the mesh's own UV map: nothing draws where that picture is
	# dark, so half of a quad shows its green and the other half the blue behind it.
	var leaf := WasdSurface.cutout("res://wasd_smoke/leaf", {"threshold": 0.4})
	if (leaf == null or leaf.shader != WasdSurface.CUTOUT_SHADER or leaf.get_shader_parameter(&"opacity_map") == null
			or not is_equal_approx(leaf.get_shader_parameter(&"threshold"), 0.4)):
		return _fail("cutout made %s" % [leaf])
	if WasdSurface.cutout("res://wasd_smoke/stone") != null:
		return _fail("a folder without an opacity picture still gave a cut-out")
	var soft := WasdSurface.cutout("res://wasd_smoke/leaf", {"soft": true, "strength": 0.5})
	if soft == null or soft.shader != WasdSurface.OVERLAY_SHADER or not is_equal_approx(soft.get_shader_parameter(&"strength"), 0.5):
		return _fail("a soft cut-out is %s" % [soft])
	var card := MeshInstance3D.new()
	var quad := QuadMesh.new()
	quad.size = Vector2(8, 6)
	card.mesh = quad
	card.position = Vector3(0, 1.5, 0.3)
	card.material_override = leaf
	add_child(card)
	wall.visible = false
	var cut := (await _look_at_wall("cutout.png"))["color"] as Color
	card.queue_free()
	wall.visible = true
	if cut.g < 0.1 or cut.b < 0.2 or cut.r > cut.g:
		return _fail("a cut-out of green over blue draws as %s" % [cut])
	var by_uv := WasdSurface.from_folder("res://wasd_smoke/stone", {"uv": true})
	var relief := WasdSurface.from_picture(stone.albedo_texture, {"with_object": true})
	if by_uv.uv1_triplanar or not relief.normal_enabled or relief.normal_texture == null or relief.uv1_world_triplanar or not relief.uv1_triplanar:
		return _fail("uv: triplanar %s; from_picture: normal %s, world %s" % [by_uv.uv1_triplanar, relief.normal_enabled, relief.uv1_world_triplanar])

	# 5. Toon with and without its outline, glass that lets the wall through, and glow.
	var toon := WasdSurface.toon(Color(0.9, 0.4, 0.2), {"steps": 3, "outline": 3.0})
	var plain := WasdSurface.toon(Color(0.9, 0.4, 0.2), {"outline": 0.0})
	if toon.next_pass == null or plain.next_pass != null or not is_equal_approx(toon.get_shader_parameter(&"steps"), 3.0):
		return _fail("toon: outline pass %s, without %s" % [toon.next_pass, plain.next_pass])
	wall.material_override = toon
	var orange := await _look_at_wall("toon.png")
	if (orange["color"] as Color).r < (orange["color"] as Color).b * 1.5:
		return _fail("toon in orange draws as %s" % [orange["color"]])
	wall.material_override = bricks
	var pane := MeshInstance3D.new()
	var sheet := BoxMesh.new()
	sheet.size = Vector3(6, 5, 0.05)
	pane.mesh = sheet
	pane.position = Vector3(0, 1.5, 1.0)
	pane.material_override = WasdSurface.glass()
	add_child(pane)
	var through := await _look_at_wall("glass.png")
	var seen: Color = through["color"]
	if seen.r < brick_color.r * 0.5 or seen.r < seen.b or seen.is_equal_approx(brick_color):
		return _fail("bricks through glass draw as %s, without it as %s" % [seen, brick_color])
	pane.queue_free()
	var lamp := WasdSurface.glow(Color(1.0, 0.5, 0.1), 4.0)
	if not lamp.emission_enabled or lamp.emission_energy_multiplier != 4.0:
		return _fail("glow has emission %s at %f" % [lamp.emission_enabled, lamp.emission_energy_multiplier])

	# 6. paint() reaches every mesh and CSG shape under a node.
	var house := Node3D.new()
	add_child(house)
	var part := MeshInstance3D.new()
	part.mesh = sheet
	house.add_child(part)
	var block := CSGBox3D.new()
	house.add_child(block)
	house.position = Vector3(0, -50, 0)
	WasdSurface.paint(house, bricks)
	if part.material_override != bricks or block.material != bricks:
		return _fail("paint() left %s on the mesh and %s on the CSG box" % [part.material_override, block.material])

	# 7. A human whose materials all came in see-through: skin, eyes, teeth, lashes, brows, and hair get their
	# shaders, whole cloth becomes solid, and cloth with holes is cut out. Brown eyes are eyes, not brows.
	var solid_picture := ImageTexture.create_from_image(Image.create_empty(8, 8, false, Image.FORMAT_RGB8))
	var holes := Image.create_empty(8, 8, false, Image.FORMAT_RGBA8)
	holes.fill(Color(0.3, 0.2, 0.1, 1.0))
	holes.fill_rect(Rect2i(0, 0, 4, 8), Color(0, 0, 0, 0))
	var holed_picture := ImageTexture.create_from_image(holes)
	var human := Node3D.new()
	human.position = Vector3(0, -50, 0)
	add_child(human)
	var parts := {}
	var named := {"Human": "Human.body", "Human_high-poly": "Human.eyes_brown", "Human_long01": "Human.hair_long01"}
	for name: String in ["Human", "Human_low-poly", "Human_high-poly", "Human_teeth_base", "Human_eyelashes01", "Human_eyebrow001", "Human_long01", "Human_skirt", "Human_shirt"]:
		var piece := MeshInstance3D.new()
		piece.name = name
		var ball := SphereMesh.new()
		var material := StandardMaterial3D.new()
		material.resource_name = named.get(name, name.replace("_", "."))
		material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_DEPTH_PRE_PASS
		material.cull_mode = BaseMaterial3D.CULL_DISABLED
		material.albedo_texture = holed_picture if name in ["Human_eyelashes01", "Human_eyebrow001", "Human_long01", "Human_skirt"] else solid_picture
		if name == "Human":
			# The folds of a face, as the mpfb guide's humans bring them: a normal map of no strength.
			material.normal_enabled = true
			material.normal_texture = solid_picture
			material.normal_scale = 0.0
		ball.material = material
		piece.mesh = ball
		human.add_child(piece)
		parts[name] = piece
	# A head's mesh may hold the inside of its mouth after its skin, as an MPFB proxy that was given a face does: the
	# skin gets its shader, the dark inside and its dull teeth stay what they are, and the mesh counts as skin.
	var head := MeshInstance3D.new()
	head.name = "Human_proxy741"
	var surfaces := ArrayMesh.new()
	for surface_name: String in ["Human.body", "Human.mouth_dark", "Human.mouth_white"]:
		surfaces.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, SphereMesh.new().get_mesh_arrays())
		var material := StandardMaterial3D.new()
		material.resource_name = surface_name
		material.cull_mode = BaseMaterial3D.CULL_DISABLED
		material.roughness = 0.8
		if surface_name == "Human.body":
			material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_DEPTH_PRE_PASS
			material.albedo_texture = solid_picture
			material.normal_enabled = true
			material.normal_texture = solid_picture
		elif surface_name == "Human.mouth_dark":
			material.albedo_color = Color(0.2, 0.08, 0.08)
			material.metallic = 1.0
		surfaces.surface_set_material(surfaces.get_surface_count() - 1, material)
	head.mesh = surfaces
	human.add_child(head)
	var report := WasdSurface.human(human)
	var wanted := {"Human": "skin", "Human_low-poly": "eyes", "Human_high-poly": "eyes", "Human_teeth_base": "teeth", "Human_eyelashes01": "lashes",
			"Human_eyebrow001": "lashes", "Human_long01": "hair", "Human_skirt": "cutout", "Human_shirt": "solid", "Human_proxy741": "skin"}
	if report != wanted:
		return _fail("human() took the parts for %s" % [report])
	# A skin's normal map of no strength is a face's folds, which the skin presses in as the face moves; a normal
	# map of any strength is the skin's relief, as ever.
	var folding := (parts["Human"] as MeshInstance3D).get_active_material(0) as ShaderMaterial
	var relieved := head.get_active_material(0) as ShaderMaterial
	if (folding == null or relieved == null or folding.get_shader_parameter(&"has_relief") != true or folding.get_shader_parameter(&"has_folds") != true
			or relieved.get_shader_parameter(&"has_relief") != true or relieved.get_shader_parameter(&"has_folds") != false):
		return _fail("a skin with a face's folds takes them as %s, and a skin with relief of its own as %s" % [
				folding.get_shader_parameter(&"has_folds") if folding != null else null, relieved.get_shader_parameter(&"has_folds") if relieved != null else null])
	var mouth_now := head.get_active_material(1) as BaseMaterial3D
	var teeth_now := head.get_active_material(2) as BaseMaterial3D
	if (not head.get_active_material(0) is ShaderMaterial or mouth_now == null or mouth_now.albedo_color.r > 0.21 or mouth_now.metallic < 1.0
			or mouth_now.cull_mode != BaseMaterial3D.CULL_BACK or teeth_now == null or not is_equal_approx(teeth_now.roughness, 0.8)):
		return _fail("a head with a mouth inside it has the surfaces %s, %s, and %s" % [head.get_active_material(0), mouth_now, teeth_now])
	var shaders := {}
	for name: String in parts:
		var shown := (parts[name] as MeshInstance3D).get_active_material(0) as ShaderMaterial
		shaders[name] = shown.shader if shown != null else null
	var shaded := {"Human": WasdSurface.SKIN_SHADER, "Human_low-poly": WasdSurface.EYE_SHADER, "Human_high-poly": WasdSurface.EYE_SHADER,
			"Human_teeth_base": WasdSurface.MOUTH_SHADER, "Human_eyelashes01": WasdSurface.LASH_SHADER, "Human_eyebrow001": WasdSurface.LASH_SHADER,
			"Human_long01": WasdSurface.HAIR_SHADER, "Human_skirt": null, "Human_shirt": null}
	if shaders != shaded:
		return _fail("the human's parts have the shaders %s" % [shaders])
	# A card of lashes or brows casts no shadow: it would lie on the lid as a solid band.
	var casting := [(parts["Human_eyelashes01"] as MeshInstance3D).cast_shadow, (parts["Human_eyebrow001"] as MeshInstance3D).cast_shadow, (parts["Human_long01"] as MeshInstance3D).cast_shadow]
	if casting != [GeometryInstance3D.SHADOW_CASTING_SETTING_OFF, GeometryInstance3D.SHADOW_CASTING_SETTING_OFF, GeometryInstance3D.SHADOW_CASTING_SETTING_ON]:
		return _fail("lashes, brows, and hair cast shadows as %s" % [casting])
	var skirt_now := (parts["Human_skirt"] as MeshInstance3D).get_active_material(0) as BaseMaterial3D
	var shirt_now := (parts["Human_shirt"] as MeshInstance3D).get_active_material(0) as BaseMaterial3D
	if (skirt_now.transparency != BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR or shirt_now.transparency != BaseMaterial3D.TRANSPARENCY_DISABLED
			or shirt_now.cull_mode != BaseMaterial3D.CULL_BACK):
		return _fail("skirt transparency %d, shirt %d" % [skirt_now.transparency, shirt_now.transparency])
	# Brows are read softer than lashes, which are seen edge-on. One ball is one eye and shows no inner corner; a mesh
	# of two balls with a part of the picture each is a pair of eyes, and the shader is told where the picture has
	# each: the left eye is the one on the mesh's +X side.
	var brow_now := (parts["Human_eyebrow001"] as MeshInstance3D).get_active_material(0) as ShaderMaterial
	var lash_now := (parts["Human_eyelashes01"] as MeshInstance3D).get_active_material(0) as ShaderMaterial
	if not (float(brow_now.get_shader_parameter(&"sharp")) < float(lash_now.get_shader_parameter(&"sharp"))):
		return _fail("brows are read at %s and lashes at %s" % [brow_now.get_shader_parameter(&"sharp"), lash_now.get_shader_parameter(&"sharp")])
	# Lashes are cleared of what is faint between their hairs; brows keep the soft shade their hairs lie on.
	if float(brow_now.get_shader_parameter(&"clean")) != 0.0 or float(lash_now.get_shader_parameter(&"clean")) != 1.0:
		return _fail("brows are cleaned by %s and lashes by %s" % [brow_now.get_shader_parameter(&"clean"), lash_now.get_shader_parameter(&"clean")])
	var one_eye := (parts["Human_high-poly"] as MeshInstance3D).get_active_material(0) as ShaderMaterial
	var pair := ArrayMesh.new()
	var both := SurfaceTool.new()
	both.begin(Mesh.PRIMITIVE_TRIANGLES)
	for offset: float in [0.03, -0.03]:
		var ball_arrays := SphereMesh.new().get_mesh_arrays()
		var ball_points: PackedVector3Array = ball_arrays[Mesh.ARRAY_VERTEX]
		var ball_maps: PackedVector2Array = ball_arrays[Mesh.ARRAY_TEX_UV]
		for index: int in (ball_arrays[Mesh.ARRAY_INDEX] as PackedInt32Array):
			both.set_uv(Vector2((0.0 if offset > 0.0 else 0.5) + ball_maps[index].x * 0.5, ball_maps[index].y))
			both.add_vertex(ball_points[index] * 0.024 + Vector3(offset, 0.0, 0.0))
	both.commit(pair)
	var middles := WasdSurface.eye_middles(pair)
	if (one_eye.get_shader_parameter(&"eye_middles") != Vector4.ZERO or WasdSurface.eye_middles(SphereMesh.new()) != Vector4.ZERO
			or absf(middles.x - 0.25) > 0.02 or absf(middles.z - 0.75) > 0.02 or absf(middles.y - middles.w) > 0.02):
		return _fail("one eye has the middles %s, and a pair of eyes %s" % [one_eye.get_shader_parameter(&"eye_middles"), middles])
	# A second call finds nothing left to put right.
	if not WasdSurface.human(human).values().all(func(kind: String) -> bool: return kind == "solid" or kind == "cutout" or kind == "skin"):
		return _fail("a second human() changed parts it had put right: %s" % [WasdSurface.human(human)])
	# The human's own shaders draw without an error: each shows its picture's color, not the blue behind the wall.
	var drawn := {}
	var makers := {"skin": WasdSurface.skin, "eye": WasdSurface.eye, "mouth": WasdSurface.mouth, "lashes": WasdSurface.lashes, "hair": WasdSurface.hair}
	for kind: String in makers:
		wall.material_override = (makers[kind] as Callable).call(stone.albedo_texture) as Material
		drawn[kind] = (await _look_at_wall(kind + ".png"))["color"]
		if (drawn[kind] as Color).r < (drawn[kind] as Color).b * 1.3 or (drawn[kind] as Color).r < 0.05:
			return _fail("the %s shader draws %s" % [kind, drawn[kind]])
	print("SMOKE_PASS ", ID)
	get_tree().quit(0)
