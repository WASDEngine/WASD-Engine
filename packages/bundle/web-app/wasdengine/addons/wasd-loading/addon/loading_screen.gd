# SPDX-License-Identifier: CC0-1.0
# The loading screen WasdLoader shows when the game has none of its own: the game's name, a bar that fills, and a
# line of advice, drawn in code with no picture or font of its own. A screen of the game's own may have the same
# two methods, `set_progress` and `set_tip`.
class_name WasdLoadingScreen
extends Control

## The backdrop: a little darker at the top than at the bottom, a faint glow of the accent behind the bar, and a
## grain of one color step that keeps the wide gradients from showing bands.
const BACKDROP := "
shader_type canvas_item;
uniform vec4 base : source_color = vec4(0.06, 0.07, 0.09, 1.0);
uniform vec4 glow : source_color = vec4(0.96, 0.76, 0.32, 1.0);
uniform vec2 glow_at = vec2(0.5, 0.52);
uniform float wide = 1.78;

void fragment() {
	vec3 color = mix(base.rgb * 0.72, base.rgb * 1.06 + 0.01, UV.y);
	vec2 off = (UV - glow_at) * vec2(wide, 1.0);
	color += glow.rgb * exp(-dot(off, off) * 4.5) * 0.055;
	color += (fract(52.9829189 * fract(dot(FRAGCOORD.xy, vec2(0.06711056, 0.00583715)))) - 0.5) / 255.0;
	COLOR = vec4(color, 1.0);
}
"

var title := "": set = _set_title
var background := Color(0.06, 0.07, 0.09)
var accent := Color(0.96, 0.76, 0.32)

var _wanted := 0.0
var _shown := 0.0
var _clock := 0.0
var _backdrop := ColorRect.new()
var _title := Label.new()
var _tip := Label.new()


func _init() -> void:
	set_anchors_preset(Control.PRESET_FULL_RECT)
	mouse_filter = Control.MOUSE_FILTER_STOP
	var shader := Shader.new()
	shader.code = BACKDROP
	var material := ShaderMaterial.new()
	material.shader = shader
	_backdrop.material = material
	_backdrop.set_anchors_preset(Control.PRESET_FULL_RECT)
	_backdrop.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_backdrop.show_behind_parent = true
	add_child(_backdrop)
	# The title stands on one line above the bar, in a heavier cut of the font; the advice wraps below the bar.
	var heavy := FontVariation.new()
	heavy.variation_embolden = 0.5
	_title.add_theme_font_override(&"font", heavy)
	_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_title.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	_title.clip_text = true
	_title.anchor_left = 0.08
	_title.anchor_right = 0.92
	_title.anchor_top = 0.24
	_title.anchor_bottom = 0.52
	_tip.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_tip.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_tip.anchor_left = 0.5
	_tip.anchor_right = 0.5
	_tip.anchor_top = 0.52
	_tip.anchor_bottom = 0.52
	_tip.grow_vertical = Control.GROW_DIRECTION_END
	_tip.modulate.a = 0.78
	add_child(_title)
	add_child(_tip)


func _ready() -> void:
	resized.connect(_lay_out)
	_lay_out()


## How much is done, from 0 to 1. The bar moves there smoothly.
func set_progress(part: float) -> void:
	_wanted = clampf(part, 0.0, 1.0)


## A line of advice under the bar; empty for none.
func set_tip(tip: String) -> void:
	_tip.text = tip


func _process(delta: float) -> void:
	_clock += delta
	_shown = move_toward(_shown, _wanted, maxf(delta * 1.6, (_wanted - _shown) * delta * 6.0))
	queue_redraw()


func _draw() -> void:
	var bar := _bar()
	var round := int(bar.size.y * 0.5)
	var track := StyleBoxFlat.new()
	track.bg_color = Color(1.0, 1.0, 1.0, 0.14)
	track.set_corner_radius_all(round)
	draw_style_box(track, bar)
	var filled := maxf(bar.size.x * _shown, bar.size.y)
	# A soft pulse at the bar's end: the page is alive even while the bar waits for one large file.
	var pulse := 0.5 + 0.5 * sin(_clock * 3.5)
	var halo := StyleBoxFlat.new()
	halo.bg_color = Color(accent, 0.1 + 0.16 * pulse)
	halo.set_corner_radius_all(int(bar.size.y * 1.5))
	draw_style_box(halo, Rect2(bar.position + Vector2(filled - bar.size.y * 2.0, -bar.size.y), Vector2(bar.size.y * 3.0, bar.size.y * 3.0)))
	var fill := StyleBoxFlat.new()
	fill.bg_color = accent
	fill.set_corner_radius_all(round)
	draw_style_box(fill, Rect2(bar.position, Vector2(filled, bar.size.y)))


func _bar() -> Rect2:
	var wide := clampf(size.x * 0.36, 160.0, 640.0)
	var high := maxf(roundf(size.y * 0.014), 6.0)
	return Rect2(Vector2((size.x - wide) * 0.5, size.y * 0.52), Vector2(wide, high))


func _lay_out() -> void:
	var bar := _bar()
	var backdrop := _backdrop.material as ShaderMaterial
	backdrop.set_shader_parameter(&"base", background)
	backdrop.set_shader_parameter(&"glow", accent)
	backdrop.set_shader_parameter(&"wide", size.x / maxf(size.y, 1.0))
	# One step of space above the bar and one below it.
	var step := bar.size.y * 2.6
	_title.add_theme_font_size_override(&"font_size", int(clampf(size.y * 0.066, 20.0, 80.0)))
	_title.offset_bottom = -step * 0.75
	_tip.add_theme_font_size_override(&"font_size", int(clampf(size.y * 0.026, 12.0, 30.0)))
	var half := minf(size.x * 0.4, size.y * 0.4)
	_tip.offset_left = -half
	_tip.offset_right = half
	_tip.offset_top = bar.size.y + step


func _set_title(value: String) -> void:
	title = value
	_title.text = value
