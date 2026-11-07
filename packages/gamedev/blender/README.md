---
description: "Headless Blender tools over MCP for deployments and maintainers choosing the bpy-module or installed-Blender backend, configuring the data directory and timeouts, or debugging the mcp__wasd_blender__ tools and their first-use setup."
kind: "package-reference"
---

# @deepseek-ai/dsh-blender

English | [中文](README.zh.md)

## Summary

Let the agent inspect, model, render, and export 3D assets with Blender, which runs without a window: the agent looks at its work through rendered previews and exports glTF files for the game. WASD Engine Web and Desktop turn the tools on by default. The first tool call starts Blender, either the `bpy` Python module that uv installs on first use or an installed Blender in background mode, and the tool results report setup problems. One Blender session and one open scene serve every conversation; a crash or timeout loses unsaved changes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Choose these tools when the agent should create, inspect, or convert 3D assets as files. The plugin starts its own Blender and never connects to a Blender window that the user has open. Activating the plugin registers its MCP server, `wasd_blender`, and nothing else: no download, installation, or Blender start happens before the first tool call, so the plugin loads on machines without uv or Blender.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the `blender` row into every Web and Desktop profile and puts its data directory under the harness home: `~/.wasdengine/blender`, or `$DSH_HOME/blender` when `DSH_HOME` is set.

```yaml
- id: blender
  name: '@deepseek-ai/dsh-blender'
  config:
    dataRoot: !!js dshHomePath('blender')
```

The plugin requires the `mcpManager` service, which the `mcp-manager` row of the [`dsh-web-app`](../../bundle/web-app/README.md) bundle provides. In another composition, mount [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) beside this row and set an absolute `dataRoot`.

### Turn the tools off or change their settings

A profile patch overrides the row by its id. Add the entry to `$DSH_HOME/profiles/<name>/cordis.patch.yml`, where `$DSH_HOME` is `~/.wasdengine` when unset and the standard profile names are `web` and `desktop`. Restart Web or Desktop after editing the patch. The switch on the Game tools tab of the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) adds and removes this `disabled` entry through the plugin manager, which applies the change or says that it waits for a restart.

```yaml
- id: blender
  disabled: true
```

A disabled row withdraws the tools and the server instructions from the model and stops the running Blender. A patch that sets `config` replaces the row's whole configuration, so restate `dataRoot` beside the fields you change:

```yaml
- id: blender
  config:
    dataRoot: !!js dshHomePath('blender')
    backend: app
    blenderPath: /Applications/Blender.app/Contents/MacOS/Blender
```

### Configuration

[`src/index.ts`](src/index.ts) declares and validates these fields. Activation fails when `dataRoot`, `uvPath`, or `blenderPath` holds a relative path, and when `requestTimeoutMs` is not at least 30 s less than `toolCallTimeoutMs`.

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | required | Absolute directory for the bpy environment, the managed Python, previews, default renders, and the worker script copy |
| `backend` | `auto` | Which Blender runs the tools: `auto`, `bpy`, or `app` (see [Backends](#backends)) |
| `bpyVersion` | `5.2.3` | Version of the `bpy` package in the managed environment, in `major.minor.patch` form |
| `pythonVersion` | `3.13` | Python minor version of the managed environment, in `3.<minor>` form; the bpy release must support it |
| `uvPath` | `''` | Absolute uv executable; empty searches `PATH`, then `~/.local/bin/uv`, `/opt/homebrew/bin/uv`, and `/usr/local/bin/uv` (on Windows, `%USERPROFILE%\.local\bin\uv.exe`) |
| `blenderPath` | `''` | Absolute Blender executable; empty uses the `BLENDER_PATH` environment variable, then the standard install locations |
| `toolCallTimeoutMs` | `900,000` | Budget of one tool call, including a first-use bpy installation; a Blender request, including an `execute_python` timeout, may use all of it but the last 30 s, which a worker start and the result keep |
| `startupTimeoutMs` | `30,000` | Budget for the MCP server to connect and list its tools, and for each Blender worker to report ready |
| `requestTimeoutMs` | `600,000` | Default budget of one Blender request, at least 30 s less than `toolCallTimeoutMs`; when it expires, the worker stops and unsaved changes are lost |
| `graceMs` | `3,000` | Time the worker gets to exit after the `shutdown` request, and again after SIGTERM, before SIGKILL |
| `maxLogBytes` | `65,536` | Bytes of recent worker and uv output kept for error messages |

<a id="backends"></a>
### Backends

The plugin selects the backend each time a worker starts: on the first tool call and on the call after a stop. After installing uv or Blender in response to a setup error, call the tool again; the Host does not need a restart.

- **`bpy`** runs the Blender Python module from a virtual environment that uv manages under `dataRoot`. On the first start, uv installs Python `pythonVersion` into `uv-python/` and builds `venv-py<pythonVersion>-bpy<bpyVersion>/` with `bpy==<bpyVersion>`, which is `venv-py3.13-bpy5.2.3/` by default. With the default versions on macOS arm64, the environment takes about 740 MB and Python about 70 MB, and uv also keeps the downloaded packages in its own cache. The first tool call waits for the installation and reports it in its result; later starts reuse the environment. A directory at the environment's path whose Python is not executable, such as one whose interpreter under `uv-python/` was removed, is replaced by a fresh installation. A bpy module that does not start fails the call with the advice to delete the environment's folder, so that the next start installs it again. Without uv, this backend fails with installation steps.
- **`app`** runs an installed Blender in background mode with factory settings, so the user's startup file and preferences do not load. The search order is `blenderPath`, `BLENDER_PATH`, `/Applications/Blender.app` and `~/Applications/Blender.app` on macOS, `blender` on `PATH`, and the newest `Blender*` folder under `%ProgramFiles%\Blender Foundation` on Windows.
- **`auto`** uses `bpy` when it finds uv and `app` otherwise. When uv cannot install bpy, or the installed bpy module does not start, `auto` falls back to an installed Blender, and the next tool result says so and quotes the failure; when neither works, the result explains how to install uv or Blender.

A `uvPath`, `blenderPath`, or `BLENDER_PATH` value that does not name an executable file fails the call; the plugin does not continue the search.

<a id="tools"></a>
### Tools

The model calls each tool as `mcp__wasd_blender__<name>`, and every path argument is absolute. A result is text, and `render_preview` and `render` add one image; a failed call returns an error result whose text names the cause.

| Tool | Arguments | Result |
|---|---|---|
| `scene_info` | none | JSON: the file and its unsaved-changes flag, which is true once a tool changed the scene since it was opened, created, or saved, with every `execute_python` call counted as a change; scenes, frame range, render settings and camera, units, the collection tree, up to 300 objects with transforms, dimensions, materials, modifiers, visibility, and evaluated triangle counts, and datablock counts |
| `object_info` | `name` | JSON: local and world transforms, world bounds, visibility, mesh statistics, camera, light, armature, or empty settings, modifiers, materials with nodes and textures, constraints, custom properties, and animation; an unknown name fails and suggests up to five close names |
| `execute_python` | `code`, `timeout_seconds` | The traceback when the code raised, as an error result, then the JSON value of `result` and the printed output |
| `new_scene` | `empty` | The objects of the new scene and the names that `execute_python` had defined, which it clears; `empty` defaults to `true`, and `false` starts with Blender's default cube, camera, and light |
| `open_blend` | `path` | The file, its scenes, the object count and names, and the names that `execute_python` had defined, which it clears; scripts stored in the file do not run, and a file that fails to load keeps the open scene and the names |
| `save_blend` | `path` | The saved path and size; without `path`, it saves the current file and fails for a scene that was never saved |
| `import_file` | `path` | The names of the new objects; the extension selects the glTF, FBX, OBJ, STL, PLY, USD, Alembic, SVG, or `.blend` importer |
| `export_gltf` | `path`, `selection`, `apply_modifiers`, `animations`, `format` | The count of exported objects, without cameras and lights, which glTF export leaves out; the path, format, and size; and for `.gltf` the `.bin` file beside it |
| `export_file` | `path`, `format`, `selection` | The format, path, and size of an FBX, OBJ, STL, or USD file |
| `render_preview` | `width`, `height`, `view`, `objects`, `shading` | One preview image with its size, view, object count, and world bounds, and a note naming listed objects that the preview cannot show |
| `render` | `path`, `width`, `height`, `engine`, `samples`, `camera` | One rendered image with its size, engine, camera, render time, and saved PNG path |
| `python_api` | `identifier` | Documentation of one Blender Python API name, read from the running Blender, at most 12,000 characters |
| `checkpoint` | none | The number of the new checkpoint |
| `undo` | none | The checkpoint that the scene returned to; at the oldest checkpoint left, an error names it |

`execute_python` runs code in one namespace that keeps its names between calls, until `new_scene` or `open_blend` clears them, and imports `bpy`, `bmesh`, `mathutils`, `math`, and `json`. The tool cuts printed output to 20,000 characters, keeping its start and end, and while the code runs the worker keeps only its start and end, fewer than 60,000 characters, however much the code prints. A `result` longer than 50,000 characters of JSON becomes a truncated preview, integers in it beyond ±(2^53 − 1) arrive as strings of their digits, or as `<integer of about N digits>` beyond Python's conversion limit, and an exception message is cut to 20,000 characters. `timeout_seconds` defaults to `requestTimeoutMs` and is at most `toolCallTimeoutMs` less 30 s, both in seconds.

`export_gltf` writes glTF 2.0 with +Y up and never uses Draco compression, which Godot cannot import. A `selection` includes the children of each named object, also hidden and unselectable ones, such as a `-col` collision child hidden in the viewport: the export shows and selects them, and restores their visibility and the selection afterwards. A named object that a collection keeps unselectable, because the collection disables selection or viewport display, fails the call with that cause. `export_gltf` and `export_file` delete an earlier file at `path` first and fail when Blender writes no file, as for an OBJ export of cameras only, so the file at `path` after a successful call is always the new export.

`render` renders from the scene camera unless `camera` names another camera object. `width`, `height`, `engine`, and `samples` apply to that render only, and a call without `path` writes a new file under `renders/` in `dataRoot`.

<a id="one-blender-session"></a>
### One Blender session for every conversation

The Host runs one Blender MCP server, and the server runs one Blender worker. Every Session and conversation therefore shares one open scene, one `execute_python` namespace, and one set of checkpoints, and calls run one at a time in arrival order. This state persists between calls until `new_scene` or `open_blend` replaces the scene. The replacement also clears the `execute_python` names, because a name that holds part of the old scene, such as `scene.render` or `mesh.vertices`, would point at freed memory: reading it returned garbage, and writing through it crashed Blender.

The worker starts on the first tool call with Blender's default scene. A crash, an expired request budget, or a cancelled running call stops the worker and loses unsaved changes. When the worker stops during a call, that call fails and says that the state was lost, and the next call starts a fresh worker. When the worker stops while idle or because a running call was cancelled, the next call fails with that notice without running, and the call after it starts a fresh worker. When the MCP server itself dies, Blender ends within about a second, also in the middle of a call, and so do the processes that executed code started. Save `.blend` files at milestones.

<a id="headless-operation"></a>
### Headless operation

Blender runs without a window, so the tools offer no viewport, no interface, and no window or area screenshot. Some operators need a window and fail in background Blender, so the server instructions tell the agent to prefer `bpy.data` edits over `bpy.ops` operators.

The agent looks at the scene with `render_preview`. It renders from a temporary orthographic camera framed on every renderable object, or on the listed objects and their children with other geometry hidden, from the `iso`, `front`, `back`, `left`, `right`, or `top` view. The framing follows what a render shows: it includes objects and collections hidden only in the viewport and leaves out collections that are excluded from the view layer or hidden from renders; the result names listed objects that such a collection holds, since the preview cannot show them. `solid`, the default, is fast Workbench shading with outlines in material base colors; `material` renders node materials and textures with EEVEE at 16 samples, lit by the scene lights or by a temporary sun when the scene has none.

After rendering, `render_preview` restores the scene's camera, world, render settings, color management view and look, and visibility, and a value that it cannot restore fails the call. `render` makes final images and needs a camera.

<a id="checkpoints"></a>
### Checkpoints

`checkpoint` records the scene state, and `undo` returns the scene to the latest checkpoint and discards later changes. A second `undo` right away steps back one more checkpoint, down to the scene as it was opened or created. `new_scene` and `open_blend` clear the checkpoints. The checkpoints live in Blender's undo history, so the `undo_steps` preference, 32 with factory settings, bounds how far `undo` reaches; at the oldest checkpoint left, `undo` fails and names that checkpoint. After `undo`, Python references held in `execute_python` variables can be invalid, and the `undo` result tells the agent to look objects up by name again.

<a id="data-directory"></a>
### Files under the data directory

The first tool call creates `dataRoot`, and the worker runs with it as its working directory.

| Path | Contents | Lifetime |
|---|---|---|
| `payload/<hash>/wasd_blender_worker.py` | Copy of the worker script as a real file outside the Desktop application archive; `<hash>` is the first 16 hex digits of its SHA-256 | Reused while the script is unchanged; earlier versions stay |
| `uv-python/` | The Python that uv installs for the `bpy` backend | Kept |
| `venv-py<pythonVersion>-bpy<bpyVersion>/` | The `bpy` environment, built in a `.partial-<uuid>` sibling and renamed into place; a directory there whose Python is not executable moves to a `.stale-<uuid>` sibling first | Kept; the plugin deletes only a moved-aside directory |
| `previews/` | `render_preview` images and the downscaled copies of `render` images | Deleted when the call returns |
| `renders/<time>-<id>.png` | `render` output for a call without `path` | Kept |

Other files go where the agent's absolute paths point; `save_blend`, `export_gltf`, `export_file`, and `render` create missing parent folders. uv keeps downloaded packages in its own cache directory.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs of Settings › Built-in plugins and the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`. The file embeds the Blender logo mark unaltered in a 36 × 36 canvas: Blender's application icon, `release/freedesktop/icons/scalable/apps/blender.svg` in the [Blender source repository](https://projects.blender.org/blender/blender), at the commit that the file's comment names. Blender and the Blender logo are trademarks of the Blender Foundation, which owns the logo; no open license covers it, and neither does this repository's license. The icon identifies the Blender integration only, under the Blender [logo guidelines](https://www.blender.org/about/logo/) and [trademark policy](https://www.blender.org/about/trademark-policy/). WASD Engine is not affiliated with, sponsored by, or endorsed by the Blender Foundation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin spans three processes. The Host plugin registers a stdio MCP server, `wasd_blender`, with the MCP server manager for its own lifetime; the `wasd_` prefix keeps it apart from a `blender` server that a user configures. The manager runs the server entry, `lib/worker.js`, under the Host's own executable with `ELECTRON_RUN_AS_NODE=1`, so the Desktop app needs no separate Node installation; a source launch of the harness runs `src/worker.ts` through tsx instead. The plugin passes its configuration to the server as base64url JSON on the command line. The server answers MCP discovery at once and starts no worker until a tool call arrives.

On the first call, the server resolves the backend, prepares the bpy environment when needed, copies the worker script out of the package, and starts one Python worker. Server and worker speak the shared JSON-lines protocol: requests on the worker's standard input, replies on file descriptor 3, and logs on standard output and standard error. Each tool validates its arguments, sends one request to the worker method of the same name, validates the reply, and turns it into compact text and images. A supervisor runs the calls one at a time and starts a fresh worker after a stop.

The same worker script runs under the bpy module (`<venv python> -I -u <script>`) and inside Blender (`blender --background --factory-startup -noaudio --python-exit-code 1 --python <script>`). The server removes `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `VIRTUAL_ENV`, and `ELECTRON_RUN_AS_NODE` from the environment of uv and the worker, so the user's Python setup stays out of Blender. The worker exits with `os._exit(0)` after its `shutdown` reply, because Blender can crash in its own exit handlers after some exporters ran. Its standard input closing without a `shutdown` request, or its reply pipe losing its reader, means the server is gone. A worker thread checks the reply pipe every second, so the worker notices this also during a request; it then kills its process group, which the server gives it on POSIX, so the processes that executed code started end with it.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host plugin: the configuration schema, with the shared fields spread in, and the server registration |
| [`src/worker.ts`](src/worker.ts) | MCP server process entry: `runAppMcpServer` with the Blender options, worker starter, tools, and instructions |
| [`src/environment.ts`](src/environment.ts) | uv and Blender search, the bpy environment, backend choice, and setup notes |
| [`src/tools.ts`](src/tools.ts) | Tool declarations, worker requests, reply validation, result text, and image files |
| [`src/instructions.ts`](src/instructions.ts) | Server name and instructions |
| [`py/wasd_blender_worker.py`](py/wasd_blender_worker.py) | Worker: the protocol loop and one method per tool |

The shared [`dsh-app-mcp`](../app-mcp/README.md) package owns the shared Config fields and the server registration, the server process, the worker protocol client, the supervisor, the result size bounds, the setup host, and the tool helpers, including `execute_python`.

### Verify against real Blender

From the repository root, run the end-to-end suite. Its bpy suite runs uv offline, so it runs only when bpy 5.2.3 is already in the uv cache; its app suite runs only when it finds an installed Blender. A suite whose runtime is missing is skipped.

```sh
pnpm run test:e2e packages/gamedev/blender/tests/blender-worker.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Game development tools](../README.md) — the package group and its other game applications.
- [App MCP runtime](../app-mcp/README.md) — the server process, the worker protocol, supervision, and result bounds.
- [MCP server manager](../../mcp/mcp-manager/README.md) — plugin-registered servers, their status, and restarts.
- [MCP client](../../mcp/mcp-client/README.md) — tool naming, server instructions, and image admission.
- [Web app bundle](../../bundle/web-app/README.md) — the Web and Desktop composition that carries the `blender` row.
- [Blender Python API](https://docs.blender.org/api/current/) — the upstream reference for `execute_python` code.

-----

<a id="model-experience"></a>
## Model Experience

### Blender tool declarations

#### What the model sees

The model sees 14 tools named `mcp__wasd_blender__<name>` with the descriptions and input schemas that [`src/tools.ts`](src/tools.ts) declares and [`model-surface.spec.ts.snap`](tests/__snapshots__/model-surface.spec.ts.snap) pins; the generated tool catalog does not list MCP server tools. In `execute_python`, the `timeout_seconds` description names the `requestTimeoutMs` default in seconds, and its maximum is `toolCallTimeoutMs` less 30 s, in whole seconds. The server lists the tools without starting Blender, so the model sees them whether or not uv or Blender is installed.

#### Token effect

The 14 declarations come to about 10,200 characters of JSON, names included, and enter every request while the server's tools are registered.

#### KV Cache effect

One configuration always yields identical declarations, so a reconnect keeps the tool-definition prefix stable. The tools register when the server finishes discovery after the Host starts; a request assembled earlier has no Blender tools, and the first request after registration can lose reuse from the first changed definition onward. A change of `requestTimeoutMs` or `toolCallTimeoutMs` changes the `execute_python` declaration, and a disabled row removes all 14 declarations.

### Server instructions in the system prompt

#### What the model sees

After the server connects, the MCP client adds the instructions from [`src/instructions.ts`](src/instructions.ts) to the system prompt under the heading `### MCP server: wasd_blender`.

##### Blender server instructions

```markdown
Blender runs headless behind these tools: there is no window, viewport, or screenshot. One Blender session and one open scene serve every conversation and persist between calls until new_scene or open_blend replaces them, so call scene_info before relying on earlier state. If Blender restarts after a crash or a timeout, unsaved work is lost: save .blend files at milestones. The first result after a start names the Blender version; check API names with python_api instead of guessing, since APIs change between versions.

Paths are absolute. Resolve relative names against your working directory. Put game assets inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Inspect, change, look:
- scene_info gives the overview and object_info the details of one object (transforms, bounds, mesh statistics, modifiers, materials).
- execute_python changes the scene. Prefer bpy.data and direct property edits over bpy.ops operators: operators depend on the active object, selection, and mode, and some need a window that background Blender does not have. Create meshes with bmesh or Mesh.from_pydata, link new objects into a collection, and assign result to return data.
- render_preview shows the result without touching the scene's camera or settings: solid for shape and base colors, material for node materials and textures. Look at a preview after significant changes and fix what looks wrong before exporting.
- render makes final images from a scene camera.

Game assets:
- Model in meters at real scale, with -Y as the front and +Z as up in Blender; glTF export converts to +Y up. Apply rotation and scale (bpy.ops.object.transform_apply) and place each origin where the game expects the pivot, such as the feet of a character.
- Use Principled BSDF materials. Image textures should be files saved next to the model or packed into the .blend so export can embed or copy them.
- Keep triangle counts suited to real-time rendering; scene_info reports them per mesh.
- Name objects, meshes, and materials meaningfully: glTF keeps the names. In Godot, an object name ending in -col adds a collision shape, -convcol a convex one, and -colonly keeps only the collision shape.
- export_gltf to a .glb inside the game project. It applies modifiers, exports animations, and never uses Draco compression, which Godot cannot import. Export the whole scene or name the objects in selection.
- Save the editable .blend next to the exported file with save_blend so the asset can be changed later.

Use checkpoint before risky edits and undo to return to it. new_scene and open_blend remove every name that execute_python defined, and after undo, Python references held in variables can be invalid, so look objects up by name again.
```

#### Token effect

The section adds about 2,800 characters to every request while the server is connected.

#### KV Cache effect

The text is constant, so a reconnect renders an identical section. The section appears when the server first connects and disappears when the row is disabled or the server's reconnect attempts run out; each change alters the assembled system prompt, and the [system prompt's cache rules](../../core/system-prompt/README.md#model-experience) decide how much of the prefix stays reusable.

### Tool results and images

#### What the model sees

Each result has one text block, and `render_preview` and `render` add one image: the rendered PNG when its longest edge is at most 1,568 pixels and its file at most 3 MiB, otherwise a copy scaled down to that edge, as PNG or, when the PNG still exceeds 3 MiB, as JPEG; the `render` text names the copy's size. After each worker start, the next result begins with `Blender <version> started (<runtime>, Python <python>) with its default scene.`, where `<runtime>` is `bpy module` or `Blender app`; on first use, the bpy installation note comes before it, and so does the note that an installed Blender replaced a bpy module that could not be installed or did not start. The `new_scene` and `open_blend` texts end with the `execute_python` names they cleared, when there were any. Error results carry the failure: a setup failure says how to install uv or Blender, and a worker failure names its error code and adds the traceback and recent worker output when there are any. The [MCP client](../../mcp/mcp-client/README.md#model-experience) admits images only on model routes that declare image input and gives other routes diagnostic text instead.

#### Token effect

Arguments, result text, and admitted images stay in the conversation until compaction. The tools bound their text: `scene_info` lists at most 300 objects, `execute_python` keeps at most 20,000 characters of printed output and of an exception message and replaces a `result` over 50,000 characters of JSON with a truncated preview, `python_api` returns at most 12,000 characters, and the server cuts any text block over 1 MiB of JSON. A worker reply over 32 MiB, such as `object_info` for a huge custom property, becomes an error that says the request completed.

#### KV Cache effect

Append-only: calls and their results follow the existing request prefix and do not invalidate it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe current gaps in the Blender tools.

- **One Blender for every Session** — all Sessions share one open scene, one Python namespace, and one set of checkpoints, so one Session can change or replace another Session's scene, and a long render delays every other Blender call.
- **No window** — the tools offer no viewport, interface, or window or area screenshot, and operators that need a window fail; `render_preview` is the only way to look at the scene, and `render` needs a camera.
- **Restarts lose unsaved work** — a crash, an expired `requestTimeoutMs` or `timeout_seconds`, or a cancelled running call stops the worker; the scene, the Python namespace, and the checkpoints are gone, and the fresh worker starts with Blender's default scene.
- **First use is slow and large** — the `bpy` backend installs during the first tool call, which waits for it; when the call exceeds `toolCallTimeoutMs`, uv stops, the partial environment is removed, and the next call starts the installation again. A new `bpyVersion` or `pythonVersion` installs another environment, and the plugin removes none that works.
- **bpy covers four platforms** — PyPI publishes bpy 5.2.3 only for macOS arm64, Linux x86_64, and Windows x64 and arm64; elsewhere the `bpy` backend fails, and `auto` needs an installed Blender.
- **Bounded checkpoints** — the `undo_steps` preference (32 with factory settings) limits how far `undo` reaches, and `new_scene` and `open_blend` clear the checkpoints.
- **Images need an image-capable route** — on a model route without image input, the model receives diagnostic text instead of previews and renders.
- **A long native call delays the server check** — the worker thread that notices a dead server needs Python's lock, so code inside one long native call that holds it, such as one operator that runs for minutes, keeps Blender running until that call returns.
- **Windows notices a dead server late** — the worker has no `poll()` for its reply pipe and no process group on Windows, so it ends only when it reads its next request, and processes that executed code started keep running.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
