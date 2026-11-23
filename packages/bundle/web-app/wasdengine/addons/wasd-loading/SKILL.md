---
name: wasd-loading
description: WASD Loading 1.0.0 is installed in this project. The autoload WasdLoader changes scenes behind a loading screen whose bar moves in Web builds too, and compiles every shader of the new scene and of what it will spawn before the player sees a frame. Load before changing scenes, adding a loading screen, or fixing a stall when an effect, an enemy, or a material first shows.
---

# WASD Loading 1.0.0

`res://addons/wasd_loading/` (CC0, written by WASD Engine). The installation adds the autoload `WasdLoader`.

A Web build runs on one thread. Godot's background loading (`ResourceLoader.load_threaded_request`) loads in the foreground there, `change_scene_to_file()` stands still, and a loading screen that waits for either never draws. And every renderer compiles a shader the first time something that uses it is drawn, in the middle of play. Measured on a level with 36 materials of their own and a spawned scene with 8 more: without this pack, 25 stalls of 130 ms while turning round and up to a second at the first spawn on desktop, 25 dropped frames and a quarter second in a browser; with it, none on either, for 3 seconds more behind the loading screen in the browser.

## Change scenes

```gdscript
await WasdLoader.change_scene("res://levels/forest.tscn")
```

in place of `get_tree().change_scene_to_file()`. The screen fades in, the old scene is freed, the new one's files load a few a frame while the bar moves, the scene enters the tree paused, the warm-up shows it to the graphics card, and the scene starts as the screen fades out. The call returns the new scene's root; the signals `progress_changed(part)` and `finished(scene)` tell the same. `WasdLoader.is_loading()` is true meanwhile, and a second change is refused.

The node that calls it usually goes with the old scene, and then the lines after the `await` never run. Start what the new scene needs in its own `_ready`, or call from an autoload.

## What the game spawns later

A scene that is not in the level when it loads, such as an enemy, a projectile, a pickup, or an effect, would compile its shaders when it first appears. Name such scenes:

```gdscript
await WasdLoader.change_scene("res://levels/forest.tscn", ["res://enemies/wolf.tscn", "res://fx/arrow_hit.tscn"])
```

Each is loaded with the level, stands in it for the warm-up (its `_ready` runs once, its particles emit), and stays loaded until the next scene change, so that a later `load()` of it is instant and its shaders are still compiled. The effects of `wasd-fx` are warmed without being named.

## The screen

The built-in screen shows the game's name, a bar, and a line of advice:

```gdscript
WasdLoader.title = "Forest"                        # empty: the project's name
WasdLoader.tips = ["Hold Shift to run.", "Wolves fear fire."]
WasdLoader.accent = Color(0.4, 0.8, 1.0)           # the bar; WasdLoader.background is behind it
```

A screen of the game's own: `WasdLoader.screen_scene = preload("res://ui/loading.tscn")`, a scene whose root is a Control that fills the window. If its script has `set_progress(part: float)` (0 to 1) and `set_tip(tip: String)`, they are called. `min_seconds` (0.5) keeps a short load from flashing the screen.

## The warm-up

Behind the screen a camera looks down on everything visible within `warm_up_reach` (300 m) of the scene's camera, walls or not. On desktop it goes a patch of ground a frame, so that no frame has every shader to compile. A browser compiles in the background and finishes only what stays in the picture, so there the whole scene is held until the frames run evenly: `warm_up_seconds` (1) at the least, six at the most.

- `WasdLoader.warm_up = false` skips it: for a change between menus, where a second in the browser buys nothing.
- The scene is paused meanwhile: `_ready` has run, `_process` and physics have not.
- What is hidden is not drawn and not compiled: list its scene in the second argument, or show it from the start.
- The first 3D scene of a session takes longest, because the renderer's own shaders compile with it.

## Loading while the game runs

```gdscript
var cave: PackedScene = await WasdLoader.load_resource("res://levels/cave.tscn")
```

loads a resource and all it is made of a few files a frame (`frame_budget_ms`, 8), with no screen: the next area while the player walks toward it. One file still loads in one piece, so a very large texture is one long frame.

## Pitfalls

- A scene with no current Camera3D when it enters the tree is taken for a 2D scene, and its 3D things are not shown from above. Give the scene its camera in the scene file or in `_ready`.
- A shader stays compiled only while something holds its material. Scenes named in the second argument are held; one that the game loads later and lets go compiles again next time.
- A light that first shines later, such as a muzzle flash with shadows, can still need one more compile for what it lights. Name a scene in which it is on.
- Do not mix it with `change_scene_to_file()` or `reload_current_scene()`: reload with `WasdLoader.change_scene(get_tree().current_scene.scene_file_path)`.

## Check it

`wasd_export_web` and read its Web check: the longest freeze and the slowest frame after the game has started. Or `godot_run` with `web: true`, change scenes, see the bar move, then `godot_performance` while the first effects and enemies appear.
