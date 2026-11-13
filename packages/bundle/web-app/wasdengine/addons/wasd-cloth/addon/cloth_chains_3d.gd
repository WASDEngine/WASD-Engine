# SPDX-License-Identifier: CC0-1.0
# Character cloth on bone chains: capes, skirts, coat tails, scarves, long hair, tails, ribbons. Each chain is a run of
# bones named <prefix><group>_<column>_<row>, row 0 at the body, each bone the parent of the next; WASD Cloth for
# Blender makes them with add_chains(). Add this node as a child of the Skeleton3D. When it enters the tree it makes
# one spring-bone setting per chain with the fabric's stiffness, drag, and gravity, puts capsule colliders around the
# hips, torso, and legs of a humanoid skeleton, and then follows the wind of WasdClothWind3D zones. Spring bones cost
# little, never explode, and need no physics engine, but chains do not hold each other: a skirt's chains can part.
@tool
class_name WasdClothChains3D
extends SpringBoneSimulator3D

## Start of the chain bones' names.
@export var prefix := "cloth_":
	set(value):
		prefix = value
		_queue_configure()

## Only the chains of this group, such as cape or skirt; empty takes every group.
@export var group := "":
	set(value):
		group = value
		_queue_configure()

## Fabric preset from WasdClothFabrics: silk, cotton, canvas, denim, leather, or rubber.
@export_enum("silk", "cotton", "canvas", "denim", "leather", "rubber") var fabric := "cotton":
	set(value):
		fabric = value
		_queue_configure()

## Capsules around the hips, torso, and legs of a humanoid skeleton that the chains cannot pass through.
@export var body_colliders := true:
	set(value):
		body_colliders = value
		_queue_configure()

## How the chains follow WasdClothWind3D zones: 0 ignores the wind.
@export_range(0.0, 3.0, 0.01) var wind_response := 1.0

## Thickness of each joint against the colliders, in meters.
@export_range(0.005, 0.2, 0.005, "suffix:m") var joint_radius := 0.03:
	set(value):
		joint_radius = value
		_queue_configure()

## Bone names that each body part may have, in Godot's humanoid profile, MPFB's game_engine rig, Mixamo, and Rigify.
const BODY := {
	"hips": ["Hips", "pelvis", "mixamorig_Hips", "DEF-spine", "DEF-hips", "hips"],
	"chest": ["UpperChest", "Chest", "spine_03", "spine_02", "mixamorig_Spine2", "mixamorig_Spine1", "DEF-spine.003", "DEF-spine.002", "chest"],
	"neck": ["Neck", "neck_01", "mixamorig_Neck", "DEF-spine.004", "neck"],
	"left_thigh": ["LeftUpperLeg", "thigh_l", "mixamorig_LeftUpLeg", "DEF-thigh.L", "thigh.L"],
	"left_shin": ["LeftLowerLeg", "calf_l", "mixamorig_LeftLeg", "DEF-shin.L", "shin.L"],
	"left_foot": ["LeftFoot", "foot_l", "mixamorig_LeftFoot", "DEF-foot.L", "foot.L"],
	"right_thigh": ["RightUpperLeg", "thigh_r", "mixamorig_RightUpLeg", "DEF-thigh.R", "thigh.R"],
	"right_shin": ["RightLowerLeg", "calf_r", "mixamorig_RightLeg", "DEF-shin.R", "shin.R"],
	"right_foot": ["RightFoot", "foot_r", "mixamorig_RightFoot", "DEF-foot.R", "foot.R"],
}

## Body capsules: the part whose bone carries it, the part it reaches, and its radius as a share of that length.
const CAPSULES := [
	["hips", "chest", 0.42],
	["chest", "neck", 0.55],
	["left_thigh", "left_shin", 0.2],
	["left_shin", "left_foot", 0.13],
	["right_thigh", "right_shin", 0.2],
	["right_shin", "right_foot", 0.13],
]

var _chain_count := 0
var _configure_queued := false


func _ready() -> void:
	configure()


func _process(_delta: float) -> void:
	if Engine.is_editor_hint() or wind_response <= 0.0:
		return
	var skeleton := get_skeleton()
	var at := skeleton.global_position if skeleton != null else global_position
	# The simulator adds external_force to each joint's motion like gravity, in meters per second.
	external_force = WasdClothWind3D.velocity_at(get_tree(), at) * 0.25 * wind_response


## Chains found by the last configure().
func chain_count() -> int:
	return _chain_count


## Find the chains and body bones of the parent skeleton again and rebuild the settings and colliders.
func configure() -> void:
	_configure_queued = false
	var skeleton := get_skeleton()
	if skeleton == null:
		push_warning("WASD Cloth: %s must be a child of a Skeleton3D." % name)
		return
	var chains := _find_chains(skeleton)
	clear_settings()
	setting_count = chains.size()
	_chain_count = chains.size()
	var preset := WasdClothFabrics.chain(fabric)
	var keys := chains.keys()
	keys.sort()
	for i in keys.size():
		var joints: Array = chains[keys[i]]
		set_root_bone(i, joints[0])
		set_end_bone(i, joints[joints.size() - 1])
		set_extend_end_bone(i, true)
		set_end_bone_length(i, _end_length(skeleton, joints))
		set_radius(i, joint_radius)
		set_stiffness(i, float(preset["stiffness"]))
		set_drag(i, float(preset["drag"]))
		set_gravity(i, float(preset["gravity"]))
		set_gravity_direction(i, Vector3.DOWN)
		set_enable_all_child_collisions(i, true)
	if chains.is_empty():
		push_warning("WASD Cloth: %s found no bones named %s<group>_<column>_<row> in %s." % [name, prefix, skeleton.name])
	for child in get_children(true):
		if child is SpringBoneCollision3D and child.has_meta(&"wasd_cloth"):
			remove_child(child)
			child.queue_free()
	if body_colliders:
		_add_body_colliders(skeleton)
	reset()


## The settings are rebuilt from the bones whenever the node enters the tree, so scenes do not store them.
func _validate_property(property: Dictionary) -> void:
	var property_name := String(property["name"])
	if property_name == "setting_count" or property_name.begins_with("settings/"):
		property["usage"] = property["usage"] & ~PROPERTY_USAGE_STORAGE


func _queue_configure() -> void:
	if not is_inside_tree() or _configure_queued:
		return
	_configure_queued = true
	configure.call_deferred()


## Chains keyed by "<group>/<column>", each a list of bone indices from row 0 down.
func _find_chains(skeleton: Skeleton3D) -> Dictionary:
	var pattern := RegEx.create_from_string("^%s(.+)_(\\d+)_(\\d+)$" % _escape(prefix))
	var rows := {}
	for bone in skeleton.get_bone_count():
		var found := pattern.search(skeleton.get_bone_name(bone))
		if found == null or (group != "" and found.get_string(1) != group):
			continue
		var key := "%s/%s" % [found.get_string(1), found.get_string(2).pad_zeros(4)]
		if not rows.has(key):
			rows[key] = []
		rows[key].append([found.get_string(3).to_int(), bone])
	var chains := {}
	for key in rows:
		var joints: Array = rows[key]
		joints.sort_custom(func(a: Array, b: Array) -> bool: return a[0] < b[0])
		var bones: Array[int] = []
		for joint in joints:
			bones.append(joint[1])
		var linked := true
		for k in range(1, bones.size()):
			if skeleton.get_bone_parent(bones[k]) != bones[k - 1]:
				linked = false
		if not linked:
			push_warning("WASD Cloth: the bones of chain %s are not each the parent of the next; it is left out." % key)
			continue
		chains[key] = bones
	return chains


func _end_length(skeleton: Skeleton3D, joints: Array) -> float:
	if joints.size() < 2:
		return 0.1
	var last := skeleton.get_bone_global_rest(joints[joints.size() - 1]).origin
	var before := skeleton.get_bone_global_rest(joints[joints.size() - 2]).origin
	return maxf(last.distance_to(before), 0.01)


func _add_body_colliders(skeleton: Skeleton3D) -> void:
	var bones := {}
	for part in BODY:
		for candidate in BODY[part]:
			var bone := skeleton.find_bone(candidate)
			if bone >= 0:
				bones[part] = bone
				break
	for capsule in CAPSULES:
		if not bones.has(capsule[0]) or not bones.has(capsule[1]):
			continue
		var from_rest := skeleton.get_bone_global_rest(bones[capsule[0]])
		var to_rest := skeleton.get_bone_global_rest(bones[capsule[1]])
		var reach := from_rest.affine_inverse() * to_rest.origin
		var length := reach.length()
		if length < 0.01:
			continue
		var collider := SpringBoneCollisionCapsule3D.new()
		collider.name = "Wasd%s" % String(capsule[0]).to_pascal_case()
		collider.set_meta(&"wasd_cloth", true)
		collider.bone_name = skeleton.get_bone_name(bones[capsule[0]])
		collider.radius = length * float(capsule[2])
		collider.height = length + 2.0 * collider.radius
		collider.position_offset = reach * 0.5
		collider.rotation_offset = Quaternion(Vector3.UP, reach.normalized())
		add_child(collider, false, Node.INTERNAL_MODE_BACK)


static func _escape(text: String) -> String:
	var escaped := ""
	for character in text:
		escaped += "\\" + character if ".^$*+?()[]{}|\\".contains(character) else character
	return escaped
