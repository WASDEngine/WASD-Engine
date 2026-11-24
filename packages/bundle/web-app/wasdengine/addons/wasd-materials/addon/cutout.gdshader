// SPDX-License-Identifier: CC0-1.0
// A cut-out surface for WasdSurface.cutout(): a color picture drawn only where an opacity picture is light, on the
// mesh's own UV map and from both sides, as leaves, fences, and stencils need. Nothing blends, so cut-outs sort
// like solid surfaces and cast shadows of their own outline. It draws on Forward+, Mobile, and Compatibility.
shader_type spatial;
render_mode cull_disabled;

uniform sampler2D color_map : source_color, filter_linear_mipmap_anisotropic, repeat_disable;
uniform sampler2D opacity_map : hint_default_white, filter_linear_mipmap, repeat_disable;
uniform sampler2D normal_map : hint_normal, filter_linear_mipmap, repeat_disable;
uniform sampler2D roughness_map : hint_default_white, filter_linear_mipmap, repeat_disable;
// Whether the folder had a normal and a roughness picture.
uniform bool has_normal = false;
uniform bool has_roughness = false;
uniform float roughness : hint_range(0.0, 1.0) = 0.8;
// The opacity below which nothing is drawn.
uniform float threshold : hint_range(0.01, 0.99) = 0.5;
// The part of the pictures to show: its corner and its size, in shares of the picture. One piece of an atlas.
uniform vec4 region = vec4(0.0, 0.0, 1.0, 1.0);
// How much light shines through from behind, as through a leaf.
uniform float shine_through : hint_range(0.0, 1.0) = 0.0;

void fragment() {
	vec2 at = region.xy + UV * region.zw;
	ALBEDO = texture(color_map, at).rgb;
	ALPHA = texture(opacity_map, at).r;
	ALPHA_SCISSOR_THRESHOLD = threshold;
	ROUGHNESS = has_roughness ? texture(roughness_map, at).r : roughness;
	if (has_normal) {
		NORMAL_MAP = texture(normal_map, at).rgb;
	}
	// Seen from behind, the surface faces the viewer too: with culling off, the renderers already turn NORMAL round
	// on the back, so light from the viewer's side lights it and light from beyond it shines through.
	BACKLIGHT = vec3(shine_through);
}
