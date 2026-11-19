// SPDX-License-Identifier: CC0-1.0
// The view from under water: WasdWater3D covers the screen with it while the camera is below the surface. It tints
// the picture and makes it sway.
shader_type canvas_item;

uniform sampler2D wasd_screen : hint_screen_texture, filter_linear, repeat_disable;
uniform vec3 tint : source_color = vec3(0.05, 0.35, 0.45);
// How strongly the water colors the view, from 0 to 1.
uniform float strength = 0.55;
// How far the picture sways, as a part of the screen.
uniform float sway = 0.004;
uniform float water_time = 0.0;

void fragment() {
	vec2 moved = vec2(sin(SCREEN_UV.y * 22.0 + water_time * 1.7), cos(SCREEN_UV.x * 18.0 + water_time * 1.3)) * sway;
	vec3 scene = texture(wasd_screen, clamp(SCREEN_UV + moved, vec2(0.001), vec2(0.999))).rgb;
	// The tint's hue colors the picture; its brightness adds a little haze.
	vec3 hue = tint / max(max(tint.r, max(tint.g, tint.b)), 0.001);
	COLOR = vec4(mix(scene, scene * hue + tint * 0.12, strength), 1.0);
}
