// SPDX-License-Identifier: CC0-1.0
// The look of the finished picture, in one pass over the screen: WasdPost covers the screen with it. It reads what is
// drawn below its canvas layer, the 3D world with its transparent things included, and leaves what is drawn above it,
// such as the HUD, alone. It runs the same on the Forward+, Mobile, and Compatibility renderers.
shader_type canvas_item;

uniform sampler2D wasd_screen : hint_screen_texture, filter_linear_mipmap, repeat_disable;

// How much of the look shows, from 0 (the plain picture) to 1.
uniform float amount : hint_range(0.0, 1.0) = 1.0;

// Lens.
// Color fringes toward the corners, in pixels at the corner.
uniform float aberration = 0.0;
// Edge contrast, from 0 to 1.
uniform float sharpen : hint_range(0.0, 1.0) = 0.0;
// Blur above and below a sharp band, in pixels at the screen's top and bottom edge: the look of a miniature.
uniform float tilt_shift = 0.0;
// Where the sharp band lies, from 0 (top) to 1 (bottom), and half its height.
uniform float tilt_focus : hint_range(0.0, 1.0) = 0.55;
uniform float tilt_band : hint_range(0.0, 0.5) = 0.12;
// Side of the square blocks the picture is drawn in, in pixels; 1 and below draws every pixel.
uniform float pixel_size = 1.0;

// Color.
// Brightness in photographic stops: 1 doubles it.
uniform float exposure = 0.0;
uniform float contrast = 1.0;
uniform float saturation = 1.0;
// From -1 (cool, blue) to 1 (warm, orange).
uniform float temperature : hint_range(-1.0, 1.0) = 0.0;
// Tints of the dark and the bright tones, as the screen shows them; middle gray tints nothing.
uniform vec3 shadows = vec3(0.5);
uniform vec3 highlights = vec3(0.5);
// Steps per color channel, 2 or more; 0 keeps every shade.
uniform float color_levels = 0.0;
// Steps of brightness, with each color's own hue kept: the flat shades of a comic. 2 or more; 0 keeps every shade.
uniform float tone_levels = 0.0;

// Frame.
// Darkening toward the corners, how gradually it sets in, and its color. From 0 to 1 the corners darken; up to 2 they
// go fully dark and the dark closes in on the picture's sides.
uniform float vignette : hint_range(0.0, 2.0) = 0.0;
uniform float vignette_softness : hint_range(0.05, 1.0) = 0.55;
uniform vec3 vignette_color = vec3(0.0);
// Film grain, from 0 to 1.
uniform float grain : hint_range(0.0, 1.0) = 0.0;
// Dark horizontal lines of an old screen, from 0 to 1.
uniform float scanlines : hint_range(0.0, 1.0) = 0.0;
// The bulge of an old screen's glass, and the red, green, and blue stripes of its picture tube, from 0 to 1.
uniform float curve : hint_range(0.0, 1.0) = 0.0;
uniform float mask : hint_range(0.0, 1.0) = 0.0;
// A soft glow laid over the picture, as through a misted lens, from 0 to 1.
uniform float soften : hint_range(0.0, 1.0) = 0.0;
// Ink lines where the picture's brightness steps, from 0 to 1, and their color.
uniform float edges : hint_range(0.0, 1.0) = 0.0;
uniform vec3 edge_color = vec3(0.05, 0.05, 0.08);
// A color the graded picture is multiplied by: green for a night-vision scope.
uniform vec3 tint = vec3(1.0);
// Pencil shading on paper in place of the picture's tones, from 0 to 1: the darker a place, the closer its strokes.
uniform float hatch : hint_range(0.0, 1.0) = 0.0;

float wasd_hash(vec2 at) {
	vec3 p = fract(vec3(at.xyx) * 0.1031);
	p += dot(p, p.yzx + 33.33);
	return fract((p.x + p.y) * p.z);
}

// The picture at a point, from one of the smaller copies the renderer keeps of it: each level up is twice as soft.
// The renderers soften their copies by different amounts, so this serves only the wide glow, where that does not show.
vec3 wasd_smooth(vec2 uv, float level) {
	return textureLod(wasd_screen, clamp(uv, vec2(0.0005), vec2(0.9995)), level).rgb;
}

vec3 wasd_sample(vec2 uv) {
	return wasd_smooth(uv, 0.0);
}

// The picture at a point, softened over a disc of `radius` pixels.
vec3 wasd_soft(vec2 uv, float radius, vec2 pixel) {
	if (radius < 0.5) {
		return wasd_sample(uv);
	}
	vec3 sum = wasd_sample(uv);
	for (int tap = 0; tap < 8; tap++) {
		float angle = float(tap) * 0.785398 + 0.4;
		float reach = (tap % 2 == 0) ? 1.0 : 0.55;
		sum += wasd_sample(uv + vec2(cos(angle), sin(angle)) * radius * reach * pixel);
	}
	return sum / 9.0;
}

void fragment() {
	vec2 pixel = SCREEN_PIXEL_SIZE;
	vec2 uv = SCREEN_UV;
	vec3 plain = textureLod(wasd_screen, uv, 0.0).rgb;
	float on_glass = 1.0;
	if (curve > 0.0) {
		// The picture as on bulging glass: pushed outward toward the corners, and black beyond the glass's edge.
		vec2 bulged = uv - 0.5;
		bulged *= 1.0 + curve * 0.9 * dot(bulged, bulged);
		// The middle of each side stays at the screen's edge, so that only the corners are lost.
		uv = bulged / (1.0 + curve * 0.225) + 0.5;
		// The glass has round corners and a soft edge.
		float beyond = length(max(abs(uv - 0.5) - vec2(0.5 - 0.035), vec2(0.0)));
		on_glass = 1.0 - smoothstep(0.03, 0.036, beyond);
	}

	if (pixel_size > 1.0) {
		vec2 block = pixel * pixel_size;
		uv = (floor(uv / block) + 0.5) * block;
	}
	float away = abs(uv.y - tilt_focus) - tilt_band;
	float blur = tilt_shift * smoothstep(0.0, max(0.5 - tilt_band, 0.001), away);

	vec2 from_centre = uv - 0.5;
	float edge = length(from_centre * vec2(1.0, pixel.x / pixel.y) * 1.2);
	vec3 color;
	// A drawn look works from a picture without the grain of its textures, and a misted lens loses detail toward its rim.
	// Steps of brightness finer than 16 need less of that, and those of a fade's first moments, too fine to see, none.
	float flatten = step(2.0, tone_levels) * 2.6 * min(1.0, 16.0 / max(tone_levels, 1.0));
	blur = max(blur, max(max(edges * 1.6, flatten), soften * 7.0 * smoothstep(0.1, 0.7, edge)));
	if (aberration > 0.0) {
		vec2 shift = from_centre * dot(from_centre, from_centre) * 4.0 * aberration * pixel;
		color = vec3(wasd_soft(uv + shift, blur, pixel).r, wasd_soft(uv, blur, pixel).g, wasd_soft(uv - shift, blur, pixel).b);
	} else {
		color = wasd_soft(uv, blur, pixel);
	}
	if (hatch > 0.0) {
		// Strokes follow the broad light and dark of the picture, not the grain of its surfaces, and a dark picture is
		// drawn as if it were lit: by how much darker it is, over all, than a picture in daylight.
		color = mix(color, wasd_smooth(uv, 2.0), hatch * 0.85);
		float usual = dot(wasd_smooth(vec2(0.5), 16.0), vec3(0.2126, 0.7152, 0.0722));
		color *= mix(1.0, clamp(0.4 / max(usual, 0.02), 1.0, 8.0), hatch);
	}
	if (sharpen > 0.0) {
		vec3 around = wasd_sample(uv + vec2(pixel.x, 0.0)) + wasd_sample(uv - vec2(pixel.x, 0.0))
			+ wasd_sample(uv + vec2(0.0, pixel.y)) + wasd_sample(uv - vec2(0.0, pixel.y));
		color = max(color + (color - around * 0.25) * sharpen * 1.5, vec3(0.0));
	}

	if (soften > 0.0) {
		// The picture's own light, spread wide and laid back over it.
		vec3 spread = wasd_smooth(uv, 3.0) * 0.35 + wasd_smooth(uv, 4.5) * 0.35 + wasd_smooth(uv, 6.0) * 0.3;
		color = mix(color, 1.0 - (1.0 - color) * (1.0 - spread * 0.65), soften);
	}
	float ink = 0.0;
	if (edges > 0.0) {
		// Where the color steps from one side to the other, a line is drawn.
		vec2 reach = pixel * 1.8;
		float across = length(wasd_sample(uv + vec2(reach.x, 0.0)) - wasd_sample(uv - vec2(reach.x, 0.0)));
		float down = length(wasd_sample(uv + vec2(0.0, reach.y)) - wasd_sample(uv - vec2(0.0, reach.y)));
		ink = smoothstep(0.16, 0.42, length(vec2(across, down))) * edges;
	}

	color *= exp2(exposure);
	color *= vec3(1.0 + temperature * 0.12, 1.0, 1.0 - temperature * 0.12);
	float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
	color = mix(vec3(luma), color, saturation);
	color = (color - 0.5) * contrast + 0.5;
	// Dark tones take the shadows tint and bright tones the highlights tint, each by how far it is from middle gray.
	float bright = smoothstep(0.0, 1.0, dot(clamp(color, 0.0, 1.0), vec3(0.2126, 0.7152, 0.0722)));
	color += (shadows - 0.5) * (1.0 - bright) * 0.5 + (highlights - 0.5) * bright * 0.5;
	color = clamp(color, 0.0, 1.0);
	if (color_levels >= 2.0) {
		color = floor(color * (color_levels - 1.0) + 0.5) / (color_levels - 1.0);
	}
	// The patterns of the drawn looks are as large as on a window 720 pixels high, and never finer than on one.
	vec2 at = FRAGCOORD.xy * min(1.0, 720.0 * pixel.y);
	if (tone_levels >= 2.0) {
		// Between two shades, the dots of a printed comic: larger the closer the tone is to the lighter shade.
		vec2 cell = fract(mat2(vec2(0.7071, 0.7071), vec2(-0.7071, 0.7071)) * at / 7.0) - 0.5;
		float dots = (length(cell) * 1.4142 - 0.5) * 0.42;
		float value = max(color.r, max(color.g, color.b));
		float shade = clamp(floor(value * tone_levels * 0.999 - dots), 0.0, tone_levels - 1.0);
		color *= (shade + 0.5) / (tone_levels * max(value, 0.001));
	}
	// A tinted picture's brightest places burn toward white, as a scope's do.
	float burn = pow(dot(color, vec3(0.2126, 0.7152, 0.0722)), 4.0) * 0.75;
	color = color * tint + (1.0 - tint) * burn;
	if (hatch > 0.0) {
		// Strokes in three directions on paper: sparse in the middle tones, crossed in the dark, dense in the darkest.
		float tone = dot(color, vec3(0.2126, 0.7152, 0.0722));
		// Each direction of strokes presses harder as the tone darkens, as a pencil does.
		float stroke = max(step(0.7, fract((at.x + at.y) * 0.17)) * smoothstep(0.76, 0.58, tone),
			max(step(0.7, fract((at.x - at.y) * 0.17)) * smoothstep(0.5, 0.36, tone), step(0.68, fract((at.x + at.y * 0.35) * 0.25)) * smoothstep(0.26, 0.12, tone)));
		color = mix(color, mix(vec3(0.96, 0.94, 0.87), edge_color, stroke * 0.8), hatch);
	}
	// Ink in a dark shade of the color it lies on.
	color = mix(color, mix(edge_color, color * 0.25, 0.4), ink);

	float dark = min(smoothstep(0.75 - vignette_softness * 0.7, 0.9, edge) * vignette, 1.0);
	color = mix(color, vignette_color, dark);
	if (grain > 0.0) {
		float speck = wasd_hash(FRAGCOORD.xy + fract(TIME * 7.0) * 311.0) - 0.5;
		color += speck * grain * 0.35 * (1.0 - luma * 0.5);
	}
	// An old screen has 240 lines, however many pixels the window has; a line is never thinner than two pixels.
	float line = max(2.0, floor(1.0 / (pixel.y * 240.0) + 0.5));
	if (scanlines > 0.0) {
		color *= 1.0 - scanlines * 0.25 * (1.0 - cos(6.28318 * (FRAGCOORD.y / line - 0.25)));
	}
	if (mask > 0.0) {
		// A picture tube's stripes: every third column a little redder, greener, or bluer.
		float column = mod(floor(FRAGCOORD.x / max(1.0, floor(line * 0.5))), 3.0);
		color *= mix(vec3(1.0), vec3(0.8) + 0.5 * vec3(step(column, 0.5), step(abs(column - 1.0), 0.5), step(1.5, column)), mask);
	}
	color *= on_glass;
	COLOR = vec4(mix(plain, clamp(color, 0.0, 1.0), amount), 1.0);
}
