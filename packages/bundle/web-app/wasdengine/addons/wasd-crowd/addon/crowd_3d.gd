# SPDX-License-Identifier: CC0-1.0
# A crowd: hundreds or thousands of copies of one animated model, each at its own place, in its own clip, at its own
# pace and phase, drawn in one draw call for each surface of the model. The animation comes from textures that
# WasdCrowdBaker baked, so that a member costs no skeleton and no animation player: an army, a stadium, a street of
# walkers, a school of fish. Members do not collide and are not nodes; the game moves them by their numbers.
class_name WasdCrowd3D
extends MultiMeshInstance3D

## The baked model: a WasdCrowdData file that bake_crowd.gd saved.
@export var data: WasdCrowdData: set = _set_data
## Most members the crowd can hold. Changed, it keeps its members; a lower one drops those numbered from it up.
@export_range(1, 20000, 1) var capacity := 512: set = _set_capacity

var _used := 0
var _free: Array[int] = []
var _clips: Array[Color] = []


func _init() -> void:
	multimesh = MultiMesh.new()
	multimesh.transform_format = MultiMesh.TRANSFORM_3D
	multimesh.use_colors = true
	multimesh.use_custom_data = true
	multimesh.instance_count = capacity
	multimesh.visible_instance_count = 0
	# Members may stand anywhere, so the crowd is never culled as a whole.
	custom_aabb = AABB(Vector3.ONE * -100000.0, Vector3.ONE * 200000.0)


## Adds a member at a place, given in this node's own space, playing a clip. `pace` multiplies the clip's speed, and
## `phase`, from 0 to 1, is where in the clip the member starts; left out, each member gets its own. Returns the
## member's number, or -1 when the crowd is full or has no such clip.
func add(place: Transform3D, clip := "", pace := 1.0, phase := -1.0, color := Color.WHITE) -> int:
	if data == null:
		push_error("WasdCrowd3D has no data: bake a model with bake_crowd.gd and load the file it saves.")
		return -1
	# The clip is checked before a number is taken: a number taken and given back would show what it held before.
	var entry := _clip(clip)
	if entry.is_empty():
		return -1
	var member := -1
	if not _free.is_empty():
		member = _free.pop_back()
	elif _used < capacity:
		member = _used
		_used += 1
	else:
		return -1
	_set_clip(member, entry, pace, phase)
	multimesh.set_instance_transform(member, place)
	multimesh.set_instance_color(member, color)
	multimesh.visible_instance_count = _used
	return member


## Moves a member, in this node's own space.
func set_member_transform(member: int, place: Transform3D) -> void:
	multimesh.set_instance_transform(member, place)


func get_member_transform(member: int) -> Transform3D:
	return multimesh.get_instance_transform(member)


## Gives a member another clip, pace, and phase. Returns false when the data has no such clip.
func set_member_clip(member: int, clip: String, pace := 1.0, phase := -1.0) -> bool:
	if data == null:
		return false
	var entry := _clip(clip)
	if entry.is_empty():
		return false
	_set_clip(member, entry, pace, phase)
	return true


## The baked clip of that name, the first one for an empty name; empty, with a warning, when the data has none.
func _clip(clip: String) -> Dictionary:
	if clip == "":
		clip = data.clips.keys()[0]
	if not data.clips.has(clip):
		push_warning("WasdCrowd3D: no clip named \"%s\". The baked clips are: %s." % [clip, ", ".join(data.names())])
		return {}
	return data.clips[clip]


func _set_clip(member: int, entry: Dictionary, pace: float, phase: float) -> void:
	multimesh.set_instance_custom_data(member, Color(entry["start"], entry["frames"], phase if phase >= 0.0 else randf(), float(entry["fps"]) * pace))


## Tints a member: the model's own colors are multiplied by it, for a crowd whose members do not all look alike.
func set_member_color(member: int, color: Color) -> void:
	multimesh.set_instance_color(member, color)


## Lets only some of the model's surfaces take the members' tints: those whose name holds one of the given words,
## without regard to case. A surface is named after its mesh in the model and its number there, as `surfaces()` lists
## them: `tint_only(["suit", "shirt"])` varies the clothes and leaves skin and hair alone.
func tint_only(words: PackedStringArray) -> void:
	if data == null:
		return
	for surface: int in data.mesh.get_surface_count():
		var name := data.mesh.surface_get_name(surface).to_lower()
		var takes := words.is_empty()
		for word: String in words:
			if name.contains(word.to_lower()):
				takes = true
		(data.mesh.surface_get_material(surface) as ShaderMaterial).set_shader_parameter(&"tinted", 1.0 if takes else 0.0)


## The names of the model's surfaces.
func surfaces() -> PackedStringArray:
	var found := PackedStringArray()
	if data != null:
		for surface: int in data.mesh.get_surface_count():
			found.append(data.mesh.surface_get_name(surface))
	return found


## Takes a member out. Its number goes to the next member added.
func remove(member: int) -> void:
	if member < 0 or member >= _used or _free.has(member):
		return
	multimesh.set_instance_transform(member, Transform3D(Basis.from_scale(Vector3.ZERO), Vector3.ZERO))
	_free.append(member)


## How many members the crowd holds.
func count() -> int:
	return _used - _free.size()


## Takes every member out.
func clear() -> void:
	_used = 0
	_free.clear()
	multimesh.visible_instance_count = 0


## Makes room for `capacity` members and keeps the members whose numbers it holds, with their places, clips, and tints.
func _resize() -> void:
	var kept := mini(_used, capacity)
	var members := multimesh.buffer if kept > 0 else PackedFloat32Array()
	var each := members.size() / multimesh.instance_count
	multimesh.instance_count = capacity
	if kept > 0 and each > 0:
		members.resize(capacity * each)
		multimesh.buffer = members
	_used = kept
	_free.assign(_free.filter(func(member: int) -> bool: return member < kept))
	multimesh.visible_instance_count = _used


func _set_data(value: WasdCrowdData) -> void:
	data = value
	multimesh.mesh = value.mesh if value != null else null


func _set_capacity(value: int) -> void:
	capacity = maxi(value, 1)
	if multimesh != null:
		_resize()
