// SPDX-License-Identifier: CC0-1.0
// WASD Water's full look: the water bends and tints what lies under it, colors itself by depth, draws shore foam and
// caustics, and can mirror the scene. It reads the screen and depth textures, which every renderer has. WasdWater3D
// uses it by default.
shader_type spatial;
render_mode world_vertex_coords, cull_disabled;

#define WASD_WATER_FULL
#include "water.gdshaderinc"
