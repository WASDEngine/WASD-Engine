---
name: gaea
description: Gaea 2.0.0-beta6 (a pre-release) is installed in this project. A GaeaGenerator runs a GaeaGraph of generation nodes from a seed and draws the result into TileMapLayer or GridMap. Its graph editor is unusable here, so write graphs as .tres text or build them in code. Load before you generate maps with Gaea.
---

# Gaea 2.0.0-beta6

## Parts

- `GaeaGraph` (Resource, `.tres`):
  - `_node_data` maps a node id to `{type: 0, position, salt, uid, arguments}`, where `uid` may be the node script's `res://` path;
  - `_connections` lists wires as `"from_id-from_port-to_id-to_port"`;
  - `_parameters` holds named values such as materials;
  - `layers: Array[GaeaLayer]`;
  - node 0 is the Output node, with input port i for layer i.
- `GaeaGenerator` (Node):
  - `graph`, `settings: GaeaGenerationSettings` (`seed`, `random_seed_on_generate`, which defaults to true, and `world_size: Vector3i`, with z = 1 for 2D), and `task_pool: GaeaTaskPool` (`multithreaded`, default true);
  - `generate()` clears and fills `world_size`; `generate_area(AABB)` fills one area;
  - signal `generation_finished(grid)`.
- Renderers draw on `generation_finished`. `TileMapGaeaRenderer` has `generator` and `tile_map_layers` (one TileMapLayer per graph layer). `GridMapGaeaRenderer` has `generator` and `grid_maps`.
- Materials say what to place:
  - `TileMapGaeaMaterial`: `type` 0 single cell (`source_id`, `atlas_coord`, `alternative_tile`), 1 terrain (`terrain_set`, `terrain`), or 2 pattern (`pattern_index`);
  - `GridMapGaeaMaterial`: `item_idx` and `orientation`;
  - `PickRandomGaeaMaterial`: `materials` and `weights`.

## Ports

A node's output port is the index of the output in its script's `_get_output_ports_list()`. Its input port is the argument's index in `_get_arguments_list()`, counting only arguments that can take a wire: numbers, vectors, ranges, materials, textures, samples, and maps. Node scripts live under `res://addons/gaea/runtime/graph_nodes/root/`.

| Node (script) | Inputs, by port | Output 0 |
|---|---|---|
| `GaeaNodeNoise2D` (`sampling/noise/noise_2d.gd`) | frequency (0.01), lacunarity (2.0), octaves (5) | noise: 0–1 per cell |
| `GaeaNodeThresholdMapper` (`map/mappers/threshold_mapper.gd`) | reference, material, range `{"min","max"}` | map |
| `GaeaNodeMaterialParameter` (`resources/variables/material_parameter.gd`) | none; argument `name` | value |

Other nodes include `GaeaNodeFloorWalker`, `GaeaNodeBasicMapper`, `GaeaNodeThresholdFilter`, `GaeaNodeRandomScatter`, `GaeaNodeFalloffMap`, and `GaeaNodeBorder2D`. Read a node's script for its arguments and `_get_required_arguments()`. Required inputs must be wired: a mapper's `material` comes from a MaterialParameter node, and a plain argument value is ignored.

## Minimal graph (.tres)

`res://gen/island_graph.tres` sets land wherever the noise is at least 0.5:

```
[gd_resource type="Resource" script_class="GaeaGraph" load_steps=5 format=3]

[ext_resource type="Script" path="res://addons/gaea/runtime/resources/graph.gd" id="1_graph"]
[ext_resource type="Script" path="res://addons/gaea/runtime/resources/layer.gd" id="2_layer"]
[ext_resource type="Script" path="res://addons/gaea/runtime/resources/materials/data/tilemap_material.gd" id="3_tile"]

[sub_resource type="Resource" id="Layer"]
script = ExtResource("2_layer")

[sub_resource type="Resource" id="LandTile"]
script = ExtResource("3_tile")
atlas_coord = Vector2i(1, 0)

[resource]
script = ExtResource("1_graph")
layers = Array[ExtResource("2_layer")]([SubResource("Layer")])
save_version = 5
_connections = Array[StringName]([&"1-0-2-0", &"3-0-2-1", &"2-0-0-0"])
_node_data = Dictionary[int, Dictionary]({
0: {&"type": 0, &"position": Vector2(0, 0), &"salt": 0, &"uid": "res://addons/gaea/runtime/graph_nodes/special/output.gd"},
1: {&"type": 0, &"position": Vector2(-600, 0), &"salt": 0, &"uid": "res://addons/gaea/runtime/graph_nodes/root/sampling/noise/noise_2d.gd", &"arguments": {&"frequency": 0.08}},
2: {&"type": 0, &"position": Vector2(-300, 0), &"salt": 0, &"uid": "res://addons/gaea/runtime/graph_nodes/root/map/mappers/threshold_mapper.gd", &"arguments": {&"range": {"min": 0.5, "max": 1.0}}},
3: {&"type": 0, &"position": Vector2(-600, 200), &"salt": 0, &"uid": "res://addons/gaea/runtime/graph_nodes/root/resources/variables/material_parameter.gd", &"arguments": {&"name": "Land"}}
})
_parameters = Dictionary[StringName, Variant]({
&"Land": {"name": "Land", "type": 24, "hint": 17, "hint_string": "GaeaMaterial", "usage": 4, "value": SubResource("LandTile")}
})
```

## Scene (.tscn)

Add these to a scene. The TileMapLayer `Ground` must have a `tile_set` whose source 0 has tile (1, 0).

```
[ext_resource type="Script" path="res://addons/gaea/runtime/scene_nodes/generator.gd" id="2_gen"]
[ext_resource type="Script" path="res://addons/gaea/runtime/resources/generation_settings.gd" id="3_set"]
[ext_resource type="Script" path="res://addons/gaea/runtime/scene_nodes/threading/task_pool.gd" id="4_pool"]
[ext_resource type="Script" path="res://addons/gaea/runtime/scene_nodes/renderers/tilemap_renderer.gd" id="5_ren"]
[ext_resource type="Resource" path="res://gen/island_graph.tres" id="6_graph"]

[sub_resource type="Resource" id="Settings"]
script = ExtResource("3_set")
random_seed_on_generate = false
seed = 1234
world_size = Vector3i(32, 32, 1)

[sub_resource type="Resource" id="Pool"]
script = ExtResource("4_pool")
multithreaded = false

[node name="Generator" type="Node" parent="."]
script = ExtResource("2_gen")
graph = ExtResource("6_graph")
settings = SubResource("Settings")
task_pool = SubResource("Pool")

[node name="Renderer" type="Node" parent="." node_paths=PackedStringArray("generator", "tile_map_layers")]
script = ExtResource("5_ren")
generator = NodePath("../Generator")
tile_map_layers = [NodePath("../Ground")]
```

Run it: `$Generator.generate()`, then `await $Generator.generation_finished`. The map is drawn by then.

## Build graphs in GDScript

To build or change a graph at runtime, read [references/graph-api.md](references/graph-api.md). It covers the same graph built with `add_node()`, `connect_nodes()`, and `set_parameter()`.

## Verify in WASD Engine

- Use `godot_run`, then `godot_eval`: `scene.get_node("Ground").get_used_cells().size()`. Look with `godot_screenshot`.
- With a fixed seed and fixed salts, the map repeats exactly. The graphs above give 457 land cells on 32×32 with seed 1234, and 582 with seed 99.
- 0 cells together with "Could not get data from previous node" in `godot_logs` means a required input is not wired or a port index is wrong.

## Pitfalls

- Web exports are single-threaded: give every generator a `GaeaTaskPool` with `multithreaded = false`, as above. Generation then runs inside `generate()`, and `generation_finished` fires at the end of the frame.
- Set `random_seed_on_generate = false`, or every `generate()` picks a new seed.
- Keep `save_version = 5`. The parameter name must match in the node's `arguments.name`, the `_parameters` key, and its `"name"`.
- Exported node properties in a `.tscn` need `node_paths=PackedStringArray(...)` in the node header.
- "ObjectDB instances leaked at exit" warnings from Gaea graphs are harmless.
