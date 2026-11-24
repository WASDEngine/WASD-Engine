---
name: wasd-weather
description: WASD Weather 1.0.0 is installed in this project. One WasdWeather3D node gives rain, drizzle, storms with lightning, snow, blizzards, and fog by name, with a wind that clouds, grass, smoke, and cloth share, and snow, wetness, and puddles left on what it covers, on every renderer and in Web builds. Load before adding rain, snow, a storm, fog that comes and goes, wind, or wet and snowy ground.
---

# WASD Weather 1.0.0

`res://addons/wasd_weather/` (CC0, written by WASD Engine; a global class, no plugin to enable). `WasdWeather3D` is a scene's weather: what falls, how the sky and the air look, the wind, and what the weather leaves on the ground. Rain and snow are cards that a shader moves in a box of air round the camera: no particle system, nothing to place. A landscape with terrain, grass, and a lake runs at 60 fps in a Web build through every weather.

Install `wasd-look` with it and light the scene with a `WasdLook3D`: the weather clouds its sky over, weakens its sun, and thickens its fog. Without one only what falls, blows, and lies changes, and rain falls from a blue sky.

## Add it

```gdscript
var weather := WasdWeather3D.new()
add_child(weather)
weather.cover($Level)        # what snow and rain may lie on
weather.weather = "rain"     # comes over weather.change_seconds (8)
```

## Weathers

| Weather | Falls | Sky and air | Wind, m/s |
|---|---|---|---|
| `clear` | nothing | as the look has them | 1 |
| `cloudy` | nothing | mostly clouded | 2 |
| `drizzle` | light rain | gray, a little haze | 2 |
| `rain` | steady rain | gray, the distance veiled | 4 |
| `storm` | heavy rain, lightning about six times a minute | dark, nothing beyond about 250 m | 10 |
| `snow` | steady snow | gray, the distance veiled | 1.5 |
| `blizzard` | driving snow | white, nothing beyond about 100 m | 12 |
| `fog` | nothing | thick fog, nothing beyond about 70 m, the sky gone | 0.5 |

`weather.fade_to("storm", 20.0)` changes over seconds of its own. `weather.get_rain()` and `get_snow()` tell how much falls now (0 to 1), and the signal `weather_changed(name)` fires when a change begins. A game's own forecast is a timer that sets `weather`.

## What lies: cover

`weather.cover(root)` lets wetness and snow lie on every mesh and CSG shape under `root`, also on those that come under it later, such as terrain that loads as the player walks. While things are wet or snowy each of them is drawn once more with the pack's cover; dry and clear, nothing is.

- `weather.wetness` and `weather.snow_cover` run from 0 to 1. Rain and snow raise them over `settle_seconds` (40 of the heaviest), and they dry and melt `clear_slowness` (3) times slower. Set them to begin soaked or snowed in: `weather.snow_cover = 1.0`.
- Wet: everything darkens and shines. From a wetness of about 0.3, puddles stand on level ground, a third of it when soaked; they mirror the sky and the lamps, and rain ruffles them.
- Snow: on what faces up, first in patches, then closed; walls stay bare.
- Left bare: see-through materials, also shaders that write ALPHA, such as `wasd-materials`' cut-outs and glass, the nodes of other WASD packs (water, effects, light, marks), and every node in the group `wasd_weather_bare` with all under it. `weather.uncover(root)` takes the cover off.
- With `lite-terrain` and `simple-grass-textured` the snow buries the grass by itself. A GridMap, and a mesh whose own shader moves its vertices, cannot take the cover: tint or swap those from `weather.snow_cover` in your own code.

## Rain on level ground

`weather.splashes = true` and `weather.ground = 0.0` (the ground's height) draw rings and small splashes where drops land: streets, yards, decks. Leave them off over hills.

## Under a roof

The rain does not know roofs. Set `weather.sheltered = true` while the camera is indoors or under cover, from an Area3D at the door or from the game's own room logic: nothing falls before the camera then, and sky, fog, wind, and lightning go on. Seen from outside, rain still falls through an open shed.

## Lightning and sound

Storms strike by themselves; `weather.strike()` strikes on cue. Each strike flashes over ground and sky and emits `lightning(seconds_to_thunder)`:

```gdscript
weather.lightning.connect(func(seconds: float) -> void:
	await get_tree().create_timer(seconds).timeout
	$Thunder.play())
```

The pack has no sounds. Make a rain loop and thunder with `elevenlabs_sound_effect` and set the loop's volume from the rain: `$Rain.volume_db = linear_to_db(maxf(weather.get_rain(), 0.001))`.

## Wind

`wind_heading` is the compass direction the wind blows toward (0 toward -Z, 90 toward +X), `wind_strength` multiplies every weather's wind. It moves by itself: the rain's and the snow's slant, the clouds of WASD Look, the smoke, steam, and flames of WASD FX, and the grass of SimpleGrassTextured.

Whatever else should feel it joins the group `wasd_wind` and is told through `set_wind(wind: Vector3)`, in meters a second along the world's axes, whenever the wind changes. `WasdClothWind3D`, `WasdDust3D`, and `WasdFogBank3D` have the method: `$Flags/Wind.add_to_group("wasd_wind")`. A node of the game's own needs only the method. `weather.get_wind()` is the wind this moment with its gusts, for sails and other forces the game applies itself.

## With WASD Look

The weather sets the look's `overcast` and `added_fog`; leave both alone while a weather node is in the scene, and shape the rest as ever: `look.look = "night"` under a storm, a running day under passing showers. The rain is lit by the look's light, so it dims at night. With `lite-terrain`, hand the look's haze to the ground as its guide shows, or thick fog stops at the terrain.

## Pitfalls

- Rain and snow show against what is darker than they are: walls, trees, a night sky. Against a bright overcast sky they are faint, as in life. Judge them with something dark in view.
- Snow that lies only on rocks and props: the ground was not under the node given to `cover()`, or it is a GridMap.
- The box of air follows the viewport's current camera. A second view in a SubViewport has no rain of its own.
- A lamp in the rain wants a `WasdHalo3D` from `wasd-light`: the pack draws no glow round lights.
- Water is left bare: a lake does not freeze, and snow does not lie on it.

## Check it

`godot_run`, set `weather.wetness = 1.0` or wait, then `godot_screenshot` with dark ground or a wall in view: streaks in the air, puddles that mirror the sky, a gray sky. Set `weather.snow_cover = 1.0` and look again: white on every top, bare walls. Run once with `web: true`.
