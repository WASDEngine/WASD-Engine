---
name: vrm
description: VRM Add-on for Blender 4.10.4 is installed for this project's Blender and imports and exports VRM 1.0 and 0.x humanoid avatars (.vrm) with humanoid bone mapping and metadata, so VRoid-style avatars can be converted to .glb for Godot. Load before reading or writing .vrm files in Blender.
---

# VRM Add-on 4.10.4 on Blender 5.2.3, headless

In each Blender Session, first run `import wasd_addons; wasd_addons.enable("vrm")` with `mcp__wasd_blender__execute_python`. It is idempotent, survives `new_scene`, and must be repeated after a tool result says the worker's state was lost. All code below runs in `execute_python` (set `result` to return values).

Call the operators with their arguments as below. Their dialogs (bone assignment, validation results, export confirmation) are UI-only and never appear headless.

## What it adds

- `bpy.ops.icyp.make_basic_armature()`: a VRM 1.0 humanoid armature `Armature` (54 bones: `hips`, `spine`, `chest`, `neck`, `head`, `upper_arm.L`, `lower_arm.L`, `hand.L`, fingers, `upper_leg.L`, `lower_leg.L`, `foot.L`, `toes.L`, ... and `.R`), 1.70 m, human bones assigned. About 5 s. `skip_heavy_armature_setup=True` is instant but leaves the bones unassigned.
- `bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=name)` (and `assign_vrm0_...` for VRM 0.x) maps an armature's bones by name. It recognizes this add-on's names, MPFB rigs (tested: game_engine maps `pelvis` to hips, `spine_01` to spine, `upperarm_l` to leftUpperArm), Rigify meta-rigs, Unreal, Mixamo, VRoid, MMD and others.
- `bpy.ops.vrm.model_validate(armature_object_name=name)` returns `{'CANCELLED'}` when the model has errors and writes them to the log.
- `bpy.ops.export_scene.vrm(filepath=path, armature_object_name=name)` writes a binary glTF with the `VRMC_vrm` extension (VRM 1.0) or `VRM` (0.x). Options: `export_invisibles`, `export_only_selections`, `export_lights`, `export_gltf_animations`, `export_all_influences`.
- `bpy.ops.import_scene.vrm(filepath=path, ...)` imports a .vrm (VRM 0.x or 1.0) as an armature with meshes and materials.
- Per armature, `arm.data.vrm_addon_extension`: `spec_version` (`"1.0"` or `"0.0"`); VRM 1.0 `vrm1.meta.vrm_name`, `vrm1.meta.authors` (items with `.value`), `vrm1.humanoid.human_bones.hips.node.bone_name` (also `spine`, `chest`, `upper_chest`, `neck`, `head`, `left_upper_arm`, `left_hand`, `right_upper_leg`, `right_foot`, `left_toes`...) and `vrm1.humanoid.human_bones.bones_are_correctly_assigned()`; VRM 0.x `vrm0.meta.title`, `vrm0.meta.author`.

## Export a humanoid

```python
import bpy
bpy.ops.icyp.make_basic_armature()
arm = bpy.context.active_object
body = bpy.data.objects["Body"]                 # your mesh standing on the armature
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
ext = arm.data.vrm_addon_extension
ext.vrm1.meta.vrm_name = "Hero"                 # without these the file says "undefined"
ext.vrm1.meta.authors.clear(); ext.vrm1.meta.authors.add().value = "Studio"
bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=arm.name)
assert ext.vrm1.humanoid.human_bones.bones_are_correctly_assigned()
assert bpy.ops.vrm.model_validate(armature_object_name=arm.name) == {'FINISHED'}
result = bpy.ops.export_scene.vrm(filepath="/abs/path/hero.vrm", armature_object_name=arm.name)
```

For an MPFB human, use its rig instead of `make_basic_armature`: `HumanService.add_builtin_rig(body, "game_engine")`, bake it (see the mpfb skill), then assign and export with `armature_object_name="Human.rig"` (tested: 52 human bones in the file). For VRM 0.x set `ext.spec_version = "0.0"`, run `assign_vrm0_humanoid_human_bones_automatically`, fill `ext.vrm0.meta.title` and `.author`, then export.

## Import a .vrm and convert it for Godot

Godot does not read .vrm files. Import, then export a .glb:

```python
bpy.ops.import_scene.vrm(filepath="/abs/path/avatar.vrm",
                         set_shading_type_to_material_on_import=False,
                         set_view_transform_to_standard_on_import=False)
arm = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
hb = arm.data.vrm_addon_extension.vrm1.humanoid.human_bones
result = {"spec": arm.data.vrm_addon_extension.spec_version, "hips": hb.hips.node.bone_name}
```

Then call the `export_gltf` tool with `selection: [arm.name]` (or `bpy.ops.export_scene.gltf(..., use_selection=True)`): the .glb has one skin with every bone and no VRM extensions. VRM-only data (expressions, spring bones, MToon shading) does not carry over; check the materials in Godot.

## Verify

- Read the file back: the first 20 bytes of a .vrm are the glTF header; `json.loads(data[20:20 + length])` (length = `int.from_bytes(data[12:16], "little")`) gives `extensions.VRMC_vrm.humanoid.humanBones` (each `{"node": index}` into `nodes`) and `extensions.VRMC_vrm.meta`.
- Or import it into an empty scene and check `bones_are_correctly_assigned()` and `hips.node.bone_name`.
- `render_preview(objects=[arm.name])` after import.

## Pitfalls

- Without the two `set_..._on_import=False` options the importer switches every 3D view to Material shading, which raises "enum MATERIAL not found" when the scene renders with Workbench, and it changes the scene's view transform to Standard.
- `export_scene.vrm` returns `{'CANCELLED'}` without a message when validation fails: run `model_validate` first and read the log.
- Pass `armature_object_name` to every operator; do not rely on the active object.
- After each `new_scene` the add-on's log lines repeat once more; harmless.
