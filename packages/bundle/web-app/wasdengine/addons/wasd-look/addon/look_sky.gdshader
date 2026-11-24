// SPDX-License-Identifier: CC0-1.0
// The sky of WasdLook3D: a gradient from horizon to zenith, the ground below, the sun's or moon's disc and glow, a
// layer of clouds lit from the sun's side, and stars. It reads no clock and no light: WasdLook3D hands it the sun's
// direction and moves the clouds, so the sky's light is redrawn only when a value changes. It draws on the Forward+,
// Mobile, and Compatibility renderers.
shader_type sky;

#include "res://addons/wasd_look/look_tone.gdshaderinc"

uniform vec3 sky_top : source_color = vec3(0.20, 0.40, 0.80);
uniform vec3 sky_horizon : source_color = vec3(0.62, 0.76, 0.92);
uniform vec3 ground_horizon : source_color = vec3(0.52, 0.56, 0.58);
uniform vec3 ground_bottom : source_color = vec3(0.18, 0.17, 0.15);
uniform float sky_energy = 1.0;
// Unit vector toward the sun or moon.
uniform vec3 sun_direction = vec3(0.0, 1.0, 0.0);
uniform vec3 sun_color : source_color = vec3(1.0, 0.96, 0.90);
// 0 hides the disc and its glow.
uniform float sun_shine = 1.0;
// Degrees across the disc.
uniform float sun_size = 1.6;
// How far the glow around the disc reaches: 1 is a clear day, 3 a hazy sunset.
uniform float sun_glow = 1.0;
uniform sampler2D cloud_noise : repeat_enable, filter_linear_mipmap;
uniform float clouds : hint_range(0.0, 1.0) = 0.35;
uniform vec3 cloud_color : source_color = vec3(1.0);
// Where the clouds have drifted to, in turns of the noise. The finer layers move by whole multiples of it, so that
// a turn of 1 is the same sky as 0.
uniform vec2 cloud_offset = vec2(0.0);
uniform float stars : hint_range(0.0, 1.0) = 0.0;

float wasd_star_hash(vec3 cell) {
	cell = fract(cell * 0.1031);
	cell += dot(cell, cell.zyx + 31.32);
	return fract((cell.x + cell.y) * cell.z);
}

// How thick the cloud layer is above a point of the flat ceiling it lies on, from 0 (clear) to 1: broad shapes cut
// off at a level that the cover sets, with their thin parts eaten away by finer shapes.
// `heavy` tells how far the layer is above its middle weight there, from 0 to 1: the dark bellies of a closed sky.
float wasd_cloud_thickness(vec2 at, out float heavy) {
	const mat2 turned = mat2(vec2(0.8, 0.6), vec2(-0.6, 0.8));
	float broad = texture(cloud_noise, at * 0.085 + cloud_offset).r * 0.62
		+ texture(cloud_noise, turned * at * 0.23 + cloud_offset * 2.0 + vec2(0.37, 0.11)).r * 0.38;
	float fine = texture(cloud_noise, at * 0.71 + cloud_offset * 3.0 + vec2(0.71, 0.53)).r;
	float thickness = clamp((broad - mix(0.76, 0.2, clouds)) / 0.2, 0.0, 1.0);
	heavy = smoothstep(0.4, 0.68, broad * 0.8 + fine * 0.2);
	return clamp(thickness - fine * 0.55 * (1.0 - thickness), 0.0, 1.0);
}

void sky() {
	vec3 eye = normalize(EYEDIR);
	float up = eye.y;
	vec3 sun_light = wasd_light(sun_color);
	vec3 cloud_light = wasd_light(cloud_color);
	// Away from a low sun the horizon takes on the color of the sky above it.
	float low_sun = 1.0 - smoothstep(0.0, 0.5, sun_direction.y);
	float away = 0.5 - 0.5 * dot(normalize(eye.xz + vec2(0.00001)), normalize(sun_direction.xz + vec2(0.00001)));
	vec3 top_light = wasd_light(sky_top);
	vec3 horizon_light = mix(wasd_light(sky_horizon), top_light, 0.6 * away * low_sun * sun_shine);
	vec3 color;
	if (up >= 0.0) {
		// A band of the horizon's color lies along the horizon, where fog fades the far ground into the same color.
		// The sky has its own color from about 30 degrees up.
		color = mix(horizon_light, top_light, smoothstep(0.0, 0.52, up));
	} else {
		// Below the horizon the same band continues, so that a world that ends short of the horizon, faded by fog of
		// this color, has no edge; further down lies the color of far ground.
		vec3 ground = mix(wasd_light(ground_horizon), wasd_light(ground_bottom), pow(clamp(-up * 3.0, 0.0, 1.0), 0.6));
		color = mix(horizon_light, ground, smoothstep(0.02, 0.3, -up));
	}
	color *= sky_energy;

	float toward_sun = max(dot(eye, sun_direction), 0.0);
	float shine = sun_shine * smoothstep(-0.1, 0.02, sun_direction.y);
	// A wide soft glow and a tight one around the sun, stronger and wider in haze, held near the horizon when the sun
	// is low.
	float band = mix(1.0, exp(-abs(up) * 6.0), low_sun * 0.9);
	// Four rings of glow, so that the sky brightens toward the sun long before the disc: a wide haze, a soft lift of
	// some 15 degrees, a halo, and a corona right round the disc. A glow of 0 would raise toward_sun to an endless
	// power, which has no value where it is 1.
	float reach = max(sun_glow, 0.05);
	vec3 glow = sun_light * shine * sky_energy * (pow(toward_sun, 8.0 / reach) * 0.14 * sun_glow * band + pow(toward_sun, 50.0 / reach) * 0.22
		+ pow(toward_sun, 320.0) * 0.4 + pow(toward_sun, 1800.0) * 0.8);
	if (up >= -0.03) {
		color += glow * smoothstep(-0.03, 0.02, up);
	}

	if (up > 0.0) {
		if (stars > 0.0 && !AT_CUBEMAP_PASS) {
			vec3 grid = eye * 190.0;
			vec3 cell = floor(grid);
			float seed = wasd_star_hash(cell);
			float dot_size = length(fract(grid) - 0.5);
			color += vec3(0.9, 0.95, 1.0) * stars * step(0.9965, seed) * smoothstep(0.42, 0.1, dot_size) * (0.4 + 0.6 * fract(seed * 91.7)) * smoothstep(0.0, 0.2, up);
		}
		float disc = 0.0;
		if (!AT_CUBEMAP_PASS && shine > 0.0) {
			float edge = cos(radians(sun_size * 0.5));
			disc = smoothstep(edge - 0.00012, edge + 0.00012, dot(eye, sun_direction));
		}
		float cover = 0.0;
		if (clouds > 0.0) {
			// The cloud layer is a flat ceiling: directions near the horizon see far along it.
			vec2 at = eye.xz / (up + 0.1);
			float heavy;
			float unused;
			float thickness = wasd_cloud_thickness(at, heavy);
			if (thickness > 0.0) {
				// A second reading a step toward the sun tells which side of a cloud this is: thinner that way is the lit
				// side, thicker the shaded one.
				vec2 sun_at = sun_direction.xz / (max(sun_direction.y, 0.0) + 0.1);
				vec2 step_to_sun = sun_at - at;
				step_to_sun = step_to_sun / max(length(step_to_sun), 0.001) * 0.4;
				float lit_side = clamp((thickness - wasd_cloud_thickness(at + step_to_sun, unused)) * 3.2, -1.0, 1.0);
				// Seen from below, a cloud is bright where it is thin or faces the sun and gray in its thick middle.
				// Seen from below, a cloud's body is in its own shade, gray by day and the color of the sky above it under
				// a low sun; its thin edges and the side toward the sun are bright.
				vec3 shade = mix(cloud_light * mix(0.5, 0.32, low_sun), mix(color / max(sky_energy, 0.001), top_light * 1.3, 0.6 * low_sun), 0.35 + 0.2 * low_sun);
				// Under a low sun only the clouds toward it are bright.
				float facing = mix(1.0, 0.5 + 0.5 * smoothstep(0.2, 0.9, toward_sun), low_sun);
				vec3 bright = (cloud_light * 0.95 + sun_light * shine * (0.12 + 0.35 * low_sun)) * facing;
				float body = smoothstep(0.05, 0.55, thickness) * (0.7 + 0.22 * low_sun);
				vec3 lit = mix(mix(bright, shade, body), bright, clamp(lit_side, 0.0, 1.0) * 0.85);
				// A sky that has closed shows its weight: dark bellies between paler stretches.
				lit *= 1.0 - 0.5 * heavy * smoothstep(0.6, 1.0, clouds);
				// Thin cloud in front of the sun lights up.
				lit += sun_light * shine * pow(toward_sun, 24.0) * (1.0 - thickness) * 0.8;
				float far = smoothstep(0.0, 0.14, up);
				cover = smoothstep(0.0, 0.26, thickness) * far;
				color = mix(color, lit * sky_energy, cover);
			}
		}
		color += sun_light * shine * disc * 5.0 * (1.0 - cover);
	}
	COLOR = wasd_sky_out(color, AT_CUBEMAP_PASS);
}
