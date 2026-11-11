---
name: smartshape2d
description: SmartShape2D 3.3.2 is installed in this project. Its SS2D_Shape node builds textured 2D terrain from a list of points, with a tiled fill, edge textures along the outline, and a generated collision polygon. Load before you build 2D ground, hills, platforms, or cliffs from points.
---

# SmartShape2D 3.3.2

## What it adds

- The node `SS2D_Shape` (a Node2D, `res://addons/rmsmartshape/shapes/shape.gd`). `SS2D_Shape_Closed` and `SS2D_Shape_Open` are deprecated. A closed shape gets a fill and edges, an open one edges only.
- Points live in `shape.get_point_array()`, an `SS2D_Point_Array` of `SS2D_Point` (`position`, `point_in`, `point_out` curve handles, `width`).
- `shape.shape_material` is an `SS2D_Material_Shape`: `fill_textures` (the first is used), `fill_texture_scale`, `fill_texture_offset`, `fill_texture_z_index` (-10), and edge materials added with `add_edge_material(meta)`.
- `meta` is an `SS2D_Material_Edge_Metadata`: `edge_material`, `normal_range` (an `SS2D_NormalRange` with `begin` and `distance` in degrees; the default 0 to 360 covers every edge), `z_index`, `offset`. Give a grass top and rock sides different ranges.
- `SS2D_Material_Edge`: `textures`, `textures_corner_outer`, `textures_corner_inner`, `textures_taper_left`, `textures_taper_right`, `use_corner_texture`, `use_taper_texture`.
- An edge is as thick as its texture is tall, centred on the outline. Textures always repeat.
- Collision: `collision_polygon_node_path` names a CollisionPolygon2D; `collision_update_mode` 0 Editor (default), 1 Runtime, 2 both; `collision_generation_method` 0 filled, 2 Hollow; `collision_size`, `collision_offset`.

## Point API

Call these on `shape.get_point_array()`; the same methods on the shape are deprecated. `add_point(pos, index := -1, key := -1) -> int` (returns the key), `add_points(PackedVector2Array)`, `close_shape()` (appends a copy of the first point), `is_shape_closed()`, `get_point_count()`, `get_point_key_at_index(i)`, `get_point_position(key)`, `set_point_position(key, pos)`, `set_point_in(key, v)` and `set_point_out(key, v)` (curves), `remove_point(key)`, `clear()`, `begin_update()` and `end_update()` (batch), `are_points_clockwise()`, `invert_point_order()`. Keep closed shapes clockwise on screen (y down): corner generation assumes it.

## Minimal example (code)

```gdscript
extends Node2D

func _ready() -> void:
	var edge := SS2D_Material_Edge.new()
	edge.textures = [load("res://art/grass_edge.png")]  # its height = edge thickness
	var meta := SS2D_Material_Edge_Metadata.new()
	meta.edge_material = edge
	var material := SS2D_Material_Shape.new()
	material.add_edge_material(meta)
	material.fill_textures = [load("res://art/dirt.png")]

	var ground := SS2D_Shape.new()
	ground.shape_material = material
	var points := ground.get_point_array()
	points.begin_update()
	for p in [Vector2(0, 300), Vector2(200, 220), Vector2(480, 260), Vector2(640, 300),
			Vector2(640, 480), Vector2(0, 480)]:
		points.add_point(p)
	points.close_shape()
	points.end_update()
	if not points.are_points_clockwise():
		points.invert_point_order()

	var body := StaticBody2D.new()
	var collision := CollisionPolygon2D.new()
	body.add_child(collision)
	add_child(body)
	add_child(ground)
	ground.collision_update_mode = SS2D_Shape.CollisionUpdateMode.Runtime
	ground.collision_polygon_node_path = ground.get_path_to(collision)
```

## Text form (.tscn)

Each point is a sub-resource. `_points` maps keys to points, `_point_order` lists keys in outline order, and the constraint `Vector2i(first_key, last_key): 15` closes the shape, whose last point repeats the first. Leave out `_mesh_cache` (rebuilt at runtime). Resource text has no comment syntax: do not put `#` lines in it.

```
[ext_resource type="Script" path="res://addons/rmsmartshape/shapes/shape.gd" id="1_shape"]
[ext_resource type="Script" path="res://addons/rmsmartshape/shapes/point_array.gd" id="2_array"]
[ext_resource type="Script" path="res://addons/rmsmartshape/shapes/point.gd" id="3_point"]
[ext_resource type="Resource" path="res://ground_material.tres" id="4_mat"]

[sub_resource type="Resource" id="P0"]
script = ExtResource("3_point")
position = Vector2(60, 80)

[sub_resource type="Resource" id="P1"]
script = ExtResource("3_point")
position = Vector2(280, 80)

[sub_resource type="Resource" id="P2"]
script = ExtResource("3_point")
position = Vector2(280, 280)

[sub_resource type="Resource" id="P3"]
script = ExtResource("3_point")
position = Vector2(60, 280)

[sub_resource type="Resource" id="P4"]
script = ExtResource("3_point")
position = Vector2(60, 80)

[sub_resource type="Resource" id="Points"]
script = ExtResource("2_array")
_points = {0: SubResource("P0"), 1: SubResource("P1"), 2: SubResource("P2"), 3: SubResource("P3"), 4: SubResource("P4")}
_point_order = PackedInt32Array(0, 1, 2, 3, 4)
_constraints = {Vector2i(0, 4): 15}
_next_key = 5

[node name="Ground" type="Node2D" parent="."]
script = ExtResource("1_shape")
_points = SubResource("Points")
shape_material = ExtResource("4_mat")
collision_update_mode = 1
collision_polygon_node_path = NodePath("../Body/Collision")
```

The material as `res://ground_material.tres`:

```
[gd_resource type="Resource" script_class="SS2D_Material_Shape" load_steps=7 format=3]

[ext_resource type="Script" path="res://addons/rmsmartshape/materials/shape_material.gd" id="1_shape"]
[ext_resource type="Script" path="res://addons/rmsmartshape/materials/edge_material_metadata.gd" id="2_meta"]
[ext_resource type="Script" path="res://addons/rmsmartshape/materials/edge_material.gd" id="3_edge"]
[ext_resource type="Texture2D" path="res://art/grass_edge.png" id="4_grass"]
[ext_resource type="Texture2D" path="res://art/dirt.png" id="5_dirt"]

[sub_resource type="Resource" id="Edge"]
script = ExtResource("3_edge")
textures = Array[Texture2D]([ExtResource("4_grass")])

[sub_resource type="Resource" id="Meta"]
script = ExtResource("2_meta")
edge_material = SubResource("Edge")

[resource]
script = ExtResource("1_shape")
_edge_meta_materials = Array[ExtResource("2_meta")]([SubResource("Meta")])
fill_textures = Array[Texture2D]([ExtResource("5_dirt")])
```

Without `normal_range` an edge material covers every edge. To limit it, add a `normal_range` sub-resource with script `res://addons/rmsmartshape/normal_range.gd`, `begin`, and `distance`. Angles are the edge's outward normal on screen: 0 right, 90 up, 180 left, 270 down. Grass on top is `begin = 45.0` with `distance = 90.0`; rock elsewhere is 135 with 270. In code: `SS2D_NormalRange.new(45, 90)`.

## Verify in WASD Engine

- Use `godot_run` and `godot_screenshot` to see the fill and edges.
- With `godot_eval`: `scene.get_node("Ground").get_point_array().get_point_count()` and `scene.get_node("Body/Collision").polygon.size()` (0: no collision). The built meshes are `shape._mesh_cache.meshes` (`SS2D_Mesh` with `mesh: ArrayMesh`); read them only for checks.

## Pitfalls (seen on Godot 4.7.2)

- The default `collision_update_mode` (Editor) generates no collision when the game runs: the polygon stays empty. Set 1 (Runtime).
- Point changes are rebuilt one frame later. Call `shape.force_update()` to rebuild at once.
- `close_shape()` adds a point, so 4 corners make 5 points.
- A material without textures draws nothing. Only a closed shape gets a fill.
- Shapes also render in the Compatibility renderer that Web exports use.
