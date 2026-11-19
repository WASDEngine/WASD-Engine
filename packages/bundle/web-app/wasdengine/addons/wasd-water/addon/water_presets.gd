# SPDX-License-Identifier: CC0-1.0
# The looks WasdWater3D knows by name. A preset first puts every look and wave property back to DEFAULTS and then
# sets its own values, so a preset always looks the same; properties set after it change that look. Presets leave the
# water's shape, size, and quality alone.
class_name WasdWaterPresets
extends RefCounted

## The value of every look and wave property before a preset changes it. This is the "lake" look.
const DEFAULTS := {
	"shallow_color": Color(0.32, 0.72, 0.60),
	"deep_color": Color(0.02, 0.15, 0.14),
	"color_depth": 3.0,
	"clarity": 20.0,
	"color_steps": 0,
	"glow": 0.0,
	"scatter_color": Color(0.10, 0.70, 0.55),
	"scatter_strength": 0.0,
	"fast_opacity": 0.75,
	"roughness": 0.05,
	"reflectivity": 1.0,
	"refraction": 1.0,
	"surface_scale": 1.5,
	"surface_strength": 0.3,
	"surface_speed": 0.15,
	"glint_strength": 0.7,
	"glint_size": 0.12,
	"glint_hardness": 0.0,
	"glint_sparkle": 0.25,
	"flat_shading": false,
	"pixel_size": 0.0,
	"reflection": 1,
	"reflection_steps": 24,
	"reflection_distance": 80.0,
	"reflection_distortion": 0.6,
	"wave_height": 0.05,
	"wave_length": 4.0,
	"wave_direction": 30.0,
	"wave_spread": 80.0,
	"wave_count": 10,
	"wave_chop": 0.5,
	"wave_steepness": 0.5,
	"wave_speed": 1.0,
	"flow": Vector2.ZERO,
	"foam_color": Color(0.90, 0.93, 0.95),
	"foam_scale": 3.0,
	"foam_speed": 0.1,
	"foam_stretch": 1.0,
	"foam_hardness": 0.35,
	"shore_foam_width": 0.15,
	"shore_foam": 0.3,
	"shore_foam_lines": 0.0,
	"crest_foam": 0.0,
	"foam_trail": 2.5,
	"foam_trail_waves": 3,
	"slope_foam": 0.0,
	"caustics": 0.4,
	"caustics_scale": 2.5,
	"caustics_depth": 4.0,
	"edge_fade": 0.15,
	"underwater_color": Color(0.05, 0.32, 0.30),
	"underwater_fog_density": 0.08,
}

## Each preset's changes to DEFAULTS.
const PRESETS := {
	# A calm, clear lake under a light breeze, which mirrors its shores.
	"lake": {},
	# A still forest pool one sees far into, tinted green, a mirror for the trees around it.
	"spring": {
		"shallow_color": Color(0.50, 0.76, 0.58), "deep_color": Color(0.01, 0.06, 0.05), "color_depth": 1.6, "clarity": 12.0,
		"roughness": 0.03, "surface_scale": 1.2, "surface_strength": 0.35, "surface_speed": 0.08,
		"wave_height": 0.03, "wave_length": 2.5, "wave_count": 10, "shore_foam": 0.3, "shore_foam_width": 0.12,
		"caustics": 0.7, "caustics_scale": 1.6, "caustics_depth": 1.5, "reflection_distortion": 0.8, "glint_sparkle": 0.4,
		"underwater_color": Color(0.08, 0.34, 0.22), "underwater_fog_density": 0.05,
	},
	# A small, still, greenish pond one barely sees into.
	"pond": {
		"shallow_color": Color(0.42, 0.55, 0.25), "deep_color": Color(0.06, 0.12, 0.04), "color_depth": 1.2, "clarity": 3.0,
		"roughness": 0.06, "surface_scale": 1.5, "surface_strength": 0.15, "surface_speed": 0.05,
		"wave_height": 0.01, "wave_length": 1.5, "wave_count": 6, "shore_foam": 0.0, "caustics": 0.1,
		"underwater_color": Color(0.10, 0.22, 0.08), "underwater_fog_density": 0.35,
	},
	# A river: a current carries the ripples and the foam, and steep stretches turn white.
	"river": {
		"shallow_color": Color(0.35, 0.68, 0.55), "deep_color": Color(0.03, 0.16, 0.14), "color_depth": 2.0, "clarity": 9.0,
		"surface_scale": 1.8, "surface_strength": 0.5, "surface_speed": 0.2,
		"wave_height": 0.04, "wave_length": 2.0, "wave_count": 8, "wave_direction": 0.0, "wave_spread": 50.0,
		"flow": Vector2(0.0, 1.5), "foam_scale": 2.0, "foam_speed": 0.0, "foam_stretch": 2.5,
		"shore_foam_width": 0.3, "shore_foam": 0.5, "slope_foam": 0.9, "caustics": 0.3, "underwater_fog_density": 0.12,
	},
	# A calm, deep blue sea with a low swell and hardly any foam.
	"calm_sea": {
		"shallow_color": Color(0.12, 0.64, 0.62), "deep_color": Color(0.004, 0.07, 0.16), "color_depth": 8.0, "clarity": 20.0,
		"scatter_color": Color(0.10, 0.70, 0.55), "scatter_strength": 0.35, "roughness": 0.2, "reflectivity": 0.7,
		"surface_scale": 1.5, "surface_strength": 0.2, "surface_speed": 0.25, "glint_strength": 1.0, "glint_sparkle": 0.8,
		"reflection": 0,
		"wave_height": 0.5, "wave_length": 22.0, "wave_count": 20, "wave_chop": 0.6, "wave_spread": 60.0, "wave_steepness": 0.6,
		"foam_scale": 3.5, "foam_stretch": 1.6, "shore_foam_width": 1.0, "shore_foam": 0.7, "shore_foam_lines": 1.0,
		"crest_foam": 0.15, "caustics": 0.3, "caustics_scale": 3.5,
		"underwater_color": Color(0.02, 0.22, 0.36), "underwater_fog_density": 0.05,
	},
	# Open sea with a rolling swell: light shines through the crests, and foam trails behind the ones that break.
	"ocean": {
		"shallow_color": Color(0.10, 0.62, 0.60), "deep_color": Color(0.004, 0.07, 0.15), "color_depth": 8.0, "clarity": 18.0,
		"scatter_color": Color(0.08, 0.62, 0.50), "scatter_strength": 0.9, "roughness": 0.22, "reflectivity": 0.75,
		"surface_scale": 1.2, "surface_strength": 0.3, "surface_speed": 0.3,
		"glint_strength": 1.0, "glint_size": 0.2, "glint_sparkle": 1.0, "reflection": 0,
		"wave_height": 2.2, "wave_length": 42.0, "wave_count": 24, "wave_chop": 0.6, "wave_spread": 75.0, "wave_steepness": 0.9,
		"foam_color": Color(0.88, 0.92, 0.94), "foam_scale": 5.0, "foam_stretch": 1.6, "foam_hardness": 0.1,
		"shore_foam_width": 1.4, "shore_foam": 0.8, "shore_foam_lines": 1.0, "crest_foam": 0.5, "foam_trail": 3.5,
		"caustics": 0.3, "caustics_scale": 4.0, "underwater_color": Color(0.02, 0.22, 0.36), "underwater_fog_density": 0.05,
	},
	# A heavy, dark sea in a gale, streaked with foam.
	"storm": {
		"shallow_color": Color(0.20, 0.42, 0.42), "deep_color": Color(0.008, 0.04, 0.055), "color_depth": 5.0, "clarity": 6.0,
		"scatter_color": Color(0.18, 0.48, 0.42), "scatter_strength": 0.8, "roughness": 0.4, "reflectivity": 0.5,
		"surface_scale": 1.5, "surface_strength": 0.25, "surface_speed": 0.6, "glint_strength": 0.4, "reflection": 0,
		"wave_height": 5.0, "wave_length": 75.0, "wave_count": 28, "wave_chop": 0.8, "wave_spread": 45.0,
		"wave_steepness": 1.1, "wave_speed": 1.05,
		"foam_color": Color(0.80, 0.84, 0.84), "foam_scale": 6.0, "foam_speed": 0.3, "foam_stretch": 2.0, "foam_hardness": 0.1,
		"shore_foam_width": 2.0, "shore_foam": 0.9, "crest_foam": 0.7, "foam_trail": 5.0, "foam_trail_waves": 5,
		"caustics": 0.0, "underwater_color": Color(0.03, 0.12, 0.14), "underwater_fog_density": 0.2,
	},
	# A turquoise lagoon over sand: very clear, bright caustics, lines of foam on the beach.
	"tropical": {
		"shallow_color": Color(0.20, 0.90, 0.80), "deep_color": Color(0.00, 0.32, 0.50), "color_depth": 6.0, "clarity": 30.0,
		"scatter_color": Color(0.20, 0.95, 0.80), "scatter_strength": 0.6, "roughness": 0.12, "reflectivity": 0.7,
		"surface_scale": 2.0, "surface_strength": 0.25, "glint_strength": 1.0, "glint_sparkle": 0.6, "reflection": 0,
		"wave_height": 0.35, "wave_length": 12.0, "wave_count": 16, "wave_chop": 0.55, "wave_steepness": 0.6,
		"shore_foam_width": 0.9, "shore_foam": 0.9, "shore_foam_lines": 2.0, "crest_foam": 0.15,
		"caustics": 1.0, "caustics_scale": 2.0, "caustics_depth": 7.0,
		"underwater_color": Color(0.05, 0.55, 0.60), "underwater_fog_density": 0.03,
	},
	# Still, brown-green swamp water one cannot see into.
	"swamp": {
		"shallow_color": Color(0.45, 0.42, 0.15), "deep_color": Color(0.10, 0.11, 0.04), "color_depth": 0.5, "clarity": 0.8,
		"roughness": 0.12, "reflectivity": 0.8, "refraction": 0.4,
		"surface_scale": 1.5, "surface_strength": 0.1, "surface_speed": 0.03, "glint_strength": 0.5, "glint_size": 0.3,
		"wave_height": 0.0, "wave_count": 0, "foam_color": Color(0.55, 0.62, 0.30), "shore_foam_width": 0.25, "shore_foam": 0.45,
		"foam_speed": 0.03, "caustics": 0.0, "underwater_color": Color(0.16, 0.18, 0.06), "underwater_fog_density": 0.6,
	},
	# Cold, pale, glassy water between ice.
	"arctic": {
		"shallow_color": Color(0.60, 0.85, 0.88), "deep_color": Color(0.04, 0.20, 0.30), "color_depth": 5.0, "clarity": 25.0,
		"scatter_color": Color(0.55, 0.85, 0.90), "scatter_strength": 0.4, "roughness": 0.03,
		"surface_scale": 3.0, "surface_strength": 0.2, "surface_speed": 0.1,
		"wave_height": 0.1, "wave_length": 9.0, "wave_count": 12, "shore_foam_width": 0.3, "shore_foam": 0.4, "caustics": 0.25,
		"underwater_color": Color(0.10, 0.35, 0.48), "underwater_fog_density": 0.04,
	},
	# A swimming pool or a fountain basin: clear, light blue, lively caustics.
	"pool": {
		"shallow_color": Color(0.55, 0.90, 0.95), "deep_color": Color(0.05, 0.45, 0.75), "color_depth": 4.0, "clarity": 40.0,
		"roughness": 0.03, "surface_scale": 1.5, "surface_strength": 0.3, "surface_speed": 0.15,
		"wave_height": 0.02, "wave_length": 1.5, "wave_count": 8, "shore_foam": 0.0,
		"caustics": 1.2, "caustics_scale": 1.4, "caustics_depth": 8.0, "edge_fade": 0.04,
		"underwater_color": Color(0.15, 0.55, 0.80), "underwater_fog_density": 0.02,
	},
	# Cartoon water: flat color bands, a hard white shore line that moves, a hard highlight.
	"toon": {
		"shallow_color": Color(0.45, 0.85, 0.92), "deep_color": Color(0.05, 0.38, 0.80), "color_depth": 2.5, "clarity": 4.0,
		"color_steps": 3, "roughness": 0.5, "reflectivity": 0.15, "refraction": 0.3,
		"surface_scale": 4.0, "surface_strength": 0.15, "surface_speed": 0.15,
		"glint_strength": 1.5, "glint_size": 0.2, "glint_hardness": 1.0, "glint_sparkle": 0.0, "reflection": 0,
		"wave_height": 0.15, "wave_length": 8.0, "wave_count": 4, "wave_steepness": 0.3,
		"foam_color": Color(1.0, 1.0, 1.0), "foam_scale": 2.5, "foam_hardness": 1.0,
		"shore_foam_width": 0.7, "shore_foam": 0.75, "shore_foam_lines": 2.0, "crest_foam": 0.3, "foam_trail": 0.0,
		"caustics": 0.0, "edge_fade": 0.0,
	},
	# Faceted water for low-poly worlds. It also sets `cell` to 1.5 meters, the size of the facets.
	"low_poly": {
		"shallow_color": Color(0.40, 0.80, 0.85), "deep_color": Color(0.06, 0.34, 0.62), "color_depth": 3.0, "clarity": 6.0,
		"roughness": 0.3, "reflectivity": 0.4, "refraction": 0.3, "surface_strength": 0.0,
		"glint_strength": 0.6, "glint_size": 0.45, "glint_sparkle": 0.0, "flat_shading": true, "reflection": 0,
		"wave_height": 0.6, "wave_length": 9.0, "wave_count": 4, "wave_steepness": 0.5, "wave_speed": 0.7, "cell": 1.5,
		"foam_hardness": 1.0, "foam_scale": 5.0, "shore_foam_width": 0.5, "shore_foam": 0.6, "caustics": 0.0, "edge_fade": 0.0,
	},
	# Blocky water in few colors, in the manner of 32-bit consoles and pixel-art 3D.
	"retro": {
		"shallow_color": Color(0.40, 0.75, 0.90), "deep_color": Color(0.08, 0.24, 0.60), "color_depth": 2.5, "clarity": 3.0,
		"color_steps": 4, "roughness": 0.6, "reflectivity": 0.0, "refraction": 0.0,
		"surface_scale": 4.0, "surface_strength": 0.35, "surface_speed": 0.2, "glint_strength": 0.8, "glint_size": 0.35,
		"glint_hardness": 1.0, "glint_sparkle": 0.0, "pixel_size": 0.25, "reflection": 0,
		"wave_height": 0.1, "wave_length": 6.0, "wave_count": 2, "wave_steepness": 0.0,
		"foam_hardness": 1.0, "foam_scale": 4.0, "shore_foam_width": 0.5, "shore_foam": 0.7, "caustics": 0.0, "edge_fade": 0.0,
	},
	# Molten rock: it glows, flows slowly, and carries a dark crust where water would carry foam.
	"lava": {
		"shallow_color": Color(1.0, 0.62, 0.10), "deep_color": Color(0.85, 0.14, 0.02), "color_depth": 0.6, "clarity": 0.05,
		"glow": 2.2, "roughness": 0.7, "reflectivity": 0.1, "refraction": 0.0,
		"surface_scale": 5.0, "surface_strength": 0.5, "surface_speed": 0.03, "glint_strength": 0.0, "reflection": 0,
		"wave_height": 0.12, "wave_length": 9.0, "wave_count": 6, "wave_steepness": 0.2, "wave_speed": 0.12,
		"foam_color": Color(0.07, 0.04, 0.035), "foam_scale": 5.0, "foam_speed": 0.02, "foam_hardness": 0.75,
		"shore_foam_width": 0.5, "shore_foam": 0.9, "crest_foam": 0.75, "foam_trail": 8.0, "caustics": 0.0, "edge_fade": 0.0,
		"underwater_color": Color(0.9, 0.3, 0.02), "underwater_fog_density": 1.0,
	},
	# Glowing green acid or slime.
	"toxic": {
		"shallow_color": Color(0.55, 0.95, 0.15), "deep_color": Color(0.12, 0.45, 0.05), "color_depth": 1.0, "clarity": 0.8,
		"glow": 0.7, "roughness": 0.25, "reflectivity": 0.5, "refraction": 0.5,
		"surface_scale": 3.0, "surface_strength": 0.4, "surface_speed": 0.06, "reflection": 0,
		"wave_height": 0.03, "wave_length": 3.0, "wave_count": 6, "wave_speed": 0.4,
		"foam_color": Color(0.85, 1.0, 0.45), "foam_scale": 1.5, "foam_speed": 0.05, "shore_foam_width": 0.3, "shore_foam": 0.6,
		"caustics": 0.0, "underwater_color": Color(0.25, 0.55, 0.05), "underwater_fog_density": 0.5,
	},
}


## The names of the presets, in the order above.
static func names() -> PackedStringArray:
	return PackedStringArray(PRESETS.keys())


## Every look and wave value of a preset: DEFAULTS with the preset's changes. An unknown name gives an empty
## Dictionary.
static func values(preset: String) -> Dictionary:
	if not PRESETS.has(preset):
		return {}
	var result := DEFAULTS.duplicate()
	result.merge(PRESETS[preset], true)
	return result
