# SPDX-License-Identifier: CC0-1.0
# Materials by name, with no texture files and no UV maps: `WasdSurface.make("bricks")` gives a material that lays
# its pattern out in meters of the world, so walls, floors, and boulders come out at the right scale whatever their
# mesh. Also correct materials from a folder of downloaded textures or from one picture, a toon look with an
# outline, glass, and a surface that glows. Every surface draws the same on Forward+, Mobile, and in Web builds.
class_name WasdSurface
extends RefCounted

const SURFACE_SHADER := preload("res://addons/wasd_materials/surface.gdshader")
const TOON_SHADER := preload("res://addons/wasd_materials/toon.gdshader")
const OUTLINE_SHADER := preload("res://addons/wasd_materials/outline.gdshader")
const GLASS_SHADER := preload("res://addons/wasd_materials/glass.gdshader")
const SKIN_SHADER := preload("res://addons/wasd_materials/skin.gdshader")
const EYE_SHADER := preload("res://addons/wasd_materials/eye.gdshader")
const MOUTH_SHADER := preload("res://addons/wasd_materials/mouth.gdshader")
const HAIR_SHADER := preload("res://addons/wasd_materials/hair.gdshader")
const LASH_SHADER := preload("res://addons/wasd_materials/lash.gdshader")
const CUTOUT_SHADER := preload("res://addons/wasd_materials/cutout.gdshader")
const OVERLAY_SHADER := preload("res://addons/wasd_materials/overlay.gdshader")

## The surfaces by name: each names only what differs from the shader's own values. Colors are the surface's own;
## `make()` takes another color and keeps the surface's character.
const SURFACES := {
	## Poured concrete: walls, floors, bunkers, sidewalks.
	"concrete": {"color": Color(0.56, 0.55, 0.53), "color_spots": Color(0.42, 0.41, 0.4), "spots": 0.6, "size": 2.5, "fine": 9.0, "shade": 0.14, "shade_fine": 0.16, "bump": 0.25, "bump_fine": 0.3, "roughness": 0.86,
		"hollows": 0.25, "specks": 0.25, "speck_color": Color(0.3, 0.3, 0.3)},
	## Painted plaster: interior walls, stucco houses.
	"plaster": {"color": Color(0.86, 0.83, 0.77), "color_spots": Color(0.78, 0.75, 0.69), "spots": 0.35, "size": 3.0, "fine": 6.0, "shade": 0.05, "shade_fine": 0.05, "bump": 0.12, "bump_fine": 0.15, "roughness": 0.9, "hollows": 0.08},
	## A road's surface.
	"asphalt": {"color": Color(0.17, 0.17, 0.18), "color_spots": Color(0.24, 0.24, 0.24), "spots": 0.4, "size": 2.0, "fine": 14.0, "shade": 0.12, "shade_fine": 0.45, "bump": 0.1, "bump_fine": 0.6, "roughness": 0.92,
		"specks": 0.6, "speck_color": Color(0.4, 0.4, 0.4), "hollows": 0.3},
	## Red bricks in mortar.
	"bricks": {"color": Color(0.56, 0.26, 0.19), "color_spots": Color(0.44, 0.2, 0.15), "spots": 0.5, "pattern": 1, "piece": Vector2(0.24, 0.075), "gap": 0.012, "gap_color": Color(0.72, 0.69, 0.63), "gap_depth": 0.7,
		"piece_spread": 0.34, "size": 0.8, "fine": 5.0, "shade": 0.14, "shade_fine": 0.22, "bump": 0.4, "bump_fine": 0.6, "roughness": 0.88, "hollows": 0.3},
	## Large cut stones: castle walls, old paving.
	"stone_blocks": {"color": Color(0.53, 0.51, 0.48), "color_spots": Color(0.42, 0.42, 0.4), "spots": 0.5, "pattern": 1, "piece": Vector2(0.62, 0.3), "gap": 0.02, "gap_color": Color(0.3, 0.29, 0.27), "gap_depth": 0.9,
		"piece_spread": 0.2, "size": 1.2, "fine": 6.0, "shade": 0.16, "shade_fine": 0.2, "bump": 0.4, "bump_fine": 0.4, "roughness": 0.9, "hollows": 0.3},
	## Glazed tiles: kitchens, baths, pools, clean floors.
	"tiles": {"color": Color(0.86, 0.87, 0.87), "color_spots": Color(0.8, 0.82, 0.83), "spots": 0.3, "pattern": 2, "piece": Vector2(0.3, 0.3), "gap": 0.006, "gap_color": Color(0.35, 0.35, 0.36), "gap_depth": 0.5,
		"piece_spread": 0.04, "size": 3.0, "fine": 8.0, "shade": 0.03, "shade_fine": 0.03, "bump": 0.04, "bump_fine": 0.04, "roughness": 0.18, "hollows": 0.0},
	## A wooden floor or wall of boards.
	"planks": {"color": Color(0.56, 0.39, 0.23), "color_spots": Color(0.42, 0.28, 0.16), "spots": 0.6, "pattern": 3, "piece": Vector2(1.8, 0.14), "gap": 0.004, "gap_color": Color(0.15, 0.1, 0.06), "gap_depth": 0.5,
		"piece_spread": 0.32, "size": 0.5, "fine": 5.0, "drawn_out": 9.0, "shade": 0.22, "shade_fine": 0.22, "bump": 0.12, "bump_fine": 0.28, "roughness": 0.62, "hollows": 0.15},
	## Wood without seams: beams, furniture, crates.
	"wood": {"color": Color(0.5, 0.34, 0.2), "color_spots": Color(0.38, 0.25, 0.14), "spots": 0.6, "size": 0.5, "fine": 5.0, "drawn_out": 10.0, "shade": 0.24, "shade_fine": 0.24, "bump": 0.12, "bump_fine": 0.3, "roughness": 0.66, "hollows": 0.15},
	## Brushed steel; with a color, any bare metal: gold, copper, brass.
	"metal": {"color": Color(0.62, 0.63, 0.65), "color_spots": Color(0.55, 0.56, 0.58), "spots": 0.2, "size": 1.6, "fine": 9.0, "shade": 0.04, "shade_fine": 0.02, "bump": 0.04, "bump_fine": 0.03,
		"roughness": 0.34, "roughness_spread": 0.07, "metallic": 1.0, "hollows": 0.0},
	## Painted metal with chipped paint: machines, doors, containers, vehicles.
	"painted_metal": {"color": Color(0.2, 0.4, 0.6), "color_spots": Color(0.17, 0.35, 0.53), "spots": 0.3, "size": 1.5, "fine": 6.0, "shade": 0.05, "shade_fine": 0.06, "bump": 0.04, "bump_fine": 0.14, "roughness": 0.45,
		"wear": 0.27, "wear_color": Color(0.5, 0.48, 0.46), "wear_roughness": 0.4, "wear_metallic": 1.0, "hollows": 0.0},
	## Rusted iron.
	"rust": {"color": Color(0.45, 0.24, 0.12), "color_spots": Color(0.3, 0.16, 0.09), "spots": 0.6, "size": 1.2, "fine": 8.0, "shade": 0.22, "shade_fine": 0.32, "bump": 0.3, "bump_fine": 0.5, "roughness": 0.9,
		"wear": 0.3, "wear_color": Color(0.4, 0.4, 0.42), "wear_roughness": 0.5, "wear_metallic": 1.0, "hollows": 0.35},
	## Bare rock: cliffs, boulders, caves.
	"rock": {"color": Color(0.47, 0.45, 0.42), "color_spots": Color(0.38, 0.36, 0.34), "spots": 0.38, "size": 3.5, "fine": 4.0, "shade": 0.18, "shade_fine": 0.2, "bump": 1.4, "bump_fine": 0.7, "roughness": 0.92, "hollows": 0.3},
	## Dry sand: beaches, deserts.
	"sand": {"color": Color(0.82, 0.72, 0.5), "color_spots": Color(0.76, 0.65, 0.43), "spots": 0.5, "size": 4.0, "fine": 16.0, "shade": 0.07, "shade_fine": 0.18, "bump": 0.2, "bump_fine": 0.3, "roughness": 0.95, "sparkle": 0.5,
		"specks": 0.2, "speck_color": Color(0.55, 0.45, 0.3), "hollows": 0.06},
	## Bare earth: paths, fields, cave floors.
	"dirt": {"color": Color(0.37, 0.28, 0.19), "color_spots": Color(0.28, 0.2, 0.13), "spots": 0.6, "size": 2.5, "fine": 10.0, "shade": 0.18, "shade_fine": 0.32, "bump": 0.35, "bump_fine": 0.5, "roughness": 0.95, "hollows": 0.3},
	## Ground under grass: lawns and meadows seen from some way off.
	"grass": {"color": Color(0.3, 0.45, 0.16), "color_spots": Color(0.4, 0.47, 0.2), "spots": 0.55, "size": 3.0, "fine": 14.0, "shade": 0.18, "shade_fine": 0.42, "bump": 0.15, "bump_fine": 0.6, "roughness": 0.9, "hollows": 0.3},
	## Fresh snow.
	"snow": {"color": Color(0.92, 0.94, 0.97), "color_spots": Color(0.82, 0.87, 0.95), "spots": 0.4, "size": 4.0, "fine": 9.0, "shade": 0.04, "shade_fine": 0.05, "bump": 0.25, "bump_fine": 0.15, "roughness": 0.7, "sparkle": 1.0, "hollows": 0.0},
	## Smooth plastic in any color: toys, props, casings.
	"plastic": {"color": Color(0.8, 0.2, 0.18), "color_spots": Color(0.8, 0.2, 0.18), "spots": 0.0, "size": 1.0, "fine": 8.0, "shade": 0.0, "shade_fine": 0.02, "bump": 0.0, "bump_fine": 0.04, "roughness": 0.4, "hollows": 0.0},
	## Rubber: tires, mats, grips.
	"rubber": {"color": Color(0.09, 0.09, 0.09), "color_spots": Color(0.12, 0.12, 0.12), "spots": 0.3, "size": 1.0, "fine": 10.0, "shade": 0.05, "shade_fine": 0.1, "bump": 0.05, "bump_fine": 0.15, "roughness": 0.85, "hollows": 0.05},
	## Woven cloth: carpets, upholstery, tents, banners.
	"fabric": {"color": Color(0.35, 0.4, 0.55), "color_spots": Color(0.3, 0.35, 0.5), "spots": 0.3, "size": 0.3, "fine": 12.0, "shade": 0.05, "shade_fine": 0.3, "bump": 0.1, "bump_fine": 0.6, "roughness": 0.96, "hollows": 0.2},
	## A builder's grid with a line every meter and a stronger one every five: blocking out a level.
	"grid": {"color": Color(0.34, 0.36, 0.4), "color_spots": Color(0.34, 0.36, 0.4), "spots": 0.0, "pattern": 4, "piece": Vector2(1.0, 1.0), "gap": 0.03, "gap_color": Color(0.78, 0.8, 0.84), "size": 4.0, "fine": 8.0,
		"shade": 0.03, "shade_fine": 0.03, "bump": 0.0, "bump_fine": 0.04, "roughness": 0.8, "hollows": 0.0},
}

static var _grain: ImageTexture
static var _white_pixel: ImageTexture
## Whether a picture has see-through parts, by the picture: looked up once.
static var _holes := {}


## The names of the surfaces.
static func names() -> PackedStringArray:
	return PackedStringArray(SURFACES.keys())


## A material for a surface by name. Options, all optional: `color` (Color) recolors the surface and keeps its
## character; `size` (float) makes its pattern that many times larger; `roughness` (float) sets its own;
## `bump` (float) multiplies its relief; `with_object` (bool) lays the pattern out in the object's own meters, so
## that it moves with a prop or a vehicle instead of standing still in the world. Any other key sets the shader
## value of that name. An unknown surface gives "concrete" and a warning. Keep the material and give it to every
## mesh of that surface.
static func make(surface: String, options := {}) -> ShaderMaterial:
	if not SURFACES.has(surface):
		push_warning("WasdSurface: no surface named %s; the surfaces are %s." % [surface, ", ".join(names())])
		surface = "concrete"
	var values: Dictionary = (SURFACES[surface] as Dictionary).duplicate()
	if options.has("color"):
		# The blotches keep their relation to the main color.
		var was: Color = values["color"]
		var spots: Color = values["color_spots"]
		var now: Color = options["color"]
		values["color_spots"] = Color(now.r * spots.r / maxf(was.r, 0.01), now.g * spots.g / maxf(was.g, 0.01), now.b * spots.b / maxf(was.b, 0.01)).clamp()
		values["color"] = now
	var larger: float = options.get("size", 1.0)
	if larger != 1.0:
		values["size"] = float(values["size"]) * larger
		if values.has("piece"):
			values["piece"] = (values["piece"] as Vector2) * larger
			values["gap"] = float(values["gap"]) * larger
	var relief: float = options.get("bump", 1.0)
	values["bump"] = float(values["bump"]) * relief
	values["bump_fine"] = float(values["bump_fine"]) * relief
	for key: String in options:
		if key not in ["color", "size", "bump"]:
			values[key] = options[key]
	var material := ShaderMaterial.new()
	material.shader = SURFACE_SHADER
	material.set_shader_parameter(&"grain", _grain_texture())
	for key: String in values:
		material.set_shader_parameter(key, values[key])
	return material


## A material from a folder of downloaded textures, such as one that `polyhaven_download` or `ambientcg_download`
## filled: it finds the color, normal, roughness, metal, and ambient occlusion pictures by their names and lays them
## out from three sides in meters of the world, so the mesh needs no UV map. Options: `size` (float, 2): meters
## across one repeat of the pictures; `with_object` (bool): lay them out in the object's own meters; `uv` (bool): use
## the mesh's own UV map instead. Returns null with a warning if the folder has no color picture.
static func from_folder(folder: String, options := {}) -> StandardMaterial3D:
	var found := _pictures(folder)
	if not found.has("color"):
		push_warning("WasdSurface: %s has no color picture (a name with diff, color, albedo, or basecolor)." % [folder])
		return null
	var material := StandardMaterial3D.new()
	material.albedo_texture = load(found["color"])
	if found.has("normal"):
		material.normal_enabled = true
		material.normal_texture = load(found["normal"])
	if found.has("packed"):
		# One picture with ambient occlusion in red, roughness in green, and metal in blue.
		var packed: Texture2D = load(found["packed"])
		material.ao_enabled = true
		material.ao_texture = packed
		material.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_RED
		material.roughness_texture = packed
		material.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GREEN
		material.metallic_texture = packed
		material.metallic_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_BLUE
		material.metallic = 1.0
	else:
		if found.has("roughness"):
			material.roughness_texture = load(found["roughness"])
			material.roughness_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GRAYSCALE
		if found.has("metal"):
			material.metallic_texture = load(found["metal"])
			material.metallic_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GRAYSCALE
			material.metallic = 1.0
		if found.has("occlusion"):
			material.ao_enabled = true
			material.ao_texture = load(found["occlusion"])
			material.ao_texture_channel = BaseMaterial3D.TEXTURE_CHANNEL_GRAYSCALE
	_lay_out(material, options)
	return material


## A cut-out material from a folder of downloaded textures that has an opacity picture, such as a leaf atlas or a
## decal that `ambientcg_download` filled: the color picture shows only where the opacity picture is light, on the
## mesh's own UV map and from both sides. Options: `threshold` (float, 0.5): the opacity below which nothing is
## drawn; `region` (Rect2, the whole picture): the part of the pictures to show, in shares of their size, for one
## piece of an atlas; `shine_through` (float, 0): how much light passes through from behind, for leaves; `soft`
## (bool): blend with soft edges instead of cutting, for stains, leaks, and road lines on a quad laid just above a
## surface, with `strength` (float, 1). Returns null with a warning if the folder lacks a color or an opacity
## picture.
static func cutout(folder: String, options := {}) -> ShaderMaterial:
	var found := _pictures(folder)
	if not found.has("color") or not found.has("opacity"):
		push_warning("WasdSurface: %s needs a color and an opacity picture for a cut-out." % [folder])
		return null
	var soft: bool = options.get("soft", false)
	var material := ShaderMaterial.new()
	material.shader = OVERLAY_SHADER if soft else CUTOUT_SHADER
	material.set_shader_parameter(&"color_map", load(found["color"]))
	material.set_shader_parameter(&"opacity_map", load(found["opacity"]))
	if found.has("normal"):
		material.set_shader_parameter(&"normal_map", load(found["normal"]))
		material.set_shader_parameter(&"has_normal", true)
	if found.has("roughness"):
		material.set_shader_parameter(&"roughness_map", load(found["roughness"]))
		material.set_shader_parameter(&"has_roughness", true)
	var region: Rect2 = options.get("region", Rect2(0.0, 0.0, 1.0, 1.0))
	material.set_shader_parameter(&"region", Vector4(region.position.x, region.position.y, region.size.x, region.size.y))
	if soft:
		material.set_shader_parameter(&"strength", options.get("strength", 1.0))
	else:
		material.set_shader_parameter(&"threshold", options.get("threshold", 0.5))
		material.set_shader_parameter(&"shine_through", options.get("shine_through", 0.0))
	return material


## A material from one picture: its relief is worked out from the picture's light and dark, so a flat photograph
## or a generated texture takes the light like a surface. Options as for `from_folder`, and `bump` (float, 1): how
## strong the relief is; `roughness` (float, 0.8).
static func from_picture(picture: Texture2D, options := {}) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_texture = picture
	material.roughness = options.get("roughness", 0.8)
	var relief := picture.get_image()
	if relief != null and not relief.is_empty():
		if relief.is_compressed():
			relief.decompress()
		relief.convert(Image.FORMAT_RGBA8)
		relief.bump_map_to_normal_map(float(options.get("bump", 1.0)) * 8.0)
		relief.generate_mipmaps()
		material.normal_enabled = true
		material.normal_texture = ImageTexture.create_from_image(relief)
	_lay_out(material, options)
	return material


## A toon material: light in flat steps, a rim, an optional highlight, and an outline. Options: `picture`
## (Texture2D) on the mesh's UV map; `steps` (int, 2) of light; `soft` (float, 0.03) edge between steps; `rim`
## (float, 0.25); `shine` (float, 0): the size of a hard highlight; `outline` (float, 2): its width in pixels, 0
## for none; `outline_color` (Color, near black).
static func toon(color: Color, options := {}) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = TOON_SHADER
	material.set_shader_parameter(&"color", color)
	material.set_shader_parameter(&"steps", float(options.get("steps", 2)))
	material.set_shader_parameter(&"soft", options.get("soft", 0.03))
	material.set_shader_parameter(&"rim", options.get("rim", 0.25))
	material.set_shader_parameter(&"shine", options.get("shine", 0.0))
	if options.has("picture"):
		material.set_shader_parameter(&"picture", options["picture"])
	var width: float = options.get("outline", 2.0)
	if width > 0.0:
		var line := ShaderMaterial.new()
		line.shader = OUTLINE_SHADER
		line.set_shader_parameter(&"width", width)
		line.set_shader_parameter(&"color", options.get("outline_color", Color(0.05, 0.05, 0.07)))
		material.next_pass = line
	return material


## Glass: clear seen straight on, mirroring the sky seen along it. `color` tints it; options: `clear` (float,
## 0.85): how much shows through seen straight on; `roughness` (float, 0.04): higher frosts the reflections.
static func glass(color := Color(0.8, 0.9, 1.0), options := {}) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = GLASS_SHADER
	material.set_shader_parameter(&"color", color)
	material.set_shader_parameter(&"clear", options.get("clear", 0.85))
	material.set_shader_parameter(&"roughness", options.get("roughness", 0.04))
	return material


## A surface that glows in a color: a lamp's bulb, a screen, neon, lava, a magic rune. With an `energy` above 2
## it also gets a halo where the scene's glow is on.
static func glow(color: Color, energy := 3.0) -> StandardMaterial3D:
	var material := StandardMaterial3D.new()
	material.albedo_color = color.darkened(0.6)
	material.emission_enabled = true
	material.emission = color
	material.emission_energy_multiplier = energy
	material.roughness = 0.5
	return material


## Skin from a color picture: light wraps round into the shade and turns warm there, which stands in for
## subsurface scattering in Web builds, its oily parts shine in patches, a close view shows its pores, and the
## picture's own lines, such as wrinkles, are pressed into it. Options: `relief` (Texture2D): a normal map; `gloss`
## (Texture2D): a picture whose green is the roughness, such as a glTF material's; `shade` (Texture2D): a picture
## whose red is how open each point lies to the sky, such as a glTF material's occlusion; `tint` (Color);
## `roughness` (float, 0.5), where there is no `gloss`; `soft` (float, 0.36): how far light wraps; `shine` (float, 0.75):
## how strong the highlights are; `pores` (float, 0.3): how deep the pores; `creases` (float, 0.45): how deep the
## picture's lines; `folds` (bool): the relief is that of a face's folds, as the mpfb guide's humans bring it, with
## the mesh's second UV map telling where a smile (U) and a frown (V) fold the face: the skin then presses the folds
## in only as far as a WasdFace3D says the face smiles and frowns.
static func skin(picture: Texture2D, options := {}) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = SKIN_SHADER
	material.set_shader_parameter(&"picture", picture if picture != null else _white())
	material.set_shader_parameter(&"grain", _grain_texture())
	if options.get("relief") != null:
		material.set_shader_parameter(&"relief", options["relief"])
		material.set_shader_parameter(&"has_relief", true)
	if options.get("gloss") != null:
		material.set_shader_parameter(&"gloss", options["gloss"])
		material.set_shader_parameter(&"has_gloss", true)
	if options.get("shade") != null:
		material.set_shader_parameter(&"shade", options["shade"])
		material.set_shader_parameter(&"has_shade", true)
	material.set_shader_parameter(&"tint", options.get("tint", Color.WHITE))
	material.set_shader_parameter(&"roughness", options.get("roughness", 0.5))
	material.set_shader_parameter(&"soft", options.get("soft", 0.36))
	material.set_shader_parameter(&"shine", options.get("shine", 0.75))
	material.set_shader_parameter(&"pores", options.get("pores", 0.3))
	material.set_shader_parameter(&"creases", options.get("creases", 0.45))
	material.set_shader_parameter(&"has_folds", bool(options.get("folds", false)))
	return material


## An eye from its picture: wet, with a small catchlight that keeps its place before the viewer wherever the
## scene's lights stand, as bright as the light on the eye. `catchlight` (0 to 2) is its share. `middles` is for a mesh that
## holds both eyes of a face: where the picture has the middle of the left eye (x, y) and of the right eye (z, w),
## as `eye_middles` tells of a mesh. Such eyes show the pink flesh of their inner corners, toward the nose, which
## stays in its place while an eye turns.
static func eye(picture: Texture2D, catchlight := 1.0, middles := Vector4.ZERO) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = EYE_SHADER
	material.set_shader_parameter(&"picture", picture)
	material.set_shader_parameter(&"catchlight", catchlight)
	material.set_shader_parameter(&"eye_middles", middles)
	return material


## Where the picture of a mesh's surface has each of the two eyes that the mesh holds: the middle of the UV map of
## what lies on the mesh's +X side, a character's left eye, as (x, y), and of what lies on its -X side, as (z, w).
## Nothing for a mesh of one eye, which has points at its own middle, and for eyes that share one part of the
## picture.
static func eye_middles(mesh: Mesh, surface := 0) -> Vector4:
	var arrays := mesh.surface_get_arrays(surface)
	var points: PackedVector3Array = arrays[Mesh.ARRAY_VERTEX]
	if arrays[Mesh.ARRAY_TEX_UV] == null:
		return Vector4.ZERO
	var maps: PackedVector2Array = arrays[Mesh.ARRAY_TEX_UV]
	var widest := 0.0
	for point: Vector3 in points:
		widest = maxf(widest, absf(point.x))
	var sums := [Vector2.ZERO, Vector2.ZERO]
	var counts := [0, 0]
	for index: int in mini(points.size(), maps.size()):
		# Two eyes leave the middle between them empty.
		if absf(points[index].x) < widest * 0.15:
			return Vector4.ZERO
		var side := 0 if points[index].x > 0.0 else 1
		sums[side] += maps[index]
		counts[side] += 1
	if counts[0] == 0 or counts[1] == 0:
		return Vector4.ZERO
	var left: Vector2 = sums[0] / counts[0]
	var right: Vector2 = sums[1] / counts[1]
	return Vector4(left.x, left.y, right.x, right.y) if left.distance_to(right) > 0.05 else Vector4.ZERO


## Hair from its picture, whose see-through parts are its strands' ends: solid where the picture is, soft at its
## edges, and broken up into strands where the mesh says that the hair thins out, in the alpha of its vertices'
## color, as the mpfb guide's humans say it along their hairline. `tint` colors the picture. Options: `strands`
## (float, 220): how many strands lie side by side across the picture; `across` (bool): the strands run across the
## picture instead of down it.
static func hair(picture: Texture2D, tint := Color.WHITE, options := {}) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = HAIR_SHADER
	material.set_shader_parameter(&"picture", picture if picture != null else _white())
	material.set_shader_parameter(&"grain", _grain_texture())
	material.set_shader_parameter(&"tint", tint)
	material.set_shader_parameter(&"strands", options.get("strands", 220.0))
	material.set_shader_parameter(&"strands_across", options.get("across", false))
	return material


## Eyelashes or eyebrows from their picture, whose see-through parts lie between the hairs: each hair stays thin
## and dark from any side, where a blended material blurs a lash card seen edge-on into a film over the lid.
## `tint` colors the picture. `sharp` is how many sizes sharper than the screen asks for the picture is read: 1
## for lashes, which are seen edge-on, and less for brows, which lie flat on the face and are a soft band of hair from
## a step away, not single dark lines. `clean` is how far what is faint in the picture is cleared away: 1 for lashes,
## which leaves skin between their hairs, and 0 for brows, which keeps the soft shade their hairs lie on.
static func lashes(picture: Texture2D, tint := Color.WHITE, sharp := 1.0, clean := 1.0) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = LASH_SHADER
	material.set_shader_parameter(&"picture", picture if picture != null else _white())
	material.set_shader_parameter(&"tint", tint)
	material.set_shader_parameter(&"sharp", sharp)
	material.set_shader_parameter(&"clean", clean)
	return material


## The inside of a mouth from its picture: teeth, gums, or a tongue, which take little of the scene's light and
## mirror none of its sky. `tint` colors the picture; without a picture it is the color.
static func mouth(picture: Texture2D, tint := Color.WHITE) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = MOUTH_SHADER
	material.set_shader_parameter(&"picture", picture if picture != null else _white())
	material.set_shader_parameter(&"tint", tint)
	return material


## Puts right the materials of a human under `root`, such as one made with MPFB (MakeHuman) and exported as .glb.
## Such a character may come in with every material see-through, and its eyes, teeth, and the back of its hair then
## show through its face. This makes skin, eyes, teeth, and whole cloth solid, gives the body the skin shader, the
## eyes their shade, shine, and catchlight, and the teeth and tongue the mouth's shader, lets hair thin out along
## its hairline, blends brows and lashes over the skin, and cuts cloth with holes out. It tells the parts by their
## names (body or skin, eye, teeth or tongue, brow, lash, hair) and the rest by whether their picture has holes.
## Returns what it took each mesh for, by its first surface: "skin", "eyes", "teeth", "lashes", "hair", "cutout",
## or "solid".
static func human(root: Node) -> Dictionary:
	var report := {}
	var meshes: Array[Node] = root.find_children("*", "MeshInstance3D", true, false)
	if root is MeshInstance3D:
		meshes.append(root)
	for node: Node in meshes:
		var mesh := node as MeshInstance3D
		if mesh.mesh == null:
			continue
		for surface: int in mesh.mesh.get_surface_count():
			var material := mesh.get_active_material(surface) as BaseMaterial3D
			if material == null:
				continue
			var name := ("%s %s" % [mesh.name, material.resource_name]).to_lower()
			var kind := "solid"
			# Brown eyes are no brows.
			if name.replace("brown", "").contains("brow") or name.contains("lash"):
				kind = "lashes"
			elif name.contains("teeth") or name.contains("tooth") or name.contains("tongue"):
				kind = "teeth"
			elif name.contains("eye") or name.ends_with("low-poly") or name.ends_with("high-poly"):
				kind = "eyes"
			elif name.contains("body") or name.contains("skin"):
				kind = "skin"
			elif name.contains("hair"):
				kind = "hair"
			elif _has_holes(material.albedo_texture):
				kind = "cutout"
			# A head's mesh may hold the inside of its mouth after its skin: the mesh counts as its first surface.
			if not report.has(String(mesh.name)):
				report[String(mesh.name)] = kind
			if kind == "lashes":
				# Fine hairs that lie on the skin: blended over it, which is safe now that the skin under them is solid.
				# Their cards cast no shadow: a card's would lie on the lid and the eye as a solid band.
				var brows := name.contains("brow")
				mesh.set_surface_override_material(surface, lashes(material.albedo_texture, material.albedo_color, 0.5 if brows else 1.0, 0.0 if brows else 1.0))
				mesh.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
				continue
			if kind == "hair":
				mesh.set_surface_override_material(surface, hair(material.albedo_texture, material.albedo_color))
				continue
			if kind == "cutout":
				# Cloth with holes, and hair that does not say what it is: cut out, not blended. Every pixel is either
				# there or not, so its layers need no sorting; where the view smooths edges, the cut's edge is smoothed
				# with them.
				material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA_SCISSOR
				material.alpha_scissor_threshold = 0.4
				material.alpha_antialiasing_mode = BaseMaterial3D.ALPHA_ANTIALIASING_ALPHA_TO_COVERAGE
				material.alpha_antialiasing_edge = 0.3
				material.cull_mode = BaseMaterial3D.CULL_DISABLED
				continue
			material.transparency = BaseMaterial3D.TRANSPARENCY_DISABLED
			material.cull_mode = BaseMaterial3D.CULL_BACK
			if kind == "eyes":
				# A mesh that holds both eyes has an inner corner for each.
				mesh.set_surface_override_material(surface, eye(material.albedo_texture, 1.0, eye_middles(mesh.mesh, surface)))
			elif kind == "teeth":
				mesh.set_surface_override_material(surface, mouth(material.albedo_texture, material.albedo_color))
			elif kind == "skin":
				mesh.set_surface_override_material(surface, skin(material.albedo_texture, {
					"relief": material.normal_texture if material.normal_enabled else null,
					"gloss": material.roughness_texture, "shade": material.ao_texture if material.ao_enabled else null,
					"tint": material.albedo_color, "roughness": 0.5,
					# A normal map of no strength is a face's folds, as the mpfb guide's humans bring them: a
					# stock material shows none of them, and this skin presses them in as the face moves.
					"folds": material.normal_enabled and is_zero_approx(material.normal_scale),
				}))
	return report


## One white pixel, for a shader that asks for a picture where a material has only a color.
static func _white() -> ImageTexture:
	if _white_pixel == null:
		var image := Image.create(1, 1, false, Image.FORMAT_RGB8)
		image.fill(Color.WHITE)
		_white_pixel = ImageTexture.create_from_image(image)
	return _white_pixel


## Whether a picture has see-through parts.
static func _has_holes(picture: Texture2D) -> bool:
	if picture == null:
		return false
	if _holes.has(picture.get_rid()):
		return _holes[picture.get_rid()]
	var found := false
	var image := picture.get_image()
	if image != null and not image.is_empty() and (not image.is_compressed() or image.decompress() == OK):
		found = image.detect_alpha() != Image.ALPHA_NONE
	_holes[picture.get_rid()] = found
	return found


## Gives a material to every mesh and CSG shape under `node`, `node` included.
static func paint(node: Node, material: Material) -> void:
	for part: Node in [node] + node.find_children("*", "GeometryInstance3D", true, false):
		if part is MeshInstance3D or part is MultiMeshInstance3D:
			(part as GeometryInstance3D).material_override = material
		elif part is CSGPrimitive3D:
			(part as CSGPrimitive3D).material = material


## The words in a picture's file name that tell what it holds.
const _PICTURE_WORDS := {
	"color": ["_diff", "diffuse", "albedo", "basecolor", "base_color", "_col_", "_color"],
	"normal": ["_nor_gl", "normal_gl", "normalgl", "_nor", "normal"],
	"packed": ["_arm", "_orm"],
	"roughness": ["_rough", "roughness"],
	"metal": ["_metal", "metallic", "metalness"],
	"occlusion": ["_ao", "ambientocclusion", "occlusion"],
	"opacity": ["_opacity", "_alpha", "_mask"],
}


## The pictures of a folder of downloaded textures by what they hold: `color`, `normal`, `packed`, `roughness`,
## `metal`, `occlusion`, and `opacity`, each with the picture's path. A name's words tell them apart.
static func _pictures(folder: String) -> Dictionary:
	var found := {}
	for file: String in DirAccess.get_files_at(folder):
		# An exported game lists a picture by its import file.
		var name := file.trim_suffix(".import").trim_suffix(".remap")
		if name.get_extension().to_lower() not in ["png", "jpg", "jpeg", "webp", "exr", "tga", "bmp"]:
			continue
		var plain := name.get_basename().to_lower()
		for kind: String in _PICTURE_WORDS:
			if found.has(kind):
				continue
			for word: String in _PICTURE_WORDS[kind]:
				if plain.contains(word) and not (kind == "normal" and _is_directx(plain)):
					found[kind] = folder.path_join(name)
					break
			if found.get(kind, "") == folder.path_join(name):
				break
	return found


## Whether a picture's name marks a DirectX normal map, whose green channel points the other way than Godot reads
## it: Poly Haven's `nor_dx` and ambientCG's `NormalDX`.
static func _is_directx(plain: String) -> bool:
	return plain.contains("_dx") or plain.contains("normaldx") or plain.contains("directx")


static func _lay_out(material: StandardMaterial3D, options: Dictionary) -> void:
	material.texture_filter = BaseMaterial3D.TEXTURE_FILTER_LINEAR_WITH_MIPMAPS_ANISOTROPIC
	if options.get("uv", false):
		return
	material.uv1_triplanar = true
	material.uv1_world_triplanar = not bool(options.get("with_object", false))
	material.uv1_scale = Vector3.ONE / maxf(float(options.get("size", 2.0)), 0.01)
	material.uv1_triplanar_sharpness = 4.0


## The one small picture every surface shares: a noise's slope in red and green, its height in blue, and a second
## noise in alpha, made once in code.
static func _grain_texture() -> ImageTexture:
	if _grain != null:
		return _grain
	const SIDE := 256
	var first := FastNoiseLite.new()
	first.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	first.seed = 11
	first.frequency = 0.016
	first.fractal_octaves = 5
	var second := FastNoiseLite.new()
	second.noise_type = FastNoiseLite.TYPE_SIMPLEX_SMOOTH
	second.seed = 47
	second.frequency = 0.022
	second.fractal_octaves = 4
	var height := first.get_seamless_image(SIDE, SIDE).get_data()
	var other := second.get_seamless_image(SIDE, SIDE).get_data()
	var pixels := PackedByteArray()
	pixels.resize(SIDE * SIDE * 4)
	for y: int in SIDE:
		var above := ((y + SIDE - 1) % SIDE) * SIDE
		var below := ((y + 1) % SIDE) * SIDE
		var row := y * SIDE
		for x: int in SIDE:
			var left := (x + SIDE - 1) % SIDE
			var right := (x + 1) % SIDE
			var at := (row + x) * 4
			# The slope across and down, the height, and the second noise.
			pixels[at] = clampi(128 + (height[row + left] - height[row + right]) * 8, 0, 255)
			pixels[at + 1] = clampi(128 + (height[above + x] - height[below + x]) * 8, 0, 255)
			pixels[at + 2] = height[row + x]
			pixels[at + 3] = other[row + x]
	var image := Image.create_from_data(SIDE, SIDE, false, Image.FORMAT_RGBA8, pixels)
	image.generate_mipmaps()
	_grain = ImageTexture.create_from_image(image)
	return _grain
