"""Smoke test for the rigify catalog entry (Rigify 0.6.10 in bpy 5.2.3). Assumes Rigify is enabled.

Generates the basic human meta-rig, skins a mesh with automatic weights, re-parents the DEF- bones into one
hierarchy, exports only the deform bones to .glb and imports that file back.
"""

import math
import os
import shutil
import tempfile

import bpy

ADDON_ID = "rigify"
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
    return ok


def game_skeleton(rig):
    """Give every DEF- bone a DEF- parent so that a deform-only export keeps one hierarchy."""
    bones = rig.data.bones
    deform = {b.name for b in bones if b.use_deform}
    for name in deform:  # bones that follow their parent only through parenting get a Copy Transforms first
        parent = bones[name].parent
        pose_bone = rig.pose.bones[name]
        if parent and parent.name not in deform and not any(c.type == 'COPY_TRANSFORMS' for c in pose_bone.constraints):
            constraint = pose_bone.constraints.new('COPY_TRANSFORMS')
            constraint.target = rig
            constraint.subtarget = parent.name

    def deform_ancestor(name):
        bone = bones[name].parent
        while bone:
            for candidate in (bone.name, "DEF-" + bone.name.split("-", 1)[-1]):
                if candidate in deform and candidate != name:
                    return candidate
            bone = bone.parent
        return None

    plan = {n: deform_ancestor(n) for n in deform if not bones[n].parent or bones[n].parent.name not in deform}
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, parent in plan.items():
        edit_bone = rig.data.edit_bones[name]
        edit_bone.use_connect = False
        edit_bone.parent = rig.data.edit_bones[parent] if parent else None
    bpy.ops.object.mode_set(mode='OBJECT')


def deform_matrices(rig):
    bpy.context.view_layer.update()
    return {b.name: rig.matrix_world @ rig.pose.bones[b.name].matrix for b in rig.data.bones if b.use_deform}


def fcurve_count(action):
    return sum(len(bag.fcurves) for layer in action.layers for strip in layer.strips for bag in strip.channelbags)


def main(folder):
    check(hasattr(bpy.types.Armature, "rigify_target_rig"), "Rigify is not enabled")
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    scene = bpy.context.scene

    bpy.ops.object.armature_basic_human_metarig_add()
    metarig = bpy.context.active_object
    check(metarig.type == 'ARMATURE' and len(metarig.data.bones) == 29, "basic human meta-rig has %d bones" % len(metarig.data.bones))
    bpy.ops.pose.rigify_generate()
    rig = metarig.data.rigify_target_rig
    if not check(rig is not None, "rigify_generate made no rig"):
        return
    deform = [b.name for b in rig.data.bones if b.use_deform]
    check(len(deform) == 35, "expected 35 deform bones, got %d" % len(deform))
    check(all(name.startswith("DEF-") for name in deform), "a deform bone is not named DEF-")

    bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.18, depth=1.6, location=(0, 0, 0.9))
    body = bpy.context.active_object
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.subdivide(number_cuts=12)
    bpy.ops.object.mode_set(mode='OBJECT')
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    groups = {g.name for g in body.vertex_groups}
    check(body.parent == rig and any(m.type == 'ARMATURE' for m in body.modifiers), "automatic weights did not bind the mesh")
    check(groups and all(name.startswith("DEF-") for name in groups), "vertex groups are not DEF- bones: %s" % sorted(groups)[:5])
    weighted = {body.vertex_groups[g.group].name for v in body.data.vertices for g in v.groups if g.weight > 0.01}
    check(len(weighted) >= 10, "only %d bones got weights" % len(weighted))

    scene.frame_start, scene.frame_end = 1, 10
    rig.pose.bones["upper_arm_parent.L"]["IK_FK"] = 1.0  # use the FK arm
    arm = rig.pose.bones["upper_arm_fk.L"]
    arm.rotation_mode = 'XYZ'
    for frame, angle in ((1, 0.0), (10, math.radians(60))):
        arm.rotation_euler = (0.0, 0.0, angle)
        arm.keyframe_insert("rotation_euler", frame=frame)
    hand = []
    for frame in (1, 10):
        scene.frame_set(frame)
        hand.append(deform_matrices(rig)["DEF-hand.L"].translation.copy())
    check((hand[1] - hand[0]).length > 0.1, "the FK arm animation does not move DEF-hand.L")
    scene.frame_set(5)
    before = deform_matrices(rig)
    game_skeleton(rig)
    after = deform_matrices(rig)
    drift = max(abs(a - b) for n in before for ra, rb in zip(before[n], after[n]) for a, b in zip(ra, rb))
    check(drift < 1e-4, "re-parenting moved the deform bones by %g" % drift)
    roots = [b.name for b in rig.data.bones if b.use_deform and (not b.parent or not b.parent.use_deform)]
    check(roots == ["DEF-spine"], "deform roots are %s" % roots)

    path = os.path.join(folder, "rigify_smoke.glb")
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    body.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_def_bones=True,
                                       export_animations=True, export_force_sampling=True)
    check(result == {'FINISHED'} and os.path.isfile(path), "glTF export failed: %s" % result)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    bpy.ops.import_scene.gltf(filepath=path)
    armatures = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    if not check(len(armatures) == 1, "reimport has %d armatures" % len(armatures)):
        return
    imported = armatures[0].data.bones
    check(len(imported) == 35 and all(b.name.startswith("DEF-") for b in imported), "reimported bones: %d" % len(imported))
    check([b.name for b in imported if b.parent is None] == ["DEF-spine"], "reimported skeleton has another root")
    check(any(o.type == 'MESH' and o.find_armature() for o in bpy.data.objects), "reimported mesh is not skinned")
    check(any(fcurve_count(a) > 0 for a in bpy.data.actions), "the animation was not exported")


folder = tempfile.mkdtemp(prefix="wasd-smoke-rigify-")
try:
    main(folder)
except Exception as error:  # report, do not crash the harness
    failures.append("%s: %s" % (type(error).__name__, error))
finally:
    shutil.rmtree(folder, ignore_errors=True)
if failures:
    print("SMOKE_FAIL " + "; ".join(failures))
    raise SystemExit(1)
print("SMOKE_PASS " + ADDON_ID)
