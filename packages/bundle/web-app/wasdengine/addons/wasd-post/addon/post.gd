# SPDX-License-Identifier: CC0-1.0
# The look of the finished picture: color grade, lens, and frame effects in one pass over the screen. Add one WasdPost
# to the game and pick a `look` by name, then change any property after it. It affects what is drawn below its canvas
# layer, the 3D world by default, and not what is drawn above, such as the HUD. It runs on the Forward+, Mobile, and
# Compatibility renderers.
class_name WasdPost
extends CanvasLayer

const SHADER := preload("res://addons/wasd_post/post.gdshader")

## A look by name: one of WasdPostLooks.names(). Setting it sets every property below to that look's values.
@export var look := "none": set = set_look
## How much of the look shows, from 0 (the plain picture) to 1. Tween it to fade a look in or out.
@export_range(0.0, 1.0, 0.01) var amount := 1.0: set = _set_amount

@export_group("Lens")
## Color fringes toward the corners, in pixels at the corner.
@export_range(0.0, 8.0, 0.1) var aberration := 0.0: set = _set_aberration
## Edge contrast, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var sharpen := 0.0: set = _set_sharpen
## Blur above and below a sharp band, in pixels at the screen's edge: the look of a miniature.
@export_range(0.0, 16.0, 0.1) var tilt_shift := 0.0: set = _set_tilt_shift
## Where the sharp band lies, from 0 (top of the screen) to 1 (bottom).
@export_range(0.0, 1.0, 0.01) var tilt_focus := 0.55: set = _set_tilt_focus
## Half the height of the sharp band, as a part of the screen.
@export_range(0.0, 0.5, 0.01) var tilt_band := 0.12: set = _set_tilt_band
## Side of the square blocks the picture is drawn in, in pixels; 1 draws every pixel.
@export_range(1.0, 16.0, 1.0) var pixel_size := 1.0: set = _set_pixel_size

@export_group("Color")
## Brightness in photographic stops: 1 doubles it, -1 halves it.
@export_range(-3.0, 3.0, 0.01) var exposure := 0.0: set = _set_exposure
@export_range(0.0, 2.0, 0.01) var contrast := 1.0: set = _set_contrast
@export_range(0.0, 2.0, 0.01) var saturation := 1.0: set = _set_saturation
## From -1 (cool) to 1 (warm).
@export_range(-1.0, 1.0, 0.01) var temperature := 0.0: set = _set_temperature
## Tint of the dark tones; middle gray tints nothing.
@export var shadows := Color(0.5, 0.5, 0.5): set = _set_shadows
## Tint of the bright tones; middle gray tints nothing.
@export var highlights := Color(0.5, 0.5, 0.5): set = _set_highlights
## Steps per color channel; 0 keeps every shade.
@export_range(0.0, 32.0, 1.0) var color_levels := 0.0: set = _set_color_levels
## Steps of brightness with each color's hue kept, for flat comic shades; 0 keeps every shade.
@export_range(0.0, 16.0, 1.0) var tone_levels := 0.0: set = _set_tone_levels

@export_group("Frame")
## Darkening toward the corners, from 0 to 1.
@export_range(0.0, 2.0, 0.01) var vignette := 0.0: set = _set_vignette
## How gradually the corners darken.
@export_range(0.05, 1.0, 0.01) var vignette_softness := 0.55: set = _set_vignette_softness
@export var vignette_color := Color(0, 0, 0): set = _set_vignette_color
## Film grain, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var grain := 0.0: set = _set_grain
## Dark horizontal lines of an old screen, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var scanlines := 0.0: set = _set_scanlines
## The bulge of an old screen's glass, and the colored stripes of its picture tube, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var curve := 0.0: set = _set_curve
@export_range(0.0, 1.0, 0.01) var mask := 0.0: set = _set_mask

@export_group("Style")
## A soft glow over the picture, as through a misted lens, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var soften := 0.0: set = _set_soften
## Ink lines where the picture's brightness steps, from 0 to 1, and their color.
@export_range(0.0, 1.0, 0.01) var edges := 0.0: set = _set_edges
@export var edge_color := Color(0.05, 0.05, 0.08): set = _set_edge_color
## A color the graded picture is multiplied by.
@export var tint := Color(1, 1, 1): set = _set_tint
## Pencil strokes on paper in place of the picture's tones, from 0 to 1.
@export_range(0.0, 1.0, 0.01) var hatch := 0.0: set = _set_hatch

var _material := ShaderMaterial.new()
var _rect := ColorRect.new()


func _init() -> void:
	# Below the default canvas, so the pass colors the 3D world and leaves Controls and other canvas layers alone.
	layer = -1
	_material.shader = SHADER
	_rect.material = _material
	_rect.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_rect.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(_rect, false, Node.INTERNAL_MODE_FRONT)


## Sets every property to a look's values. An unknown name gives the plain picture and a warning.
func set_look(value: String) -> void:
	if not WasdPostLooks.LOOKS.has(value):
		push_warning("WasdPost: no look named %s; the looks are %s." % [value, ", ".join(WasdPostLooks.names())])
	look = value
	var values := WasdPostLooks.values(value)
	for property: String in values:
		set(property, values[property])


## Fades to another look over `seconds`: every property moves from its value now to the look's value.
func fade_to(next: String, seconds: float) -> Tween:
	var values := WasdPostLooks.values(next)
	var tween := create_tween().set_parallel(true)
	for property: String in values:
		tween.tween_property(self, property, values[property], seconds)
	tween.chain().tween_callback(func() -> void: look = next)
	return tween


func _pass(uniform_name: StringName, value: Variant) -> void:
	_material.set_shader_parameter(uniform_name, value)


func _set_amount(value: float) -> void:
	amount = value
	_pass(&"amount", value)
	# A look that shows nothing costs nothing.
	_rect.visible = value > 0.0


func _set_aberration(value: float) -> void:
	aberration = value
	_pass(&"aberration", value)


func _set_sharpen(value: float) -> void:
	sharpen = value
	_pass(&"sharpen", value)


func _set_tilt_shift(value: float) -> void:
	tilt_shift = value
	_pass(&"tilt_shift", value)


func _set_tilt_focus(value: float) -> void:
	tilt_focus = value
	_pass(&"tilt_focus", value)


func _set_tilt_band(value: float) -> void:
	tilt_band = value
	_pass(&"tilt_band", value)


func _set_pixel_size(value: float) -> void:
	pixel_size = value
	_pass(&"pixel_size", value)


func _set_exposure(value: float) -> void:
	exposure = value
	_pass(&"exposure", value)


func _set_contrast(value: float) -> void:
	contrast = value
	_pass(&"contrast", value)


func _set_saturation(value: float) -> void:
	saturation = value
	_pass(&"saturation", value)


func _set_temperature(value: float) -> void:
	temperature = value
	_pass(&"temperature", value)


func _set_shadows(value: Color) -> void:
	shadows = value
	_pass(&"shadows", value)


func _set_highlights(value: Color) -> void:
	highlights = value
	_pass(&"highlights", value)


func _set_color_levels(value: float) -> void:
	color_levels = value
	_pass(&"color_levels", value)


func _set_vignette(value: float) -> void:
	vignette = value
	_pass(&"vignette", value)


func _set_vignette_softness(value: float) -> void:
	vignette_softness = value
	_pass(&"vignette_softness", value)


func _set_vignette_color(value: Color) -> void:
	vignette_color = value
	_pass(&"vignette_color", value)


func _set_grain(value: float) -> void:
	grain = value
	_pass(&"grain", value)


func _set_scanlines(value: float) -> void:
	scanlines = value
	_pass(&"scanlines", value)


func _set_curve(value: float) -> void:
	curve = value
	_pass(&"curve", value)


func _set_mask(value: float) -> void:
	mask = value
	_pass(&"mask", value)


func _set_soften(value: float) -> void:
	soften = value
	_pass(&"soften", value)


func _set_edges(value: float) -> void:
	edges = value
	_pass(&"edges", value)


func _set_edge_color(value: Color) -> void:
	edge_color = value
	_pass(&"edge_color", value)


func _set_tint(value: Color) -> void:
	tint = value
	_pass(&"tint", value)


func _set_hatch(value: float) -> void:
	hatch = value
	_pass(&"hatch", value)


func _set_tone_levels(value: float) -> void:
	tone_levels = value
	_pass(&"tone_levels", value)
