# SPDX-License-Identifier: GPL-3.0-or-later
"""WASD Bake: textures for Godot games baked with Cycles from scripts, without a window.

- textures(): unwrap an object, bake what its materials show into images (color, roughness, metallic, normal,
  emission, and ambient occlusion), and give it one material made of those images, which glTF exports whole.
  Many procedural materials become one draw call, and creases get the shading that a Web build does not compute.
- from_high(): bake a detailed model's surface onto a simple one: its relief as a normal map, its creases as ambient
  occlusion, and its colors.
- vertex_ao(): bake ambient occlusion into vertex colors, which cost a game no texture at all.

Each function restores the render and bake settings it changed, leaves a model as it was when its bake fails, and
returns a dict of what it made.
"""
import os
import time

import bpy

MAPS = ('color', 'roughness', 'metallic', 'normal', 'emission', 'ao')
"""The maps textures() can bake, in the order it bakes them."""

_BAKE_TYPES = {'color': 'DIFFUSE', 'roughness': 'ROUGHNESS', 'normal': 'NORMAL', 'emission': 'EMIT', 'ao': 'AO'}
_DATA_MAPS = ('roughness', 'metallic', 'normal', 'ao')


class BakeError(RuntimeError):
    """An object the module cannot bake, with what to change."""


def _object(item):
    obj = bpy.data.objects.get(item) if isinstance(item, str) else item
    if obj is None:
        raise BakeError(f'No object named {item!r}.')
    if obj.type != 'MESH':
        raise BakeError(f'{obj.name} is a {obj.type.lower()}, not a mesh.')
    if not obj.data.polygons:
        raise BakeError(f'{obj.name} has no faces.')
    return obj


_BAKE_SETTINGS = ('target', 'margin', 'use_selected_to_active', 'cage_extrusion', 'max_ray_distance')
"""The scene's bake settings that a bake sets for its time."""


class _Cycles:
    """Cycles on the CPU with few samples for the time of a bake, baking into images unless the bake says otherwise, and
    the scene's own render and bake settings afterwards, whether the bake is done or fails."""

    def __init__(self, samples):
        self.samples = samples

    def __enter__(self):
        scene = bpy.context.scene
        self.saved = (scene.render.engine, scene.cycles.device, scene.cycles.samples, scene.cycles.use_denoising)
        self.bake = {name: getattr(scene.render.bake, name) for name in _BAKE_SETTINGS}
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = self.samples
        scene.cycles.use_denoising = False
        scene.render.bake.target = 'IMAGE_TEXTURES'
        return scene

    def __exit__(self, *_):
        scene = bpy.context.scene
        scene.render.engine, scene.cycles.device, scene.cycles.samples, scene.cycles.use_denoising = self.saved
        for name, value in self.bake.items():
            setattr(scene.render.bake, name, value)


def _select_only(objects, active):
    for other in bpy.context.view_layer.objects:
        other.select_set(other in objects)
    bpy.context.view_layer.objects.active = active


BAKE_UV = 'WasdBake'
"""Name of the UV map that a bake lays out and bakes into."""


def _ensure_uv(obj, unwrap, margin, undo):
    """The UV map to bake into: a new one without overlaps from Smart UV Project, or the object's own active one.

    A new map becomes the active one, which is where Cycles bakes to, while the map that is used for rendering
    stays the one the materials read their textures through until the bake is done. An earlier bake's map that is
    that one keeps its layout under the name `WasdBake_before`; one that is not is put aside as `WasdBake_old`, to go
    once the bake is done (_drop_uv), or, on a mesh with as many UV maps as it can have, is laid out anew in its
    place. What it changes goes on undo as a step that takes it back, for a bake that fails. Returns whether it
    unwrapped, and the name of the map put aside, or None.
    """
    import numpy as np
    layers = obj.data.uv_layers
    if layers and not unwrap:
        return False, None
    # Maps are found by name each time: adding or removing one moves the others, and a map held from before then
    # points at nothing.
    render = next((layer.name for layer in layers if layer.active_render), None)
    active = layers.active.name if layers.active is not None else None
    earlier = layers.get(BAKE_UV)
    moved = None
    if earlier is not None:
        earlier.name = BAKE_UV + ('_before' if render == BAKE_UV else '_old')
        moved = earlier.name
    # The layout of an earlier bake's map that is laid out anew, for a bake that fails.
    layout = []
    undo.append(lambda: _put_back_uv(obj, moved, active, render, layout))
    if layers.new(name=BAKE_UV, do_init=False) is None:
        if moved is None or render == BAKE_UV:
            raise BakeError(f'{obj.name} has as many UV maps as a mesh can have: remove one, or bake with unwrap=False.')
        uv = np.empty(len(layers[moved].uv) * 2, dtype=np.float32)
        layers[moved].uv.foreach_get('vector', uv)
        layout.append(uv)
        layers[moved].name = BAKE_UV
    layers.active = layers[BAKE_UV]
    layers[(moved if render == BAKE_UV else render) or BAKE_UV].active_render = True
    _select_only([obj], obj)
    bpy.ops.object.mode_set(mode='EDIT')
    try:
        bpy.ops.mesh.select_all(action='SELECT')
        bpy.ops.uv.smart_project(island_margin=margin)
    finally:
        bpy.ops.object.mode_set(mode='OBJECT')
    return True, (moved if render != BAKE_UV else None)


def _put_back_uv(obj, moved, active, render, layout):
    """Take back what _ensure_uv changed: remove the UV map it made and give the earlier bake's map that it renamed, if
    any, its name again, or give the earlier bake's map that it laid out anew its layout again, and make active and
    rendering again the maps that were, by their names."""
    layers = obj.data.uv_layers
    made = layers.get(BAKE_UV)
    if layout and made is not None:
        made.uv.foreach_set('vector', layout[0])
    elif made is not None:
        layers.remove(made)
    if moved is not None and layers.get(moved) is not None:
        layers[moved].name = BAKE_UV
    if active is not None and layers.get(active) is not None:
        layers.active = layers[active]
    if render is not None and layers.get(render) is not None:
        layers[render].active_render = True


def _drop_uv(obj, name):
    """Remove a UV map by its name, if the object has it: once a bake is done, the earlier bake's map that _ensure_uv
    put aside, which the materials do not read."""
    layer = obj.data.uv_layers.get(name) if name is not None else None
    if layer is not None:
        obj.data.uv_layers.remove(layer)


def _keep_bake_uv(obj):
    """After a bake into a new UV map, that map is the only one the object needs: glTF exports it as the first."""
    layers = obj.data.uv_layers
    if layers.get(BAKE_UV) is None:
        return
    for name in [layer.name for layer in layers if layer.name != BAKE_UV]:
        layers.remove(layers[name])
    layers[BAKE_UV].active_render = True
    layers.active = layers[BAKE_UV]


def _image(name, size, data):
    """A new image to bake into. An image of its name, such as an earlier bake's that the materials still show,
    keeps that name until the bake is done (_settle)."""
    image = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    image.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
    return image


def _settle(datablocks, made, name):
    """Give an image or a material that a bake made the name of the one it replaces. That one goes once nothing uses
    it, and is kept as `<name>_before` while something does."""
    earlier = datablocks.get(name)
    if earlier is not None and earlier != made:
        if earlier.users == 0:
            datablocks.remove(earlier)
        else:
            earlier.name = name + '_before'
    made.name = name


BAKED = 'wasd_bake'
"""Custom property of a material that textures() or from_high() made: each map it holds with the function that baked
it, as `map:function` separated by commas, such as `color:textures,normal:from_high`."""

MAP_NODE = 'wasd_map_'
"""Start of the name of each image node of a baked material, which ends in the map that the node shows."""

CLEAN_NODE = 'wasd_color_clean'
"""Name of an image node, linked to nothing, of a baked material whose color textures() baked and occlusion darkened:
it holds that color as it baked, which a later from_high() darkens by the detail's creases in place of the model's own."""


def _baked_sources(obj):
    """Each map of the baked materials that an object wears from an earlier bake, with the function that baked it."""
    found = {}
    for slot in obj.material_slots:
        for item in str(slot.material.get(BAKED, '') if slot.material is not None else '').split(','):
            key, _, source = item.partition(':')
            if key in MAPS:
                found[key] = source
    return found


def _shown_maps(obj):
    """The images that the baked materials an object wears show, by map."""
    return {node.name[len(MAP_NODE):]: node.image for slot in obj.material_slots
            if slot.material is not None and slot.material.get(BAKED)
            for node in slot.material.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image is not None and node.name.startswith(MAP_NODE)}


def _check_colors(materials, asked=True):
    """Refuse a color bake of materials without a Principled BSDF, whose Base Color is what the color map holds: a
    bake of theirs would be black. asked says whether the color map is one the caller named, or one of an earlier bake
    that is baked again."""
    plain = [material.name for material in materials if material is not None and _principled(material) is None]
    if plain:
        names = f'{", ".join(plain)} {"has" if len(plain) == 1 else "have"} none'
        build = f'build {"it" if len(plain) == 1 else "them"} on a Principled BSDF'
        raise BakeError(f'The color map holds each material\'s Principled BSDF Base Color, and {names}: {build}, or leave "color" out of maps.'
                        if asked else f'The low model\'s earlier bake from the high model has a color map, which this one bakes again from '
                        f'each material\'s Principled BSDF Base Color, and {names}: {build}.')


def _materials(obj, undo=None):
    """The object's materials, each with nodes; an object without one, and each empty slot, gets a plain gray material.
    undo, if given, gets a step that takes the plain materials back off, for a bake that fails."""
    had = len(obj.data.materials)
    if not had:
        obj.data.materials.append(bpy.data.materials.new(obj.name + '_plain'))
    empty = [index for index, slot in enumerate(obj.material_slots) if slot.material is None]
    for index in empty:
        obj.material_slots[index].material = bpy.data.materials.new(obj.name + '_plain')
    made = [obj.material_slots[index].material for index in empty] + ([] if had else [obj.data.materials[0]])
    if undo is not None and made:

        def back():
            for index in empty:
                obj.material_slots[index].material = None
            if not had:
                obj.data.materials.clear()
            for material in made:
                if material.users == 0:
                    bpy.data.materials.remove(material)

        undo.append(back)
    return [slot.material for slot in obj.material_slots]


def _target(material, image):
    """An Image Texture node that holds the image, alone selected and active, which is where Cycles bakes to."""
    nodes = material.node_tree.nodes
    node = nodes.new('ShaderNodeTexImage')
    node.name = 'wasd_bake_target'
    node.image = image
    for other in nodes:
        other.select = False
    node.select = True
    nodes.active = node
    return node


def _drop_targets(materials):
    for material in materials:
        nodes = material.node_tree.nodes
        for node in [node for node in nodes if node.name.startswith('wasd_bake_target')]:
            nodes.remove(node)


def _principled(material):
    for node in material.node_tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            return node
    return None


def _bake_input(materials, socket, margin, **options):
    """Bake what feeds one input of each material's Principled BSDF, such as its Base Color or its Metallic value.

    Cycles has no bake pass for either: a metal's diffuse color is black, and metal itself is no pass. For the time
    of the bake each material shows that input as light instead, and a material without a Principled BSDF shows
    black: it has no metal, and _check_colors() refuses a color bake of it beforehand.
    """
    restore = []
    for material in materials:
        tree = material.node_tree
        shader = _principled(material)
        output = next((node for node in tree.nodes if node.type == 'OUTPUT_MATERIAL' and node.is_active_output), None)
        if output is None:
            continue
        emit = tree.nodes.new('ShaderNodeEmission')
        source = shader.inputs[socket] if shader is not None else None
        if source is None:
            emit.inputs['Color'].default_value = (0.0, 0.0, 0.0, 1.0)
        elif source.is_linked:
            tree.links.new(source.links[0].from_socket, emit.inputs['Color'])
        elif source.type == 'RGBA':
            emit.inputs['Color'].default_value = source.default_value
        else:
            value = source.default_value
            emit.inputs['Color'].default_value = (value, value, value, 1.0)
        before = output.inputs['Surface'].links[0].from_socket if output.inputs['Surface'].is_linked else None
        tree.links.new(emit.outputs['Emission'], output.inputs['Surface'])
        restore.append((tree, emit, output, before))
    try:
        bpy.ops.object.bake(type='EMIT', margin=margin, **options)
    finally:
        for tree, emit, output, before in restore:
            if before is not None:
                tree.links.new(before, output.inputs['Surface'])
            tree.nodes.remove(emit)


def _shade(color, occlusion, amount):
    """Darken a color image by an occlusion image in place: glTF carries one color picture, not two multiplied."""
    import numpy as np
    count = color.size[0] * color.size[1] * 4
    pixels = np.empty(count, dtype=np.float32)
    shade = np.empty(count, dtype=np.float32)
    color.pixels.foreach_get(pixels)
    occlusion.pixels.foreach_get(shade)
    pixels = pixels.reshape(-1, 4)
    shade = shade.reshape(-1, 4)
    pixels[:, :3] *= (1.0 - amount) + amount * shade[:, :1]
    color.pixels.foreach_set(pixels.reshape(-1))
    color.update()


def _copy(image, name):
    """A new image of another image's pixels, which a bake may darken while the other stays as it is."""
    import numpy as np
    copy = bpy.data.images.new(name, image.size[0], image.size[1], alpha=False, float_buffer=False)
    copy.colorspace_settings.name = image.colorspace_settings.name
    pixels = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    copy.pixels.foreach_set(pixels)
    copy.update()
    return copy


def _clean_color(obj):
    """The color that textures() baked before occlusion darkened it, which the baked material an object wears keeps
    (CLEAN_NODE), or None."""
    return next((node.image for slot in obj.material_slots if slot.material is not None and slot.material.get(BAKED)
                 for node in slot.material.node_tree.nodes if node.name == CLEAN_NODE and node.image is not None), None)


def _baked_material(name, images, sources, clean=None):
    """One material of baked images: color, roughness, metal, relief, and glow, each image's node named for its map,
    and the function that baked each map, by map, as BAKED. clean, the color as textures() baked it where occlusion
    darkened the one shown, goes in a node of its own that is linked to nothing (CLEAN_NODE). A material of its name,
    such as the one an earlier bake gave the object, keeps that name until this one is on the object (_wear)."""
    material = bpy.data.materials.new(name)
    material[BAKED] = ','.join(f'{key}:{sources[key]}' for key in MAPS if key in images)
    tree = material.node_tree
    shader = _principled(material)
    if shader is None:
        tree.nodes.clear()
        shader = tree.nodes.new('ShaderNodeBsdfPrincipled')
        output = tree.nodes.new('ShaderNodeOutputMaterial')
        tree.links.new(shader.outputs['BSDF'], output.inputs['Surface'])

    def picture(key, y):
        node = tree.nodes.new('ShaderNodeTexImage')
        node.name = MAP_NODE + key
        node.image = images[key]
        node.location = (-700, y)
        return node

    if 'color' in images:
        tree.links.new(picture('color', 300).outputs['Color'], shader.inputs['Base Color'])
    elif 'ao' in images:
        tree.links.new(picture('ao', 300).outputs['Color'], shader.inputs['Base Color'])
    if 'roughness' in images:
        tree.links.new(picture('roughness', 0).outputs['Color'], shader.inputs['Roughness'])
    if 'metallic' in images:
        tree.links.new(picture('metallic', -300).outputs['Color'], shader.inputs['Metallic'])
    if 'normal' in images:
        relief = tree.nodes.new('ShaderNodeNormalMap')
        relief.location = (-350, -600)
        tree.links.new(picture('normal', -600).outputs['Color'], relief.inputs['Color'])
        tree.links.new(relief.outputs['Normal'], shader.inputs['Normal'])
    if 'emission' in images:
        tree.links.new(picture('emission', -900).outputs['Color'], shader.inputs['Emission Color'])
        shader.inputs['Emission Strength'].default_value = 1.0
    if clean is not None:
        node = tree.nodes.new('ShaderNodeTexImage')
        node.name = CLEAN_NODE
        node.image = clean
        node.location = (-1000, 300)
    return material


def _wear(obj, baked):
    """Give an object its bake's material in place of its own, and only the UV map that the bake laid out."""
    obj.data.materials.clear()
    obj.data.materials.append(baked)
    for polygon in obj.data.polygons:
        polygon.material_index = 0
    _keep_bake_uv(obj)
    _settle(bpy.data.materials, baked, obj.name + '_baked')


def _bake_maps(obj, materials, maps, size, bake):
    """Bake each of the maps into a new image, as `bake(name)` bakes it, with an image node to bake into in every
    material for the time of each. Returns the images by map; none of them is left behind when a bake fails."""
    images = {}
    try:
        for name in MAPS:
            if name not in maps:
                continue
            images[name] = _image(f'{obj.name}_{name}', size, name in _DATA_MAPS)
            for material in materials:
                _target(material, images[name])
            bake(name)
            _drop_targets(materials)
    except BaseException:
        _drop_targets(materials)
        for image in images.values():
            bpy.data.images.remove(image)
        raise
    return images


def _save(images, folder, stem):
    """Save each image as `<stem>_<map>.png` in folder and return their paths by map, or, without a folder, pack them
    into the .blend. An image in use that reads a file saved over, such as the color as textures() saved it, which a
    later from_high() keeps as it baked, is packed first and keeps its pixels."""
    paths = {}
    if not folder:
        for image in images.values():
            image.pack()
        return paths
    os.makedirs(folder, exist_ok=True)
    for key, image in images.items():
        path = os.path.join(folder, f'{stem}_{key}.png')
        for other in bpy.data.images if os.path.isfile(path) else ():
            if (other != image and other.users and other.packed_file is None and other.filepath
                    and os.path.abspath(bpy.path.abspath(other.filepath)) == os.path.abspath(path)):
                other.pack()
        image.filepath_raw = path
        image.file_format = 'PNG'
        image.save()
        paths[key] = path
    return paths


def _spread(image):
    """How dark and how bright a baked image gets, as its smallest and largest value: a flat image baked nothing."""
    import numpy as np
    pixels = np.empty(image.size[0] * image.size[1] * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    values = pixels.reshape(-1, 4)[:, :3]
    return round(float(values.min()), 3), round(float(values.max()), 3)


def textures(obj, size=1024, maps=('color', 'roughness', 'normal', 'ao'), *, folder=None, unwrap=True, samples=8,
             margin=8, ao_into_color=0.7, ao_samples=32, replace_materials=True):
    """Bake what an object's materials show into images and give it one material made of them.

    maps: any of 'color', 'roughness', 'metallic', 'normal', 'emission', 'ao'. 'normal' holds the relief that Bump
    and Normal Map nodes give the materials. 'ao' is ambient occlusion, the darkness of creases and of places near
    other parts of the object; `ao_into_color` (0 to 1) darkens the color image by it, so that the shading reaches
    the game in every renderer. The object gets a new UV map without overlaps to bake into, while its materials still read
    their textures through the old one; `unwrap=False` bakes into its own UV map, which must not overlap. `folder`
    saves the images as PNG files there; without it they are packed into the .blend, and
    export_gltf embeds them either way. `replace_materials=False` only makes the images. The material keeps the color
    as it baked, before `ao` darkened it, in an image node linked to nothing, for a later from_high() whose detail's
    creases take the place of the model's own. An object that wears the material of an earlier bake is refused: its
    own materials are gone, and a second bake would bake that material's images over again, their creases darkened
    twice. A bake that fails leaves the object as it was. Returns the images, their files, each one's darkest and
    brightest value, and the seconds it took.
    """
    obj = _object(obj)
    unknown = [name for name in maps if name not in MAPS]
    if unknown:
        raise BakeError(f'Unknown maps {unknown}; the maps are {list(MAPS)}.')
    if _baked_sources(obj):
        worn = ', '.join(slot.material.name for slot in obj.material_slots if slot.material is not None and slot.material.get(BAKED))
        raise BakeError(f'{obj.name} wears {worn}, the material of an earlier bake, which replaced its own: a second bake would '
                        'bake its images over again, their creases darkened twice. To bake it again, undo to a checkpoint '
                        'taken before the bake, or make its materials anew, and bake once with every map it needs.')
    if 'color' in maps:
        _check_colors([slot.material for slot in obj.material_slots])
    started = time.time()
    # What the bake changes on the object, taken back if it fails: a failed bake leaves the object as it was.
    undo = []
    try:
        unwrapped, old = _ensure_uv(obj, unwrap, 0.02, undo)
        materials = _materials(obj, undo)
        with _Cycles(samples) as scene:
            _select_only([obj], obj)
            scene.render.bake.use_selected_to_active = False
            scene.render.bake.margin = margin

            def bake(name):
                if name in ('color', 'metallic'):
                    _bake_input(materials, 'Base Color' if name == 'color' else 'Metallic', margin)
                elif name == 'ao':
                    scene.cycles.samples = ao_samples
                    bpy.ops.object.bake(type='AO', margin=margin)
                    scene.cycles.samples = samples
                else:
                    bpy.ops.object.bake(type=_BAKE_TYPES[name], margin=margin)

            images = _bake_maps(obj, materials, maps, size, bake)
        undo.append(lambda: bpy.data.batch_remove(list(images.values())))
        clean = None
        if 'color' in images and 'ao' in images and ao_into_color > 0.0:
            if replace_materials:
                clean = _copy(images['color'], f'{obj.name}_color_clean')
                undo.append(lambda: bpy.data.images.remove(clean))
            _shade(images['color'], images['ao'], ao_into_color)
        paths = _save(images, folder, obj.name)
    except BaseException:
        for step in reversed(undo):
            step()
        raise
    _drop_uv(obj, old)
    if replace_materials:
        baked = _baked_material(obj.name + '_baked', images, {key: 'textures' for key in images}, clean)
        _wear(obj, baked)
    if clean is not None:
        clean.pack()
        _settle(bpy.data.images, clean, f'{obj.name}_color_clean')
    for key, image in images.items():
        _settle(bpy.data.images, image, f'{obj.name}_{key}')
    result = {'object': obj.name, 'size': size, 'unwrapped': unwrapped, 'images': {key: image.name for key, image in images.items()},
              'files': paths, 'range': {key: _spread(image) for key, image in images.items()}}
    if replace_materials:
        result['material'] = baked.name
        result['materials_before'] = len(materials)
    result['seconds'] = round(time.time() - started, 1)
    return result


def from_high(low, high, size=2048, maps=('normal', 'ao', 'color'), *, folder=None, unwrap=True, extrusion=0.05,
              samples=8, margin=8, ao_into_color=0.7, ao_samples=32):
    """Bake a detailed model's surface onto a simple model that lies in the same place.

    low: the model the game shows; it gets a new UV map without overlaps, or keeps its own with `unwrap=False`.
    high: one object or a list of objects with the detail. maps: 'normal' (the detail's relief), 'ao' (its
    creases), 'color', 'roughness', 'metallic', 'emission'. `extrusion` is how far outside the low model, in meters, rays start
    to look for the detail: raise it when parts of the detail are missed, lower it when neighboring parts bleed in.
    The low model gets one material of the baked images. A low model baked before keeps every map of that bake that
    `maps` leaves out: the maps of an earlier from_high() are baked again from the high model, and those that
    textures() baked from the low model's own materials stay as they are, on the UV map they were baked into, which
    this bake then bakes into too. A color that textures() baked takes the occlusion of this bake as a color baked
    here does, in place of the model's own: `ao_into_color` darkens a copy of it as it baked, which `folder` saves
    with the maps as `<low>_color.png`, and which a later bake darkens anew. A bake that fails leaves the objects as
    they were. Returns as textures() does, with the maps it kept as `kept`.
    """
    low = _object(low)
    highs = [_object(item) for item in (high if isinstance(high, (list, tuple)) else [high])]
    unknown = [name for name in maps if name not in MAPS]
    if unknown:
        raise BakeError(f'Unknown maps {unknown}; the maps are {list(MAPS)}.')
    earlier = _baked_sources(low)
    kept = {key: image for key, image in _shown_maps(low).items() if key not in maps and earlier.get(key) == 'textures'}
    # The color as textures() baked it, before occlusion darkened the one shown, where it did.
    clean = (_clean_color(low) or kept['color']) if 'color' in kept else None
    asked = [name for name in MAPS if name in maps]
    maps = [name for name in MAPS if name in asked or earlier.get(name) == 'from_high']
    if 'color' in maps:
        _check_colors([slot.material for item in highs for slot in item.material_slots], asked='color' in asked)
    started = time.time()
    # What the bake changes on the objects, taken back if it fails: a failed bake leaves them as they were.
    undo = []
    shaded = None
    try:
        unwrapped, _ = _ensure_uv(low, unwrap and not kept, 0.02, undo)
        materials = _materials(low, undo)
        sources = [material for item in highs for material in _materials(item, undo)] if {'color', 'metallic'} & set(maps) else []
        with _Cycles(samples) as scene:
            _select_only(highs + [low], low)
            settings = scene.render.bake
            settings.use_selected_to_active = True
            settings.cage_extrusion = extrusion
            settings.max_ray_distance = extrusion * 2.0

            def bake(name):
                if name in ('color', 'metallic'):
                    _bake_input(sources, 'Base Color' if name == 'color' else 'Metallic', margin, use_selected_to_active=True,
                                cage_extrusion=extrusion, max_ray_distance=extrusion * 2.0)
                else:
                    if name == 'ao':
                        scene.cycles.samples = ao_samples
                    bpy.ops.object.bake(type=_BAKE_TYPES[name], margin=margin, use_selected_to_active=True,
                                        cage_extrusion=extrusion, max_ray_distance=extrusion * 2.0)
                    scene.cycles.samples = samples

            images = _bake_maps(low, materials, maps, size, bake)
        undo.append(lambda: bpy.data.batch_remove(list(images.values())))
        if 'color' in images and 'ao' in images and ao_into_color > 0.0:
            _shade(images['color'], images['ao'], ao_into_color)
        elif clean is not None and 'ao' in images:
            # The color that textures() baked takes the detail's creases in place of the model's own: a copy of it as
            # it baked is darkened by them as far as ao_into_color says, and it stays as it is for the next bake.
            shaded = _copy(clean, f'{low.name}_color_shaded')
            undo.append(lambda: bpy.data.images.remove(shaded))
            if ao_into_color > 0.0:
                _shade(shaded, images['ao'], ao_into_color)
            kept['color'] = shaded
        # The color shown in place of the one kept is saved or packed with the maps baked here.
        paths = _save(images if shaded is None else {**images, 'color': shaded}, folder, low.name)
    except BaseException:
        for step in reversed(undo):
            step()
        raise
    shown = {key: images[key] if key in images else kept[key] for key in MAPS if key in images or key in kept}
    clean = clean if 'color' in kept and kept['color'] is not clean else None
    baked = _baked_material(low.name + '_baked', shown, {key: 'from_high' if key in images else 'textures' for key in shown}, clean)
    _wear(low, baked)
    if clean is not None:
        _settle(bpy.data.images, clean, f'{low.name}_color_clean')
    if shaded is not None:
        _settle(bpy.data.images, shaded, f'{low.name}_color')
    for key, image in images.items():
        _settle(bpy.data.images, image, f'{low.name}_{key}')
    return {'object': low.name, 'from': [item.name for item in highs], 'size': size, 'unwrapped': unwrapped,
            'images': {key: image.name for key, image in shown.items()}, 'kept': [key for key in MAPS if key in kept], 'files': paths,
            'range': {key: _spread(image) for key, image in shown.items()}, 'material': baked.name,
            'seconds': round(time.time() - started, 1)}


def vertex_ao(obj, *, name='Occlusion', samples=32, into_materials=True):
    """Bake ambient occlusion into a vertex color attribute, which glTF exports and Godot multiplies into the color.

    It costs a game no texture and no UV map, and suits low-poly models with enough vertices to carry the shading:
    a crease darkens only as finely as the mesh is divided. `into_materials` multiplies the attribute into the base
    color of each of the object's materials, which is what makes glTF export it. A material that another mesh shows
    too, which has no such attribute and would turn black, is copied first, and the objects baked after it that show
    that material share the copy. With `into_materials`, a model whose material's Base Color is a color attribute,
    or is multiplied by one, such as painted vertex colors, is refused: glTF carries the one vertex color that Godot
    multiplies into the color, which is the paint, and the occlusion would not reach the game. A color attribute that
    a material uses otherwise, such as a mask, is no paint. A bake that fails leaves the attribute of the bake before
    as it was. Returns the attribute's name and its darkest and brightest value.
    """
    obj = _object(obj)
    if into_materials:
        _check_paint(obj, name)
    started = time.time()
    colors = obj.data.color_attributes
    # The bake goes into an attribute of its own, which takes the place of the earlier one once it is done.
    active = colors.active_color_name or None
    render = colors[colors.render_color_index].name if colors.render_color_index >= 0 else None
    baking = colors.new(name=name + '_baking', type='BYTE_COLOR', domain='CORNER').name
    colors.active_color = colors[baking]
    colors.render_color_index = colors.find(baking)
    try:
        with _Cycles(samples) as scene:
            _select_only([obj], obj)
            scene.render.bake.use_selected_to_active = False
            scene.render.bake.target = 'VERTEX_COLORS'
            bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
    except BaseException:
        colors.remove(colors[baking])
        if active is not None and colors.get(active) is not None:
            colors.active_color = colors[active]
        if render is not None and colors.get(render) is not None:
            colors.render_color_index = colors.find(render)
        raise
    old = colors.get(name)
    if old is not None:
        colors.remove(old)
    colors[baking].name = name
    colors.active_color = colors[name]
    colors.render_color_index = colors.find(name)
    values = [max(color.color[0], color.color[1], color.color[2]) for color in colors[name].data]
    if into_materials:
        _materials(obj)
        own = {}
        for slot in obj.material_slots:
            if slot.material not in own:
                own[slot.material] = _shaded_material(slot.material, name)
            slot.material = own[slot.material]
        for material in dict.fromkeys(own.values()):
            shader = _principled(material)
            if shader is None:
                continue
            shown = next((node for node in material.node_tree.nodes if node.name == 'wasd_vertex_ao'), None)
            if shown is not None:
                shown.layer_name = name
                continue
            tree = material.node_tree
            source = tree.nodes.new('ShaderNodeVertexColor')
            source.name = 'wasd_vertex_ao'
            source.layer_name = name
            mix = tree.nodes.new('ShaderNodeMix')
            mix.data_type = 'RGBA'
            mix.blend_type = 'MULTIPLY'
            mix.inputs['Factor'].default_value = 1.0
            base = shader.inputs['Base Color']
            if base.is_linked:
                tree.links.new(base.links[0].from_socket, mix.inputs['A'])
            else:
                mix.inputs['A'].default_value = base.default_value
            tree.links.new(source.outputs['Color'], mix.inputs['B'])
            tree.links.new(mix.outputs['Result'], base)
    return {'object': obj.name, 'attribute': name, 'range': (round(min(values), 3), round(max(values), 3)),
            'corners': len(values), 'seconds': round(time.time() - started, 1)}


def _check_paint(obj, name):
    """Refuse occlusion in vertex colors for a model whose material takes its color from a color attribute other than
    `name`, as Blender's glTF exporter finds one (_vertex_color): the file's one vertex color would be that attribute.
    A color attribute that a material uses otherwise, such as a mask, is none."""
    colors = obj.data.color_attributes
    render = colors[colors.render_color_index].name if colors.render_color_index >= 0 else ''
    for material in dict.fromkeys(slot.material for slot in obj.material_slots if slot.material is not None and slot.material.use_nodes):
        node = _vertex_color(material)
        # The node by which an earlier vertex_ao() multiplied its occlusion in is no paint.
        if node is None or node.name == 'wasd_vertex_ao':
            continue
        paint = (node.layer_name if node.type == 'VERTEX_COLOR' else node.attribute_name) or render
        if paint and paint != name and colors.get(paint) is not None:
            raise BakeError(f'{material.name} takes its color from the color attribute {paint!r}, which a glTF file carries as its one '
                            'vertex color, the one Godot multiplies into the color: occlusion in a second attribute would not reach the '
                            f'game. Bake {obj.name} with textures(), which puts its colors and its occlusion into images, or call '
                            'vertex_ao with into_materials=False for the attribute alone.')


def _vertex_color(material):
    """The node by which Blender's glTF exporter gives a material its vertex color, which Godot multiplies into the
    color: a Color Attribute node, or an Attribute node of the geometry, that feeds the Base Color of its Principled
    BSDF as it is, times a constant, or as one factor of a Multiply mix there; or None. Its links are followed as the
    exporter follows them, through reroutes and node groups."""
    shader = _principled(material)
    if shader is None:
        return None
    socket, groups = shader.inputs['Base Color'], ()
    for step in range(2):
        if step == 0:
            if _constant(socket, groups) is not None:
                return None
            pair = _factors(socket, groups)
            # A constant times the rest: the rest is looked at again.
            other = next((rest for factor, rest in (pair, pair[::-1]) if _constant(*factor) is not None), None) if pair else None
            if other is not None:
                socket, groups = other
                continue
        node = _attribute(socket, groups)
        if node is not None:
            return node
        return next((found for found in (_attribute(*factor) for factor in _factors(socket, groups) or ()) if found is not None), None)
    return None


def _source(socket, groups=()):
    """Where an input socket's value comes from, as Blender's glTF exporter follows a material's links: through
    reroutes, into node groups, and out of them again. Returns the node that feeds it, that node's output socket, and
    the node groups it lies in; or, where nothing feeds it, None, the unlinked socket whose own value it takes, the
    input itself or a group node's input, and the node groups that one lies in."""
    while socket.is_linked:
        link = socket.links[0]
        node, output = link.from_node, link.from_socket
        inside = next((inner for inner in node.node_tree.nodes if inner.type == 'GROUP_OUTPUT'), None) if node.type == 'GROUP' and node.node_tree else None
        if node.type == 'REROUTE':
            socket = node.inputs[0]
        elif inside is not None:
            socket, groups = inside.inputs[list(node.outputs).index(output)], groups + (node,)
        elif node.type == 'GROUP_INPUT' and groups:
            socket, groups = groups[-1].inputs[list(node.outputs).index(output)], groups[:-1]
        else:
            return node, output, groups
    return None, socket, groups


def _constant(socket, groups):
    """An input's value where glTF takes it as a constant: its own, or that of an RGB or Value node that feeds it; None
    where something else feeds it."""
    node, output, _ = _source(socket, groups)
    return output.default_value if node is None or node.type in ('RGB', 'VALUE') else None


def _attribute(socket, groups):
    """The Color Attribute node, or Attribute node of the geometry, that feeds an input, or None."""
    node, _, _ = _source(socket, groups)
    return node if node is not None and (node.type == 'VERTEX_COLOR' or node.type == 'ATTRIBUTE' and node.attribute_type == 'GEOMETRY') else None


def _factors(socket, groups):
    """The two color inputs, each with its node groups, of a Mix node that multiplies colors at a factor of 1 and feeds
    an input, as glTF takes a product; None where something else feeds it."""
    node, _, inner = _source(socket, groups)
    if node is None or node.type != 'MIX' or node.data_type != 'RGBA' or node.blend_type != 'MULTIPLY' or _constant(node.inputs['Factor'], inner) != 1:
        return None
    by_id = {input.identifier: input for input in node.inputs}
    return (by_id['A_Color'], inner), (by_id['B_Color'], inner)


SHADED = 'wasd_vertex_ao_copy'
"""Custom property of a material that vertex_ao() copied: the name of the material it copied and the attribute that
it multiplies in, as `material:attribute`."""


def _shaded_material(material, name):
    """The material into which an object that has just got the color attribute `name` multiplies it: a copy of it
    that vertex_ao() made for that attribute and whose meshes all have it, so that objects baked one after another
    share one copy; else the material itself when every mesh that shows it has such an attribute; else a new copy."""

    def lacking(users):
        meshes = [user.data if isinstance(user, bpy.types.Object) else user for user in users]
        return [user for user in meshes if not isinstance(user, bpy.types.Mesh) or user.color_attributes.get(name) is None]

    mark = f'{material.name}:{name}'
    copies = [other for other in bpy.data.materials if other.get(SHADED) == mark]
    users = bpy.data.user_map(subset={material, *copies})
    copy = next((other for other in copies if not lacking(users[other])), None)
    if copy is not None:
        return copy
    if not lacking(users[material]):
        return material
    copy = material.copy()
    copy[SHADED] = mark
    return copy


def register():
    """Blender calls this when the extension is enabled; the module has nothing to register."""


def unregister():
    """Blender calls this when the extension is disabled; the module has nothing to unregister."""
