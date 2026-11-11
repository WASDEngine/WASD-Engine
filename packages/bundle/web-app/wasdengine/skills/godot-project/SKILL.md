---
name: godot-project
description: Create, edit, run, test, or export a Godot 4 game (project.godot, .tscn scenes, GDScript, Godot C#). Load before changing files in a workspace that contains project.godot, before writing GDScript, or when the user asks for a Godot game.
---

# Godot 4 projects

## Find the engine

When the `godot_*` tools are available, Godot is built in: `godot_check` and `godot_run` run it, so writing, checking, running, and playing a game need no Godot editor or `godot` command. Do not look for one, download one, or ask the user for one; only an export needs an editor (see Export). Start a new game by writing `project.godot`, a main scene, and its scripts with the file tools, then check and run it with the tools. Before building a camera rig, dialogue, behavior trees, state charts, an inventory, or tile terrain, search `game_addons` for a tested add-on. The Godot games section of the system prompt names the built-in Godot release, and `godot_run` reports its full version. If a tool reports that no Godot runtime is installed, pass its message on to the user instead of searching for Godot.

Without the `godot_*` tools, run `godot --version`, then try `godot4` and, on macOS, `/Applications/Godot.app/Contents/MacOS/Godot`; if none exists, ask the user for the editor executable instead of downloading one.

Write code for the Godot 4 release in use, and name that release first in `config/features` of `project.godot`, as in `config/features=PackedStringArray("4.7", "Forward Plus")` for Godot 4.7; when an existing project names an older release there, change it to the release in use. The built-in runtime runs GDScript, not C#: a project with a `.csproj` needs the Godot .NET editor, and its C# builds with `dotnet build`.

## Project layout

- `project.godot` marks the project root; `res://` paths resolve from it, and `application/run/main_scene` names the scene that runs.
- Scenes are text `.tscn` files; scripts are `.gd` files, usually beside the scene that uses them.
- `.godot/` is the generated import cache. Never edit it, and keep it out of version control.
- Godot 4.4 and later write a `.uid` file beside each script and shader (`player.gd.uid`). Commit it, and move or rename it together with its file.
- `export_presets.cfg` holds export presets.

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

Use static types (`var health: int = 3`, `func hurt(amount: int) -> void:`), keep tunables in `@export` fields, move bodies in `_physics_process(delta)`, and read input through Input Map actions, for example `Input.get_vector("move_left", "move_right", "move_up", "move_down")`, rather than raw key codes.

## Edit scenes safely

- Prefer building or changing nodes from GDScript over hand-editing large `.tscn` files.
- When a `.tscn` edit is needed, keep each `[ext_resource]` and `[sub_resource]` id consistent with its `ExtResource("...")` or `SubResource("...")` uses. A scene has exactly one root node, which has no `parent`; direct children of the root use `parent="."`.
- Never invent `uid://` values. A new `[ext_resource]` may omit `uid`: Godot falls back to `path` and records the UID on the next save.
- Input actions live in `project.godot` under `[input]` as serialized events. Copy the format of an existing action, or create actions in code with `InputMap.add_action()` and `InputMap.action_add_event()`.

## Verify every change with the Godot tools

1. `godot_check` parses every script and reports each error at its file and line. Fix the first one and check again until it is clean. With GUT or GdUnit4 installed, `godot_script` runs the tests.
2. `godot_run` imports the assets and starts the game; its result lists the errors and warnings logged while it started. Every later Godot tool result lists new errors, and `godot_logs` returns the full log.
3. Look before you claim it works: `godot_screenshot` shows the game. Play it with `godot_input`, using Input Map actions (`{"kind": "action", "action": "jump", "pressed": true, "hold": 0.3}`) or keys and clicks at screenshot coordinates, then take another screenshot or pass `screenshot: true`.
4. Read state instead of guessing: `godot_eval` evaluates an expression such as `scene.get_node("Player").position`, and `godot_scene_tree` lists the running nodes. `godot_control` pauses, steps a number of frames, and resumes.
5. Measure speed instead of guessing: when the game slows, or a change adds many nodes, effects, or bodies, compare `godot_performance` before and after it.
6. Stop the game with `godot_stop` when you are done. The user sees every run live in the Game tab and can play it there.

## Verify every change without the Godot tools

Only when the `godot_*` tools are not available, check with the editor executable you found, written `godot` below:

1. After adding, moving, or renaming files, refresh imports, `.uid` files, and the global class cache:
   `godot --headless --path <project-dir> --import`
2. Parse one script without running it; the exit code is non-zero when the script is invalid:
   `godot --headless --path <project-dir> --check-only --script res://path/to/script.gd`
3. Run the main scene briefly and read every `SCRIPT ERROR`, `ERROR`, and `WARNING` line:
   `godot --headless --path <project-dir> --quit-after 120`
4. If the project has a test addon such as `addons/gut` or `addons/gdUnit4`, run its command-line runner as its README describes.

Fix the first reported error at its file and line, then repeat until the run is clean.

## Models, textures, and audio

With the `mcp__wasd_blender__` tools, build or edit 3D models, paint image textures for each model as the Blender instructions describe, look at them with `mcp__wasd_blender__render_preview`, and write them into the project with `mcp__wasd_blender__export_gltf` as `.glb` files (no Draco compression); keep the `.blend` source beside the export. For hand-drawn detail, edit a model's texture PNG with the `mcp__wasd_gimp__` tools, then reload it in Blender with `image.reload()` and export again. With the `mcp__wasd_gimp__` tools, make or edit textures and sprites, look at them with `mcp__wasd_gimp__snapshot`, and export PNG files into the project; keep the `.xcf` source beside the export. With the `mcp__wasd_supercollider__` tools, design sound effects and music in SuperCollider code and render them with `mcp__wasd_supercollider__render_audio` as `.wav` effects and `.ogg` music and loops; read its levels and waveform and spectrogram image, since nothing plays aloud, and keep the `.scd` source beside it. For free CC0 skies, textures, and models, use the `polyhaven_*` tools. For voices, realistic effects, and music, use the `elevenlabs_*` tools. Record the source and license of every third-party asset.

## Export

Export only when the user asks. The `godot_*` tools cannot export: exporting needs a Godot editor executable of the same version and its export templates. Find the editor as Find the engine describes, ask the user for it if none exists, then run:

```sh
godot --headless --path <project-dir> --export-release "<preset name>" <output-path>
```

The preset name must match one in `export_presets.cfg`, a relative output path resolves from the project directory, and the output directory must already exist. If the preset or the export templates are missing, tell the user which one and stop.
