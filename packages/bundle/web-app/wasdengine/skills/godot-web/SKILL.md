---
name: godot-web
description: Make a Godot game look right and run smoothly in browsers, where WASD Engine releases play it with the Compatibility renderer (WebGL 2). Load before starting a new Godot game, before writing a shader, compute code, or a large level generator, before releasing or exporting the game, and when a Web check, a Web run, or the user reports a problem in the browser.
---

# Godot games on the Web

WASD Engine releases play in browsers, where Godot draws with the Compatibility renderer (WebGL 2) whatever renderer the project uses on desktop, and runs scripts and drawing on one thread.

## Choose the renderer

Start new games on the Compatibility renderer: put `renderer/rendering_method="gl_compatibility"` under `[rendering]` in `project.godot` and `"GL Compatibility"` after the release in `config/features`, so the game looks the same on desktop and in the browser. Choose Forward+ only when the user wants desktop-only effects such as SDFGI or volumetric fog. A project on another renderer still plays on the Web with the Compatibility renderer: run every visual change with `godot_run` and `web: true` too, which draws the game as browsers do.

## Write for the Compatibility renderer

- Shaders read `source_color` textures as sRGB values there, because Godot converts `ALBEDO` to linear after the shader runs; math that mixes such a sample with linear values, such as dividing it by a linear average, comes out too bright.
- Depth from `hint_depth_texture` maps to normalized device coordinates with `vec3(SCREEN_UV, depth) * 2.0 - 1.0` there, instead of Forward+'s `vec3(SCREEN_UV * 2.0 - 1.0, depth)`. A shader for both renderers branches with `#if CURRENT_RENDERER == RENDERER_COMPATIBILITY`.
- There is no RenderingDevice: `RenderingServer.get_rendering_device()` and `create_local_rendering_device()` return null, so compute shaders, RenderingDevice textures such as `Texture2DRD`, and `CompositorEffect`s do nothing or fail. Give such work a path that runs on the CPU or in ordinary shaders: cloth as `SoftBody3D` sheets on Jolt, such as those of the `wasd-cloth` add-on, and particles with `GPUParticles3D` process shaders or `CPUParticles3D`.
- SSAO, SSR, SDFGI, VoxelGI, volumetric fog, FogVolume shaders, TAA, FSR, SMAA, screen-space AA, and `GPUParticles3D.emit_particle()` do nothing there, most of them without a warning. Give each particle effect its own one-shot `CPUParticles3D` or `GPUParticles3D` node and `restart()` it.
- The `SOFT_VERY_LOW` shadow filter takes a single shadow sample there, so shadows look blocky without Forward+'s softening; use `SOFT_LOW` or better.
- Browsers keep the instance uniforms of all objects in one buffer of 16 to 64 KB, enough for about 60 to 250 objects; past that, objects read zeros. Give per-object values through shared materials, vertex colors, or MultiMesh custom data instead.

## Stand in for desktop-only effects

Approximate what browsers lack instead of dropping it. A game that keeps Forward+ on desktop switches to these stand-ins where `RenderingServer.get_current_rendering_method()` is `"gl_compatibility"`:

- Fog: the Environment's depth and height fog work. Make drifting fog banks from particles of large soft quads: an unshaded, alpha-blended `StandardMaterial3D` with particle billboards, a radial `GradientTexture2D`, and proximity fade, so the cards fade where they meet the ground.
- Light shafts, such as a lantern's or a torch's beam: an open cone mesh along the light, casting no shadow, with a shader that adds light where the cone faces the camera and fades toward its open end:

```gdshader
shader_type spatial;
render_mode blend_add, unshaded, cull_disabled, depth_draw_never, shadows_disabled;
uniform vec3 tint = vec3(1.0, 0.75, 0.45);
uniform float strength = 0.5;
void fragment() {
	float facing = pow(abs(dot(normalize(NORMAL), normalize(VIEW))), 2.0);
	ALBEDO = tint * strength * facing * (1.0 - UV.y);
}
```

- Glow: emission brighter than 1 with the Environment's glow works.
- Edges: MSAA (`rendering/anti_aliasing/quality/msaa_3d`) works where TAA, FSR, SMAA, and screen-space AA do not.
- Ambient occlusion: bake it into textures or vertex colors, for example in Blender.
- Cloth: `SoftBody3D` sheets on Jolt simulate in the browser too, as the RenderingDevice bullet above says.

The same light, fog, and color values can look different in the two renderers: tune the browser's look from what `godot_run` with `web: true` and the Web check's screenshot show, never from the numbers alone.

## Keep the browser tab responsive and fast

- No frame may run for seconds, or the tab freezes and the browser offers to close it: build levels in chunks with `await get_tree().process_frame` between them, and show a progress screen while they build.
- Each new material, light setup, or particle effect compiles shaders the first time it is drawn, which stalls the frame; avoid showing many at once, for example at nightfall.
- Keep draw calls under about 1,500 per frame: merge static meshes, draw repeated objects with `MultiMeshInstance3D`, and give small distant objects visibility ranges.
- Players download the whole pack before the game starts: keep it under about 100 MB, with textures at 2048 px or less and music as Ogg Vorbis.
- Keep `physics/common/physics_ticks_per_second` at 60 unless the game needs more, and `physics/common/max_physics_steps_per_frame` low, so a slow frame does not run many physics steps.

## Check the Web build

`wasd_export_web` and `wasd_release_game` run a Web check: a browser opens the build, watches it start and run without input, and reports its start time, freezes, frame rate, draw calls, and the errors it printed, with findings that say what to fix and a screenshot of the page. The export's result also names the project files that use what Web builds lack. While you build the game, fix what they report, look at the screenshot, and export again to check.

When the user asks to release, export, or share the game, do only that: release or export the game as it is and change none of its files in that turn. `wasd_release_game` checks the build before it uploads anything and publishes nothing when the game does not start, crashes, stops answering, or prints errors in the browser. Then tell the user what the check found and change the game only when they ask; to publish the build as it is, which only the user decides, call it again with `check` set to false.
