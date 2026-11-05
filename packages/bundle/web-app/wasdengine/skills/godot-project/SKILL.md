---
name: godot-project
description: Create, edit, run, test, or export a Godot 4 game (project.godot, .tscn scenes, GDScript, Godot C#). Load before changing files in a workspace that contains project.godot, before writing GDScript, or when the user asks for a Godot game.
---

# Godot 4 projects

## Find the engine

Run `godot --version`; also try `godot4`, and on macOS `/Applications/Godot.app/Contents/MacOS/Godot`. If none exists, ask the user for the editor executable instead of downloading one. Note the version (for example `4.7.stable`) and write code for that 4.x release; run `godot --help` when a flag below is missing. A project with a `.csproj` needs the Godot .NET editor, and its C# builds with `dotnet build`.

## Project layout

- `project.godot` marks the project root; `res://` paths resolve from it, and `application/run/main_scene` names the scene that runs.
- Scenes are text `.tscn` files; scripts are `.gd` files, usually beside the scene that uses them.
- `.godot/` is the generated import cache. Never edit it, and keep it out of version control.
- Godot 4.4 and later write a `.uid` file beside each script and shader (`player.gd.uid`). Commit it, and move or rename it together with its file.
- `export_presets.cfg` holds export presets. Exporting also needs export templates for the exact editor version.

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

## Verify every change

1. After adding, moving, or renaming files, refresh imports, `.uid` files, and the global class cache:
   `godot --headless --path <project-dir> --import`
2. Parse one script without running it; the exit code is non-zero when the script is invalid:
   `godot --headless --path <project-dir> --check-only --script res://path/to/script.gd`
3. Run the main scene briefly and read every `SCRIPT ERROR`, `ERROR`, and `WARNING` line:
   `godot --headless --path <project-dir> --quit-after 120`
4. If the project has a test addon such as `addons/gut` or `addons/gdUnit4`, run its command-line runner as its README describes.

Fix the first reported error at its file and line, then repeat until the run is clean. To watch gameplay, start the project without `--headless` as a background job and stop the job when done.

## Export

Export only when the user asks:

```sh
godot --headless --path <project-dir> --export-release "<preset name>" <output-path>
```

The preset name must match one in `export_presets.cfg`, a relative output path resolves from the project directory, and the output directory must already exist. If the preset or the export templates are missing, tell the user which one and stop.
