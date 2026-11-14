# SPDX-License-Identifier: GPL-3.0-or-later
"""WASD Cloth: cloth for Godot games, made with Blender's Cloth modifier from scripts, without a window.

- sheet(): a subdivided rectangle with UVs, standing (flag, banner, curtain, cape) or lying (tablecloth, tarp).
- pin(): a vertex group of the points along named edges, for cloth to hang from.
- drape(): drop cloth onto objects until it settles and keep the result as an ordinary mesh: tablecloths, bedsheets,
  tarps over crates, rugs on steps, banners over a wall. It costs the game nothing.
- bake_loop(): simulate pinned cloth in wind and keep a seamless loop as shape keys, which glTF exports as morph
  targets and Godot plays as a looping animation: flags, sails, hanging banners, curtains in a breeze.
- add_chains(): give a cape, skirt, coat tail, scarf, or hair mesh bone chains in its character's armature and
  weight it to them, for WasdClothChains3D in Godot to swing.
- check(): measure cloth for faults: points that are not numbers, stretched edges, points inside colliders, and
  faces that cross each other.

Units are meters, +Z is up, and a standing sheet faces -Y, as Blender's front view shows it.
"""
import math
import time

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

FABRICS = {
    'silk': {'quality': 5, 'mass': 0.15, 'tension': 5, 'shear': 5, 'bending': 0.05, 'damping': 0, 'air': 1.0},
    'cotton': {'quality': 5, 'mass': 0.3, 'tension': 15, 'shear': 15, 'bending': 0.5, 'damping': 5, 'air': 1.0},
    'canvas': {'quality': 8, 'mass': 0.5, 'tension': 30, 'shear': 30, 'bending': 2.0, 'damping': 10, 'air': 1.0},
    'denim': {'quality': 12, 'mass': 1.0, 'tension': 40, 'shear': 40, 'bending': 10, 'damping': 25, 'air': 1.0},
    'leather': {'quality': 15, 'mass': 0.4, 'tension': 80, 'shear': 80, 'bending': 150, 'damping': 25, 'air': 1.0},
    'rubber': {'quality': 7, 'mass': 3.0, 'tension': 15, 'shear': 15, 'bending': 25, 'damping': 25, 'air': 1.0},
}
"""Cloth modifier settings per fabric: Blender's own Silk, Cotton, Denim, Leather, and Rubber presets, and canvas
between cotton and denim for flags and sails. Mass is per vertex, as the modifier counts it."""

CHAIN_PREFIX = 'cloth_'
"""Start of the bone names that add_chains() makes and WasdClothChains3D finds: cloth_<group>_<column>_<row>."""

# Wind field strength per (m/s)² of wind and per kg/m² of the cloth's vertex mass over its area. Measured on a 1.5 m by
# 1 m flag hung from its left edge, the free corner settles at about 40 degrees below level in a 3 m/s wind, 24 in
# 5 m/s, and 10 in 8 m/s, for every fabric, and the same at any mesh density.
_WIND_PER_SPEED_SQUARED = 0.46


class ClothError(RuntimeError):
    """Cloth that the module cannot work on, with what to change."""


def _object(item):
    obj = bpy.data.objects.get(item) if isinstance(item, str) else item
    if obj is None:
        raise ClothError(f'No object named {item!r}.')
    return obj


def _refresh():
    """Bring every object's matrix_world up to date with transforms that code set since the last update."""
    bpy.context.view_layer.update()


def _mesh_object(item):
    obj = _object(item)
    if obj.type != 'MESH':
        raise ClothError(f'{obj.name} is a {obj.type.lower()}, not a mesh.')
    return obj


def _fabric(name):
    if name not in FABRICS:
        raise ClothError(f'Unknown fabric {name!r}; use one of {", ".join(FABRICS)}.')
    return FABRICS[name]


def _coords(mesh):
    co = np.empty(len(mesh.vertices) * 3, dtype=np.float64)
    mesh.vertices.foreach_get('co', co)
    return co.reshape(-1, 3)


def _evaluated_coords(obj):
    evaluated = obj.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = evaluated.to_mesh()
    try:
        return _coords(mesh)
    finally:
        evaluated.to_mesh_clear()


def _world(obj, local):
    matrix = np.array(obj.matrix_world)
    return local @ matrix[:3, :3].T + matrix[:3, 3]


def _edges(mesh, local):
    pairs = np.empty(len(mesh.edges) * 2, dtype=np.int64)
    mesh.edges.foreach_get('vertices', pairs)
    pairs = pairs.reshape(-1, 2)
    lengths = np.linalg.norm(local[pairs[:, 0]] - local[pairs[:, 1]], axis=1)
    keep = lengths > 1e-6
    return pairs[keep], lengths[keep]


def _area(obj):
    mesh = obj.data
    scale = obj.matrix_world.to_scale()
    return sum(p.area for p in mesh.polygons) * abs(scale.x * scale.y * scale.z) ** (2.0 / 3.0)


class _Frames:
    """Scene frame rate and range set for a simulation, put back afterwards."""

    def __init__(self, scene, fps, last):
        self.scene, self.fps, self.last = scene, fps, last

    def __enter__(self):
        scene = self.scene
        self.saved = (scene.render.fps, scene.render.fps_base, scene.frame_start, scene.frame_end, scene.frame_current)
        scene.render.fps, scene.render.fps_base = self.fps, 1.0
        scene.frame_start, scene.frame_end = 1, max(self.last, 2)
        return self

    def __exit__(self, *_exc):
        scene = self.scene
        scene.render.fps, scene.render.fps_base, scene.frame_start, scene.frame_end, current = self.saved
        scene.frame_set(current)


def _add_cloth(obj, fabric, *, pin_group, frames, self_collision, collision_distance):
    preset = _fabric(fabric)
    for modifier in obj.modifiers:
        if modifier.type == 'CLOTH':
            raise ClothError(f'{obj.name} already has a Cloth modifier ({modifier.name}); remove it first.')
    if pin_group is not None and obj.vertex_groups.get(pin_group) is None:
        raise ClothError(f'{obj.name} has no vertex group {pin_group!r}; make it with pin().')
    modifier = obj.modifiers.new('Cloth', 'CLOTH')
    settings = modifier.settings
    settings.quality = preset['quality']
    settings.mass = preset['mass']
    settings.tension_stiffness = settings.compression_stiffness = preset['tension']
    settings.shear_stiffness = preset['shear']
    settings.bending_stiffness = preset['bending']
    settings.tension_damping = settings.compression_damping = settings.shear_damping = preset['damping']
    settings.air_damping = preset['air']
    if pin_group is not None:
        settings.vertex_group_mass = pin_group
    collision = modifier.collision_settings
    collision.use_collision = True
    collision.distance_min = collision_distance
    collision.collision_quality = 3
    collision.use_self_collision = self_collision
    collision.self_distance_min = collision_distance
    modifier.point_cache.frame_start = 1
    modifier.point_cache.frame_end = frames
    return modifier


def _make_collider(obj, thickness):
    if obj.type != 'MESH':
        raise ClothError(f'Collider {obj.name} is a {obj.type.lower()}; cloth collides only with meshes.')
    if not any(modifier.type == 'COLLISION' for modifier in obj.modifiers):
        obj.modifiers.new('Collision', 'COLLISION')
    obj.collision.thickness_outer = thickness
    obj.collision.use = True


def sheet(name, size=(1.0, 1.0), cell=0.04, facing='VERTICAL', location=(0.0, 0.0, 0.0), collection=None):
    """Make a rectangle of cloth: `size` (width, height) in meters, cells of about `cell` meters, with UVs.
    VERTICAL stands in the XZ plane facing -Y (a flag, banner, curtain, or cape; top is +Z); HORIZONTAL lies in the XY
    plane facing +Z (a tablecloth or tarp; top is +Y). Returns the new object, linked to `collection` or the scene."""
    if facing not in ('VERTICAL', 'HORIZONTAL'):
        raise ClothError("facing is 'VERTICAL' or 'HORIZONTAL'.")
    width, height = float(size[0]), float(size[1])
    columns, rows = max(1, round(width / cell)), max(1, round(height / cell))
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    bmesh.ops.create_grid(bm, x_segments=columns, y_segments=rows, size=0.5, calc_uvs=True)
    for vertex in bm.verts:
        x, along = vertex.co.x * width, vertex.co.y * height
        vertex.co = Vector((x, 0.0, along)) if facing == 'VERTICAL' else Vector((x, along, 0.0))
    for face in bm.faces:
        for loop in face.loops:
            co = loop.vert.co
            loop[uv].uv = (co.x / width + 0.5, (co.z if facing == 'VERTICAL' else co.y) / height + 0.5)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.shade_smooth()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def pin(cloth, edges=('top',), rows=1, group='pin'):
    """Make the vertex group `group` of the points along named edges of a sheet: top, bottom, left, right, or a corner
    (top_left, top_right, bottom_left, bottom_right), in the object's own axes (top is +Z for a standing sheet and +Y
    for a lying one, left is -X). `rows` lines of points next to each edge are pinned. Returns the group's size."""
    obj = _mesh_object(cloth)
    co = _coords(obj.data)
    if len(co) == 0:
        raise ClothError(f'{obj.name} has no vertices.')
    low, high = co.min(axis=0), co.max(axis=0)
    up = 2 if (high[2] - low[2]) >= (high[1] - low[1]) else 1
    pairs, lengths = _edges(obj.data, co)
    reach = (float(np.median(lengths)) if len(lengths) else 0.05) * (rows - 0.5)
    sides = {
        'top': co[:, up] >= high[up] - reach, 'bottom': co[:, up] <= low[up] + reach,
        'left': co[:, 0] <= low[0] + reach, 'right': co[:, 0] >= high[0] - reach,
    }
    chosen = np.zeros(len(co), dtype=bool)
    for edge in ([edges] if isinstance(edges, str) else edges):
        parts = edge.split('_')
        if any(part not in sides for part in parts) or len(parts) > 2:
            raise ClothError(f'Unknown edge {edge!r}; use top, bottom, left, right, or a corner such as top_left.')
        mask = np.ones(len(co), dtype=bool)
        for part in parts:
            mask &= sides[part]
        chosen |= mask
    vertex_group = obj.vertex_groups.get(group) or obj.vertex_groups.new(name=group)
    vertex_group.remove(range(len(co)))
    vertex_group.add([int(i) for i in np.nonzero(chosen)[0]], 1.0, 'REPLACE')
    return int(chosen.sum())


def drape(cloth, colliders=(), fabric='cotton', *, frames=150, settle=0.05, self_collision=True,
          collision_distance=0.005, thickness=0.0, pin_group=None, apply=True, fps=24):
    """Drop `cloth` onto `colliders` (meshes) and simulate until it settles: 98% of its points move slower than
    `settle` m/s for 8 frames in a row, or `frames` frames pass. Start the cloth just above the colliders, not
    touching them. With `apply`, the settled shape replaces the mesh, the Cloth modifier goes, and the cloth is an
    ordinary mesh again; `thickness` adds a Solidify modifier of that many meters. Self-collision keeps folds from
    passing through each other and costs about three times the time. Returns frames, seconds, whether it settled,
    and check()'s measurements."""
    _refresh()
    obj = _mesh_object(cloth)
    targets = [_mesh_object(item) for item in colliders]
    added = [target for target in targets if not any(modifier.type == 'COLLISION' for modifier in target.modifiers)]
    for target in targets:
        _make_collider(target, collision_distance)
    rest = _coords(obj.data)
    scene = bpy.context.scene
    modifier = _add_cloth(obj, fabric, pin_group=pin_group, frames=frames, self_collision=self_collision,
                          collision_distance=collision_distance)
    started = time.perf_counter()
    calm, frame, speed = 0, 0, float('inf')
    with _Frames(scene, fps, frames):
        previous = None
        for frame in range(1, frames + 1):
            scene.frame_set(frame)
            co = _evaluated_coords(obj)
            if previous is not None:
                # The 98th percentile, so that one point twitching at a corner does not keep the cloth unsettled.
                speed = float(np.percentile(np.linalg.norm(co - previous, axis=1), 98)) * fps
                calm = calm + 1 if speed < settle else 0
                if frame >= 20 and calm >= 8:
                    break
            previous = co
        if apply:
            settled = bpy.data.meshes.new_from_object(obj.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    seconds = time.perf_counter() - started
    if apply:
        old = obj.data
        obj.modifiers.remove(modifier)
        settled.name = old.name
        obj.data = settled
        if old.users == 0:
            bpy.data.meshes.remove(old)
        settled.shade_smooth()
    else:
        # Leaving the simulation put the scene back on its earlier frame; show the settled one again.
        scene.frame_set(frame)
    result = {'frames': frame, 'seconds': round(seconds, 2), 'settled': calm >= 8, 'end_speed': round(speed, 3)}
    result.update(check(obj, targets, rest=rest))
    if apply:
        # The Collision modifiers it added go again, so the props export as they were.
        for target in added:
            for modifier in [m for m in target.modifiers if m.type == 'COLLISION']:
                target.modifiers.remove(modifier)
    if apply and thickness > 0:
        solidify = obj.modifiers.new('Solidify', 'SOLIDIFY')
        solidify.thickness = thickness
        solidify.offset = 0.0
    return result


def bake_loop(cloth, *, pin_group='pin', fabric='canvas', wind_speed=5.0, wind_direction=(1.0, -0.5, 0.0),
              turbulence=0.5, seconds=2.0, fps=24, warmup=3.0, blend=0.5, name=None):
    """Simulate pinned cloth in wind and keep a seamless loop of `seconds` as shape keys on a new object `name`
    (default <cloth>_loop), whose action <name> loops when Godot imports it. The sheet hangs from `pin_group` (see
    pin()); the wind blows at `wind_speed` m/s along `wind_direction`, which should cross the sheet: wind along the
    surface does not push cloth. `turbulence` (0 to 1) adds flutter. The first `warmup` seconds let the cloth start
    moving, and the last `blend` seconds fade into the first frames so the end meets the start. The source object
    stays as it was. Every frame becomes a shape key: keep loops short and meshes light (glTF stores about 24 bytes per
    vertex per frame). Returns the loop object's name, frames, and check()'s measurements."""
    _refresh()
    source = _mesh_object(cloth)
    if seconds <= 0 or blend < 0 or blend >= seconds:
        raise ClothError('seconds must be positive and blend smaller than it.')
    scene = bpy.context.scene
    loop_frames = max(2, round(seconds * fps))
    blend_frames = round(blend * fps)
    first = max(2, round(warmup * fps))
    last = first + loop_frames + blend_frames
    sim = source.copy()
    sim.data = source.data.copy()
    sim.name = f'{source.name}_simulating'
    scene.collection.objects.link(sim)
    fields = []
    started = time.perf_counter()
    try:
        _add_cloth(sim, fabric, pin_group=pin_group, frames=last, self_collision=False, collision_distance=0.005)
        preset = _fabric(fabric)
        weight = preset['mass'] * len(sim.data.vertices) / max(_area(sim), 1e-6)
        direction = Vector(wind_direction).normalized()
        center = sim.matrix_world @ (sum((v.co for v in sim.data.vertices), Vector()) / max(len(sim.data.vertices), 1))
        with bpy.context.temp_override(scene=scene, view_layer=scene.view_layers[0]):
            rotation = direction.to_track_quat('Z', 'Y').to_euler()
            bpy.ops.object.effector_add(type='WIND', location=center - direction * 3.0, rotation=rotation)
            fields.append(bpy.context.view_layer.objects.active)
            bpy.ops.object.effector_add(type='TURBULENCE', location=center)
            fields.append(bpy.context.view_layer.objects.active)
        wind, gusts = fields
        wind.field.strength = _WIND_PER_SPEED_SQUARED * wind_speed ** 2 * weight
        # Wind along the surface pushes the cloth too, as drag does, so a flag streams out instead of hanging.
        wind.field.wind_factor = 0.0
        wind.field.noise = 2.0 * turbulence
        gusts.field.strength = 0.35 * turbulence * wind.field.strength
        gusts.field.size = 0.6
        gusts.field.flow = 0.0
        frames = {}
        with _Frames(scene, fps, last):
            for frame in range(1, last + 1):
                scene.frame_set(frame)
                if frame >= first:
                    frames[frame - first] = _evaluated_coords(sim)
        seconds_taken = time.perf_counter() - started
    finally:
        for field in fields:
            bpy.data.objects.remove(field)
        mesh = sim.data
        bpy.data.objects.remove(sim)
        bpy.data.meshes.remove(mesh)
    shapes = []
    for k in range(loop_frames):
        shape = frames[k]
        if k < blend_frames:
            weight_k = k / blend_frames
            weight_k = weight_k * weight_k * (3.0 - 2.0 * weight_k)
            shape = frames[loop_frames + k] * (1.0 - weight_k) + frames[k] * weight_k
        shapes.append(shape)
    loop = source.copy()
    loop.data = source.data.copy()
    loop.name = name or f'{source.name}_loop'
    loop.data.name = loop.name
    loop.modifiers.clear()
    for collection in source.users_collection:
        collection.objects.link(loop)
    loop.data.vertices.foreach_set('co', shapes[0].ravel())
    loop.data.update()
    loop.shape_key_add(name='Basis', from_mix=False)
    keys = []
    for k in range(1, loop_frames):
        key = loop.shape_key_add(name=f'F{k:03d}', from_mix=False)
        key.data.foreach_set('co', shapes[k].ravel())
        keys.append(key)
    # Frame 0 and frame loop_frames both show the basis, so the action is exactly the loop long and wraps without a stop.
    for k, key in enumerate(keys, start=1):
        for frame, value in ((k - 1, 0.0), (k, 1.0), (k + 1, 0.0)):
            key.value = value
            key.keyframe_insert('value', frame=frame)
    action = loop.data.shape_keys.animation_data.action
    action.name = loop.name if loop.name.lower().endswith('loop') else f'{loop.name}_loop'
    for curve in _fcurves(action):
        for point in curve.keyframe_points:
            point.interpolation = 'LINEAR'
    loop.data.shade_smooth()
    result = {'object': loop.name, 'action': action.name, 'frames': loop_frames, 'fps': fps,
              'seconds': round(seconds_taken, 2), 'glb_bytes_estimate': len(loop.data.vertices) * loop_frames * 24}
    result.update(check(loop, (), rest=_coords(source.data)))
    return result


def _fcurves(action):
    """The F-curves of an action, from its layered channelbags in Blender 5 or its own list before."""
    curves = []
    for layer in getattr(action, 'layers', ()):
        for strip in layer.strips:
            for bag in getattr(strip, 'channelbags', ()):
                curves.extend(bag.fcurves)
    return curves or list(getattr(action, 'fcurves', ()))


def add_chains(cloth, armature, *, anchor, group='cape', columns=5, rows=6, layout='sheet', top_band=0.08):
    """Give a cloth mesh worn by a character bone chains in the character's armature and weight it to them, for
    WasdClothChains3D in Godot. `anchor` is the bone the cloth hangs from (the chest for a cape, the hips for a
    skirt). Chains run from the top of the cloth (its highest points) down: `columns` side by side across a sheet
    (cape, coat tail, banner on a back) or around a tube (layout='tube': skirt, kilt, robe hem), each `rows` bones
    long, named cloth_<group>_<column>_<row>. The top `top_band` of the cloth's height stays on the anchor. The cloth
    gets an Armature modifier and loses its weights to the armature's other bones. Pose the armature at rest first.
    Returns the bone names and how far the chains sit from the cloth."""
    _refresh()
    obj = _mesh_object(cloth)
    arm = _object(armature)
    if arm.type != 'ARMATURE':
        raise ClothError(f'{arm.name} is not an armature.')
    if arm.data.bones.get(anchor) is None:
        raise ClothError(f'{arm.name} has no bone {anchor!r}.')
    if layout not in ('sheet', 'tube'):
        raise ClothError("layout is 'sheet' or 'tube'.")
    if columns < (2 if layout == 'sheet' else 3) or rows < 1:
        raise ClothError('Use at least 2 columns for a sheet, 3 around a tube, and 1 row.')
    world = _world(obj, _coords(obj.data))
    z_top, z_bottom = float(world[:, 2].max()), float(world[:, 2].min())
    if z_top - z_bottom < 0.02:
        raise ClothError(f'{obj.name} is flat in Z; chains hang down, so stand the cloth up first.')
    down = (z_top - world[:, 2]) / (z_top - z_bottom)
    center = world[:, :2].mean(axis=0)
    if layout == 'tube':
        across = (np.arctan2(world[:, 1] - center[1], world[:, 0] - center[0]) / (2.0 * math.pi)) % 1.0
        spots = (np.arange(columns) + 0.5) / columns
    else:
        flat = world[:, :2] - center
        axis = np.linalg.svd(flat - flat.mean(axis=0), full_matrices=False)[2][0]
        across = flat @ axis
        across = (across - across.min()) / max(float(np.ptp(across)), 1e-6)
        spots = np.linspace(0.0, 1.0, columns)
    span = 1.0 / columns if layout == 'tube' else 1.0 / (columns - 1)
    levels = top_band + (1.0 - top_band) * np.arange(rows + 1) / rows

    def gap(a, b):
        distance = np.abs(a - b)
        return np.minimum(distance, 1.0 - distance) if layout == 'tube' else distance

    joints = np.zeros((columns, rows + 1, 3))
    for c in range(columns):
        near_column = np.exp(-0.5 * (gap(across, spots[c]) / (0.35 * span)) ** 2)
        for r in range(rows + 1):
            near = near_column * np.exp(-0.5 * ((down - levels[r]) / (0.5 * (1.0 - top_band) / rows)) ** 2)
            if near.sum() < 1e-9:
                raise ClothError(f'The cloth has no vertices near chain {c} row {r}; use fewer columns or rows.')
            joints[c, r] = (world * near[:, None]).sum(axis=0) / near.sum()
    surface = BVHTree.FromObject(obj, bpy.context.evaluated_depsgraph_get())
    to_local = obj.matrix_world.inverted()
    offsets = [surface.find_nearest(to_local @ Vector(point))[3] or 0.0 for point in joints.reshape(-1, 3)]

    scene = bpy.context.scene
    view_layer = scene.view_layers[0]
    previous_active = view_layer.objects.active
    view_layer.objects.active = arm
    names = []
    to_armature = arm.matrix_world.inverted()
    with bpy.context.temp_override(scene=scene, view_layer=view_layer, active_object=arm, object=arm,
                                   selected_objects=[arm], selected_editable_objects=[arm]):
        bpy.ops.object.mode_set(mode='EDIT')
        try:
            bones = arm.data.edit_bones
            for c in range(columns):
                parent = bones[anchor]
                for r in range(rows):
                    bone_name = f'{CHAIN_PREFIX}{group}_{c:02d}_{r:02d}'
                    if bones.get(bone_name) is not None:
                        bones.remove(bones[bone_name])
                    bone = bones.new(bone_name)
                    bone.head = to_armature @ Vector(joints[c, r])
                    bone.tail = to_armature @ Vector(joints[c, r + 1])
                    bone.parent = parent
                    bone.use_connect = False
                    bone.use_deform = True
                    parent = bone
                    names.append(bone_name)
        finally:
            bpy.ops.object.mode_set(mode='OBJECT')
    view_layer.objects.active = previous_active

    bone_names = {bone.name for bone in arm.data.bones}
    for vertex_group in list(obj.vertex_groups):
        if vertex_group.name in bone_names:
            obj.vertex_groups.remove(vertex_group)
    step = (1.0 - top_band) / rows
    middles = levels[:-1] + 0.5 * step
    on_anchor = np.clip((top_band + 0.5 * step - down) / step, 0.0, 1.0)
    weights = np.zeros((len(world), columns, rows))
    clamped = np.clip(down, middles[0], middles[-1])
    for c in range(columns):
        side = np.clip(1.0 - gap(across, spots[c]) / span, 0.0, 1.0)
        for r in range(rows):
            weights[:, c, r] = side * np.clip(1.0 - np.abs(clamped - middles[r]) / step, 0.0, 1.0)
    totals = weights.reshape(len(world), -1).sum(axis=1)
    totals[totals < 1e-9] = 1.0
    weights = weights / totals[:, None, None] * (1.0 - on_anchor)[:, None, None]
    anchor_group = obj.vertex_groups.new(name=anchor)
    for i in np.nonzero(on_anchor > 0)[0]:
        anchor_group.add([int(i)], float(on_anchor[i]), 'REPLACE')
    for c in range(columns):
        for r in range(rows):
            column_weights = weights[:, c, r]
            chosen = np.nonzero(column_weights > 0.01)[0]
            if len(chosen) == 0:
                continue
            vertex_group = obj.vertex_groups.new(name=f'{CHAIN_PREFIX}{group}_{c:02d}_{r:02d}')
            for i in chosen:
                vertex_group.add([int(i)], float(column_weights[i]), 'REPLACE')
    modifier = next((m for m in obj.modifiers if m.type == 'ARMATURE' and m.object == arm), None)
    if modifier is None:
        modifier = obj.modifiers.new('Armature', 'ARMATURE')
        modifier.object = arm
    obj.modifiers.move(list(obj.modifiers).index(modifier), 0)
    if obj.parent != arm:
        world_matrix = obj.matrix_world.copy()
        obj.parent = arm
        obj.parent_type = 'OBJECT'
        obj.matrix_world = world_matrix
    return {'bones': names, 'chains': columns, 'rows': rows, 'anchor': anchor,
            'farthest_from_cloth': round(float(max(offsets)), 3)}


def check(cloth, colliders=(), rest=None):
    """Measure cloth as it is now (with its modifiers): vertices whose position is not a number, how far edges stretch
    past `rest` (vertex coordinates in object space, such as the mesh before a simulation; default: the mesh itself),
    vertices more than 2 mm inside the `colliders`, and pairs of faces that cross each other."""
    _refresh()
    obj = _mesh_object(cloth)
    local = _evaluated_coords(obj)
    reference = local if rest is None else np.asarray(rest, dtype=np.float64)
    nan = int((~np.isfinite(local)).any(axis=1).sum())
    result = {'vertices': len(local), 'not_numbers': nan}
    if len(reference) == len(local) and nan == 0:
        pairs, lengths = _edges(obj.data, reference)
        if len(pairs):
            ratio = np.linalg.norm(local[pairs[:, 0]] - local[pairs[:, 1]], axis=1) / lengths
            result['stretch_p95'] = round(float(np.percentile(ratio, 95)) - 1.0, 4)
            result['stretch_max'] = round(float(ratio.max()) - 1.0, 4)
    if nan == 0:
        world = _world(obj, local)
        inside = 0
        depsgraph = bpy.context.evaluated_depsgraph_get()
        for item in colliders:
            target = _mesh_object(item)
            tree = BVHTree.FromObject(target, depsgraph)
            to_target = target.matrix_world.inverted()
            for point in world:
                local_point = to_target @ Vector(point)
                hit, normal, _index, _distance = tree.find_nearest(local_point)
                if hit is not None and (local_point - hit).dot(normal) < -0.002:
                    inside += 1
        result['inside_colliders'] = inside
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            polygons = [tuple(p.vertices) for p in mesh.polygons]
            tree = BVHTree.FromPolygons([Vector(p) for p in _coords(mesh)], polygons)
            crossing = 0
            for a, b in tree.overlap(tree):
                if a < b and not set(polygons[a]) & set(polygons[b]):
                    crossing += 1
            result['crossing_faces'] = crossing
        finally:
            evaluated.to_mesh_clear()
    return result


def register():
    """Blender calls this when the extension is enabled; the module has nothing to register."""


def unregister():
    """Blender calls this when the extension is disabled."""
