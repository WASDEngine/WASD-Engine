// SPDX-License-Identifier: CC0-1.0
// A toon look: every light falls in flat steps instead of a smooth falloff, with a rim of light at the edges and
// an optional hard highlight. WasdSurface.toon() adds the outline as a second pass.
shader_type spatial;

uniform vec3 color : source_color = vec3(0.8, 0.5, 0.3);
uniform sampler2D picture : source_color, hint_default_white, filter_linear_mipmap, repeat_enable;
// Steps of light, how soft the edge between two steps is, the rim's strength, and a highlight's size (0 for none).
uniform float steps = 2.0;
uniform float soft : hint_range(0.0, 0.5) = 0.03;
uniform float rim : hint_range(0.0, 1.0) = 0.25;
uniform float shine : hint_range(0.0, 1.0) = 0.0;

void fragment() {
	ALBEDO = color * texture(picture, UV).rgb;
	ROUGHNESS = 1.0;
	SPECULAR = 0.0;
}

void light() {
	float lit = clamp(dot(NORMAL, LIGHT), 0.0, 1.0) * ATTENUATION;
	// The light in steps: each step's edge is softened a little, so that it does not crawl.
	float scaled = lit * steps;
	float stepped = (floor(scaled) + smoothstep(0.5 - soft * steps, 0.5 + soft * steps, fract(scaled))) / steps;
	DIFFUSE_LIGHT += stepped * LIGHT_COLOR / PI;
	// A rim on the lit side, and a hard highlight.
	float edge = pow(1.0 - clamp(dot(NORMAL, VIEW), 0.0, 1.0), 3.0);
	DIFFUSE_LIGHT += smoothstep(0.4, 0.5, edge * lit * 2.0) * rim * LIGHT_COLOR / PI;
	if (shine > 0.0) {
		float glint = dot(NORMAL, normalize(LIGHT + VIEW));
		SPECULAR_LIGHT += smoothstep(1.0 - shine * 0.1 - 0.01, 1.0 - shine * 0.1 + 0.01, glint) * ATTENUATION * LIGHT_COLOR * 0.5;
	}
}
