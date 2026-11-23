# SPDX-License-Identifier: CC0-1.0
# Puts a humanoid's feet on the ground it stands on. On stairs and slopes each foot reaches down or lifts to the
# surface under it, the hips sink far enough for the lower foot to reach, and the soles tilt with the slope. Each
# leg is bent from the pose the animation gave it, so a clip keeps its look and on level ground nothing changes.
# WasdCharacter3D adds one to a model whose skeleton has Godot's humanoid bone names; it works under any
# CharacterBody3D whose origin is at its feet.
class_name WasdFootPlacement3D
extends SkeletonModifier3D

## The body whose floor the feet stand on; none takes the nearest CharacterBody3D above the skeleton.
@export var body: CharacterBody3D
## The physics layers the feet may stand on.
@export_flags_3d_physics var ground_mask := 1
## How far above and below the body's floor a foot follows the ground, in meters. A step or drop beyond it is left
## to the animation.
@export_range(0.05, 1.0, 0.01) var reach := 0.45
## How far the hips sink so that the lower foot reaches its ground, in meters. Further than a stair's height makes
## a climb look like a crouch; beyond it the lower leg stretches as far as it can.
@export_range(0.0, 0.6, 0.01) var sink := 0.24
## How far the soles tilt with the ground, in degrees; 0 keeps them as the animation has them.
@export_range(0.0, 60.0, 1.0) var sole_tilt := 30.0
## How fast the feet follow a change of ground: higher is snappier.
@export_range(1.0, 60.0, 0.5) var follow := 14.0

const LEGS := [["LeftUpperLeg", "LeftLowerLeg", "LeftFoot"], ["RightUpperLeg", "RightLowerLeg", "RightFoot"]]

var _hips := -1
## For each leg: its three bones, where its foot was last, the ground height wanted and reached, and the ground's slope.
var _legs: Array[Dictionary] = []
var _hips_drop := 0.0
var _weight := 0.0
var _grounded := false


## Whether the skeleton has the bones the feet need: Hips and both legs under Godot's humanoid names.
static func fits(skeleton: Skeleton3D) -> bool:
	if skeleton == null or skeleton.find_bone("Hips") < 0:
		return false
	for leg: Array in LEGS:
		for bone: String in leg:
			if skeleton.find_bone(bone) < 0:
				return false
	return true


func _ready() -> void:
	_find_bones()
	if body == null:
		var above := get_parent()
		while above != null and not above is CharacterBody3D:
			above = above.get_parent()
		body = above as CharacterBody3D


func _skeleton_changed(_old: Skeleton3D, _new: Skeleton3D) -> void:
	_find_bones()


func _find_bones() -> void:
	_legs.clear()
	_hips = -1
	var skeleton := get_skeleton()
	if not fits(skeleton):
		return
	_hips = skeleton.find_bone("Hips")
	for leg: Array in LEGS:
		_legs.append({
			"upper": skeleton.find_bone(leg[0]), "lower": skeleton.find_bone(leg[1]), "foot": skeleton.find_bone(leg[2]),
			"at": Vector3.ZERO, "seen": false, "wanted": 0.0, "offset": 0.0, "slope": Vector3.UP, "tilt": Vector3.UP,
		})


## Tells the feet that the body's floor rose, or fell, by this much at once, as on a stair: feet and hips keep their
## places and take the change up over a moment.
func floor_moved(by: float) -> void:
	_hips_drop -= by
	for leg: Dictionary in _legs:
		leg["offset"] = float(leg["offset"]) - by
		leg["wanted"] = float(leg["wanted"]) - by


## Looks for the ground under each foot. The rays are cast in the physics step, where the physics space may be read
## whatever thread it runs on, from where the animation last had the feet.
func _physics_process(_delta: float) -> void:
	if body == null or _legs.is_empty() or not is_inside_tree():
		return
	# A WasdCharacter3D also stands while it rests on a stair's edge.
	_grounded = body.call(&"is_grounded") if body.has_method(&"is_grounded") else body.is_on_floor()
	if not _grounded:
		return
	var space := body.get_world_3d().direct_space_state
	var floor_y := body.global_position.y
	for leg: Dictionary in _legs:
		if not leg["seen"]:
			continue
		var at: Vector3 = leg["at"]
		var query := PhysicsRayQueryParameters3D.create(Vector3(at.x, floor_y + reach, at.z), Vector3(at.x, floor_y - reach, at.z), ground_mask, [body.get_rid()])
		var hit := space.intersect_ray(query)
		if hit.is_empty():
			leg["wanted"] = 0.0
			leg["slope"] = Vector3.UP
		else:
			leg["wanted"] = float(hit["position"].y) - floor_y
			leg["slope"] = hit["normal"]


func _process_modification_with_delta(delta: float) -> void:
	var skeleton := get_skeleton()
	if skeleton == null or _legs.is_empty() or body == null:
		return
	var to_world := skeleton.global_transform
	var to_skeleton := to_world.affine_inverse()
	for leg: Dictionary in _legs:
		leg["at"] = to_world * skeleton.get_bone_global_pose(leg["foot"]).origin
		leg["seen"] = true
	_weight = move_toward(_weight, 1.0 if _grounded else 0.0, delta * 6.0)
	var gain := 1.0 - exp(-follow * delta)
	var lowest := 0.0
	for leg: Dictionary in _legs:
		var wanted: float = leg["wanted"] if _grounded else 0.0
		# A foot rises to a step ahead of it twice as fast as it sinks to one below, so that it does not pass through.
		leg["offset"] = lerpf(leg["offset"], wanted, gain if wanted <= float(leg["offset"]) else 1.0 - exp(-follow * 2.0 * delta))
		leg["tilt"] = (leg["tilt"] as Vector3).lerp(leg["slope"] if _grounded else Vector3.UP, gain).normalized()
		lowest = minf(lowest, leg["offset"])
	_hips_drop = lerpf(_hips_drop, maxf(lowest, -sink), gain)
	if _weight <= 0.001:
		return
	# The hips sink until the lower foot reaches its ground; the other leg then bends up to its own.
	var up := to_skeleton.basis * Vector3.UP
	var hips := skeleton.get_bone_global_pose(_hips)
	hips.origin += up * (_hips_drop * _weight)
	skeleton.set_bone_global_pose(_hips, hips)
	for leg: Dictionary in _legs:
		_place(skeleton, leg, up * ((float(leg["offset"]) - _hips_drop) * _weight), to_skeleton.basis)


## Bends one leg so that its foot stands `lift` away from where the animation has it, in the skeleton's space.
func _place(skeleton: Skeleton3D, leg: Dictionary, lift: Vector3, to_skeleton: Basis) -> void:
	var upper := skeleton.get_bone_global_pose(leg["upper"])
	var lower := skeleton.get_bone_global_pose(leg["lower"])
	var foot := skeleton.get_bone_global_pose(leg["foot"])
	var hip := upper.origin
	var thigh := lower.origin - hip
	var shin := foot.origin - lower.origin
	var thigh_length := thigh.length()
	var shin_length := shin.length()
	if thigh_length < 0.0001 or shin_length < 0.0001:
		return
	var reach_now := foot.origin - hip
	var wanted := reach_now + lift
	var distance := clampf(wanted.length(), absf(thigh_length - shin_length) + 0.001, thigh_length + shin_length - 0.001)
	if wanted.length() < 0.0001 or reach_now.length() < 0.0001:
		return
	var along := wanted.normalized()
	var was_along := reach_now.normalized()
	# The knee keeps the side of the hip-to-foot line on which the animation has it; a straight leg bends forward.
	var bend := thigh - was_along * thigh.dot(was_along)
	if bend.length() < thigh_length * 0.02:
		# A humanoid skeleton faces +Z.
		bend = Vector3.BACK
	bend = _arc(was_along, along) * bend
	bend -= along * bend.dot(along)
	if bend.length() < 0.0001:
		return
	bend = bend.normalized()
	var near := (thigh_length * thigh_length + distance * distance - shin_length * shin_length) / (2.0 * distance)
	var out := sqrt(maxf(thigh_length * thigh_length - near * near, 0.0))
	var knee := hip + along * near + bend * out
	var ankle := hip + along * distance
	upper.basis = Basis(_arc(thigh.normalized(), (knee - hip).normalized())) * upper.basis
	skeleton.set_bone_global_pose(leg["upper"], upper)
	lower = Transform3D(Basis(_arc(shin.normalized(), (ankle - knee).normalized())) * lower.basis, knee)
	skeleton.set_bone_global_pose(leg["lower"], lower)
	# The sole keeps the turn the animation gave it and leans with the ground under it.
	var up := (to_skeleton * Vector3.UP).normalized()
	var slope := (to_skeleton * (leg["tilt"] as Vector3)).normalized()
	var axis := up.cross(slope)
	var most := deg_to_rad(sole_tilt) * _weight
	if axis.length() > 0.001 and most > 0.0:
		foot.basis = Basis(axis.normalized(), minf(up.angle_to(slope), most)) * foot.basis
	foot.origin = ankle
	skeleton.set_bone_global_pose(leg["foot"], foot)


## The shortest turn that takes one direction to another; none when they are the same or opposite.
func _arc(from: Vector3, to: Vector3) -> Quaternion:
	var axis := from.cross(to)
	if axis.length() < 0.00001:
		return Quaternion.IDENTITY
	return Quaternion(axis.normalized(), from.angle_to(to))
