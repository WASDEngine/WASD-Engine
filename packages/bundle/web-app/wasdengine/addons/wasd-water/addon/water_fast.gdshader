// SPDX-License-Identifier: CC0-1.0
// WASD Water without screen or depth reads, for slow phones and crowded Web scenes: waves, ripples, crest foam, rings,
// the sky's reflection, and glitter stay; refraction, depth colors, shore foam, caustics, mirrored scenery, and the
// soft edge go, and the water blends over the scene instead. WasdWater3D uses it with
// `quality = WasdWater3D.Quality.FAST`.
shader_type spatial;
render_mode world_vertex_coords, cull_disabled;

#include "water.gdshaderinc"
