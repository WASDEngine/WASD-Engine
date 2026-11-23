// SPDX-License-Identifier: CC0-1.0
// How the skies of WasdLook3D hand their colors to each renderer, so that one sky gives the same picture and the same
// light on all of them.
//
// Forward+ and Mobile take a sky's color as light and give color values to shaders as light. The Compatibility
// renderer, which every Web build uses, gives color values as they are written (sRGB) and takes the sky's color the
// same way. It also passes the sky's light through exposure and the tone curve before the scene is lit by it, where
// it passes through both again, and it stores that light as color values twice, with conversions that lose dark
// values: a night sky gives no light there, and a bright one too little. These functions turn colors into light on
// the way in and, on Compatibility, undo each of those steps on the way out.

// The tone curve's numbers (contrast, toe, slope, shoulder) and the exposure, as WasdLook3D reads them from its
// Environment.
uniform vec4 tone_curve = vec4(1.25, 0.534112, 1.025, 324.4151);
uniform float tone_exposure = 1.0;
// How strongly the sky lights the scene and shows in reflections, beside how bright it looks. The engine's own
// ambient energy does not reach a sky's light, and the Compatibility renderer stores no sky light brighter than 1,
// so the light stops at 1 on every renderer.
uniform float light_gain = 1.0;

#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
// The Compatibility renderer's own conversion from a color value to light.
vec3 wasd_engine_light(vec3 color) {
	return color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878);
}

// The color value that conversion turns into `light`.
vec3 wasd_engine_light_inverse(vec3 light) {
	vec3 color = max(1.055 * pow(light, vec3(0.416666667)) - 0.055, vec3(0.0));
	for (int step_index = 0; step_index < 4; step_index++) {
		vec3 off = color * (color * (color * 0.305306011 + 0.682171111) + 0.012522878) - light;
		color = max(color - off / (color * (color * 0.915918033 + 1.364342222) + 0.012522878), vec3(0.0));
	}
	return color;
}

// The light that the renderer's conversion from light to a color value turns into `color`.
vec3 wasd_engine_color_inverse(vec3 color) {
	return pow((color + 0.055) / 1.055, vec3(2.4));
}

// The light that the engine's AgX tone curve turns into `shown`: its matrices and curve run backward.
vec3 wasd_before_tone_curve(vec3 shown) {
	const mat3 outset_inverse = mat3(
			vec3(0.570774518, 0.130619007, 0.089066981),
			vec3(0.377615922, 0.842960637, 0.187404665),
			vec3(0.051609560, 0.026420356, 0.723528354));
	const mat3 inset_inverse = mat3(
			vec3(2.114473395, -0.370504268, -0.165931398),
			vec3(-1.027378470, 1.552926184, -0.254715528),
			vec3(-0.087094925, -0.182421916, 1.420646926));
	const float crossover = 0.18;
	vec3 curved = clamp(outset_inverse * shown, vec3(0.0), vec3(0.999));
	vec3 toe = pow(tone_curve.y * curved / (1.0 - curved), vec3(1.0 / tone_curve.x));
	vec3 over = max(curved - crossover, vec3(0.0));
	vec3 line = tone_curve.z * (1.0 - over / (1.0 - crossover));
	vec3 shoulder = 2.0 * over / (line + sqrt(line * line + 4.0 * (tone_curve.z / tone_curve.w) * over)) + crossover;
	return max(inset_inverse * mix(shoulder, toe, lessThan(curved, vec3(crossover))), vec3(0.0));
}
#endif

// A color value as light.
vec3 wasd_light(vec3 color) {
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	return wasd_engine_light(color);
#else
	return color;
#endif
}

// The value a sky shader writes for a color given as light. `lights_scene` is AT_CUBEMAP_PASS: the pass whose
// picture lights the scene.
vec3 wasd_sky_out(vec3 light, bool lights_scene) {
	if (lights_scene) {
		light = min(light * light_gain, vec3(1.0));
	}
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	if (lights_scene) {
		// From the scene's reading back to this shader's writing: the stored light is read as a color value, was
		// stored as one after a blur that read it as one, and before that came out of the tone curve and exposure.
		vec3 blurred = wasd_engine_light_inverse(light);
		vec3 stored = wasd_engine_light_inverse(wasd_engine_color_inverse(blurred));
		light = wasd_before_tone_curve(wasd_engine_color_inverse(stored)) / tone_exposure;
	}
	return wasd_engine_light_inverse(light);
#else
	return light;
#endif
}
