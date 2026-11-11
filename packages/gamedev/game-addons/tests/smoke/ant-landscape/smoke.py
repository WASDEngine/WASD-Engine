"""Smoke test for the ant-landscape catalog entry (A.N.T. Landscape 0.2.0 on bpy 5.2.3). Assumes it is enabled.

Generates a seeded terrain grid, checks its size, height range and determinism, bakes the heights into a float EXR
heightmap and reads it back, exports the mesh to .glb and imports it back.
"""

import os
import shutil
import tempfile

import bpy
import numpy as np

ADDON_ID = "ant-landscape"
N, SIZE = 65, 64.0  # 65 x 65 vertices over 64 m: one sample per metre
failures = []


def check(ok, message):
    if not ok:
        failures.append(message)
    return ok


def landscape(seed):
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    result = bpy.ops.mesh.landscape_add(refresh=True, subdivision_x=N, subdivision_y=N, mesh_size_x=SIZE,
                                        mesh_size_y=SIZE, random_seed=seed, noise_type='hetero_terrain', height=8.0,
                                        maximum=8.0, minimum=-2.0)
    obj = bpy.context.active_object
    coords = np.empty(len(obj.data.vertices) * 3, np.float32)
    obj.data.vertices.foreach_get("co", coords)
    return result, obj, coords


def main(folder):
    check(hasattr(bpy.ops.mesh, "landscape_add"), "A.N.T. Landscape is not enabled")
    if bpy.context.object and bpy.context.object.mode != 'OBJECT':
        bpy.ops.object.mode_set(mode='OBJECT')
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    check(bpy.ops.mesh.landscape_add() == {'PASS_THROUGH'} and not bpy.data.objects,
          "landscape_add without refresh=True made something")

    result, obj, coords = landscape(42)
    check(result == {'FINISHED'} and obj.name.startswith("Landscape"), "landscape_add returned %s" % result)
    check(len(obj.data.vertices) == N * N and len(obj.data.polygons) == (N - 1) ** 2, "grid is %d vertices" % len(obj.data.vertices))
    check(abs(obj.dimensions.x - SIZE) < 0.01 and abs(obj.dimensions.y - SIZE) < 0.01, "size %s" % (tuple(obj.dimensions),))
    z = coords[2::3]
    check(-2.0 <= z.min() and z.max() <= 8.0 and z.max() - z.min() > 1.0, "heights %.2f..%.2f" % (z.min(), z.max()))
    check(np.array_equal(landscape(42)[2], coords), "the same seed gave another terrain")
    check(not np.array_equal(landscape(43)[2], coords), "another seed gave the same terrain")
    result, obj, coords = landscape(42)

    # Heightmap: vertex k is column i = k // N (x) and j = k % N (y); image row 0 is +Y, which is -Z in Godot.
    rows = coords[2::3].reshape(N, N).T[::-1]
    image = bpy.data.images.new("heights", N, N, float_buffer=True, is_data=True)
    pixels = np.zeros((N, N, 4), np.float32)
    pixels[..., 0] = rows[::-1]  # Blender stores pixel rows bottom-up
    pixels[..., 3] = 1.0
    image.pixels.foreach_set(pixels.ravel())
    exr = os.path.join(folder, "height.exr")
    image.filepath_raw = exr
    image.file_format = 'OPEN_EXR'
    image.save()
    bpy.data.images.remove(image)
    loaded = bpy.data.images.load(exr)
    back = np.empty(N * N * 4, np.float32)
    loaded.pixels.foreach_get(back)
    back = back.reshape(N, N, 4)[::-1, :, 0]
    check(tuple(loaded.size) == (N, N) and np.allclose(back, rows, atol=1e-5), "EXR heightmap does not match the mesh")
    bpy.data.images.remove(loaded)

    path = os.path.join(folder, "terrain.glb")
    bpy.ops.object.select_all(action='DESELECT')
    obj.select_set(True)
    check(bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True) == {'FINISHED'}, "glTF export failed")
    for item in list(bpy.data.objects):
        bpy.data.objects.remove(item)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [item for item in bpy.data.objects if item.type == 'MESH']
    check(len(meshes) == 1 and abs(meshes[0].dimensions.x - SIZE) < 0.01 and abs(meshes[0].dimensions.z - float(np.ptp(rows))) < 0.01,
          "reimported terrain differs")


folder = tempfile.mkdtemp(prefix="wasd-smoke-ant-")
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
