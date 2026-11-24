---
name: mpfb
description: MPFB 2.0.18 (MakeHuman Plugin for Blender) is installed for this project's Blender with MakeHuman's CC0 system assets. One call makes a rigged, dressed human with a good-looking face that looks natural in a game, by gender, age, ethnicity, eye and hair color, hair, and clothes; a second gives it a face that a game can move, and a third writes the .glb. Load before making human characters in Blender.
---

# MPFB 2.0.18 (MakeHuman) on Blender 5.2.3, headless

In each Blender Session, first run `import wasd_addons; wasd_addons.enable("mpfb")` with `mcp__wasd_blender__execute_python`. It points MPFB at MakeHuman's system assets, offers the module `wasd_mpfb`, is idempotent, survives `new_scene`, and must be repeated after a tool result says the worker's state was lost. All code below runs in `execute_python` (set `result` to return values).

## A human

```python
import wasd_addons; wasd_addons.enable("mpfb")
import wasd_mpfb
body = wasd_mpfb.human("female", age=27, eyes="hazel", hair_color="brown")   # the base mesh; body.parent is the rig
wasd_mpfb.add_face(body)                                                     # shapes a game moves, and eye bones
result = wasd_mpfb.export(body, "/abs/path/project/models/anna.glb")         # {'bytes', 'triangles', 'bones'}
```

`human(gender, age, ethnicity, ...)` takes:

- `gender` `"female"` or `"male"`; `age` in years, 12 to 90; `ethnicity` `"caucasian"`, `"asian"`, or `"african"`, or shares such as `{"asian": 1, "caucasian": 1}`.
- `eyes`: `brown`, `dark`, `hazel`, `green`, `blue`, `gray`. `hair_color`: `black`, `dark`, `brown`, `auburn`, `red`, `blonde`, `gray`, `white`, or an sRGB color `(r, g, b)`.
- `hair`: `long01`, `ponytail01`, `short01`, `short02`, `afro01` leave the face free; `bob01`, `bob02`, `short03`, `braid01` hang over an eye; `short04` is combed back. `False` is bald. Default `long01` for women and `short02` for men, `afro01` and `short01` for `african`.
- `outfit`: clothes by name, such as `("male_worksuit01", "shoes02")`; `()` none. `lashes`: an asset's name or `False`. `brows`: left out, they are painted hair by hair for this face in its hair's color; `eyebrow001` to `eyebrow012` take MakeHuman's thinner pictures, `False` none. Names are in [references/asset-packs.md](references/asset-packs.md).
- `looks` (0 to 1, default 1): how far the face is brought to what good-looking faces of its kind measure. Keep 1 for anyone the player looks at; 0.5 is a plainer face, 0 MakeHuman's own. `makeup` (0 to 1; default 0.5 for women, 0 for men): the lash line, and color on lips and cheeks.
- `seed`: an integer draws what makes this face its own (nose, chin, cheeks, skin tone, how its two sides differ); give each person their own.
- `build`: MakeHuman's body values from 0 to 1, such as `{"muscle": 0.7, "weight": 0.4, "height": 0.6}`.
- `detail="low"`: a human for a crowd or the distance on a 1,460-triangle proxy, without brows, lashes, or teeth (12,000 to 24,000 triangles dressed); its face is too coarse for a close view.

It returns a human of 36,000 to 48,000 triangles on the 53-bone `game_engine` skeleton (Unreal-style names: `pelvis`, `spine_01`, `head`, `upperarm_l`, ...), standing at the origin.

## What `human()` does to the face, and why not to undo it

MakeHuman's own faces are plain, and a game's lights turn its assets into a mask. `human()` measures each face and brings it to what good-looking faces of its gender and group measure (eyes, lids, mouth, lips, jaw, chin, cheeks), lifts the mouth's corners, paints its brows, eyes, and teeth, evens and grooms its skin and tells a game where it is hollow and glossy, thins lashes and hairline, and lifts the hair off the skull. Keep all of it: change a face through `looks`, `makeup`, `seed`, and the other arguments, not with MPFB's targets or other skins afterwards.

## A face that moves

`add_face(body)` is the last step before the export. It seats the teeth where an opening mouth shows the upper teeth's edge, and gives the body 15 shape keys, and brows, lashes, teeth, and tongue those that move them: `blink_l`, `blink_r`, `mouth_open`, `mouth_narrow`, `mouth_wide` (an "ah", an "oo", an "ee" as speech shapes them), `smile` (lips together), `grin` (upper teeth), `sad`, `angry`, `surprised`, `afraid`, `disgusted`, `brows_up`, `brows_down`, `squint`. Each is made on this human's own face as its muscles would make it: the jaw turns about its hinge with the lower teeth and the tongue, and a smile lifts the cheeks and narrows the eyes. It also gives the skin a normal map of the face's folds at no strength, and a second UV map of where they lie: the skin of `wasd-materials` presses them in as the face smiles and frowns. `shapes=[...]` takes fewer. Each eye gets a bone under the head, `eye_l` and `eye_r` (55 bones). Add no modifier afterwards: an export drops the shape keys of a mesh that has one.

## Export

`export(body, path, texture_size=1024)` writes the rig with every mesh on it, skin and eyes solid, pictures scaled down: about 10 MB at 1024, which suits the Web. Use 2048 for a face that fills the screen, 512 for `detail="low"` (2 MB). A human that `add_face` did not prepare has no face shapes.

## In the game

Install `wasd-face` and `wasd-materials`, and for one that walks `universal-animation-library` and `wasd-character`. Once the project has imported the .glb, run that library's `retarget.gd` on it with `godot_script`, as its guide says: it knows this skeleton and names the eye bones `LeftEye` and `RightEye`, and without it the human gets no clips or feet. Then a `WasdCharacter3D` with the .glb as its model, or `WasdFace3D.add_to(model)`, gives the human its face, which WASD Materials dress: skin that light enters, wet eyes with a catchlight, a dark mouth, soft brows, thin lashes, hair with a hairline. Without those two add-ons the face is not fit to be seen up close: a stock material smears the lashes into a band over each eye.

```gdscript
var hero := WasdCharacter3D.new()
hero.add_child(preload("res://models/anna.glb").instantiate())
add_child(hero)
hero.face.look_target = player_camera
hero.face.feel("smile")
```

Light matters as much as the model: a sun to the side of a face shapes it, and a sun overhead blacks out its eyes. Of the `wasd-look` add-on's looks, `golden_hour`, `overcast`, and `studio` flatter a face, and `noon` is the hardest on it. Frame a face from a meter or more with a `fov` of 20 to 30: a wide lens up close swells the nose.

## Check it

- In Blender: `render_preview(objects=["Human.rig"], view="front")`.
- In the game: `godot_screenshot` of the face from 1 m, at rest and after `face.feel("grin")` and `face.mouth = 0.6`. Eyes look at the target, teeth are ivory, and no band lies over the lids. Then `graphics_review` it.

## MPFB's own services

For what `human()` does not offer, use MPFB's Python services (never `bpy.ops.mpfb.*`, which read UI panels):

```python
from bl_ext.wasd.mpfb.services import HumanService, TargetService, RigService
```

- `HumanService.add_mhclo_asset(os.path.join(wasd_addons.assets("mpfb"), "clothes/fedora01/fedora01.mhclo"), body, asset_type="Clothes", subdiv_levels=0)` adds a part to a body that has its rig; do it before `add_face`.
- `TargetService.get_default_macro_info_dict()`, `HumanService.create_human(macro_detail_dict=macro)`, and `HumanService.add_builtin_rig(body, "game_engine")` (also `mixamo`, `default`, `rigify.human`) build a bare human with MakeHuman's own plain face; `wasd_mpfb.add_face` and `export` take it too, and in Godot `WasdSurface.human(model)` dresses it.
- Pose `Human.rig`'s bones directly (`rig.pose.bones["upperarm_l"].rotation_euler`, `keyframe_insert`), or `rigify`'s guide for controls.

## Pitfalls

- The base mesh, targets, and system assets are CC0: characters made from them carry no license duty, and the add-on's GPL code is not part of the game.
- A second human in one scene is `Human.001` on `Human.001.rig`, made at the origin like the first; `export` writes the one it is given, where it stands.
- `human()` takes about 10 seconds, and bakes the body's shape: MPFB's sliders no longer change it. MPFB's `[INFO ]` and `[WARN ]` lines are harmless.
