---
name: simple-dungeons
description: SimpleDungeons is installed in this project. DungeonGenerator3D places rooms on a grid of one or more floors and joins them with corridors and stairs, a different level for every seed, and DungeonBoxRooms builds the rooms, corridor, and stairs in code, with walls, doorways, and colliders, so that no room scene has to be made by hand. Load before generating a dungeon, a maze of rooms, or any random interior.
---

# SimpleDungeons (2025-04-02)

`res://addons/SimpleDungeons/` (CC0, by MajikayoGames; global classes, no plugin to enable; its sample rooms are left out, and `DungeonBoxRooms` and `DungeonBoxRoom` are added by WASD Engine, also CC0). A dungeon of some ten rooms on two floors generates in under 20 ms; in a Web build, one of three floors with 8 rooms and 23 corridor pieces took 135 ms and ran at 60 fps with a lamp in every room.

## A dungeon in code

```gdscript
func build_dungeon(seed_number: int) -> DungeonGenerator3D:
	var dungeon := DungeonGenerator3D.new()
	dungeon.voxel_scale = Vector3(6, 4, 6)        # a grid cell in meters: the box rooms' cell
	dungeon.dungeon_size = Vector3i(10, 1, 10)    # cells across, floors, cells deep
	dungeon.generate_on_ready = false
	dungeon.room_scenes = [
		DungeonBoxRooms.room(Vector2i(2, 2)),                        # 12 by 12 m, two to five of them
		DungeonBoxRooms.room(Vector2i(3, 2), {"max_count": 3}),
		DungeonBoxRooms.room(Vector2i(4, 4), {"min_count": 1, "max_count": 1, "name": "Hall"}),
	]
	dungeon.corridor_room_scene = DungeonBoxRooms.corridor()
	add_child(dungeon)
	dungeon.done_generating.connect(_on_dungeon_done.bind(dungeon))
	dungeon.generating_failed.connect(func() -> void: push_warning("The dungeon did not fit"))
	dungeon.generate(seed_number)                 # the same seed gives the same dungeon; no argument, a random one
	return dungeon


func _on_dungeon_done(dungeon: DungeonGenerator3D) -> void:
	for child: Node in dungeon.get_node("RoomsContainer").get_children():
		var room := child as DungeonBoxRoom
		if room == null:
			continue  # a room scene of your own, a DungeonRoom3D
		var floor_middle := room.global_position + Vector3.DOWN * (room.voxel_scale.y * 0.5 - 0.3)
		if String(room.name).begins_with("Hall"):
			$Player.global_position = floor_middle + Vector3.UP * 0.2
		# room.size_in_voxels tells its size in cells; room.joined maps each open side's name to the room beyond it;
		# room.get_doorway_position(side) is the middle of that doorway on the floor, for a door or a trigger.
```

It builds in the frame `generate()` is called. Calling it again frees the old rooms and builds new ones, so parent what belongs to a room, such as enemies, chests, and lights, to the room.

`DungeonBoxRooms.room(cells, options)` takes:

| Option | Default | |
|---|---|---|
| `"min_count"`, `"max_count"` | 2, 5 | how many of this room the dungeon holds |
| `"name"` | `Room2x2` | placed rooms are named `<name>_<number>` |
| `"floor"`, `"wall"`, `"roof"` | gray | materials. With `wasd-materials`: `{"floor": WasdSurface.make("stone_blocks"), "wall": WasdSurface.make("bricks")}` |
| `"ceiling"` | `true` | `false` leaves rooms open above, for a camera that looks down |
| `"cell"` | `Vector3(6, 4, 6)` | a cell's size; give every room, the corridor, and `dungeon.voxel_scale` the same |
| `"door_width"`, `"door_height"`, `"wall_thickness"` | 2.0, 2.8, 0.3 | meters |

`DungeonBoxRooms.corridor(options)` is the piece corridors are laid from, with the same options.

## Floors

Set `dungeon_size.y` to the number of floors and add stairs to the rooms:

```gdscript
dungeon.dungeon_size = Vector3i(10, 3, 10)
dungeon.room_scenes.append(DungeonBoxRooms.stairs())
```

The stairs are a ramp that a `CharacterBody3D` walks up. Without stairs a dungeon of more than one floor fails.

## What is inside a room

An interior with ceilings gets no light from the sky: give each room a light, parented to it, and keep shadows to the few lights near the player.

```gdscript
var lamp := OmniLight3D.new()
lamp.omni_range = 9.0
lamp.position = Vector3(0, 1.2, 0)            # a room's origin is its middle
room.add_child(lamp)
```

Rooms turn by quarter turns, so place things in the room's own space (`room.add_child(thing)`, then `thing.position`), not by world axes. A room's floor is at `-voxel_scale.y * 0.5 + 0.3` in its own space.

## Rooms of the game's own

A room made by hand is a scene whose root has the script `res://addons/SimpleDungeons/DungeonRoom3D.gd` (or one that extends it), is centered on its origin, and sets `size_in_voxels`, `min_count`, and `max_count`. Mark each place a door may be with a `Node3D` child named `DOOR?_…`, in the middle of an outer side of a cell; `DOOR_…` without the question mark must be joined. Save it as a `.tscn` and add `load("res://rooms/shrine.tscn")` to `room_scenes` beside the box rooms. To open its walls, connect the room's signal `dungeon_done_generating` and ask each `get_doors()` entry for `get_room_leads_to()`; that answer is right only inside that signal.

## Pitfalls

- `generating_failed` means the rooms did not fit: enlarge `dungeon_size`, lower the `min_count`s, or raise `dungeon.max_retries` (1).
- Leave `generate_threaded` off: a Web build has no threads.
- Every wall is a box with its own collider and draw call: a dungeon of 40 rooms is near a thousand. For more, share one material per kind of surface, as above, and keep `"ceiling": false` where the camera looks down.
- `"cell"` must be the same everywhere, or rooms overlap and doorways miss.

## Check it

`godot_run`, then `godot_screenshot` from above with `"ceiling": false` to see the layout, and walk a character from the first room to the farthest: every doorway open, no wall across a corridor.
