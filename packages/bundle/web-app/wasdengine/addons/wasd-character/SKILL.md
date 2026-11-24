---
name: wasd-character
description: WASD Character 1.0.0 is installed in this project. WasdCharacter3D is a character on foot in one node, with movement relative to the camera, a forgiving jump, sprint, stairs taken in stride with feet placed on steps and slopes, and the model's animations chosen by speed and paced so that feet do not slide, steered by the player or by code, and WasdOrbitCamera3D is a third-person camera that stays out of walls. Load before making a player character, an enemy, or a companion that walks.
---

# WASD Character 1.0.0

`res://addons/wasd_character/` (CC0, written by WASD Engine; global classes, no plugin to enable). Tested at 60 fps in a Web build with an MPFB human and the Universal Animation Library.

## A player character

```gdscript
var hero := WasdCharacter3D.new()
hero.add_child(preload("res://characters/hero.glb").instantiate())    # the model, feet at its origin, facing +Z
add_child(hero)
```

In a scene file: a `CharacterBody3D` with the script `res://addons/wasd_character/character_3d.gd` and the model as its child: add the model before any other Node3D child or set `model`. When it enters the tree it:

- gets a capsule of `body_size` (1.75 m high, 0.32 m radius) unless it has a collision shape of its own;
- adds the input actions the project lacks, `move_left`, `move_right`, `move_forward`, `move_back`, `jump`, `sprint`, and `walk`: WASD and the arrow keys, Space, Shift, C, and on a gamepad the left stick, the bottom button, and the left stick's click. The dictionary `actions` names others;
- adds an orbit camera, `hero.camera_rig`: the mouse or the right stick turns it, the first click takes the mouse pointer, and the cancel key gives it back;
- finds the model's animation player and its clips.

Movement is relative to the camera. A light tilt of the stick, or holding C, walks; Shift sprints.

## Animations

With `universal-animation-library` installed and the model retargeted as that guide says, the character gives the model that library and plays Idle, Walk, Jog_Fwd, Sprint, Jump_Start, Jump, and Jump_Land. Each clip plays at the pace at which its feet stay planted at the body's speed, between 0.6 and 1.8 times.

A model with clips of its own is searched for these names after any library prefix such as `moves/`, without regard to case; `_Loop` endings count:

| For | Names |
|---|---|
| standing | Idle, Stand, Breathing |
| walking | Walk, Walk_Fwd, Walking |
| running | Jog_Fwd, Jog, Run, Run_Fwd, Running |
| sprinting | Sprint, Sprint_Fwd, Run_Fast |
| leaving the ground, in the air, landing | Jump_Start, Jump_Up; Jump, Fall, Falling; Jump_Land, Land |

A missing gait uses the nearest one. `hero.clips` holds what was found, to read or to change after `add_child`: `hero.clips["run"] = "moves/Gallop"`.

`hero.play_action("Sword_Attack")` plays a clip once, a looping one too, by its name with or without its library prefix, and holds the character in place, unable to jump, until it ends; `play_action("Wave", false)` lets it walk meanwhile, and a jump ends it. It returns false when the model has no such clip; `hero.stop_action()` ends an action early. The clips of `universal-animation-library-2` play once their library is added: `hero.animation_player.add_animation_library(&"ual2", preload("res://addons/universal_animation_library_2/UAL2_Standard.glb"))`.

## Settings

| Property | Default | |
|---|---|---|
| `walk_speed`, `run_speed`, `sprint_speed` | 1.4, 5.2, 8.0 | m/s |
| `acceleration`, `deceleration` | 28, 34 | m/s a second on the ground; `air_control` (0.35) is the share kept in the air |
| `turn_speed` | 12 | how fast the model turns toward where it goes |
| `jump_height`, `max_jumps` | 1.25 m, 1 | 0 takes jumping away; 2 is a double jump. Letting go early jumps lower |
| `gravity_scale`, `fall_gravity` | 1, 1.6 | falling pulls harder than rising, which reads as weight |
| `coyote_time`, `jump_buffer` | 0.12 s | a jump counts a moment after walking off an edge, and a press a moment before landing |
| `push` | 40 | force on rigid bodies it walks into |
| `step_height` | 0.3 m | the highest step it walks up or down without a jump; 0 stops at each |
| `foot_placement` | true | see Stairs and feet |
| `model_turn` | 0 | 180 for a model that faces -Z, as Kenney's do |
| `blend` | 0.2 s | cross-fade between clips |

Signals: `jumped`, and `landed(speed)` with the speed of the fall. `hero.teleport(place, facing)` puts it at rest, on a floor up to 0.3 m below, with no landing; `hero.face_toward(direction)` turns the model at once, `hero.get_ground_speed()` reads its speed. To knock it back, add to `hero.velocity`.

## Stairs and feet

Steps, curbs, and door sills of up to `step_height` are walked, up and down, at any gait, with the gait's clip and no fall pose; stairs need no ramp. On a stair's edge a round body has no floor under its middle, so ask `hero.is_grounded()` where a game would ask `is_on_floor()`.

A model with Godot's humanoid bone names, as every model retargeted for the Universal Animation Library has, gets `hero.feet`, a `WasdFootPlacement3D`: on stairs and slopes each foot stands on the ground under it, the hips sink for the lower foot (`sink`, 0.24 m), and the soles lean with the slope (`sole_tilt`, 30 degrees). It casts two rays a physics step, so set `foot_placement = false` on the far members of a horde.

## Enemies and companions

The same node, steered by code:

```gdscript
var guard := WasdCharacter3D.new()
guard.controlled = false                      # no input, no camera
guard.add_child(GUARD_MODEL.instantiate())
add_child(guard)

func _physics_process(_delta: float) -> void:
	var to_player := player.global_position - guard.global_position
	guard.wish_direction = to_player.normalized() if to_player.length() > 2.0 else Vector3.ZERO    # in the world; zero stops
	guard.wish_gait = "run" if to_player.length() > 8.0 else "walk"                               # or "sprint"
```

`guard.jump()` jumps and returns whether it could. To follow a `NavigationAgent3D`, set `guard.wish_direction = guard.global_position.direction_to(agent.get_next_path_position())` each physics frame.

## The camera

`hero.camera_rig` is a `WasdOrbitCamera3D`: `distance` (4.5 m), `height` (where it looks, above the target's origin), `shoulder` (0; 0.5 looks over the right shoulder), `pitch_limits`, `mouse_sensitivity`, `stick_speed`, `follow_speed`, `collision_mask` (what it stays in front of), `capture_mouse`. Its `camera` is the `Camera3D`: `hero.camera_rig.camera.fov = 60.0`.

For a camera of the game's own, a fixed one, one that looks down, or `phantom-camera`, set `hero.orbit_camera = false` before `add_child`: movement is then relative to the current camera, and for one that looks straight down, to the top of the screen.

The camera also works alone, for a car or a ball: `var rig := WasdOrbitCamera3D.new()`, `rig.target = $Car`, `add_child(rig)`, and `rig.reset_smoothing()` after teleporting the car. With `capture_mouse = false` it turns while the right mouse button is held.

## With other packs

- `wasd-decals`: `hero.add_child(WasdBlobShadow3D.new())` and `hero.add_child(WasdFootprints3D.new())`, whose `stepped` signal times footstep sounds.
- `wasd-materials`: an MPFB human's skin, eyes, and hair, by itself with `wasd-face`.
- `wasd-fx`: `hero.landed.connect(func(speed: float) -> void: WasdFx.play("impact", hero.global_position, {"scale": 0.5}))`.
- `wasd-face`: a model with a face blinks by itself, and `hero.face` is its `WasdFace3D`: `hero.face.speak($Voice)`.

## Pitfalls

- The model must face +Z with its feet at its origin, as Godot's humanoid imports do; one that runs backward needs `model_turn = 180`.
- It moves itself: do not call `move_and_slide()` on it or set its position each frame. Set `wish_direction`, or `velocity` for a push.
- It walks slopes of up to 45 degrees. A ledge higher than `step_height` needs a jump; a ladder, code of the game's own.
- For a first-person shooter, `starter-kit-fps` is the start.

## Check it

`godot_run`, hold `move_forward` with `godot_input`, then `godot_eval` of `hero.get_ground_speed()` and `hero.animation_player.current_animation`, and a `godot_screenshot` in mid-run: a running pose, not a T-pose, the model facing where it goes.
