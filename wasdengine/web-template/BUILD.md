# Web export template

The Godot plugin (`@deepseek-ai/dsh-godot`) exports games for the Web with Godot's single-threaded Web release template, `web_nothreads_release.zip`: the engine compiled to WebAssembly, its JavaScript loader, and the page. A Web build always renders with the Compatibility renderer (WebGL 2), so a game made with Forward+ meets that renderer's limits in the browser. This directory builds WASD Engine's own template: Godot 4.7.2 with the patches below, compiled with the Emscripten release of Godot's own template, so that every exported game gets the fixes without changes of its own.

| Path | Role |
|---|---|
| [patches/](patches) | Changes to Godot's source, applied in file-name order. |
| [build.sh](build.sh) | Installs Emscripten, builds the template, and packages it. |
| [template.py](template.py) | Writes the template, the export templates archive, and `manifest.json` for `build.sh`, and checks them for the release workflow. |
| [test_template.py](test_template.py) | Tests of `template.py`. |
| [wasd-web-template.yml](../../.github/workflows/wasd-web-template.yml) | Builds the template and publishes the release. |

## The patches

Each patch changes one behavior of Godot 4.7.2-stable; they apply in file-name order. The numbers come from Shotgun Dave, a Forward+ game with 1,500 to 3,000 draw calls a frame and a 373 MB pack, exported once with Godot's official template and once with this one, and loaded in Chrome for Testing 156 with ANGLE on Metal on an Apple M3 Pro, at a device pixel ratio of 2, with a fresh browser profile and an emptied Metal shader cache for each load. A probe script in a copy of the game moved the camera, took screenshots, and spawned bullet impacts; the page timed every WebGL call that can wait for the GPU process.

| Shotgun Dave, cold load | Godot 4.7.2 | This template |
|---|---|---|
| Loading screen gone | 49.3 s | 19.5 s |
| Main-thread tasks over 50 ms until playable | 71.2 s, the longest 46.4 s | 34.8 s, the longest 17.2 s |
| Time in shader compile and link status queries until playable | 57.2 s | 12.7 s |
| Shader programs linked by the first playable frame | 334 | 201 |
| "Too many instances using shader instance variables" errors | 72 | 0 |
| Framebuffer status queries during the run | 1,359, 8.1 s | 0 |
| Frame rate in the car view during impacts | 17 fps | 60 fps |

The longest task left is mostly the game's own: its scripts build the town in one frame, 10.6 s of the 17.2 s. Each column is one load, so the times vary by a few seconds between loads; a second load of an earlier build with all six patches took the loading screen away after 18.1 s, with a longest task of 16.3 s.

[0001-instance-uniforms-reserve-used-indices.patch](patches/0001-instance-uniforms-reserve-used-indices.patch) gives an instance with `instance uniform`s only the slots of the global shader uniform buffer that its materials' indices reach, the highest `instance_index` plus one, instead of `MAX_INSTANCE_UNIFORM_INDICES` (16). The Compatibility renderer keeps that buffer in a uniform block, which Chrome limits to 16 KiB, 1,024 slots, so about 60 such instances fit and the rest logged "Too many instances using shader instance variables" and read zeros: Shotgun Dave's cars drew black with white patches and opaque glass. Its car shaders use indices 0 to 3, so about 250 such instances fit in place of about 60, and all of its 66 cars draw. An instance moves to a larger allocation when a new material reaches further, updates are bounded by the allocation, and a failed allocation leaves no record, so a later material change can retry. The interface change reaches the RenderingDevice and dummy storage, which reserve the same counts.

[0002-gles3-filter-soft-very-low-shadows.patch](patches/0002-gles3-filter-soft-very-low-shadows.patch) filters shadows at `SHADOW_QUALITY_SOFT_VERY_LOW` with five taps (`SHADOW_MODE_PCF_5`), as at `SOFT_LOW`. The Compatibility renderer took one comparison sample at `SOFT_VERY_LOW`. Forward+ jitters that one sample for each pixel and frame and smooths it with TAA, which the Compatibility renderer lacks, so presets made for Forward+ that pick `SOFT_VERY_LOW`, like all but the highest of Shotgun Dave's, showed each shadow map texel as a hard block. The filter softens the block edges; it adds no resolution, so a small shadow atlas still looks coarse.

[0003-web-skip-framebuffer-status-queries.patch](patches/0003-web-skip-framebuffer-status-queries.patch) stops release Web builds from calling `glCheckFramebufferStatus`. WebGL answers `checkFramebufferStatus()` only after the browser's GPU process has run every command queued before the call, so each call blocks the main thread behind pending texture uploads and shader compiles. Most callers query once after they create a framebuffer, but `RenderSceneBuffersGLES3::check_backbuffer()` queries on every frame in which a material reads the screen or depth texture, so each such frame waited for the GPU: Shotgun Dave's official build made 412 queries during 20 seconds in its car view, which waited 4.8 s in all while the view ran at 17 frames per second. The renderer uses the answer to print an error and drop the framebuffer, so `platform/web/platform_gl.h` defines the call as `GL_FRAMEBUFFER_COMPLETE` when `DEBUG_ENABLED` is off. The one caller that falls back, the multisampled 3D buffers, which turn MSAA off on an incomplete framebuffer, still queries.

[0004-web-compile-shader-variants-on-use.patch](patches/0004-web-compile-shader-variants-on-use.patch) compiles each shader specialization of a Web build when a draw first binds it. Godot compiled every variant of a shader with the default specializations on first use, four programs for a material shader, before the specialization the draw needed; scene draws set specializations for their lights, shadows, and fog, so those programs went unused while each compile blocked the main thread. Shotgun Dave linked 201 programs before its first playable frame instead of 334. Desktop builds keep the eager compile, which fills their shader cache.

[0005-gles3-emit-particles.patch](patches/0005-gles3-emit-particles.patch) implements `GPUParticles3D.emit_particle()` and `GPUParticles2D.emit_particle()` in the Compatibility renderer, which ignored them with a warning, so effects emitted from scripts, such as all of Shotgun Dave's bullet impacts, never appeared. `particles_emit` queues each request, up to the system's amount, and ends the system's own emission as the RenderingDevice renderers do. Before the next process step, each request overwrites the color, velocity, custom data, and transform of one particle in the buffer that the step reads and flags it; the process shader starts a flagged particle from the supplied values and gives the others the RenderingDevice renderers' defaults, with the `RESTART_*` built-ins set for the `start()` code. The renderer has no atomics to find inactive particles, so requests take the particles in turn: a request restarts the particle that took the request `amount` before it, even when that one is still active, where the RenderingDevice renderers drop the request. Sub-emitters stay unsupported.

[0006-web-compile-3d-materials-async.patch](patches/0006-web-compile-3d-materials-async.patch) compiles the programs of 3D materials without blocking the page, with `KHR_parallel_shader_compile` where the browser offers it, as Chrome does; without it, draws wait as before. A draw whose specialization is not compiled yet starts compiling it and is skipped; later draws ask `GL_COMPLETION_STATUS_KHR`, which never waits, skip until the browser's compiler threads have linked the program, and then finish it and draw. A skipped draw requests another frame. Canvas, sky, particle process, and internal effect shaders still compile and wait, so the interface, the sky, and copies never drop out. Replaying the 201 programs that Shotgun Dave links while loading showed the gain: compiled and awaited one at a time, as Godot does, they took 32.0 s of main-thread time; submitted together and polled once a frame, all were linked after 6.4 s, while the main thread waited 0.4 s. Waiting only on the link status, without the compile status queries, still took 32.2 s, so the gain comes from compiling programs together. On the game, time in shader status queries until playable fell from 48.5 s, with patches 0001 to 0005, to 8.7 s, and the loading screen went 22 s earlier, in loads of the same build without and with this patch. The cost is that a 3D object can appear a few frames late the first time a material or light combination shows, where it used to freeze the page.

## Build locally

Prerequisites: macOS or Linux, Git, Python 3.8 or newer, and [uv](https://docs.astral.sh/uv/), whose `uvx` runs SCons 4.11.1 under a uv-managed CPython 3.13. `build.sh` clones [emsdk](https://github.com/emscripten-core/emsdk) at the tag of Emscripten 4.0.20 into `<out>/emsdk` and installs that release, about 2 GB, unless `--emsdk` names a checkout that has it.

```sh
# Clone Godot 4.7.2-stable into /tmp/web-template/godot-4.7.2-stable, patch it, build the template, and package it.
wasdengine/web-template/build.sh --out /tmp/web-template

# Build an existing Godot checkout with an existing emsdk.
wasdengine/web-template/build.sh --source ~/src/godot --emsdk ~/src/emsdk --out /tmp/web-template
```

`build.sh --help` lists every option. With `--source`, the script builds the checkout as it is: it applies the patches that the checkout lacks, skips those already applied, and never re-clones or resets it. SCons runs `platform=web target=template_release threads=no production=yes`, the options of Godot's own template, with `BUILD_NAME=wasd`, so the page's console reports `Godot Engine v4.7.2.stable.wasd`. SCons rebuilds only what changed, and `--scons-cache <dir>` keeps compiled objects across clones. A build from nothing, with the Emscripten install and an empty cache, took 16 minutes on an Apple M3 Pro busy with other work; with a filled cache, a build takes about three. Two such builds, from separate clones of Godot and emsdk, wrote byte-identical templates and archives.

To export with a local build, set the Godot plugin's `webTemplatePath` to `<out>/web_nothreads_release.zip`.

## Output

| File | Contents |
|---|---|
| `web_nothreads_release.zip` | The template: `godot.html`, `godot.js`, `godot.wasm`, `godot.audio.worklet.js`, `godot.audio.position.worklet.js`, `godot.service.worker.js`, and `godot.offline.html`, stored uncompressed in name order with fixed times and attributes, so equal builds give equal bytes. |
| `web-template-<version>.tpz` | The export templates archive: the template, compressed, as `templates/web_nothreads_release.zip`, and `templates/version.txt` naming the Godot version (`4.7.2.stable`), as in Godot's own export templates. |
| `manifest.json` | The versions and both files' sizes and digests. |

```json
{
  "format": 1,
  "version": "4.7.2-wasd.1",
  "godot": "4.7.2-stable",
  "emscripten": "4.0.20",
  "template": {
    "entry": "templates/web_nothreads_release.zip",
    "bytes": 39820685,
    "sha256": "<SHA-256 digest of web_nothreads_release.zip>"
  },
  "archive": {
    "url": "https://github.com/WASDEngine/WASD-Engine/releases/download/web-template-4.7.2-wasd.1/web-template-4.7.2-wasd.1.tpz",
    "bytes": 10192534,
    "sha256": "<SHA-256 digest of the archive>"
  }
}
```

The Godot plugin reads the archive as it reads Godot's own export templates: `webTemplateArchiveUrl` names it, `webTemplateEntry` names `templates/web_nothreads_release.zip`, and `webTemplateSha256` pins `template.sha256`. The plugin downloads only that entry with HTTP range requests and refuses a template with another digest.

## Test

```sh
python3 -B -m unittest discover --start-directory wasdengine/web-template --pattern 'test_*.py'
```

## Release

The Web export template workflow, [wasd-web-template.yml](../../.github/workflows/wasd-web-template.yml), runs only when dispatched, from the Actions tab or with `gh workflow run wasd-web-template.yml -f version=4.7.2-wasd.1 -f godot_ref=4.7.2-stable`. Its `check` job runs `bash -n` and ShellCheck on `build.sh` and the tests in this directory. The `build` job runs `build.sh` on macOS 26 (arm64) with an SCons cache keyed by the Godot ref, checks the output against `manifest.json`, writes the template's digest to the job summary, and uploads the three files as a workflow artifact that is kept for seven days.

When the workflow runs on the default branch, the `release` job checks the files again and requires that the plugin's `webTemplateSha256` default in `packages/gamedev/godot/src/index.ts` names this build's template, because the plugin refuses any other. It then creates the release `web-template-<version>` as a draft at the run's commit, or moves a draft that an earlier failed run left to that commit, attaches the archive and the template and then `manifest.json`, and publishes the release as a pre-release, so that it never becomes the repository's latest release. The job fails when the release is already published. A run on another branch stops after the build.

A published template version never changes. To publish a new one after changing the patches or the build options:

1. Build it with `build.sh`, and set the plugin's `webTemplateArchiveUrl` default to the new version's archive URL and `webTemplateSha256` to the `template.sha256` that `manifest.json` lists.
2. Dispatch the workflow on a branch with those defaults. When the job summary shows another digest, the runner's build differs from the local one: set `webTemplateSha256` to the digest the summary shows.
3. Merge, then dispatch the workflow on the default branch, which publishes the release.
