// SPDX-License-Identifier: CC0-1.0
// A card with holes that only throws a shadow: leaves between the sun and the ground, a grating before a lamp,
// blinds at a window. It stands in for light projectors, which Web builds do not draw.
shader_type spatial;
render_mode unshaded, cull_disabled;

uniform sampler2D pattern : repeat_enable, filter_linear_mipmap;
// How much of the light the card stops, and the size of the pattern in meters.
uniform float cover : hint_range(0.0, 1.0) = 0.55;
uniform float pattern_size = 3.0;
// 0 leaves, 1 bars, 2 a grid.
uniform int kind = 0;
// How far and how fast the pattern sways, in meters and turns a second.
uniform float sway = 0.15;
uniform float sway_speed = 0.12;

varying vec2 across;

void vertex() {
	across = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xz;
	if (abs(MODEL_NORMAL_MATRIX[1].y) < 0.5) {
		// An upright card: its pattern runs along its own width and height.
		across = VERTEX.xy * vec2(length(MODEL_MATRIX[0].xyz), length(MODEL_MATRIX[1].xyz));
	}
}

void fragment() {
	vec2 at = across / pattern_size + sway / pattern_size * vec2(sin(TIME * sway_speed * 6.2832), cos(TIME * sway_speed * 4.7));
	float solid;
	if (kind == 1) {
		solid = step(fract(at.y), cover);
	} else if (kind == 2) {
		solid = max(step(fract(at.x), cover * 0.5), step(fract(at.y), cover * 0.5));
	} else {
		float leaves = texture(pattern, at).r * 0.6 + texture(pattern, at * 2.3 + vec2(0.4, 0.7)).r * 0.4;
		solid = step(1.0 - cover, leaves);
	}
	ALBEDO = vec3(0.0);
	ALPHA = solid;
	ALPHA_SCISSOR_THRESHOLD = 0.5;
}
