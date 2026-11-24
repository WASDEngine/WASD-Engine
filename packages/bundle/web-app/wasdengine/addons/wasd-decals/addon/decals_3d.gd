# SPDX-License-Identifier: CC0-1.0
# Marks on surfaces: bullet holes, scorch marks, splats, footprints, cracks. One WasdDecals3D holds all marks of one
# kind and draws them in one draw call as flat quads just above the surface; `add()` places a mark at a point with
# the surface's normal. A kind is one of the marks drawn in code (`mark`), which need no texture and never repeat, or
# a texture of the game's own. Marks fade after `lifetime` seconds, and the oldest goes when `capacity` is reached. It
# draws on the Forward+, Mobile, and Compatibility renderers, where Decal nodes do not draw.
class_name WasdDecals3D
extends MultiMeshInstance3D

const SHADER := preload("res://addons/wasd_decals/decals.gdshader")
## Seconds after which the pool's clock starts again from 0, and every mark's end moves with it. The Compatibility
## renderer, which every Web build uses, keeps a mark's custom data as half floats, which are a second off past 2,048
## and hold nothing past 65,504: the end times stay small numbers however long the game runs.
const CLOCK_SPAN := 64.0
## The marks drawn in code, each with the size in meters, the tint, and the shine that suit it.
const MARKS := {
	"bullet_hole": {"kind": 1, "size": 0.16, "tint": Color(1, 1, 1), "shine": 0.0},
	"scorch": {"kind": 2, "size": 1.8, "tint": Color(1, 1, 1), "shine": 0.0},
	"splat": {"kind": 3, "size": 0.9, "tint": Color(1, 1, 1), "shine": 0.6},
	"crack": {"kind": 4, "size": 1.4, "tint": Color(1, 1, 1), "shine": 0.0},
	"footprint": {"kind": 5, "size": 0.3, "tint": Color(0.08, 0.065, 0.05, 0.8), "shine": 0.0},
}

## A mark drawn in code, with no texture: "bullet_hole", "scorch", "splat", "crack", or "footprint". Every mark gets
## a shape of its own. Setting it also sets `size`, `tint`, and `shine` to what suits the mark; "" draws `texture`.
@export var mark := "": set = _set_mark
## The marks' picture, on a transparent background, when `mark` is empty.
@export var texture: Texture2D: set = _set_texture
## Columns and rows when the texture holds several marks; `add()` picks one at random.
@export var frames := Vector2i(1, 1): set = _set_frames
## Side of a mark in meters, unless `add()` gives its own.
@export_range(0.01, 20.0, 0.01) var size := 0.3
## Seconds a mark stays, its fade included; 0 keeps marks until `clear()` or until `capacity` replaces them.
@export_range(0.0, 600.0, 0.1) var lifetime := 20.0
## Seconds a mark takes to fade at the end of its life.
@export_range(0.0, 30.0, 0.1) var fade := 2.0: set = _set_fade
## Most marks at once; a new mark replaces the oldest.
@export_range(1, 4096, 1) var capacity := 256: set = _set_capacity
## Tint of new marks; its alpha makes them fainter.
@export var tint := Color(1, 1, 1)
## false lights the marks with the scene, so they darken in shadow; true draws them with their own colors.
@export var unlit := false: set = _set_unlit
## How wet the marks look, from 0 (dry) to 1 (a fresh spill that mirrors the light).
@export_range(0.0, 1.0, 0.01) var shine := 0.0: set = _set_shine
## Meters the marks float above the surface, so the two do not flicker.
@export_range(0.001, 0.1, 0.001) var lift := 0.012

var _material := ShaderMaterial.new()
var _next := 0
var _used := 0
var _clock := 0.0
## What each slot's custom data holds: when its mark ends on the pool's clock (0 for a mark that stays, -1 for one
## that has ended), its frame, and the number of its shape.
var _custom := PackedColorArray()


func _init() -> void:
	_material.shader = SHADER
	_material.render_priority = 1
	var quad := QuadMesh.new()
	quad.orientation = PlaneMesh.FACE_Y
	quad.material = _material
	multimesh = MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.use_colors = true
	multimesh.use_custom_data = true
	multimesh.mesh = quad
	cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	_resize()


func _ready() -> void:
	# Marks are placed in world space, wherever this node is.
	top_level = true
	global_transform = Transform3D.IDENTITY


func _process(delta: float) -> void:
	_clock += delta
	if _clock >= CLOCK_SPAN:
		_restart_clock()
	_material.set_shader_parameter(&"clock", _clock)


## The names of the marks drawn in code.
static func names() -> PackedStringArray:
	return PackedStringArray(MARKS.keys())


## Places a mark at a world position on a surface with the world normal `normal`. `side` is its size in meters
## (`size` when negative), `turn` its rotation about the normal in radians (random when negative), and `frame` its
## frame of the texture, or the number of its shape for a mark drawn in code (random when negative). Returns the
## mark's slot.
func add(at: Vector3, normal: Vector3, side := -1.0, turn := -1.0, frame := -1) -> int:
	var up := normal.normalized() if normal.length_squared() > 0.0001 else Vector3.UP
	var across := up.cross(Vector3.RIGHT if absf(up.x) < 0.9 else Vector3.FORWARD).normalized()
	return _place(at, up, Basis(across, up, across.cross(up)).rotated(up, turn if turn >= 0.0 else randf() * TAU), side, frame)


## Places a mark like `add()`, turned so that the top of its picture points along `toward`: a footprint's toe, the
## long end of a skid mark. An even `frame` of "footprint" is a left foot and an odd one a right foot.
func add_toward(at: Vector3, normal: Vector3, toward: Vector3, side := -1.0, frame := -1) -> int:
	var up := normal.normalized() if normal.length_squared() > 0.0001 else Vector3.UP
	var ahead := toward - up * toward.dot(up)
	if ahead.length_squared() < 0.000001:
		return add(at, normal, side, -1.0, frame)
	ahead = ahead.normalized()
	# The picture's top lies toward the quad's -Z.
	return _place(at, up, Basis(up.cross(-ahead).normalized(), up, -ahead), side, frame)


func _place(at: Vector3, up: Vector3, basis: Basis, side: float, frame: int) -> int:
	var length := side if side > 0.0 else size
	var slot := _next
	_next = (_next + 1) % capacity
	_used = mini(_used + 1, capacity)
	multimesh.visible_instance_count = _used
	multimesh.set_instance_transform(slot, Transform3D(basis * Basis.from_scale(Vector3(length, 1.0, length)), at + up * lift))
	multimesh.set_instance_color(slot, tint)
	var count := frames.x * frames.y
	var ends := _clock + lifetime if lifetime > 0.0 else 0.0
	# A drawn mark's own number: its frame when one is given, so that a game can ask for the same shape twice.
	var shape := float(frame) if frame >= 0 else float(randi() % 500) * 2.0 + 0.37
	_custom[slot] = Color(ends, float(frame if frame >= 0 else randi() % count), shape, 0.0)
	multimesh.set_instance_custom_data(slot, _custom[slot])
	return slot


## How many marks the pool holds, faded ones included until a new mark takes their slot.
func count() -> int:
	return _used


## Removes every mark.
func clear() -> void:
	_next = 0
	_used = 0
	multimesh.visible_instance_count = 0


## Starts the pool's clock again from 0 and moves the end of every mark with a lifetime along with it.
func _restart_clock() -> void:
	for slot: int in _used:
		var custom := _custom[slot]
		if custom.r > 0.0:
			custom.r = custom.r - _clock if custom.r > _clock else -1.0
			_custom[slot] = custom
			multimesh.set_instance_custom_data(slot, custom)
	_clock = 0.0


func _resize() -> void:
	multimesh.instance_count = capacity
	multimesh.visible_instance_count = 0
	_custom.resize(capacity)
	_next = 0
	_used = 0
	# Marks may lie anywhere, so the pool is never culled as a whole.
	custom_aabb = AABB(Vector3.ONE * -100000.0, Vector3.ONE * 200000.0)


func _set_mark(value: String) -> void:
	mark = value if MARKS.has(value) else ""
	if value != "" and mark == "":
		push_warning("WasdDecals3D has no mark named \"%s\". The marks are: %s." % [value, ", ".join(names())])
	var drawn: Dictionary = MARKS.get(mark, {})
	_material.set_shader_parameter(&"kind", drawn.get("kind", 0))
	if not drawn.is_empty():
		size = drawn["size"]
		tint = drawn["tint"]
		shine = drawn["shine"]


func _set_shine(value: float) -> void:
	shine = value
	_material.set_shader_parameter(&"shine", value)


func _set_texture(value: Texture2D) -> void:
	texture = value
	_material.set_shader_parameter(&"marks", value)


func _set_frames(value: Vector2i) -> void:
	frames = Vector2i(maxi(value.x, 1), maxi(value.y, 1))
	_material.set_shader_parameter(&"frames", Vector2(frames))


func _set_fade(value: float) -> void:
	fade = value
	_material.set_shader_parameter(&"fade", value)


func _set_capacity(value: int) -> void:
	capacity = maxi(value, 1)
	if multimesh != null:
		_resize()


func _set_unlit(value: bool) -> void:
	unlit = value
	_material.set_shader_parameter(&"unlit", 1.0 if value else 0.0)
