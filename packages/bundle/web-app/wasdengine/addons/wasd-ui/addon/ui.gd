# SPDX-License-Identifier: CC0-1.0
# The game's interface from one autoload, `WasdUi`: a look for every control in the game, and the pieces of a HUD
# that are drawn over it: bars in the corners, messages that come and go, numbers that rise from where something
# was hit, a prompt for the key to press, a flash at the screen's edges when the player is hurt, and fades.
# Everything is drawn in code and sized to the window, with no picture and no font file.
class_name WasdUiKit
extends CanvasLayer

## The look, the accent, the font, or the scale changed: widgets draw themselves again.
signal look_changed

const VIGNETTE := "
shader_type canvas_item;
uniform vec4 tone : source_color = vec4(0.8, 0.05, 0.05, 1.0);
uniform float strength = 0.0;

void fragment() {
	vec2 from_middle = (UV - 0.5) * 2.0;
	float edge = smoothstep(0.45, 1.25, length(from_middle * vec2(0.9, 1.0)));
	COLOR = vec4(tone.rgb, edge * strength);
}
"

## The look by name: one of WasdUiLooks.names(), on every control of the game. Empty gives Godot's own back.
var look := "clean": set = _set_look
## A color of the game's own for buttons that matter, bars, focus, and selection; null keeps the look's.
var accent: Variant = null: set = _set_accent
## A font of the game's own for all text; null keeps Godot's.
var font: Font = null: set = _set_font
## What text and widgets are multiplied by. 0 works it out: 1 where the project stretches its window, and
## otherwise the window's height over 720.
var scale_by := 0.0: set = _set_scale_by

var _root := Control.new()
var _corners := {}
var _toasts := VBoxContainer.new()
var _prompt := PanelContainer.new()
var _prompt_key := Label.new()
var _prompt_icon := TextureRect.new()
var _prompt_text := Label.new()
var _prompt_fade: Tween
var _pops := Control.new()
var _hurt := ColorRect.new()
var _hurt_fade: Tween
var _cover := ColorRect.new()
var _cover_fade: Tween
var _dim := ColorRect.new()
var _menus := CenterContainer.new()
var _scale := 1.0
## Godot's own default theme as it was, to give back when the look is taken off.
var _godot_theme: Theme


func _init() -> void:
	layer = 100
	process_mode = Node.PROCESS_MODE_ALWAYS
	_root.set_anchors_preset(Control.PRESET_FULL_RECT)
	_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_root)
	var vignette := Shader.new()
	vignette.code = VIGNETTE
	var hurt_material := ShaderMaterial.new()
	hurt_material.shader = vignette
	_hurt.material = hurt_material
	for sheet: ColorRect in [_hurt, _cover]:
		sheet.set_anchors_preset(Control.PRESET_FULL_RECT)
		sheet.mouse_filter = Control.MOUSE_FILTER_IGNORE
		sheet.visible = false
	_root.add_child(_hurt)
	_pops.set_anchors_preset(Control.PRESET_FULL_RECT)
	_pops.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_root.add_child(_pops)
	# A stack in each corner, for bars, a radar, and whatever else the game puts there.
	for corner: int in [CORNER_TOP_LEFT, CORNER_TOP_RIGHT, CORNER_BOTTOM_LEFT, CORNER_BOTTOM_RIGHT]:
		var stack := VBoxContainer.new()
		stack.mouse_filter = Control.MOUSE_FILTER_IGNORE
		var right := corner == CORNER_TOP_RIGHT or corner == CORNER_BOTTOM_RIGHT
		var low := corner == CORNER_BOTTOM_LEFT or corner == CORNER_BOTTOM_RIGHT
		stack.anchor_left = 1.0 if right else 0.0
		stack.anchor_right = stack.anchor_left
		stack.anchor_top = 1.0 if low else 0.0
		stack.anchor_bottom = stack.anchor_top
		stack.grow_horizontal = Control.GROW_DIRECTION_BEGIN if right else Control.GROW_DIRECTION_END
		stack.grow_vertical = Control.GROW_DIRECTION_BEGIN if low else Control.GROW_DIRECTION_END
		stack.alignment = BoxContainer.ALIGNMENT_END if low else BoxContainer.ALIGNMENT_BEGIN
		_corners[corner] = stack
		_root.add_child(stack)
	_toasts.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_toasts.anchor_left = 0.5
	_toasts.anchor_right = 0.5
	_toasts.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_toasts.alignment = BoxContainer.ALIGNMENT_BEGIN
	_root.add_child(_toasts)
	_prompt.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_prompt.anchor_left = 0.5
	_prompt.anchor_right = 0.5
	_prompt.anchor_top = 1.0
	_prompt.anchor_bottom = 1.0
	_prompt.grow_horizontal = Control.GROW_DIRECTION_BOTH
	_prompt.grow_vertical = Control.GROW_DIRECTION_BEGIN
	_prompt.visible = false
	var row := HBoxContainer.new()
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_prompt_key.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_prompt_key.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	row.add_child(_prompt_key)
	_prompt_icon.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	_prompt_icon.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_prompt_icon.visible = false
	row.add_child(_prompt_icon)
	row.add_child(_prompt_text)
	_prompt.add_child(row)
	_root.add_child(_prompt)
	# Menus stand over a dimmed game and over the HUD.
	_dim.set_anchors_preset(Control.PRESET_FULL_RECT)
	_dim.mouse_filter = Control.MOUSE_FILTER_STOP
	_dim.visible = false
	_root.add_child(_dim)
	_menus.set_anchors_preset(Control.PRESET_FULL_RECT)
	_menus.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_menus.visible = false
	_root.add_child(_menus)
	_root.add_child(_cover)


func _ready() -> void:
	_godot_theme = ThemeDB.get_default_theme().duplicate(true)
	get_tree().root.size_changed.connect(_apply)
	_apply()


## The names of the looks.
func names() -> PackedStringArray:
	return WasdUiLooks.names()


## The colors and numbers of the look that is on, with the game's accent: for widgets of the game's own that
## should match.
func values() -> Dictionary:
	return WasdUiLooks.values(look, accent)


## What text and widgets are multiplied by now.
func get_ui_scale() -> float:
	return _scale


## A bar in a corner of the screen, with a word before it: `var health := WasdUi.bar("HP", Color.RED)`, then
## `health.value = 60`. Bars in one corner stack.
func bar(label := "", color := Color(0.86, 0.2, 0.22), corner := CORNER_TOP_LEFT) -> WasdBar:
	var made := WasdBar.new()
	made.label = label
	made.color = color
	place(made, corner)
	return made


## Puts a control of any kind into a corner's stack: a radar, a score label, an ammunition count. A plain Label
## becomes a "HudLabel": white with a dark outline, which reads over the game whatever the look.
func place(control: Control, corner := CORNER_TOP_LEFT) -> void:
	if control.get_parent() != null:
		control.get_parent().remove_child(control)
	if control is Label and (control as Label).theme_type_variation == &"":
		(control as Label).theme_type_variation = &"HudLabel"
	(_corners[corner] as VBoxContainer).add_child(control)


## A line that slides in at the top of the screen and leaves by itself: "Checkpoint reached", "Key found".
## Options: `seconds` (float, 2.5); `color` (Color) of the text.
func toast(text: String, options := {}) -> void:
	var card := PanelContainer.new()
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# A toast is a panel of the look with a bar of the accent down its left side.
	var plate := (card.get_theme_stylebox(&"panel") as StyleBoxFlat).duplicate() as StyleBoxFlat
	plate.border_width_left = maxi(roundi(4.0 * _scale), 3)
	plate.border_color = values()["accent"]
	plate.border_blend = false
	plate.content_margin_left = roundi(14.0 * _scale)
	plate.content_margin_right = roundi(14.0 * _scale)
	plate.content_margin_top = roundi(7.0 * _scale)
	plate.content_margin_bottom = roundi(7.0 * _scale)
	card.add_theme_stylebox_override(&"panel", plate)
	var line := Label.new()
	line.text = text
	line.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	if options.has("color"):
		line.add_theme_color_override(&"font_color", options["color"])
	card.add_child(line)
	_toasts.add_child(card)
	# Four at the most: the oldest gives way.
	while _toasts.get_child_count() > 4:
		var oldest := _toasts.get_child(0)
		_toasts.remove_child(oldest)
		oldest.queue_free()
	card.modulate.a = 0.0
	var life := create_tween()
	life.tween_property(card, ^"modulate:a", 1.0, 0.18)
	life.tween_interval(float(options.get("seconds", 2.5)))
	life.tween_property(card, ^"modulate:a", 0.0, 0.3)
	life.tween_callback(card.queue_free)


## A number or a word that rises from a place and fades: damage, healing, points, "Miss". `at` is a place in the
## 3D world (Vector3), in the 2D world (Vector2), or a node there. Options: `size` (float, 1): larger for a
## critical hit; `seconds` (float, 0.8).
func pop(text: String, at: Variant, color := Color.WHITE, options := {}) -> void:
	var view := get_viewport()
	var place := Vector2.ZERO
	if at is Node3D:
		at = (at as Node3D).global_position
	elif at is Node2D:
		at = (at as Node2D).global_position
	if at is Vector3:
		var camera := view.get_camera_3d()
		if camera == null or camera.is_position_behind(at):
			return
		place = camera.unproject_position(at)
	elif at is Vector2:
		place = view.get_canvas_transform() * (at as Vector2)
	else:
		return
	var number := Label.new()
	number.text = text
	number.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var size := roundi(22.0 * _scale * float(options.get("size", 1.0)))
	var heavy := FontVariation.new()
	heavy.base_font = font if font != null else ThemeDB.fallback_font
	heavy.variation_embolden = 0.9
	number.add_theme_font_override(&"font", heavy)
	number.add_theme_font_size_override(&"font_size", size)
	number.add_theme_color_override(&"font_color", color)
	number.add_theme_color_override(&"font_outline_color", Color(0, 0, 0, 0.85))
	number.add_theme_constant_override(&"outline_size", maxi(roundi(size * 0.28), 3))
	_pops.add_child(number)
	number.reset_size()
	# Numbers from one place do not hide one another: each starts a little to one side.
	number.position = place - number.size * 0.5 + Vector2(randf_range(-14.0, 14.0), randf_range(-6.0, 6.0)) * _scale
	number.pivot_offset = number.size * 0.5
	number.scale = Vector2.ONE * 1.5
	var seconds: float = options.get("seconds", 0.8)
	var life := create_tween().set_parallel(true)
	life.tween_property(number, ^"position:y", number.position.y - 64.0 * _scale, seconds).set_ease(Tween.EASE_OUT).set_trans(Tween.TRANS_CUBIC)
	life.tween_property(number, ^"scale", Vector2.ONE, 0.16).set_ease(Tween.EASE_OUT).set_trans(Tween.TRANS_BACK)
	life.tween_property(number, ^"modulate:a", 0.0, seconds * 0.4).set_delay(seconds * 0.6)
	life.chain().tween_callback(number.queue_free)


## Shows what a key does at the bottom of the screen, as a key cap and a word: `WasdUi.prompt("E", "Open")`. `key` is
## the cap's letter, or a picture of the key or button, such as a ControllerIconTexture of the controller-icons
## add-on, which changes with the device the player uses. Without arguments it takes the prompt away.
func prompt(key: Variant = "", text := "") -> void:
	if _prompt_fade != null:
		_prompt_fade.kill()
	_prompt_fade = create_tween()
	var picture: Texture2D = key if key is Texture2D else null
	var letter := str(key) if picture == null and key != null else ""
	if picture == null and letter == "" and text == "":
		_prompt_fade.tween_property(_prompt, ^"modulate:a", 0.0, 0.12)
		_prompt_fade.tween_callback(_prompt.hide)
		return
	_prompt_key.text = letter
	_prompt_key.visible = letter != ""
	_prompt_icon.texture = picture
	_prompt_icon.visible = picture != null
	_prompt_text.text = text
	if not _prompt.visible:
		_prompt.modulate.a = 0.0
		_prompt.show()
	_prompt_fade.tween_property(_prompt, ^"modulate:a", 1.0, 0.12)


## A flash at the screen's edges, as when the player is hurt: `strength` from 0 to 1, in red or another color
## (green for poison, white for a blinding light).
func hurt(strength := 0.6, color := Color(0.8, 0.05, 0.05)) -> void:
	var sheet := _hurt.material as ShaderMaterial
	sheet.set_shader_parameter(&"tone", color)
	sheet.set_shader_parameter(&"strength", clampf(strength, 0.0, 1.0))
	_hurt.show()
	if _hurt_fade != null:
		_hurt_fade.kill()
	_hurt_fade = create_tween()
	_hurt_fade.tween_property(sheet, ^"shader_parameter/strength", 0.0, 0.5 + strength * 0.4).set_ease(Tween.EASE_OUT).set_trans(Tween.TRANS_QUAD)
	_hurt_fade.tween_callback(_hurt.hide)


## Shows a menu of the game's own, such as a pause or settings panel, in the middle of the screen over a dimmed
## game, above the HUD, and gives its first button the focus. `close()` takes it away again. The game goes on
## behind it unless the game pauses itself.
func open(menu: Control, dim := 0.55) -> void:
	if menu.get_parent() != null:
		menu.get_parent().remove_child(menu)
	_dim.color = Color(0, 0, 0, dim)
	_dim.show()
	_menus.add_child(menu)
	_menus.show()
	menu.modulate.a = 0.0
	create_tween().tween_property(menu, ^"modulate:a", 1.0, 0.12)
	var first := menu.find_next_valid_focus() if menu.focus_mode != Control.FOCUS_NONE else null
	for part: Node in menu.find_children("*", "BaseButton", true, false):
		if first == null and (part as BaseButton).focus_mode != Control.FOCUS_NONE and not (part as BaseButton).disabled:
			first = part as Control
	if first != null:
		first.grab_focus.call_deferred()


## Takes a menu that `open()` showed away again, and frees it unless `keep` is true.
func close(menu: Control, keep := false) -> void:
	if menu.get_parent() == _menus:
		_menus.remove_child(menu)
		if not keep:
			menu.queue_free()
	if _menus.get_child_count() == 0:
		_menus.hide()
		_dim.hide()


## Covers the screen in a color over `seconds` and returns the Tween to await: before a cut, a death, a level's
## end. The HUD is covered with it. `clear()` uncovers.
func fade(color := Color.BLACK, seconds := 0.4) -> Tween:
	if _cover_fade != null:
		_cover_fade.kill()
	if not _cover.visible:
		_cover.color = Color(color, 0.0)
		_cover.show()
	_cover.mouse_filter = Control.MOUSE_FILTER_STOP
	_cover_fade = create_tween()
	_cover_fade.tween_property(_cover, ^"color", Color(color, 1.0), seconds)
	return _cover_fade


## Uncovers the screen again over `seconds` and returns the Tween.
func clear(seconds := 0.4) -> Tween:
	if _cover_fade != null:
		_cover_fade.kill()
	_cover_fade = create_tween()
	_cover_fade.tween_property(_cover, ^"color:a", 0.0, seconds)
	_cover_fade.tween_callback(_cover.hide)
	_cover_fade.tween_callback(func() -> void: _cover.mouse_filter = Control.MOUSE_FILTER_IGNORE)
	return _cover_fade


## Builds the look for the window as it is and lays the HUD out for it.
func _apply() -> void:
	var window := get_tree().root
	var stretched := str(ProjectSettings.get_setting("display/window/stretch/mode", "disabled")) != "disabled"
	_scale = scale_by if scale_by > 0.0 else (1.0 if stretched else clampf(window.size.y / 720.0, 0.75, 3.0))
	# The look goes into the default theme, which every control falls back on wherever it stands in the tree: a
	# theme set on the window would not reach controls under a CanvasLayer. A Theme of the game's own, on a control
	# or in the project settings, still comes first.
	var shared := ThemeDB.get_default_theme()
	shared.clear()
	shared.merge_with(_godot_theme)
	shared.default_font = _godot_theme.default_font
	shared.default_font_size = _godot_theme.default_font_size
	if look != "":
		var made := WasdUiLooks.make(look, accent, _scale, font)
		shared.merge_with(made)
		shared.default_font = made.default_font
		shared.default_font_size = made.default_font_size
	var edge := roundi(20.0 * _scale)
	for corner: int in _corners:
		var stack: VBoxContainer = _corners[corner]
		var right := corner == CORNER_TOP_RIGHT or corner == CORNER_BOTTOM_RIGHT
		var low := corner == CORNER_BOTTOM_LEFT or corner == CORNER_BOTTOM_RIGHT
		stack.offset_left = -edge if right else edge
		stack.offset_right = stack.offset_left
		stack.offset_top = -edge if low else edge
		stack.offset_bottom = stack.offset_top
		stack.add_theme_constant_override(&"separation", roundi(8.0 * _scale))
	_toasts.offset_top = edge
	_toasts.add_theme_constant_override(&"separation", roundi(6.0 * _scale))
	_prompt.offset_bottom = -roundi(64.0 * _scale)
	_prompt.offset_top = _prompt.offset_bottom
	# The key cap: a small raised box in the look's text color.
	var v := values()
	var cap := StyleBoxFlat.new()
	cap.bg_color = v["text"]
	cap.set_corner_radius_all(mini(roundi(float(v["radius"]) * _scale), roundi(6.0 * _scale)))
	cap.border_color = Color(v["text"]).darkened(0.35)
	cap.border_width_bottom = maxi(roundi(3.0 * _scale), 2)
	cap.content_margin_left = roundi(9.0 * _scale)
	cap.content_margin_right = roundi(9.0 * _scale)
	cap.content_margin_top = roundi(2.0 * _scale)
	cap.content_margin_bottom = roundi(4.0 * _scale)
	_prompt_key.add_theme_stylebox_override(&"normal", cap)
	_prompt_key.add_theme_color_override(&"font_color", v["panel"] if (v["panel"] as Color).a > 0.5 else Color(0.08, 0.09, 0.12))
	_prompt_key.custom_minimum_size = Vector2.ONE * roundi(30.0 * _scale)
	_prompt_icon.custom_minimum_size = Vector2.ONE * roundi(36.0 * _scale)
	look_changed.emit()


func _set_look(to: String) -> void:
	if to != "" and not WasdUiLooks.LOOKS.has(to):
		push_warning("WasdUi: no look named %s; the looks are %s." % [to, ", ".join(WasdUiLooks.names())])
		to = "clean"
	look = to
	if is_inside_tree():
		_apply()


func _set_accent(to: Variant) -> void:
	accent = to
	if is_inside_tree():
		_apply()


func _set_font(to: Font) -> void:
	font = to
	if is_inside_tree():
		_apply()


func _set_scale_by(to: float) -> void:
	scale_by = maxf(to, 0.0)
	if is_inside_tree():
		_apply()
