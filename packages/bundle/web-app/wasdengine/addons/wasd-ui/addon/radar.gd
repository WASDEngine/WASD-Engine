# SPDX-License-Identifier: CC0-1.0
# A radar: a disc that shows where things lie round the player, each as a dot in its own color. It draws no map,
# costs nothing to speak of, and works in 3D and in 2D.
class_name WasdRadar
extends Control

## The node at the radar's middle: the player. A Node3D or a Node2D. Like a WasdCharacter3D, a node with a `model`
## and a `model_turn` faces where that model faces, and one with a `camera_rig` looks where that rig looks.
@export var center: Node
## Meters (or pixels in 2D) from the middle to the rim.
@export var reach := 40.0
## True turns the radar with the center, so that what lies ahead is at the top: ahead of its camera rig if it has
## one, and otherwise where it faces; the arrow points where it faces. False keeps north (-Z, or up in 2D) at the top.
@export var turns := true
## What lies beyond the rim shows on the rim, smaller.
@export var keeps_far := true
## The disc's width in pixels at a scale of 1.
@export var width := 140.0: set = _set_width

var _tracked: Array[Array] = []


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fit()
	var kit := get_node_or_null(^"/root/WasdUi")
	if kit != null and kit.has_signal(&"look_changed"):
		kit.connect(&"look_changed", _fit)


## Shows a node on the radar as a dot in `color`; `large` for what matters, such as a goal. It leaves the radar by
## itself when it is freed.
func track(node: Node, color := Color(0.95, 0.3, 0.25), large := false) -> void:
	untrack(node)
	_tracked.append([weakref(node), color, large])


func untrack(node: Node) -> void:
	for index: int in range(_tracked.size() - 1, -1, -1):
		var kept: Object = (_tracked[index][0] as WeakRef).get_ref()
		if kept == null or kept == node:
			_tracked.remove_at(index)


func _process(_delta: float) -> void:
	queue_redraw()


func _draw() -> void:
	var kit := get_node_or_null(^"/root/WasdUi")
	var look: Dictionary = kit.call(&"values") if kit != null and kit.has_method(&"values") else WasdUiLooks.values("clean")
	var scale: float = kit.call(&"get_ui_scale") if kit != null and kit.has_method(&"get_ui_scale") else 1.0
	var middle := size * 0.5
	var rim := minf(size.x, size.y) * 0.5 - 2.0
	var text: Color = look["text"]
	draw_circle(middle, rim, Color(look["panel"], 0.7))
	draw_arc(middle, rim, 0.0, TAU, 64, look["panel_edge"], maxf(float(look["edge"]) * scale, 1.5), true)
	draw_arc(middle, rim * 0.5, 0.0, TAU, 48, Color(text, 0.12), 1.0, true)
	draw_line(middle - Vector2(rim, 0), middle + Vector2(rim, 0), Color(text, 0.1), 1.0)
	draw_line(middle - Vector2(0, rim), middle + Vector2(0, rim), Color(text, 0.1), 1.0)
	# Marks at the four points of the compass; the one for north is longer.
	var alive := center != null and is_instance_valid(center)
	var heading := _view(center) if turns and alive else 0.0
	for quarter: int in 4:
		var way := Vector2.UP.rotated(-heading + quarter * PI * 0.5)
		draw_line(middle + way * (rim - (9.0 if quarter == 0 else 5.0) * scale), middle + way * rim, Color(text, 0.9 if quarter == 0 else 0.5), maxf(2.0 * scale, 1.5))
	if not alive:
		return
	var here := _flat(center)
	for index: int in range(_tracked.size() - 1, -1, -1):
		var node: Node = (_tracked[index][0] as WeakRef).get_ref()
		if node == null or not node.is_inside_tree():
			if node == null:
				_tracked.remove_at(index)
			continue
		var off := (_flat(node) - here).rotated(-heading) / reach
		var far := off.length() > 1.0
		if far and not keeps_far:
			continue
		var at := middle + (off.normalized() if far else off) * (rim - 4.0 * scale)
		var dot := (5.0 if _tracked[index][2] else 3.2) * scale * (0.7 if far else 1.0)
		draw_circle(at, dot + 1.0, Color(0, 0, 0, 0.5))
		draw_circle(at, dot, _tracked[index][1])
	# The player: an arrow that points where the center faces.
	var facing := _heading(center) - heading
	var arrow := PackedVector2Array([Vector2(0, -9), Vector2(6.5, 6.5), Vector2(0, 3), Vector2(-6.5, 6.5)])
	for point: int in arrow.size():
		arrow[point] = middle + arrow[point].rotated(facing) * scale
	draw_colored_polygon(arrow, look["accent"])


## A node's place seen from above: X and Z in 3D, X and Y in 2D.
static func _flat(node: Node) -> Vector2:
	if node is Node3D:
		var place := (node as Node3D).global_position
		return Vector2(place.x, place.z)
	return (node as Node2D).global_position if node is Node2D else Vector2.ZERO


## The angle a node faces, clockwise from north, seen from above: its -Z, or for a node that turns only its `model`,
## that model's +Z turned back by `model_turn` degrees.
static func _heading(node: Node) -> float:
	if node is Node3D:
		var ahead := -(node as Node3D).global_basis.z
		var model: Variant = node.get(&"model")
		var turn: Variant = node.get(&"model_turn")
		if is_instance_valid(model) and model is Node3D and (model as Node3D).is_inside_tree() and (turn is float or turn is int):
			ahead = (model as Node3D).global_basis * Vector3.BACK.rotated(Vector3.UP, -deg_to_rad(float(turn)))
		return atan2(ahead.x, -ahead.z)
	return (node as Node2D).global_rotation + PI * 0.5 if node is Node2D else 0.0


## The angle a node looks, clockwise from north, seen from above: that of its `camera_rig` if it has one in the tree,
## and otherwise the angle it faces.
static func _view(node: Node) -> float:
	var rig: Variant = node.get(&"camera_rig")
	if is_instance_valid(rig) and rig is Node3D and (rig as Node3D).is_inside_tree():
		return _heading(rig)
	return _heading(node)


func _fit() -> void:
	var kit := get_node_or_null(^"/root/WasdUi")
	var scale: float = kit.call(&"get_ui_scale") if kit != null and kit.has_method(&"get_ui_scale") else 1.0
	custom_minimum_size = Vector2.ONE * width * scale


func _set_width(to: float) -> void:
	width = to
	if is_inside_tree():
		_fit()
