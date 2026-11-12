"""Make the rigs of the animation packs' smoke test: MPFB's game_engine and mixamo rigs and a Rigify basic_human game
skeleton, each with one small cube skinned to its hips, as files/wasd_smoke/<rig>.glb. Run it with bpy 5.2.3, a store
folder that holds the catalog's MPFB extension unpacked as mpfb/, and a Blender user folder of its own:

BLENDER_USER_RESOURCES=<scratch folder> uv run --python 3.13 --no-project --with bpy==5.2.3 python -I rigs.py <store> <out>
"""
import os
import sys

import bpy  # noqa: I001 (bpy puts addon_utils on the path)
import addon_utils

store, out = sys.argv[-2], sys.argv[-1]
repos = bpy.context.preferences.extensions.repos
if not any(repo.module == 'wasd' for repo in repos):
    repos.new(name='WASD Engine add-ons', module='wasd', custom_directory=store, source='USER')
errors = []
for module in ('bl_ext.wasd.mpfb', 'rigify'):
    addon_utils.enable(module, default_set=True, persistent=True, handle_error=errors.append)
if errors:
    raise SystemExit(f'Enabling MPFB or Rigify failed: {errors}')
from bl_ext.wasd.mpfb.services import HumanService  # noqa: E402


def clear():
    for collection in (bpy.data.objects, bpy.data.armatures, bpy.data.meshes):
        for item in list(collection):
            collection.remove(item)


def skin_cube(rig, hips):
    """A 5 cm cube at the hips, weighted to them, so the export has a skin with every bone of the rig."""
    bpy.ops.mesh.primitive_cube_add(size=0.05, location=rig.matrix_world @ rig.data.bones[hips].head_local)
    cube = bpy.context.active_object
    cube.name = 'Fixture'
    group = cube.vertex_groups.new(name=hips)
    group.add([vertex.index for vertex in cube.data.vertices], 1.0, 'REPLACE')
    cube.modifiers.new('Armature', 'ARMATURE').object = rig
    cube.parent = rig
    cube.matrix_parent_inverse = rig.matrix_world.inverted()
    return cube


def export(rig, cube, name, **options):
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    cube.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.export_scene.gltf(filepath=os.path.join(out, f'{name}.glb'), export_format='GLB', use_selection=True, **options)


for rig_name, hips in (('game_engine', 'pelvis'), ('mixamo', 'mixamorig:Hips')):
    clear()
    body = HumanService.create_human()
    rig = HumanService.add_builtin_rig(body, rig_name)
    bpy.data.objects.remove(body)
    rig.name = f'mpfb_{rig_name}'
    export(rig, skin_cube(rig, hips), f'mpfb_{rig_name}', export_animations=False)


def game_skeleton(rig):
    """The rigify guide's re-parenting, which leaves one skeleton of DEF- bones rooted at DEF-spine."""
    bones = rig.data.bones
    deform = {bone.name for bone in bones if bone.use_deform}
    for name in deform:
        parent, pose_bone = bones[name].parent, rig.pose.bones[name]
        if parent and parent.name not in deform and not any(c.type == 'COPY_TRANSFORMS' for c in pose_bone.constraints):
            constraint = pose_bone.constraints.new('COPY_TRANSFORMS')
            constraint.target = rig
            constraint.subtarget = parent.name

    def ancestor(name):
        bone = bones[name].parent
        while bone:
            for candidate in (bone.name, 'DEF-' + bone.name.split('-', 1)[-1]):
                if candidate in deform and candidate != name:
                    return candidate
            bone = bone.parent
        return None
    plan = {name: ancestor(name) for name in deform if not bones[name].parent or bones[name].parent.name not in deform}
    bpy.ops.object.select_all(action='DESELECT')
    rig.select_set(True)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode='EDIT')
    for name, parent in plan.items():
        edit_bone = rig.data.edit_bones[name]
        edit_bone.use_connect = False
        edit_bone.parent = rig.data.edit_bones[parent] if parent else None
    bpy.ops.object.mode_set(mode='OBJECT')


clear()
bpy.ops.object.armature_basic_human_metarig_add()
meta = bpy.context.active_object
meta.scale = (0.9, 0.9, 0.9)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
bpy.ops.pose.rigify_generate()
rig = meta.data.rigify_target_rig
if rig is None:
    raise SystemExit('Rigify generation failed')
bpy.data.objects.remove(meta)
game_skeleton(rig)
rig.name = 'rigify_basic_human'
export(rig, skin_cube(rig, 'DEF-spine'), 'rigify_basic_human', export_def_bones=True, export_animations=True, export_force_sampling=True)
