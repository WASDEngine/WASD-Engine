---
name: godot-project
description: Create, edit, run, test, or export a Godot 4 game (project.godot, .tscn scenes, GDScript, Godot C#). Load before changing files in a workspace that contains project.godot, before writing GDScript, or when the user asks for a Godot game.
---

# Godot 4 projects

## Find the engine

When the `godot_*` tools are available, Godot is built in: `godot_check` and `godot_run` run it, so writing, checking, running, and playing a game need no Godot editor or `godot` command. Do not look for one, download one, or ask the user for one; only some exports need one (see Export). Start a new game by writing `project.godot`, a main scene, and its scripts with the file tools, then check and run it with the tools. Before building a camera rig, dialogue, cloth, behavior trees, state charts, an inventory, or tile terrain, search `game_addons` for a tested add-on. The system prompt names the built-in release; `godot_run` reports its full version. If a tool reports no installed Godot runtime, give the user its message instead of searching for Godot.

Without the `godot_*` tools, run `godot --version`, then try `godot4` and, on macOS, `/Applications/Godot.app/Contents/MacOS/Godot`; if none exists, ask the user for the editor executable instead of downloading one.

Write code for the Godot 4 release in use, and name it first in `config/features` of `project.godot`, as in `config/features=PackedStringArray("4.7", "GL Compatibility")` for Godot 4.7, replacing an older release an existing project names there. A new `project.godot` also sets `3d/physics_engine="Jolt Physics"` under `[physics]`; without it, Godot uses GodotPhysics3D. Keep an existing project's physics engine, since switching changes how its bodies move. The built-in runtime runs GDScript, not C#: a project with a `.csproj` needs the Godot .NET editor, and its C# builds with `dotnet build`.

## Project layout

- `project.godot` marks the project root; `res://` paths resolve from it, and `application/run/main_scene` names the scene that runs.
- Scenes are text `.tscn` files; scripts are `.gd` files, usually beside the scene that uses them.
- `.godot/` is the generated import cache: never edit or commit it.
- Godot 4.4 and later write a `.uid` file beside each script and shader (`player.gd.uid`); commit it, and move or rename it with its file.

## Write Godot 4 code, not Godot 3

| Godot 4 | Godot 3 form to avoid |
|---|---|
| `@export var speed := 200.0` | `export var speed = 200.0` |
| `@onready var sprite: Sprite2D = $Sprite2D` | `onready var sprite = $Sprite2D` |
| `CharacterBody2D`: set `velocity`, then call `move_and_slide()` | `KinematicBody2D` with `move_and_slide(velocity)` |
| `button.pressed.connect(_on_pressed)` and `died.emit()` | `connect("pressed", self, "_on_pressed")` |
| `await get_tree().create_timer(1.0).timeout` | `yield(get_tree().create_timer(1.0), "timeout")` |
| `preload("res://enemy.tscn").instantiate()` | `.instance()` |
| `create_tween().tween_property(self, "modulate:a", 0.0, 0.3)` | a `Tween` node with `interpolate_property` |

Use static types (`var health: int = 3`, `func hurt(amount: int) -> void:`), keep tunables in `@export` fields, move bodies in `_physics_process(delta)`, and read input through Input Map actions, as in `Input.get_vector("left", "right", "up", "down")`, rather than raw key codes.

## Edit scenes safely

- Prefer building or changing nodes from GDScript over hand-editing large `.tscn` files.
- When a `.tscn` edit is needed, keep each `[ext_resource]` and `[sub_resource]` id consistent with its `ExtResource("...")` or `SubResource("...")` uses. A scene has exactly one root node, which has no `parent`; direct children of the root use `parent="."`.
- Never invent `uid://` values. A new `[ext_resource]` may omit `uid`: Godot falls back to `path` and records the UID on the next save.
- Input actions live in `project.godot` under `[input]` as serialized events. Copy the format of an existing action, or create actions in code with `InputMap.add_action()` and `InputMap.action_add_event()`.

## Verify every change with the Godot tools

1. `godot_check` parses every script and reports each error at its file and line. Fix the first and check again until it is clean. With GUT or GdUnit4 installed, `godot_script` runs the tests.
2. `godot_run` imports the assets and starts the game; its result lists the errors and warnings logged at startup. Every later Godot tool result lists new errors, and `godot_logs` returns the full log.
3. Look before you claim it works: `godot_screenshot` shows the game. Play it with `godot_input`, using Input Map actions (`{"kind": "action", "action": "jump", "pressed": true, "hold": 0.3}`) or keys and clicks at screenshot coordinates, then take another screenshot or pass `screenshot: true`.
4. Read state instead of guessing: `godot_eval` evaluates an expression such as `scene.get_node("Player").position`, and `godot_scene_tree` lists the running nodes. `godot_control` pauses, steps frames, and resumes.
5. Measure speed instead of guessing: when the game slows, or a change adds many nodes, effects, or bodies, compare `godot_performance` before and after.
6. Stop the game with `godot_stop` when done; the user sees every run live in the Game tab and can play it there.

## Verify every change without the Godot tools

Only when the `godot_*` tools are missing, check with the editor you found, written `godot` below:

1. After adding, moving, or renaming files, refresh imports, `.uid` files, and the global class cache:
   `godot --headless --path <project-dir> --import`
2. Parse one script without running it; a non-zero exit code means it is invalid:
   `godot --headless --path <project-dir> --check-only --script res://path/to/script.gd`
3. Run the main scene briefly and read every `SCRIPT ERROR`, `ERROR`, and `WARNING` line:
   `godot --headless --path <project-dir> --quit-after 120`
4. If the project has a test addon such as `addons/gut` or `addons/gdUnit4`, run its command-line runner as its README describes.

Fix the first reported error at its file and line, then repeat until the run is clean.

## Models, textures, and audio

Get each asset from the first source that suits the game's art style: download skies, textures, and models with `polyhaven_*` or an add-on's assets with `game_addons`; otherwise generate 2D art, UI pieces, and tiling textures with `image_generate` instead of drawing them yourself, 3D models with `tripo_*`, and voices, effects, and music with `elevenlabs_*` instead of SuperCollider. With the `mcp__wasd_blender__` tools, build other 3D models, texture them as the Blender instructions describe, and export `.glb` files with `mcp__wasd_blender__export_gltf` (no Draco compression). With the `mcp__wasd_gimp__` tools, edit textures and sprites and export PNG files; for hand-drawn detail on a model, edit its texture PNG there, then `image.reload()` it in Blender and export again. Use the `mcp__wasd_supercollider__` tools only when the user asks for them or ElevenLabs cannot make a sound, rendering `.wav` effects or `.ogg` music with `mcp__wasd_supercollider__render_audio`. Keep each `.blend`, `.xcf`, and `.scd` source beside its output, and record the source and license of every third-party asset.

## Export

Export only when the user asks. The built-in Godot exports with `wasd_export_web` (Web), `wasd_export_desktop` (Windows, macOS), and `wasd_export_mobile` (Android, iOS), and `wasd_release_game` publishes the game on WASD Engine with a share link. Other platforms, and sessions without these tools, need a Godot editor of the same version and its export templates; find it as Find the engine describes, then run:

```sh
godot --headless --path <project-dir> --export-release "<preset name>" <output-path>
```

The preset must be one in `export_presets.cfg`, a relative output path resolves from the project directory, and the output directory must exist. If the preset or the templates are missing, tell the user which and stop.
