# SPDX-License-Identifier: CC0-1.0
# A body of water: it builds its mesh (a rectangle, a disc, a sea that follows the camera, or a ribbon along a Path3D),
# draws it with water.gdshader, moves it with waves, mirrors the scene when `reflection` asks for it, and answers
# where the surface is, so that things float and swim. `preset` picks a look by name and every property after it
# changes that look. While the camera is under the surface it tints and fogs the view. It runs on the Forward+,
# Mobile, and Compatibility renderers.
class_name WasdWater3D
extends MeshInstance3D

## The camera went under this water's surface.
signal camera_submerged
## The camera came back above this water's surface.
signal camera_surfaced

enum Shape {
	## `size` meters along X and Z, centered on the node.
	RECTANGLE,
	## An ellipse `size` meters across.
	DISC,
	## A sea to the horizon, `size.x` meters across, that stays under the camera.
	INFINITE,
	## A ribbon `size.x` meters wide along the Path3D that `path` names: rivers, streams, waterfalls.
	PATH,
	## The mesh this node already has, such as a lake's outline modeled in Blender.
	CUSTOM,
}

enum Quality {
	## Refraction, depth colors, shore foam, caustics, mirrored scenery, and a soft edge.
	FULL,
	## None of those, and no screen or depth reads: for slow phones and crowded Web scenes.
	FAST,
}

enum Reflection {
	## The sky and the scene's ReflectionProbes: free, and all that slow devices should draw.
	SKY,
	## Also what is on screen above the water, found by following mirrored rays through the picture. It shows
	## nothing that is off screen or hidden behind something else.
	SCREEN,
	## Also the scene drawn a second time by a mirror camera: exact for level water, and it doubles the drawing.
	PLANAR,
}

## Group of every WasdWater3D in the scene tree.
const GROUP := &"wasd_water"
const MAX_WAVES := 32
const MAX_RINGS := 8
const GRAVITY := 9.81
## The render layer a water with a PLANAR reflection draws on. Its mirror camera leaves that layer out, so the
## water does not mirror itself.
const MIRROR_HIDDEN_LAYER := 20
## The foam's built-in pattern: sea-foam lace, bright where foam shows first, drawn for this add-on with an image
## generator and made to tile in GIMP; like the rest of the add-on it is CC0. Without the file, noise stands in.
const FOAM_PATTERN := "res://addons/wasd_water/foam.png"
## Each wave is this much shorter than the one before it.
const WAVE_RATIO := 0.78
## height_at() adds up this many of the longest waves; the rest are too small to move a boat.
const QUERY_WAVES := 16
## The mesh moves sideways by this part of what the shading shows (MESH_PINCH in water.gdshaderinc), so that the
## steepest crests do not turn triangles over.
const MESH_PINCH := 0.6
## Each cell of an infinite sea is this much wider than the one nearer the camera.
const SEA_GROWTH := 1.07
## Cells of an infinite sea that keep the size `cell`, counted from the camera, before they grow.
const SEA_CORE := 24
## Properties that are shader uniforms of the same name.
const UNIFORMS: Array[StringName] = [
	&"shallow_color", &"deep_color", &"color_depth", &"clarity", &"color_steps", &"glow", &"scatter_color",
	&"scatter_strength", &"fast_opacity", &"roughness", &"reflectivity", &"refraction", &"surface_scale",
	&"surface_strength", &"surface_speed", &"glint_strength", &"glint_size", &"glint_hardness", &"glint_sparkle",
	&"flat_shading",
	&"pixel_size", &"flow", &"foam_color", &"foam_scale", &"foam_speed", &"foam_stretch",
	&"foam_hardness", &"shore_foam_width", &"shore_foam", &"shore_foam_lines", &"crest_foam", &"foam_trail",
	&"foam_trail_waves", &"slope_foam", &"caustics", &"caustics_scale", &"caustics_depth", &"edge_fade",
	&"reflection_steps", &"reflection_distance", &"reflection_distortion",
]

## The look, by name: lake, spring, pond, river, calm_sea, ocean, storm, tropical, swamp, arctic, pool, toon,
## low_poly, retro, lava, or toxic (WasdWaterPresets). Setting it puts every property of the groups below Shape back
## to that look, so set it first and change single properties after it. Empty keeps the properties as they are.
@export var preset := "":
	set(value):
		preset = value
		if value == "":
			return
		var look := WasdWaterPresets.values(value)
		if look.is_empty():
			push_warning("WasdWater3D: no preset named \"%s\". The presets are %s." % [value, ", ".join(WasdWaterPresets.names())])
			return
		for key: String in look:
			set(key, look[key])

@export_group("Shape")
@export var shape := Shape.RECTANGLE:
	set(value):
		shape = value
		_queue_rebuild()
## Meters along X and Z. A disc is this far across, an infinite sea `size.x` across, and a path `size.x` wide.
@export var size := Vector2(40.0, 40.0):
	set(value):
		size = value.abs().max(Vector2(0.1, 0.1))
		_queue_rebuild()
## Distance between the mesh's vertices in meters. Waves shorter than about five cells only shade the surface and
## do not move it; a smaller cell costs more vertices. An infinite sea has cells of this size under the camera,
## which grow with distance.
@export_range(0.05, 20.0, 0.05, "suffix:m") var cell := 0.5:
	set(value):
		cell = maxf(value, 0.05)
		_queue_rebuild()
## The Path3D a PATH shape follows. The water flows from the curve's start to its end.
@export_node_path("Path3D") var path: NodePath:
	set(value):
		path = value
		_queue_rebuild()
## How far below its surface the water reaches, for is_underwater() and floaters.
@export_range(0.1, 1000.0, 0.1, "suffix:m") var depth := 50.0
@export var quality := Quality.FULL:
	set(value):
		quality = value
		if _material != null:
			_material.shader = _shader()
## Speed of the water's time: 0 freezes waves, ripples, and foam.
@export_range(0.0, 4.0, 0.01) var time_scale := 1.0

@export_group("Color")
## The tint light takes on in `color_depth` meters of water: how a pale bottom looks at that depth. Red fades
## first in real water, which is why shallows are green or turquoise.
@export var shallow_color := Color(0.32, 0.72, 0.60):
	set(value):
		shallow_color = value
		_uniform(&"shallow_color", value)
## The water's own color, seen where it is too deep or too cloudy to show the bottom.
@export var deep_color := Color(0.02, 0.15, 0.14):
	set(value):
		deep_color = value
		_uniform(&"deep_color", value)
## Depth of water over which light takes on `shallow_color`; twice the depth tints twice over.
@export_range(0.05, 100.0, 0.05, "suffix:m") var color_depth := 3.0:
	set(value):
		color_depth = value
		_uniform(&"color_depth", value)
## How far one sees through the water: the bottom fades into the water's color over this distance.
@export_range(0.01, 200.0, 0.01, "suffix:m") var clarity := 20.0:
	set(value):
		clarity = value
		_uniform(&"clarity", value)
## 0 blends the colors smoothly; 2 or more draws that many flat color bands, as toon water has.
@export_range(0, 8) var color_steps := 0:
	set(value):
		color_steps = value
		_uniform(&"color_steps", value)
## Light the water gives off, as lava does: 0 none, 1 its own color; more blooms with the Environment's glow.
@export_range(0.0, 8.0, 0.01) var glow := 0.0:
	set(value):
		glow = value
		_uniform(&"glow", value)
## Color of the sunlight that passes through wave crests.
@export var scatter_color := Color(0.10, 0.70, 0.55):
	set(value):
		scatter_color = value
		_uniform(&"scatter_color", value)
## How brightly wave crests light up where the sun shines through them; 0 for water without waves.
@export_range(0.0, 3.0, 0.01) var scatter_strength := 0.0:
	set(value):
		scatter_strength = value
		_uniform(&"scatter_strength", value)
## FAST quality only: how opaque the water is seen from straight above.
@export_range(0.0, 1.0, 0.01) var fast_opacity := 0.75:
	set(value):
		fast_opacity = value
		_uniform(&"fast_opacity", value)

@export_group("Surface")
## How much the surface blurs the mirrored sky: 0 is a mirror. Waves too far away to see add to it by themselves.
@export_range(0.0, 1.0, 0.01) var roughness := 0.05:
	set(value):
		roughness = value
		_uniform(&"roughness", value)
## Scales every mirror image on the surface, the sky's and the scene's: 1 is water, 0 none.
@export_range(0.0, 1.0, 0.01) var reflectivity := 1.0:
	set(value):
		reflectivity = value
		_uniform(&"reflectivity", value)
## How far the surface bends the view of what lies under it.
@export_range(0.0, 4.0, 0.01) var refraction := 1.0:
	set(value):
		refraction = value
		_uniform(&"refraction", value)
## Small ripples: a tiling normal map; empty uses the built-in one.
@export var surface_normal_map: Texture2D:
	set(value):
		surface_normal_map = value
		_textures()
## Meters one tile of the ripples covers.
@export_range(0.1, 100.0, 0.1, "suffix:m") var surface_scale := 1.5:
	set(value):
		surface_scale = value
		_uniform(&"surface_scale", value)
## How strongly the ripples tilt the surface.
@export_range(0.0, 2.0, 0.01) var surface_strength := 0.3:
	set(value):
		surface_strength = value
		_uniform(&"surface_strength", value)
## How fast the ripples' two layers drift across each other.
@export_range(0.0, 5.0, 0.01, "suffix:m/s") var surface_speed := 0.15:
	set(value):
		surface_speed = value
		_uniform(&"surface_speed", value)
## Brightness of the sun's glitter.
@export_range(0.0, 8.0, 0.01) var glint_strength := 0.7:
	set(value):
		glint_strength = value
		_uniform(&"glint_strength", value)
## Size of the sun's highlight, from a pinpoint to a wide sheen.
@export_range(0.0, 1.0, 0.01) var glint_size := 0.12:
	set(value):
		glint_size = value
		_uniform(&"glint_size", value)
## 0 is a soft highlight, 1 a toon highlight with a hard edge.
@export_range(0.0, 1.0, 0.01) var glint_hardness := 0.0:
	set(value):
		glint_hardness = value
		_uniform(&"glint_hardness", value)
## Breaks the sun's mirror image into sparks a few pixels wide, near and far: 0 leaves it whole, 1 scatters it
## widely.
@export_range(0.0, 2.0, 0.01) var glint_sparkle := 0.25:
	set(value):
		glint_sparkle = value
		_uniform(&"glint_sparkle", value)
## Flat-shaded faces, as low-poly water has.
@export var flat_shading := false:
	set(value):
		flat_shading = value
		_uniform(&"flat_shading", value)
## Size of the squares that colors, foam, and ripples snap to, as retro water has; 0 is smooth.
@export_range(0.0, 4.0, 0.01, "suffix:m") var pixel_size := 0.0:
	set(value):
		pixel_size = value
		_uniform(&"pixel_size", value)

@export_group("Reflection")
## What the surface mirrors besides the sky and ReflectionProbes.
@export var reflection := Reflection.SCREEN:
	set(value):
		reflection = value
		_reflection_changed()
## SCREEN: how many steps each mirrored ray takes through the picture. More find thin things and cost more.
@export_range(4, 64) var reflection_steps := 24:
	set(value):
		reflection_steps = value
		_uniform(&"reflection_steps", value)
## SCREEN: how far a mirrored ray reaches. PLANAR: how far from the camera the mirrored water reaches, when the
## water is larger than that; the picture's pixels spread over twice this distance.
@export_range(1.0, 1000.0, 1.0, "suffix:m") var reflection_distance := 80.0:
	set(value):
		reflection_distance = value
		_uniform(&"reflection_distance", value)
## PLANAR: pixels along the longer side of the mirror camera's picture.
@export_range(128, 4096, 1, "suffix:px") var reflection_resolution := 1024:
	set(value):
		reflection_resolution = clampi(value, 128, 4096)
## PLANAR: the render layers the mirror camera draws. Leave out what is too small or too far to matter; layer 20
## is the water itself and is never drawn.
@export_flags_3d_render var reflection_layers := 0x7FFFF:
	set(value):
		reflection_layers = value
		if _mirror_camera != null:
			_mirror_camera.cull_mask = value & ~(1 << (MIRROR_HIDDEN_LAYER - 1))
## How much the waves bend the mirrored picture.
@export_range(0.0, 4.0, 0.01) var reflection_distortion := 0.6:
	set(value):
		reflection_distortion = value
		_uniform(&"reflection_distortion", value)

@export_group("Waves")
## Height of the larger waves from trough to crest; single crests reach higher. 0 is flat water.
@export_range(0.0, 30.0, 0.01, "suffix:m") var wave_height := 0.05:
	set(value):
		wave_height = maxf(value, 0.0)
		_waves_changed()
## Length of the longest wave; the others are shorter.
@export_range(0.2, 500.0, 0.1, "suffix:m") var wave_length := 4.0:
	set(value):
		wave_length = maxf(value, 0.2)
		_waves_changed()
## Compass direction the waves travel toward, in degrees: 0 is -Z, 90 is +X.
@export_range(-360.0, 360.0, 0.5, "suffix:°") var wave_direction := 30.0:
	set(value):
		wave_direction = value
		_waves_changed()
## How far the waves' directions differ: 0 makes rows of parallel waves, 180 a confused sea.
@export_range(0.0, 180.0, 0.5, "suffix:°") var wave_spread := 80.0:
	set(value):
		wave_spread = value
		_waves_changed()
## How many waves add up, from 0 to 32. Each is about a fifth shorter than the one before, so more waves add finer
## chop: 8 reach down to a sixth of `wave_length`, 16 to a fortieth, 24 to a three-hundredth. Each costs every pixel
## of the water a little.
@export_range(0, 32) var wave_count := 10:
	set(value):
		wave_count = clampi(value, 0, MAX_WAVES)
		_waves_changed()
## How high the short waves are beside the long ones: 0 leaves a smooth swell, 0.5 a natural sea, 1 a sea rough
## with chop.
@export_range(0.0, 1.0, 0.01) var wave_chop := 0.5:
	set(value):
		wave_chop = value
		_waves_changed()
## 0 makes rounded waves, 1 crests so sharp that the highest are about to break.
@export_range(0.0, 1.5, 0.01) var wave_steepness := 0.5:
	set(value):
		wave_steepness = value
		_waves_changed()
## 1 moves waves as fast as real waves of their length; less is slow and heavy.
@export_range(0.0, 4.0, 0.01) var wave_speed := 1.0:
	set(value):
		wave_speed = value
		_waves_changed()

@export_group("Flow")
## The current in m/s, which carries ripples and foam: along world X and Z, and for a PATH shape across (x) and
## along (y) the path.
@export var flow := Vector2.ZERO:
	set(value):
		flow = value
		_uniform(&"flow", value)

@export_group("Foam")
## Color of foam in full light; lava uses a dark crust here.
@export var foam_color := Color(0.90, 0.93, 0.95):
	set(value):
		foam_color = value
		_uniform(&"foam_color", value)
## A tiling pattern that breaks the foam up, bright where foam shows first; empty uses the built-in sea-foam lace.
@export var foam_noise: Texture2D:
	set(value):
		foam_noise = value
		_textures()
## Meters one tile of the foam covers.
@export_range(0.1, 100.0, 0.1, "suffix:m") var foam_scale := 3.0:
	set(value):
		foam_scale = value
		_uniform(&"foam_scale", value)
## How fast the foam's pattern drifts by itself, besides the current.
@export_range(0.0, 5.0, 0.01, "suffix:m/s") var foam_speed := 0.1:
	set(value):
		foam_speed = value
		_uniform(&"foam_speed", value)
## How much longer than wide the foam's pattern is, along the way the waves travel: 1 is round, 3 long streaks.
@export_range(0.2, 8.0, 0.01) var foam_stretch := 1.0:
	set(value):
		foam_stretch = value
		_uniform(&"foam_stretch", value)
## 0 fades foam softly, 1 cuts it out with a hard edge.
@export_range(0.0, 1.0, 0.01) var foam_hardness := 0.35:
	set(value):
		foam_hardness = value
		_uniform(&"foam_hardness", value)
## Depth of the water where the shore foam ends.
@export_range(0.0, 20.0, 0.01, "suffix:m") var shore_foam_width := 0.15:
	set(value):
		shore_foam_width = value
		_uniform(&"shore_foam_width", value)
## Amount of foam where the water meets land and objects, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var shore_foam := 0.3:
	set(value):
		shore_foam = value
		_uniform(&"shore_foam", value)
## Bands of foam that travel to the shore, this many across the shore foam's width; 0 none.
@export_range(0.0, 6.0, 0.1) var shore_foam_lines := 0.0:
	set(value):
		shore_foam_lines = value
		_uniform(&"shore_foam_lines", value)
## Foam on wave crests, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var crest_foam := 0.0:
	set(value):
		crest_foam = value
		_uniform(&"crest_foam", value)
## Seconds the foam of a crest stays on the water behind it; 0 keeps foam on the crests only.
@export_range(0.0, 12.0, 0.05, "suffix:s") var foam_trail := 2.5:
	set(value):
		foam_trail = value
		_uniform(&"foam_trail", value)
## How many of the longest waves leave foam behind their crests, from 0 to 8. More leave more and smaller patches
## of foam and cost more per pixel.
@export_range(0, 8) var foam_trail_waves := 3:
	set(value):
		foam_trail_waves = value
		_uniform(&"foam_trail_waves", value)
## Foam where the surface is steep, as in rapids and waterfalls, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var slope_foam := 0.0:
	set(value):
		slope_foam = value
		_uniform(&"slope_foam", value)

@export_group("Caustics")
## Brightness of the light patterns on what lies under the water.
@export_range(0.0, 4.0, 0.01) var caustics := 0.4:
	set(value):
		caustics = value
		_uniform(&"caustics", value)
## Meters one tile of the pattern covers.
@export_range(0.1, 50.0, 0.1, "suffix:m") var caustics_scale := 2.5:
	set(value):
		caustics_scale = value
		_uniform(&"caustics_scale", value)
## Depth over which the patterns fade.
@export_range(0.1, 100.0, 0.1, "suffix:m") var caustics_depth := 4.0:
	set(value):
		caustics_depth = value
		_uniform(&"caustics_depth", value)
## A tiling pattern of bright lines on black; empty uses the built-in one.
@export var caustics_pattern: Texture2D:
	set(value):
		caustics_pattern = value
		_textures()

@export_group("Edge")
## The water fades in over this depth where it meets land; 0 gives a hard edge.
@export_range(0.0, 5.0, 0.01, "suffix:m") var edge_fade := 0.15:
	set(value):
		edge_fade = value
		_uniform(&"edge_fade", value)

@export_group("Underwater")
## Tint and fog the view while the camera is under the surface.
@export var underwater_effect := true
## Color of the view and of the fog while the camera is under the surface.
@export var underwater_color := Color(0.05, 0.32, 0.30)
## How quickly things fade into `underwater_color` under water; it sets the Environment's fog while submerged.
@export_range(0.0, 2.0, 0.005) var underwater_fog_density := 0.08

static var _built_in: Dictionary = {}

var _material: ShaderMaterial
var _time := 0.0
var _wave_shape := PackedVector4Array()
var _wave_motion := PackedVector4Array()
var _wave_used := 0
var _rings := PackedVector4Array()
var _next_ring := 0
var _rebuild_queued := false
var _submerged := false
var _eye_under := false
var _overlay: CanvasLayer
var _overlay_material: ShaderMaterial
var _fogged: Environment
var _fog_before: Dictionary = {}
var _mirror_viewport: SubViewport
var _mirror_camera: Camera3D
var _layers_before := 1


func _init() -> void:
	_rings.resize(MAX_RINGS)
	for index in MAX_RINGS:
		_rings[index] = Vector4(0.0, 0.0, -1000.0, 0.0)


func _ready() -> void:
	add_to_group(GROUP)
	_material = ShaderMaterial.new()
	_material.shader = _shader()
	material_override = _material
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	for uniform in UNIFORMS:
		_material.set_shader_parameter(uniform, get(uniform))
	_material.set_shader_parameter(&"rings", _rings)
	_material.set_shader_parameter(&"ring_count", MAX_RINGS)
	_textures()
	_rebuild()
	_update_waves()
	_reflection_changed()


func _exit_tree() -> void:
	_surface()
	if _mirror_viewport != null and RenderingServer.frame_pre_draw.is_connected(_update_mirror):
		RenderingServer.frame_pre_draw.disconnect(_update_mirror)


func _enter_tree() -> void:
	if _mirror_viewport != null and not RenderingServer.frame_pre_draw.is_connected(_update_mirror):
		RenderingServer.frame_pre_draw.connect(_update_mirror)


func _process(delta: float) -> void:
	_time += delta * time_scale
	_material.set_shader_parameter(&"water_time", _time)
	var camera := get_viewport().get_camera_3d()
	if camera == null:
		return
	if shape == Shape.INFINITE:
		var eye := camera.global_position
		global_position = Vector3(snappedf(eye.x, cell), global_position.y, snappedf(eye.z, cell))
	var eye_under := is_underwater(camera.global_position)
	if eye_under != _eye_under:
		_eye_under = eye_under
		_material.set_shader_parameter(&"eye_under", eye_under)
	var under := underwater_effect and eye_under
	if under and not _submerged:
		_submerge(camera)
	elif not under and _submerged:
		_surface()
	if _submerged:
		_overlay_material.set_shader_parameter(&"water_time", _time)
		_overlay_material.set_shader_parameter(&"tint", underwater_color)
		if _fogged != null:
			_fogged.fog_light_color = underwater_color
			_fogged.fog_density = underwater_fog_density


## Seconds of water time, which waves, ripples, and foam follow.
func water_time() -> float:
	return _time


## World height of the surface over or under a world position, with the waves as they are now.
func height_at(world_position: Vector3) -> float:
	var level := _level_at(world_position)
	# A path's waves follow its bends, which only the shader knows; they are a few centimeters high.
	if _wave_used == 0 or shape == Shape.PATH:
		return level
	var fade := _wave_fade(world_position)
	# Waves also move the surface sideways, so look for the surface point that ends up over this position. Each
	# step goes most of the way there, which also settles on steep crests, where a full step would overshoot.
	var target := Vector2(world_position.x, world_position.z)
	var rest := target
	var moved := Vector3.ZERO
	for attempt in 5:
		moved = _wave_offset(rest, fade)
		rest += (target - rest - Vector2(moved.x, moved.z)) * 0.7
	return level + _wave_offset(rest, fade).y


## Whether a world position is inside this water: within its outline, below its surface, and above its `depth`.
func is_underwater(world_position: Vector3) -> bool:
	if not contains(world_position):
		return false
	var below := height_at(world_position) - world_position.y
	return below > 0.0 and below < depth


## Meters of water over a world position; negative above the surface. It ignores the outline.
func depth_at(world_position: Vector3) -> float:
	return height_at(world_position) - world_position.y


## Whether a world position is over or under this water's outline, whatever its height.
func contains(world_position: Vector3) -> bool:
	if shape == Shape.INFINITE:
		return true
	var local := to_local(world_position)
	match shape:
		Shape.RECTANGLE:
			return absf(local.x) <= size.x * 0.5 and absf(local.z) <= size.y * 0.5
		Shape.DISC:
			return Vector2(local.x / (size.x * 0.5), local.z / (size.y * 0.5)).length_squared() <= 1.0
		_:
			if mesh == null:
				return false
			var box := mesh.get_aabb()
			return local.x >= box.position.x and local.x <= box.end.x and local.z >= box.position.z and local.z <= box.end.z


## The direction and speed the water carries things at a world position, in m/s: `flow` in the world, or along the
## path for a PATH shape.
func flow_at(world_position: Vector3) -> Vector3:
	if shape != Shape.PATH:
		return Vector3(flow.x, 0.0, flow.y)
	var path_node := get_node_or_null(path) as Path3D
	if path_node == null or path_node.curve == null or path_node.curve.get_baked_length() <= 0.0:
		return Vector3.ZERO
	var curve := path_node.curve
	var along := curve.get_closest_offset(path_node.to_local(world_position))
	var ahead := curve.sample_baked(minf(along + 0.25, curve.get_baked_length()), true) - curve.sample_baked(maxf(along - 0.25, 0.0), true)
	var forward := (path_node.global_transform.basis * ahead).normalized()
	var right := forward.cross(Vector3.UP).normalized()
	return forward * flow.y + right * flow.x


## Starts rings that spread from a world position, as a splash, a footstep, or a raindrop makes. `strength` 1 is a
## footstep, 3 a heavy splash. The eight newest rings show.
func add_ripple(world_position: Vector3, strength := 1.0) -> void:
	var at := Vector2(world_position.x, world_position.z)
	if shape == Shape.PATH:
		push_warning("WasdWater3D: add_ripple() draws nothing on a PATH shape, whose ripples follow the path.")
		return
	_rings[_next_ring] = Vector4(at.x, at.y, _time, strength)
	_next_ring = (_next_ring + 1) % MAX_RINGS
	if _material != null:
		_material.set_shader_parameter(&"rings", _rings)


## The water at a world position: one the position is under, else one whose outline it is over, else null.
static func find(tree: SceneTree, world_position: Vector3) -> WasdWater3D:
	var over: WasdWater3D = null
	for node in tree.get_nodes_in_group(GROUP):
		var water := node as WasdWater3D
		if water == null or not water.contains(world_position):
			continue
		if water.is_underwater(world_position):
			return water
		if over == null:
			over = water
	return over


## Builds the mesh again now, after the Path3D's curve changed.
func rebuild() -> void:
	_rebuild()


func _shader() -> Shader:
	return load("res://addons/wasd_water/water.gdshader" if quality == Quality.FULL else "res://addons/wasd_water/water_fast.gdshader") as Shader


func _reflection_changed() -> void:
	_uniform(&"reflection_mode", reflection)
	if not is_node_ready():
		return
	if reflection == Reflection.PLANAR and _mirror_viewport == null:
		_mirror_viewport = SubViewport.new()
		# Where the mirror camera sees only sky its picture stays empty, and the sky's own reflection shows.
		_mirror_viewport.transparent_bg = true
		_mirror_camera = Camera3D.new()
		_mirror_camera.projection = Camera3D.PROJECTION_FRUSTUM
		_mirror_camera.keep_aspect = Camera3D.KEEP_HEIGHT
		_mirror_camera.cull_mask = reflection_layers & ~(1 << (MIRROR_HIDDEN_LAYER - 1))
		_mirror_viewport.add_child(_mirror_camera)
		add_child(_mirror_viewport, false, Node.INTERNAL_MODE_BACK)
		_material.set_shader_parameter(&"planar_texture", _mirror_viewport.get_texture())
		_layers_before = layers
		layers = 1 << (MIRROR_HIDDEN_LAYER - 1)
		RenderingServer.frame_pre_draw.connect(_update_mirror)
	elif reflection != Reflection.PLANAR and _mirror_viewport != null:
		RenderingServer.frame_pre_draw.disconnect(_update_mirror)
		_material.set_shader_parameter(&"planar_texture", null)
		_mirror_viewport.queue_free()
		_mirror_viewport = null
		_mirror_camera = null
		layers = _layers_before


## Puts the mirror camera under the surface, as far below it as the game's camera is above it, looking straight up
## through the water's plane: what it sees through a point of the plane is what the surface mirrors there. It runs
## right before each frame is drawn, so the mirror image never trails the camera.
func _update_mirror() -> void:
	var camera := get_viewport().get_camera_3d() if is_inside_tree() else null
	if camera == null or _mirror_viewport == null:
		return
	var eye := camera.global_position
	var level := global_position.y
	var above := eye.y - level
	# The picture covers the whole of a small water, and a square around the camera on a large one.
	var low := Vector2(eye.x - reflection_distance, eye.z - reflection_distance)
	var high := Vector2(eye.x + reflection_distance, eye.z + reflection_distance)
	if shape != Shape.INFINITE and mesh != null:
		var box := global_transform * mesh.get_aabb()
		if box.size.x <= reflection_distance * 2.0 and box.size.z <= reflection_distance * 2.0:
			low = Vector2(box.position.x, box.position.z)
			high = Vector2(box.end.x, box.end.z)
	var span := high - low
	if above < 0.05 or span.x <= 0.0 or span.y <= 0.0:
		# A camera level with the surface or under it sees no mirror image.
		_mirror_viewport.render_target_update_mode = SubViewport.UPDATE_DISABLED
		_material.set_shader_parameter(&"planar_window", Vector4.ZERO)
		return
	_mirror_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	var pixels := Vector2i(reflection_resolution, reflection_resolution)
	if span.x > span.y:
		pixels.y = maxi(roundi(reflection_resolution * span.y / span.x), 16)
	else:
		pixels.x = maxi(roundi(reflection_resolution * span.x / span.y), 16)
	if _mirror_viewport.size != pixels:
		_mirror_viewport.size = pixels
	var middle := (low + high) * 0.5
	_mirror_camera.environment = camera.environment
	_mirror_camera.attributes = camera.attributes
	# The camera's right is the world's +X and its up the world's +Z, so the picture maps onto the plane directly.
	_mirror_camera.global_transform = Transform3D(Basis(Vector3.RIGHT, Vector3.BACK, Vector3.DOWN), Vector3(eye.x, level - above, eye.z))
	# The near plane is the water's plane: nothing under the water is drawn into the mirror image.
	_mirror_camera.set_frustum(span.y, Vector2(middle.x - eye.x, middle.y - eye.z), above, maxf(camera.far, above + 1.0))
	_material.set_shader_parameter(&"planar_window", Vector4(low.x, low.y, 1.0 / span.x, 1.0 / span.y))


func _uniform(uniform: StringName, value: Variant) -> void:
	if _material != null:
		_material.set_shader_parameter(uniform, value)


func _textures() -> void:
	if _material == null:
		return
	_material.set_shader_parameter(&"surface_normal_map", surface_normal_map if surface_normal_map != null else _built_in_texture(&"ripples"))
	_material.set_shader_parameter(&"foam_noise", foam_noise if foam_noise != null else _built_in_texture(&"foam"))
	_material.set_shader_parameter(&"caustics_pattern", caustics_pattern if caustics_pattern != null else _built_in_texture(&"caustics"))


## The built-in tiling textures, shared by every water: the foam's lace from foam.png, the others made from noise.
static func _built_in_texture(kind: StringName) -> Texture2D:
	if _built_in.has(kind):
		return _built_in[kind]
	if kind == &"foam" and ResourceLoader.exists(FOAM_PATTERN):
		var lace := load(FOAM_PATTERN) as Texture2D
		if lace != null:
			var picture := lace.get_image()
			if picture != null and not picture.is_compressed() and not picture.has_mipmaps():
				# Far foam needs the picture's smaller copies, which a project's import settings may leave out.
				picture.generate_mipmaps()
				lace = ImageTexture.create_from_image(picture)
			_built_in[kind] = lace
			return lace
	var noise := FastNoiseLite.new()
	var texture := NoiseTexture2D.new()
	texture.width = 256
	texture.height = 256
	texture.seamless = true
	texture.seamless_blend_skirt = 0.25
	texture.generate_mipmaps = true
	# A browser makes these textures on its one thread while the game starts, so they are smaller there.
	var detailed := 256 if OS.has_feature("web") else 512
	match kind:
		&"ripples":
			# Sharp little ridges, as a breeze draws on water.
			texture.width = detailed
			texture.height = detailed
			noise.noise_type = FastNoiseLite.TYPE_SIMPLEX
			noise.fractal_type = FastNoiseLite.FRACTAL_RIDGED
			noise.frequency = 0.012
			noise.fractal_octaves = 5
			noise.fractal_lacunarity = 2.1
			noise.fractal_gain = 0.55
			noise.domain_warp_enabled = true
			noise.domain_warp_amplitude = 30.0
			noise.domain_warp_frequency = 0.008
			noise.seed = 7
			texture.as_normal_map = true
			texture.bump_strength = 5.0
		&"foam":
			# Lace: bright walls between bubbles of several sizes.
			texture.width = detailed
			texture.height = detailed
			noise.noise_type = FastNoiseLite.TYPE_CELLULAR
			noise.cellular_return_type = FastNoiseLite.RETURN_DISTANCE2_SUB
			noise.frequency = 0.018
			noise.fractal_type = FastNoiseLite.FRACTAL_FBM
			noise.fractal_octaves = 3
			noise.fractal_lacunarity = 2.3
			noise.fractal_gain = 0.6
			noise.domain_warp_enabled = true
			noise.domain_warp_amplitude = 22.0
			noise.domain_warp_frequency = 0.012
			noise.seed = 3
			var lace := Gradient.new()
			lace.set_color(0, Color.WHITE)
			lace.set_color(1, Color.BLACK)
			lace.set_offset(1, 0.6)
			texture.color_ramp = lace
		_:
			noise.noise_type = FastNoiseLite.TYPE_CELLULAR
			noise.cellular_return_type = FastNoiseLite.RETURN_DISTANCE2_SUB
			noise.frequency = 0.03
			noise.fractal_type = FastNoiseLite.FRACTAL_NONE
			noise.domain_warp_enabled = true
			noise.domain_warp_amplitude = 14.0
			noise.domain_warp_frequency = 0.03
			noise.seed = 11
			# Bright lines where two cells meet, black inside the cells.
			var ramp := Gradient.new()
			ramp.set_color(0, Color.WHITE)
			ramp.set_color(1, Color.BLACK)
			ramp.set_offset(1, 0.4)
			texture.color_ramp = ramp
	texture.noise = noise
	_built_in[kind] = texture
	return texture


func _waves_changed() -> void:
	if is_node_ready():
		_update_waves()


## Works the waves out from the wave properties: each is shorter than the one before and travels in its own direction.
func _update_waves() -> void:
	var count := wave_count if wave_height > 0.0 else 0
	var shares: Array[float] = []
	var spread_sum := 0.0
	for index in count:
		# The shortest waves fade out, so that no single small wave draws a regular pattern.
		var ending := smoothstep(0.0, 1.0, (count - index) / (count * 0.35))
		# At a `wave_chop` of 0.8 every wave is as steep as the others, the roughest a wind makes the sea; below it
		# the short waves are gentler than the long ones.
		shares.append(pow(_wave_length_share(index), lerpf(1.7, 0.8, wave_chop)) * ending)
		spread_sum += shares[index] * shares[index] * 0.5
	# The larger waves are `wave_height` from trough to crest, which is four times how far the surface strays.
	var scale := wave_height / (4.0 * sqrt(spread_sum)) if count > 0 else 0.0
	var slope_sum := 0.0
	for index in count:
		slope_sum += pow(shares[index] * scale * TAU / (wave_length * _wave_length_share(index)), 2.0) * 0.5
	_wave_shape = PackedVector4Array()
	_wave_motion = PackedVector4Array()
	_wave_shape.resize(MAX_WAVES)
	_wave_motion.resize(MAX_WAVES)
	# Along a path, 0 degrees is downstream.
	var heading := wave_direction + (180.0 if shape == Shape.PATH else 0.0)
	for index in MAX_WAVES:
		if index >= count:
			_wave_shape[index] = Vector4(1.0, 0.0, 1.0, 0.0)
			_wave_motion[index] = Vector4.ZERO
			continue
		var number := TAU / (wave_length * _wave_length_share(index))
		var amplitude := shares[index] * scale
		var slope := amplitude * number
		# Directions fill the spread evenly, and short waves stray further from the wind than long ones.
		var turn := 2.0 * fposmod(index * 0.61803398875 + 0.5, 1.0) - 1.0
		var angle := deg_to_rad(heading + wave_spread * 0.5 * turn * lerpf(0.7, 1.3, float(index) / maxf(count - 1, 1)))
		# At a steepness of 1 the waves together press the surface shut (a fold of 0) in about one place in 70.
		var pinch := wave_steepness * slope / (2.2 * sqrt(slope_sum)) if slope_sum > 0.0 else 0.0
		_wave_shape[index] = Vector4(sin(angle), -cos(angle), number, amplitude)
		_wave_motion[index] = Vector4(sqrt(GRAVITY * number) * wave_speed, TAU * fposmod(index * 0.754877666 + 0.11, 1.0), pinch / number, slope * slope * 0.5)
	_wave_used = count
	if _material == null:
		return
	_material.set_shader_parameter(&"wave_shape", _wave_shape)
	_material.set_shader_parameter(&"wave_motion", _wave_motion)
	_material.set_shader_parameter(&"wave_count", count)
	_material.set_shader_parameter(&"wave_scale", maxf(wave_height * 0.5, 0.0001))
	extra_cull_margin = wave_height * 2.0 + wave_length * wave_steepness * 0.2


## The length of a wave as a part of the longest: each is about a fifth shorter than the one before, a little more
## or less so that the waves do not repeat each other's pattern.
func _wave_length_share(index: int) -> float:
	return pow(WAVE_RATIO, index + 0.35 * sin(index * 2.399963) * minf(index, 1.0))


## How far a point of the resting surface has moved, as the shader moves it.
func _wave_offset(rest: Vector2, fade: float) -> Vector3:
	var moved := Vector3.ZERO
	for index in mini(_wave_used, QUERY_WAVES):
		var shape_of := _wave_shape[index]
		var motion := _wave_motion[index]
		var phase := shape_of.z * (shape_of.x * rest.x + shape_of.y * rest.y) - motion.x * _time + motion.y
		var sideways := motion.z * MESH_PINCH * fade * cos(phase)
		moved.x += shape_of.x * sideways
		moved.z += shape_of.y * sideways
		moved.y += shape_of.w * fade * sin(phase)
	return moved


## 1 where the waves have their full height; an infinite sea flattens them far from the camera.
func _wave_fade(world_position: Vector3) -> float:
	if shape != Shape.INFINITE:
		return 1.0
	var camera := get_viewport().get_camera_3d() if is_inside_tree() else null
	if camera == null:
		return 1.0
	var away := Vector2(world_position.x - camera.global_position.x, world_position.z - camera.global_position.z).length()
	return 1.0 - smoothstep(size.x * 0.18, size.x * 0.45, away)


## World height of the resting surface: the node's, or the path's nearest point.
func _level_at(world_position: Vector3) -> float:
	if shape == Shape.PATH:
		var path_node := get_node_or_null(path) as Path3D
		if path_node != null and path_node.curve != null and path_node.curve.point_count > 1:
			return path_node.to_global(path_node.curve.get_closest_point(path_node.to_local(world_position))).y
	return global_position.y


func _queue_rebuild() -> void:
	if not is_node_ready() or _rebuild_queued:
		return
	_rebuild_queued = true
	_rebuild.call_deferred()


func _rebuild() -> void:
	_rebuild_queued = false
	match shape:
		Shape.RECTANGLE:
			var plane := PlaneMesh.new()
			plane.size = size
			plane.subdivide_width = clampi(ceili(size.x / cell) - 1, 0, 255)
			plane.subdivide_depth = clampi(ceili(size.y / cell) - 1, 0, 255)
			mesh = plane
		Shape.DISC:
			mesh = _disc_mesh()
		Shape.INFINITE:
			mesh = _sea_mesh()
		Shape.PATH:
			mesh = _path_mesh()
	_material.set_shader_parameter(&"flow_along_uv", shape == Shape.PATH)
	_material.set_shader_parameter(&"two_sided", shape == Shape.PATH)
	_material.set_shader_parameter(&"wave_fade_start", size.x * 0.18 if shape == Shape.INFINITE else 0.0)
	_material.set_shader_parameter(&"wave_fade_end", size.x * 0.45 if shape == Shape.INFINITE else 0.0)
	_material.set_shader_parameter(&"mesh_cell", cell if shape != Shape.CUSTOM else 0.0)
	_material.set_shader_parameter(&"mesh_cell_growth", SEA_GROWTH - 1.0 if shape == Shape.INFINITE else 0.0)


func _disc_mesh() -> ArrayMesh:
	var rings := clampi(ceili(size.x * 0.5 / cell), 1, 128)
	var sides := clampi(ceili(PI * size.x / cell), 12, 256)
	var vertices := PackedVector3Array([Vector3.ZERO])
	var indices := PackedInt32Array()
	for ring in range(1, rings + 1):
		for side in sides:
			var angle := TAU * side / sides
			vertices.append(Vector3(cos(angle) * size.x, 0.0, sin(angle) * size.y) * (0.5 * ring / rings))
	for side in sides:
		var next := (side + 1) % sides
		indices.append_array([0, 1 + side, 1 + next])
		for ring in range(1, rings):
			var inner := 1 + (ring - 1) * sides
			var outer := inner + sides
			indices.append_array([inner + side, outer + side, outer + next, inner + side, outer + next, inner + next])
	return _mesh_of(vertices, indices, PackedVector2Array())


## A grid whose cells are `cell` wide in the middle and grow with distance, out to `size.x` across.
func _sea_mesh() -> ArrayMesh:
	var half: Array[float] = [0.0]
	var step := cell
	while half[-1] < size.x * 0.5 and half.size() < 160:
		half.append(half[-1] + step)
		# Cells keep their size near the camera and then grow with distance.
		if half.size() > SEA_CORE:
			step *= SEA_GROWTH
	if half[-1] < size.x * 0.5:
		half.append(size.x * 0.5)
	var axis: Array[float] = []
	for index in range(half.size() - 1, 0, -1):
		axis.append(-half[index])
	axis.append_array(half)
	var count := axis.size()
	var vertices := PackedVector3Array()
	var indices := PackedInt32Array()
	for z in count:
		for x in count:
			vertices.append(Vector3(axis[x], 0.0, axis[z]))
	for z in count - 1:
		for x in count - 1:
			var corner := z * count + x
			indices.append_array([corner, corner + 1, corner + count, corner + 1, corner + count + 1, corner + count])
	return _mesh_of(vertices, indices, PackedVector2Array())


## A ribbon along the path, level across its width. Its UV is meters across and meters along the path.
func _path_mesh() -> ArrayMesh:
	if path.is_empty():
		return null
	var path_node := get_node_or_null(path) as Path3D
	if path_node == null or path_node.curve == null or path_node.curve.get_baked_length() <= 0.0:
		push_warning("WasdWater3D: a PATH shape needs `path` to name a Path3D with a curve of two points or more.")
		return null
	var curve := path_node.curve
	var length := curve.get_baked_length()
	var rows := clampi(ceili(length / cell), 1, 4000)
	var columns := clampi(ceili(size.x / cell), 1, 24)
	var to_water := global_transform.affine_inverse() * path_node.global_transform
	var vertices := PackedVector3Array()
	var uvs := PackedVector2Array()
	var indices := PackedInt32Array()
	var right := Vector3.RIGHT
	for row in rows + 1:
		var along := length * row / rows
		var center := curve.sample_baked(along, true)
		var forward := (curve.sample_baked(minf(along + 0.1, length), true) - curve.sample_baked(maxf(along - 0.1, 0.0), true)).normalized()
		var across := forward.cross(Vector3.UP)
		# A stretch that falls straight down keeps the direction of the stretch before it.
		if across.length() > 0.05:
			right = across.normalized()
		for column in columns + 1:
			var side := (float(column) / columns - 0.5) * size.x
			vertices.append(to_water * (center + right * side))
			uvs.append(Vector2(side, along))
	for row in rows:
		for column in columns:
			var corner := row * (columns + 1) + column
			var next := corner + columns + 1
			indices.append_array([corner, next, corner + 1, corner + 1, next, next + 1])
	return _mesh_of(vertices, indices, uvs)


func _mesh_of(vertices: PackedVector3Array, indices: PackedInt32Array, uvs: PackedVector2Array) -> ArrayMesh:
	var surface := SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)
	for index in vertices.size():
		if not uvs.is_empty():
			surface.set_uv(uvs[index])
		surface.set_normal(Vector3.UP)
		surface.add_vertex(vertices[index])
	for index in indices:
		surface.add_index(index)
	if not uvs.is_empty():
		# A path rises and falls, so its normals come from its faces.
		surface.generate_normals()
	return surface.commit()


func _submerge(camera: Camera3D) -> void:
	_submerged = true
	if _overlay == null:
		_overlay = CanvasLayer.new()
		_overlay.layer = -100
		var cover := ColorRect.new()
		cover.set_anchors_preset(Control.PRESET_FULL_RECT)
		cover.mouse_filter = Control.MOUSE_FILTER_IGNORE
		_overlay_material = ShaderMaterial.new()
		_overlay_material.shader = load("res://addons/wasd_water/underwater.gdshader") as Shader
		cover.material = _overlay_material
		_overlay.add_child(cover)
		add_child(_overlay, false, Node.INTERNAL_MODE_BACK)
	_overlay.visible = true
	_overlay_material.set_shader_parameter(&"tint", underwater_color)
	var environment := camera.environment
	if environment == null and camera.get_world_3d() != null:
		environment = camera.get_world_3d().environment
	if environment != null:
		_fogged = environment
		_fog_before = {
			"fog_enabled": environment.fog_enabled, "fog_light_color": environment.fog_light_color,
			"fog_density": environment.fog_density, "fog_mode": environment.fog_mode,
			"fog_sky_affect": environment.fog_sky_affect, "fog_light_energy": environment.fog_light_energy,
		}
		environment.fog_enabled = true
		environment.fog_mode = Environment.FOG_MODE_EXPONENTIAL
		environment.fog_light_color = underwater_color
		environment.fog_light_energy = 1.0
		environment.fog_density = underwater_fog_density
		environment.fog_sky_affect = 1.0
	camera_submerged.emit()


func _surface() -> void:
	if not _submerged:
		return
	_submerged = false
	if _overlay != null:
		_overlay.visible = false
	if _fogged != null:
		for key: String in _fog_before:
			_fogged.set(key, _fog_before[key])
		_fogged = null
	camera_surfaced.emit()
