"""Smoke test for the wasd-bake-blender catalog entry (WASD Bake 1.0.0 on bpy 5.2.3). Assumes the extension is enabled.

Bakes a crate of two node materials, one of them metal, into images and one material; bakes a bumpy ball onto a
smooth one of few faces; bakes occlusion into vertex colors; and exports each to a .glb, checking what each function
returns, what the images hold, and what the files carry.
"""

import importlib
import json
import os
import shutil
import struct
import tempfile

import bpy
import numpy as np
import wasd_addons

ADDON_ID = "wasd-bake-blender"
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
        bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True)
    with open(path, "rb") as source:
        source.seek(12)
        length, _kind = struct.unpack("<II", source.read(8))
        return json.loads(source.read(length))


def node_material(name, base, dark, metal):
    material = bpy.data.materials.new(name)
    tree = material.node_tree
    shader = next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED")
    noise = tree.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 3.0
    ramp = tree.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*dark, 1.0)
    ramp.color_ramp.elements[1].color = (*base, 1.0)
    tree.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    tree.links.new(ramp.outputs["Color"], shader.inputs["Base Color"])
    wave = tree.nodes.new("ShaderNodeTexWave")
    wave.inputs["Scale"].default_value = 6.0
    bump = tree.nodes.new("ShaderNodeBump")
    tree.links.new(wave.outputs["Fac"], bump.inputs["Height"])
    tree.links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    shader.inputs["Roughness"].default_value = 0.7
    shader.inputs["Metallic"].default_value = metal
    return material


def crate(name):
    """A box with a lid and a knob joined into one mesh, whose leftover UV maps overlap: wood below, metal on top."""
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 0.5))
    body = bpy.context.active_object
    body.name = name
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(0, 0, 1.06))
    lid = bpy.context.active_object
    lid.scale = (1.1, 1.1, 0.12)
    bpy.ops.object.transform_apply(scale=True)
    bpy.ops.mesh.primitive_cube_add(size=0.3, location=(0.45, 0.0, 0.5))
    knob = bpy.context.active_object
    for part in (lid, knob, body):
        part.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.join()
    body.data.materials.append(node_material(name + "Wood", (0.55, 0.36, 0.18), (0.25, 0.14, 0.06), 0.0))
    body.data.materials.append(node_material(name + "Iron", (0.3, 0.32, 0.35), (0.12, 0.12, 0.14), 1.0))
    for polygon in body.data.polygons:
        polygon.material_index = 1 if polygon.center.z > 0.45 else 0
    return body


def pixels(image):
    values = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    image.pixels.foreach_get(values)
    return values.reshape(-1, 4)[:, :3]


def main(folder):
    bake = importlib.import_module(wasd_addons.enable(ADDON_ID))
    engine = bpy.context.scene.render.engine

    clear()
    box = crate("Crate")
    done = bake.textures(box, size=256, maps=("color", "roughness", "metallic", "normal", "ao"), folder=folder)
    check(done["unwrapped"] and [layer.name for layer in box.data.uv_layers] == ["WasdBake"], f"the crate's UV maps are {[layer.name for layer in box.data.uv_layers]}")
    check(len(box.data.materials) == 1 and done["materials_before"] == 2 and done["material"] == "Crate_baked", f"the crate has {len(box.data.materials)} materials after the bake")
    check(all(os.path.exists(path) and os.path.getsize(path) > 500 for path in done["files"].values()) and len(done["files"]) == 5, f"the baked files are {done['files']}")
    check(done["range"]["metallic"] == (0.0, 1.0), f"metal ranges over {done['range']['metallic']}")
    check(done["range"]["ao"][0] < 0.5 and done["range"]["ao"][1] > 0.95, f"occlusion ranges over {done['range']['ao']}")
    check(done["range"]["normal"][0] < 0.48, f"the relief ranges over {done['range']['normal']}")
    color = pixels(bpy.data.images["Crate_color"])
    metal = pixels(bpy.data.images["Crate_metallic"])[:, 0] > 0.5
    wood = pixels(bpy.data.images["Crate_metallic"])[:, 0] < 0.5
    filled = color.sum(axis=1) > 0.02
    # The metal's own color, which a diffuse bake would leave black, and the wood's: gray against brown.
    iron = color[metal & filled].mean(axis=0)
    brown = color[wood & filled].mean(axis=0)
    check(iron.min() > 0.05 and abs(iron[0] - iron[2]) < 0.05, f"the metal lid baked the color {iron.round(3)}")
    check(brown[0] > brown[2] * 1.5, f"the wood baked the color {brown.round(3)}")
    # Without occlusion in the color the image is brighter.
    clean = bake.textures(crate("Clean"), size=256, maps=("color", "ao"), ao_into_color=0.0)
    bright = pixels(bpy.data.images["Clean_color"])
    check(bright[bright.sum(axis=1) > 0.02].mean() > color[filled].mean() * 1.03, "occlusion did not darken the color image")
    check(clean["files"] == {} and bpy.data.images["Clean_color"].packed_file is not None, "images without a folder are not packed")
    check(bpy.context.scene.render.engine == engine, f"the render engine was left at {bpy.context.scene.render.engine}")
    written = export([box], os.path.join(folder, "crate.glb"))
    material = written["materials"][0]
    check(len(written["materials"]) == 1 and "baseColorTexture" in material["pbrMetallicRoughness"] and "normalTexture" in material, f"crate.glb's material is {material}")
    check(len(written.get("images", [])) >= 2, f"crate.glb carries {len(written.get('images', []))} images")

    # A model with image textures already: its own UV map is kept.
    kept = crate("Kept")
    kept.data.uv_layers[0].name = "Mine"
    bake.textures(kept, size=64, maps=("color",), unwrap=False)
    check([layer.name for layer in kept.data.uv_layers][0] == "Mine", "unwrap=False replaced the object's UV map")

    # A bumpy ball of 1,280 faces onto a smooth one of 80.
    clear()
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=0.5)
    high = bpy.context.active_object
    high.name = "High"
    texture = bpy.data.textures.new("Bumps", "VORONOI")
    texture.noise_scale = 0.25
    displace = high.modifiers.new("Displace", "DISPLACE")
    displace.texture = texture
    displace.strength = 0.08
    bpy.ops.object.modifier_apply(modifier="Displace")
    gold = bpy.data.materials.new("Gold")
    shader = next(node for node in gold.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
    shader.inputs["Base Color"].default_value = (0.8, 0.6, 0.2, 1.0)
    shader.inputs["Metallic"].default_value = 1.0
    high.data.materials.append(gold)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.52)
    low = bpy.context.active_object
    low.name = "Low"
    bpy.ops.object.shade_smooth()
    onto = bake.from_high(low, high, size=256, maps=("normal", "ao", "color", "metallic"), extrusion=0.1)
    check(onto["range"]["normal"][0] < 0.42, f"the detail's relief ranges over {onto['range']['normal']}")
    check(onto["range"]["metallic"][1] == 1.0, f"the detail's metal ranges over {onto['range']['metallic']}")
    tone = pixels(bpy.data.images["Low_color"])
    tone = tone[tone.sum(axis=1) > 0.05].mean(axis=0)
    check(tone[0] > tone[2] * 1.5 and tone[0] > 0.6, f"the low ball took the color {tone.round(3)} from a gold one")
    check(len(low.data.polygons) == 80 and len(low.data.materials) == 1, "the low ball changed shape or has more than one material")

    # Occlusion into the vertex colors of a model of many faces: a ball that rests in a bowl's hollow.
    clear()
    bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=0.5, location=(0, 0, 0.45))
    ball = bpy.context.active_object
    ball.name = "Ball"
    bpy.ops.mesh.primitive_plane_add(size=4.0)
    ground = bpy.context.active_object
    ground.select_set(True)
    ball.select_set(True)
    bpy.context.view_layer.objects.active = ball
    bpy.ops.object.join()
    shaded = bake.vertex_ao(ball)
    check(shaded["attribute"] == "Occlusion" and shaded["range"][0] < 0.6 and shaded["range"][1] > 0.9, f"vertex occlusion ranges over {shaded['range']}")
    written = export([ball], os.path.join(folder, "ball.glb"))
    attributes = written["meshes"][0]["primitives"][0]["attributes"]
    check("COLOR_0" in attributes, f"ball.glb carries the attributes {sorted(attributes)}")

    try:
        bake.textures("NoSuchObject")
        check(False, "a missing object raised no error")
    except bake.BakeError:
        pass
    try:
        bake.textures(ball, maps=("colour",))
        check(False, "an unknown map raised no error")
    except bake.BakeError:
        pass

    if failures:
        for failure in failures:
            print(f"SMOKE_FAIL {ADDON_ID}: {failure}")
    else:
        print(f"SMOKE_PASS {ADDON_ID}")


folder = tempfile.mkdtemp(prefix="wasd-bake-smoke-")
try:
    main(folder)
finally:
    shutil.rmtree(folder, ignore_errors=True)
