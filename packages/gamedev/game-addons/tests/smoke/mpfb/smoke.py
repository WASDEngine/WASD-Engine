"""Smoke test for the mpfb catalog entry (MPFB 2.0.18 on bpy 5.2.3). Assumes MPFB is enabled.

Creates humans with MPFB's HumanService, adds the game_engine skeleton, bakes the body for export, decimates it,
exports a skinned .glb and imports it back. Then dresses a human from the MakeHuman system assets that WASD Engine
installs with MPFB (low-poly proxy, skin, eyes, hair, clothes), exports and reimports it, and checks that MPFB still
reads the pack after factory settings reset its preferences.
"""

import importlib
import math
import os
import shutil
import tempfile

import bpy

ADDON_ID = "mpfb"
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
    return ok


def evaluated(obj):
    """(vertices, triangles, z height) of the object with its modifiers."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    owner = obj.evaluated_get(depsgraph)
    mesh = owner.to_mesh()
    zs = [v.co.z for v in mesh.vertices]
    result = (len(mesh.vertices), sum(len(p.vertices) - 2 for p in mesh.polygons), max(zs) - min(zs))
    owner.to_mesh_clear()
    return result


def main(folder):
    package = next((a.module for a in bpy.context.preferences.addons if a.module.split(".")[-1] == "mpfb"), None)
    if not check(package is not None, "MPFB is not enabled"):
        return
    services = importlib.import_module(package + ".services")
    exports = importlib.import_module(package + ".services.exportservice")
    HumanService, TargetService = services.HumanService, services.TargetService
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)

    heights = []
    for height in (0.0, 1.0):
        macro = TargetService.get_default_macro_info_dict()
        macro["height"] = height
        human = HumanService.create_human(macro_detail_dict=macro)
        heights.append(evaluated(human)[2])
        bpy.data.objects.remove(human)
    check(heights[1] - heights[0] > 0.1, "the height slider changed the body by %.3f m" % (heights[1] - heights[0]))

    macro = TargetService.get_default_macro_info_dict()
    macro["gender"] = 1.0
    basemesh = HumanService.create_human(macro_detail_dict=macro)
    vertices, triangles, height = evaluated(basemesh)
    check(len(basemesh.data.vertices) == 19158, "base mesh has %d vertices with helpers" % len(basemesh.data.vertices))
    check(vertices == 13380 and 1.5 < height < 2.0, "visible body: %d vertices, %.2f m" % (vertices, height))

    rig = HumanService.add_builtin_rig(basemesh, "game_engine")
    if not check(rig is not None and rig.type == 'ARMATURE', "add_builtin_rig made no armature"):
        return
    bones = rig.data.bones
    check(len(bones) == 53 and [b.name for b in bones if b.parent is None] == ["Root"], "game_engine rig: %d bones" % len(bones))
    check(basemesh.parent == rig and any(m.type == 'ARMATURE' and m.object == rig for m in basemesh.modifiers),
          "the body is not bound to the rig")

    TargetService.bake_targets(basemesh)
    exports.ExportService.bake_modifiers_remove_helpers(basemesh, bake_masks=True)
    check(basemesh.data.shape_keys is None and len(basemesh.data.vertices) == 13380,
          "baked body: %d vertices, shape keys %s" % (len(basemesh.data.vertices), basemesh.data.shape_keys))

    rest = [v.co.copy() for v in basemesh.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh().vertices]
    basemesh.evaluated_get(bpy.context.evaluated_depsgraph_get()).to_mesh_clear()
    arm = rig.pose.bones["upperarm_l"]
    arm.rotation_mode = 'XYZ'
    arm.rotation_euler = (0.0, 0.0, math.radians(45))
    bpy.context.view_layer.update()
    posed_owner = basemesh.evaluated_get(bpy.context.evaluated_depsgraph_get())
    moved = sum((a - b.co).length > 0.01 for a, b in zip(rest, posed_owner.to_mesh().vertices))
    posed_owner.to_mesh_clear()
    check(500 < moved < 6000, "posing upperarm_l moved %d vertices" % moved)
    arm.rotation_euler = (0.0, 0.0, 0.0)

    decimate = basemesh.modifiers.new("Decimate", 'DECIMATE')
    decimate.ratio = 0.25
    triangles = evaluated(basemesh)[1]
    check(triangles <= 8000, "decimated body has %d triangles" % triangles)

    path = os.path.join(folder, "mpfb_smoke.glb")
    bpy.ops.object.select_all(action='DESELECT')
    basemesh.select_set(True)
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True)
    check(result == {'FINISHED'} and os.path.isfile(path), "glTF export failed: %s" % result)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    bpy.ops.import_scene.gltf(filepath=path)
    armatures = [o for o in bpy.data.objects if o.type == 'ARMATURE']
    meshes = [o for o in bpy.data.objects if o.type == 'MESH' and o.find_armature()]
    check(len(armatures) == 1 and len(armatures[0].data.bones) == 53, "reimported armature is wrong")
    check(len(meshes) == 1 and evaluated(meshes[0])[1] == triangles, "reimported skinned body is wrong")


def second_root(package):
    return os.path.realpath(bpy.context.preferences.addons[package].preferences.mpfb_second_root)


def dressed(folder):
    """Dress a human from the asset pack, export it, and check the reimported character."""
    import wasd_addons  # the worker's module; a smoke test runs inside the worker

    assets = wasd_addons.assets(ADDON_ID)
    package = next(a.module for a in bpy.context.preferences.addons if a.module.split(".")[-1] == "mpfb")
    check(second_root(package) == os.path.realpath(assets), "MPFB's second root is %s, not the pack" % second_root(package))
    HumanService = importlib.import_module(package + ".services").HumanService
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    body = HumanService.create_human()
    rig = HumanService.add_builtin_rig(body, "game_engine")

    def part(path, kind):
        return HumanService.add_mhclo_asset(os.path.join(assets, *path.split("/")), body, asset_type=kind, subdiv_levels=0)

    proxy = part("proxymeshes/proxy741/proxy741.proxy", "Proxymeshes")
    HumanService.set_character_skin(os.path.join(assets, "skins", "young_caucasian_male", "young_caucasian_male.mhmat"), body,
                                    skin_type="GAMEENGINE", material_instances=False)
    worn = [part("eyes/low-poly/low-poly.mhclo", "Eyes"), part("hair/short02/short02.mhclo", "Hair"),
            part("clothes/male_casualsuit01/male_casualsuit01.mhclo", "Clothes")]
    check(proxy is not None and len(proxy.data.vertices) == 741, "the low-poly proxy is missing or not 741 vertices")
    check(all(obj is not None and obj.find_armature() == rig for obj in worn), "eyes, hair, or clothes are not on the rig")
    check(proxy is not None and any(slot.material is not None for slot in proxy.material_slots), "the skin gave the proxy no material")
    path = os.path.join(folder, "mpfb_dressed.glb")
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [rig, proxy, *worn]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True)
    check(result == {'FINISHED'} and os.path.isfile(path), "glTF export of the dressed human failed: %s" % result)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    bpy.ops.import_scene.gltf(filepath=path)
    skinned = [o for o in bpy.data.objects if o.type == 'MESH' and o.find_armature()]
    check(len(skinned) == 4, "the reimported character has %d skinned meshes, not 4" % len(skinned))
    check(any(img.size[0] > 0 for img in bpy.data.images), "the reimported character has no textures")
    # Factory settings reset add-on preferences; the worker runs MPFB's setup again.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    check(second_root(package) == os.path.realpath(assets), "after factory settings, MPFB's second root is %s" % second_root(package))


folder = tempfile.mkdtemp(prefix="wasd-smoke-mpfb-")
try:
    main(folder)
    if not failures:
        dressed(folder)
except Exception as error:  # report, do not crash the harness
    failures.append("%s: %s" % (type(error).__name__, error))
finally:
    shutil.rmtree(folder, ignore_errors=True)
if failures:
    print("SMOKE_FAIL " + "; ".join(failures))
    raise SystemExit(1)
print("SMOKE_PASS " + ADDON_ID)
