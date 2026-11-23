# SPDX-License-Identifier: CC0-1.0
# The looks WasdPost knows by name: each sets some of its properties, and the rest stay at their plain values.
class_name WasdPostLooks
extends RefCounted

## The plain value of every property a look can set.
const PLAIN := {
	"aberration": 0.0, "sharpen": 0.0, "tilt_shift": 0.0, "tilt_focus": 0.55, "tilt_band": 0.12, "pixel_size": 1.0,
	"exposure": 0.0, "contrast": 1.0, "saturation": 1.0, "temperature": 0.0,
	"shadows": Color(0.5, 0.5, 0.5), "highlights": Color(0.5, 0.5, 0.5), "color_levels": 0.0, "tone_levels": 0.0,
	"vignette": 0.0, "vignette_softness": 0.55, "vignette_color": Color(0, 0, 0), "grain": 0.0, "scanlines": 0.0,
	"curve": 0.0, "mask": 0.0, "soften": 0.0, "edges": 0.0, "edge_color": Color(0.05, 0.05, 0.08), "tint": Color(1, 1, 1), "hatch": 0.0,
}

## The looks by name.
const LOOKS := {
	## The picture as the game draws it.
	"none": {},
	## A feature film: teal shadows, warm highlights, soft corners, a little grain and fringe.
	"cinematic": {
		"contrast": 1.12, "saturation": 0.94, "shadows": Color(0.42, 0.5, 0.56), "highlights": Color(0.56, 0.52, 0.45),
		"vignette": 0.35, "grain": 0.06, "aberration": 0.8, "sharpen": 0.15,
	},
	## Late afternoon: warm, a little soft in contrast.
	"warm": {"temperature": 0.45, "contrast": 1.05, "saturation": 1.08, "highlights": Color(0.56, 0.52, 0.44), "vignette": 0.2},
	## Winter or night: cool and clear.
	"cold": {"temperature": -0.45, "contrast": 1.08, "saturation": 0.9, "shadows": Color(0.44, 0.5, 0.58), "vignette": 0.25},
	## Bright and saturated, with crisp edges: toys, arcades, cartoons.
	"vivid": {"saturation": 1.3, "contrast": 1.1, "sharpen": 0.3},
	## Black and white with hard contrast, grain, and dark corners.
	"noir": {"saturation": 0.0, "contrast": 1.35, "exposure": 0.1, "vignette": 0.5, "grain": 0.14},
	## An old photograph: faded, warm, grainy.
	"vintage": {
		"contrast": 0.9, "saturation": 0.72, "temperature": 0.3, "exposure": 0.1, "shadows": Color(0.55, 0.5, 0.44),
		"vignette": 0.42, "grain": 0.16,
	},
	## Dread: drained color, green shadows, heavy corners and grain.
	"horror": {
		"saturation": 0.55, "contrast": 1.2, "exposure": -0.25, "shadows": Color(0.44, 0.54, 0.46),
		"vignette": 0.65, "vignette_softness": 0.8, "grain": 0.2, "aberration": 1.2,
	},
	## A model railway: a sharp band with blur above and below, and strong color.
	"miniature": {"tilt_shift": 7.0, "saturation": 1.25, "contrast": 1.1, "sharpen": 0.2},
	## An old console on an old screen: blocks, few colors, scanlines.
	"retro": {"pixel_size": 3.0, "color_levels": 12.0, "scanlines": 0.3, "contrast": 1.08, "vignette": 0.25},
	## A comic book: flat steps of strong color with ink lines round shapes.
	"comic": {"saturation": 1.4, "exposure": 0.45, "contrast": 1.1, "tone_levels": 4.0, "edges": 1.0},
	## A pencil drawing on paper: strokes that cross where it is dark, dark outlines, a little grain.
	"sketch": {"saturation": 0.0, "exposure": 0.6, "contrast": 1.2, "hatch": 1.0, "edges": 1.0, "edge_color": Color(0.16, 0.16, 0.2), "grain": 0.1, "vignette": 0.15},
	## An old television: bulging glass, scanlines, colored stripes, soft glow, dark corners.
	"crt": {"curve": 0.6, "scanlines": 0.55, "mask": 0.28, "soften": 0.3, "aberration": 2.0, "exposure": 0.3, "contrast": 1.1, "saturation": 1.1, "vignette": 0.4},
	## A night-vision scope: green, bright, grainy, dark at the rim.
	"night_vision": {"saturation": 0.0, "tint": Color(0.2, 1.0, 0.28), "exposure": 0.5, "contrast": 1.6, "grain": 0.35, "scanlines": 0.2, "vignette": 2.0, "vignette_softness": 0.65, "soften": 0.25},
	## A dream or a memory: soft glow over everything, pale edges.
	"dream": {"soften": 0.9, "saturation": 0.95, "exposure": 0.1, "contrast": 0.95, "shadows": Color(0.52, 0.5, 0.58), "highlights": Color(0.58, 0.52, 0.46),
		"vignette": 0.9, "vignette_softness": 0.9, "vignette_color": Color(1.0, 0.96, 0.92), "aberration": 5.0},
	## Day for night: blue, dim, and drained, for a moonlit scene shot in daylight.
	"moonlight": {"temperature": -0.8, "saturation": 0.22, "exposure": -1.1, "contrast": 1.2, "shadows": Color(0.47, 0.53, 0.72), "highlights": Color(0.42, 0.48, 0.56), "vignette": 0.5, "soften": 0.35},
}


## The names of the looks, in the order above.
static func names() -> PackedStringArray:
	return PackedStringArray(LOOKS.keys())


## Every property's value for a look; an unknown name gives the plain values.
static func values(look: String) -> Dictionary:
	var result := PLAIN.duplicate()
	result.merge(LOOKS.get(look, {}), true)
	return result
