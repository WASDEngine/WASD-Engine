// SPDX-License-Identifier: CC0-1.0
// The glow round a lamp, a candle, a headlight, or a screen: a card that always faces the camera, brightest in its
// middle, added to the picture. It hides behind walls like any object and fades out as the camera comes close.
shader_type spatial;
render_mode unshaded, blend_premul_alpha, depth_draw_never, cull_disabled, shadows_disabled, fog_disabled;

#include "res://addons/wasd_light/light_color.gdshaderinc"

uniform vec3 color : source_color = vec3(1.0, 0.82, 0.6);
uniform float energy = 1.0;
// How much of the card the bright core takes, and how long a streak runs sideways through it (0 for none).
uniform float core : hint_range(0.02, 1.0) = 0.18;
uniform float streak : hint_range(0.0, 1.0) = 0.0;
// How uneven the glow is: faint rays that slowly turn, as a real lens or the air gives a light.
uniform float rays : hint_range(0.0, 1.0) = 0.25;
// Meters from the camera inside which the glow fades out, so that it never fills the screen.
uniform float fade_near = 0.6;
// Meters at which it has faded away in the distance; 0 keeps it at any distance.
uniform float fade_far = 0.0;

void vertex() {
	// Face the camera, keeping the node's size.
	vec3 scale = vec3(length(MODEL_MATRIX[0].xyz), length(MODEL_MATRIX[1].xyz), length(MODEL_MATRIX[2].xyz));
	MODELVIEW_MATRIX = VIEW_MATRIX * mat4(INV_VIEW_MATRIX[0] * scale.x, INV_VIEW_MATRIX[1] * scale.y, INV_VIEW_MATRIX[2] * scale.z, MODEL_MATRIX[3]);
	MODELVIEW_NORMAL_MATRIX = mat3(MODELVIEW_MATRIX);
}

void fragment() {
	vec2 from_middle = (UV - 0.5) * 2.0;
	float distance_out = length(from_middle);
	float soft = pow(clamp(1.0 - distance_out, 0.0, 1.0), 2.4);
	if (rays > 0.0) {
		float turn = atan(from_middle.y, from_middle.x);
		soft *= 1.0 + rays * (0.35 * sin(turn * 5.0 + TIME * 0.21) + 0.3 * sin(turn * 9.0 - TIME * 0.13 + 1.7)) * smoothstep(0.0, 0.5, distance_out);
	}
	float middle = smoothstep(core, 0.0, distance_out);
	float line = streak * pow(clamp(1.0 - abs(from_middle.x), 0.0, 1.0), 2.0) * smoothstep(0.08 + 0.1 * streak, 0.0, abs(from_middle.y));
	float away = length(VERTEX);
	float shown = smoothstep(fade_near * 0.4, fade_near, away);
	if (fade_far > 0.0) {
		shown *= 1.0 - smoothstep(fade_far * 0.6, fade_far, away);
	}
	wasd_layer(wasd_to_light(color) * energy * (soft * 0.5 + middle * 0.9 + line) * shown, 1.0, FRAGCOORD.xy, ALBEDO, ALPHA);
}
