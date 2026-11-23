// SPDX-License-Identifier: CC0-1.0
// A soft overlay for WasdSurface.cutout() with `soft`: a color picture blended over what lies behind by an opacity
// picture, for marks with soft edges such as stains, leaks, and road lines on a quad laid just above a surface. It
// writes no depth, so marks may overlap. It draws on Forward+, Mobile, and Compatibility.
shader_type spatial;
render_mode blend_mix, depth_draw_never, cull_back;

uniform sampler2D color_map : source_color, filter_linear_mipmap_anisotropic, repeat_disable;
uniform sampler2D opacity_map : hint_default_white, filter_linear_mipmap, repeat_disable;
uniform sampler2D normal_map : hint_normal, filter_linear_mipmap, repeat_disable;
uniform sampler2D roughness_map : hint_default_white, filter_linear_mipmap, repeat_disable;
uniform bool has_normal = false;
uniform bool has_roughness = false;
uniform float roughness : hint_range(0.0, 1.0) = 0.8;
// How strongly the mark shows where its opacity picture is white.
uniform float strength : hint_range(0.0, 1.0) = 1.0;
uniform vec4 region = vec4(0.0, 0.0, 1.0, 1.0);

void fragment() {
	vec2 at = region.xy + UV * region.zw;
	ALBEDO = texture(color_map, at).rgb;
	ALPHA = texture(opacity_map, at).r * strength;
	ROUGHNESS = has_roughness ? texture(roughness_map, at).r : roughness;
	if (has_normal) {
		NORMAL_MAP = texture(normal_map, at).rgb;
	}
}
