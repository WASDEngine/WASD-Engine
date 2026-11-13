"""Smoke test for the wasd-cloth-blender catalog entry (WASD Cloth 1.0.0 on bpy 5.2.3). Assumes the extension is enabled.

Drapes a tablecloth over a table, bakes a flag's wind loop into shape keys, rigs a cape and a skirt with bone chains on
a small armature, and exports each to a .glb, checking the measurements that each function returns.
"""

import importlib
import os
import shutil
import tempfile

import bmesh
import bpy
import wasd_addons

ADDON_ID = "wasd-cloth-blender"
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
    return ok


def clear():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)


def export(objects, path):
    for obj in bpy.context.scene.objects:
        obj.select_set(obj in objects)
    with bpy.context.temp_override(scene=bpy.context.scene, view_layer=bpy.context.scene.view_layers[0]):
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=False)
    return os.path.getsize(path)


def box(name, size, center):
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vertex in bm.verts:
        vertex.co = (vertex.co.x * size[0] + center[0], vertex.co.y * size[1] + center[1], vertex.co.z * size[2] + center[2])
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def main(folder):
    cloth = importlib.import_module(wasd_addons.enable(ADDON_ID))

    clear()
    table = box("Table", (1.0, 1.0, 0.8), (0.0, 0.0, 0.4))
    sheet = cloth.sheet("Tablecloth", size=(1.4, 1.4), cell=0.05, facing="HORIZONTAL", location=(0.0, 0.0, 0.84))
    drape = cloth.drape(sheet, [table], "cotton", frames=80)
    check(drape["not_numbers"] == 0, f"drape points are not numbers: {drape}")
    check(drape["inside_colliders"] == 0, f"drape sank into the table: {drape}")
    check(drape["stretch_p95"] < 0.02, f"drape stretched: {drape}")
    check(not any(m.type == "CLOTH" for m in sheet.modifiers), "drape kept its Cloth modifier")
    low = min((sheet.matrix_world @ v.co).z for v in sheet.data.vertices)
    check(low < 0.7, f"the tablecloth did not hang over the table's sides (lowest point {low:.2f} m)")
    check(export([sheet, table], os.path.join(folder, "tablecloth.glb")) > 0, "tablecloth.glb is empty")

    clear()
    flag = cloth.sheet("Flag", size=(1.0, 0.7), cell=0.05, location=(0.53, 0.0, 2.0))
    check(cloth.pin(flag, "left", rows=2) == 30, "pin() did not take 2 columns of 15 points")
    loop = cloth.bake_loop(flag, wind_speed=6, seconds=1.0, warmup=1.5, blend=0.25)
    looped = bpy.data.objects.get(loop["object"])
    check(looped is not None and loop["frames"] == 24, f"bake_loop made no 24-frame loop: {loop}")
    if looped is not None:
        keys = looped.data.shape_keys
        check(keys is not None and len(keys.key_blocks) == 24, "the loop does not have a basis and 23 frame keys")
        check(keys.animation_data.action.name.endswith("loop"), "the loop's action name does not end in loop")
        check(len(looped.modifiers) == 0, "the loop object has modifiers, which would drop its shape keys on export")
        check(loop["not_numbers"] == 0, f"the loop has points that are not numbers: {loop}")
        check(export([looped], os.path.join(folder, "flag_loop.glb")) > 0, "flag_loop.glb is empty")
    check(not any(m.type == "CLOTH" for m in flag.modifiers) and bpy.data.objects.get("Flag_simulating") is None, "bake_loop left its simulation behind")

    clear()
    data = bpy.data.armatures.new("Hero")
    arm = bpy.data.objects.new("Hero", data)
    bpy.context.scene.collection.objects.link(arm)
    layer = bpy.context.scene.view_layers[0]
    layer.objects.active = arm
    bones = [("Hips", None, (0, 0, 1.0), (0, 0, 1.15)), ("Spine", "Hips", (0, 0, 1.15), (0, 0, 1.35)),
             ("Chest", "Spine", (0, 0, 1.35), (0, 0, 1.55)), ("Neck", "Chest", (0, 0, 1.55), (0, 0, 1.7))]
    with bpy.context.temp_override(scene=bpy.context.scene, view_layer=layer, active_object=arm, object=arm, selected_objects=[arm], selected_editable_objects=[arm]):
        bpy.ops.object.mode_set(mode="EDIT")
        for name, parent, head, tail in bones:
            bone = data.edit_bones.new(name)
            bone.head, bone.tail = head, tail
            if parent:
                bone.parent = data.edit_bones[parent]
        bpy.ops.object.mode_set(mode="OBJECT")
    cape = cloth.sheet("Cape", size=(0.6, 1.0), cell=0.05, location=(0.0, 0.2, 1.0))
    rigged = cloth.add_chains(cape, arm, anchor="Chest", group="cape", columns=5, rows=6)
    check(len(rigged["bones"]) == 30 and rigged["bones"][0] == "cloth_cape_00_00", f"add_chains made the wrong bones: {rigged['bones'][:3]}")
    check(rigged["farthest_from_cloth"] < 0.05, f"the cape's chains are {rigged['farthest_from_cloth']} m from it")
    check(any(m.type == "ARMATURE" and m.object == arm for m in cape.modifiers), "the cape has no Armature modifier")
    check(cape.vertex_groups.get("Chest") is not None and cape.vertex_groups.get("cloth_cape_02_05") is not None, "the cape is not weighted to the anchor and the chains")
    skirt_mesh = bpy.data.meshes.new("Skirt")
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=24, radius1=0.3, radius2=0.19, depth=0.5)
    bmesh.ops.subdivide_edges(bm, edges=[e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) > 0.1], cuts=6)
    for vertex in bm.verts:
        vertex.co.z += 0.72
    bm.to_mesh(skirt_mesh)
    bm.free()
    skirt = bpy.data.objects.new("Skirt", skirt_mesh)
    bpy.context.scene.collection.objects.link(skirt)
    tube = cloth.add_chains(skirt, arm, anchor="Hips", group="skirt", columns=8, rows=4, layout="tube")
    check(len(tube["bones"]) == 32 and tube["farthest_from_cloth"] < 0.05, f"the skirt's chains are wrong: {tube['farthest_from_cloth']}")
    check(len(arm.data.bones) == 4 + 30 + 32, f"the armature has {len(arm.data.bones)} bones")
    check(export([arm, cape, skirt], os.path.join(folder, "hero.glb")) > 0, "hero.glb is empty")

    if failures:
        for failure in failures:
            print(f"SMOKE_FAIL {ADDON_ID}: {failure}")
    else:
        print(f"SMOKE_PASS {ADDON_ID}")


folder = tempfile.mkdtemp(prefix="wasd-cloth-smoke-")
try:
    main(folder)
finally:
    shutil.rmtree(folder, ignore_errors=True)
