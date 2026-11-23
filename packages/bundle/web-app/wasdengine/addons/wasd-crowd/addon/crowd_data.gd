# SPDX-License-Identifier: CC0-1.0
# What WasdCrowdBaker makes of an animated model and WasdCrowd3D draws: the model's mesh, with each vertex's place
# in the animation textures in its second UV map, the textures themselves, which hold every vertex's position and
# normal at every baked frame, and where each clip's frames lie in them.
class_name WasdCrowdData
extends Resource

## The model's mesh, one surface for each of its surfaces, each with the crowd's material.
@export var mesh: ArrayMesh
## Every vertex's position and normal at every frame, a row of pixels (or `rows` rows) for each frame.
@export var positions: ImageTexture
@export var normals: ImageTexture
## Pixels across the textures, and rows of pixels one frame takes.
@export var width := 1
@export var rows := 1
## How many vertices the model has, over all its surfaces.
@export var vertices := 0
## The clips by name: {"start": first frame, "frames": how many, "fps": frames a second, "length": seconds}.
@export var clips := {}
## The space the model takes up over all its clips, around its origin.
@export var bounds := AABB()


## The names of the baked clips.
func names() -> PackedStringArray:
	return PackedStringArray(clips.keys())
