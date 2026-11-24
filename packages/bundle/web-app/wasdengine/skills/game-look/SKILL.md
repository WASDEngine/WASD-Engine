---
name: game-look
description: Make a 3D Godot game look finished instead of like a prototype, with one written art direction and a fixed order of work (light, surfaces, a filled world, characters, motion, feedback, interface, one screen look), the tested add-on that does each step, and the checks that show whether it worked. Read it before building or reworking the look of a 3D game, and when a game looks flat, empty, gray, or unfinished.
---

# The look of a 3D game

A game looks finished when every part follows one decision and nothing is left as the engine made it: no gray background, no white mesh, no bare ground to the horizon, no default font. Work in the order below. Each step names the `game_addons` add-on that does it; install it when the game needs the step, and read its guide for the calls, with `game_addons` action guide and its id. The WASD packs draw the same in a Web build as on desktop, which lighting and shaders written by hand often do not, since browsers draw with Godot's Compatibility renderer.

## 1. Write the look down first

Five lines in the design document, before any scene:

- Kind: a row of the table below.
- Light: one look of `wasd-look`, and the weather, if any.
- Palette: a main color for the world, a second for shade and distance, and one accent kept for what the player must notice, such as pickups, enemies, the goal, and the one button a screen is about.
- References: two or three pictures from `reference_search`, kept with `reference_save`, and what you take from each.
- Screen look: one look of `wasd-post`, or none.

| Game | Light (`wasd-look`) | Surfaces (`wasd-materials`) | Screen (`wasd-post`) | Interface (`wasd-ui`) |
|---|---|---|---|---|
| Realistic | `golden_hour`, `overcast` | by name, Poly Haven and ambientCG folders | `cinematic` | `clean` |
| Stylized | `noon`, `golden_hour` | by name with `color` | `vivid` | `playful` |
| Toon | `noon` | `toon()` | `comic` or none | `playful` |
| Low-poly | `noon`, `sunset` | plain colors | `miniature` or none | `light` |
| Horror | `night`, `dawn_mist`, `interior` | by name with `wear` | `horror` | `clean`, a red accent |
| Sci-fi | `interior`, `night` | `metal`, `painted_metal`, `glow()` | `cold` | `scifi` |
| Fantasy | `golden_hour`, `dawn_mist` | `stone_blocks`, `planks`, `wood` | `warm` | `fantasy` |
| Retro | `noon` | plain colors | `retro` or `crt` | `pixel` |

Stay in one row. A photographed texture beside a flat-colored model, or a toon character in a realistic room, is what makes a game look assembled from parts.

## 2. Light: `wasd-look`

Add one `WasdLook3D` with the chosen look as soon as there is a floor and a box to look at, and judge everything after it in that light. Put the sun to the side of or behind what the camera looks at, so that shadows show shapes; a sun behind the camera flattens them. Set `view_distance` to where the level ends, or its edge shows as a line. Indoors use `interior` and let the room's own lamps light it, each with a `WasdHalo3D` of `wasd-light`.

## 3. Surfaces: `wasd-materials`

Give every mesh a surface before adding more meshes. `WasdSurface.make("bricks")` and its kin need no textures and no UV maps, and lay their patterns out in meters, so a brick is the size of a brick on every wall. `WasdSurface.from_folder()` does the same for a texture that `polyhaven_download` or `ambientcg_download` saved. Models from Blender keep their own materials; bake those that Godot shows white with `wasd-bake-blender`. An MPFB character that `wasd-face` gives a face gets its skin, eyes, teeth, lashes, and hair by itself; call `WasdSurface.human()` on any other human.

## 4. Fill the world

- Ground: `lite-terrain` for a landscape, `ant-landscape` for one modelled in Blender; `road-generator` for roads; `simple-dungeons` for rooms and corridors.
- Cover: `simple-grass-textured` for grass, `protonscatter` for rocks, plants, and props, `sapling-tree-gen` for trees, Poly Haven models for the rest. `lite-terrain` grows its own grass and has colliders only near moving bodies: place props and trees on it at its `terrain_height_at()`.
- Water: `wasd-water`, with the preset of the game's kind (`toon`, `low_poly`, `retro` beside `lake` and `ocean`).

Build in three sizes: large shapes that frame the way (hills, buildings), middle ones (trees, rocks, furniture), and small ones (grass, pebbles, clutter). A level with only the large ones looks like a model; one with only small ones looks like noise. Leave no large surface plain.

## 5. Characters

`mpfb` makes humans, `universal-animation-library` gives them clips, and `wasd-character` walks, runs, and jumps one with those clips paced so that feet do not slide, takes stairs in stride with its feet on the steps, and has a camera that stays out of walls. A character seen up close needs a face that lives: `wasd-face` blinks, turns the eyes to what the character looks at, moves the mouth with a recorded voice, and shows feelings, on an `mpfb` human given a face in Blender and on models that bring face shapes. Install `wasd-materials` with it: together they keep a human's face out of the uncanny valley, and a sun to the side of a face, not overhead, does the rest. `wasd-crowd` draws hundreds of one model; `sofluffy` gives animals fur. Where the sun's shadow is weak, put a `WasdBlobShadow3D` of `wasd-decals` under each character: a character without a shadow floats.

## 6. Motion

A world in which only the player moves looks dead. Put two or three of these into every view: wind from `wasd-weather`, which clouds, grass, smoke, and cloth share; flags, capes, and ropes from `wasd-cloth`; beams, dust in the air, and flickering lamps from `wasd-light`; fire, smoke, and steam from `wasd-fx`; birds overhead, fish, or butterflies from the flock of `wasd-crowd`; water.

## 7. Feedback

Every hit, shot, landing, pickup, and death answers at once, in three ways: an effect (`WasdFx.play("impact", at)`, `WasdFx.flash(enemy)`), a mark that stays (`wasd-decals`: bullet holes, scorch, footprints), and a movement of the camera (`shaker`). Add a sound with `elevenlabs_sound_effect`.

## 8. Interface

`wasd-ui` with the row's look and the palette's accent (`WasdUi.look`, `WasdUi.accent`), and a typeface of the game's own in `WasdUi.font`: the strongest single change. `wasd-loading` changes scenes behind a loading screen and compiles shaders before the player sees them stall. `controller-icons` shows the button to press for the device in the player's hands.

## 9. One screen look, last: `wasd-post`

Add the `WasdPost` when the rest is in place. It ties a finished picture together and cannot repair a scene that is badly lit; if the game needs it to be readable, go back to step 2. Lower `amount` when the look shows before the game does.

## Check

1. `godot_run`, then `godot_screenshot` from the player's camera in three places, and once more with `web: true`.
2. Look for what was left as the engine made it: gray background, white mesh, default font, bare ground, the level's edge against the sky.
3. Read the picture without its colors (`post.saturation = 0.0` for one screenshot): the player, the way on, and the goal must stand out by brightness alone.
4. Hold it beside the references of step 1 and name the largest difference; fix that one first.
5. `graphics_review` for what you made yourself, two to four rounds, each with a new picture.
6. `godot_performance`: 60 frames a second, and under 1,500 draw calls for the Web.

## When it looks wrong

| It looks | Change |
|---|---|
| Flat | the sun to the side and lower; a darker second color in the shade; fog that fades the distance |
| Empty | step 4's middle and small sizes; step 6 |
| Washed out or too dark | `exposure` and `ambient_strength` of the look, not the screen look |
| Noisy | fewer colors; keep the accent for what matters; larger plain areas beside the detailed ones |
| Like plastic | rougher surfaces, `wear`, and marks where things are used |
| Unlike its references | the look and the palette before any detail |
