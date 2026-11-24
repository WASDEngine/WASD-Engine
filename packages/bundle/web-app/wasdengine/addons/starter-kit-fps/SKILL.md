---
name: starter-kit-fps
description: Starter Kit FPS by Kenney is installed in this project, under res://addons/starter_kit_fps/, with its input actions and Audio autoload. It is a working first-person shooter with a player controller, two blasters, flying enemies, a HUD, sounds, and a level, and it runs in Web builds at 60 fps. Load before building a first-person game on it, and before changing its player, weapons, or enemies.
---

# Starter Kit FPS

A whole small game by Kenney (code MIT, models and sprites CC0, the Lilita One font under the SIL Open Font License), installed as one folder: `res://addons/starter_kit_fps/`. Every path below is inside that folder. The installation added the kit's 13 input actions and its `Audio` autoload to `project.godot`.

Run the kit's level to see what it does: set `run/main_scene="res://addons/starter_kit_fps/scenes/main.tscn"` under `[application]`, then `godot_run`. A Web build of it ran at 60 fps with 87 draw calls.

## What is in it

- `objects/player.tscn` with `objects/player.gd`: a `CharacterBody3D` with a camera, a second camera in a `SubViewport` that draws the weapon over the world, walking, double jump (`number_of_jumps`), `movement_speed`, `jump_strength`, mouse and gamepad look, shooting by ray cast, recoil, weapon switching, and `health` with the signal `health_updated`. It reloads the scene when health runs out or the player falls below y = -10.
- `weapons/blaster.tres`, `weapons/blaster-repeater.tres`: `Weapon` resources (`scripts/weapon.gd`, global class `Weapon`).
- `objects/enemy.tscn` with `objects/enemy.gd`: a flying enemy with `health`, `damage(amount)`, and a timer that shoots the player by ray cast. Set its `player` to the player node.
- `scenes/main.tscn`: the level, with a `HUD` layer (crosshair, health label, `scripts/hud.gd`), the sky (`scenes/main-environment.tres`), four enemies, and platforms.
- `objects/platform.tscn`, `platform_large_grass.tscn`, `wall_low.tscn`, `wall_high.tscn`, `cloud.tscn`, `impact.tscn`; models in `models/`, sounds in `sounds/`, sprites in `sprites/`.
- The autoload `Audio`: `Audio.play("sounds/land.ogg")` plays a sound by its path inside the kit's folder; several paths separated by commas pick one at random. For sounds elsewhere in the game, play them with the game's own `AudioStreamPlayer`s.

Input actions: `move_forward`, `move_back`, `move_left`, `move_right` (WASD and the left stick), `jump` (Space), `shoot` (left mouse button, right trigger), `weapon_toggle` (E), `mouse_capture` (left click), `mouse_capture_exit` (Escape), and `camera_left`, `camera_right`, `camera_up`, `camera_down` (right stick).

## Build the game on it

Keep the kit's folder as it was installed and build the game in the project's own folders:

1. Make the game's level scene, for example `res://levels/level_1.tscn`: instance `objects/player.tscn`, add a `WorldEnvironment`, a `DirectionalLight3D`, and the level's geometry with collision, and copy the `HUD` layer from `scenes/main.tscn`. Set the player's `crosshair` to the HUD's `Crosshair` node and connect the player's `health_updated` to the HUD's `_on_health_updated`, as `main.tscn` does.
2. To change how something of the kit behaves, copy its script and scene into the game's folders and change the copies: a copied `.tscn` keeps pointing at the kit's models, sounds, and scripts, so only the script path of what changed needs editing. The kit's own files stay as a working reference.
3. A new weapon is a new `Weapon` resource in the game's folders, added to the player's `weapons` array:

```
[gd_resource type="Resource" script_class="Weapon" load_steps=4 format=3]

[ext_resource type="Script" path="res://addons/starter_kit_fps/scripts/weapon.gd" id="1"]
[ext_resource type="PackedScene" path="res://addons/starter_kit_fps/models/blaster.glb" id="2"]
[ext_resource type="Texture2D" path="res://addons/starter_kit_fps/sprites/crosshair.png" id="3"]

[resource]
script = ExtResource("1")
model = ExtResource("2")
rotation = Vector3(0, 180, 0)
muzzle_position = Vector3(0.1, -0.4, 1.5)
cooldown = 0.4
max_distance = 20
damage = 60.0
knockback = 30
sound_shoot = "sounds/blaster.ogg"
crosshair = ExtResource("3")
```

`cooldown` is seconds between shots (0.1 to 1), `max_distance` the ray's reach in metres (1 to 20), `spread` the random offset of each ray, `shot_count` rays per shot (a shotgun fires 5), and `knockback` the push on the player. Whatever a ray hits takes `damage(amount)` when it has that method, so a new enemy or a breakable crate only needs that method and a collider.

## Pitfalls

- The player's `weapons` array must hold at least one weapon, or `_ready` fails.
- Browsers let a page capture the mouse only after a click. WASD Engine changed the kit's `objects/player.gd` so that a Web build waits for the first click (`mouse_capture`) instead of capturing the mouse in `_ready`, which would print an error that stops a release, and turns the view with the mouse only after that click. Keep both in a copied player script.
- The player's blob shadow is a `Decal`, which Web builds do not draw; the Web export names `objects/player.tscn` for it. In first person it is not seen anyway.
- The kit is drawn for Forward+ and looks nearly the same on the Compatibility renderer. Its sky texture is 3.9 MB: replace `sprites/skybox.png` in a copy of `scenes/main-environment.tres` with the game's own sky.
- Kenney's models are low-poly and flat-colored. Keep the game's own models in that style, or replace the kit's.

## Check it

`godot_run`, then `godot_input` to hold `move_forward` and press `shoot`, and `godot_screenshot`: the weapon shows at the lower right, the crosshair in the centre, the health label at the lower left, and enemies turn toward the player.
