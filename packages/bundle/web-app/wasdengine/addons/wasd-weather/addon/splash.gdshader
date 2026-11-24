// SPDX-License-Identifier: CC0-1.0
// Where rain meets level ground: rings that open and fade, and with every other ring a small splash that jumps up,
// at places that stay put in the world while their field follows the camera.
shader_type spatial;
render_mode unshaded, blend_premul_alpha, depth_draw_never, cull_disabled, shadows_disabled, fog_disabled;

#include "res://addons/wasd_weather/weather_color.gdshaderinc"

uniform vec3 color : source_color = vec3(0.85, 0.9, 0.95);
uniform float opacity = 0.9;
uniform float light_level = 1.0;
// Meters across the field of rings, where its middle is in the world, and the height of the ground.
uniform float field = 16.0;
uniform vec3 field_middle = vec3(0.0);
uniform float ground = 0.0;
uniform float ring_size = 0.22;
uniform float splash_height = 0.11;
uniform float clock = 0.0;

varying float shown;
varying float grown;
varying float upright;
varying vec2 card;

void vertex() {
	vec4 seed = INSTANCE_CUSTOM;
	// Each ring lives a third of a second, then opens again at another place of its own.
	float turn = clock / 0.35 + seed.w * 10.0;
	float round = floor(turn);
	grown = fract(turn);
	upright = step(0.5, seed.y);
	vec2 spot = fract(seed.xz + vec2(0.618, 0.382) * round) * field;
	vec2 offset = mod(spot - field_middle.xz + field * 0.5, field) - field * 0.5;
	shown = (1.0 - smoothstep(0.35, 0.5, length(offset) / field)) * (1.0 - grown) * (0.45 + 0.55 * seed.z);
	card = (UV - 0.5) * 2.0;
	vec3 base = vec3(field_middle.x + offset.x, ground + 0.02, field_middle.z + offset.y);
	if (upright > 0.5) {
		// The splash: a thin jet that faces the camera, up and down again in the ring's first half.
		float jump = sin(min(grown * 2.0, 1.0) * PI);
		vec3 seen = (VIEW_MATRIX * vec4(base, 1.0)).xyz;
		seen.x += card.x * 0.018;
		seen += (VIEW_MATRIX * vec4(0.0, 1.0, 0.0, 0.0)).xyz * (card.y * 0.5 + 0.5) * splash_height * (0.5 + seed.x) * jump;
		shown *= step(grown, 0.5);
		POSITION = PROJECTION_MATRIX * vec4(seen, 1.0);
	} else {
		vec3 place = base + vec3(card.x, 0.0, card.y) * ring_size * (0.5 + seed.x) * (0.3 + 0.7 * grown) * 0.5;
		POSITION = PROJECTION_MATRIX * VIEW_MATRIX * vec4(place, 1.0);
	}
}

void fragment() {
	float solid;
	if (upright > 0.5) {
		solid = (1.0 - abs(card.x)) * smoothstep(-1.0, -0.6, card.y) * (1.0 - smoothstep(0.2, 1.0, card.y));
	} else {
		float out_from_middle = length(card);
		solid = smoothstep(0.55, 0.8, out_from_middle) * clamp((1.0 - out_from_middle) / 0.2, 0.0, 1.0);
	}
	float covers = clamp(opacity * solid * shown, 0.0, 1.0);
	wasd_layer(wasd_to_light(color) * max(light_level, 0.4) * covers, 1.0 - covers * 0.3, FRAGCOORD.xy, ALBEDO, ALPHA);
}
