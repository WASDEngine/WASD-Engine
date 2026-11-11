---
name: sky3d
description: Sky3D 2.1.0 is installed in this project. It gives a 3D scene a day/night cycle from one Sky3D node (a WorldEnvironment), with a sky shader, a sun, a moon, stars, clouds, fog, and game time that drives the sun and moon lights. Load before you add a sky, time of day, or day/night lighting to a 3D scene.
---

# Sky3D 2.1.0

## What it adds

- The node `Sky3D` (class `Sky3D` extends `WorldEnvironment`; script `res://addons/sky_3d/src/Sky3D.gd`). It is the scene's only WorldEnvironment: remove any other.
- When it enters the tree, it creates whatever is missing: its `environment` (sky shader, ACES tonemap, sky ambient light), `camera_attributes`, and the children `SunLight` and `MoonLight` (DirectionalLight3D), `SkyDome` (class `SkyDome`), and `TimeOfDay` (class `TimeOfDay`). Reach them as `sky3d.sun`, `sky3d.moon`, `sky3d.sky`, and `sky3d.tod`.
- Sky3D sets the sun and moon light energy, colour, and direction on every time update. Change them through Sky3D or SkyDome, not on the light nodes.

## API

On `Sky3D`:

- Time: `current_time` (hours, 0 to 23.99; values outside wrap), `game_time_enabled` (time runs in game; default true), `minutes_per_day` (real minutes per game day; default 15; negative runs backwards), `update_interval` (seconds; default 0.016), `game_time` and `game_date` (strings such as "12:00:00"), `is_day()`, `is_night()`, `pause()`, `resume()`.
- Look: `sun_energy`, `moon_energy`, `skydome_energy`, `cloud_intensity`, `camera_exposure`, `tonemap_exposure`, `sky_contribution`, `ambient_energy`, `night_ambient_boost`, `night_sky_contribution`, `sun_shadow_opacity`, `wind_speed`, `wind_direction`.
- Switches: `sky_enabled`, `clouds_enabled`, `fog_enabled`, `lights_enabled`, `show_sky()`, `hide_sky()`.

On `sky3d.tod` (TimeOfDay):

- `set_time(hour, minute, second)`, `day`, `month`, `year`, `get_datetime_dict()`, `set_from_datetime_dict(d)`.
- `latitude` and `longitude` (radians), `utc`, `celestials_calculations` (`TimeOfDay.CelestialMode.REALISTIC` by default, or `SIMPLE`), `system_sync`.
- Signals: `time_changed(value)`, `minute_changed(value)`, `hour_changed(value)`, `day_changed(value)`, `month_changed(value)`, `year_changed(value)`.

On `sky3d.sky` (SkyDome):

- Signal `day_night_changed(value)` (true = day).
- `cumulus_visible`, `cumulus_coverage`, `cumulus_intensity`, `cirrus_visible`, `cirrus_coverage`, `fog_visible`, `fog_density`, `fog_start`, `fog_end`, `sun_disk_size`, `moon_size`, `sun_light_color`, `sun_horizon_light_color`, `moon_light_color`, `atm_day_tint`, `atm_night_tint`.

## Minimal example

`res://world.tscn`:

```
[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://world.gd" id="1_world"]
[ext_resource type="Script" path="res://addons/sky_3d/src/Sky3D.gd" id="2_sky"]

[node name="World" type="Node3D"]
script = ExtResource("1_world")

[node name="Sky3D" type="WorldEnvironment" parent="."]
script = ExtResource("2_sky")

[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.9848077, 0.17364818, 0, -0.17364818, 0.9848077, 0, 1.7, 0)
```

`res://world.gd`:

```gdscript
extends Node3D

@onready var sky: Sky3D = $Sky3D

func _ready() -> void:
	sky.current_time = 7.5          # 07:30
	sky.minutes_per_day = 10.0      # one game day = 10 real minutes
	sky.game_time_enabled = true
	sky.tod.hour_changed.connect(_on_hour)
	sky.sky.day_night_changed.connect(func(is_day: bool): print("day" if is_day else "night"))

func _on_hour(hour: int) -> void:
	print("hour ", hour)
```

## Set time and look properties from code

Properties written on the Sky3D node in a `.tscn`, such as `current_time`, `game_time_enabled`, `minutes_per_day`, and `sun_energy`, are silently dropped. They forward to the child nodes, which do not exist yet while the scene loads; a scene with `current_time = 12.0` on the Sky3D node starts at 8.0. Set them in `_ready()` of a parent node, as above (children are ready first). Alternatively, write a `TimeOfDay` child in the `.tscn` that carries its own properties; Sky3D uses an existing child:

```
[ext_resource type="Script" path="res://addons/sky_3d/src/TimeOfDay.gd" id="3_tod"]

[node name="TimeOfDay" type="Node" parent="Sky3D"]
script = ExtResource("3_tod")
current_time = 12.0
game_time_enabled = false
dome_path = NodePath("../SkyDome")
```

## Verify in WASD Engine

- Freeze time for a check with `sky.game_time_enabled = false`, set `sky.current_time`, then wait a few frames.
- Read the state with `godot_eval`: `scene.get_node("Sky3D").sun.light_energy`, `scene.get_node("Sky3D").is_day()`, and `scene.get_node("Sky3D").tod.game_time`. Look with `godot_screenshot`.
- Measured with the default settings (latitude 16°, 1 January): at 12:00 the sun's `light_energy` is 1.0 and its light points down (`-sun.global_transform.basis.z` has y < 0), with a blue sky and clouds. At 00:00 `light_energy` is 0, `is_night()` is true, the sky shows stars, and the ground is dark.

## Pitfalls

- The default day lasts 15 real minutes and time runs from the start. Set `minutes_per_day` and `game_time_enabled` deliberately.
- Sky3D replaces a `PhysicalSkyMaterial` sky with its own shader. Do not assign your own sky, a second WorldEnvironment, or light rotations.
- Web exports use the Compatibility renderer. Sky3D renders there, but the ground looks brighter. Its README suggests `sky.sky_contribution = 0.75` and `sky.sky.fog_density = 0.01` to match Forward+.
- The star map texture is licensed CC BY 4.0. Put this line in the game's credits: "The Milky Way panorama by ESO/S. Brunier, licensed under CC BY 4.0, used in original and modified forms."
- Sky3D is for 3D scenes only. Do not use it in a 2D game.
