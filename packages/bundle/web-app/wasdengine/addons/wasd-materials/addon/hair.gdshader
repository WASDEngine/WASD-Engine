// SPDX-License-Identifier: CC0-1.0
// Hair from its picture. What is solid of it is drawn first and hides what lies behind it, as a cut-out does, so
// its many layers need no sorting; its thin parts are then blended over that. Where the mesh says that the hair
// thins out, in the alpha of its vertices' color, as on a hairline, it breaks up into strands and locks instead of
// ending in a cut or a haze. Only its outer side is drawn: the inner side, dark and unsorted, would show through
// every thin part. Light wraps round it and lies on it in a ragged band across the strands, as on combed hair: lit
// as a smooth shell, hair is a helmet.
shader_type spatial;
render_mode depth_prepass_alpha, cull_back;

uniform sampler2D picture : source_color, filter_linear_mipmap_anisotropic;
uniform vec3 tint : source_color = vec3(1.0);
// The small picture of noise that every surface shares, drawn out along the hair into strands.
uniform sampler2D grain : filter_linear_mipmap, repeat_enable;
// How many strands lie side by side across the picture, and which way they run in it: down it, or across.
uniform float strands : hint_range(20.0, 600.0) = 220.0;
uniform bool strands_across = false;
// How bright the band of light across the strands is.
uniform float sheen : hint_range(0.0, 2.0) = 1.0;

// The way the strands run at this point, as the view sees it, how straight they are, and which strand this is. The
// red of the mesh's own color, 1 where it has none, tells straight hair from curls, across which no band runs.
varying vec3 run;
varying float straight;
varying float fiber;

void fragment() {
	vec4 shown = texture(picture, UV);
	ROUGHNESS = 0.55;
	SPECULAR = 0.25;
	vec3 way = strands_across ? TANGENT : BINORMAL;
	run = dot(way, way) > 0.0001 ? normalize(way) : vec3(0.0, 1.0, 0.0);
	straight = COLOR.r;
	vec2 along = strands_across ? UV.yx : UV;
	fiber = texture(grain, vec2(along.x * strands / 16.0, along.y * 0.6)).b;
	// Strands lie together in locks: a hairline thins out lock by lock, not along a ruled line.
	float lock = texture(grain, vec2(along.x * strands / 110.0, along.y * 0.15 + 0.37)).a;
	// No head of hair is of one tone: its locks are lighter and darker, and its strands within them.
	ALBEDO = shown.rgb * tint * (0.84 + 0.3 * lock) * (0.93 + 0.14 * fiber);
	// Of the strands, the share that the mesh says is there: all of them where the hair is whole.
	float kept = smoothstep(0.0, 0.25, COLOR.a * 1.25 - fiber * 0.55 - lock * 0.45 + 0.08);
	ALPHA = shown.a * kept;
}

void light() {
	// A head of hair is a mass of strands that pass light on, not a shell: light reaches round it.
	float wrapped = clamp((dot(NORMAL, LIGHT) + 0.35) / 1.35, 0.0, 1.0);
	DIFFUSE_LIGHT += wrapped * ATTENUATION * LIGHT_COLOR / PI;
	// Each strand mirrors a light where it lies across the way to it, a little up or down the strand from its
	// neighbor, which draws a ragged band of light across the hair.
	float across = dot(run, normalize(LIGHT + VIEW)) + (fiber - 0.5) * 0.3;
	float band = pow(max(1.0 - across * across, 0.0), 28.0);
	SPECULAR_LIGHT += band * 0.09 * sheen * straight * (0.4 + 1.2 * fiber) * wrapped * ATTENUATION * LIGHT_COLOR * mix(vec3(1.0), min(ALBEDO * 4.0, vec3(1.0)), 0.6);
}
