// SPDX-License-Identifier: CC0-1.0
// The water surface of WASD Water, shared by water.gdshader (the full look) and water_fast.gdshader (no screen or
// depth reads). WasdWater3D sets every uniform; the shader also works on a mesh of your own, where `wave_shape` and
// `wave_motion` must be filled by hand. Lengths are meters and speeds meters per second. It runs on the Forward+,
// Mobile, and Compatibility renderers.
//
// How it draws water:
// - Waves are a sum of up to 32 trochoidal (Gerstner) waves, from the long swell down to chop a hand long. The
//   vertices follow the waves the mesh is fine enough for; every pixel takes its slope from all of them, and waves
//   smaller than a pixel turn into roughness, so far water glitters instead of flickering.
// - Where the waves press the surface together, at crests, light passes through the water (`scatter_color`) and foam
//   forms. Foam stays where a crest left it for `foam_trail` seconds and breaks up along `foam_noise`.
// - Under the surface the scene is bent, tinted by the depth of water the light crosses, and lit by caustics.
// - The surface mirrors the sky and ReflectionProbes, and with `reflection_mode` also the scene: found in the picture
//   on screen (1), or drawn by WasdWater3D's mirror camera (2).

// Seconds of water time. WasdWater3D advances it, so waves and height_at() agree and a paused game stops the water.
uniform float water_time = 0.0;

group_uniforms color;
// The tint light takes on in `color_depth` meters of water: what a white sea bed looks like at that depth.
uniform vec3 shallow_color : source_color = vec3(0.32, 0.72, 0.60);
// The color of the water itself, seen where it is too deep or too cloudy to show the bottom.
uniform vec3 deep_color : source_color = vec3(0.02, 0.15, 0.14);
uniform float color_depth = 3.0;
// How far one sees through the water, in meters.
uniform float clarity = 20.0;
// 0 blends the colors smoothly; 2 or more draws that many flat color bands (toon water).
uniform int color_steps = 0;
// Light the water gives off, as lava and glowing pools do: 0 none, 1 its own color, more with the Environment's glow.
uniform float glow = 0.0;
// Sunlight that passes through the water of wave crests and comes out colored.
uniform vec3 scatter_color : source_color = vec3(0.10, 0.70, 0.55);
uniform float scatter_strength = 0.0;
// water_fast.gdshader only: how opaque the water is seen from straight above; it is opaque at a flat angle.
uniform float fast_opacity = 0.75;

group_uniforms surface;
uniform float roughness = 0.05;
// Scales every mirror reflection: 1 is water, 0 none.
uniform float reflectivity = 1.0;
// How far the surface bends the view of what lies under it.
uniform float refraction = 1.0;
// Ripples smaller than the waves: a tiling normal map that crosses itself in two layers.
uniform sampler2D surface_normal_map : hint_normal, filter_linear_mipmap, repeat_enable;
uniform float surface_scale = 1.5;
uniform float surface_strength = 0.3;
uniform float surface_speed = 0.15;
// The sun's glitter: its brightness, the size of each glint, and how hard its edge is (1 is a toon highlight).
uniform float glint_strength = 0.7;
uniform float glint_size = 0.12;
uniform float glint_hardness = 0.0;
// Breaks the sun's mirror image into sparks a few pixels wide, near and far: 0 leaves it whole, 1 scatters it widely.
uniform float glint_sparkle = 0.25;
// Flat-shaded faces (low-poly water) instead of smooth waves.
uniform bool flat_shading = false;
// Size of the squares that colors, foam, and ripples snap to (retro water); 0 is smooth.
uniform float pixel_size = 0.0;

group_uniforms reflection;
// What the surface mirrors besides the sky and ReflectionProbes: 0 nothing more, 1 the scene as it is on screen,
// 2 the picture of WasdWater3D's mirror camera in `planar_texture`.
uniform int reflection_mode = 0;
// Screen reflections: how many steps each ray takes, and how far it reaches in meters.
uniform int reflection_steps = 24;
uniform float reflection_distance = 80.0;
// How much the waves bend the mirrored picture.
uniform float reflection_distortion = 0.6;
uniform sampler2D planar_texture : source_color, filter_linear, repeat_disable, hint_default_black;
// The part of the water plane the mirror camera drew: least x and z, then 1 / width and 1 / depth.
uniform vec4 planar_window = vec4(0.0, 0.0, 1.0, 1.0);

group_uniforms waves;
// One wave each, longest first. Shape: direction x and z (normalized), wave number (TAU / length), amplitude.
// Motion: radians per second, starting phase, sideways amplitude, and half the square of its slope, which is the
// roughness the wave turns into where a pixel cannot show it.
uniform vec4 wave_shape[32];
uniform vec4 wave_motion[32];
uniform int wave_count = 0;
// Half the height of the larger waves: what "a crest" means for foam and for the light through crests.
uniform float wave_scale = 0.1;
// Waves flatten between these distances from the camera; an end of 0 keeps them everywhere.
uniform float wave_fade_start = 0.0;
uniform float wave_fade_end = 0.0;
// Distance between the mesh's vertices, and how much it grows per meter from the camera; 0 for a mesh of your own.
uniform float mesh_cell = 0.0;
uniform float mesh_cell_growth = 0.0;

group_uniforms flow;
// The current, which carries ripples and foam: along world X and Z, or along the mesh's UV with `flow_along_uv`.
uniform vec2 flow = vec2(0.0);
// Waves, ripples, and foam follow the mesh's UV, in meters, instead of the world: a river ribbon that bends.
uniform bool flow_along_uv = false;
// Both faces of the mesh are the water's surface, as a waterfall's are.
uniform bool two_sided = false;
// The camera is under the surface, which then shows its underside. WasdWater3D sets it every frame; a wave that
// rises above the eye is not seen from below, so the face a triangle shows cannot tell.
uniform bool eye_under = false;

group_uniforms foam;
uniform vec3 foam_color : source_color = vec3(0.90, 0.93, 0.95);
// A tiling pattern that breaks foam up: foam shows first where it is bright.
uniform sampler2D foam_noise : filter_linear_mipmap, repeat_enable, hint_default_white;
uniform float foam_scale = 3.0;
uniform float foam_speed = 0.1;
// How much longer than wide the foam's pattern is, along the way the waves travel: 1 is round, 3 long streaks.
uniform float foam_stretch = 1.0;
// 0 fades foam softly, 1 cuts it out with a hard edge.
uniform float foam_hardness = 0.35;
// Foam where the water meets land and objects: how deep the water is where the foam ends, and its amount.
uniform float shore_foam_width = 0.15;
uniform float shore_foam = 0.3;
// Bands of foam that travel to the shore, this many across the foam's width; 0 none.
uniform float shore_foam_lines = 0.0;
// Foam on wave crests, from 0 to 1.
uniform float crest_foam = 0.0;
// Seconds the foam of a crest stays on the water behind it, and how many of the longest waves leave such foam.
uniform float foam_trail = 2.5;
uniform int foam_trail_waves = 3;
// Foam where the surface is steep: rapids and waterfalls.
uniform float slope_foam = 0.0;

group_uniforms caustics;
// Light patterns on what lies under the water: brightness, size of the pattern, and the depth they fade over.
uniform float caustics = 0.4;
uniform float caustics_scale = 2.5;
uniform float caustics_depth = 4.0;
// A tiling pattern of bright lines; two layers of it cross.
uniform sampler2D caustics_pattern : filter_linear_mipmap, repeat_enable, hint_default_black;

group_uniforms edge;
// The water fades in over this depth where it meets land, so its edge is soft.
uniform float edge_fade = 0.15;

group_uniforms rings;
// Rings that spread from where something touched the water: x, z, the water_time it started, strength.
uniform vec4 rings[8];
uniform int ring_count = 0;
uniform float ring_speed = 1.6;
uniform float ring_life = 3.0;
group_uniforms;

#ifdef WASD_WATER_FULL
uniform sampler2D wasd_screen : hint_screen_texture, filter_linear, repeat_disable;
uniform sampler2D wasd_depth : hint_depth_texture, filter_nearest, repeat_disable;
#endif

// Waves beyond this many only shade the surface: they are too small to fold it.
const int FOLD_WAVES = 12;
// The mesh moves sideways by this part of what the shading shows, so that the steepest crests do not turn
// triangles over.
const float MESH_PINCH = 0.6;
// The part of light that water mirrors when seen from straight above.
const float WATER_MIRROR = 0.02;

varying vec3 world_position;
varying vec3 mesh_normal;
// Where the waves are worked out: the world's x and z, or the UV of a ribbon.
varying vec2 rest_position;
varying vec2 flow_position;
// How steep the mesh is from 0 to 1, and how much of their height the waves keep this far from the camera.
varying float surface_slope;
varying float wave_fade;
// From fragment() to light(): foam from 0 to 1, the squared width of the highlight, how much of a crest this is, and
// the part of the light that the surface lets through.
varying float foam_amount;
varying float glint_spread;
varying float crest_amount;
varying float let_through;
// How far this part of a wave leans toward the eye, from 0 to 1: the eye looks through such a slope into the wave.
varying float lean_to_eye;
// The surface as the sun's glitter sees it, in view space: the normal with the finest ripples added.
varying vec3 sparkle_normal;

void vertex() {
	vec3 rest = VERTEX;
	float away = distance(rest.xz, CAMERA_POSITION_WORLD.xz);
	float fade = 1.0;
	if (wave_fade_end > 0.0) {
		fade = 1.0 - smoothstep(wave_fade_start, wave_fade_end, away);
	}
	// A wave shorter than a few cells of the mesh would move it at random, so it only shades the surface there.
	float cell = max(mesh_cell, away * mesh_cell_growth);
	vec2 at = flow_along_uv ? UV : rest.xz;
	vec3 moved = vec3(0.0);
	for (int i = 0; i < wave_count; i++) {
		vec4 shape = wave_shape[i];
		vec4 motion = wave_motion[i];
		float carried = fade * (cell > 0.0 ? smoothstep(3.0, 6.0, TAU / (shape.z * cell)) : 1.0);
		if (carried <= 0.0) {
			break;
		}
		float phase = shape.z * dot(shape.xy, at) - motion.x * water_time + motion.y;
		moved.y += shape.w * carried * sin(phase);
		if (!flow_along_uv) {
			moved.xz += shape.xy * (motion.z * MESH_PINCH * carried * cos(phase));
		}
	}
	surface_slope = 1.0 - clamp(NORMAL.y, 0.0, 1.0);
	wave_fade = fade;
	mesh_normal = NORMAL;
	world_position = rest + moved;
	rest_position = at;
	flow_position = flow_along_uv ? UV : rest.xz;
	VERTEX = world_position;
}

// The ripples that break the sun's mirror image into sparks, at tile size 2 to the power of `level` meters. Odd and
// even levels lie crosswise and drift different ways, so two neighboring levels never line up.
vec2 spark_ripples(vec2 at, float level, float time, float detail) {
	float tile = exp2(level);
	bool odd = mod(level, 2.0) > 0.5;
	vec2 uv = odd ? at.yx / tile - vec2(time * 0.015, 0.0) : at / tile + vec2(0.0, time * 0.02);
	return textureLod(surface_normal_map, uv, detail).rg * 2.0 - 1.0;
}

// Soft blotches from 0 to 1, about one to a unit of `at`: where foam gathers.
float blotches(vec2 at) {
	vec2 cell = floor(at);
	vec2 within = at - cell;
	within = within * within * (3.0 - 2.0 * within);
	vec4 corners = fract(sin(vec4(dot(cell, vec2(127.1, 311.7)), dot(cell + vec2(1.0, 0.0), vec2(127.1, 311.7)), dot(cell + vec2(0.0, 1.0), vec2(127.1, 311.7)), dot(cell + vec2(1.0, 1.0), vec2(127.1, 311.7)))) * 43758.5453);
	return mix(mix(corners.x, corners.y, within.x), mix(corners.z, corners.w, within.x), within.y);
}

// How much of a wave a pixel shows, from 0 to 1. `pixel` holds the size of a pixel on the water across the line of
// sight, the direction of sight on the water, and how much longer the pixel is along it: a wave is whole when its
// length in the direction it travels is 12 pixels or more and lost at 3, because a wave drawn with fewer pixels
// changes too much from one pixel to the next, which flickers.
float wave_seen(vec4 shape, vec4 pixel) {
	float lean = dot(shape.xy, pixel.yz);
	float size = pixel.x * sqrt(1.0 + (pixel.w * pixel.w - 1.0) * lean * lean);
	return 1.0 - smoothstep(0.08, 0.3, size * shape.z / TAU);
}

// The waves at a resting position: `slope` is how the surface rises along x and z, `squeeze` how much they press
// the surface together along x, along z, and across (positive at crests), `height` their height, and `lost` the
// slope of the waves that are too small for a pixel and so left out.
void waves_at(vec2 at, float time, float fade, vec4 pixel, out vec2 slope, out vec3 squeeze, out float height, out float lost) {
	slope = vec2(0.0);
	squeeze = vec3(0.0);
	height = 0.0;
	lost = 0.0;
	for (int i = 0; i < wave_count; i++) {
		vec4 shape = wave_shape[i];
		vec4 motion = wave_motion[i];
		float seen = fade * wave_seen(shape, pixel);
		lost += (1.0 - seen) * motion.w;
		if (seen <= 0.0) {
			continue;
		}
		float phase = shape.z * dot(shape.xy, at) - motion.x * time + motion.y;
		float up = sin(phase) * seen;
		slope += shape.xy * (shape.z * shape.w * seen * cos(phase));
		float pinch = shape.z * motion.z * up;
		squeeze += vec3(shape.x * shape.x, shape.y * shape.y, shape.x * shape.y) * pinch;
		height += shape.w * up;
	}
}

// How far the larger waves fold the surface at a resting position: 1 on flat water, toward 0 where a crest is about
// to break, more than 1 in troughs.
float fold_at(vec2 at, float time, float fade, vec4 pixel) {
	vec3 squeeze = vec3(0.0);
	int count = min(wave_count, FOLD_WAVES);
	for (int i = 0; i < count; i++) {
		vec4 shape = wave_shape[i];
		vec4 motion = wave_motion[i];
		float seen = fade * wave_seen(shape, pixel);
		float pinch = shape.z * motion.z * seen * sin(shape.z * dot(shape.xy, at) - motion.x * time + motion.y);
		squeeze += vec3(shape.x * shape.x, shape.y * shape.y, shape.x * shape.y) * pinch;
	}
	return (1.0 - squeeze.x) * (1.0 - squeeze.y) - squeeze.z * squeeze.z;
}

#ifdef WASD_WATER_FULL
// Where the scene behind a screen position lies, in view space.
vec3 scene_view_position(vec2 screen_uv, mat4 inv_projection) {
	float depth = textureLod(wasd_depth, screen_uv, 0.0).r;
#if CURRENT_RENDERER == RENDERER_COMPATIBILITY
	vec4 view = inv_projection * vec4(vec3(screen_uv, depth) * 2.0 - 1.0, 1.0);
#else
	vec4 view = inv_projection * vec4(screen_uv * 2.0 - 1.0, depth, 1.0);
#endif
	return view.xyz / view.w;
}

// Follows a mirrored ray from the surface through the picture of the scene and returns the color it meets, with how
// sure the meeting is in alpha: 0 where the ray leaves the picture or meets nothing, and the sky shows instead.
vec4 screen_reflection(vec3 from, vec3 direction, float level, float start, mat4 projection, mat4 inv_projection, mat4 inv_view) {
	float grow = 1.18;
	float stride = reflection_distance * (grow - 1.0) / (pow(grow, float(reflection_steps)) - 1.0);
	float gone = stride * start;
	for (int i = 0; i < reflection_steps; i++) {
		float next = gone + stride;
		vec3 point = from + direction * next;
		vec4 clip = projection * vec4(point, 1.0);
		if (clip.w <= 0.0) {
			break;
		}
		vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
		// Beyond the sides of the picture the scene is taken to go on as it is at the picture's edge.
		uv.x = clamp(uv.x, 0.002, 0.998);
		if (uv.y < 0.0 || uv.y > 1.0) {
			if (uv.y < 0.0) {
				// The ray left the picture at its top edge. Where a tree or a cliff stands there, taller than the
				// picture, its mirror image goes on in the color of its top row; where sky does, the sky's does.
				vec2 top = vec2(uv.x, 0.002);
				vec3 above = scene_view_position(top, inv_projection);
				if (above.z > point.z * 1.5 && (inv_view * vec4(above, 1.0)).y > level) {
					return vec4(textureLod(wasd_screen, top, 0.0).rgb, 0.7);
				}
			}
			break;
		}
		float gap = scene_view_position(uv, inv_projection).z - point.z;
		if (gap > 0.0 && gap < stride * 1.2 + 0.2) {
			// The ray went into something between the last step and this one: close in on where.
			float near = gone;
			float far = next;
			for (int refine = 0; refine < 5; refine++) {
				float middle = 0.5 * (near + far);
				vec3 tried = from + direction * middle;
				vec4 tried_clip = projection * vec4(tried, 1.0);
				vec2 tried_uv = tried_clip.xy / tried_clip.w * 0.5 + 0.5;
				tried_uv.x = clamp(tried_uv.x, 0.002, 0.998);
				if (scene_view_position(tried_uv, inv_projection).z - tried.z > 0.0) {
					far = middle;
				} else {
					near = middle;
				}
			}
			vec3 met = from + direction * far;
			vec4 met_clip = projection * vec4(met, 1.0);
			vec2 met_uv = met_clip.xy / met_clip.w * 0.5 + 0.5;
			met_uv.x = clamp(met_uv.x, 0.002, 0.998);
			vec3 met_scene = scene_view_position(met_uv, inv_projection);
			// What lies under the surface is not mirrored, and neither is something much nearer than the ray.
			if ((inv_view * vec4(met_scene, 1.0)).y < level - 0.05 || met_scene.z - met.z > stride * 1.2 + 0.2) {
				gone = next;
				stride *= grow;
				continue;
			}
			// The mirror image thins toward the top of the picture, where what it mirrors is cut off, down to what a
			// ray that leaves the picture there gets.
			float sure = mix(0.7, 1.0, smoothstep(0.0, 0.12, met_uv.y)) * (1.0 - smoothstep(0.8, 1.0, far / reflection_distance));
			// A little blur, wider for what is mirrored from further off, as ripples spread a mirror image.
			vec2 wide = (0.0015 + 0.004 * far / reflection_distance) * vec2(2.0, 1.0);
			vec3 color = textureLod(wasd_screen, met_uv, 0.0).rgb * 0.4;
			color += textureLod(wasd_screen, met_uv + wide * vec2(1.0, 0.5), 0.0).rgb * 0.15;
			color += textureLod(wasd_screen, met_uv + wide * vec2(-1.0, 0.5), 0.0).rgb * 0.15;
			color += textureLod(wasd_screen, met_uv + wide * vec2(0.3, -1.0), 0.0).rgb * 0.15;
			color += textureLod(wasd_screen, met_uv + wide * vec2(-0.3, 1.0), 0.0).rgb * 0.15;
			return vec4(color, sure);
		}
		gone = next;
		stride *= grow;
	}
	return vec4(0.0);
}
#endif

void fragment() {
	vec2 at = rest_position;
	vec2 position = flow_position;
	if (pixel_size > 0.0) {
		at = (floor(at / pixel_size) + 0.5) * pixel_size;
		position = (floor(position / pixel_size) + 0.5) * pixel_size;
	}
	vec2 carried = position - flow * water_time;

	// The directions on the surface that the waves' x and z mean: the world's, or across and along a ribbon.
	vec3 level_normal = normalize(mesh_normal);
	vec3 across = vec3(1.0, 0.0, 0.0);
	vec3 along = vec3(0.0, 0.0, 1.0);
	if (flow_along_uv) {
		vec3 dx = dFdx(world_position);
		vec3 dy = dFdy(world_position);
		vec2 ux = dFdx(flow_position);
		vec2 uy = dFdy(flow_position);
		float area = ux.x * uy.y - ux.y * uy.x;
		if (abs(area) > 1e-9) {
			across = normalize((dx * uy.y - dy * ux.y) / area);
			along = normalize((dy * ux.x - dx * uy.x) / area);
		}
	}

	// The size of a pixel on the water, from the camera and not from the mesh, whose triangles each tilt their own way.
	// The projection's vertical scale is negative where the renderer draws the picture upside down.
	vec3 to_eye = CAMERA_POSITION_WORLD - world_position;
	float eye_distance = length(to_eye);
	to_eye /= eye_distance;
	vec4 pixel = vec4(2.0 * (PROJECTION_MATRIX[3][3] == 0.0 ? eye_distance : 1.0) / (abs(PROJECTION_MATRIX[1][1]) * VIEWPORT_SIZE.y), 0.0, 0.0, 1.0);
	if (!flow_along_uv) {
		pixel.yz = normalize(to_eye.xz + vec2(1e-6, 0.0));
		// At a flat angle a pixel is many times longer than wide, but the wave faces that lean toward the eye stay
		// in sight, so the length counts up to five times the width.
		pixel.w = 1.0 / max(abs(dot(to_eye, level_normal)), 0.2);
	}

	vec2 slope;
	vec3 squeeze;
	float height;
	float lost;
	waves_at(at, water_time, wave_fade, pixel, slope, squeeze, height, lost);
	float pinch = squeeze.x + squeeze.y;
	float fold = (1.0 - squeeze.x) * (1.0 - squeeze.y) - squeeze.z * squeeze.z;
	float crest = clamp(height / max(wave_scale, 0.0001), -2.0, 2.0);

	// Ripples: two layers of the normal map that cross each other.
	vec2 ripple = vec2(0.0);
	if (surface_strength > 0.0) {
		float drift = surface_speed * water_time;
		vec2 first = texture(surface_normal_map, (carried + vec2(0.8, 0.6) * drift) / surface_scale).rg;
		vec2 second = texture(surface_normal_map, (carried.yx * vec2(1.0, -1.0) + vec2(0.5, -0.86) * drift) / (surface_scale * 0.57)).rg;
		ripple = (first + second - 1.0) * surface_strength;
	}

	// Rings from touches: each is a short wave train on a growing circle.
	float ring_foam = 0.0;
	for (int i = 0; i < ring_count; i++) {
		vec4 ring = rings[i];
		float age = water_time - ring.z;
		if (age < 0.0 || age > ring_life) {
			continue;
		}
		vec2 away = position - ring.xy;
		float distance_from = length(away);
		float inside = age * ring_speed - distance_from;
		float envelope = smoothstep(-0.15, 0.0, inside) * exp(-max(inside, 0.0) * 2.5) * (1.0 - age / ring_life) * ring.w;
		ripple += away / max(distance_from, 0.001) * (sin(inside * 14.0) * envelope * 0.8);
		ring_foam = max(ring_foam, envelope * smoothstep(0.55, 1.0, sin(inside * 14.0 + 1.2)));
	}

	vec3 normal = normalize(level_normal * max(1.0 - pinch, 0.15) - across * (slope.x - ripple.x) - along * (slope.y - ripple.y));
	if (flat_shading) {
		normal = normalize(cross(dFdy(world_position), dFdx(world_position)));
		if (normal.y < 0.0) {
			normal = -normal;
		}
		// Facets differ little in slope, so their tilt is drawn stronger than it is.
		normal = normalize(vec3(normal.x * 2.5, normal.y, normal.z * 2.5) + vec3(ripple.x, 0.0, ripple.y));
	}
	bool from_below = !two_sided && eye_under;
	if (from_below || (two_sided && !FRONT_FACING)) {
		normal = -normal;
	}
	if (!from_below) {
		// Of waves too small for a pixel, the eye sees the sides that lean toward it; the others hide behind them.
		// So rough water seen at a flat angle never faces the eye less than its waves slope, and it mirrors the
		// sky from higher up and more faintly than still water does.
		float leaning = min(sqrt(2.0 * lost), 0.35);
		float faces = dot(normal, to_eye);
		if (faces < leaning) {
			normal = normalize(normal + to_eye * (leaning - faces));
		}
	}
	// How much of what this pixel mirrors is sky: a slope that leans toward the eye mirrors the water in front of
	// it, which is darker, so its mirror image is drawn fainter and from the horizon.
	float sky_mirrored = 1.0;
	if (!from_below && surface_slope < 0.2) {
		vec3 bounced = reflect(-to_eye, normal);
		sky_mirrored = mix(0.45, 1.0, smoothstep(-0.5, 0.05, bounced.y));
		if (bounced.y < 0.03) {
			bounced.y = 0.03;
			normal = normalize(to_eye + normalize(bounced));
		}
	}
	NORMAL = normalize(mat3(VIEW_MATRIX) * normal);
	sparkle_normal = NORMAL;
	if (glint_sparkle > 0.0 && glint_strength > 0.0) {
		// Sparks are a few pixels wide at any distance: their ripples are drawn at the tile size whose texels are
		// as large as a pixel on the water, blended from the two sizes next to it, each twice the other. Ripples
		// of a fixed size would blur nearby and flicker far off.
		float level = log2(max(pixel.x * pixel.w, 0.00001) * float(textureSize(surface_normal_map, 0).x));
		float nearer = floor(level);
		float blend = level - nearer;
		vec2 fine = mix(spark_ripples(carried, nearer, water_time, blend), spark_ripples(carried, nearer + 1.0, water_time, 0.0), blend);
		sparkle_normal = normalize(mat3(VIEW_MATRIX) * normalize(normal + (across * fine.x + along * fine.y) * glint_sparkle));
	}

	// Gusts roughen the water in patches tens of meters across, which far off show as lighter and darker bands.
	float gust = wave_count > 0 ? mix(0.6, 1.5, blotches(at * 0.011 + vec2(water_time * 0.008, 3.7))) : 1.0;
	// Waves too small for a pixel blur the sky's reflection and widen the sun's highlight instead of tilting the
	// surface. `roughness` blurs the sky's reflection only; the highlight keeps its own size, `glint_size`.
	float rough = sqrt(sqrt(clamp(roughness * roughness * roughness * roughness * gust * gust + lost, 0.000004, 1.0)));
	float spread = clamp(lost * 0.1, 0.000004, 0.003);
	float facing = clamp(dot(normal, to_eye), 0.0, 1.0);
	float mirror_scale = reflectivity * sky_mirrored;
	float mirror = mix(pow(1.0 - facing, 5.0 * exp(-2.69 * rough)) / (1.0 + 22.7 * pow(rough, 1.5)), 1.0, WATER_MIRROR) * mirror_scale;

	// Foam. `foam_shape` breaks it up: foam shows where the shape is brighter than what is left of the foam.
	vec2 foam_at = carried;
	if (flow_along_uv) {
		// Falling water stretches its foam into streaks and speeds it up.
		foam_at.y = position.y / (1.0 + surface_slope * 5.0) - flow.y * water_time;
	}
	if (!flow_along_uv && wave_count > 0) {
		// Streaks lie along the way the longest wave travels.
		vec2 wind = wave_shape[0].xy;
		foam_at = vec2(wind.y * foam_at.x - wind.x * foam_at.y, dot(wind, foam_at) / max(foam_stretch, 0.01));
	}
	vec2 foam_uv = (foam_at + vec2(0.3, 0.7) * foam_speed * water_time) / foam_scale;
	// Foam is lace: the pattern's bright strands show first, a finer copy of it frays them, and soft blotches make
	// the foam thick in one place and thin in the next.
	float gathered = blotches(foam_uv * 1.7) * 0.6 + blotches(foam_uv * 4.3 + vec2(3.1, 7.7)) * 0.4;
	float foam_shape = clamp(texture(foam_noise, foam_uv).r * 0.8 + texture(foam_noise, foam_uv * 2.7 + vec2(0.4, 0.1)).r * 0.3, 0.0, 1.0);
	float foam_edge = mix(0.35, 0.02, foam_hardness);
	float foam = ring_foam;
	float churned = 0.0;
	if (crest_foam > 0.0 && wave_count > 0) {
		// White caps form where the waves fold the surface. A crest breaks along some stretches and holds along
		// others.
		float breaks = mix(0.1, 0.95, crest_foam) * mix(0.55, 1.15, blotches(at * 0.045 + vec2(7.3, 1.9)));
		churned = 1.0 - smoothstep(breaks - 0.3, breaks, fold);
		if (foam_trail > 0.0) {
			// Foam stays where a crest left it. For each of the longest waves, the moment its crest last passed
			// this place follows from its phase; if the sea was breaking here then, its foam is still here, and
			// thins out until `foam_trail` seconds have passed.
			int trails = min(foam_trail_waves, wave_count);
			for (int i = 0; i < trails; i++) {
				vec4 shape = wave_shape[i];
				vec4 motion = wave_motion[i];
				float phase = shape.z * dot(shape.xy, at) - motion.x * water_time + motion.y;
				float ago = mod(0.25 * TAU - phase, TAU) / max(motion.x, 0.0001);
				if (ago < foam_trail) {
					float then = 1.0 - smoothstep(breaks - 0.3, breaks, fold_at(at, water_time - ago, wave_fade, pixel));
					churned = max(churned, then * (1.0 - ago / foam_trail));
				}
			}
		}
		// Even fresh foam keeps the holes of its pattern, and old foam thins out before it is gone.
		float cover = churned * (0.45 + 0.6 * gathered);
		// Far off a pixel holds more of the pattern than it can show; there foam is as white as there is foam in it,
		// which keeps distant white caps from flickering.
		float far_foam = smoothstep(0.3, 1.5, pixel.x * pixel.w / max(foam_scale * 0.25, 0.01));
		float crest_edge = mix(foam_edge, 0.75, far_foam);
		foam = max(foam, smoothstep(1.0 - cover - crest_edge, 1.0 - cover + crest_edge, foam_shape) * smoothstep(0.0, 0.1, churned) * mix(0.65, 1.0, churned));
	}
	if (slope_foam > 0.0) {
		// White water where the surface falls: streaks on a slope, almost solid on a waterfall.
		float steep = smoothstep(0.02, 0.6, surface_slope) * slope_foam;
		float cut = mix(0.95, 0.06, steep);
		foam = max(foam, smoothstep(cut - foam_edge, cut + foam_edge, foam_shape) * step(0.001, steep));
	}

	// Crests let light through; water full of bubbles under fresh foam does too.
	crest_amount = clamp(smoothstep(-0.25, 1.4, crest) * (0.45 + 1.1 * (1.0 - clamp(fold, 0.0, 1.0))) + churned * churned * 0.3, 0.0, 1.5);
	// The light is stronger on one stretch of a crest than on the next, as the water there is thinner or thicker.
	crest_amount *= mix(0.5, 1.0, blotches(at * 0.07 + vec2(water_time * 0.02, 0.0)));
	// Far off, where a pixel holds whole waves, the light through single crests is lost in the haze.
	crest_amount *= 1.0 - smoothstep(0.05, 0.5, pixel.x * pixel.w / max(wave_scale * 8.0, 0.5));
	lean_to_eye = clamp((dot(normal, to_eye) - dot(level_normal, to_eye)) * 3.0, 0.0, 1.0);
	glint_spread = spread;

#ifdef WASD_WATER_FULL
	vec3 view_position = VERTEX;
	vec3 behind_view = scene_view_position(SCREEN_UV, INV_PROJECTION_MATRIX);
	vec3 behind = (INV_VIEW_MATRIX * vec4(behind_view, 1.0)).xyz;
	// How much water lies over what is behind this pixel: its depth under the surface where the eye looks down at
	// the water, and the distance to it along the line of sight where the eye looks along the water or up at a wave,
	// because what stands behind a crest is not under it. Land that meets the water gets its foam either way.
	float depth_here = mix(view_position.z - behind_view.z, max(world_position.y - behind.y, 0.0), smoothstep(0.02, 0.12, to_eye.y));

	if (from_below) {
		// Seen from under the surface. Within 48 degrees of straight up the world above shows, bent by the waves;
		// beyond that the surface mirrors the water below it.
		float up = clamp(dot(normal, to_eye), 0.0, 1.0);
		float window = smoothstep(0.62, 0.74, up);
		vec2 bent_uv = clamp(SCREEN_UV + (NORMAL.xy - normalize(mat3(VIEW_MATRIX) * -level_normal).xy) * refraction * 0.25, vec2(0.001), vec2(0.999));
		vec3 above = mix(texture(wasd_screen, bent_uv).rgb, shallow_color, 0.2);
		ALBEDO = vec3(0.0);
		EMISSION = mix(deep_color * 0.6, above, window) + shallow_color * glow;
		ROUGHNESS = rough;
		SPECULAR = 0.35 * (1.0 - window);
		foam_amount = 0.0;
		let_through = 0.0;
		crest_amount = 0.0;
	} else {
		// Refraction: look at the scene a little to the side, unless what lies there is in front of the water.
		vec2 bend = (NORMAL.xy - normalize(mat3(VIEW_MATRIX) * level_normal).xy) * refraction * 0.12;
		vec2 bent_uv = clamp(SCREEN_UV + bend * clamp(depth_here, 0.0, 1.0) / max(1.0, -view_position.z * 0.1), vec2(0.001), vec2(0.999));
		vec3 bent_view = scene_view_position(bent_uv, INV_PROJECTION_MATRIX);
		vec3 bottom = (INV_VIEW_MATRIX * vec4(bent_view, 1.0)).xyz;
		if (bent_view.z > view_position.z || world_position.y - bottom.y < 0.0) {
			bent_uv = SCREEN_UV;
			bent_view = behind_view;
			bottom = behind;
		}
		float depth = max(world_position.y - bottom.y, 0.0);
		float through = distance(bent_view, view_position);
		// What lies under water is wet, and wet stone and sand are darker than dry.
		vec3 scene = texture(wasd_screen, bent_uv).rgb * mix(1.0, 0.78, smoothstep(0.0, 0.05, depth));

		// Caustics reach the bottom of shallow water only, so deep water does not pay for them.
		float caustics_lit = caustics * smoothstep(0.0, 0.1, depth) * exp(-depth / max(caustics_depth, 0.01));
		if (caustics_lit > 0.004) {
			// Two layers of the pattern cross; red, green, and blue land a little apart, as light split by waves does.
			vec2 spot = (bottom.xz + normal.xz * depth * 0.6) / caustics_scale;
			float drift = water_time * 0.07;
			vec3 lines = vec3(0.0);
			for (int band = 0; band < 3; band++) {
				vec2 shifted = spot + vec2(float(band) - 1.0) * 0.002;
				lines[band] = min(texture(caustics_pattern, shifted + vec2(drift, drift * 0.6)).r, texture(caustics_pattern, shifted * 1.31 - vec2(drift * 0.8, drift)).r);
			}
			scene += scene * smoothstep(vec3(0.05), vec3(0.9), lines) * 1.8 * caustics_lit;
		}

		// Light that crosses water loses red first: the tint deepens with the distance crossed, and the water's own
		// color takes over where the bottom is lost.
		float crossed = through / max(color_depth, 0.01);
		float murk = through / max(clarity, 0.01);
		if (color_steps > 1) {
			// Bands follow the depth of the water, not the line of sight, so they lie along the shore.
			crossed = floor(depth / max(color_depth, 0.01) * float(color_steps) + 0.5) / float(color_steps);
			murk = floor(depth * 2.0 / max(clarity, 0.01) * float(color_steps) + 0.5) / float(color_steps);
		}
		vec3 kept = pow(max(shallow_color, vec3(0.001)), vec3(crossed)) * exp(-3.0 * murk);
		float body = 1.0 - (kept.r + kept.g + kept.b) / 3.0;
		if (color_steps > 1) {
			body = floor(body * float(color_steps) + 0.5) / float(color_steps);
		}

		if (shore_foam > 0.0) {
			// Lacy foam that thickens toward the land, where a solid line of it lies.
			float closeness = 1.0 - clamp(depth_here / max(shore_foam_width, 0.001), 0.0, 1.0);
			float amount = closeness;
			if (shore_foam_lines > 0.0) {
				float band = sin((depth_here / max(shore_foam_width, 0.001) * shore_foam_lines + water_time * 0.35) * TAU) * 0.5 + 0.5;
				amount = closeness * (0.35 + 0.9 * smoothstep(0.5, 0.9, band));
			}
			float cut = mix(0.95, 0.4, clamp(amount * shore_foam, 0.0, 1.0));
			float shore = smoothstep(cut - foam_edge, cut + foam_edge, foam_shape) * step(0.001, closeness);
			// The line of foam along the water's edge is broken, like the foam itself.
			shore = max(shore, smoothstep(0.8, 0.95, closeness) * shore_foam * smoothstep(0.1, 0.55, foam_shape));
			foam = max(foam, shore);
		}
		foam = clamp(foam, 0.0, 1.0);
		foam_amount = foam;
		float calm = 1.0 - foam;
		let_through = (1.0 - mirror) * calm;

		// The scene mirrored in the surface, where a reflection mode finds it.
		vec4 mirrored = vec4(0.0);
		if (reflection_mode == 1) {
			// The ray follows a calmer surface than the pixel's, and the waves shift where its color is read.
			vec3 ray_normal = normalize(mat3(VIEW_MATRIX) * normalize(mix(level_normal, normal, clamp(0.35 * reflection_distortion, 0.0, 1.0))));
			vec3 ray = reflect(normalize(view_position), ray_normal);
			// Each pixel's ray starts a little nearer or further, so that steps do not show as bands.
			float start = mix(0.35, 0.65, fract(52.9829189 * fract(dot(FRAGCOORD.xy, vec2(0.06711056, 0.00583715)))));
			mirrored = screen_reflection(view_position, ray, world_position.y, start, PROJECTION_MATRIX, INV_PROJECTION_MATRIX, INV_VIEW_MATRIX);
		} else if (reflection_mode == 2) {
			vec2 shifted = world_position.xz + (normal.xz - level_normal.xz) * reflection_distortion * 0.07 * eye_distance;
			vec2 window_uv = (shifted - planar_window.xy) * planar_window.zw;
			if (window_uv.x > 0.0 && window_uv.x < 1.0 && window_uv.y > 0.0 && window_uv.y < 1.0) {
				mirrored = texture(planar_texture, vec2(window_uv.x, 1.0 - window_uv.y));
				vec2 edge = smoothstep(vec2(0.0), vec2(0.03), window_uv) * (1.0 - smoothstep(vec2(0.97), vec2(1.0), window_uv));
				mirrored.a *= edge.x * edge.y;
			}
		}
		mirrored.a *= calm;

		ALBEDO = mix(deep_color * body * (1.0 - mirror), foam_color, foam);
		// A liquid that glows does so in its shallow color where it is shallow.
		vec3 glowing = mix(shallow_color, deep_color, 1.0 - exp(-3.0 * depth / max(color_depth, 0.01)));
		EMISSION = scene * kept * let_through + glowing * glow * calm + mirrored.rgb * mirrored.a * mirror;
		ROUGHNESS = mix(rough, 1.0, foam);
		// Below 0.35 Godot scales the sky's reflection with the square of SPECULAR.
		SPECULAR = 0.3536 * sqrt(clamp(mirror_scale * calm * (1.0 - mirrored.a), 0.0, 1.0));
		if (edge_fade > 0.0) {
			// Far off the soft edge widens with the size of a pixel, so a distant shore does not flicker.
			ALPHA = smoothstep(0.0, edge_fade + min(pixel.x * pixel.w * 0.2, edge_fade * 3.0 + 0.2), depth_here);
		}
	}
#else
	foam = clamp(foam, 0.0, 1.0);
	foam_amount = foam;
	float calm = 1.0 - foam;
	let_through = (1.0 - mirror) * calm;
	float deep = 1.0 - facing * 0.6;
	if (color_steps > 1) {
		deep = floor(deep * float(color_steps) + 0.5) / float(color_steps);
	}
	vec3 water = mix(shallow_color, deep_color, deep);
	ALBEDO = mix(water * (1.0 - mirror), foam_color, foam);
	EMISSION = water * glow * calm;
	ROUGHNESS = mix(rough, 1.0, foam);
	SPECULAR = 0.3536 * sqrt(clamp(mirror_scale * calm, 0.0, 1.0));
	ALPHA = mix(mix(1.0, fast_opacity, facing), 1.0, foam);
#endif
}

void light() {
	float toward_light = dot(NORMAL, LIGHT);
	float lit = clamp(toward_light, 0.0, 1.0);
	float seen = clamp(dot(NORMAL, VIEW), 0.0, 1.0);
	float calm = 1.0 - foam_amount;
	// Water takes its light from every side, a little more where it faces the light or the eye; foam is matte.
	float body = 0.35 + 0.4 * lit + 0.25 * seen * seen;
	DIFFUSE_LIGHT += mix(body, lit * 0.5 + 0.3, foam_amount) * ATTENUATION * LIGHT_COLOR / PI;

	if (scatter_strength > 0.0) {
		// Light crosses the thin water of a crest and comes out colored: strongest where the eye looks toward the
		// light through a slope that leans toward it.
		float into_light = pow(clamp(dot(LIGHT, -VIEW) * 0.5 + 0.5, 0.0, 1.0), 3.0);
		float crossing = crest_amount * (0.08 + 2.0 * (0.15 + 0.85 * into_light) * (0.2 + 0.8 * lean_to_eye)) + 0.04 * seen * seen;
		SPECULAR_LIGHT += scatter_color * (scatter_strength * crossing * let_through) * ATTENUATION * LIGHT_COLOR / PI;
	}

	if (glint_strength > 0.0) {
		// The light's mirror image, spread by the waves a pixel cannot show and by the size of the sun.
		vec3 halfway = normalize(VIEW + LIGHT);
		float size = clamp(glint_size, 0.0, 1.0);
		float spread = clamp(glint_spread + size * size * size * 0.05, 0.000004, 1.0);
		float across_halfway = clamp(dot(sparkle_normal, halfway), 0.0, 1.0);
		float lobe = across_halfway * across_halfway * (spread - 1.0) + 1.0;
		float highlight = spread / (PI * lobe * lobe);
		float mirror = WATER_MIRROR + (1.0 - WATER_MIRROR) * pow(1.0 - clamp(dot(VIEW, halfway), 0.0, 1.0), 5.0);
		float visible = 0.25 / max(mix(lit * seen, 1.0, sqrt(spread)), 0.05);
		float glint = highlight * mirror * visible * lit;
		if (glint_hardness > 0.0) {
			glint = mix(glint, smoothstep(0.5, 0.5 + 0.5 * (1.0 - glint_hardness) + 0.01, glint * 0.25) * 3.0, glint_hardness);
		}
		SPECULAR_LIGHT += glint * glint_strength * calm * ATTENUATION * LIGHT_COLOR;
	}
}
