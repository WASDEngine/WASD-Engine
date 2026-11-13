---
name: godot-web
description: Make a Godot game look right and run smoothly in browsers, where WASD Engine releases play it with the Compatibility renderer (WebGL 2). Load before starting a new Godot game, before writing a shader or a large level generator, and when a Web check, a Web run, or the user reports a problem in the browser.
---

# Godot games on the Web

WASD Engine releases play in browsers, where Godot draws with the Compatibility renderer (WebGL 2) whatever renderer the project uses on desktop, and runs scripts and drawing on one thread.

## Choose the renderer

Start new games on the Compatibility renderer: put `renderer/rendering_method="gl_compatibility"` under `[rendering]` in `project.godot` and `"GL Compatibility"` after the release in `config/features`, so the game looks the same on desktop and in the browser. Choose Forward+ only when the user wants desktop-only effects such as SDFGI or volumetric fog. A project on another renderer still plays on the Web with the Compatibility renderer: run every visual change with `godot_run` and `web: true` too, which draws the game as browsers do.

## Write for the Compatibility renderer

- Shaders read `source_color` textures as sRGB values there, because Godot converts `ALBEDO` to linear after the shader runs; math that mixes such a sample with linear values, such as dividing it by a linear average, comes out too bright.
- Depth from `hint_depth_texture` maps to normalized device coordinates with `vec3(SCREEN_UV, depth) * 2.0 - 1.0` there, instead of Forward+'s `vec3(SCREEN_UV * 2.0 - 1.0, depth)`. A shader for both renderers branches with `#if CURRENT_RENDERER == RENDERER_COMPATIBILITY`.
- SSR, SDFGI, VoxelGI, volumetric fog, FogVolume shaders, TAA, FSR, and `GPUParticles3D.emit_particle()` do nothing there. Give each particle effect its own one-shot `CPUParticles3D` or `GPUParticles3D` node and `restart()` it.
- The `SOFT_VERY_LOW` shadow filter takes a single shadow sample there, so shadows look blocky without Forward+'s softening; use `SOFT_LOW` or better.
- Browsers keep the instance uniforms of all objects in one buffer of 16 to 64 KB, enough for about 60 to 250 objects; past that, objects read zeros. Give per-object values through shared materials, vertex colors, or MultiMesh custom data instead.

## Keep the browser tab responsive and fast

- No frame may run for seconds, or the tab freezes and the browser offers to close it: build levels in chunks with `await get_tree().process_frame` between them, and show a progress screen while they build.
- Each new material, light setup, or particle effect compiles shaders the first time it is drawn, which stalls the frame; avoid showing many at once, for example at nightfall.
- Keep draw calls under about 1,500 per frame: merge static meshes, draw repeated objects with `MultiMeshInstance3D`, and give small distant objects visibility ranges.
- Players download the whole pack before the game starts: keep it under about 100 MB, with textures at 2048 px or less and music as Ogg Vorbis.
- Keep `physics/common/physics_ticks_per_second` at 60 unless the game needs more, and `physics/common/max_physics_steps_per_frame` low, so a slow frame does not run many physics steps.

## Check the Web build

`wasd_export_web` and `wasd_release_game` end with a Web check: a browser opens the build, watches it start and run without input, and reports its start time, freezes, frame rate, draw calls, and the errors it printed, with findings that say what to fix. Fix what it reports, then export again to check.
