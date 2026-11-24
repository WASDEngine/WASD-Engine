# SPDX-License-Identifier: CC0-1.0
# A bar for health, stamina, mana, a boss, or progress: it glides to a new value, shows for a moment what was
# lost, flashes when hit, and pulses when low. It takes its shape from the look that WasdUi has on.
class_name WasdBar
extends Control

## The value fell to nothing.
signal emptied

## The most the bar holds, and how much it holds now. Setting `value` moves the bar there. `value` stays between 0 and
## `max_value`, as a ProgressBar's does: set `max_value` first, and a lower one takes `value` down with it.
@export var max_value := 100.0: set = _set_max_value
@export var value := 100.0: set = _set_value
## The fill's color, and a word before the bar, such as "HP".
@export var color := Color(0.86, 0.2, 0.22): set = _set_color
@export var label := "": set = _set_label
## Shows "62 / 100" on the bar.
@export var numbers := false: set = _set_numbers
## Cuts the bar into this many pieces, as for hearts or ammunition; 0 leaves it whole.
@export_range(0, 40) var pieces := 0: set = _set_pieces
## Below this share of the whole the bar pulses.
@export_range(0.0, 1.0, 0.01) var low_at := 0.25
## The bar's length and height in pixels at a scale of 1.
@export var length := 260.0: set = _set_length
@export var height := 20.0: set = _set_height

var _shown := 1.0
var _lost := 1.0
var _hold := 0.0
var _flash := 0.0
var _clock := 0.0


func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	_shown = _share()
	_lost = _shown
	_fit()
	var kit := _kit()
	if kit != null and kit.has_signal(&"look_changed"):
		kit.connect(&"look_changed", _fit)


func _process(delta: float) -> void:
	_clock += delta
	var wanted := _share()
	var moved := false
	if not is_equal_approx(_shown, wanted):
		_shown = move_toward(_shown, wanted, maxf(delta * 1.5, absf(wanted - _shown) * delta * 10.0))
		moved = true
	# What was lost stays a moment, then follows.
	_hold = maxf(_hold - delta, 0.0)
	if _lost > _shown and _hold <= 0.0:
		_lost = move_toward(_lost, _shown, delta * 0.6)
		moved = true
	elif _lost < _shown:
		_lost = _shown
	if _flash > 0.0:
		_flash = maxf(_flash - delta * 4.0, 0.0)
		moved = true
	if moved or (wanted > 0.0 and wanted <= low_at):
		queue_redraw()


func _draw() -> void:
	var look := _look()
	var scale := _scale()
	var font := get_theme_default_font()
	var font_size := roundi(13.0 * scale)
	var bar := Rect2(Vector2.ZERO, Vector2(length, height) * scale)
	if label != "":
		var wide := font.get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x + 8.0 * scale
		# The word stands over the game itself: white with a dark outline, whatever the look.
		var word_at := Vector2(0.0, bar.size.y * 0.5 + font_size * 0.36)
		draw_string_outline(font, word_at, label, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, maxi(roundi(4.0 * scale), 3), Color(0, 0, 0, 0.75))
		draw_string(font, word_at, label, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, Color.WHITE)
		bar.position.x = wide
	var radius := mini(roundi(float(look["radius"]) * scale), int(bar.size.y * 0.5))
	var edge := roundi(float(look["edge"]) * scale) if int(look["edge"]) > 1 else 0
	var back := StyleBoxFlat.new()
	back.bg_color = Color(0, 0, 0, 0.6)
	back.border_color = look["panel_edge"]
	back.set_border_width_all(edge)
	back.set_corner_radius_all(radius)
	draw_style_box(back, bar)
	var inner := bar.grow(-float(edge) - roundf(1.0 * scale))
	var inner_radius := maxi(radius - edge - 1, 0)
	if _lost > _shown:
		var was := StyleBoxFlat.new()
		was.bg_color = Color(1.0, 0.95, 0.8, 0.85)
		was.set_corner_radius_all(inner_radius)
		draw_style_box(was, Rect2(inner.position, Vector2(inner.size.x * _lost, inner.size.y)))
	if _shown > 0.0:
		var fill := StyleBoxFlat.new()
		var low := _share() > 0.0 and _share() <= low_at
		fill.bg_color = color.lerp(Color.WHITE, clampf(_flash + (0.25 + 0.25 * sin(_clock * 9.0) if low else 0.0), 0.0, 1.0))
		fill.set_corner_radius_all(inner_radius)
		draw_style_box(fill, Rect2(inner.position, Vector2(maxf(inner.size.x * _shown, inner.size.y * 0.5), inner.size.y)))
		# A paler upper half, which gives the fill a little shape.
		draw_rect(Rect2(inner.position + Vector2(inner_radius, 0), Vector2(maxf(inner.size.x * _shown - inner_radius * 2.0, 0.0), inner.size.y * 0.45)), Color(1, 1, 1, 0.12))
	for piece: int in range(1, pieces):
		var x := inner.position.x + inner.size.x * piece / pieces
		draw_line(Vector2(x, inner.position.y), Vector2(x, inner.end.y), Color(0, 0, 0, 0.55), maxf(roundf(2.0 * scale), 1.0))
	if numbers:
		var shown := "%d / %d" % [roundi(value), roundi(max_value)]
		var across := font.get_string_size(shown, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size).x
		var at := Vector2(bar.position.x + (bar.size.x - across) * 0.5, bar.size.y * 0.5 + font_size * 0.36)
		draw_string_outline(font, at, shown, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, maxi(roundi(3.0 * scale), 2), Color(0, 0, 0, 0.7))
		draw_string(font, at, shown, HORIZONTAL_ALIGNMENT_LEFT, -1, font_size, Color.WHITE)


func _share() -> float:
	return clampf(value / max_value, 0.0, 1.0) if max_value > 0.0 else 0.0


func _kit() -> Node:
	return get_node_or_null(^"/root/WasdUi") if is_inside_tree() else null


func _look() -> Dictionary:
	var kit := _kit()
	return kit.call(&"values") if kit != null and kit.has_method(&"values") else WasdUiLooks.values("clean")


func _scale() -> float:
	var kit := _kit()
	return kit.call(&"get_ui_scale") if kit != null and kit.has_method(&"get_ui_scale") else 1.0


func _fit() -> void:
	var scale := _scale()
	var wide := length * scale
	if label != "":
		wide += get_theme_default_font().get_string_size(label, HORIZONTAL_ALIGNMENT_LEFT, -1, roundi(13.0 * scale)).x + 8.0 * scale
	custom_minimum_size = Vector2(wide, height * scale)
	queue_redraw()


func _set_value(to: float) -> void:
	var before := value
	value = clampf(to, 0.0, max_value)
	if value < before:
		# A hit: what was lost stays in view for a moment, and the fill flashes. A value given before the bar is in
		# play, as by a scene, is where it starts.
		if is_node_ready():
			_hold = 0.45
			_flash = 0.8
		if value <= 0.0 and before > 0.0:
			emptied.emit()
	queue_redraw()


func _set_max_value(to: float) -> void:
	max_value = maxf(to, 0.0001)
	if value > max_value:
		value = max_value
	queue_redraw()


func _set_color(to: Color) -> void:
	color = to
	queue_redraw()


func _set_label(to: String) -> void:
	label = to
	if is_inside_tree():
		_fit()


func _set_numbers(to: bool) -> void:
	numbers = to
	queue_redraw()


func _set_pieces(to: int) -> void:
	pieces = to
	queue_redraw()


func _set_length(to: float) -> void:
	length = to
	if is_inside_tree():
		_fit()


func _set_height(to: float) -> void:
	height = to
	if is_inside_tree():
		_fit()
