---
name: dialogue-manager
description: Dialogue Manager 4.2.0 is installed in this project for branching dialogue written in `.dialogue` text files (characters, choices, conditions, variables, function calls) that import as DialogueResource and run through the DialogueManager autoload or its balloon UI. Load before writing dialogue or dialogue UI.
---

# Dialogue Manager 4.2.0

Installed in `res://addons/dialogue_manager/` with the autoload `DialogueManager`. Its import plugin compiles each `*.dialogue` file into a `DialogueResource` when the project imports, which `godot_run` does first. Do not edit the add-on folder; ignore its `.cs` files.

## `.dialogue` files

Write UTF-8 text, indented with tabs:

```
~ start
Guard: Halt, {{player_name}}! [#mood=angry]
set coins += 5
if coins >= 10:
	Guard: {{coins}} coins? Fine, pass.
	=> END
elif coins > 5:
	Guard: Almost enough.
else:
	Guard: You are broke.
Guard: The toll is 10 coins.
- Use the key [if has_key /] => key
- Ask why
	Guard: Orders.
	=> END
- Leave => END

~ key
do open_gate()
Guard: [[Fine|Go on]], the gate is open.
=> END
```

- `~ name` starts a cue (entry point). `Name: text` is a spoken line; text alone has an empty `character`.
- `- text` lines after a line are its responses. A response jumps with `=> cue` or runs its indented lines. `[if expr /]` after the text makes `is_allowed` false when `expr` fails; the response is still listed.
- `if`/`elif`/`else:` blocks, `while expr:`, and `match expr:` with `when value:` take GDScript-like expressions (`and`, `or`, `not`, `in`).
- `set x = 1`, `set x += 1` change state; `do f(args)` calls a method and waits if it awaits (`do! f()` does not wait).
- `=> cue` jumps, `=> END` ends, `=> END!` ends even inside a snippet, `=>< cue` runs a cue and comes back.
- In text: `{{expr}}` inserts a value, `[if expr]a[else]b[/if]` picks text, `[[a|b]]` picks at random, `[#tag]`/`[#key=value]` are tags (`line.has_tag("mood")`, `line.get_tag_value("mood")`); the balloon reads `[wait=1]` (pause), `[speed=2]…[/speed]` (typing speed) and `[next=auto]` (advance by itself).
- Flow continues after a response block and falls into the next `~ cue`; end each section with `=> END` or a jump.

## State

Names in a file resolve, in order, from the `extra_game_states` array you pass (Objects, or Dictionaries whose keys already exist), the current scene's script, then autoloads by name (`GameState.coins`). `using GameState` on a file's first line lets it write `coins` for `GameState.coins`. Declare variables and methods in scripts: a missing name logs `Assertion failed: "name" not found` and its value becomes null.

## Show it

```gdscript
extends Node2D  # main scene: its variables and methods are dialogue state

var player_name := "Ada"
var coins := 3
var has_key := true
var gate_open := false

func open_gate() -> void:
	gate_open = true

func _ready() -> void:
	var dialogue: DialogueResource = load("res://dialogue/gate.dialogue")
	DialogueManager.show_dialogue_balloon(dialogue, "start", [self])
```

The balloon is a CanvasLayer named `ExampleBalloon` added to the current scene: `ui_accept` or a click advances, `ui_up`/`ui_down` and `ui_accept` pick a response, disallowed responses show disabled, and it frees itself at the end. It shows an "example balloon" banner. For your own look, make a scene whose root script has `func start(resource: DialogueResource, cue: String, extra_game_states: Array)` and pass it to `DialogueManager.show_dialogue_balloon_scene(scene, resource, cue, states)`, or drive your UI yourself:

```gdscript
func talk(dialogue: DialogueResource) -> void:
	var line: DialogueLine = await DialogueManager.get_next_dialogue_line(dialogue, "start", [self])
	while line != null:
		$Label.text = "%s: %s" % [line.character, line.text]
		var next_id := line.next_id
		if line.responses.is_empty():
			await $NextButton.pressed
		else:
			var choice: DialogueResponse = await show_choices(line.responses)  # your UI; skip is_allowed == false
			next_id = choice.next_id
		line = await DialogueManager.get_next_dialogue_line(dialogue, next_id, [self])
```

API: `get_next_dialogue_line(resource, cue_or_next_id, extra_game_states)` must be awaited; it runs `set`/`do` lines and returns the next spoken `DialogueLine` or `null` at the end (`resource.get_next_dialogue_line(cue, states)` is the same). `DialogueLine`: `character`, `text`, `responses`, `next_id`, `tags`, `time`. `DialogueResponse`: `text`, `next_id`, `is_allowed`, `tags`. `DialogueResource`: `get_cues()`. Signals on `DialogueManager`: `dialogue_started(resource)`, `got_dialogue(line)`, `mutated(mutation)`, `passed_cue(cue)`, `dialogue_ended(resource)`. `DialogueManager.create_resource_from_text(text)` compiles dialogue at runtime.

## Verify in WASD Engine

Check syntax with `godot_script` and this script, saved as `res://tools/check_dialogue.gd`, with the `res://` paths of the files as `args`; it prints one `path:line:column message` per error, then `DIALOGUE_CHECK OK` or `DIALOGUE_CHECK FAILED`:

```gdscript
extends SceneTree

func _init() -> void:
	var failed := false
	for path: String in OS.get_cmdline_user_args():
		var result: DMCompilerResult = DMCompiler.compile_string(FileAccess.get_file_as_string(path), path)
		for e: DMError in result.errors:
			failed = true
			print("%s:%d:%d %s" % [path, e.line_number, e.column_number, DMConstants.get_error_message(e.error)])
	print("DIALOGUE_CHECK ", "FAILED" if failed else "OK")
	quit(1 if failed else 0)
```

Then `godot_run`, press `ui_accept` with `godot_input`, and read `scene.get_node("ExampleBalloon").dialogue_line.text` with `godot_eval`.

## Pitfalls

- Version 4 renamed titles to cues: use `get_cues()`, `cues`, `passed_cue`. `first_cue` is a line ID, not a cue name.
- A file with errors does not import: the import log says `N errors found in res://….dialogue`, and `load()` returns null after "Cannot open file 'res://.godot/imported/….tres'".
- Importing adds `.dialogue` files to `internationalization/locale/translations_pot_files` in `project.godot`; leave it.
- `get_next_dialogue_line` is a coroutine: without `await` the script fails to parse ("is a coroutine, so it must be called with "await"").
