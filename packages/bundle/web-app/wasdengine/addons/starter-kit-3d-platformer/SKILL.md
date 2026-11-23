---
name: starter-kit-3d-platformer
description: Starter Kit 3D Platformer by Kenney is installed in this project, under res://addons/starter_kit_3d_platformer/, with its input actions and Audio autoload. It is a working third-person platformer with a character, an orbiting camera, coins, falling platforms, bricks, sounds, and a level, and it runs in Web builds at 60 fps. Load before building a platformer on it, and before changing its character, camera, or pickups.
---

# Starter Kit 3D Platformer

A whole small game by Kenney (code MIT, models, sprites, and sounds CC0, the Lilita One font under the SIL Open Font License), installed as one folder: `res://addons/starter_kit_3d_platformer/`. Every path below is inside that folder. The installation added the kit's 11 input actions and its `Audio` autoload to `project.godot`; the kit expects Jolt Physics (`3d/physics_engine="Jolt Physics"` under `[physics]`).

Run the kit's level to see what it does: set `run/main_scene="res://addons/starter_kit_3d_platformer/scenes/main.tscn"` under `[application]`, then `godot_run`. A Web build of it ran at 60 fps with about 200 draw calls.

## What is in it

- `objects/player.tscn` with `scripts/player.gd`: a `CharacterBody3D` that walks relative to the camera, jumps twice, squashes and stretches, plays walk and jump animations of `objects/character.tscn`, leaves dust, and counts `coins` with the signal `coin_collected(coins)`. Properties: `movement_speed` (250), `jump_strength` (7), and `view`, the camera rig. It reloads the scene when the player falls below y = -10.
- The camera rig: a `Node3D` named `View` with `scripts/view.gd` and a `Camera3D` child. It follows `target`, turns with `camera_left`, `camera_right`, `camera_up`, `camera_down`, and zooms with `zoom_in` and `zoom_out` (`zoom_minimum` 16, `zoom_maximum` 4, `rotation_speed` 120).
- `objects/coin.tscn`: an `Area3D` that calls `collect_coin()` on the body that touches it.
- `objects/platform.tscn`, `platform_medium.tscn`, `platform_grass_large_round.tscn`, `platform_falling.tscn` (falls shortly after the player lands on it), `brick.tscn` (breaks when a body in the group `player` hits it from below), `cloud.tscn`; models in `models/`, among them `flag.glb` for a goal.
- `scenes/main.tscn`: the level, with the `HUD` (coin icon and counter, `scripts/hud.gd`), the sky (`scenes/main-environment.tres`), and `scripts/main.gd`, which lowers the sun and sky brightness on the Compatibility renderer so it matches the kit's look on Forward+.
- The autoload `Audio`: `Audio.play("res://addons/starter_kit_3d_platformer/sounds/jump.ogg")` plays a sound by its full path through a pool of players.

Input actions: `move_forward`, `move_back`, `move_left`, `move_right` (WASD and the left stick), `jump` (Space and gamepad button 1), `camera_left`, `camera_right`, `camera_up`, `camera_down` (arrow keys and the right stick), `zoom_in`, `zoom_out` (keypad plus and minus, and the triggers).

## Build the game on it

Keep the kit's folder as it was installed and build the game in the project's own folders:

1. Make the game's level scene, for example `res://levels/level_1.tscn`: instance `objects/player.tscn` and put it in the group `player`, copy the `View` rig, the `HUD`, the `Sun`, and the `Environment` node from `scenes/main.tscn`, and lay out platforms and coins by instancing the kit's objects or the game's own. Set the player's `view` to the rig and the rig's `target` to the player, connect the player's `coin_collected` to the HUD's `_on_coin_collected`, and attach `scripts/main.gd` to the level's root if it keeps the kit's `Sun` and `Environment` node names.
2. To change how something of the kit behaves, copy its script and scene into the game's folders and change the copies: a copied `.tscn` keeps pointing at the kit's models, sounds, and scripts, so only the script path of what changed needs editing.
3. A new pickup or hazard is an `Area3D` with a `body_entered` handler, as `objects/coin.gd` shows; a moving platform is an `AnimatableBody3D` that a script or an `AnimationPlayer` moves.

## Pitfalls

- The kit reloads the current scene when the player falls: a level needs ground under its start, and anything that must survive a fall belongs in an autoload.
- The kit's `jump` is read in `_physics_process` with `is_action_just_pressed`: a test presses it with `godot_input` rather than by setting a variable.
- The character's blob shadow is a `Decal`, which Web builds do not draw; the Web export names `objects/player.tscn` for it. The sun's shadow still shows where the character is; for a round shadow there, add a flat disc mesh with a soft transparent texture under the character and place it on the ground with a ray cast.
- This kit and `starter-kit-fps` both register an autoload named `Audio`, so a project holds one of them.
- Kenney's models are low-poly and flat-colored. Keep the game's own models in that style, or replace the kit's.

## Check it

`godot_run`, hold `move_forward` and tap `jump` with `godot_input`, then `godot_screenshot`: the character stands on a platform in view of the camera, the coin counter shows at the top left, and a second screenshot after collecting a coin shows the count.
