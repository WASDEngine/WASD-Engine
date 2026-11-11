# Gaea graphs in GDScript

`GaeaGraph.new()` already holds the Output node (id 0) and one `GaeaLayer`. Add more layers to `graph.layers` before you connect them; layer i is input port i of node 0.

## Methods

- `add_node(node: GaeaNodeResource, position: Vector2) -> int` adds a node and returns its id. It gives the node a random `salt`, so set it with `set_node_salt(id, salt)` for repeatable maps.
- `set_node_argument(id, arg_name: StringName, value)` sets an argument that is not wired.
- `set_node_enum(id, enum_index, value)` selects an option. Noise2D's enum 0 is `GaeaNodeNoise.NoiseType`; the default is `SIMPLEX_SMOOTH`.
- `connect_nodes(from_id, from_port, to_id, to_port) -> Error` connects two ports. It returns `ERR_CANT_CONNECT` for a wrong port or type and `ERR_ALREADY_EXISTS` for a duplicate. `disconnect_nodes(...)` takes the same arguments.
- `remove_node(id)`.
- `get_raw_connections()` lists the wires as `"from-port-to-port"` strings, and `get_ids()` lists the node ids.
- `set_parameter(name, value)` and `get_parameter(name)`. A MaterialParameter node registers its parameter one frame after `add_node()`, named after the node title (`MaterialParameter`, then `MaterialParameter2`, …).
- `ResourceSaver.save(graph, "res://gen/my_graph.tres")` writes the text form that SKILL.md shows.
- Once a generator uses the graph, call `re_initialize_resource(id)` after changing a node, or the change may not apply. A `set_node_enum()` change applied only after it.

## The island graph in code

```gdscript
func build_graph() -> GaeaGraph:
	var graph := GaeaGraph.new()
	var noise := graph.add_node(GaeaNodeNoise2D.new(), Vector2(-600, 0))
	graph.set_node_argument(noise, &"frequency", 0.08)
	var mapper := graph.add_node(GaeaNodeThresholdMapper.new(), Vector2(-300, 0))
	graph.set_node_argument(mapper, &"range", {"min": 0.5, "max": 1.0})
	var land := graph.add_node(GaeaNodeMaterialParameter.new(), Vector2(-600, 200))
	for id in [noise, mapper, land]:
		graph.set_node_salt(id, 0)
	await get_tree().process_frame  # lets the MaterialParameter register itself
	var tile := TileMapGaeaMaterial.new()
	tile.atlas_coord = Vector2i(1, 0)
	graph.set_parameter(&"MaterialParameter", tile)
	graph.connect_nodes(noise, 0, mapper, 0)  # noise -> reference
	graph.connect_nodes(land, 0, mapper, 1)   # value -> material
	graph.connect_nodes(mapper, 0, 0, 0)      # map -> Output layer 0
	return graph
```

Use it with `$Generator.graph = await build_graph()`, then `$Generator.generate()`. With seed 1234 on 32×32 it gives the same 457 cells as `island_graph.tres`.

## A generator in code

```gdscript
var generator := GaeaGenerator.new()
generator.settings = GaeaGenerationSettings.new()
generator.settings.random_seed_on_generate = false
generator.settings.seed = 1234
generator.settings.world_size = Vector3i(32, 32, 1)
generator.task_pool = GaeaTaskPool.new()
generator.task_pool.multithreaded = false
add_child(generator)
generator.graph = graph
var renderer := TileMapGaeaRenderer.new()
renderer.generator = generator
renderer.tile_map_layers = [$Ground]
add_child(renderer)
```
