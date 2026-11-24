# SPDX-License-Identifier: GPL-3.0-or-later
"""WASD Bake: textures for Godot games baked with Cycles from scripts, without a window.

- textures(): unwrap an object, bake what its materials show into images (color, roughness, metallic, normal,
  emission, and ambient occlusion), and give it one material made of those images, which glTF exports whole.
  Many procedural materials become one draw call, and creases get the shading that a Web build does not compute.
- from_high(): bake a detailed model's surface onto a simple one: its relief as a normal map, its creases as ambient
  occlusion, and its colors.
- vertex_ao(): bake ambient occlusion into vertex colors, which cost a game no texture at all.

Each function restores the render settings it changed and returns a dict of what it made.
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


class _Cycles:
    """Cycles on the CPU with few samples for the time of a bake, and the scene's own settings afterwards."""

    def __init__(self, samples):
        self.samples = samples

    def __enter__(self):
        scene = bpy.context.scene
        self.saved = (scene.render.engine, scene.cycles.device, scene.cycles.samples, scene.cycles.use_denoising)
        scene.render.engine = 'CYCLES'
        scene.cycles.device = 'CPU'
        scene.cycles.samples = self.samples
        scene.cycles.use_denoising = False
        return scene

    def __exit__(self, *_):
        scene = bpy.context.scene
        scene.render.engine, scene.cycles.device, scene.cycles.samples, scene.cycles.use_denoising = self.saved


def _select_only(objects, active):
    for other in bpy.context.view_layer.objects:
        other.select_set(other in objects)
    bpy.context.view_layer.objects.active = active


BAKE_UV = 'WasdBake'
"""Name of the UV map that a bake lays out and bakes into."""


def _ensure_uv(obj, unwrap, margin):
    """The UV map to bake into: a new one without overlaps from Smart UV Project, or the object's own active one.

    A new map becomes the active one, which is where Cycles bakes to, while the map that was used for rendering
    stays the one the materials read their textures through. Returns whether it unwrapped.
    """
    layers = obj.data.uv_layers
    if layers and not unwrap:
        return False
    source = next((layer for layer in layers if layer.active_render), None)
    old = layers.get(BAKE_UV)
    if old is not None:
        layers.remove(old)
    fresh = layers.new(name=BAKE_UV, do_init=False)
    layers.active = fresh
    if source is not None:
        source.active_render = True
    else:
        fresh.active_render = True
    _select_only([obj], obj)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(island_margin=margin)
    bpy.ops.object.mode_set(mode='OBJECT')
    return True


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
    old = bpy.data.images.get(name)
    if old is not None:
        bpy.data.images.remove(old)
    image = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    image.colorspace_settings.name = 'Non-Color' if data else 'sRGB'
    return image


def _materials(obj):
    """The object's materials, each with nodes; an object without one gets a plain gray material."""
    if not obj.data.materials:
        obj.data.materials.append(bpy.data.materials.new(obj.name + '_plain'))
    found = []
    for slot in obj.material_slots:
        if slot.material is None:
            slot.material = bpy.data.materials.new(obj.name + '_plain')
        found.append(slot.material)
    return found


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
    of the bake each material shows that input as light instead.
    """
    restore = []
    for material in materials:
        tree = material.node_tree
        shader = _principled(material)
        output = next((node for node in tree.nodes if node.type == 'OUTPUT_MATERIAL' and node.is_active_output), None)
        if shader is None or output is None:
            continue
        emit = tree.nodes.new('ShaderNodeEmission')
        source = shader.inputs[socket]
        if source.is_linked:
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


def _baked_material(name, images):
    """One material of baked images: color, roughness, metal, relief, and glow."""
    old = bpy.data.materials.get(name)
    if old is not None:
        bpy.data.materials.remove(old)
    material = bpy.data.materials.new(name)
    tree = material.node_tree
    shader = _principled(material)
    if shader is None:
        tree.nodes.clear()
        shader = tree.nodes.new('ShaderNodeBsdfPrincipled')
        output = tree.nodes.new('ShaderNodeOutputMaterial')
        tree.links.new(shader.outputs['BSDF'], output.inputs['Surface'])

    def picture(key, y):
        node = tree.nodes.new('ShaderNodeTexImage')
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
    return material


def _save(images, folder, stem):
    paths = {}
    if not folder:
        for image in images.values():
            image.pack()
        return paths
    os.makedirs(folder, exist_ok=True)
    for key, image in images.items():
        path = os.path.join(folder, f'{stem}_{key}.png')
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
    export_gltf embeds them either way. Returns the images, their files, each one's darkest and brightest value, and
    the seconds it took.
    """
    obj = _object(obj)
    unknown = [name for name in maps if name not in MAPS]
    if unknown:
        raise BakeError(f'Unknown maps {unknown}; the maps are {list(MAPS)}.')
    started = time.time()
    unwrapped = _ensure_uv(obj, unwrap, 0.02)
    materials = _materials(obj)
    images = {}
    with _Cycles(samples) as scene:
        _select_only([obj], obj)
        scene.render.bake.use_selected_to_active = False
        scene.render.bake.margin = margin
        for name in MAPS:
            if name not in maps:
                continue
            image = _image(f'{obj.name}_{name}', size, name in _DATA_MAPS)
            for material in materials:
                _target(material, image)
            if name == 'metallic':
                _bake_input(materials, 'Metallic', margin)
            elif name == 'color':
                _bake_input(materials, 'Base Color', margin)
            elif name == 'ao':
                scene.cycles.samples = ao_samples
                bpy.ops.object.bake(type='AO', margin=margin)
                scene.cycles.samples = samples
            else:
                bpy.ops.object.bake(type=_BAKE_TYPES[name], margin=margin)
            _drop_targets(materials)
            images[name] = image
    if 'color' in images and 'ao' in images and ao_into_color > 0.0:
        _shade(images['color'], images['ao'], ao_into_color)
    paths = _save(images, folder, obj.name)
    result = {'object': obj.name, 'size': size, 'unwrapped': unwrapped, 'images': {key: image.name for key, image in images.items()},
              'files': paths, 'range': {key: _spread(image) for key, image in images.items()}}
    if replace_materials:
        baked = _baked_material(obj.name + '_baked', images)
        obj.data.materials.clear()
        obj.data.materials.append(baked)
        for polygon in obj.data.polygons:
            polygon.material_index = 0
        _keep_bake_uv(obj)
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
    The low model gets one material of the baked images. Returns as textures() does.
    """
    low = _object(low)
    highs = [_object(item) for item in (high if isinstance(high, (list, tuple)) else [high])]
    unknown = [name for name in maps if name not in MAPS]
    if unknown:
        raise BakeError(f'Unknown maps {unknown}; the maps are {list(MAPS)}.')
    started = time.time()
    unwrapped = _ensure_uv(low, unwrap, 0.02)
    materials = _materials(low)
    images = {}
    with _Cycles(samples) as scene:
        _select_only(highs + [low], low)
        bake = scene.render.bake
        saved = (bake.use_selected_to_active, bake.cage_extrusion, bake.max_ray_distance)
        bake.use_selected_to_active = True
        bake.cage_extrusion = extrusion
        bake.max_ray_distance = extrusion * 2.0
        try:
            for name in MAPS:
                if name not in maps:
                    continue
                image = _image(f'{low.name}_{name}', size, name in _DATA_MAPS)
                for material in materials:
                    _target(material, image)
                if name in ('color', 'metallic'):
                    sources = [material for item in highs for material in _materials(item)]
                    _bake_input(sources, 'Base Color' if name == 'color' else 'Metallic', margin, use_selected_to_active=True,
                                cage_extrusion=extrusion, max_ray_distance=extrusion * 2.0)
                else:
                    if name == 'ao':
                        scene.cycles.samples = ao_samples
                    bpy.ops.object.bake(type=_BAKE_TYPES[name], margin=margin, use_selected_to_active=True,
                                        cage_extrusion=extrusion, max_ray_distance=extrusion * 2.0)
                    scene.cycles.samples = samples
                _drop_targets(materials)
                images[name] = image
        finally:
            bake.use_selected_to_active, bake.cage_extrusion, bake.max_ray_distance = saved
    if 'color' in images and 'ao' in images and ao_into_color > 0.0:
        _shade(images['color'], images['ao'], ao_into_color)
    paths = _save(images, folder, low.name)
    baked = _baked_material(low.name + '_baked', images)
    low.data.materials.clear()
    low.data.materials.append(baked)
    for polygon in low.data.polygons:
        polygon.material_index = 0
    _keep_bake_uv(low)
    return {'object': low.name, 'from': [item.name for item in highs], 'size': size, 'unwrapped': unwrapped,
            'images': {key: image.name for key, image in images.items()}, 'files': paths,
            'range': {key: _spread(image) for key, image in images.items()}, 'material': baked.name,
            'seconds': round(time.time() - started, 1)}


def vertex_ao(obj, *, name='Occlusion', samples=32, into_materials=True):
    """Bake ambient occlusion into a vertex color attribute, which glTF exports and Godot multiplies into the color.

    It costs a game no texture and no UV map, and suits low-poly models with enough vertices to carry the shading:
    a crease darkens only as finely as the mesh is divided. `into_materials` multiplies the attribute into the base
    color of each of the object's materials, which is what makes glTF export it. Returns the attribute's name and
    its darkest and brightest value.
    """
    obj = _object(obj)
    started = time.time()
    mesh = obj.data
    old = mesh.color_attributes.get(name)
    if old is not None:
        mesh.color_attributes.remove(old)
    attribute = mesh.color_attributes.new(name=name, type='BYTE_COLOR', domain='CORNER')
    mesh.color_attributes.active_color = attribute
    mesh.color_attributes.render_color_index = list(mesh.color_attributes).index(attribute)
    with _Cycles(samples) as scene:
        _select_only([obj], obj)
        scene.render.bake.use_selected_to_active = False
        scene.render.bake.target = 'VERTEX_COLORS'
        try:
            bpy.ops.object.bake(type='AO', target='VERTEX_COLORS')
        finally:
            scene.render.bake.target = 'IMAGE_TEXTURES'
    values = [max(color.color[0], color.color[1], color.color[2]) for color in mesh.color_attributes[name].data]
    if into_materials:
        for material in _materials(obj):
            shader = _principled(material)
            if shader is None or any(node.name == 'wasd_vertex_ao' for node in material.node_tree.nodes):
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


def register():
    """Blender calls this when the extension is enabled; the module has nothing to register."""


def unregister():
    """Blender calls this when the extension is disabled; the module has nothing to unregister."""
