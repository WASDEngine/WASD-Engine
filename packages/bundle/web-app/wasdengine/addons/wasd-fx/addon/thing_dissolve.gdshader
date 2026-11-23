// SPDX-License-Identifier: CC0-1.0
// A thing that dissolves: it is eaten away in patches from a noise, with a glowing edge where it goes. It takes
// the color and the picture of the material it stands in for.
shader_type spatial;
render_mode cull_disabled;

uniform vec3 color : source_color = vec3(1.0);
uniform sampler2D picture : source_color, hint_default_white, filter_linear_mipmap, repeat_enable;
uniform sampler2D noise : repeat_enable, filter_linear_mipmap;
// How much is gone, from 0 to 1; the edge's color and width; meters across the noise.
uniform float gone : hint_range(0.0, 1.0) = 0.0;
uniform vec3 edge_color : source_color = vec3(1.0, 0.55, 0.15);
uniform float edge = 0.035;
uniform float patch_size = 1.0;
uniform float roughness = 0.7;
// The thing's lowest and highest point in its own space: it goes from the bottom up, more than at random.
uniform vec2 span = vec2(0.0, 1.0);

varying vec3 place;

void vertex() {
	place = VERTEX;
}

void fragment() {
	vec4 shown = texture(picture, UV);
	// The noise is read from three sides of the thing's own space, so that it needs no UV map.
	float left = texture(noise, place.zy / patch_size).r;
	float top = texture(noise, place.xz / patch_size).r;
	float front = texture(noise, place.xy / patch_size).r;
	// Three readings together keep to the middle of the range: spread them out again. A finer reading breaks the
	// edge up, and the height in the thing makes it go from the bottom up.
	float coarse = clamp(((left + top + front) / 3.0 - 0.22) / 0.56, 0.0, 1.0);
	float fine = texture(noise, (place.xy + place.zz) / (patch_size * 0.22)).r;
	float height = clamp((place.y - span.x) / max(span.y - span.x, 0.001), 0.0, 1.0);
	float level = clamp(coarse * 0.3 + fine * 0.1 + height * 0.6, 0.0, 1.0);
	float cut = gone * (1.0 + edge * 2.0) - edge;
	if (level < cut || shown.a < 0.4) {
		discard;
	}
	ALBEDO = shown.rgb * color;
	ROUGHNESS = roughness;
	float glow = 1.0 - smoothstep(cut, cut + edge, level);
	EMISSION = edge_color * glow * glow * 3.5 * step(0.001, gone);
}
