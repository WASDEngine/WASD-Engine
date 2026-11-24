# SPDX-License-Identifier: CC0-1.0
# Gives a character's face life. As a child of the character's Skeleton3D it blinks, turns the eyes, the head, and
# the neck toward what they should look at, moves the mouth with a voice that plays, and shows feelings. It also does
# by itself what a living face does unasked, because a face that only obeys stares: the eyes glance from one of a
# listener's eyes to the other and away, the lids follow the eyes down, and brows and head mark the stressed
# syllables of speech. It works on what the model has: blend shapes for the lids, the mouth, and expressions, and
# eye, head, and neck bones; a model without one of them keeps still there. It works after the animation each frame,
# so any clip may play under it, on every renderer. The node itself sits between the eyes, so its place in the world
# is where to look at the character or aim a camera.
class_name WasdFace3D
extends SkeletonModifier3D

## Emitted as the lids close in a blink.
signal blinked

## What the eyes, and with `head_share` the head, look at; none lets the eyes wander a little. A character with a
## face, such as a WasdCharacter3D, is looked at in its face and not at its feet, where its origin is.
@export var look_target: Node3D
## How far the eyes turn from straight ahead, in degrees.
@export_range(0.0, 45.0, 1.0) var eye_reach := 28.0
## The share of a turn to the side that the head takes, the eyes taking the rest: 0 leaves the head to the
## animation. Of a turn up or down the head takes more.
@export_range(0.0, 1.0, 0.05) var head_share := 0.6
## How far the head turns, in degrees.
@export_range(0.0, 80.0, 1.0) var head_reach := 45.0
## Whether the face blinks by itself.
@export var blinking := true
## Seconds from one blink to the next, about.
@export_range(1.0, 20.0, 0.1) var blink_every := 4.0
## How wide the mouth opens at a voice's loudest, from 0 to 1.
@export_range(0.0, 1.0, 0.05) var mouth_reach := 0.85
## How wide the mouth is open when no voice plays, from 0 to 1, for a game that moves the mouth itself.
@export_range(0.0, 1.0, 0.01) var mouth := 0.0
## How much the face does unasked, from 0 to 1: glances, lids that follow the eyes, a mouth that shapes each
## syllable, and the brows and nods of speech. 0 leaves only what the game asks for.
@export_range(0.0, 1.0, 0.05) var liveliness := 1.0
## Where the model's face points in the pose its meshes were made in, in the skeleton's space: +Z for a glTF model.
@export var front := Vector3(0.0, 0.0, 1.0)

## The names a blend shape may have for each thing the face does by itself, without regard to case or to marks
## between words: the shapes of the mpfb guide's `add_face`, of ARKit, and of VRM and VRoid models.
const SHAPES := {
	"blink_l": ["blinkl", "blinkleft", "eyeblinkleft", "eyeblinkl", "fcleyeclosel", "eyeclosedl", "blinkl01"],
	"blink_r": ["blinkr", "blinkright", "eyeblinkright", "eyeblinkr", "fcleyecloser", "eyeclosedr", "blinkr01"],
	"blink": ["blink", "fcleyeclose", "eyesclosed", "blinkboth"],
	"mouth_open": ["mouthopen", "jawopen", "aa", "a", "fclmtha", "visemeaa", "mouthopenaa"],
	"mouth_narrow": ["mouthnarrow", "mouthpucker", "ou", "oh", "o", "fclmtho", "visemeo"],
	"mouth_wide": ["mouthwide", "mouthstretch", "ee", "ih", "e", "fclmthe", "visemee"],
	"brows_up": ["browsup", "browup", "browinnerup", "fclbrwsurprised"],
}
## The feelings `feel` knows, each with the names a blend shape may have for it: the shapes of the mpfb guide's
## `add_face`, and of VRM models.
const FEELINGS := {
	"smile": ["smile", "happy", "joy", "relaxed", "fclalljoy"],
	"grin": ["grin", "fun", "laugh", "fclallfun"],
	"sad": ["sad", "sorrow", "fclallsorrow"],
	"angry": ["angry", "anger", "fclallangry"],
	"surprised": ["surprised", "surprise", "fclallsurprised"],
	"afraid": ["afraid", "fear", "scared"],
	"disgusted": ["disgusted", "disgust"],
}
## The script of the wasd-materials add-on's WasdSurface, which is loaded by its path because it may not be installed.
const SURFACE := "res://addons/wasd_materials/surface.gd"
const HEAD_BONES := ["Head", "head", "mixamorig:Head", "mixamorig_Head"]
const EYE_BONES := [["LeftEye", "RightEye"], ["eye_l", "eye_r"], ["eye.L", "eye.R"], ["mixamorig:LeftEye", "mixamorig:RightEye"]]
## The share of the head's turn that the neck takes, where the head's bone hangs on a neck's.
const NECK_SHARE := 0.35
## What a syllable's mouth may add to its opening, as shares of wide and narrow: most syllables only open.
const _SYLLABLES := [Vector2.ZERO, Vector2.ZERO, Vector2(0.6, 0.0), Vector2(0.0, 0.7), Vector2(0.35, 0.0), Vector2(0.0, 0.4)]

## Whether `add_to` also gives a human of the mpfb guide's `wasd_mpfb` its skin, eyes, mouth, lashes, and hair, where
## WASD Materials is installed. Set it to false before a model is added to keep the materials the model came with.
static var dress_humans := true

## Each blend shape the model has, by its name: the meshes that have it, each with the shape's index there.
var _shapes := {}
## The model's name for each shape of SHAPES and each feeling of FEELINGS that it has.
var _roles := {}
## The value of each shape that `express` set, where it came from and goes, and how far along its way it is.
var _expressions := {}
## The value each shape has now, of those the face moved off 0.
var _shown := {}
var _head := -1
var _neck := -1
var _eyes: Array[int] = []
## For the head's bone and each eye's, what takes it back from its pose to the pose its meshes were bound in. A bone's
## pose times this is how the bone has moved its part of the mesh, whatever the skeleton's rest pose is: an
## animation retarget gives a skeleton another rest, in which a head may lean back and its eyes look elsewhere.
var _unbound := {}
## The eyes' materials that take the head's up direction, so that the lids' shade stays under the lids.
var _eye_materials: Array[ShaderMaterial] = []
## The skin's materials that take the face's folds, and how far a smile's and a frown's are drawn in now.
var _skin_materials: Array[ShaderMaterial] = []
var _folds := Vector2.ZERO
var _voice: Node
var _voice_clock := 0.0
var _talk_left := 0.0
var _talk_time := 0.0
var _mouth_now := 0.0
## What the voice's loudness was a frame ago, the shares of wide and narrow that this syllable adds, and how hard
## the last stressed syllable was struck, fading.
var _level_before := 0.0
var _syllable := Vector2.ZERO
var _syllable_now := Vector2.ZERO
var _stress := 0.0
var _blink_wait := 2.0
var _blink_time := -1.0
var _blink_again := false
var _since_blink := 0.0
var _point := Vector3.ZERO
var _has_point := false
var _head_turn := Vector2.ZERO
var _eye_turns: Array[Vector2] = [Vector2.ZERO, Vector2.ZERO]
var _wish_before := Vector2.ZERO
var _wander := Vector2.ZERO
var _wander_wait := 1.0
## Where, a little off what they look at, the eyes rest for the moment, and for how much longer.
var _glance := Vector2.ZERO
var _glance_wait := 1.0
## A small movement the face makes by itself now and then: its shape, how far it goes, and its seconds left.
var _whim := ""
var _whim_amount := 0.0
var _whim_left := 0.0
var _whim_wait := 4.0
var _whim_now := 0.0


## Whether a model has a face to move: a skeleton with two eye bones, or with a mesh that has a blend shape this
## node knows.
static func fits(model: Node) -> bool:
	return _skeleton_of(model) != null


## Gives a model a face: adds a WasdFace3D under its skeleton, the one with the eyes or with the face's mesh, and
## returns it, or the face that is there already. Returns null for a model without a face to move. A human that the
## mpfb guide's `wasd_mpfb` made also gets its skin, eyes, mouth, lashes, and hair from WASD Materials, where that
## add-on is installed: as it comes in, such a human has a face that no shape can save.
static func add_to(model: Node) -> WasdFace3D:
	var skeleton := _skeleton_of(model)
	if skeleton == null:
		return null
	for child: Node in skeleton.get_children():
		if child is WasdFace3D:
			return child as WasdFace3D
	if dress_humans:
		_dress(model)
	var face := WasdFace3D.new()
	skeleton.add_child(face)
	return face


## Has WASD Materials put right the materials of a human that `wasd_mpfb` made, which is told by the material of
## its eyes: that module names it "<name>.eyes_<color>".
static func _dress(model: Node) -> void:
	if not ResourceLoader.exists(SURFACE):
		return
	for found: Node in model.find_children("*", "MeshInstance3D", true, false):
		var instance := found as MeshInstance3D
		for surface: int in (instance.mesh.get_surface_count() if instance.mesh != null else 0):
			var material := instance.get_active_material(surface)
			if material is BaseMaterial3D and material.resource_name.contains(".eyes_"):
				(load(SURFACE) as GDScript).call(&"human", model)
				return


## The skeleton of a model that a face goes under: the first with two eye bones, else the first with a mesh that
## has a blend shape this node knows; none for a model without either.
static func _skeleton_of(model: Node) -> Skeleton3D:
	if model == null:
		return null
	var skeletons := model.find_children("*", "Skeleton3D", true, false)
	if model is Skeleton3D:
		skeletons.push_front(model)
	for found: Node in skeletons:
		for pair: Array in EYE_BONES:
			if (found as Skeleton3D).find_bone(pair[0]) >= 0 and (found as Skeleton3D).find_bone(pair[1]) >= 0:
				return found as Skeleton3D
	for found: Node in skeletons:
		for instance: MeshInstance3D in _meshes_of(found as Skeleton3D):
			for index: int in _shape_count(instance):
				if _role_of((instance.mesh as ArrayMesh).get_blend_shape_name(index)) != "":
					return found as Skeleton3D
	return null


## How many blend shapes a mesh has. Only a mesh made of arrays, as a model's is, has any: a ball or a box that hangs
## on a skeleton, such as a hat, has none to ask for.
static func _shape_count(instance: MeshInstance3D) -> int:
	return (instance.mesh as ArrayMesh).get_blend_shape_count() if instance.mesh is ArrayMesh else 0


## A skeleton's meshes: those under it, and those beside it that are skinned to it, since another model's may share
## its parent.
static func _meshes_of(skeleton: Skeleton3D) -> Array[MeshInstance3D]:
	var meshes: Array[MeshInstance3D] = []
	for found: Node in skeleton.find_children("*", "MeshInstance3D", true, false):
		meshes.append(found as MeshInstance3D)
	if skeleton.get_parent() != null:
		for found: Node in skeleton.get_parent().find_children("*", "MeshInstance3D", true, false):
			if not skeleton.is_ancestor_of(found) and found.get_node_or_null((found as MeshInstance3D).skeleton) == skeleton:
				meshes.append(found as MeshInstance3D)
	return meshes


func _ready() -> void:
	_blink_wait = randf_range(0.5, blink_every)
	refresh()


func _skeleton_changed(_old: Skeleton3D, _new: Skeleton3D) -> void:
	refresh()


## A blend shape's name without its case and the marks between its words.
static func _plain(shape: String) -> String:
	var plain := ""
	for letter: String in shape.to_lower():
		if (letter >= "a" and letter <= "z") or (letter >= "0" and letter <= "9"):
			plain += letter
	return plain


## The name of SHAPES or of FEELINGS that a blend shape's name stands for; empty for another shape.
static func _role_of(shape: String) -> String:
	var plain := _plain(shape)
	for role: String in SHAPES:
		if plain in SHAPES[role]:
			return role
	for feeling: String in FEELINGS:
		if plain in FEELINGS[feeling]:
			return feeling
	return ""


## Looks through the model again for its blend shapes and bones: call it after adding meshes to the model, such as
## a hat with the face's shapes, or after changing them or their materials.
func refresh() -> void:
	_shapes.clear()
	_roles.clear()
	_head = -1
	_neck = -1
	_eyes.clear()
	_unbound.clear()
	_eye_materials.clear()
	_skin_materials.clear()
	var skeleton := get_skeleton()
	if skeleton == null:
		return
	for bone: String in HEAD_BONES:
		if _head < 0:
			_head = skeleton.find_bone(bone)
	var under_head := skeleton.get_bone_parent(_head) if _head >= 0 else -1
	if under_head >= 0 and skeleton.get_bone_name(under_head).to_lower().contains("neck"):
		_neck = under_head
	for pair: Array in EYE_BONES:
		if _eyes.is_empty() and skeleton.find_bone(pair[0]) >= 0 and skeleton.find_bone(pair[1]) >= 0:
			_eyes = [skeleton.find_bone(pair[0]), skeleton.find_bone(pair[1])]
	var meshes := _meshes_of(skeleton)
	for bone: int in [_head] + _eyes:
		if bone >= 0:
			_unbound[bone] = _unbind(skeleton, meshes, bone)
	for instance: MeshInstance3D in meshes:
		for index: int in _shape_count(instance):
			var shape := String((instance.mesh as ArrayMesh).get_blend_shape_name(index))
			if not _shapes.has(shape):
				_shapes[shape] = []
			(_shapes[shape] as Array).append([instance, index])
			var role := _role_of(shape)
			if role != "" and not _roles.has(role):
				_roles[role] = shape
		for surface: int in (instance.mesh.get_surface_count() if instance.mesh != null else 0):
			var material := instance.get_active_material(surface) as ShaderMaterial
			if material != null and material.shader != null:
				var takes := _uniforms_of(material.shader)
				if takes.has("head_up"):
					_eye_materials.append(material)
				if takes.has("folds"):
					_skin_materials.append(material)
	# A mesh that is new takes the values the face shows now; a shape that is gone is forgotten.
	for shape: String in _shown.keys():
		if _shapes.has(shape):
			_write(shape, _shown[shape])
		else:
			_shown.erase(shape)


## The names of a shader's uniforms. A material answers nothing for a uniform that was never set on it, so what a
## material takes is asked of its shader.
static func _uniforms_of(shader: Shader) -> PackedStringArray:
	var names := PackedStringArray()
	for entry: Dictionary in shader.get_shader_uniform_list():
		names.append(String(entry["name"]))
	return names


## What takes a bone back from its pose to the pose a mesh was bound to it in: the bind of the first mesh that is
## skinned to the bone, or else the bone's rest, which is the same for a model that no retarget has changed.
static func _unbind(skeleton: Skeleton3D, meshes: Array[MeshInstance3D], bone: int) -> Transform3D:
	var bone_name := skeleton.get_bone_name(bone)
	for instance: MeshInstance3D in meshes:
		var skin := instance.skin
		if skin == null:
			continue
		for index: int in skin.get_bind_count():
			if skin.get_bind_bone(index) == bone or String(skin.get_bind_name(index)) == bone_name:
				return skin.get_bind_pose(index)
	return skeleton.get_bone_global_rest(bone).affine_inverse()


## The names of the model's blend shapes, each of which `express` takes.
func shapes() -> PackedStringArray:
	return PackedStringArray(_shapes.keys())


## The feelings of FEELINGS that the model has a shape for, each of which `feel` takes.
func feelings() -> PackedStringArray:
	var known := PackedStringArray()
	for feeling: String in FEELINGS:
		if _roles.has(feeling):
			known.append(feeling)
	return known


## Whether the model has what one part of the face needs: "blink", "mouth", "eyes" (two eye bones), or "head".
func has(part: String) -> bool:
	match part:
		"blink":
			return _roles.has("blink") or (_roles.has("blink_l") and _roles.has("blink_r"))
		"mouth":
			return _roles.has("mouth_open")
		"eyes":
			return _eyes.size() == 2
		"head":
			return _head >= 0
	return false


## Moves the mouth with a voice from now on: an AudioStreamPlayer, AudioStreamPlayer2D, or AudioStreamPlayer3D, which
## the game plays as it likes. While it plays, the mouth follows the loudness of its sound, which WasdVoice reads from
## any recording; with a sound that has no length, such as a microphone, the mouth moves in the rhythm of speech.
## None stops it.
func speak(voice: Node) -> void:
	_voice = voice
	_voice_clock = 0.0


## Moves the mouth in the rhythm of speech for some seconds, for a line that the game shows as text without a voice.
## 0 stops it.
func talk(seconds: float) -> void:
	_talk_left = maxf(seconds, 0.0)
	_talk_time = 0.0


## Blinks once, now.
func blink() -> void:
	if _blink_time < 0.0:
		_blink_time = 0.0
		_since_blink = 0.0
		blinked.emit()


## Brings a blend shape to an amount from 0 to 1 over some seconds and holds it there: a smile, raised brows, or any
## shape the model has, by the name `shapes()` gives or by a name of SHAPES or FEELINGS. 0 lets it go. Returns whether
## the model has the shape.
func express(shape: String, amount: float, seconds := 0.25) -> bool:
	var known := String(_roles.get(shape, shape))
	if not _shapes.has(known):
		return false
	var entry: Dictionary = _expressions.get(known, {"value": 0.0})
	entry["from"] = float(entry["value"])
	entry["goal"] = clampf(amount, 0.0, 1.0)
	entry["seconds"] = maxf(seconds, 0.001)
	entry["time"] = 0.0
	_expressions[known] = entry
	return true


## Shows one feeling of FEELINGS and lets the others go, over some seconds: "smile", "grin", "sad", "angry",
## "surprised", "afraid", or "disgusted". An empty name lets every feeling go. Returns whether the model has a shape
## for the feeling.
func feel(feeling: String, amount := 1.0, seconds := 0.4) -> bool:
	for other: String in FEELINGS:
		if other != feeling:
			express(other, 0.0, seconds)
	return feeling != "" and express(feeling, amount, seconds)


## Looks at a point of the world until `look_ahead()` or a `look_target` says otherwise.
func look_at_point(point: Vector3) -> void:
	_point = point
	_has_point = true


## Looks ahead again, where the animation has the head, with eyes that wander.
func look_ahead() -> void:
	_has_point = false
	look_target = null


## How wide the mouth is open so many seconds into a line that has no sound to follow, from 0 to 1: about five
## syllables a second, in phrases of some two seconds with a short rest between them. A line starts with a phrase.
func _rhythm(at: float) -> float:
	var syllable := 0.5 + 0.5 * sin(at * 31.0 + 1.7 * sin(at * 4.3))
	var phrase := clampf(1.6 * sin(at * 2.1 + 0.9 * sin(at * 0.83) - 0.6) + 1.3, 0.0, 1.0)
	return (0.15 + 0.85 * syllable) * phrase


func _process(delta: float) -> void:
	if not active:
		# A face that is switched off rests.
		for shape: String in _shown.keys():
			_show(shape, 0.0)
		return
	# Blinks: the lids fall fast, stay shut for a moment, and rise a little slower; now and then two follow each other.
	var lids := 0.0
	_since_blink += delta
	if _blink_time >= 0.0:
		_blink_time += delta
		if _blink_time < 0.075:
			lids = smoothstep(0.0, 1.0, _blink_time / 0.075)
		elif _blink_time < 0.105:
			lids = 1.0
		elif _blink_time < 0.245:
			lids = 1.0 - smoothstep(0.0, 1.0, (_blink_time - 0.105) / 0.14)
		else:
			_blink_time = -1.0
			if _blink_again:
				_blink_again = false
				_blink_wait = 0.12
	elif blinking:
		_blink_wait -= delta
		if _blink_wait <= 0.0:
			_blink_wait = blink_every * randf_range(0.5, 1.5)
			_blink_again = randf() < 0.15
			blink()
	# Lids follow eyes that look down, and so cover the white above the iris.
	var down := 0.0
	for turn: Vector2 in _eye_turns:
		down += -turn.y * 0.5
	lids = maxf(lids, clampf(down / deg_to_rad(30.0), 0.0, 1.0) * 0.45 * liveliness)
	# The voice: how loud it is now.
	var level := 0.0
	var talking := false
	if _voice != null and is_instance_valid(_voice) and bool(_voice.get("playing")) and not bool(_voice.get("stream_paused")):
		talking = true
		_voice_clock += delta * float(_voice.get("pitch_scale"))
		var stream := _voice.get("stream") as AudioStream
		var heard: float = _voice.call(&"get_playback_position")
		# A build that plays sounds outside the mixer may not tell how far a sound is: the time it has played serves.
		var at := heard if heard > 0.0 else _voice_clock
		level = WasdVoice.level_at(stream, at) if WasdVoice.reads(stream) else _rhythm(_voice_clock)
	else:
		if _voice == null or not is_instance_valid(_voice) or not bool(_voice.get("playing")):
			_voice_clock = 0.0
		if _talk_left > 0.0:
			talking = true
			_talk_left -= delta
			_talk_time += delta
			level = _rhythm(_talk_time)
	# A syllable starts where the voice rises out of a quiet: its mouth takes a shape of its own, and a loud one
	# is stressed, which the brows and the head mark.
	if talking and level > 0.3 and _level_before <= 0.3:
		_syllable = _SYLLABLES[randi() % _SYLLABLES.size()] * liveliness
		if level > 0.7 and randf() < 0.45:
			_stress = 1.0
	_level_before = level
	_stress = maxf(_stress - delta / 0.45, 0.0)
	_syllable_now = _syllable_now.lerp(_syllable if talking else Vector2.ZERO, 1.0 - exp(-22.0 * delta))
	# The mouth opens fast and closes a little slower, as a jaw does.
	var wanted := level * mouth_reach if talking else mouth
	_mouth_now = lerpf(_mouth_now, wanted, 1.0 - exp(-(38.0 if wanted > _mouth_now else 16.0) * delta))
	# Now and then a face at rest moves a little by itself: the brows lift, or the eyes narrow.
	_whim_wait -= delta
	if _whim_wait <= 0.0 and liveliness > 0.0:
		_whim_wait = randf_range(3.0, 8.0)
		var pick: Array = [["brows_up", 0.22, 0.7], ["squint", 0.18, 1.2], ["smile", 0.12, 1.8]][randi() % 3]
		if _shapes.has(String(_roles.get(pick[0], pick[0]))):
			_whim = String(_roles.get(pick[0], pick[0]))
			_whim_amount = float(pick[1]) * liveliness
			_whim_left = float(pick[2])
	_whim_left -= delta
	_whim_now = lerpf(_whim_now, _whim_amount if _whim_left > 0.0 else 0.0, 1.0 - exp(-6.0 * delta))
	var values := {}
	for shape: String in _expressions:
		var entry: Dictionary = _expressions[shape]
		# A face's muscles start and settle softly: an expression that came on at one speed would look switched on.
		entry["time"] = minf(float(entry["time"]) + delta, float(entry["seconds"]))
		entry["value"] = lerpf(float(entry["from"]), float(entry["goal"]), smoothstep(0.0, 1.0, float(entry["time"]) / float(entry["seconds"])))
		values[shape] = float(entry["value"])
	if _roles.has("blink"):
		_raise(values, _roles["blink"], lids)
	else:
		_raise(values, _roles.get("blink_l", ""), lids)
		_raise(values, _roles.get("blink_r", ""), lids)
	# A mouth that purses opens less.
	_raise(values, _roles.get("mouth_open", ""), _mouth_now * (1.0 - 0.4 * _syllable_now.y))
	var shaped := clampf(_mouth_now / maxf(mouth_reach, 0.01), 0.0, 1.0)
	_raise(values, _roles.get("mouth_wide", ""), _syllable_now.x * shaped)
	_raise(values, _roles.get("mouth_narrow", ""), _syllable_now.y * shaped)
	_raise(values, _roles.get("brows_up", ""), _stress * 0.4 * liveliness)
	if _whim != "" and _whim_now > 0.002:
		_raise(values, _whim, _whim_now)
	for shape: String in values:
		_show(shape, values[shape])
	for shape: String in _shown.keys():
		if not values.has(shape):
			_show(shape, 0.0)
	# A smile folds the skin beside the nose and at the mouth's corners, and a frown the skin between the brows
	# and over the chin: skin that knows its folds shades them as the face moves.
	if not _skin_materials.is_empty():
		var smiling := maxf(_of(values, "smile"), _of(values, "grin")) + 0.6 * _of(values, "disgusted")
		var frowning := maxf(maxf(_of(values, "angry"), _of(values, "brows_down") * 0.7), maxf(_of(values, "sad"), _of(values, "disgusted")) * 0.6)
		var folds := Vector2(clampf(smiling, 0.0, 1.0), clampf(frowning, 0.0, 1.0))
		if not folds.is_equal_approx(_folds):
			_folds = folds
			for material: ShaderMaterial in _skin_materials:
				material.set_shader_parameter(&"folds", folds)


## How far a shape is shown now, by its name or by a name of SHAPES or FEELINGS.
func _of(values: Dictionary, shape: String) -> float:
	return float(values.get(String(_roles.get(shape, shape)), 0.0))


## Gives a shape a value unless an expression holds it higher.
func _raise(values: Dictionary, shape: String, value: float) -> void:
	if shape != "":
		values[shape] = maxf(float(values.get(shape, 0.0)), value)


## Sets a blend shape on every mesh that has it, when its value changed. A shape that the face leaves at 0 is never
## written, so an animation or the game may move it.
func _show(shape: String, value: float) -> void:
	if value < 0.001:
		if not _shown.has(shape):
			return
		_shown.erase(shape)
		value = 0.0
	elif absf(value - float(_shown.get(shape, 0.0))) < 0.001:
		return
	else:
		_shown[shape] = value
	_write(shape, value)


func _write(shape: String, value: float) -> void:
	for pair: Array in _shapes.get(shape, []):
		var instance := pair[0] as MeshInstance3D
		if is_instance_valid(instance):
			instance.set_blend_shape_value(pair[1], value)


func _process_modification_with_delta(delta: float) -> void:
	var skeleton := get_skeleton()
	if skeleton == null or (_head < 0 and _eyes.is_empty()):
		return
	var anchor := _head if _head >= 0 else _eyes[0]
	var pose := skeleton.get_bone_global_pose(anchor)
	# The face's own directions now, in the skeleton's space: how the animation has turned the head's mesh.
	var turned := (pose.basis * (_unbound[anchor] as Transform3D).basis).orthonormalized()
	var ahead := (turned * front).normalized()
	var up := (turned * Vector3.UP).normalized()
	var side := up.cross(ahead).normalized()
	# Where the head as a whole would have to turn, to the side and up.
	var wish := Vector2.ZERO
	var point := Vector3.ZERO
	var looking := _has_point or (look_target != null and is_instance_valid(look_target) and look_target.is_inside_tree())
	if looking:
		point = skeleton.global_transform.affine_inverse() * (_point if _has_point else _aim(look_target))
		var eyes_at := [pose.origin + up * 0.07, pose.origin + up * 0.07]
		if _eyes.size() == 2:
			eyes_at = [skeleton.get_bone_global_pose(_eyes[0]).origin, skeleton.get_bone_global_pose(_eyes[1]).origin]
		var between: Vector3 = (eyes_at[0] + eyes_at[1]) * 0.5
		# Eyes cross on what is held before the nose: nothing nearer than a forearm's length is looked at as it is.
		if (point - between).length() < 0.35:
			point = between + (point - between).normalized() * 0.35 if (point - between).length() > 0.001 else between + ahead * 0.35
		wish = _angles(point - between, ahead, up, side)
		# What is behind the head is not looked at: the face turns back to the front.
		if absf(wish.x) > deg_to_rad(head_reach * head_share + eye_reach + 35.0):
			wish = Vector2.ZERO
			looking = false
	if looking:
		# Eyes that jump to something new blink on the way, as a person's do.
		if (wish - _wish_before).length() > deg_to_rad(18.0) and _since_blink > 0.6 and blinking and randf() < 0.7:
			blink()
		_wish_before = wish
		# Eyes do not rest on one spot of what they look at: they go from one of its eyes to the other and to its
		# mouth, and now and then away from it and back.
		_glance_wait -= delta
		if _glance_wait <= 0.0:
			if randf() < 0.14:
				_glance = Vector2(deg_to_rad(randf_range(7.0, 12.0)) * (1.0 if randf() < 0.5 else -1.0), deg_to_rad(randf_range(-6.0, 1.5)))
				_glance_wait = randf_range(0.35, 0.8)
			else:
				_glance = Vector2(deg_to_rad(randf_range(-2.2, 2.2)), deg_to_rad(randf_range(-2.6, 0.8)))
				_glance_wait = randf_range(0.7, 2.4)
	else:
		_glance = Vector2.ZERO
		# Eyes at rest are never still: every second or so they settle on another spot near the front.
		_wander_wait -= delta
		if _wander_wait <= 0.0:
			_wander_wait = randf_range(0.6, 3.2)
			_wander = Vector2.ZERO if randf() < 0.35 else Vector2(randf_range(-0.12, 0.12), randf_range(-0.06, 0.05))
	var head_most := deg_to_rad(head_reach)
	# The head takes more of a turn up or down than of one to the side: eyes that look up from under a lowered
	# brow glower, and eyes that look down from a raised chin sneer.
	var share_up := lerpf(head_share, 1.0, 0.6) if head_share > 0.0 else 0.0
	var head_wish := Vector2(clampf(wish.x * head_share, -head_most, head_most), clampf(wish.y * share_up, -head_most * 0.5, head_most * 0.5)) if _head >= 0 else Vector2.ZERO
	_head_turn = _head_turn.lerp(head_wish, 1.0 - exp(-5.0 * delta))
	# A stressed syllable dips the head a little.
	var nod := _head_turn + Vector2(0.0, -deg_to_rad(2.5) * _stress * liveliness) if _head >= 0 else Vector2.ZERO
	if _head >= 0 and nod.length() > 0.0005:
		# The neck takes a part of the head's turn, which keeps the throat from twisting under a head that turns far.
		var by_neck := NECK_SHARE if _neck >= 0 else 0.0
		if _neck >= 0:
			var neck_pose := skeleton.get_bone_global_pose(_neck)
			var bend := Basis(up, nod.x * by_neck) * Basis(side, -nod.y * by_neck)
			skeleton.set_bone_global_pose(_neck, Transform3D(bend * neck_pose.basis, neck_pose.origin))
			pose = skeleton.get_bone_global_pose(_head)
		var tilt := Basis(up, nod.x * (1.0 - by_neck)) * Basis(side, -nod.y * (1.0 - by_neck))
		skeleton.set_bone_global_pose(_head, Transform3D(tilt * pose.basis, pose.origin))
		var whole := Basis(up, nod.x) * Basis(side, -nod.y)
		ahead = whole * ahead
		up = whole * up
		side = whole * side
	var eye_most := deg_to_rad(eye_reach)
	for index: int in _eyes.size():
		# Each eye turns from where it looks now, with the head where it has just been put, to the point: eyes that
		# each look at what is near meet on it, as a person's do.
		var eye_pose := skeleton.get_bone_global_pose(_eyes[index])
		var eye_turned := (eye_pose.basis * (_unbound[_eyes[index]] as Transform3D).basis).orthonormalized()
		var eye_ahead := (eye_turned * front).normalized()
		var eye_up := (eye_turned * Vector3.UP).normalized()
		var eye_side := eye_up.cross(eye_ahead).normalized()
		var eye_wish := (_angles(point - eye_pose.origin, eye_ahead, eye_up, eye_side) + _glance * liveliness) if looking else _wander * liveliness
		eye_wish = Vector2(clampf(eye_wish.x, -eye_most, eye_most), clampf(eye_wish.y, -eye_most * 0.6, eye_most * 0.6))
		_eye_turns[index] = _eye_turns[index].lerp(eye_wish, 1.0 - exp(-24.0 * delta))
		if _eye_turns[index].length() > 0.0005:
			var roll := Basis(eye_up, _eye_turns[index].x) * Basis(eye_side, -_eye_turns[index].y)
			skeleton.set_bone_global_pose(_eyes[index], Transform3D(roll * eye_pose.basis, eye_pose.origin))
	# The node itself sits between the eyes and faces as the head does, so another face can look at this one and a
	# camera can be aimed at it.
	var seat := pose.origin + up * 0.07
	if _eyes.size() == 2:
		seat = (skeleton.get_bone_global_pose(_eyes[0]).origin + skeleton.get_bone_global_pose(_eyes[1]).origin) * 0.5
	transform = Transform3D(Basis(side, up, ahead), seat)
	# The lids' shade on the eyes stays under the lids of a head that leans or turns.
	if not _eye_materials.is_empty():
		var world_up := (skeleton.global_basis * up).normalized()
		var world_ahead := (skeleton.global_basis * ahead).normalized()
		for material: ShaderMaterial in _eye_materials:
			material.set_shader_parameter(&"head_up", world_up)
			material.set_shader_parameter(&"head_ahead", world_ahead)


## How far a direction lies to the side of straight ahead and above it, as two angles.
func _angles(to: Vector3, ahead: Vector3, up: Vector3, side: Vector3) -> Vector2:
	if to.length() < 0.001:
		return Vector2.ZERO
	return Vector2(atan2(to.dot(side), to.dot(ahead)), atan2(to.dot(up), Vector2(to.dot(side), to.dot(ahead)).length()))


## Where a target is looked at: a character in its face, a WasdCharacter3D without one at the height of its eyes,
## and anything else where it is.
func _aim(target: Node3D) -> Vector3:
	var its_face: Variant = target.get(&"face")
	if its_face is Node3D and its_face != self and (its_face as Node3D).is_inside_tree():
		return (its_face as Node3D).global_position
	var size: Variant = target.get(&"body_size")
	if size is Vector2:
		return target.global_transform * Vector3(0.0, (size as Vector2).x * 0.92, 0.0)
	return target.global_position
