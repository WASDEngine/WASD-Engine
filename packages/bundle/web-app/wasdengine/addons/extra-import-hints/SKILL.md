---
name: extra-import-hints
description: Extra Import Hints 1.0 is installed in this project. Its Blender object-name suffixes -rigidonly, -convrigidonly, and -trueconvcolonly turn glTF/.glb nodes into RigidBody3D bodies and convex CollisionShape3D colliders on import. Load before modeling physics props for this project or changing how .glb files import.
---

# Extra Import Hints 1.0

The add-on is a post-import script, `res://addons/extra_import_hints/extra_import_hints.gd` (an `EditorScenePostImport`), not a node or class you call. The installer wrote two settings into `project.godot`:
- `[importer_defaults] scene={"import_script/path": "res://addons/extra_import_hints/extra_import_hints.gd"}`: every scene file (`.glb`, `.gltf`) imported for the first time runs the script.
- `[filesystem] import/blender/enabled=false`: Godot does not import `.blend` files. The add-on folder holds example `.blend` files, and without a configured Blender program a headless import stops at the first `.blend` file and imports nothing. Keep exporting `.glb` files; `.blend` files stay as sources.

## The hints

Name the Blender object (it becomes the glTF node name) with a suffix:
- `Name-convrigidonly` on a mesh: becomes a `RigidBody3D` named `Name` with one child `CollisionShape3D` `Name_collider` holding a `ConvexPolygonShape3D` of the mesh. The visible mesh is dropped.
- `Name-rigidonly` on a mesh: the same, but with a concave `ConcavePolygonShape3D` (see Pitfalls). On an Empty: a plain `RigidBody3D` named `Name` that keeps its children.
- `Name-trueconvcolonly` on a mesh: becomes only a `CollisionShape3D` `Name_collider` with a convex shape, no body. Use it for the colliders inside a `-rigidonly` Empty.
- Objects without a suffix import normally, and Godot's own hints still work beside these: `-col`, `-convcol`, `-colonly`, `-convcolonly`, `-rigid`, `-noimp`.

## Transforms are dropped

The script replaces each hinted node with a new node and does not copy its position, rotation, or scale: the new `RigidBody3D` or `CollisionShape3D` sits at its parent's origin. So:
- Make one physics prop per `.glb`, centered on the Blender origin, with the hinted Empty or mesh at location (0, 0, 0), rotation 0, scale 1. Place copies of the imported scene in Godot.
- Give `-trueconvcolonly` meshes their offset in the vertices: apply location, rotation, and scale (`bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)` on the active object) before parenting. Visual meshes without a suffix keep their transforms.

## Example: a mallet prop (Blender worker)

Run with `mcp__wasd_blender__execute_python`, then write it with `mcp__wasd_blender__export_gltf` as `res://models/mallet.glb`:

```python
import bpy
for obj in list(bpy.data.objects):
    bpy.data.objects.remove(obj)
bpy.ops.object.empty_add(location=(0, 0, 0))
body = bpy.context.active_object
body.name = "Mallet-rigidonly"
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.6), scale=(0.3, 0.15, 0.15))
head = bpy.context.active_object
head.name = "Head-trueconvcolonly"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.25), scale=(0.06, 0.06, 0.5))
handle = bpy.context.active_object
handle.name = "Handle-trueconvcolonly"
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.6), scale=(0.3, 0.15, 0.15))
visual = bpy.context.active_object
visual.name = "MalletHead"
for child in (head, handle, visual):
    child.parent = body
result = {"objects": sorted(o.name for o in bpy.data.objects)}
```

Godot imports it as:

```
mallet (Node3D)
  Mallet (RigidBody3D)
    Handle_collider (CollisionShape3D, ConvexPolygonShape3D)
    Head_collider (CollisionShape3D, ConvexPolygonShape3D)
    MalletHead (MeshInstance3D)
```

Use it like any imported model: `var mallet: Node3D = preload("res://models/mallet.glb").instantiate()`, set `mallet.position`, `add_child(mallet)`; the body is `mallet.get_node("Mallet")`.

## Models imported before the add-on

`importer_defaults` applies only to files without a `.import` file. For an older model, edit `res://models/<name>.glb.import` and set, under `[params]`:

```
import_script/path="res://addons/extra_import_hints/extra_import_hints.gd"
```

The next import (`godot_run` imports first) reimports it. To exclude one model, set `import_script/path=""` there instead.

## Check it in WASD Engine

After `godot_run`, read the result with `godot_eval`, for example `scene.get_node("Mallet/Mallet").get_class()` and `scene.get_node("Mallet/Mallet/Head_collider").shape.get_class()` (paths depend on where you placed the instance). Or write a small `extends SceneTree` script that loads the `.glb`, prints each node's `name` and `get_class()`, and quits, and run it with `godot_script` after an import.

## Pitfalls

- Every import of a scene file prints `ERROR: Condition "p_owner == this" is true.` (from `extra_import_hints.gd:65`) and, when the import process exits, leak messages such as `Pages in use exist at exit in PagedAllocator`, `Leaked instance dependency`, and `RID allocations ... were leaked at exit`. They are harmless: the import succeeds.
- A `-rigidonly` mesh gets a concave collider, and two concave shapes never collide: such a body falls through a `-col` floor (Godot warns `Collisions between two concave shapes are not supported.`). Use `-convrigidonly`, or an Empty with `-trueconvcolonly` children, for anything that moves.
- By default a `RigidBody3D` computes its center of mass from its `CollisionShape3D` origins, which this script leaves at the body origin: keep the prop's origin at its center.
- `.blend` files are not imported in this project: export `.glb`.

## Do not

- Do not edit `extra_import_hints.gd`, add a `plugin.cfg`, or remove the two settings above.
- Do not put several hinted props at different places in one `.glb`; their positions are lost.
