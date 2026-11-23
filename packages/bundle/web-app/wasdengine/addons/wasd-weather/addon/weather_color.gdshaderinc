// SPDX-License-Identifier: CC0-1.0
// Light and see-through layers for the rain, snow, and covers of WASD Weather, alike on every renderer.
//
// Forward+ and Mobile hand a shader its color values as light, take ALBEDO as light, and blend layers as light. The
// Compatibility renderer, which every Web build uses, hands color values over as written (sRGB), takes ALBEDO the
// same way, and blends layers as color values: there a glow added over a lit wall comes out several times too
// bright, and thin fog over a dark floor far too thin. These functions keep the arithmetic in light and hand each
// renderer the layer that shows the same picture. The shaders that use `wasd_layer` blend with `blend_premul_alpha`.

// A color value as light.
vec3 wasd_to_light(vec3 color) {
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	return color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878);
#else
	return color;
#endif
}

#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
// The Compatibility renderer's own conversion from light to a color value.
float wasd_engine_color(float light) {
	return max(1.055 * pow(light, 0.416666667) - 0.055, 0.0);
}
#endif

// A layer that adds `light` to the picture behind it and lets the part `through` (0 to 1) of that picture pass: 1
// for a pure glow, less for fog. `pixel` is FRAGCOORD.xy: the light gets a grain of a few hundredths from it, which
// keeps wide soft gradients from showing steps. Write the results to ALBEDO and ALPHA.
void wasd_layer(vec3 light, float through, vec2 pixel, out vec3 albedo, out float alpha) {
	light *= 1.0 + (fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715)))) - 0.5) * 0.05;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	// ALBEDO as the color value that the renderer turns back into `light`.
	vec3 color = max(1.055 * pow(light, vec3(0.416666667)) - 0.055, vec3(0.0));
	for (int step_index = 0; step_index < 3; step_index++) {
		vec3 off = color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878) - light;
		color = max(color - off / (color * (color * 0.915918033 + 1.364342222) + 0.012522878), vec3(0.0));
	}
	albedo = color;
	// The layer lands on a picture of color values. So much of that picture is kept that a mid-gray behind the
	// layer ends up where adding light to it would put it; a black one is exact as it is.
	const float behind = 0.18;
	float added = dot(light, vec3(0.2126, 0.7152, 0.0722));
	alpha = clamp(1.0 - (wasd_engine_color(behind * through + added) - wasd_engine_color(added)) / wasd_engine_color(behind), 0.0, 1.0);
#else
	albedo = light;
	alpha = 1.0 - through;
#endif
}
