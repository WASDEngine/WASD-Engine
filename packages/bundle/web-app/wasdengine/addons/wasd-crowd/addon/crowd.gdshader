// SPDX-License-Identifier: CC0-1.0
// A crowd member: one copy of a model's mesh whose vertices take their places from animation textures that
// WasdCrowdBaker baked, a row of pixels for each frame. Every member plays its own clip at its own pace and phase,
// and the whole crowd is one draw call for each surface of the model. It draws with shadows on the Forward+, Mobile,
// and Compatibility renderers.
shader_type spatial;

uniform sampler2D positions : filter_nearest, repeat_disable;
uniform sampler2D normals : filter_nearest, repeat_disable;
// Pixels across the textures, and rows of pixels one frame takes.
uniform int width = 1;
uniform int rows = 1;
uniform vec4 albedo : source_color = vec4(1.0);
uniform sampler2D albedo_texture : source_color, filter_linear_mipmap, repeat_enable;
uniform float roughness : hint_range(0.0, 1.0) = 0.8;
uniform float metallic : hint_range(0.0, 1.0) = 0.0;
// Above 0, pixels more see-through than this are left out: hair, lashes, torn cloth.
uniform float alpha_cut : hint_range(0.0, 1.0) = 0.0;
// How much of a member's tint this surface takes: 1 for clothes that should differ, 0 for skin that should not.
uniform float tinted : hint_range(0.0, 1.0) = 1.0;

void vertex() {
	// Custom data: the clip's first frame, its number of frames, the member's phase from 0 to 1, and frames a second.
	float count = max(INSTANCE_CUSTOM.y, 1.0);
	float at = mod(TIME * INSTANCE_CUSTOM.w + INSTANCE_CUSTOM.z * count, count);
	int first = int(INSTANCE_CUSTOM.x) + int(floor(at));
	int second = int(INSTANCE_CUSTOM.x) + int(mod(floor(at) + 1.0, count));
	float between = fract(at);
	// The second UV map holds the vertex's column and its row within a frame.
	int column = int(UV2.x * float(width));
	int row = int(UV2.y * float(rows));
	vec3 place = mix(texelFetch(positions, ivec2(column, first * rows + row), 0).xyz, texelFetch(positions, ivec2(column, second * rows + row), 0).xyz, between);
	vec3 facing = mix(texelFetch(normals, ivec2(column, first * rows + row), 0).xyz, texelFetch(normals, ivec2(column, second * rows + row), 0).xyz, between);
	VERTEX = place;
	NORMAL = normalize(facing);
}

void fragment() {
	vec4 surface = texture(albedo_texture, UV) * albedo;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	vec3 tint = COLOR.rgb;
#else
	// A member's tint is a color as the screen shows it. The Compatibility renderer hands it over as light already;
	// the others hand it over as it is.
	vec3 tint = mix(pow((COLOR.rgb + 0.055) / 1.055, vec3(2.4)), COLOR.rgb / 12.92, step(COLOR.rgb, vec3(0.04045)));
#endif
	ALBEDO = surface.rgb * mix(vec3(1.0), tint, tinted);
	ROUGHNESS = roughness;
	METALLIC = metallic;
	if (alpha_cut > 0.0 && surface.a < alpha_cut) {
		discard;
	}
}
