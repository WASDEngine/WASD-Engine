"""Smoke test for the wasd-bake-blender catalog entry (WASD Bake 1.0.0 on bpy 5.2.3). Assumes the extension is enabled.

Bakes a crate of two node materials, one of them metal, into images and one material; bakes a bumpy ball onto a
smooth one of few faces, twice; bakes occlusion into vertex colors; and exports each to a .glb, checking what each
function returns, what the images hold, and what the files carry. A second bake of a baked crate and a color bake of a
material without a Principled BSDF are refused, a second bake onto the ball bakes every map of the first again, a ball
that textures() baked keeps its own colors under the detail's relief and takes the detail's creases on them once, and
the occlusion of one object goes into no material that another object without it shows, while objects baked one after
another share one copy. Every function restores the scene's bake settings, a bake that fails leaves its object as it
was, at the limit of UV maps too, where one that does not lays the earlier bake's map out anew, and a folder gets the
darkened colors while the material keeps the color as it baked packed. A model whose material takes its color from its
vertex colors, through a node group too, is refused occlusion in vertex colors, and one whose vertex colors only mask
its color is not.
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


def color0(path, obj):
    """The red of each vertex color that the object's .glb carries as COLOR_0, the one Godot multiplies into the color."""
    export([obj], path)
    with open(path, "rb") as source:
        data = source.read()
    length = struct.unpack("<I", data[12:16])[0]
    scene = json.loads(data[20:20 + length])
    binary = data[20 + length + 8:]
    accessor = scene["accessors"][scene["meshes"][0]["primitives"][0]["attributes"]["COLOR_0"]]
    view = scene["bufferViews"][accessor["bufferView"]]
    kind, size, scale = {5126: ("f", 4, 1.0), 5123: ("H", 2, 65535.0), 5121: ("B", 1, 255.0)}[accessor["componentType"]]
    stride = view.get("byteStride", size * {"VEC3": 3, "VEC4": 4}[accessor["type"]])
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    return [struct.unpack_from("<" + kind, binary, start + index * stride)[0] / scale for index in range(accessor["count"])]


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
    # The scene's own bake settings, which every function sets for its bake and restores afterwards; textures() and
    # from_high() bake images under a target of vertex colors all the same.
    settings = bpy.context.scene.render.bake
    settings.margin, settings.use_selected_to_active, settings.target = 5, True, "VERTEX_COLORS"
    own = lambda: (settings.margin, settings.use_selected_to_active, settings.target)

    clear()
    box = crate("Crate")
    done = bake.textures(box, size=256, maps=("color", "roughness", "metallic", "normal", "ao"), folder=folder)
    check(own() == (5, True, "VERTEX_COLORS"), f"textures() left the bake settings at {own()}")
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
    # The color as it baked, before its creases darkened it, stays in the material for a later from_high() and out of the file.
    pictures = [image.get("name") for image in written.get("images", [])]
    check(len(pictures) >= 2 and "Crate_color_clean" not in pictures, f"crate.glb carries the images {pictures}")
    # Its own materials are gone: a second bake would bake its images over again, darker in the creases, so it is
    # refused, images alone too, with the way back, and the crate keeps the images of its bake.
    for replace in (True, False):
        try:
            bake.textures(box, size=64, maps=("color", "ao"), replace_materials=replace)
            check(False, f"a second bake of a baked crate with replace_materials={replace} raised no error")
        except bake.BakeError as error:
            check("Crate_baked" in str(error) and "checkpoint" in str(error), f"the refusal of a second bake: {error}")
    shown = sorted(node.image.name for node in box.data.materials[0].node_tree.nodes if node.type == "TEX_IMAGE" and node.image)
    check(shown == ["Crate_color", "Crate_color_clean", "Crate_metallic", "Crate_normal", "Crate_roughness"], f"after the refused bake the crate shows {shown}")

    # A model with image textures already: its own UV map is kept.
    kept = crate("Kept")
    kept.data.uv_layers[0].name = "Mine"
    bake.textures(kept, size=64, maps=("color",), unwrap=False)
    check([layer.name for layer in kept.data.uv_layers][0] == "Mine", "unwrap=False replaced the object's UV map")

    # The color map holds a Principled BSDF's Base Color: a material built on another shader is refused, untouched.
    clay = bpy.data.materials.new("Clay")
    for node in [node for node in clay.node_tree.nodes if node.type == "BSDF_PRINCIPLED"]:
        clay.node_tree.nodes.remove(node)
    diffuse = clay.node_tree.nodes.new("ShaderNodeBsdfDiffuse")
    clay.node_tree.links.new(diffuse.outputs["BSDF"], next(node for node in clay.node_tree.nodes if node.type == "OUTPUT_MATERIAL").inputs["Surface"])
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(4.0, 0.0, 0.0))
    pot = bpy.context.active_object
    pot.data.materials.append(clay)
    try:
        bake.textures(pot, size=64, maps=("color",))
        check(False, "a color bake of a Diffuse BSDF material raised no error")
    except bake.BakeError as error:
        check("Clay" in str(error) and [layer.name for layer in pot.data.uv_layers] == ["UVMap"], f"the refused color bake: {error}")

    # A bake that fails, here of an object that renders nothing, leaves the object as it was: its UV maps, the one
    # that is active and the one that renders, no material where it had none, and no images.
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(8.0, 0.0, 0.0))
    ghost = bpy.context.active_object
    ghost.data.uv_layers[0].name = "Mine"
    ghost.data.uv_layers.new(name="Second")
    ghost.data.uv_layers.active = ghost.data.uv_layers["Second"]
    ghost.hide_render = True
    state = lambda: ([(layer.name, layer.active, layer.active_render) for layer in ghost.data.uv_layers], len(ghost.data.materials),
                     sorted(material.name for material in bpy.data.materials), sorted(image.name for image in bpy.data.images))
    before = state()
    try:
        bake.textures(ghost, size=64, maps=("color", "ao"))
        check(False, "a bake of an object that renders nothing raised no error")
    except RuntimeError:
        check(state() == before and own() == (5, True, "VERTEX_COLORS"), f"a failed bake left {state()} where there was {before}, and the bake settings at {own()}")

    # A model with as many UV maps as a mesh can have, one of them an earlier images-only bake's, laid out otherwise
    # than a new unwrap would: a bake that fails leaves every map as it was, and one that does not lays that map out anew.
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(12.0, 0.0, 0.0))
    full = bpy.context.active_object
    bake.textures(full, size=16, maps=("roughness",), replace_materials=False)
    for loop in full.data.uv_layers["WasdBake"].uv:
        loop.vector = loop.vector * 0.5
    while full.data.uv_layers.new(name=f"Extra{len(full.data.uv_layers)}") is not None:
        pass
    layouts = lambda: [(layer.name, layer.active, layer.active_render, round(sum(sum(loop.vector) for loop in layer.uv), 4)) for layer in full.data.uv_layers]
    before = layouts()
    full.hide_render = True
    try:
        bake.textures(full, size=16, maps=("roughness",), replace_materials=False)
        check(False, "a bake of an object that renders nothing raised no error")
    except RuntimeError:
        check(layouts() == before, f"a failed bake at the limit of UV maps left {layouts()} where there was {before}")
    full.hide_render = False
    try:
        bake.textures(full, size=16, maps=("roughness",), replace_materials=False)
        check([layer[0] for layer in layouts()] == [layer[0] for layer in before] and layouts()[1][3] != before[1][3],
              f"a bake at the limit of UV maps left {layouts()} where there was {before}")
    except bake.BakeError as error:
        check(False, f"a bake at the limit of UV maps was refused: {error}")

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
    # A second bake with another extrusion: the maps that it leaves out come again from the detailed ball.
    again = bake.from_high(low, high, size=128, maps=("normal",), extrusion=0.12)
    shown = sorted(node.image.name for node in low.data.materials[0].node_tree.nodes if node.type == "TEX_IMAGE" and node.image)
    check(sorted(again["images"]) == ["ao", "color", "metallic", "normal"] and shown == ["Low_color", "Low_metallic", "Low_normal"]
          and [layer.name for layer in low.data.uv_layers] == ["WasdBake"] and again["material"] == "Low_baked" and again.get("kept") == [],
          f"a second bake onto the low ball made {again['images']}, shows {shown}, and left the UV maps {[layer.name for layer in low.data.uv_layers]}")
    tone = pixels(bpy.data.images["Low_color"])
    tone = tone[tone.sum(axis=1) > 0.05].mean(axis=0)
    check(tone[0] > tone[2] * 1.5 and tone[0] > 0.6, f"after a second bake the low ball has the color {tone.round(3)}")
    # A ball that textures() baked from its own red keeps that color and its roughness under the relief of a detailed
    # ball whose material, of no Principled BSDF, a color bake would refuse: nothing bakes a color from it. The detailed
    # ball's creases darken that red as they darken a color baked from it, from the red as it baked, so that a second
    # bake, which bakes them again, darkens it no further. Both bakes save into the folder, where the darkened red takes
    # the place of the red as it baked, which the material keeps packed.
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.52)
    red = bpy.context.active_object
    red.name = "Red"
    bpy.ops.object.shade_smooth()
    red_paint = bpy.data.materials.new("RedPaint")
    next(node for node in red_paint.node_tree.nodes if node.type == "BSDF_PRINCIPLED").inputs["Base Color"].default_value = (0.8, 0.05, 0.05, 1.0)
    red.data.materials.append(red_paint)
    bake.textures(red, size=64, maps=("color", "roughness"), folder=folder)
    as_baked = pixels(bpy.data.images["Red_color"]).copy()
    high.data.materials[0] = clay
    try:
        relief = bake.from_high(red, high, size=64, maps=("normal", "ao"), folder=folder, extrusion=0.1)
    except bake.BakeError as error:
        relief = {"kept": None, "images": {}, "range": {"normal": (0.5, 0.5)}, "error": str(error)}
    shown = {node.name: node.image for node in red.data.materials[0].node_tree.nodes if node.type == "TEX_IMAGE" and node.image}
    tone = pixels(bpy.data.images["Red_color"])
    tone = tone[tone.sum(axis=1) > 0.05].mean(axis=0)
    check(relief.get("kept") == ["color", "roughness"] and sorted(relief["images"]) == ["ao", "color", "normal", "roughness"] and tone[0] > tone[1] * 3.0
          and relief["range"]["normal"][0] < 0.45 and relief["range"].get("ao", (1.0,))[0] < 0.9 and "wasd_color_clean" in shown,
          f"textures() and then from_high() kept {relief.get('kept')}, made {relief['images']} of the ranges {relief['range']}, and left the color "
          f"{tone.round(3)} and the images {sorted(image.name for image in shown.values())} {relief.get('error', '')}")
    if "wasd_color_clean" in shown:
        darkened = pixels(shown["wasd_map_color"])
        expected = pixels(shown["wasd_color_clean"]) * (0.3 + 0.7 * pixels(bpy.data.images[relief["images"]["ao"]])[:, :1])
        check(float(abs(darkened - expected).max()) < 0.02 and float((pixels(shown["wasd_color_clean"]) - darkened).max()) > 0.05,
              f"the detail's creases darken the red by up to {float((pixels(shown['wasd_color_clean']) - darkened).max()):.3f}, "
              f"{float(abs(darkened - expected).max()):.3f} off the red as it baked times the occlusion")
        # The folder's Red_color.png is the darkened red, and the red as it baked, which a .blend saved now and opened
        # again reads from what is packed, is as it baked.
        written = bpy.data.images.load(relief["files"]["color"], check_existing=False) if "color" in relief.get("files", {}) else None
        clean = shown["wasd_color_clean"]
        if clean.packed_file is not None:
            with open(os.path.join(folder, "red_clean.png"), "wb") as file:
                file.write(clean.packed_file.data)
        reopened = bpy.data.images.load(os.path.join(folder, "red_clean.png"), check_existing=False) if clean.packed_file is not None else None
        check(written is not None and float(abs(pixels(written) - darkened).max()) < 0.01 and reopened is not None
              and float(abs(pixels(reopened) - as_baked).max()) < 0.01,
              f"from_high() saved {sorted(relief.get('files', {}))} into the folder, and the red as it baked is packed: {clean.packed_file is not None}")
        again = bake.from_high(red, high, size=64, maps=("normal",), extrusion=0.1)
        twice = pixels(bpy.data.images["Red_color"])
        check(sorted(again["images"]) == ["ao", "color", "normal", "roughness"] and float(abs(twice - darkened).max()) < 0.02,
              f"a second bake made {sorted(again['images'])} and moved the red by {float(abs(twice - darkened).max()):.3f}")
    check(own() == (5, True, "VERTEX_COLORS"), f"from_high() left the bake settings at {own()}")

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
    check(own() == (5, True, "VERTEX_COLORS"), f"vertex_ao() left the bake settings at {own()}")
    written = export([ball], os.path.join(folder, "ball.glb"))
    attributes = written["meshes"][0]["primitives"][0]["attributes"]
    check("COLOR_0" in attributes, f"ball.glb carries the attributes {sorted(attributes)}")
    # A second bake that fails leaves the occlusion of the first as it was.
    occlusion = lambda: ([attribute.name for attribute in ball.data.color_attributes], [tuple(entry.color) for entry in ball.data.color_attributes["Occlusion"].data])
    before = occlusion()
    ball.hide_render = True
    try:
        bake.vertex_ao(ball, samples=4)
        check(False, "a vertex occlusion bake of an object that renders nothing raised no error")
    except RuntimeError:
        check(occlusion() == before, f"a failed vertex occlusion bake left the attributes {occlusion()[0]} and changed the occlusion: {occlusion()[1] != before[1]}")
    ball.hide_render = False
    # Two objects of one material: the one whose occlusion is baked gets a copy, and the other, which has no such
    # attribute, keeps the material as it was.
    paint = bpy.data.materials.new("Paint")
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(4.0, 0.0, 0.5))
    near = bpy.context.active_object
    near.data.materials.append(paint)
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(8.0, 0.0, 0.5))
    far = bpy.context.active_object
    far.data.materials.append(paint)
    bpy.ops.mesh.primitive_cone_add(location=(12.0, 0.0, 0.5))
    third = bpy.context.active_object
    third.data.materials.append(paint)
    bake.vertex_ao(near, samples=4)
    bake.vertex_ao(third, samples=4)
    marked = lambda material: any(node.name == "wasd_vertex_ao" for node in material.node_tree.nodes)
    check(far.data.materials[0] == paint and not marked(paint) and near.data.materials[0] != paint and marked(near.data.materials[0])
          and third.data.materials[0] == near.data.materials[0],
          f"vertex_ao on two of three objects of one material left them {[obj.data.materials[0].name for obj in (near, far, third)]}")

    # A model painted with vertex colors, which its material takes its color from, here through a node group: a glTF
    # file carries one vertex color, the paint, so occlusion in a second one would not reach the game. vertex_ao()
    # refuses it and changes nothing. Paint that only picks between two colors, as a mask, is no vertex color of the
    # file's: there the occlusion is, and vertex_ao() bakes it.
    def painted_ball(label, x):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, location=(x, 0.0, 0.5))
        obj = bpy.context.active_object
        obj.name = label
        for entry in obj.data.color_attributes.new("Col", "BYTE_COLOR", "CORNER").data:
            entry.color = (0.3, 0.3, 0.3, 1.0)
        obj.data.materials.append(bpy.data.materials.new(label))
        tree = obj.data.materials[0].node_tree
        return obj, tree, next(node for node in tree.nodes if node.type == "BSDF_PRINCIPLED").inputs["Base Color"]

    painted, look, base = painted_ball("VertexPaint", 16.0)
    group = bpy.data.node_groups.new("Paint", "ShaderNodeTree")
    group.interface.new_socket("Color", in_out="OUTPUT", socket_type="NodeSocketColor")
    source = group.nodes.new("ShaderNodeVertexColor")
    source.layer_name = "Col"
    group.links.new(source.outputs["Color"], group.nodes.new("NodeGroupOutput").inputs["Color"])
    holder = look.nodes.new("ShaderNodeGroup")
    holder.node_tree = group
    look.links.new(holder.outputs["Color"], base)
    try:
        bake.vertex_ao(painted, samples=4)
        check(False, "vertex_ao took a model whose material takes its color from its vertex colors in a node group")
    except bake.BakeError as error:
        check("'Col'" in str(error) and "textures()" in str(error) and [attribute.name for attribute in painted.data.color_attributes] == ["Col"]
              and len(look.nodes) == 3, f"the refusal of a painted model: {error}")
    masked, look, base = painted_ball("Masked", 20.0)
    source = look.nodes.new("ShaderNodeVertexColor")
    source.layer_name = "Col"
    pick = look.nodes.new("ShaderNodeMix")
    pick.data_type = "RGBA"
    look.links.new(source.outputs["Color"], pick.inputs["Factor"])
    pick.inputs["A"].default_value = (0.1, 0.5, 0.1, 1.0)
    pick.inputs["B"].default_value = (0.5, 0.4, 0.3, 1.0)
    look.links.new(pick.outputs["Result"], base)
    try:
        bake.vertex_ao(masked, samples=4)
        reds = color0(os.path.join(folder, "masked.glb"), masked)
        check(max(reds) > 0.6, f"the masked ball's vertex color in the file ranges over {min(reds):.2f} to {max(reds):.2f}: its paint's 0.3, not its occlusion")
    except bake.BakeError as error:
        check(False, f"vertex_ao refused a model whose vertex colors only mask its color: {error}")

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
