// SPDX-License-Identifier: CC0-1.0
// Glass: clear seen straight on, a mirror of the sky and the lamps seen along it. What it mirrors is added to what
// shows through, at full strength however clear the glass is.
shader_type spatial;
render_mode blend_premul_alpha, depth_draw_never, cull_disabled, specular_schlick_ggx;

uniform vec3 color : source_color = vec3(0.8, 0.9, 1.0);
uniform float clear : hint_range(0.0, 1.0) = 0.85;
uniform float roughness : hint_range(0.0, 1.0) = 0.04;

void fragment() {
	float along = pow(1.0 - clamp(abs(dot(NORMAL, VIEW)), 0.0, 1.0), 4.0);
	// How much of what lies behind the glass is hidden: little straight on, most along it; frosted glass hides more.
	float hides = mix(1.0 - clear, 0.9, along) + roughness * 0.35 * clear;
	// The Compatibility renderer, which Web builds use, adds a see-through surface's light to the picture as color
	// values, where a little light counts for much: there the glass gives off a third as much, and shows the same.
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	const float GIVES = 0.3;
#else
	const float GIVES = 1.0;
#endif
	ALBEDO = color * hides * 0.6 * sqrt(GIVES);
	ROUGHNESS = roughness;
	SPECULAR = GIVES;
	METALLIC = 0.0;
	ALPHA = clamp(hides, 0.0, 1.0);
}
