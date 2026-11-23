# SPDX-License-Identifier: CC0-1.0
# The looks WasdLook3D knows by name: each is a whole lighting setup, with a sky, a sun, bounce light, fog, exposure,
# and glow. Light energies are given as the Forward+ and Mobile renderers take them; WasdLook3D works out what the
# Compatibility renderer needs to show the same picture.
class_name WasdLookPresets
extends RefCounted

## Every value of a look, with the value a look takes when it does not name its own.
const BASE := {
	# Sky: colors at the top, at the horizon, of the ground at the horizon and below, and its brightness.
	"sky_top": Color(0.20, 0.40, 0.80), "sky_horizon": Color(0.62, 0.76, 0.92),
	"ground_horizon": Color(0.52, 0.56, 0.58), "ground_bottom": Color(0.18, 0.17, 0.15), "sky_energy": 1.0,
	# Clouds from 0 (clear) to 1 (covered), their color, and stars from 0 to 1.
	"clouds": 0.35, "cloud_color": Color(1.0, 1.0, 1.0), "stars": 0.0,
	# The sun (or moon): on or off, color, energy, degrees above the horizon, and compass direction it shines from;
	# degrees across its disc, and how far its glow reaches (1 on a clear day, 3 in haze).
	"sun": true, "sun_color": Color(1.0, 0.96, 0.90), "sun_energy": 1.5, "sun_elevation": 55.0, "sun_azimuth": -35.0,
	"sun_size": 1.2, "sun_glow": 1.0,
	# Light from the sky on everything, and light that the ground throws back up.
	"ambient": 0.9, "bounce_color": Color(0.55, 0.50, 0.42), "bounce": 0.25,
	# Fog by distance, in the color of the horizon, and a second layer that lies on the ground below `mist_height`
	# meters.
	"fog": 0.0015, "mist": 0.0, "mist_height": 4.0,
	# The picture: brightness, contrast, color strength, how much bright things glow, and contact shading.
	"exposure": 1.0, "contrast": 1.06, "saturation": 1.0, "glow": 0.5, "contact_shading": true,
}

## The looks by name.
const LOOKS := {
	## A clear day with the sun high.
	"noon": {},
	## The hour before sunset: a low warm sun, long shadows, an orange horizon.
	"golden_hour": {
		"sky_top": Color(0.17, 0.26, 0.62), "sky_horizon": Color(0.96, 0.70, 0.46), "ground_horizon": Color(0.62, 0.50, 0.40),
		"sun_color": Color(1.0, 0.74, 0.46), "sun_energy": 2.2, "sun_elevation": 13.0, "sun_glow": 2.2, "ambient": 0.75,
		"bounce_color": Color(0.62, 0.46, 0.32), "bounce": 0.3, "fog": 0.003,
		"clouds": 0.45, "cloud_color": Color(1.0, 0.80, 0.62), "glow": 0.7, "exposure": 0.88, "contrast": 1.08, "saturation": 0.93,
	},
	## The sun on the horizon: red light from one side, a dark blue sky above and behind.
	"sunset": {
		"sky_top": Color(0.16, 0.20, 0.42), "sky_horizon": Color(0.98, 0.56, 0.30), "ground_horizon": Color(0.42, 0.32, 0.30),
		"sun_color": Color(1.0, 0.60, 0.36), "sun_energy": 1.5, "sun_elevation": 5.0, "sun_glow": 2.6, "ambient": 0.7,
		"bounce_color": Color(0.5, 0.34, 0.28), "bounce": 0.25, "fog": 0.004,
		"clouds": 0.35, "cloud_color": Color(0.98, 0.70, 0.58), "glow": 0.8,
	},
	## A gray day: soft light from everywhere, faint shadows.
	"overcast": {
		"sky_top": Color(0.50, 0.55, 0.62), "sky_horizon": Color(0.74, 0.77, 0.80), "ground_horizon": Color(0.56, 0.58, 0.60),
		"sun_color": Color(0.95, 0.97, 1.0), "sun_energy": 0.45, "sun_elevation": 50.0, "ambient": 1.25,
		"bounce_color": Color(0.5, 0.5, 0.5), "bounce": 0.2, "fog": 0.005,
		"clouds": 1.0, "cloud_color": Color(0.86, 0.88, 0.90), "saturation": 0.94, "glow": 0.3,
	},
	## Early morning: a pale low sun and mist on the ground.
	"dawn_mist": {
		"sky_top": Color(0.42, 0.52, 0.72), "sky_horizon": Color(0.96, 0.82, 0.76), "ground_horizon": Color(0.70, 0.66, 0.66),
		"sun_color": Color(1.0, 0.84, 0.72), "sun_energy": 0.9, "sun_elevation": 9.0, "sun_glow": 2.4, "ambient": 0.85,
		"bounce_color": Color(0.6, 0.55, 0.52), "bounce": 0.2, "fog": 0.010,
		"mist": 0.06, "mist_height": 6.0, "clouds": 0.3, "cloud_color": Color(1.0, 0.90, 0.86), "contrast": 1.0, "glow": 0.6,
	},
	## A night under the moon, bright enough to play in: blue light, stars, bright things glow.
	"night": {
		"sky_top": Color(0.03, 0.05, 0.12), "sky_horizon": Color(0.09, 0.14, 0.26), "ground_horizon": Color(0.05, 0.07, 0.12),
		"ground_bottom": Color(0.02, 0.02, 0.04), "sun_color": Color(0.56, 0.68, 1.0), "sun_energy": 0.75, "sun_elevation": 42.0,
		"sun_size": 2.6, "sun_glow": 0.6, "ambient": 2.2, "bounce_color": Color(0.2, 0.26, 0.4), "bounce": 0.12, "fog": 0.004,
		"clouds": 0.2, "cloud_color": Color(0.26, 0.31, 0.44), "stars": 1.0, "glow": 1.0, "saturation": 0.96,
	},
	## Dry heat: a hard sun, pale dusty horizon, warm bounce from sand.
	"desert": {
		"sky_top": Color(0.20, 0.44, 0.84), "sky_horizon": Color(0.86, 0.82, 0.72), "ground_horizon": Color(0.80, 0.70, 0.54),
		"ground_bottom": Color(0.50, 0.40, 0.28), "sun_color": Color(1.0, 0.95, 0.84), "sun_energy": 1.9, "sun_elevation": 62.0,
		"ambient": 0.8, "bounce_color": Color(0.86, 0.70, 0.46), "bounce": 0.4, "fog": 0.0025,
		"clouds": 0.08, "contrast": 1.1,
	},
	## Snow under a clear cold sky: bright ground, blue shadows.
	"snow": {
		"sky_top": Color(0.24, 0.46, 0.84), "sky_horizon": Color(0.80, 0.88, 0.96), "ground_horizon": Color(0.90, 0.93, 0.97),
		"ground_bottom": Color(0.70, 0.76, 0.84), "sun_color": Color(1.0, 0.97, 0.94), "sun_energy": 1.3, "sun_elevation": 28.0,
		"ambient": 1.1, "bounce_color": Color(0.80, 0.88, 1.0), "bounce": 0.45, "fog": 0.003,
		"clouds": 0.25, "saturation": 0.98,
	},
	## A photo studio: an even backdrop, a key light with soft shadows, strong fill. For showing a model or a menu scene.
	"studio": {
		"sky_top": Color(0.42, 0.44, 0.48), "sky_horizon": Color(0.52, 0.54, 0.58), "ground_horizon": Color(0.52, 0.54, 0.58),
		"ground_bottom": Color(0.42, 0.44, 0.48), "sun_color": Color(1.0, 0.98, 0.95), "sun_energy": 1.2, "sun_elevation": 48.0,
		"sun_azimuth": -40.0, "ambient": 1.0, "bounce_color": Color(0.8, 0.82, 0.88), "bounce": 0.35, "fog": 0.0,
		"clouds": 0.0, "contrast": 1.04, "saturation": 1.0, "glow": 0.3,
	},
	## Indoors with no sun: dim even light from everywhere, so that the room's own lamps do the lighting and glow.
	"interior": {
		"sky_top": Color(0.15, 0.15, 0.16), "sky_horizon": Color(0.17, 0.17, 0.18), "ground_horizon": Color(0.17, 0.17, 0.18),
		"ground_bottom": Color(0.15, 0.15, 0.15), "sun": false, "ambient": 3.4, "bounce_color": Color(0.5, 0.45, 0.4), "bounce": 0.0,
		"fog": 0.0, "clouds": 0.0, "glow": 0.9, "contrast": 1.08,
	},
}


## The names of the looks, in the order above.
static func names() -> PackedStringArray:
	return PackedStringArray(LOOKS.keys())


## Every value of a look; an unknown name gives "noon".
static func values(look: String) -> Dictionary:
	var result := BASE.duplicate()
	result.merge(LOOKS.get(look, {}), true)
	return result


## The values between two sets of values: `weight` 0 gives `from`, 1 gives `to`. The sun's compass direction turns
## the short way round, and a value that is on or off switches halfway.
static func blend(from: Dictionary, to: Dictionary, weight: float) -> Dictionary:
	var result := {}
	for key: String in to:
		var a: Variant = from.get(key, to[key])
		var b: Variant = to[key]
		if a is bool:
			result[key] = b if weight >= 0.5 else a
		elif key == "sun_azimuth":
			result[key] = float(a) + wrapf(float(b) - float(a), -180.0, 180.0) * weight
		else:
			result[key] = lerp(a, b, weight)
	return result


## A set of values under a sky clouded over by `amount` (0 to 1): the sky's colors go gray and darker, the sun and
## the light bounced from the ground weaken, the sky's own light counts for more, clouds turn gray, stars go, and
## the air grows a little hazier. It works on a day's values as on a night's.
static func clouded(values: Dictionary, amount: float) -> Dictionary:
	var result := values.duplicate()
	for key: String in ["sky_top", "sky_horizon", "ground_horizon"]:
		var color: Color = values[key]
		var gray := color.r * 0.3 + color.g * 0.59 + color.b * 0.11
		result[key] = color.lerp(Color(gray * 0.8, gray * 0.82, gray * 0.86), amount * 0.9)
	var cloud: Color = values["cloud_color"]
	var cloud_gray := (cloud.r * 0.3 + cloud.g * 0.59 + cloud.b * 0.11) * 0.8
	result["cloud_color"] = cloud.lerp(Color(cloud_gray, cloud_gray * 1.02, cloud_gray * 1.05), amount * 0.85)
	result["sun_energy"] = float(values["sun_energy"]) * (1.0 - 0.8 * amount)
	result["bounce"] = float(values["bounce"]) * (1.0 - 0.6 * amount)
	# The sky's own light counts for more under clouds, and for most where it is dark already: a night under clouds
	# stays bright enough to play in.
	var horizon: Color = values["sky_horizon"]
	var dark := 1.0 - clampf((horizon.r * 0.3 + horizon.g * 0.59 + horizon.b * 0.11) * 2.5, 0.0, 1.0)
	result["ambient"] = float(values["ambient"]) * (1.0 + (0.35 + 1.3 * dark) * amount)
	result["sun_glow"] = float(values["sun_glow"]) * (1.0 - 0.6 * amount)
	result["stars"] = float(values["stars"]) * (1.0 - amount)
	result["fog"] = float(values["fog"]) * (1.0 + 0.5 * amount) + 0.0005 * amount
	result["saturation"] = float(values["saturation"]) * (1.0 - 0.08 * amount)
	return result
