---
name: importality
description: Importality 0.4.0 is installed in this project and turns Pixelorama (.pxo) and Piskel (.piskel) files the user saves into the project into SpriteFrames, AnimatedSprite2D/3D, or Sprite2D/3D + AnimationPlayer scenes. Load before using .pxo or .piskel art.
---

# Importality 0.4.0

An editor import plugin in `res://addons/nklbdev.importality/`. It runs only in the import step that `godot_run` performs; the imported resources do not need it in the game. Do not edit or move that folder.

## Formats

- Work without extra software: Pixelorama `.pxo` (Pixelorama 1.x files) and Piskel `.piskel`.
- Do not work in WASD Engine: Aseprite/LibreSprite `.ase`/`.aseprite`, Krita `.kra`/`.krita`, Pencil2D `.pclx`. Importality runs those apps' command lines, configured in Godot's Editor Settings, which you cannot set; their import fails with `The editor setting "importality/aseprite_or_libre_sprite_command" is not specified!` (or the Krita/Pencil2D equivalent). Ask the user to save the art as `.pxo` or `.piskel` instead, or to export a PNG sprite sheet. Give such files a `.import` with `importer="keep"` to stop the errors.

## Place the files and pick the output

Have the user save the file anywhere in the project, for example `res://art/hero.pxo`, and keep it there: each re-save is imported again on the next run.

Unless its `.import` file names an Importality importer, Godot imports a `.pxo`/`.piskel` as a plain Texture2D of the first frame only. To get animations, write `<file>.import` beside it, or, when Godot already wrote one, change its `importer=` and `type=` lines; the next `godot_run` reimports the file:

```ini
[remap]

importer="Pixelorama SpriteFrames"
type="SpriteFrames"

[params]

animation/autoplay_name="walk"
```

The importer is `<Format> <Output>`, Format `Pixelorama` or `Piskel`:

| Output | type | Result |
|---|---|---|
| `SpriteFrames` | `SpriteFrames` | one animation per tag |
| `AnimatedSprite2D` / `AnimatedSprite3D` | `PackedScene` | that node as the root, with the SpriteFrames |
| `Sprite2D with AnimationPlayer` / `Sprite3D with AnimationPlayer` / `TextureRect with AnimationPlayer` | `PackedScene` | root node plus child `AnimationPlayer` (library `""`) |
| `Sprite sheet (PortableCompressedTexture2D)` | `PortableCompressedTexture2D` | the packed atlas only |

A misspelled importer name falls back to `importer="texture"` without an error: after the run, read the `.import` file again.

## Animations and options

- Pixelorama: one animation per tag (from-to frames); no tags gives one animation named by `animation/default/name` (`"default"`). Frame time = frame duration / project FPS. Animations loop unless a tag name ends in `-r:N` with N of 1 or more (plays N times) or `animation/default/repeat_count` is above 0. A tag name may also end in `-d:f`, `-d:r`, `-d:pp`, or `-d:ppr` (forward, reverse, ping-pong, ping-pong reverse); these suffixes are not part of the animation name.
- Piskel has no tags. Set `piskel/animations_parameters=PackedStringArray("idle -f:2 -r:0", "run -f:4 -r:0")`: each entry takes the next `-f:N` frames in order. Without `-r:0` the animation plays once; without the option the SpriteFrames is empty. Frame time = 1 / the file's FPS.
- SpriteFrames: animation speed 1.0 and each frame's duration in seconds. Frames are AtlasTextures trimmed to their content in one embedded atlas; `get_size()` is still the canvas size.
- Other `[params]`: `animation/autoplay_name` (scene outputs autoplay it), `animation/default/direction` (0-3), `animation/create_reset_animation`, `root_node_name` (scene outputs; default: file name), `sprite/centered` (Sprite2D/3D outputs, default false), `layers/split_layers` (one animation per layer, named `layer/tag`), `sprite_sheet/edges_artifacts_avoidance_method` (0 none, 1 transparent spacing, 2 solid color surrounding, 3 borders extrusion, 4 transparent expansion; use 1 or 3 if neighbouring frames bleed in when the sprite is scaled or filtered).

## Example

`res://art/hero.pxo` has tags `idle` and `walk`, imported as `Pixelorama SpriteFrames`:

```gdscript
extends CharacterBody2D

@onready var sprite: AnimatedSprite2D = $AnimatedSprite2D

func _ready() -> void:
	sprite.sprite_frames = load("res://art/hero.pxo")
	sprite.play("idle")

func _physics_process(_delta: float) -> void:
	velocity.x = Input.get_axis("move_left", "move_right") * 120.0
	move_and_slide()
	sprite.play("walk" if velocity.x != 0.0 else "idle")
```

In a `.tscn`, reference the source path: `[ext_resource type="SpriteFrames" path="res://art/hero.pxo" id="1"]` then `sprite_frames = ExtResource("1")`. An `AnimatedSprite2D` import is a scene: `[ext_resource type="PackedScene" path="res://art/hero.pxo" id="2"]` and `[node name="Hero" parent="." instance=ExtResource("2")]`.

## Verify in WASD Engine

1. Call `godot_run`. Its result lists the `ERROR:`/`WARNING:` lines of the import step, such as `Export is failed. Errors chain:` (the chain's detail lines are not kept) or the Pixelorama warnings below.
2. Read the `.import` file: `importer=` must be the importer you chose.
3. With the art in the running scene, `godot_eval`: `scene.get_node("Player/AnimatedSprite2D").sprite_frames.get_animation_names()` and `.get_frame_count("walk")`; look with `godot_screenshot`. `load()` is not available in `godot_eval` expressions.
4. Without a scene: after a `godot_run` has imported the file, run a SceneTree script with `godot_script` that prints `load("res://art/hero.pxo").get_animation_names()` and read its output.

## Pitfalls

- Pixelorama 1.2 saves layer images cropped to their content. Unless the file holds blended images, Importality builds wrong frames (empty 1x1 textures) and logs `Expected Image data size of ...` after the warning `does not contain blended/precomposited frame images`. Ask the user to tick "Include blended images" in Pixelorama's Save project dialog and save again.
- A Piskel layer saved in several chunks (only for very large animations) imports wrong: only the last chunk is read.
- Every import step with this add-on ends with `WARNING: ... ObjectDB instances were leaked at exit` and `ERROR: 8 resources still in use at exit`. They come from the add-on's static variables; ignore them.
- Its `plugin.cfg` says 0.3.0; the installed files are release 0.4.0.
- Do not delete a `.import` file you wrote: the file goes back to a one-frame Texture2D.
