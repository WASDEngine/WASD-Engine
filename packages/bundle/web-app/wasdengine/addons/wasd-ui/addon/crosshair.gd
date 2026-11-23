# SPDX-License-Identifier: CC0-1.0
# A crosshair in the middle of the screen: a dot, a cross, a ring, or all three, that opens as the aim spreads and
# shows a mark when a shot lands.
class_name WasdCrosshair
extends Control

enum Shape { DOT, CROSS, RING, CROSS_AND_DOT }

@export var shape := Shape.CROSS_AND_DOT: set = _set_shape
@export var color := Color(1, 1, 1, 0.9): set = _set_color
## How far the aim has opened, in pixels at a scale of 1: 0 while still, more while moving or firing.
@export var spread := 0.0: set = _set_spread
## The length of the cross's arms and the ring's radius, in pixels at a scale of 1.
@export var arm := 8.0
@export var gap := 5.0

var _mark := 0.0


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	set_anchors_preset(Control.PRESET_FULL_RECT)


## Shows the mark of a shot that landed; `strong` for a kill or a critical hit.
func hit(strong := false) -> void:
	_mark = 1.5 if strong else 1.0
	queue_redraw()


func _process(delta: float) -> void:
	if _mark > 0.0:
		_mark = maxf(_mark - delta * 4.0, 0.0)
		queue_redraw()


func _draw() -> void:
	var kit := get_node_or_null(^"/root/WasdUi")
	var scale: float = kit.call(&"get_ui_scale") if kit != null and kit.has_method(&"get_ui_scale") else 1.0
	var middle := (size * 0.5).floor()
	var thick := maxf(roundf(2.0 * scale), 1.0)
	var dark := Color(0, 0, 0, color.a * 0.5)
	var open := (gap + spread) * scale
	if shape == Shape.CROSS or shape == Shape.CROSS_AND_DOT:
		for way: Vector2 in [Vector2.RIGHT, Vector2.LEFT, Vector2.UP, Vector2.DOWN]:
			draw_line(middle + way * (open - 1.0), middle + way * (open + arm * scale + 1.0), dark, thick + 2.0)
			draw_line(middle + way * open, middle + way * (open + arm * scale), color, thick)
	if shape == Shape.RING:
		draw_arc(middle, (arm + spread) * scale, 0.0, TAU, 48, dark, thick + 2.0, true)
		draw_arc(middle, (arm + spread) * scale, 0.0, TAU, 48, color, thick, true)
	if shape == Shape.DOT or shape == Shape.CROSS_AND_DOT or shape == Shape.RING:
		draw_circle(middle, thick + 1.0, dark)
		draw_circle(middle, thick, color)
	if _mark > 0.0:
		# The mark of a hit: four short strokes on the diagonals.
		var tone := Color(1.0, 0.25, 0.2, minf(_mark, 1.0)) if _mark > 1.0 else Color(1, 1, 1, _mark)
		for way: Vector2 in [Vector2(1, 1), Vector2(-1, 1), Vector2(1, -1), Vector2(-1, -1)]:
			var along := way.normalized()
			draw_line(middle + along * (open + 2.0 * scale), middle + along * (open + (arm + 2.0) * scale), tone, thick + 1.0)


func _set_shape(to: Shape) -> void:
	shape = to
	queue_redraw()


func _set_color(to: Color) -> void:
	color = to
	queue_redraw()


func _set_spread(to: float) -> void:
	spread = maxf(to, 0.0)
	queue_redraw()
