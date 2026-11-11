"""Smoke test for the vrm catalog entry (VRM Add-on for Blender 4.10.4 on bpy 5.2.3). Assumes the add-on is enabled.

Builds the add-on's own VRM humanoid armature, skins a mesh to it, exports VRM 1.0, checks the humanoid bone
mapping and metadata inside the .vrm file, then imports the file back and checks the mapping in Blender.
"""

import json
import os
import shutil
import struct
import tempfile

import bpy

ADDON_ID = "vrm"
EXPECTED = {"hips": "hips", "spine": "spine", "chest": "chest", "neck": "neck", "head": "head",
            "leftUpperArm": "upper_arm.L", "rightHand": "hand.R", "leftUpperLeg": "upper_leg.L", "rightFoot": "foot.R"}
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
    return ok


def glb_json(path):
    with open(path, "rb") as handle:
        data = handle.read()
    length, kind = struct.unpack("<II", data[12:20])
    if data[:4] != b"glTF" or kind != 0x4E4F534A:
        raise ValueError("%s is not a binary glTF file" % path)
    return json.loads(data[20:20 + length])


def main(folder):
    check(hasattr(bpy.ops.export_scene, "vrm") and hasattr(bpy.ops.icyp, "make_basic_armature"), "the VRM add-on is not enabled")
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)

    check(bpy.ops.icyp.make_basic_armature() == {'FINISHED'}, "make_basic_armature failed")
    armature = bpy.context.active_object
    extension = armature.data.vrm_addon_extension
    check(armature.type == 'ARMATURE' and extension.spec_version == "1.0", "new humanoid is not VRM 1.0")
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.15, depth=1.6, location=(0, 0, 0.85))
    body = bpy.context.active_object
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')

    meta = extension.vrm1.meta
    meta.vrm_name = "Smoke Humanoid"
    meta.authors.clear()
    meta.authors.add().value = "WASD Engine"
    result = bpy.ops.vrm.assign_vrm1_humanoid_human_bones_automatically(armature_object_name=armature.name)
    human_bones = extension.vrm1.humanoid.human_bones
    check(result == {'FINISHED'} and human_bones.bones_are_correctly_assigned(), "automatic bone assignment failed")
    check(bpy.ops.vrm.model_validate(armature_object_name=armature.name) == {'FINISHED'}, "model_validate found errors")

    path = os.path.join(folder, "smoke.vrm")
    result = bpy.ops.export_scene.vrm(filepath=path, armature_object_name=armature.name)
    if not check(result == {'FINISHED'} and os.path.isfile(path), "export_scene.vrm returned %s" % result):
        return
    gltf = glb_json(path)
    vrm = gltf.get("extensions", {}).get("VRMC_vrm", {})
    check("VRMC_vrm" in gltf.get("extensionsUsed", []), "the file has no VRMC_vrm extension")
    nodes = [node.get("name") for node in gltf.get("nodes", [])]
    in_file = {name: nodes[bone["node"]] for name, bone in vrm.get("humanoid", {}).get("humanBones", {}).items()}
    check(all(in_file.get(k) == v for k, v in EXPECTED.items()), "humanBones in the file: %s" % in_file)
    check(len(in_file) >= 50, "only %d human bones in the file" % len(in_file))
    check(vrm.get("meta", {}).get("name") == "Smoke Humanoid" and vrm["meta"].get("authors") == ["WASD Engine"], "meta in the file: %s" % vrm.get("meta"))

    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    # With its defaults the importer switches every 3D view to Material shading, which raises when the scene renders
    # with Workbench, and sets the scene's view transform to Standard; both options turn that off.
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_WORKBENCH'
    view_transform = scene.view_settings.view_transform
    result = bpy.ops.import_scene.vrm(filepath=path, set_shading_type_to_material_on_import=False,
                                      set_view_transform_to_standard_on_import=False)
    check(result == {'FINISHED'}, "import_scene.vrm failed")
    check(scene.view_settings.view_transform == view_transform, "the import changed the view transform")
    armatures = [obj for obj in bpy.data.objects if obj.type == 'ARMATURE']
    if not check(len(armatures) == 1, "import made %d armatures" % len(armatures)):
        return
    imported = armatures[0].data.vrm_addon_extension
    bones = imported.vrm1.humanoid.human_bones
    check(imported.spec_version == "1.0" and bones.bones_are_correctly_assigned(), "imported humanoid is not assigned")
    mapping = {"hips": bones.hips, "head": bones.head, "leftUpperArm": bones.left_upper_arm, "rightFoot": bones.right_foot}
    check(all(mapping[k].node.bone_name == EXPECTED[k] for k in mapping), "imported mapping: %s" % {k: v.node.bone_name for k, v in mapping.items()})
    check(imported.vrm1.meta.vrm_name == "Smoke Humanoid", "imported meta name: %r" % imported.vrm1.meta.vrm_name)
    check(any(obj.type == 'MESH' and obj.find_armature() == armatures[0] for obj in bpy.data.objects), "imported mesh is not skinned")


folder = tempfile.mkdtemp(prefix="wasd-smoke-vrm-")
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
