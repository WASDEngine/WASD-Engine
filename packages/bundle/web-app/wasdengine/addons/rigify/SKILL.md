---
name: rigify
description: Rigify 0.6.10, Blender 5.2.3's built-in auto-rigger, is enabled for this project's Blender and gives human and animal meta-rigs, generated control rigs with DEF- deform bones, automatic weights, and a deform-only skeleton for Godot. Load before rigging, skinning or animating a character in Blender.
---

# Rigify 0.6.10 (Blender 5.2.3, headless)

In each Blender Session, first run `import wasd_addons; wasd_addons.enable("rigify")` with `mcp__wasd_blender__execute_python`. It is idempotent, survives `new_scene`, and must be repeated after a tool result says the worker's state was lost. All code below runs in `execute_python` (set `result` to return values).

## What it adds

- Meta-rig operators (object mode; the meta-rig is added at the 3D cursor, named `metarig`, and made active): `bpy.ops.object.armature_basic_human_metarig_add()` (29 bones, no face or fingers), `armature_human_metarig_add()` (face and fingers), `armature_basic_quadruped_metarig_add()`, `armature_cat_metarig_add()`, `armature_wolf_metarig_add()`, `armature_horse_metarig_add()`, `armature_bird_metarig_add()`, `armature_shark_metarig_add()`.
- `bpy.ops.pose.rigify_generate()` builds the control rig from the active meta-rig: `metarig.data.rigify_target_rig` (object `rig`); widget meshes go to the hidden collection `WGTS_rig`. It returns `{'FINISHED'}` even when generation failed, so check `rigify_target_rig`. Generating again updates `rig` in place.
- Only `DEF-` bones deform. basic_human: 222 bones, 35 DEF, 0.2 s. human: 706 bones, 160 DEF (face included), about 10 s.
- Controls to animate: FK `upper_arm_fk.L`, `forearm_fk.L`, `hand_fk.L`, `thigh_fk.L`, `shin_fk.L`, `foot_fk.L`; IK `hand_ik.L`, `foot_ik.L`; body `torso`, `hips`, `chest`, `neck`, `head`, `root` (`.R` for the right side). IK/FK switch: custom property `IK_FK` on `upper_arm_parent.L` / `thigh_parent.L`, 0 = IK (default), 1 = FK. A custom property set from Python does not re-evaluate the rig: call `rig.update_tag()` after it.

## Fit, generate, skin

```python
import bpy
bpy.ops.object.armature_basic_human_metarig_add()
meta = bpy.context.active_object          # 1.98 m tall
meta.scale = (0.9, 0.9, 0.9)              # match the character, then apply the scale
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
bpy.ops.pose.rigify_generate()
rig = meta.data.rigify_target_rig
if rig is None:
    raise RuntimeError("Rigify generation failed; read the log")
body = bpy.data.objects["Body"]           # your mesh, in object mode, standing over the rig
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True); rig.select_set(True)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.parent_set(type='ARMATURE_AUTO')   # works headless: DEF- vertex groups only
result = sorted(g.name for g in body.vertex_groups)[:5]
```

For a finer fit, move meta-rig bones before generating: `bpy.ops.object.mode_set(mode='EDIT')`, then set `meta.data.edit_bones["upper_arm.L"].head` / `.tail`, then back to `'OBJECT'`.

## Animate

Keyframe controls, never DEF bones:

```python
rig.pose.bones["upper_arm_parent.L"]["IK_FK"] = 1.0   # FK arm
arm = rig.pose.bones["upper_arm_fk.L"]; arm.rotation_mode = 'XYZ'
arm.rotation_euler = (0, 0, 0); arm.keyframe_insert("rotation_euler", frame=1)
arm.rotation_euler = (0, 0, 1.0); arm.keyframe_insert("rotation_euler", frame=10)
bpy.context.scene.frame_end = 10
```

Blender 5 actions have no `action.fcurves`; read curves with `[f for l in act.layers for s in l.strips for b in s.channelbags for f in b.fcurves]`.

## Game skeleton for Godot

DEF bones follow ORG/MCH bones through constraints, and DEF-spine, pelvis, thighs, shoulders, upper arms and breasts have non-DEF parents. A deform-only export then gives 11 separate root bones (basic_human). Re-parent first; the deformation does not change (checked to 1e-6):

```python
def game_skeleton(rig):
    bones = rig.data.bones
    deform = {b.name for b in bones if b.use_deform}
    for name in deform:   # DEF bones that follow their parent only by parenting get a Copy Transforms
        parent, pb = bones[name].parent, rig.pose.bones[name]
        if parent and parent.name not in deform and not any(c.type == 'COPY_TRANSFORMS' for c in pb.constraints):
            c = pb.constraints.new('COPY_TRANSFORMS'); c.target = rig; c.subtarget = parent.name
    def ancestor(name):
        b = bones[name].parent
        while b:
            for cand in (b.name, "DEF-" + b.name.split("-", 1)[-1]):
                if cand in deform and cand != name:
                    return cand
            b = b.parent
    plan = {n: ancestor(n) for n in deform if not bones[n].parent or bones[n].parent.name not in deform}
    bpy.ops.object.select_all(action='DESELECT'); rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, parent in plan.items():
        eb = rig.data.edit_bones[name]
        eb.use_connect = False
        eb.parent = rig.data.edit_bones[parent] if parent else None
    bpy.ops.object.mode_set(mode='OBJECT')

game_skeleton(rig)
bpy.ops.object.select_all(action='DESELECT')
rig.select_set(True); body.select_set(True); bpy.context.view_layer.objects.active = rig
bpy.ops.export_scene.gltf(filepath="/abs/path/hero.glb", export_format='GLB', use_selection=True,
                          export_def_bones=True, export_animations=True, export_force_sampling=True)
```

The `export_gltf` tool has no deform-only option, so call the exporter as above. `export_def_bones` is ignored when animations are exported without `export_force_sampling`. Result: one skeleton of DEF- bones rooted at `DEF-spine`, the skinned mesh, and the baked actions. `root` is not a deform bone and is not exported.

## Verify

- `len([b for b in rig.data.bones if b.use_deform])` and the deform roots: bones whose parent is None or not deform (after `game_skeleton`: only `DEF-spine`).
- Import the .glb into a new scene (`bpy.ops.import_scene.gltf`) and count bones and roots, or run the game and read the Skeleton3D `get_bone_count()` with `godot_eval`.
- `render_preview(objects=["Body"])` shows the posed mesh.

## Pitfalls

- `bpy.ops.object.mode_set` needs an active object; return to object mode before exporting.
- The face meta-rig (`armature_human_metarig_add`) is slow and heavy for Web games; use basic_human unless the face must animate.
- Heat weighting needs a closed mesh around the bones; bones it cannot reach get no weights, and the log says "Bone Heat Weighting: failed".
- Do not delete ORG/MCH bones or the `WGT-` objects, and do not export `WGT-` objects or the meta-rig.
