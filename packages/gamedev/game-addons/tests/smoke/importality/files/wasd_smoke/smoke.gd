extends Node
## Smoke test for Importality 0.4.0, run after the project's import step.
##
## walk.pxo (Pixelorama 1.2 layout, pxo_version 8, blended images included, tag "walk") and blink.piskel (4 FPS)
## are 8x8 with 2 frames: frame 1 is red on the left half and green on the right half; frame 2 is a 4x4 blue
## square at (2,2). Their hand-written .import files select the importers "Pixelorama SpriteFrames" and
## "Piskel SpriteFrames" (the latter with piskel/animations_parameters "blink -f:2 -r:0"), so the import step must
## have turned each file into SpriteFrames with one looping 2-frame animation of 8x8 frames, 0.25 s each.

const ID := "importality"
const RED := Color(1, 0, 0, 1)
const GREEN := Color(0, 1, 0, 1)
const BLUE := Color(0, 0, 1, 1)
const CLEAR := Color(0, 0, 0, 0)

var _failures := PackedStringArray()


func _ready() -> void:
	# A script error aborts the checks without quitting; the watchdog then reports the failure.
	get_tree().create_timer(30.0).timeout.connect(_on_watchdog)
	_run.call_deferred()


func _on_watchdog() -> void:
	print("SMOKE_FAIL checks did not finish (script error?) ", " | ".join(_failures))
	get_tree().quit(1)


func _run() -> void:
	_check_sprite_frames("res://wasd_smoke/walk.pxo", &"walk")
	_check_sprite_frames("res://wasd_smoke/blink.piskel", &"blink")
	if _failures.is_empty():
		print("SMOKE_PASS ", ID)
		get_tree().quit(0)
	else:
		print("SMOKE_FAIL ", " | ".join(_failures))
		get_tree().quit(1)


func _fail(message: String) -> void:
	_failures.append(message)


func _same(a: Color, b: Color) -> bool:
	return absf(a.r - b.r) < 0.02 and absf(a.g - b.g) < 0.02 and absf(a.b - b.b) < 0.02 and absf(a.a - b.a) < 0.02


## Colour of a canvas pixel of a frame texture, honouring an AtlasTexture's region and margin.
func _pixel(texture: Texture2D, at: Vector2i) -> Color:
	if texture is AtlasTexture:
		var atlas_texture := texture as AtlasTexture
		var local := Vector2(at) - atlas_texture.margin.position
		if local.x < 0 or local.y < 0 or local.x >= atlas_texture.region.size.x or local.y >= atlas_texture.region.size.y:
			return CLEAR
		return atlas_texture.atlas.get_image().get_pixelv(Vector2i(atlas_texture.region.position + local))
	return texture.get_image().get_pixelv(at)


func _check_sprite_frames(path: String, animation: StringName) -> void:
	var frames := load(path) as SpriteFrames
	if frames == null:
		_fail("%s did not import as SpriteFrames (editor plugin not loaded during the import step?)" % path)
		return
	if frames.get_animation_names() != PackedStringArray([animation]):
		_fail("%s animations %s, expected [%s]" % [path, frames.get_animation_names(), animation])
		return
	if frames.get_frame_count(animation) != 2:
		_fail("%s has %d frames, expected 2" % [path, frames.get_frame_count(animation)])
		return
	if not frames.get_animation_loop(animation):
		_fail("%s animation does not loop" % path)
	for index in 2:
		var texture := frames.get_frame_texture(animation, index)
		if texture == null or texture.get_size() != Vector2(8, 8):
			_fail("%s frame %d is %s, expected an 8x8 texture" % [path, index, texture.get_size() if texture else "missing"])
			return
		var seconds := frames.get_frame_duration(animation, index) / frames.get_animation_speed(animation)
		if absf(seconds - 0.25) > 0.001:
			_fail("%s frame %d lasts %s s, expected 0.25 s" % [path, index, seconds])
	var first := frames.get_frame_texture(animation, 0)
	var second := frames.get_frame_texture(animation, 1)
	if not _same(_pixel(first, Vector2i(0, 0)), RED) or not _same(_pixel(first, Vector2i(7, 7)), GREEN):
		_fail("%s frame 1 pixels %s, %s" % [path, _pixel(first, Vector2i(0, 0)), _pixel(first, Vector2i(7, 7))])
	if not _same(_pixel(second, Vector2i(3, 3)), BLUE) or not _same(_pixel(second, Vector2i(0, 0)), CLEAR):
		_fail("%s frame 2 pixels %s, %s" % [path, _pixel(second, Vector2i(3, 3)), _pixel(second, Vector2i(0, 0))])
