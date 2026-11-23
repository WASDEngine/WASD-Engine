// SPDX-License-Identifier: CC0-1.0
// The inside of a mouth: teeth, gums, and a tongue. What lights them has mostly come off the lips and the tongue,
// not straight from the sky, and mirrors in nothing: teeth that take the light of an open field glow white, teeth
// that take the sky's turn blue, and teeth that take only what the lips' shadow leaves turn black. The mesh's own
// color, where it has one, tells how much light reaches each point: a mouth is dark toward its back.
shader_type spatial;

uniform sampler2D picture : source_color, filter_linear_mipmap_anisotropic;
uniform vec3 tint : source_color = vec3(1.0);
// The share of the sun's light that still reaches teeth in the lips' shade, off the lips and through them.
uniform float leak : hint_range(0.0, 1.0) = 0.45;

// The color that the scene's own light takes on its way off the lips and the tongue.
const vec3 WARM = vec3(1.0, 0.84, 0.75);

void fragment() {
	// The scene's own light meets the warm inside; light() takes the warmth out again for lamps and the sun.
	ALBEDO = min(texture(picture, UV).rgb * tint, vec3(1.0)) * COLOR.rgb * WARM;
	ROUGHNESS = 0.4;
	SPECULAR = 0.0;
}

void light() {
	// Light inside a mouth comes from all around the opening, so it falls off gently toward the far side.
	float toward = dot(NORMAL, LIGHT) * 0.5 + 0.5;
	float reach = LIGHT_IS_DIRECTIONAL ? mix(leak, 1.0, ATTENUATION) : ATTENUATION;
	DIFFUSE_LIGHT += toward * 0.8 * reach / WARM * LIGHT_COLOR / PI;
	// Wet teeth catch a small highlight.
	float glint = pow(clamp(dot(NORMAL, normalize(LIGHT + VIEW)), 0.0, 1.0), 48.0);
	SPECULAR_LIGHT += glint * 0.25 * ATTENUATION * LIGHT_COLOR;
}
