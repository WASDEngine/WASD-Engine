"""Smoke test for the sapling-tree-gen catalog entry (Sapling Tree Gen 1.0.0 on bpy 5.2.3). Assumes it is enabled.

Generates a low-poly tree from a built-in preset with overrides, checks seeds, converts it to one mesh within a
triangle budget, exports a .glb and imports it back.
"""

import importlib
import os
import shutil
import tempfile

import bpy

ADDON_ID = "sapling-tree-gen"
BUDGET = 6000  # triangles for trunk, branches and leaves together
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
    return ok


def evaluated(obj):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    owner = obj.evaluated_get(depsgraph)
    mesh = owner.to_mesh()
    result = (len(mesh.vertices), sum(len(p.vertices) - 2 for p in mesh.polygons), [tuple(v.co) for v in mesh.vertices[:50]])
    owner.to_mesh_clear()
    return result


def clear():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)


def make_tree(store, seed):
    clear()
    settings = store.load("black_oak").values  # a preset's settings, then overrides
    settings.update(seed=seed, scale=6.0, levels=3, branches=[0, 12, 6, 0], leaves=8, bevel=True, bevelRes=1, resU=2,
                    curveRes=[4, 3, 2, 1], showLeaves=True, leafShape='rect')
    result = bpy.ops.curve.tree_add(**settings)
    return result, {obj.name: obj for obj in bpy.data.objects}


def main(folder):
    package = next((a.module for a in bpy.context.preferences.addons if a.module.split(".")[-1] == "sapling_tree_gen"), None)
    if not check(package is not None and hasattr(bpy.ops.curve, "tree_add"), "Sapling Tree Gen is not enabled"):
        return
    store = importlib.import_module(package + ".presets").PresetStore.for_addon()
    builtin = [entry.name for entry in store.entries() if entry.builtin]
    check(len(builtin) == 29 and "black_oak" in builtin, "built-in presets: %s" % builtin)
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')

    result, objects = make_tree(store, 7)
    check(result == {'FINISHED'}, "tree_add returned %s" % result)
    if not check({"tree", "tree_curves", "leaves"} <= set(objects), "tree_add made %s" % sorted(objects)):
        return
    first = {name: evaluated(objects[name]) for name in ("tree", "leaves")}
    check(first["tree"][1] > 500 and first["leaves"][1] > 100, "tree is too small: %s" % {k: v[:2] for k, v in first.items()})
    check(abs(objects["tree"].dimensions.z - 6.0) < 1.5, "tree height %.2f m for scale 6" % objects["tree"].dimensions.z)
    _, again = make_tree(store, 7)
    check(evaluated(again["tree"]) == first["tree"], "the same seed gave another tree")
    _, other = make_tree(store, 8)
    check(evaluated(other["tree"])[2] != first["tree"][2], "another seed gave the same tree")

    tree = other["tree"]
    bpy.ops.object.select_all(action='DESELECT')
    tree.select_set(True)
    bpy.context.view_layer.objects.active = tree
    check(bpy.ops.object.convert(target='MESH') == {'FINISHED'}, "convert to mesh failed")
    bpy.data.objects.remove(other["tree_curves"])
    leaves = other["leaves"]
    bpy.ops.object.select_all(action='DESELECT')
    leaves.select_set(True)
    tree.select_set(True)
    bpy.context.view_layer.objects.active = tree
    bpy.ops.object.join()
    meshes = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    triangles = evaluated(tree)[1]
    check(len(meshes) == 1 and not tree.modifiers, "joined tree: %s" % [o.name for o in meshes])
    check(triangles <= BUDGET, "tree has %d triangles, budget %d" % (triangles, BUDGET))
    check({m.name for m in tree.data.materials} == {"Sapling Bark", "Sapling Leaf"}, "materials: %s" % [m.name for m in tree.data.materials])

    path = os.path.join(folder, "tree.glb")
    result = bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True)
    check(result == {'FINISHED'} and os.path.isfile(path), "glTF export failed: %s" % result)
    clear()
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [obj for obj in bpy.data.objects if obj.type == 'MESH']
    check(len(imported) == 1 and evaluated(imported[0])[1] == triangles, "reimported tree differs")


folder = tempfile.mkdtemp(prefix="wasd-smoke-sapling-")
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
