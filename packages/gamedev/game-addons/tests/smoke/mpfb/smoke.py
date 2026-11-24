"""Smoke test for the mpfb catalog entry (MPFB 2.0.18 on bpy 5.2.3). Assumes MPFB is enabled.

Creates humans with MPFB's HumanService, adds the game_engine skeleton, bakes the body for export, decimates it,
exports a skinned .glb and imports it back. Then dresses a human from the MakeHuman system assets that WASD Engine
installs with MPFB (low-poly proxy, skin, eyes, hair, clothes), exports and reimports it, and checks that MPFB still
reads the pack after factory settings reset its preferences. In between it gives a dressed human a face with
wasd_mpfb.add_face: shape keys on the proxy and the eyelashes that survive the export, two eye bones, and the inside
of a mouth, a dark pocket on the rim of the proxy's mouth with two rows of teeth and a tongue that open with it. And
it makes humans with wasd_mpfb.human, the way the guide teaches: skin within what skin has and a picture of its
hollows, eyes painted for the eye model without its shell, ivory teeth that fall dark toward the back, lashes and a
hairline that thin out, hair that hangs from head and spine, 15 face shapes made on its own face, a jaw that takes
the lower teeth with it and leaves the upper ones on the skull, a smile that reaches the eyes and leans to one side,
a normal map of the face's folds with the marks of where they lie, and an export that carries all of it; a face that
measures what good-looking faces measure where MakeHuman's own does not, with brows painted for it, a groomed
skin, and hair that stands off the skull; a twelve-year-old's face of a size for its age; a human for a crowd on the
low-poly proxy; refusals that name what is taken, before anything is made; a body other than MakeHuman's base mesh
refused a face; and a human that fails halfway leaving nothing in the scene.
"""

import importlib
import json
import math
import os
import shutil
import struct
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
    # A face is built from the helper geometry, which is gone now: add_face says what to call it in place of.
    import wasd_mpfb
    try:
        wasd_mpfb.add_face(basemesh)
        check(False, "add_face took a body without its helper geometry")
    except ValueError as error:
        check("bake_modifiers_remove_helpers" in str(error), "the refusal of a baked body does not name the call it replaces: %s" % error)

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


def faced(folder):
    """Give a dressed human a face, export it, and check that the reimported character can blink, speak, and look."""
    import wasd_addons
    import wasd_mpfb  # registered by the entry's setup.py when the worker enabled MPFB

    assets = wasd_addons.assets(ADDON_ID)
    package = next(a.module for a in bpy.context.preferences.addons if a.module.split(".")[-1] == "mpfb")
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
    eyes = part("eyes/low-poly/low-poly.mhclo", "Eyes")
    lashes = part("eyelashes/eyelashes01/eyelashes01.mhclo", "Eyelashes")
    suit = part("clothes/male_casualsuit01/male_casualsuit01.mhclo", "Clothes")
    try:
        wasd_mpfb.add_face(body, shapes=["wink"])
        check(False, "add_face took a shape it does not have")
    except ValueError as error:
        check("blink_l" in str(error), "the refusal of an unknown shape does not name the shapes: %s" % error)
    # The face is read by the numbers of the base mesh's vertices: a mesh of another count is refused before it is shaped.
    import bmesh
    other = HumanService.create_human()
    data = bmesh.new()
    data.from_mesh(other.data)
    data.verts.ensure_lookup_table()
    bmesh.ops.delete(data, geom=[data.verts[len(data.verts) - 1]], context='VERTS')
    data.to_mesh(other.data)
    data.free()
    shaped = list(other.data.shape_keys.key_blocks.keys()) if other.data.shape_keys else []
    try:
        wasd_mpfb.add_face(other)
        check(False, "add_face took a mesh of %d vertices" % len(other.data.vertices))
    except ValueError as error:
        check("19,158" in str(error) and (list(other.data.shape_keys.key_blocks.keys()) if other.data.shape_keys else []) == shaped,
              "the refusal of another mesh: %s" % error)
    bpy.data.objects.remove(other)
    report = wasd_mpfb.add_face(body)
    names = list(wasd_mpfb.FACE_SHAPES)
    check(report["shapes"] == names and len(names) == 15 and report["eye_bones"] == ["eye_l", "eye_r"], "add_face reported %s" % report)

    def keys(obj):
        return [key.name for key in obj.data.shape_keys.key_blocks][1:] if obj.data.shape_keys else []

    def reach(obj, name):
        """How far a shape key moves its mesh at most, in meters."""
        blocks = obj.data.shape_keys.key_blocks
        return max((key.co - rest.co).length for key, rest in zip(blocks[name].data, blocks["Basis"].data))

    check(keys(body) == names and keys(proxy) == names, "the body has %s and the proxy %s" % (keys(body), keys(proxy)))
    # The eyelashes take the shapes that move the lids: the blinks, and every feeling, each of which narrows or
    # widens the eyes. The shapes of speech and of the brows alone leave them where they are.
    lids = [name for name in names if not name.startswith(("mouth_", "brows_"))]
    check(keys(lashes) == lids and keys(suit) == [] and keys(eyes) == [],
          "eyelashes %s, suit %s, eyes %s" % (keys(lashes), keys(suit), keys(eyes)))
    check(0.012 < reach(proxy, "mouth_open") < 0.05 and 0.004 < reach(proxy, "blink_l") < 0.02 and reach(proxy, "smile") < 0.03,
          "the proxy's mouth opens %.3f m and its lid closes %.3f m" % (reach(proxy, "mouth_open"), reach(proxy, "blink_l")))
    # The suit's mask hid the skin under it; applied, the proxy lost those vertices and kept its shape keys.
    inside = report["mouth"]
    check(not any(m.type == 'MASK' for m in proxy.modifiers) and len(proxy.data.vertices) - inside["vertices"] < 741,
          "the proxy still has %d vertices and the modifiers %s" % (len(proxy.data.vertices), [m.type for m in proxy.modifiers]))
    # The proxy's mouth is a hole in a shell: it got a dark pocket on the hole's own rim, the base mesh's two rows
    # of helper teeth, 68 vertices each, and a tongue of 26.
    kinds = [slot.material.name.split(".")[1] for slot in proxy.material_slots]
    check(inside == {"mesh": proxy.name, "vertices": 175} and kinds == ["body", "mouth_dark", "mouth_white", "mouth_pink"], "the mouth's inside is %s with the materials %s" % (inside, kinds))
    faces = {kind: [polygon for polygon in proxy.data.polygons if polygon.material_index == kinds.index(kind)] for kind in kinds}
    used = {kind: {index for polygon in faces[kind] for index in polygon.vertices} for kind in kinds}
    check(len(faces["mouth_dark"]) == 24 and len(used["mouth_dark"] & used["body"]) == 12 and len(faces["mouth_white"]) == 96 and len(faces["mouth_pink"]) == 32
          and not (used["mouth_white"] | used["mouth_pink"]) & used["body"],
          "the pocket has %d faces and shares %d vertices with the lips; the teeth have %d faces and the tongue %d"
          % (len(faces["mouth_dark"]), len(used["mouth_dark"] & used["body"]), len(faces["mouth_white"]), len(faces["mouth_pink"])))
    blocks = proxy.data.shape_keys.key_blocks

    def drops(indices):
        """How far opening the mouth lowers vertices, the least and the most, in meters."""
        fallen = [blocks["Basis"].data[index].co.z - blocks["mouth_open"].data[index].co.z for index in indices]
        return min(fallen), max(fallen)

    # The upper row was made before the lower one. Both stand shortened in a shut mouth and whole in an open one,
    # where they also reach a little past the lips; the lower row and the tongue go down with the jaw besides.
    rows = sorted(used["mouth_white"])
    upper, lower, tongue = drops(rows[:68]), drops(rows[68:]), drops(used["mouth_pink"])
    # The back teeth of the lower row hardly go down, as a jaw turns about its joint, and grow a little higher.
    check(0.002 < upper[0] and upper[1] < 0.012 and lower[0] > -0.008 and lower[1] > upper[1] + 0.003 and tongue[1] > 0.006,
          "opening the mouth lowers the upper teeth by %.3f to %.3f m, the lower ones by %.3f to %.3f m, and the tongue by %.3f to %.3f m"
          % (upper + lower + tongue))
    rest_top = max(blocks["Basis"].data[index].co.z for index in used["mouth_pink"])
    check(rest_top < min(blocks["Basis"].data[index].co.z for index in used["mouth_dark"]),
          "the tongue's top lies at %.3f m in a shut mouth, not under the pocket" % rest_top)
    check(not any(m.type == 'MASK' for m in body.modifiers) and len(body.data.vertices) < 13380, "the body kept its masks")
    bones = rig.data.bones
    check(len(bones) == 55 and all(bones[name].parent.name == "head" for name in ("eye_l", "eye_r")), "the rig has %d bones" % len(bones))
    check(bones["eye_l"].head_local.x > 0.02 > -0.02 > bones["eye_r"].head_local.x and bones["eye_l"].tail_local.y < bones["eye_l"].head_local.y,
          "the eye bones are at %s and %s" % (tuple(bones["eye_l"].head_local), tuple(bones["eye_r"].head_local)))
    check(sorted(group.name for group in eyes.vertex_groups) == ["eye_l", "eye_r"], "the eyes hang on %s" % [g.name for g in eyes.vertex_groups])
    path = os.path.join(folder, "mpfb_faced.glb")
    bpy.ops.object.select_all(action='DESELECT')
    for obj in [rig, proxy, eyes, lashes, suit]:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = rig
    result = bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_apply=True)
    check(result == {'FINISHED'} and os.path.isfile(path), "glTF export of the human with a face failed: %s" % result)
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj)
    bpy.ops.import_scene.gltf(filepath=path)
    armature = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    shaped = sorted(len(keys(o)) for o in bpy.data.objects if o.type == 'MESH' and keys(o))
    check(len(armature.data.bones) == 55 and shaped == [len(lids), 15], "the reimported human has %d bones and shape keys on %s" % (len(armature.data.bones), shaped))


def natural(folder):
    """Make humans with wasd_mpfb.human, give one a face, export them, and check what makes a face fit to be seen."""
    import numpy
    import wasd_mpfb

    def clear():
        for obj in list(bpy.data.objects):
            bpy.data.objects.remove(obj)

    def pixels(image):
        """A picture's rows of RGBA, top row first."""
        values = numpy.empty(image.size[0] * image.size[1] * 4, dtype=numpy.float32)
        image.pixels.foreach_get(values)
        return values.reshape(image.size[1], image.size[0], 4)[::-1]

    def picture(obj):
        return next(node.image for node in obj.material_slots[0].material.node_tree.nodes
                    if node.type == 'TEX_IMAGE' and node.image is not None and node.outputs["Color"].is_linked)

    def face_tone(body):
        """The middle color of the face in the skin's picture, as its lightness and its saturation."""
        shown = pixels(picture(body))
        height, width = shown.shape[:2]
        middle = numpy.median(shown[int(0.40 * height):int(0.62 * height), int(0.78 * width):int(0.88 * width), :3].reshape(-1, 3), axis=0)
        light = numpy.where(middle <= 0.04045, middle / 12.92, ((middle + 0.055) / 1.055) ** 2.4)
        return float((light * numpy.array((0.2126, 0.7152, 0.0722))).sum()), float((middle.max() - middle.min()) / middle.max())

    def worn(body, word):
        return next((child for child in body.parent.children
                     if child.type == 'MESH' and child is not body and child.material_slots and word in child.material_slots[0].material.name), None)

    def colors(obj, channel=3):
        layer = obj.data.color_attributes.get("Color")
        return [entry.color[channel] for entry in layer.data] if layer is not None else []

    def face(body):
        """A face's measures in mm, from the base mesh's vertices at its landmarks: between the pupils, across the
        mouth, how far at most one side's landmarks (the eye's corners and lid, the mouth's corner, the nose's wing,
        the jaw) lie from where the other side's would be in a mirror, how much of the iris's upper half the upper
        lid covers, how far the mouth's corner lies above the middle of the line where the lips meet, how high the
        upper lip's red is two thirds of the way to that corner, as a share of its height in the middle, and how wide
        the jaw is below the mouth, as a share of the cheeks' width."""
        spots = [vertex.co for vertex in body.data.vertices]
        groups = {group.name: group.index for group in body.vertex_groups}

        def middle(name):
            mine = [spot for vertex, spot in zip(body.data.vertices, spots) if any(entry.group == groups[name] for entry in vertex.groups)]
            return [sum(spot[axis] for spot in mine) / len(mine) for axis in range(3)], max(spot.x for spot in mine) - min(spot.x for spot in mine)

        def mirrored(index):
            there = spots[index]
            return min(range(len(spots)), key=lambda other: (spots[other].x + there.x) ** 2 + (spots[other].y - there.y) ** 2 + (spots[other].z - there.z) ** 2)

        (left, width), (right, _) = middle("helper-l-eye"), middle("helper-r-eye")
        # The iris's radius, as the guide's eyes are painted: 0.375 of a ball that is a twentieth larger than its helper,
        # and 6.15 mm at most on a face whose pupils are 62 mm apart.
        iris = min(0.375 * 1.048 * width / 2.0, 6.15 * (left[0] - right[0]) / 62.0)
        lopsided = max(abs(spots[index].x + spots[mirrored(index)].x) + abs(spots[index].z - spots[mirrored(index)].z) for index in (6850, 6805, 6785, 7192, 7102, 7459))
        return {"pupils": (left[0] - right[0]) * 1000.0, "mouth": (spots[7192].x - spots[mirrored(7192)].x) * 1000.0,
                "lopsided": lopsided * 1000.0, "lid": (iris - (spots[6785].z - left[2])) / iris,
                "corner": (spots[7192].z - spots[474].z) * 1000.0,
                "taper": (spots[11943].z - spots[7225].z) / max(spots[362].z - spots[474].z, 1e-6),
                "jaw": (spots[7459].x - spots[mirrored(7459)].x) / (spots[12362].x - spots[mirrored(12362)].x)}

    clear()
    # Every argument is checked before anything is made: a refusal leaves the scene empty.
    for call, word in ((lambda: wasd_mpfb.human(gender="other"), "female"), (lambda: wasd_mpfb.human(eyes="purple"), "hazel"),
                       (lambda: wasd_mpfb.human(hair="no_such_hair"), "long01"), (lambda: wasd_mpfb.human(hair_color="pink"), "auburn"),
                       (lambda: wasd_mpfb.human(detail="medium"), "low"), (lambda: wasd_mpfb.human(ethnicity="martian"), "asian"),
                       (lambda: wasd_mpfb.human(outfit=("male_casualsuit1",)), "male_casualsuit01"), (lambda: wasd_mpfb.human(seed=1.5), "integer"),
                       (lambda: wasd_mpfb.human(age=8), "12 to 90"), (lambda: wasd_mpfb.human(build={"age": 0.2}), "muscle"),
                       (lambda: wasd_mpfb.human(ethnicity={"asian": 0}), "share"), (lambda: wasd_mpfb.human(rig="unreal"), "game_engine")):
        try:
            call()
            check(False, "human() took an argument it does not know")
        except ValueError as error:
            check(word in str(error) and not bpy.data.objects, "a refusal does not name what is taken, or comes after a body was made: %s" % error)
        clear()

    body = wasd_mpfb.human("female", age=27, eyes="hazel", hair_color="brown", seed=3)
    rig = body.parent
    if not check(rig is not None and rig.type == 'ARMATURE' and len(rig.data.bones) == 53, "human() made no body on the game skeleton"):
        return
    eyes, hair, teeth, tongue = worn(body, ".eyes_hazel"), worn(body, ".hair_long01"), worn(body, "teeth"), worn(body, "tongue")
    brows, lashes, suit = worn(body, "eyebrow"), worn(body, "eyelashes"), worn(body, "casualsuit")
    if not check(None not in (eyes, hair, teeth, tongue, brows, lashes, suit), "a human lacks one of eyes, hair, teeth, tongue, brows, lashes, and clothes"):
        return
    # The face measures what a good-looking woman's does: pupils 62 mm apart and a mouth 49 mm wide, give or take
    # what one face differs from the next, under lids that cover a quarter of the iris's upper half; and it is not
    # its own mirror image.
    fair = face(body)
    check(58.5 < fair["pupils"] < 65.5 and 45.0 < fair["mouth"] < 54.0 and 0.12 < fair["lid"] < 0.42,
          "a woman's pupils are %.1f mm apart, her mouth is %.1f mm wide, and her lids cover %.2f of the iris's upper half" % (fair["pupils"], fair["mouth"], fair["lid"]))
    check(0.05 < fair["lopsided"] < 2.5, "one side of the face lies %.3f mm from the other's mirror image at most" % fair["lopsided"])
    # Its mouth does not hang at the corners, nor smirk, its upper lip tapers to them, and its jaw tapers under its cheeks.
    check(-0.7 < fair["corner"] < 2.2 and 0.35 < fair["taper"] < 0.7 and 0.64 < fair["jaw"] < 0.75,
          "the mouth's corners lie %.2f mm above its middle, the upper lip is %.2f of its height two thirds of the way to them, and the jaw is %.2f as wide as the cheeks"
          % (fair["corner"], fair["taper"], fair["jaw"]))
    # Its hair stands off the skull, and its brows are its own: painted hair by hair in the hair's color.
    crown = max(vertex.co.z for vertex in body.data.vertices if any(entry.group == body.vertex_groups["scalp"].index for entry in vertex.groups))
    lifted = max((hair.matrix_world @ vertex.co).z for vertex in hair.data.vertices) - crown
    check(0.008 < lifted < 0.03, "the hair stands %.4f m off the crown" % lifted)
    drawn = pixels(picture(brows))
    covered = float((drawn[..., 3] > 0.3).mean())
    check(picture(brows).name.endswith(".brows") and 0.02 < covered < 0.25 and float(drawn[..., 3].max()) > 0.9,
          "the brows' picture is %s, and %.3f of it is brow" % (picture(brows).name, covered))
    # The eyes: two balls of 276 vertices without their shells, and a picture painted for them, whose irises are not
    # MakeHuman's red and whose pupils are dark.
    painted = pixels(picture(eyes))
    red = float(((painted[..., 0] > 0.45) & (painted[..., 1] < 0.2)).mean())
    dark = float((painted[..., :3].sum(-1) < 0.15).mean())
    check(len(eyes.data.vertices) == 552 and painted.shape[0] == 1024 and red < 0.001 and dark > 0.0005,
          "the eyes have %d vertices, and their %d px picture is %.4f red and %.4f dark" % (len(eyes.data.vertices), painted.shape[0], red, dark))
    # The skin: toned by the face, and with a second picture whose red tells of the face's hollows, which the glTF
    # exporter finds as the material's occlusion.
    lightness, saturation = face_tone(body)
    check(0.2 < lightness < 0.43 and 0.3 < saturation < 0.6, "a fair face's middle color has the lightness %.3f and the saturation %.3f" % (lightness, saturation))
    material = body.material_slots[0].material
    group = next((node for node in material.node_tree.nodes if node.type == 'GROUP' and node.node_tree is not None and node.node_tree.name == "glTF Material Output"), None)
    if check(group is not None and group.inputs["Occlusion"].is_linked, "the skin has no picture of its hollows, or the exporter is not told of it"):
        # The picture's red reaches the exporter through the node that takes its channels apart.
        shade = group.inputs["Occlusion"].links[0].from_node.inputs[0].links[0].from_node.image
        openness = pixels(shade)[..., 0]
        check(float(openness.min()) < 0.6 and float(openness.max()) > 0.99 and 0.5 < float(openness.mean()) < 0.99,
              "the skin's hollows are open by %.2f to %.2f, %.2f in the middle" % (openness.min(), openness.max(), openness.mean()))
    # The teeth: ivory, none of the photograph's gray and black, and dark toward the back by their vertices' color,
    # as the tongue is.
    bite = pixels(picture(teeth))
    most, least = bite[..., :3].max(-1), bite[..., :3].min(-1)
    tooth = ((most - least) / numpy.maximum(most, 1e-4) < 0.15) & (bite[..., 3] > 0.5)
    check(tooth.mean() > 0.05 and float(most[tooth].min()) > 0.4 and float(numpy.median(most[tooth])) > 0.7,
          "the teeth's picture is %.2f at its darkest and %.2f in the middle" % (most[tooth].min(), numpy.median(most[tooth])))
    check(colors(teeth, 0) and min(colors(teeth, 0)) < 0.5 and max(colors(teeth, 0)) > 0.95 and colors(tongue, 0) and min(colors(tongue, 0)) < 0.5,
          "the mouth does not fall dark toward its back")
    # Lashes thin out toward their tips and hair along its hairline; hair hangs from the head, the neck, and the
    # spine alone, and brows are darker than the hair.
    check(colors(lashes) and min(colors(lashes)) < 0.2 and max(colors(lashes)) > 0.8, "the lashes are as solid at their tips as at the lid")
    check(colors(hair) and min(colors(hair)) < 0.2 and max(colors(hair)) == 1.0 and min(colors(hair, 0)) == 1.0, "the hair has no hairline that thins out, or is not straight")
    weighted = {hair.vertex_groups[entry.group].name for vertex in hair.data.vertices for entry in vertex.groups if entry.weight > 0.01}
    check(weighted and all(name in ("head", "neck_01") or name.startswith("spine") for name in weighted), "the hair hangs on %s" % sorted(weighted))

    def tone(obj):
        shown = pixels(picture(obj))
        return float(numpy.median(shown[..., :3][shown[..., 3] > 0.5].max(-1)))

    check(tone(brows) < 0.45, "the brows (%.2f) are fair beside hair of %.2f" % (tone(brows), tone(hair)))

    report = wasd_mpfb.add_face(body)
    names = list(wasd_mpfb.FACE_SHAPES)

    def keys(obj):
        return [key.name for key in obj.data.shape_keys.key_blocks][1:] if obj.data.shape_keys else []

    check(report["shapes"] == names and keys(body) == names and report["eye_bones"] == ["eye_l", "eye_r"] and len(rig.data.bones) == 55
          and report["mouth"]["vertices"] == 0, "add_face on a human of human() reported %s" % report)
    # Teeth are hard: the upper row is the skull's and stays where it is under every shape, and the lower row turns
    # with the jaw as one piece, so no two of its points come nearer to each other or part.
    blocks = teeth.data.shape_keys.key_blocks
    rests = [entry.co.copy() for entry in blocks["Basis"].data]
    opened = [entry.co.copy() for entry in blocks["mouth_open"].data]
    turned = [index for index in range(len(rests)) if (opened[index] - rests[index]).length > 0.0003]
    still = [index for index in range(len(rests)) if (opened[index] - rests[index]).length < 1e-6]
    stretch = max(abs((opened[first] - opened[second]).length - (rests[first] - rests[second]).length) for first, second in zip(turned[::40], turned[20::40]))
    held = max((block.data[index].co - rests[index]).length for block in blocks for index in still[::25])
    check("mouth_open" in keys(teeth) and 0.4 < len(turned) / len(rests) < 0.6 and len(turned) + len(still) == len(rests)
          and min((opened[index] - rests[index]).z for index in turned) < -0.008 and stretch < 1e-5 and held < 1e-6,
          "an open mouth turns %.2f of the teeth and leaves %.2f, %.4f m down at the most; the lower row stretches by %.6f m and the upper row moves by %.6f m"
          % (len(turned) / len(rests), len(still) / len(rests), -min((opened[index] - rests[index]).z for index in turned or [0]), stretch, held))
    # The shapes are made on this face: a smile draws the mouth's corners out, back, and up, lifts the lower lids,
    # which the lashes show, and leans to one side, as no face smiles evenly; an open mouth lets the chin fall; and
    # no shape throws a vertex across the face.
    skin = body.data.shape_keys.key_blocks

    def reach(name, side=0.0):
        """How far a shape moves the body's skin at most, on one side of the face or on all of it, and that move."""
        moves = [(key.co - rest.co) for key, rest in zip(skin[name].data, skin["Basis"].data) if rest.co.x * side >= 0.0]
        return max(moves, key=lambda move: move.length)

    left, right = reach("smile", 1.0), reach("smile", -1.0)
    # The side a face leans to is drawn once and kept on the body: the face that human() set at rest and the smile
    # that add_face() made lean alike.
    check(body.get("wasd_lean") in (0.11, -0.11) and (left.length > right.length) == (body["wasd_lean"] > 0.0),
          "the face leans by %s, and its smile moves the left corner %.4f m and the right one %.4f m" % (body.get("wasd_lean"), left.length, right.length))
    check(0.006 < left.length < 0.014 and left.x > 0.003 and left.y > 0.001 and left.z > 0.003 and right.x < -0.003
          and 0.02 < abs(left.length - right.length) / left.length < 0.25 and "smile" in keys(lashes),
          "a smile draws the left corner by (%.4f, %.4f, %.4f) m and the right one %.4f m, and the lashes have %s"
          % (left.x, left.y, left.z, right.length, keys(lashes)))
    check(0.012 < reach("mouth_open").length < 0.03 and reach("mouth_open").z < -0.01 and all(reach(name).length < 0.03 for name in names),
          "an open mouth moves the chin by %.4f m, and the shapes reach %s"
          % (reach("mouth_open").length, {name: round(reach(name).length, 4) for name in names}))
    try:
        wasd_mpfb.export(body, os.path.join(folder, "mpfb_natural"))
        check(False, "export took a path without .glb")
    except ValueError as error:
        written = [name for name in os.listdir(folder) if name.startswith("mpfb_natural")]
        check(".glb" in str(error) and not written, "the refusal of a path without .glb: %s, with %s written" % (error, written))
    path = os.path.join(folder, "mpfb_natural.glb")
    made = wasd_mpfb.export(body, path)
    data = open(path, "rb").read()
    scene = json.loads(data[20:20 + struct.unpack("<I", data[12:16])[0]])
    binary = data[20 + struct.unpack("<I", data[12:16])[0] + 8:]
    targets = {mesh["name"]: len(mesh["primitives"][0].get("targets", [])) for mesh in scene["meshes"]}
    colored = sorted(mesh["name"] for mesh in scene["meshes"] if "COLOR_0" in mesh["primitives"][0]["attributes"])
    skin = next(entry for entry in scene["materials"] if ".body" in entry["name"])
    sizes = []
    for image in scene["images"]:
        view = scene["bufferViews"][image["bufferView"]]
        sizes.append(struct.unpack(">II", binary[view.get("byteOffset", 0) + 16:view.get("byteOffset", 0) + 24]))
    check(made["bones"] == 55 and 30000 < sum(made["triangles"].values()) < 50000 and made["bytes"] == len(data) < 14000000,
          "export() reported %d bones, %d triangles, and %d bytes" % (made["bones"], sum(made["triangles"].values()), made["bytes"]))
    check(max(targets.values()) == 15 and "occlusionTexture" in skin and skin.get("alphaMode", "OPAQUE") == "OPAQUE" and max(max(size) for size in sizes) == 1024
          and all(any(word in name for name in colored) for word in ("long01", "eyelashes", "teeth", "tongue")),
          "the file has %s shapes on the body, the skin %s, pictures up to %d px, and colors on %s"
          % (max(targets.values()), sorted(skin), max(max(size) for size in sizes), colored))

    # The face's folds: the skin has a normal map of their grooves at no strength, so that a material that knows
    # nothing of them shows a smooth face, and the body's second UV map marks where a smile folds the face and, in
    # fewer places, where a frown does. A game's skin presses the grooves in there as the face moves.
    grooves = skin.get("normalTexture", {})
    check(grooves.get("scale") == 0 and "index" in grooves, "the skin's normal map of the face's folds is %s" % grooves)
    marked = next(mesh["primitives"][0] for mesh in scene["meshes"] if len(mesh["primitives"][0].get("targets", [])) == 15)["attributes"]
    marks, values = [0, 0, 0], [0.0]
    if "TEXCOORD_1" in marked:
        accessor = scene["accessors"][marked["TEXCOORD_1"]]
        view = scene["bufferViews"][accessor["bufferView"]]
        start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
        values = struct.unpack("<%df" % (accessor["count"] * 2), binary[start:start + accessor["count"] * 8])
        marks = [sum(value > 0.01 for value in values[0::2]), sum(value > 0.01 for value in values[1::2]), accessor["count"]]
    check(200 < marks[0] < 900 and 20 < marks[1] < 200 and marks[2] > 5000 and min(values) >= 0.0 and max(values) <= 1.0,
          "the body marks %d of its %d vertices as where a smile folds it and %d as where a frown does" % (marks[0], marks[2], marks[1]))

    # A dark face is of a brown that skin has, not MakeHuman's rust, and curls are named so that a game lays no band of
    # light across them, with a color as white as straight hair's, which a stock material multiplies into the picture.
    # Without looks and a seed the face is MakeHuman's own: eyes too near each other, a narrow mouth, and a mirror
    # image. A named eyebrow asset brings its own picture.
    clear()
    body = wasd_mpfb.human("male", age=45, ethnicity="african", eyes="dark", hair="afro01", hair_color="black", looks=0.0, seed=None, brows="eyebrow004")
    lightness, saturation = face_tone(body)
    curls = worn(body, ".hair_afro01")
    check(0.07 < lightness < 0.2 and saturation < 0.56, "a dark face's middle color has the lightness %.3f and the saturation %.3f" % (lightness, saturation))
    check(curls is not None and curls.material_slots[0].material.name.endswith("_curly") and min(colors(curls, 0)) == 1.0
          and min(colors(curls, 2)) == 1.0, "curls are named %s and colored down to %s" % (curls and curls.material_slots[0].material.name, curls and min(colors(curls, 0))))
    plain = face(body)
    check(plain["pupils"] < 60.0 and plain["mouth"] < 48.0 and plain["lopsided"] < 0.001 and plain["corner"] < -0.7 and plain["jaw"] > 0.75,
          "MakeHuman's own face has pupils %.1f mm apart, a mouth %.1f mm wide with corners %.2f mm over its middle, and sides %.4f mm from each other's mirror image"
          % (plain["pupils"], plain["mouth"], plain["corner"], plain["lopsided"]))
    check(worn(body, "eyebrow004") is not None and "eyebrow004" in picture(worn(body, "eyebrow004")).name,
          "a named eyebrow asset did not bring its own picture")
    # A man's face of the same kind with looks: wider-set eyes and a wider mouth than MakeHuman's own, and no makeup.
    clear()
    body = wasd_mpfb.human("male", age=45, ethnicity="african", eyes="dark", hair_color="black", brows=False)
    good = face(body)
    check(good["pupils"] > plain["pupils"] + 2.0 and good["mouth"] > plain["mouth"] + 3.0 and worn(body, "eyebrow") is None and worn(body, ".hair_short01") is not None,
          "a man with looks has pupils %.1f mm apart (%.1f without) and a mouth %.1f mm wide (%.1f)" % (good["pupils"], plain["pupils"], good["mouth"], plain["mouth"]))

    # A human that fails halfway leaves nothing in the scene, and the next one is Human again. Its seed is negative,
    # which the brows, painted before the failure, take as they take any other.
    clear()
    steps = wasd_mpfb.human.__globals__
    finish = steps["_finish_skin"]

    def broken(*args, **kwargs):
        raise RuntimeError("a step that fails")

    kinds = ("objects", "meshes", "armatures", "materials", "images")
    before = {kind: {block.name for block in getattr(bpy.data, kind)} for kind in kinds}
    steps["_finish_skin"] = broken
    try:
        wasd_mpfb.human("female", age=30, hair=False, outfit=(), lashes=False, seed=-20)
        check(False, "a human whose making fails was made")
    except RuntimeError:
        pass
    finally:
        steps["_finish_skin"] = finish
    left = {kind: sorted({block.name for block in getattr(bpy.data, kind)} - before[kind]) for kind in kinds}
    check(not any(left.values()), "a human whose making failed left %s" % left)
    # A twelve-year-old's face is of a size for its age, a tenth smaller than the woman's of the same seed.
    child = wasd_mpfb.human("female", age=12, eyes="hazel", hair=False, outfit=(), seed=3)
    young = face(child)
    check(child.name == "Human" and child.parent.name == "Human.rig" and young["pupils"] < 0.95 * fair["pupils"] and young["mouth"] < 0.95 * fair["mouth"],
          "a girl of twelve, %s, has pupils %.1f mm apart and a mouth %.1f mm wide, where the woman's are %.1f and %.1f"
          % (child.name, young["pupils"], young["mouth"], fair["pupils"], fair["mouth"]))

    # A human for a crowd: the 1,460-triangle proxy, less what its clothes hide, with painted low-poly eyes and
    # without brows, lashes, or teeth, and dressed in one asset given by its name.
    clear()
    body = wasd_mpfb.human("male", age=35, detail="low", outfit="male_casualsuit01")
    path = os.path.join(folder, "mpfb_crowd.glb")
    made = wasd_mpfb.export(body, path, texture_size=512)
    proxy = next((count for name, count in made["triangles"].items() if "proxy741" in name), 0)
    check(500 < proxy <= 1460 and not any(name.split(".")[-1].startswith("Human") for name in made["triangles"]) and made["bones"] == 53 and made["bytes"] < 4000000
          and not any(word in name for name in made["triangles"] for word in ("eyebrow", "eyelashes", "teeth"))
          and any("male_casualsuit01" in name for name in made["triangles"]),
          "a human for a crowd has %s and %d bytes" % (made["triangles"], made["bytes"]))


folder = tempfile.mkdtemp(prefix="wasd-smoke-mpfb-")
try:
    main(folder)
    if not failures:
        faced(folder)
    if not failures:
        natural(folder)
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
