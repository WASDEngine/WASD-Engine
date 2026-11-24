---
name: wasd-look
description: WASD Look 1.0.0 is installed in this project. One WasdLook3D node is the scene's whole lighting, with a sky and clouds, a sun with shadows, bounce light, fog, exposure, and glow, set by ten looks by name, by the hour of a day that runs, or around an HDRI sky, and it shows the same picture on Forward+, Mobile, and in Web builds. Load before lighting any 3D scene or adding a sky, a sun, fog, or a day and night.
---

# WASD Look 1.0.0

`res://addons/wasd_look/` (CC0, written by WASD Engine; global classes, no plugin to enable). `WasdLook3D` extends `WorldEnvironment`: it is the scene's environment and owns its sun (`look.sun`) and a light bounced up from the ground (`look.bounce`). Every value was tuned on the Compatibility renderer, which Web builds use, and measured against Forward+: sunlit and shaded surfaces agree within 0.05 of full brightness in every look, most within 0.03.

## Add it

```gdscript
var look := WasdLook3D.new()
look.look = "golden_hour"
add_child(look)
```

In a `.tscn`: a `WorldEnvironment` node with the script `res://addons/wasd_look/look_3d.gd` and `look = "golden_hour"`. Delete the scene's other `WorldEnvironment` and its sun: a scene shows one environment, and a second `DirectionalLight3D` is a second sun.

## Looks

| Look | What it gives |
|---|---|
| `noon` | A clear day, sun high, a few clouds |
| `golden_hour` | Low warm sun, long shadows, orange horizon |
| `sunset` | Sun on the horizon, red light, purple sky behind |
| `overcast` | Gray sky, soft light, faint shadows |
| `dawn_mist` | Pale low sun, mist on the ground |
| `night` | Moon, stars, blue light, bright enough to play in |
| `desert` | Hard sun, dusty horizon, warm bounce |
| `snow` | Cold clear sky, blue shadows |
| `studio` | Even backdrop, key light, strong fill: one model, a menu scene |
| `interior` | No sun, dim even light: a room that its lamps light |

`look.fade_to("night", 3.0)` moves everything to another look and returns the `Tween`. `look.set_values({"sky_top": Color(0.3, 0.2, 0.5), "fog": 0.01})` changes single values of the look that shows; `WasdLookPresets.BASE` in `look_presets.gd` names them all.

## Adjust

Setting `look` also sets the sun's place and `clouds`; change them after it.

- `sun_azimuth`: compass direction the sun shines from, in degrees (0 from -Z, 90 from +X). `sun_elevation`: degrees above the horizon; under 5 the light fades, at 0 it is out. Put the sun to the side of or behind what the camera looks at, so that shadows show its shape.
- `clouds` 0 to 1; `cloud_drift` (1 a light wind, 0 still) and `cloud_heading`.
- `sun_strength`, `ambient_strength`, `fog_strength`, `exposure`: multiply the look's values; 1 keeps them. Dark shadows: raise `ambient_strength`. Everything too dark or bright: `exposure`.
- `view_distance`: meters at which the world has faded into the sky. Set it to where the terrain or level ends (and the camera's `far` beyond it), or the world's edge shows as a line against the sky.
- `look.get_horizon_color()` is the color the far world fades into, and the signal `applied` fires whenever the picture's values change, also at every step of a fade or a running day: hand the color on there to whatever fades by its own means, such as a WASD Light fog bank. `look.get_haze_range()` is where such a fade begins and ends to keep step with the fog; the guide of `lite-terrain` has the two lines for its ground.
- `overcast` (0 to 1) clouds any look or hour over: gray sky, weak sun, closed clouds. `added_fog` thickens the fog by a density per meter: 0.005 veils the distance, 0.03 hides everything beyond 80 meters, sky included. The `wasd-weather` add-on sets both, and its wind turns the clouds (`look.set_wind(wind)`).
- `shadows`, and `quality`: Fast, Balanced (default), Best set edge smoothing (off, 2x, 4x), shadow softness, and how far the sun's shadows reach (40, 80, 140 m; for more, set `look.sun.directional_shadow_max_distance` after `add_child` and after each change of `quality`). Balanced and Best keep shadows fine within 2 m of the camera, for faces in close-ups. "Leave as set" (3) keeps the project's settings.

## A day that runs

```gdscript
look.hour = 8.0          # 0 to 24; -1 (default) is no clock
look.day_minutes = 12.0  # a whole day in 12 minutes; 0 holds the hour
look.night_changed.connect(func(is_night: bool) -> void: street_lamps.visible = is_night)
```

The sun rises at 6 and sets at 18, the moon takes the other half; the looks blend through `day_looks`, pairs of an hour and a look. `day_peak_elevation` and `day_peak_azimuth` place the arc. `look.is_night()` tells which light is up. `clouds` stays as set. Setting `look` or calling `fade_to()` stops the clock (`hour` -1): set `hour` again to run it.

## A photographed sky

A real sky lights and reflects better than a drawn one. Get an HDRI with `polyhaven_search` and `polyhaven_download`, or with `ambientcg_search` and `ambientcg_download`, whose panorama is an `.exr` (type hdris; 1k or 2k for Web builds), then:

```gdscript
look.look = "golden_hour"                      # the look nearest the picture: it gives the sun's color, fog, exposure
look.panorama = load("res://skies/kloppenheim_06_2k.hdr")
look.find_sun_in_panorama()                    # the sun takes the place of the picture's brightest spot
```

The picture is shown as bright as the look's own sky whatever its exposure; `panorama_brightness` multiplies it and `panorama_turn` turns it (call `find_sun_in_panorama()` again). Under an overcast picture, with no sun to find, set the sun's place by hand. `look.panorama = null` brings the drawn sky back.

## Lamps

Lights without shadows need nothing: set energy as usual. A light that casts shadows goes through the node:

```gdscript
look.set_shadowed_light($Lamp, 3.0, Color(1.0, 0.8, 0.6))   # node, energy, color
```

In a Web build each such light is drawn as a picture of its own and added to the rest, which shows it brighter than its energy says, the more so the brighter the scene: by day as bright as a light of two to eight times the energy. The call sets the energy and color that show the same on every renderer; call it again after the look changes. Give shadows to the one or two lamps that matter: each costs a pass over what it lights, and where several overlap they still add up too bright.

## What the node owns

Do not set these on `look.environment`, `look.sun`, or `look.bounce`: the sky, tone mapping (AgX), exposure, glow, fog, contrast, saturation, ambient light, the sun's energy, color, and direction. The node writes them again at every change. Glow is on in every look, and only what is brighter than white glows, in a tight halo: give a lamp's bulb or a screen an emission energy above 2. `environment.background_energy_multiplier` and `ambient_light_energy` do not do what their names say for a sky; use `ambient_strength`.

`look.sun.light_energy` is lower in a Web build than the look's value on purpose, and its color differs: do not copy it to other lights.

## Pitfalls

- A black or burnt-out picture after adding the node: another `WorldEnvironment` or sun is still in the scene, or a material is unshaded.
- Web builds show the darkest tones darker than desktop Forward+ does. In `night` and `interior` keep what matters lit by the moon or a lamp.
- Indoors under an outdoor look the sky's light comes through the ceiling: use `interior` and lamps.
- Reflections on metal and water come from the sky; a level with a roof wants a `ReflectionProbe`.

## Check it

`godot_run`, then `godot_screenshot` facing the sun's side and away from it: lit and shaded sides differ clearly, shadows are neither black nor gone, and the far ground meets the sky without a line. Run once with `web: true`: the picture matches the desktop one.
