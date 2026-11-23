---
name: wasd-crowd
description: WASD Crowd 1.0.0 is installed in this project. Its baker turns an animated, skinned model's clips into textures once, and WasdCrowd3D then draws hundreds or thousands of copies of the model, each with its own place, clip, pace, phase, and tint, in one draw call for each surface, and WasdFlock3D draws birds, fish, and butterflies that need no model, in Web builds too. Load before filling a scene with many copies of one animated character, or with wildlife in the background.
---

# WASD Crowd 1.0.0

`res://addons/wasd_crowd/` (CC0, written by WASD Engine; global classes, no plugin to enable). Six hundred walkers of 2,649 vertices each, 400 of them moving, ran at 60 fps in a Web build in 15 draw calls. The same six hundred as skinned characters with animation players would not.

## 1. Bake the model once

The model is a scene with a `Skeleton3D`, skinned meshes, and an `AnimationPlayer` that holds its clips: any rigged `.glb`, humanoid or not. Call `godot_script` with `script: "res://addons/wasd_crowd/bake_crowd.gd"` and

```
args: ["res://characters/walker.glb", "res://crowd/walker.res", "--clips=Idle,Walk,Jog_Fwd", "--fps=12"]
```

It prints one line:

```
CROWD_BAKED res://characters/walker.glb: 2649 vertices in 4 surfaces, clips Idle, Walk, Jog_Fwd, 57 frames, textures of 2048 by 114 pixels, saved as res://crowd/walker.res (2.1 MB) in 0.1 s.
```

- A humanoid that was retargeted for `universal-animation-library` and has no clips of its own gets that library's: name them without `ual/`. Without `--clips` every clip is baked, which for that library is far too many: name the two or three the crowd needs.
- Bake clips that loop: a member plays its clip round and round.
- The file grows with vertices times frames, 16 bytes each before compression. Keep a crowd model under about 3,000 vertices (in Blender, a Decimate modifier above the Armature modifier) and `--fps` at 10 to 15; frames in between are blended.
- Each surface keeps its material's color, texture, roughness, and metal; see-through materials are cut out at 40% cover.

`CROWD_FAILED` says what is missing. From code, `WasdCrowdBaker.bake(model, ["moves/Walk"], 12.0)` returns the same `WasdCrowdData` for a model instance, in a tenth of a second for a model this size, so a game may also bake while a level loads.

## 2. Draw the crowd

```gdscript
var crowd := WasdCrowd3D.new()
crowd.data = preload("res://crowd/walker.res")
crowd.capacity = 600                         # most members at once
add_child(crowd)
for index: int in 600:
	var place := Vector3(randf_range(-30, 30), 0, randf_range(-30, 30))
	var member := crowd.add(Transform3D(Basis(Vector3.UP, randf() * TAU), place), "Idle")
```

`add(place, clip, pace := 1.0, phase := -1.0, color := Color.WHITE)` returns the member's number, or -1 when the crowd is full or the data has no such clip. `pace` multiplies the clip's speed. `phase`, from 0 to 1, is where in the clip the member starts; left out, every member gets its own, which is what keeps a crowd from moving in step. Places are in the crowd node's own space.

| Call | Does |
|---|---|
| `crowd.set_member_transform(member, place)` | moves, turns, or scales a member; `get_member_transform(member)` reads it |
| `crowd.set_member_clip(member, "Walk", 1.1)` | another clip and pace, at once |
| `crowd.set_member_color(member, color)` | tints it |
| `crowd.tint_only(["suit", "shirt"])` | only surfaces whose names hold one of the words take tints, so clothes differ and skin does not; `crowd.surfaces()` lists the names |
| `crowd.remove(member)`, `crowd.clear()`, `crowd.count()` | members leave; a freed number goes to the next member added |
| `crowd.data.names()` | the baked clips |

Members that walk are moved by the game, a line each frame:

```gdscript
func _process(delta: float) -> void:
	for member: int in walkers:
		var place := crowd.get_member_transform(member)
		place.origin += place.basis.z * walk_speed * delta      # a Godot humanoid faces its +Z
		crowd.set_member_transform(member, place)
```

Feet stay planted when a member moves at its clip's ground speed times its `pace`. For the Universal Animation Library that is 1.17 m/s for Walk and 6.6 for Jog_Fwd, times the model's hip height in meters.

Make members differ: a tint on the clothes, a scale between 0.9 and 1.1 in the basis, a pace between 0.9 and 1.2.

## What a member is not

- Not a node: it has no collision, no signals, and no children, and nothing can be attached to its hands. For someone the player meets up close, take the member out and put a `wasd-character` in its place.
- Not blended: a new clip starts at once, without a cross-fade. At a crowd's distance that does not show.
- Not culled one by one: the whole crowd is drawn or none of it. Use several crowds for places far apart.
- Every member casts a shadow. For a crowd of thousands, set `crowd.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF`.

## Birds, fish, butterflies: WasdFlock3D

Life in the background needs no model and no baking:

```gdscript
var birds := WasdFlock3D.new()
birds.kind = "birds"                  # sets speed, size, and color: change those after it
birds.count = 60
birds.radius = 40.0                   # how far from the node they roam, in meters
birds.position = Vector3(0, 30, 0)
add_child(birds)
```

| Kind | What it is | Where the node goes |
|---|---|---|
| `birds` | dark birds that travel together, beat their wings, and glide | 20 to 60 m up |
| `fish` | a silver school that turns as one | under the water's surface, with `height` less than the depth |
| `butterflies` | orange ones with dark borders and veins, some yellow, some blue, each near a spot of its own | a meter over a meadow, `radius` 5 to 15, `height` 1.5 |

`height` is the band they keep to, half above the node and half below; `speed` is in meters a second, `size` a wingspan or a length in meters; `color` and `variety` set their colors. `sight` is how far from the camera they are drawn: 22 m for butterflies and 80 m for fish, beyond which they would be specks, and 0, any distance, for birds. `birds.scare(place, strength)` makes those near a place in the world fly apart and come back over some ten seconds: call it when the player comes near or fires. The flock travels with its node.

A shader moves them and draws their wings' pattern, so a flock is one draw call and costs no script time: three flocks of 500 each ran at 60 fps in a Web build, in three draw calls. They are scenery: they pass through walls and through each other, so keep the node clear of buildings and of the ground.

## Check it

`godot_run`, then `godot_screenshot` from the game's camera and `godot_performance` with the whole crowd in view. Two screenshots a moment apart must differ; members frozen in a T-pose mean the clips' names did not match when baking.
