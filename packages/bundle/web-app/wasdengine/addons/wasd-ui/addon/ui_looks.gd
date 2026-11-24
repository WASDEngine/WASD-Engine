# SPDX-License-Identifier: CC0-1.0
# The looks of WASD UI: each is a whole Theme for Godot's controls, built in code from a handful of colors and
# numbers, with no picture and no font file. `WasdUiLooks.make("fantasy")` returns one; the WasdUi autoload puts
# one on the whole game.
class_name WasdUiLooks
extends RefCounted

## What a look is made of. Colors: a panel and its edge, text and quieter text, the accent (buttons that matter,
## bars, focus, selection), a plain button and its edge. Numbers: the edge's width and the corners' radius in
## pixels at a scale of 1, the shadow under panels, how much bolder than the font's own the text is, and extra
## pixels between letters. `caps` sets buttons in the heavy cut of the font; `cut` cuts corners off straight
## instead of rounding them; `bevel` shades edges like a raised frame; `drop` is the offset in pixels of a hard
## shadow under panels and buttons, as under a sticker.
const LOOKS := {
	## Dark glass, soft corners: fits most games.
	"clean": {"panel": Color(0.07, 0.08, 0.11, 0.9), "panel_edge": Color(1, 1, 1, 0.1), "text": Color(0.94, 0.95, 0.97), "muted": Color(0.62, 0.66, 0.72),
		"accent": Color(0.3, 0.6, 1.0), "button": Color(1, 1, 1, 0.08), "button_edge": Color(1, 1, 1, 0.14), "edge": 1, "radius": 10, "shadow": 14, "bold": 0.1, "spacing": 0, "caps": false, "cut": false, "bevel": false, "drop": 0},
	## White cards, dark text: bright, casual, and puzzle games.
	"light": {"panel": Color(0.98, 0.98, 0.99, 0.97), "panel_edge": Color(0.72, 0.73, 0.78), "text": Color(0.13, 0.15, 0.2), "muted": Color(0.42, 0.45, 0.52),
		"accent": Color(0.16, 0.48, 0.96), "button": Color(0, 0, 0, 0.05), "button_edge": Color(0, 0, 0, 0.12), "edge": 1, "radius": 12, "shadow": 16, "bold": 0.1, "spacing": 0, "caps": false, "cut": false, "bevel": false, "drop": 0},
	## Dark wood and gold: role-playing and medieval games.
	"fantasy": {"panel": Color(0.15, 0.1, 0.07, 0.95), "panel_edge": Color(0.76, 0.58, 0.28), "text": Color(0.96, 0.89, 0.74), "muted": Color(0.72, 0.62, 0.48),
		"accent": Color(0.86, 0.62, 0.22), "button": Color(0.3, 0.2, 0.12, 0.95), "button_edge": Color(0.62, 0.46, 0.22), "edge": 3, "radius": 5, "shadow": 10, "bold": 0.45, "spacing": 1, "caps": false, "cut": false, "bevel": true, "drop": 0},
	## Thin bright lines on dark blue, square corners, capitals: space and cyberpunk games.
	"scifi": {"panel": Color(0.02, 0.07, 0.11, 0.86), "panel_edge": Color(0.3, 0.9, 1.0, 0.75), "text": Color(0.82, 0.97, 1.0), "muted": Color(0.45, 0.68, 0.76),
		"accent": Color(0.18, 0.88, 1.0), "button": Color(0.18, 0.88, 1.0, 0.1), "button_edge": Color(0.3, 0.9, 1.0, 0.6), "edge": 1, "radius": 9, "shadow": 0, "bold": 0.2, "spacing": 2, "caps": true, "cut": true, "bevel": false, "drop": 0},
	## Thick dark outlines, round corners, bright fills: cartoon and family games.
	"playful": {"panel": Color(1.0, 0.98, 0.93, 0.98), "panel_edge": Color(0.17, 0.15, 0.27), "text": Color(0.17, 0.15, 0.27), "muted": Color(0.42, 0.4, 0.52),
		"accent": Color(1.0, 0.45, 0.33), "button": Color(1.0, 0.86, 0.38), "button_edge": Color(0.17, 0.15, 0.27), "edge": 3, "radius": 18, "shadow": 0, "bold": 0.7, "spacing": 0, "caps": false, "cut": false, "bevel": false, "drop": 4},
	## Hard edges and flat blocks: pixel-art and retro games.
	"pixel": {"panel": Color(0.11, 0.11, 0.19, 1.0), "panel_edge": Color(0.94, 0.94, 0.88), "text": Color(0.94, 0.94, 0.88), "muted": Color(0.6, 0.6, 0.66),
		"accent": Color(0.96, 0.74, 0.2), "button": Color(0.22, 0.22, 0.36, 1.0), "button_edge": Color(0.94, 0.94, 0.88), "edge": 2, "radius": 0, "shadow": 0, "bold": 0.5, "spacing": 1, "caps": true, "cut": false, "bevel": false, "drop": 4},
}


## How the boxes of the look being made are shaped: set by make() for _box().
static var _cut := false
static var _bevel := false


## The names of the looks.
static func names() -> PackedStringArray:
	return PackedStringArray(LOOKS.keys())


## The values of a look, with `accent` replaced if one is given. An unknown name gives "clean".
static func values(look: String, accent: Variant = null) -> Dictionary:
	var result: Dictionary = (LOOKS.get(look, LOOKS["clean"]) as Dictionary).duplicate()
	if accent is Color:
		result["accent"] = accent
	return result


## A Theme for a look: every common control styled, text sizes multiplied by `scale`. `font` replaces Godot's
## own font.
static func make(look := "clean", accent: Variant = null, scale := 1.0, font: Font = null) -> Theme:
	var v := values(look, accent)
	var theme := Theme.new()
	var text: Color = v["text"]
	var muted: Color = v["muted"]
	var main: Color = v["accent"]
	var edge := maxi(roundi(float(v["edge"]) * scale), 1) if int(v["edge"]) > 0 else 0
	var radius := roundi(float(v["radius"]) * scale)
	var pad := roundi(10.0 * scale)
	# Text on the accent: dark on a light accent, light on a dark one.
	var on_main := Color(0.06, 0.07, 0.1) if main.get_luminance() > 0.55 else Color(1, 1, 1)

	# A variation of no font draws no letters: without a font of the game's own, Godot's stands in.
	var face: Font = font if font != null else ThemeDB.fallback_font
	var regular := FontVariation.new()
	regular.base_font = face
	regular.variation_embolden = v["bold"]
	regular.spacing_glyph = roundi(float(v["spacing"]) * scale)
	var heavy := FontVariation.new()
	heavy.base_font = face
	heavy.variation_embolden = float(v["bold"]) + 0.5
	heavy.spacing_glyph = roundi((float(v["spacing"]) + 1.0) * scale)
	theme.default_font = regular
	theme.default_font_size = roundi(16.0 * scale)
	# Godot's theme names a font and a size for each kind of control: every kind takes the look's.
	for kind: String in ["Label", "Button", "LinkButton", "LineEdit", "TextEdit", "CheckBox", "CheckButton", "OptionButton", "MenuButton", "ProgressBar", "TabContainer", "TabBar",
			"ItemList", "Tree", "PopupMenu", "TooltipLabel", "SpinBox"]:
		theme.set_font("font", kind, regular)
		theme.set_font_size("font_size", kind, roundi(16.0 * scale))
	for part: String in ["normal", "bold", "italics", "bold_italics", "mono"]:
		theme.set_font_size(part + "_font_size", "RichTextLabel", roundi(16.0 * scale))
	theme.set_font("normal_font", "RichTextLabel", regular)
	theme.set_font("bold_font", "RichTextLabel", heavy)
	theme.set_color("default_color", "RichTextLabel", v["text"])

	_cut = v["cut"]
	_bevel = v["bevel"]
	var drop := roundi(float(v["drop"]) * scale)
	# Panels.
	var panel := _box(v["panel"], v["panel_edge"], edge, radius, pad)
	panel.shadow_size = roundi(float(v["shadow"]) * scale)
	panel.shadow_color = Color(0, 0, 0, 0.35)
	panel.shadow_offset = Vector2(0, roundi(float(v["shadow"]) * scale * 0.3))
	if drop > 0:
		_drop(panel, drop, v["panel_edge"])
	for kind: String in ["Panel", "PanelContainer", "PopupPanel", "PopupMenu", "AcceptDialog", "TooltipPanel"]:
		theme.set_stylebox("panel", kind, panel)
	var flat_panel := _box(Color(text, 0.05), Color(text, 0.08), edge, radius, pad)
	theme.set_stylebox("panel", "ItemList", flat_panel)
	theme.set_stylebox("panel", "Tree", flat_panel)
	theme.set_stylebox("panel", "ScrollContainer", StyleBoxEmpty.new())

	# Labels and headers.
	theme.set_color("font_color", "Label", text)
	theme.set_color("font_shadow_color", "Label", Color(0, 0, 0, 0.0))
	for header: Array in [["HeaderLarge", 2.0], ["HeaderMedium", 1.5], ["HeaderSmall", 1.2]]:
		theme.set_type_variation(header[0], "Label")
		theme.set_font("font", header[0], heavy)
		theme.set_font_size("font_size", header[0], roundi(16.0 * scale * float(header[1])))
		theme.set_color("font_color", header[0], text)
	theme.set_type_variation("MutedLabel", "Label")
	theme.set_color("font_color", "MutedLabel", muted)
	# Text that stands over the game itself, not on a panel: white with a dark outline, whatever the look, so that
	# it reads over sky and over shadow.
	theme.set_type_variation("HudLabel", "Label")
	theme.set_font("font", "HudLabel", heavy)
	theme.set_font_size("font_size", "HudLabel", roundi(18.0 * scale))
	theme.set_color("font_color", "HudLabel", Color(1, 1, 1))
	theme.set_color("font_outline_color", "HudLabel", Color(0, 0, 0, 0.8))
	theme.set_constant("outline_size", "HudLabel", maxi(roundi(5.0 * scale), 3))
	theme.set_color("font_color", "TooltipLabel", text)

	# Buttons: a plain one, and one in the accent for the choice that matters ("AccentButton").
	var button: Color = v["button"]
	var button_edge: Color = v["button_edge"]
	var lifts := Color(1, 1, 1, 0.1) if text.get_luminance() > 0.5 else Color(0, 0, 0, 0.08)
	var button_pad := Vector2(roundi(18.0 * scale), roundi(9.0 * scale))
	for kind: String in ["Button", "OptionButton", "MenuButton"]:
		theme.set_stylebox("normal", kind, _drop(_box(button, button_edge, edge, radius, button_pad), drop, button_edge))
		theme.set_stylebox("hover", kind, _drop(_box(button.blend(lifts), main, edge, radius, button_pad), drop, button_edge))
		theme.set_stylebox("pressed", kind, _box(Color(main, 0.35) if button.a < 0.5 else main.lerp(button, 0.4), main, edge, radius, button_pad))
		theme.set_stylebox("disabled", kind, _box(Color(button, button.a * 0.4), Color(button_edge, button_edge.a * 0.4), edge, radius, button_pad))
		theme.set_stylebox("focus", kind, _box(Color(0, 0, 0, 0), main, maxi(edge, roundi(2.0 * scale)), radius, button_pad))
		theme.set_font("font", kind, heavy if v["caps"] else regular)
		theme.set_color("font_color", kind, text)
		theme.set_color("font_hover_color", kind, text)
		theme.set_color("font_pressed_color", kind, text)
		theme.set_color("font_focus_color", kind, text)
		theme.set_color("font_disabled_color", kind, Color(text, 0.4))
		theme.set_color("icon_normal_color", kind, text)
	theme.set_type_variation("AccentButton", "Button")
	var accent_edge := (button_edge if drop > 0 else main.darkened(0.25)) if edge > 1 else main
	theme.set_stylebox("normal", "AccentButton", _drop(_box(main, accent_edge, edge, radius, button_pad), drop, button_edge))
	theme.set_stylebox("hover", "AccentButton", _drop(_box(main.lightened(0.12), accent_edge if edge > 1 else main.lightened(0.12), edge, radius, button_pad), drop, button_edge))
	theme.set_stylebox("pressed", "AccentButton", _box(main.darkened(0.15), main.darkened(0.3), edge, radius, button_pad))
	theme.set_stylebox("focus", "AccentButton", _box(Color(0, 0, 0, 0), text, maxi(edge, roundi(2.0 * scale)), radius, button_pad))
	theme.set_font("font", "AccentButton", heavy)
	for state: String in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		theme.set_color(state, "AccentButton", on_main)

	# Text entry.
	var field_pad := Vector2(roundi(12.0 * scale), roundi(8.0 * scale))
	for kind: String in ["LineEdit", "TextEdit"]:
		theme.set_stylebox("normal", kind, _box(Color(text, 0.1), Color(text, 0.2), maxi(edge, 1), radius, field_pad))
		theme.set_stylebox("focus", kind, _box(Color(text, 0.13), main, maxi(edge, 1), radius, field_pad))
		theme.set_stylebox("read_only", kind, _box(Color(text, 0.03), Color(text, 0.08), maxi(edge, 1), radius, field_pad))
		theme.set_color("font_color", kind, text)
		theme.set_color("font_placeholder_color", kind, Color(muted, 0.8))
		theme.set_color("caret_color", kind, main)
		theme.set_color("selection_color", kind, Color(main, 0.4))

	# Bars and sliders.
	var thin := maxi(roundi(8.0 * scale), 4)
	var track := _box(Color(text, 0.14), Color(0, 0, 0, 0), 0, mini(radius, thin / 2), 0)
	var filled := _box(main, Color(0, 0, 0, 0), 0, mini(radius, thin / 2), 0)
	var bar_back := _box(Color(text, 0.14), button_edge if edge > 1 else Color(0, 0, 0, 0), edge if edge > 1 else 0, mini(radius, roundi(9.0 * scale)), 0)
	# Slimmer than a button, so that a bar is not taken for one.
	bar_back.content_margin_top = roundi(3.0 * scale)
	bar_back.content_margin_bottom = roundi(3.0 * scale)
	theme.set_stylebox("background", "ProgressBar", bar_back)
	theme.set_stylebox("fill", "ProgressBar", _box(main, Color(0, 0, 0, 0), 0, mini(radius, roundi(9.0 * scale)), 0))
	theme.set_color("font_color", "ProgressBar", text)
	for kind: String in ["HSlider", "VSlider"]:
		var rail := track.duplicate() as StyleBoxFlat
		var done := filled.duplicate() as StyleBoxFlat
		if kind == "HSlider":
			rail.content_margin_top = thin * 0.5
			rail.content_margin_bottom = thin * 0.5
			done.content_margin_top = thin * 0.5
			done.content_margin_bottom = thin * 0.5
		else:
			rail.content_margin_left = thin * 0.5
			rail.content_margin_right = thin * 0.5
			done.content_margin_left = thin * 0.5
			done.content_margin_right = thin * 0.5
		theme.set_stylebox("slider", kind, rail)
		theme.set_stylebox("grabber_area", kind, done)
		theme.set_stylebox("grabber_area_highlight", kind, done)
		var knob := _disc(roundi(20.0 * scale), text if text.get_luminance() > 0.5 else main, v["panel_edge"] if edge > 1 else Color(0, 0, 0, 0.25), radius == 0 and not _cut)
		theme.set_icon("grabber", kind, knob)
		theme.set_icon("grabber_highlight", kind, knob)
		theme.set_icon("grabber_disabled", kind, knob)
	for kind: String in ["HScrollBar", "VScrollBar"]:
		theme.set_stylebox("scroll", kind, _box(Color(text, 0.05), Color(0, 0, 0, 0), 0, mini(radius, thin / 2), roundi(3.0 * scale)))
		theme.set_stylebox("grabber", kind, _box(Color(text, 0.3), Color(0, 0, 0, 0), 0, mini(radius, thin / 2), roundi(3.0 * scale)))
		theme.set_stylebox("grabber_highlight", kind, _box(Color(text, 0.45), Color(0, 0, 0, 0), 0, mini(radius, thin / 2), roundi(3.0 * scale)))
		theme.set_stylebox("grabber_pressed", kind, _box(main, Color(0, 0, 0, 0), 0, mini(radius, thin / 2), roundi(3.0 * scale)))

	# Check boxes and switches, drawn here: an empty box and one with a check, a switch off and on.
	var mark := roundi(22.0 * scale)
	for kind: String in ["CheckBox", "CheckButton"]:
		theme.set_color("font_color", kind, text)
		theme.set_color("font_hover_color", kind, text)
		theme.set_color("font_pressed_color", kind, text)
		theme.set_color("font_focus_color", kind, text)
		theme.set_constant("h_separation", kind, roundi(10.0 * scale))
		for state: String in ["normal", "hover", "pressed", "hover_pressed", "focus", "disabled"]:
			theme.set_stylebox(state, kind, StyleBoxEmpty.new())
	theme.set_icon("unchecked", "CheckBox", _tick(mark, Color(text, 0.5), main, on_main, false, radius == 0 and not _cut))
	theme.set_icon("checked", "CheckBox", _tick(mark, main, main, on_main, true, radius == 0 and not _cut))
	theme.set_icon("radio_unchecked", "CheckBox", _disc(mark, Color(0, 0, 0, 0), Color(text, 0.5), false, 0.0))
	theme.set_icon("radio_checked", "CheckBox", _disc(mark, main, main, false, 0.45))
	theme.set_icon("unchecked", "CheckButton", _switch(mark, Color(text, 0.25), text, false, radius == 0 and not _cut))
	theme.set_icon("checked", "CheckButton", _switch(mark, main, on_main, true, radius == 0 and not _cut))

	# Tabs.
	var tab_pad := Vector2(roundi(16.0 * scale), roundi(8.0 * scale))
	for kind: String in ["TabContainer", "TabBar"]:
		var chosen := _box(v["panel"], v["panel_edge"], edge, radius, tab_pad)
		chosen.border_width_bottom = 0
		chosen.corner_radius_bottom_left = 0
		chosen.corner_radius_bottom_right = 0
		theme.set_stylebox("tab_selected", kind, chosen)
		theme.set_stylebox("tab_unselected", kind, _box(Color(0, 0, 0, 0), Color(0, 0, 0, 0), 0, radius, tab_pad))
		theme.set_stylebox("tab_hovered", kind, _box(Color(text, 0.06), Color(0, 0, 0, 0), 0, radius, tab_pad))
		theme.set_stylebox("tab_focus", kind, StyleBoxEmpty.new())
		theme.set_color("font_selected_color", kind, text)
		theme.set_color("font_unselected_color", kind, muted)
		theme.set_color("font_hovered_color", kind, text)
	theme.set_stylebox("panel", "TabContainer", panel)

	# Lists, menus, and lines.
	for kind: String in ["ItemList", "Tree", "PopupMenu"]:
		theme.set_color("font_color", kind, text)
		theme.set_color("font_selected_color", kind, on_main)
		theme.set_color("font_hover_color", kind, text)
	var chosen_row := _box(main, Color(0, 0, 0, 0), 0, maxi(radius - edge, 0), roundi(4.0 * scale))
	for kind: String in ["ItemList", "Tree"]:
		theme.set_stylebox("selected", kind, chosen_row)
		theme.set_stylebox("selected_focus", kind, chosen_row)
		theme.set_stylebox("hovered", kind, _box(Color(text, 0.07), Color(0, 0, 0, 0), 0, maxi(radius - edge, 0), roundi(4.0 * scale)))
		theme.set_stylebox("focus", kind, StyleBoxEmpty.new())
	theme.set_stylebox("hover", "PopupMenu", _box(Color(main, 0.9), Color(0, 0, 0, 0), 0, maxi(radius - edge, 0), roundi(4.0 * scale)))
	theme.set_color("font_hover_color", "PopupMenu", on_main)
	var line := StyleBoxLine.new()
	line.color = Color(text, 0.16)
	line.thickness = maxi(edge, 1)
	theme.set_stylebox("separator", "HSeparator", line)
	var upright := line.duplicate() as StyleBoxLine
	upright.vertical = true
	theme.set_stylebox("separator", "VSeparator", upright)
	theme.set_stylebox("separator", "PopupMenu", line)
	for kind: String in ["VBoxContainer", "HBoxContainer"]:
		theme.set_constant("separation", kind, roundi(8.0 * scale))
	theme.set_constant("h_separation", "GridContainer", roundi(10.0 * scale))
	theme.set_constant("v_separation", "GridContainer", roundi(8.0 * scale))
	for side: String in ["margin_left", "margin_top", "margin_right", "margin_bottom"]:
		theme.set_constant(side, "MarginContainer", roundi(12.0 * scale))
	return theme


## A filled box with an edge, rounded corners, and room inside: `room` is a number for all sides, or a Vector2 of
## the sides' and the top and bottom's.
static func _box(fill: Color, edge_color: Color, edge: int, radius: int, room: Variant) -> StyleBoxFlat:
	var box := StyleBoxFlat.new()
	box.bg_color = fill
	box.border_color = edge_color
	box.set_border_width_all(edge)
	box.set_corner_radius_all(radius)
	box.anti_aliasing = radius > 0
	# One step makes a corner a straight cut; a blended edge shades like a raised frame.
	box.corner_detail = 1 if _cut else 8
	box.border_blend = _bevel and edge > 1
	# The room inside is counted from the edge's inner side, so a thick frame does not crowd what it holds.
	var across: float = ((room as Vector2).x if room is Vector2 else float(room)) + edge
	var down: float = ((room as Vector2).y if room is Vector2 else float(room)) + edge
	box.content_margin_left = across
	box.content_margin_right = across
	box.content_margin_top = down
	box.content_margin_bottom = down
	return box


## Gives a box a hard shadow below and to the right, as under a sticker: nothing where the offset is 0.
static func _drop(box: StyleBoxFlat, offset: int, color: Color) -> StyleBoxFlat:
	if offset > 0:
		box.shadow_size = 1
		box.shadow_color = Color(color, 1.0)
		box.shadow_offset = Vector2(offset, offset)
	return box


## A small picture of a disc (or a square, for looks with hard corners), with a rim; `dot` fills only that share of
## it and leaves a ring.
static func _disc(side: int, fill: Color, rim: Color, square := false, dot := 1.0) -> ImageTexture:
	var image := Image.create_empty(side, side, false, Image.FORMAT_RGBA8)
	var middle := (side - 1) * 0.5
	var reach := side * 0.5 - 1.0
	for y: int in side:
		for x: int in side:
			var away := maxf(absf(x - middle), absf(y - middle)) if square else Vector2(x - middle, y - middle).length()
			var inside := clampf(reach - away + 0.5, 0.0, 1.0)
			var ring := clampf(away - (reach - maxf(side * 0.1, 1.5)) + 0.5, 0.0, 1.0)
			var color := fill if dot >= 1.0 or away <= reach * dot else Color(fill, 0.0)
			color = color.lerp(rim, ring * rim.a) if rim.a > 0.0 else color
			image.set_pixel(x, y, Color(color, color.a * inside if rim.a == 0.0 else maxf(color.a, ring * rim.a) * inside))
	return ImageTexture.create_from_image(image)


## A small picture of a check box: its outline, and when `checked` a filled box with a check mark.
static func _tick(side: int, rim: Color, fill: Color, mark: Color, checked: bool, square: bool) -> ImageTexture:
	var image := Image.create_empty(side, side, false, Image.FORMAT_RGBA8)
	var middle := (side - 1) * 0.5
	var reach := side * 0.5 - 1.0
	var round := 0.0 if square else side * 0.22
	var rim_width := maxf(side * 0.09, 1.5)
	for y: int in side:
		for x: int in side:
			# The distance beyond a rounded square's edge.
			var off := Vector2(absf(x - middle), absf(y - middle)) - Vector2(reach - round, reach - round)
			var away := Vector2(maxf(off.x, 0.0), maxf(off.y, 0.0)).length() + minf(maxf(off.x, off.y), 0.0) - round
			var inside := clampf(0.5 - away, 0.0, 1.0)
			var on_rim := clampf(away + rim_width + 0.5, 0.0, 1.0)
			var color := Color(fill, 1.0 if checked else 0.0)
			if not checked:
				color = Color(rim, rim.a * on_rim)
			image.set_pixel(x, y, Color(color, color.a * inside))
	if checked:
		# The check: two strokes.
		var strokes := [[Vector2(0.24, 0.52), Vector2(0.43, 0.7)], [Vector2(0.43, 0.7), Vector2(0.77, 0.3)]]
		var thick := maxf(side * 0.07, 1.2)
		for y: int in side:
			for x: int in side:
				var at := Vector2(x, y)
				var nearest := INF
				for stroke: Array in strokes:
					var from: Vector2 = (stroke[0] as Vector2) * side
					var to: Vector2 = (stroke[1] as Vector2) * side
					var along := clampf((at - from).dot(to - from) / (to - from).length_squared(), 0.0, 1.0)
					nearest = minf(nearest, at.distance_to(from + (to - from) * along))
				var covers := clampf(thick - nearest + 0.5, 0.0, 1.0)
				if covers > 0.0:
					image.set_pixel(x, y, image.get_pixel(x, y).lerp(mark, covers))
	return ImageTexture.create_from_image(image)


## A small picture of a switch: a track with its knob at the left (off) or the right (on).
static func _switch(high: int, track: Color, knob: Color, on: bool, square: bool) -> ImageTexture:
	var wide := roundi(high * 1.8)
	var image := Image.create_empty(wide, high, false, Image.FORMAT_RGBA8)
	var half := (high - 1) * 0.5
	var knob_at := Vector2(wide - 1 - half, half) if on else Vector2(half, half)
	for y: int in high:
		for x: int in wide:
			var along := clampf(float(x), half, wide - 1 - half)
			var from_track := maxf(absf(x - (wide - 1) * 0.5) - ((wide - 1) * 0.5 - 1.0), absf(y - half) - (half - 1.0)) if square else Vector2(x - along, y - half).length() - (half - 1.0)
			var from_knob := maxf(absf(x - knob_at.x), absf(y - knob_at.y)) - (half - 3.5) if square else Vector2(x, y).distance_to(knob_at) - (half - 3.5)
			var color := Color(track, track.a * clampf(0.5 - from_track, 0.0, 1.0))
			image.set_pixel(x, y, color.lerp(Color(knob, 1.0), clampf(0.5 - from_knob, 0.0, 1.0)))
	return ImageTexture.create_from_image(image)
