// SPDX-License-Identifier: CC0-1.0
// Waves a flag, banner, pennant, or sail in the wind without physics, at the cost of a material: each vertex moves
// along the mesh normal by waves that grow from the pinned edge to the free edge. Use it on a subdivided plane with
// UVs, such as a PlaneMesh with orientation FACE_Z and subdivide_width and subdivide_depth of 16 or more. With
// pinned_edge 0 the edge where UV.x is 0 stays still (a flag on a pole); with 1, the edge where UV.y is 0 (a banner
// hanging from a rail).
shader_type spatial;
render_mode cull_disabled;

uniform sampler2D albedo_texture : source_color, filter_linear_mipmap, repeat_disable, hint_default_white;
uniform vec4 albedo_color : source_color = vec4(1.0);
uniform float roughness : hint_range(0.0, 1.0) = 0.85;
// 0: the edge where UV.x is 0 stays still; 1: the edge where UV.y is 0 does.
uniform int pinned_edge : hint_range(0, 1) = 0;
// Wind speed in m/s; 0 hangs still, 4 is a breeze, 10 a strong wind.
uniform float wind_speed : hint_range(0.0, 30.0) = 4.0;
// Largest sideways movement in meters, at the free edge in a 4 m/s wind.
uniform float amplitude : hint_range(0.0, 1.0) = 0.1;
// Length of one wave along the cloth, in meters.
uniform float wave_length : hint_range(0.1, 10.0) = 1.0;
// The cloth's size in meters: along the waves (from the pinned edge) and across them.
uniform vec2 cloth_size = vec2(1.5, 1.0);
// Small fast ripples on top of the main waves, from 0 to 1.
uniform float flutter : hint_range(0.0, 1.0) = 0.35;
// Time offset, so that flags side by side do not move together.
uniform float phase = 0.0;

float offset_at(float s, float c, float t, float k) {
	float grow = pow(s, 1.4);
	return grow * (sin(k * s - 3.0 * t) + flutter * 0.5 * sin(2.7 * k * s - 5.3 * t + 4.0 * c));
}

void vertex() {
	float s = pinned_edge == 0 ? UV.x : UV.y;
	float c = pinned_edge == 0 ? UV.y : UV.x;
	float strength = amplitude * clamp(wind_speed / 4.0, 0.0, 3.0);
	float t = TIME * (0.5 + 0.2 * wind_speed) + phase;
	float k = 6.2831853 * cloth_size.x / wave_length;
	float e = 0.01;
	float here = offset_at(s, c, t, k);
	float slope_s = (offset_at(min(s + e, 1.0), c, t, k) - offset_at(max(s - e, 0.0), c, t, k)) / (min(s + e, 1.0) - max(s - e, 0.0));
	float slope_c = (offset_at(s, c + e, t, k) - offset_at(s, c - e, t, k)) / (2.0 * e);
	vec3 along_s = normalize(pinned_edge == 0 ? TANGENT : BINORMAL);
	vec3 along_c = normalize(pinned_edge == 0 ? BINORMAL : TANGENT);
	VERTEX += NORMAL * strength * here;
	vec3 tilted = NORMAL - along_s * strength * slope_s / cloth_size.x - along_c * strength * slope_c / cloth_size.y;
	NORMAL = normalize(tilted);
}

void fragment() {
	vec4 texel = texture(albedo_texture, UV);
	ALBEDO = albedo_color.rgb * texel.rgb;
	ROUGHNESS = roughness;
	ALPHA_SCISSOR_THRESHOLD = 0.5;
	ALPHA = albedo_color.a * texel.a;
}
