---
name: protonscatter
description: ProtonScatter 4.2.0-dev (commit 7198cc0) is installed in this project. A ProtonScatter node fills box, sphere, or path areas with copies of a mesh or scene through a stack of modifiers, from a seed, and builds when the scene loads. Load before you scatter props, grass, rocks, or trees in a 3D scene.
---

# ProtonScatter 4.2.0-dev

## What it adds

A `ProtonScatter` node with two kinds of children: `ProtonScatterShape` nodes (where) and `ProtonScatterItem` nodes (what). Its `modifier_stack` decides how many instances go where. Everything runs without the editor: by default the node builds when the scene loads.

- `ProtonScatter` (Node3D, `res://addons/proton_scatter/src/scatter.gd`):
  - `global_seed` (setting it rebuilds), `enabled`, `force_rebuild_on_load` (true);
  - `render_mode`: 0 MultiMesh (default), 1 node copies, 2 GPU particles;
  - `keep_static_colliders` (adds the item scene's StaticBody3D collision shapes; not in render_mode 1);
  - `enable_updates_in_game` (false: moving the node or its shapes in game does not rebuild);
  - `dbg_disable_thread` (true builds on the main thread);
  - methods `rebuild()` and `full_rebuild()`, signal `build_completed`;
  - results in `transforms` (`transforms.list` holds Transform3D, `transforms.size()`). Output goes under a child named `ScatterOutput`.
- `ProtonScatterShape` (`src/scatter_shape.gd`): `shape` is a `ProtonScatterBoxShape` (`size`), a `ProtonScatterSphereShape` (`radius`), or a `ProtonScatterPathShape` (`curve: Curve3D`, `closed`, `thickness`). `negative = true` cuts the shape out of the area.
- `ProtonScatterItem` (`src/scatter_item.gd`):
  - `path` is a `res://` scene (`.tscn`, `.glb`) or a Mesh resource (`.tres`, `.res`);
  - `proportion` sets its share among several items (default 100);
  - also `source_scale_multiplier` and `override_material`.
- `ProtonScatterModifierStack`: `stack: Array[ScatterBaseModifier]`, `add(modifier)`. Modifiers have no class names: load their scripts from `res://addons/proton_scatter/src/modifiers/`:
  - create: `create_inside_random.gd` (`amount`), `create_inside_grid.gd` (`spacing`), `create_inside_poisson.gd` (`radius`), `create_along_edge_even.gd`, `create_along_edge_random.gd`, `single_item.gd`;
  - edit: `randomize_transforms.gd` (`position`, `rotation` in degrees, `scale`), `project_on_geometry.gd` (`ray_direction`, `ray_length`, `align_with_collision_normal`, `collision_mask`), `remove_random.gd` (`probability`), `relax.gd`, `offset_position.gd`, `look_at.gd`.
  - Every modifier has `enabled`, `override_global_seed`, `custom_seed`, `restrict_height` (keeps transforms in one horizontal layer), and `reference_frame` (0 global, 1 local, 2 per instance).

## Minimal example (.tscn)

The following scene scatters 40 rocks over a 20×20 area, at random angles and sizes, with seed 7.

```
[gd_scene load_steps=11 format=3]

[ext_resource type="Script" path="res://addons/proton_scatter/src/scatter.gd" id="1_scatter"]
[ext_resource type="Script" path="res://addons/proton_scatter/src/stack/modifier_stack.gd" id="2_stack"]
[ext_resource type="Script" path="res://addons/proton_scatter/src/modifiers/base_modifier.gd" id="3_base"]
[ext_resource type="Script" path="res://addons/proton_scatter/src/modifiers/create_inside_random.gd" id="4_create"]
[ext_resource type="Script" path="res://addons/proton_scatter/src/modifiers/randomize_transforms.gd" id="5_random"]
[ext_resource type="Script" path="res://addons/proton_scatter/src/scatter_shape.gd" id="6_shape"]
[ext_resource type="Script" path="res://addons/proton_scatter/src/shapes/box_shape.gd" id="7_box"]
[ext_resource type="Script" path="res://addons/proton_scatter/src/scatter_item.gd" id="8_item"]

[sub_resource type="Resource" id="Create"]
script = ExtResource("4_create")
amount = 40
restrict_height = true

[sub_resource type="Resource" id="Randomize"]
script = ExtResource("5_random")
rotation = Vector3(0, 180, 0)
scale = Vector3(0.5, 0.5, 0.5)

[sub_resource type="Resource" id="Stack"]
script = ExtResource("2_stack")
stack = Array[ExtResource("3_base")]([SubResource("Create"), SubResource("Randomize")])

[sub_resource type="Resource" id="Box"]
script = ExtResource("7_box")
size = Vector3(20, 1, 20)

[node name="Level" type="Node3D"]

[node name="Scatter" type="Node3D" parent="."]
script = ExtResource("1_scatter")
global_seed = 7
dbg_disable_thread = true
modifier_stack = SubResource("Stack")

[node name="Area" type="Node3D" parent="Scatter"]
script = ExtResource("6_shape")
shape = SubResource("Box")

[node name="Rock" type="Node3D" parent="Scatter"]
script = ExtResource("8_item")
path = "res://props/rock_mesh.tres"
```

`res://props/rock_mesh.tres` can be any Mesh resource, such as `[gd_resource type="BoxMesh" format=3]` followed by `[resource]` and `size = Vector3(0.4, 0.4, 0.4)`. A `.glb` or `.tscn` scene works too.

## From code

```gdscript
const CreateInsideRandom := preload("res://addons/proton_scatter/src/modifiers/create_inside_random.gd")

func make_scatter(item_path: String, count: int, area: Vector3, seed_value: int) -> ProtonScatter:
	var scatter := ProtonScatter.new()
	scatter.global_seed = seed_value
	scatter.dbg_disable_thread = true
	var create = CreateInsideRandom.new()
	create.amount = count
	create.restrict_height = true
	var stack := ProtonScatterModifierStack.new()
	stack.add(create)
	scatter.modifier_stack = stack
	var box := ProtonScatterBoxShape.new()
	box.size = area
	var shape := ProtonScatterShape.new()
	shape.shape = box
	scatter.add_child(shape)
	var item := ProtonScatterItem.new()
	item.path = item_path
	scatter.add_child(item)
	return scatter  # add_child() it; it builds when it enters the tree

func reseed(scatter: ProtonScatter, count: int, seed_value: int) -> void:
	scatter.modifier_stack.stack[0].amount = count  # the Create modifier
	scatter.global_seed = seed_value  # the setter calls rebuild()
	await scatter.build_completed
	print("placed ", scatter.transforms.size())
```

## Verify in WASD Engine

- After `build_completed`, `scatter.transforms.size()` is the instance count; with render_mode 0 the MultiMeshInstance3D nodes under `ScatterOutput` hold the same total in `multimesh.instance_count`.
- With `godot_eval`: `scene.get_node("Scatter").transforms.size()`. Look with `godot_screenshot`.
- The same seed and stack give the same layout on every run, threaded or not.

## Pitfalls

- Web exports are single-threaded. Set `dbg_disable_thread = true` on every ProtonScatter node, because the default build starts a Thread.
- Changing a modifier's property from code does not rebuild by itself: call `rebuild()`. Setting `global_seed` does rebuild.
- `build_completed` fires one frame after the output appears. Wait for it before counting.
- Create modifiers place points through the whole box height unless `restrict_height = true`. To put props on uneven ground, add `project_on_geometry.gd`; it only hits physics colliders.
- `create_inside_random` can create fewer than `amount` points in a thin or curved area, but never more.
- Do not edit the generated `ScatterOutput` node: every rebuild replaces it.
- The add-on's demo folder contains a `.blend` file. The installer turned off Godot's Blender importer (`filesystem/import/blender/enabled=false` in `project.godot`) so that the import does not stop. Leave it off, and do not add `.blend` files to the project; export `.glb` instead.
