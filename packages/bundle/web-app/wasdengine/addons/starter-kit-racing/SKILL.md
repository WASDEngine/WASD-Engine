---
name: starter-kit-racing
description: Starter Kit Racing by Kenney is installed in this project, under res://addons/starter_kit_racing/, with its input actions. It is a working arcade racer with trucks and a motorcycle that drift and lean, a chase camera, tire smoke, engine and skid sounds, and a track made of GridMap pieces, and it runs in Web builds at 60 fps. Load before building a driving game on it, and before changing its vehicles or track.
---

# Starter Kit Racing

A whole small game by Kenney (code MIT, models and sounds CC0), installed as one folder: `res://addons/starter_kit_racing/`. Every path below is inside that folder. The installation added the kit's input actions to `project.godot`; the kit expects Jolt Physics (`3d/physics_engine="Jolt Physics"` under `[physics]`).

Run the kit's track to see what it does: set `run/main_scene="res://addons/starter_kit_racing/scenes/main.tscn"` under `[application]`, then `godot_run`. A Web build of it ran at 60 fps with about 75 draw calls.

## What is in it

- `scenes/vehicle.tscn` with `scripts/vehicle.gd` (global class `Vehicle`): an arcade vehicle. A `RigidBody3D` sphere (`Sphere`) rolls over the ground and the truck model in `Container` follows it, steers, leans into corners, tilts on slopes, spins its wheels, and turns on two smoke emitters (`Container/TrailLeft`, `Container/TrailRight`) and the skid sound while it drifts. `get_vehicle_position()` returns where the truck is, and `linear_speed` its signed speed, which the camera reads.
- `scenes/vehicle-motorcycle.tscn` with `scripts/vehicle-motorcycle.gd`, which extends `Vehicle` and leans the bike.
- Vehicle models: `models/vehicle-truck-yellow.glb`, `-green`, `-purple`, `-red`, `vehicle-motorcycle.glb`. A vehicle scene's `Container/Model` is one of them: to change the car, make a copy of `scenes/vehicle.tscn` in the game's folders and swap that instance.
- The camera rig: a `Node3D` named `View` with `scripts/view.gd` and a `Camera3D` child; it follows `target`, a `Vehicle`, and pulls back as the vehicle speeds up.
- The track: a `GridMap` whose `mesh_library` is `models/Library/mesh-library.tres`, with the items `track-straight`, `track-corner`, `track-finish`, `track-ramp`, `decoration-empty`, `decoration-forest`, and `decoration-tents`, each with collision. Cells are 9.99 m square and the map is scaled by 0.75.
- `scenes/main.tscn`: the track, the vehicle, three parked trucks, a ground plane with collision, the sun, and the sky (`scenes/main-environment.tres`).
- Sounds in `audio/`: engine, skid, and impact.

Input actions: `forward` (W, Up, right trigger), `back` (S, Down, left trigger), `left` and `right` (A, D, the arrow keys, and the left stick), and `bounce` (Space), which the kit's scripts do not read.

## Build the game on it

Keep the kit's folder as it was installed and build the game in the project's own folders:

1. Make the game's track scene, for example `res://tracks/track_1.tscn`: copy `scenes/main.tscn` there and change the copy. Lay out the course by setting the GridMap's cells from a script, which is easier than writing its cell data by hand:

```gdscript
@onready var grid: GridMap = $GridMap

func lay(cell: Vector2i, item_name: String, quarter_turns: int) -> void:
	var item := grid.mesh_library.find_item_by_name(item_name)
	var basis := Basis(Vector3.UP, quarter_turns * PI / 2.0)
	grid.set_cell_item(Vector3i(cell.x, 0, cell.y), item, grid.get_orthogonal_index_from_basis(basis))
```

2. Laps, checkpoints, a timer, and opponents are not in the kit. A checkpoint is an `Area3D` across the road that records the order it was crossed in; a lap counts when the finish follows the last checkpoint. An opponent can be a `Vehicle` whose input a script sets: copy `scripts/vehicle.gd`, replace the two `Input.get_axis` lines in `handle_input` with values from a path follower, and use it in a copy of `scenes/vehicle.tscn`.
3. A second player is another `Vehicle` with its own actions, changed the same way.

## Pitfalls

- The vehicle steers only while its `Ground` ray touches something: the track needs collision everywhere the car can go, which the library's items and the kit's ground plane have.
- The kit's sky turns on SSIL, which only the Forward+ renderer draws; the Web export names `scenes/main-environment.tres` for it, and the track looks the same without it.
- The global class name `Vehicle` is taken by the kit: name the game's own classes differently.
- Kenney's models are low-poly and flat-colored. Keep the game's own models in that style, or replace the kit's.

## Check it

`godot_run`, hold `forward` and `left` with `godot_input` for two seconds, then `godot_screenshot`: the truck has moved along the track and turned, smoke shows behind the rear wheels while it drifts, and the camera still frames it. `godot_logs` shows no errors.
