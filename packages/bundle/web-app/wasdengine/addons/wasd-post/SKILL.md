---
name: wasd-post
description: WASD Post 1.0.0 is installed in this project. One WasdPost node gives the finished picture a look in a single pass over the screen, with a color grade, vignette, grain, lens fringes, a soft glow, ink lines, tilt-shift blur, pixels and scanlines, and sixteen looks by name, on every renderer and in Web builds, leaving the HUD alone. Load before grading a game's picture or giving it a film, noir, horror, comic, pencil sketch, old television, night vision, dream, miniature, or retro look.
---

# WASD Post 1.0.0

`res://addons/wasd_post/` (CC0, written by WASD Engine; global classes, and no plugin to enable). `WasdPost` is a `CanvasLayer` that covers the screen with one shader pass. It reads the finished picture below its layer, transparent things such as water, glass, and particles included, and draws the look over it. It works the same on Forward+, Mobile, and Compatibility.

## Add it

One node anywhere in the game's main scene, or in an autoload so every scene has it:

```gdscript
var post := WasdPost.new()
post.look = "cinematic"
add_child(post)
```

In a `.tscn`: a `CanvasLayer` node with the script `res://addons/wasd_post/post.gd` and `look = "cinematic"`.

## Looks

`look` sets every property at once; change single properties after it.

| Look | What it gives |
|---|---|
| `none` | The picture as the game draws it |
| `cinematic` | Teal shadows, warm highlights, soft corners, a little grain and fringe |
| `warm` | Late afternoon |
| `cold` | Winter, night |
| `vivid` | Bright, saturated, crisp: toys, arcades, cartoons |
| `noir` | Black and white, hard contrast, grain |
| `vintage` | A faded, warm, grainy photograph |
| `horror` | Drained color, green shadows, heavy dark corners, grain |
| `miniature` | A sharp band with blur above and below, strong color |
| `retro` | Blocks of 3 pixels, 12 shades a channel, scanlines |
| `comic` | Flat shades in each color's own hue, halftone dots between them, ink lines |
| `sketch` | Pencil strokes on cream paper that cross where it is dark, dark outlines; a night scene is drawn as if lit |
| `crt` | An old television: bulging glass with round corners, 240 scanlines, color stripes, glowing lights |
| `night_vision` | A green scope that brightens the dark: grain, a black rim, lights that burn white |
| `dream` | Focus that melts toward the edges, a glow round every light, a pale rim |
| `moonlight` | Day for night: a daylight scene made dim, blue, and drained. A scene already lit as night needs none |

`post.fade_to("horror", 1.5)` moves every property to another look over time and returns the `Tween`: use it when the mood changes, as at nightfall, on entering a cave, or when the player puts on goggles (`"night_vision"`). `pixel_size` moves a pixel at a time, and the steps of `color_levels` and `tone_levels` grow in or shrink away. Setting `look`, or another fade, stops it where it is, and its `finished` comes right after. `WasdPostLooks.names()` lists the looks.

## Properties

- `amount` (0 to 1): how much of the look shows. Tween it to fade the whole look in or out; at 0 the pass is not drawn.
- Color: `exposure` in stops (1 doubles brightness), `contrast` (1), `saturation` (1; 0 is black and white), `temperature` (-1 cool to 1 warm), `shadows` and `highlights` (colors that tint dark and bright tones; middle gray `Color(0.5, 0.5, 0.5)` tints nothing, and `Color(0.42, 0.5, 0.56)` in the shadows is the teal of a film grade), `color_levels` (shades per channel, 2 or more; 0 keeps all), `tone_levels` (steps of brightness that keep each color's hue, with a printer's dots between them: 4 for a comic), `tint` (a color the graded picture is multiplied by).
- Frame: `vignette` (0 to 1 darkens the corners; up to 2 they go black and the dark closes in), `vignette_softness`, `vignette_color` (black; dark red for low health, white for a dream), `grain` (0 to 1), `scanlines` (0 to 1), `curve` (the bulge of an old screen's glass, 0 to 1), `mask` (a picture tube's color stripes, 0 to 1).
- Style: `soften` (0 to 1: the picture's own light spread wide and laid back over it, so that lamps and sky glow whatever the Environment's glow is set to, and focus that softens toward the edges), `edges` (ink lines where the picture's color steps, 0 to 1) and `edge_color`, `hatch` (pencil strokes on paper in place of the picture's tones, 0 to 1).
- Lens: `aberration` (color fringes, in pixels at the corners), `sharpen` (0 to 1), `tilt_shift` (blur in pixels at the top and bottom edges) with `tilt_focus` (where the sharp band lies, 0 top to 1 bottom) and `tilt_band` (half its height), `pixel_size` (blocks in pixels; 1 is off).

Game states are a few lines: `post.vignette_color = Color(0.5, 0, 0)` with `post.vignette = 1.0 - health / max_health` for damage; `post.saturation = 0.0` and `post.fade_to(...)` on death; `post.aberration = 4.0` tweened back to its value on a hit.

## Where it draws

The node's `layer` is -1: above the 3D world and below every `Control` and `CanvasLayer` of the game, so menus and the HUD keep their colors. To grade the HUD too, give `post.layer` a number above the HUD's. In a 2D game the world is on layer 0: put the HUD on a `CanvasLayer` with `layer = 2` and set `post.layer = 1`. The same two numbers grade a first-person weapon that is drawn through a `SubViewportContainer`, as Starter Kit FPS draws its blaster: that container is a `Control`, so at the default layer the weapon keeps its plain colors while the world behind it takes the look.

## What it cannot do

It sees the picture and not the scene's depth, so it cannot blur by distance (depth of field). `tilt_shift` blurs by height on the screen instead, which reads as shallow focus from a high camera. Its ink lines follow steps of color in the picture, not the shapes themselves: two things of one color get no line between them, and a busy texture gets many. For outlines on the models, use the toon material of `wasd-materials`. Fog and SSAO are the Environment's; set them there.

## Pitfalls

- Grade last: get the lights, sky, and materials right first, then pick a look. A look cannot rescue flat lighting.
- Keep `grain` under 0.2 and `aberration` under 2 unless the game wants to look damaged; strong values tire the eyes.
- Text in the 3D world, such as signs, blurs with `tilt_shift` and breaks into blocks with `pixel_size`.
- One `WasdPost` is enough. Two stack their passes and cost twice.
- The drawn looks, `comic` and `sketch`, flatten fine textures and ink every sign and letter in the 3D world. They suit simple, strongly colored scenes best.
- Patterns such as dots, strokes, scanlines, and stripes are locked to the screen's pixels and sized for a window 720 pixels high or more.

## Check it

`godot_run`, then `godot_screenshot` with the look and with `post.amount = 0.0` (set through `godot_eval`): the look should read at a glance and the HUD should be identical in both. `godot_run` with `web: true` shows the same picture.
