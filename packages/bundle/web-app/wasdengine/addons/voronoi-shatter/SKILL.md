---
name: voronoi-shatter
description: VoronoiShatter 0.3 is installed in this project. VoronoiGenerator cuts a closed mesh into Voronoi chunks with inner faces, from game code, in tens of milliseconds a cut; the chunks become rigid bodies that fall apart. Load before making a wall, crate, pot, statue, or rock break into pieces.
---

# VoronoiShatter 0.3

`res://addons/voronoishatter/` (MIT; global classes, and no plugin to enable). `VoronoiGenerator` cuts the mesh of a `MeshInstance3D` into chunks along Voronoi cells and returns one `VoronoiMesh` per chunk. The installation leaves out the add-on's editor plugin with its `VoronoiShatter` and `VoronoiCollection` nodes, which work only inside the Godot editor: cut from game code as below.

## Cut a mesh

Keep one generator for the whole game, for example in an autoload:

```gdscript
var generator := VoronoiGenerator.new()

func _ready() -> void:
	add_child(generator)

## Replaces `target` with rigid bodies, one per chunk, and returns them.
func shatter(target: MeshInstance3D, chunks := 12, inner: Material = null, seed := 0) -> Array[RigidBody3D]:
	var config := VoronoiGeneratorConfig.new()
	config.random_seed = seed
	config.num_samples = chunks          # the cut returns about chunks + 8 pieces
	var bodies: Array[RigidBody3D] = []
	for piece: VoronoiMesh in generator.create_from_mesh(target, config):
		if inner != null:
			piece.mesh.surface_set_material(0, inner)      # surface 0: the cut faces
		var body := RigidBody3D.new()
		var mesh := MeshInstance3D.new()
		mesh.mesh = piece.mesh
		var shape := CollisionShape3D.new()
		shape.shape = piece.mesh.create_convex_shape()
		body.add_child(mesh)
		body.add_child(shape)
		target.get_parent().add_child(body)
		body.global_transform = target.global_transform * Transform3D(Basis.IDENTITY, -piece.position)
		bodies.append(body)
		piece.free()                     # VoronoiMesh and the config are Objects: free them
	config.free()
	target.queue_free()
	return bodies
```

`piece.position` is the negative of the chunk's centre in the target's space, hence the minus sign. After the cut, push the chunks away from the hit: `body.apply_central_impulse((body.global_position - hit_point).normalized() * force)`.

## What the cut needs

- A closed mesh without holes or loose faces: the cut intersects each cell with the mesh, and an open mesh returns chunks with missing sides or none. Godot's primitive meshes and solid models from Blender work; a plane or a single-sided wall does not.
- A target with scale 1. Scale the mesh in Blender or with the primitive's size instead, because a scaled rigid body misbehaves.
- Materials on the mesh's surfaces (`mesh.surface_set_material` or the imported material), which the outer faces of each chunk keep as surface 1 and up. A `material_override` on the instance does not carry over: set it on each chunk's `MeshInstance3D` again.
- `config.texture`, a `Texture3D`, places more cuts where it is bright, for example around the point of impact; without it the cuts spread evenly.

## Cost

- A cut of 12 samples took 28 ms on a desktop and 55 ms in a Web build; 40 samples take about twice that. Each cut also leaks a few hundred small objects that the add-on never frees. Cut each breakable thing once: at load, or when the level starts, keep the chunks hidden and frozen (`body.freeze = true`, `body.visible = false`), and swap them in on the hit. Cut at the moment of impact only for a rare event.
- Each chunk is a draw call and a body. Use 6 to 16 samples for props, free the chunks or turn them into static decoration after a few seconds (`body.freeze = true` once `body.sleeping`), and keep fewer than about 150 loose chunks alive in a Web game.
- Chunks smaller than a few centimetres jitter: remove pieces whose `mesh.get_aabb().size.length()` is tiny.

## Check it

`godot_run`, break the object, then `godot_screenshot`: the chunks have the object's outline and material outside and the inner material on the cut faces, none hangs in the air, and none has fallen through the floor. `godot_performance` right after a break shows the cost of the chunks.
