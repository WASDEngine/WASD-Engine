---
description: "Headless GIMP 3 tools over MCP for deployments and maintainers configuring the data directory, the gimp-console executable, and timeouts, or debugging the mcp__wasd_gimp__ tools, the GIMP search, and the plugin's own GIMP profile."
kind: "package-reference"
---

# @deepseek-ai/dsh-gimp

English | [中文](README.zh.md)

## Summary

Let the agent paint, filter, and transform layered images with GIMP 3, which runs without a window: the agent looks at its work through snapshots and exports textures, sprites, and sprite sheets into the game project. WASD Engine Web and Desktop turn the tools on by default. The first tool call starts GIMP with its own profile, which takes about 15 s the first time; without GIMP 3, the tool results say how to install it. One GIMP session serves every conversation; a crash or timeout closes every open image and loses unsaved changes.

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

Choose these tools when the agent should create or edit 2D images as files, such as textures, sprites, sprite sheets, icons, and interface art. The plugin starts its own GIMP instance with its own profile and never connects to a GIMP that the user has open. Activating the plugin registers its MCP server, `wasd_gimp`, and nothing else: no GIMP search or start happens before the first tool call, so the plugin loads on machines without GIMP.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the `gimp` row into every Web and Desktop profile and puts its data directory under the harness home: `~/.wasdengine/gimp`, or `$DSH_HOME/gimp` when `DSH_HOME` is set.

```yaml
- id: gimp
  name: '@deepseek-ai/dsh-gimp'
  config:
    dataRoot: !!js dshHomePath('gimp')
```

The plugin requires the `mcpManager` service, which the `mcp-manager` row of the [`dsh-web-app`](../../bundle/web-app/README.md) bundle provides. In another composition, mount [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) beside this row and set an absolute `dataRoot`.

### Turn the tools off or change their settings

A profile patch overrides the row by its id. Add the entry to `$DSH_HOME/profiles/<name>/cordis.patch.yml`, where `$DSH_HOME` is `~/.wasdengine` when unset and the standard profile names are `web` and `desktop`. Restart Web or Desktop after editing the patch. The switch on the Game tools tab of the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) adds and removes this `disabled` entry through the plugin manager, which applies the change or says that it waits for a restart.

```yaml
- id: gimp
  disabled: true
```

A disabled row withdraws the tools and the server instructions from the model and stops the running GIMP, which discards its open images. A patch that sets `config` replaces the row's whole configuration, so restate `dataRoot` beside the fields you change:

```yaml
- id: gimp
  config:
    dataRoot: !!js dshHomePath('gimp')
    gimpConsolePath: /Applications/GIMP.app/Contents/MacOS/gimp-console-3.2
```

### Configuration

[`src/index.ts`](src/index.ts) declares and validates these fields. Each budget is a whole number of milliseconds from 1 to 2,147,483,647. Activation fails when `dataRoot`, or a `gimpConsolePath` that is not empty, holds a relative path, and when `requestTimeoutMs` is not at least 30 s less than `toolCallTimeoutMs`.

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | required | Absolute directory for the GIMP profile, snapshots, and the worker script copy |
| `gimpConsolePath` | `''` | Absolute `gimp-console` executable of GIMP 3; empty uses the `GIMP_CONSOLE` environment variable, then the standard install locations (see [Find and install GIMP 3](#find-gimp)) |
| `toolCallTimeoutMs` | `900,000` | Budget of one tool call, including a GIMP start; a GIMP request, including an `execute_python` timeout, may use all of it but the last 30 s, which a worker start and the result keep |
| `startupTimeoutMs` | `30,000` | Budget for the MCP server to connect and list its tools; listing the tools starts no GIMP |
| `readyTimeoutMs` | `120,000` | Budget for a starting GIMP worker to report ready |
| `requestTimeoutMs` | `600,000` | Default budget of one GIMP request, at least 30 s less than `toolCallTimeoutMs`; when it expires, GIMP stops and the open images and unsaved changes are lost |
| `graceMs` | `3,000` | Time the worker gets to exit after the `shutdown` request, and again after SIGTERM, before SIGKILL |
| `maxLogBytes` | `65,536` | Bytes of recent GIMP output kept for error messages |

<a id="find-gimp"></a>
### Find and install GIMP 3

The server looks for the `gimp-console` executable of GIMP 3 each time a worker starts: on the first tool call and on the call after a stop. It takes the first match in this order:

1. `gimpConsolePath`, when it is not empty.
2. The `GIMP_CONSOLE` environment variable, when it is set and not empty; the server reads it from the environment that started Web or Desktop.
3. On macOS, the newest versioned console in `Contents/MacOS` of a GIMP application bundle (`gimp*.app`, in any case) in `/Applications` or `~/Applications`; at equal versions, `/Applications` wins.
4. The newest versioned console in the first `PATH` directory that has one.
5. `gimp-console` in the first `PATH` directory that has it.
6. On Windows, the newest versioned console in the `bin` folder of a `GIMP 3*` installation, trying the installations under `%ProgramFiles%` (`C:\Program Files` when unset), then those under `%LOCALAPPDATA%\Programs`, each newest first.

Versioned consoles are named `gimp-console-3` or `gimp-console-3.<minor>`, optionally followed by more `.<number>` parts, and the newest has the highest version numbers; on Windows, these names and `gimp-console` end in `.exe`. Only absolute `PATH` directories count. A `gimpConsolePath` or `GIMP_CONSOLE` value that does not name an executable file fails the call with a message that names the setting; the search does not continue.

When nothing matches, the call fails before it touches `dataRoot`, and its message says to install GIMP 3 from <https://www.gimp.org/downloads/>, on macOS also with `brew install --cask gimp`, and names both settings. Install GIMP 3, then call the tool again; the search runs at every worker start, so the Host does not need a restart.

<a id="gimp-profile"></a>
### The GIMP profile and the first start

GIMP runs with the `GIMP3_DIRECTORY` environment variable set to `<dataRoot>/profile`, so it keeps its configuration in that directory, apart from the user's own GIMP settings. The server creates the directory before the first start and never removes it. GIMP fills a new profile on its first start: with GIMP 3.2 on macOS arm64, that start takes about 15 s and later starts about 2 s. `readyTimeoutMs` bounds each start, and the tool call that triggers it waits for it.

<a id="tools"></a>
### Tools

The model calls each tool as `mcp__wasd_gimp__<name>`, and every path argument is absolute. A result is text, and `snapshot` adds one image; a failed call returns an error result whose text names the cause. An argument that does not apply to the chosen `action` or `mode` fails the call. Agents connected through WASD Engine's MCP server, [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md), call the same tools as `gimp_<name>`, against the same GIMP session.

| Tool | Arguments | Result |
|---|---|---|
| `list_images` | none | JSON: up to 200 open images, each with its id, name, file, size, color mode, precision, layer count, and unsaved-changes flag, and their count |
| `open_image` | `path` | The new image id, the ids of other open copies of the file, and the `image_info` JSON; any format GIMP reads, including `.xcf` with all layers |
| `new_image` | `width`, `height`, `fill`, `name` | The id and size of a new RGB image whose one layer, `Background`, is transparent or filled with `fill` |
| `image_info` | `image` | JSON: file, size, color mode, precision, resolution, unsaved-changes flag, the layer tree from the top with up to 500 entries, the selected layers, the selection bounds, and the floating selection |
| `snapshot` | `image`, `max_size` | One image of the visible layers, composited and scaled to fit `max_size`, with the image size and the shown size |
| `export_image` | `image`, `path`, `quality` | The path, format, size, and file size of the exported file |
| `save_xcf` | `image`, `path` | The path and file size of the saved `.xcf` file |
| `close_image` | `image` | The closed id, and whether unsaved changes were discarded |
| `layer` | `image`, `action`, `layer`, `name`, `opacity`, `visible`, `mode`, `offset_x`, `offset_y`, `position` | What `add`, `duplicate`, `delete`, `rename`, `set`, `move`, `merge_down`, `merge_visible`, or `flatten` did, and the layer tree as JSON |
| `select` | `image`, `mode`, `x`, `y`, `width`, `height`, `color`, `threshold`, `layer`, `amount`, `operation` | The bounding box of the selection after `all`, `none`, `invert`, `rect`, `ellipse`, `color`, `grow`, `shrink`, or `feather`, or that nothing is selected |
| `transform` | `image`, `action`, `width`, `height`, `x`, `y`, `angle`, `axis`, `layer`, `interpolation` | The image size after `scale_image`, `resize_canvas`, `crop`, `rotate`, `flip`, or `scale_layer`, and the bounds of a transformed layer |
| `draw` | `image`, `action`, `layer`, `color`, `color2`, `x`, `y`, `x2`, `y2`, `text`, `font`, `size` | The layer that `fill`, `gradient`, or `clear` painted and the selection that limited it, or the bounds of the new `text` layer |
| `filters` | `query` | The number of filter operations whose name, title, or category contains `query`, and up to 200 of them with titles and categories |
| `filter_info` | `operation` | JSON: the filter's title, description, categories, and each property with its type, range, default, and choices |
| `apply_filter` | `image`, `layer`, `operation`, `properties` | The operation, the properties it set, the layer, and the selection that limited it |
| `pdb_search` | `query` | The number of matching procedures, and up to 200 names with summaries, best matches first |
| `pdb_describe` | `procedure` | JSON: summary, help, kind, image types, menu label, authors, date, and each argument and return value with its type, range, default, and choices |
| `pdb_run` | `procedure`, `arguments` | The procedure name and its return values as JSON |
| `execute_python` | `code`, `timeout_seconds` | The traceback when the code raised, as an error result, then the JSON value of `result` and the printed output |
| `make_sprite_sheet` | `paths`, `columns`, `output`, `padding` | The sheet's path, size, file size, grid, and image id, and the rectangle of each frame as JSON |
| `make_seamless` | `image`, `layer` | The layer that now tiles seamlessly |

`snapshot` composites the visible layers in a copy of the image, so the image does not change. An image whose longest edge exceeds `max_size` (16 to 1,568 pixels, 1,024 by default) is scaled down with cubic interpolation. A smaller image is enlarged by the largest whole factor that keeps its longest edge within 256 pixels and within `max_size`, without smoothing, so pixel art stays sharp. Transparent areas show over a gray checkerboard of 8-pixel squares. The snapshot travels as PNG, or as a JPEG at 85% quality when the PNG exceeds 3 MiB, reduced by a quarter per step until it fits or its longest edge reaches 64 pixels. Its file under `snapshots/` in `dataRoot` is deleted when the call returns.

`export_image` and `make_sprite_sheet` write a composited copy of the visible layers in the format of the output extension: `.png`, `.webp`, `.jpg` or `.jpeg`, `.tga`, `.bmp`, `.ico`, or `.xcf`, which keeps all layers. `.jpg`, `.jpeg`, and `.bmp` have no transparency, so the copy is flattened onto white, and the result says so. `quality`, from 0 to 100, applies only to `.jpg`, `.jpeg`, and `.webp`; without it, GIMP 3.2 exports both formats at quality 90, also for an image opened from a JPEG file of another quality. The file is written to a hidden temporary file beside the target, `.<name>.wasd-<pid><extension>`, and then renamed into place, so a file watcher such as Godot's importer never sees a partial file. Missing folders are created, and an image without visible layers cannot be exported.

`save_xcf` saves the image itself with all layers. With `path`, which must end in `.xcf`, it saves there, creates missing folders, and keeps that file as the image's file for later saves. Without `path`, it saves to the `.xcf` file that the image was opened from or last saved to, and it fails for an image that has none.

These rules apply across `layer`, `select`, `transform`, and `draw`:

- Coordinates, offsets, and sizes are image pixels.
- Fill, clear, gradients, and filters act only inside the selection; `select` with mode `none` makes them act on whole layers again. `transform` and `make_seamless` act on whole layers and images regardless of the selection.
- `layer` with `add` or `duplicate`, and `draw` with `text`, make the new layer the selected one.
- `resize_canvas` moves every layer by `x`, `y`; then each layer that is neither a text layer nor a group, including the layers inside groups, takes the canvas size, and text layers keep theirs.
- Rotating the whole image takes 90, 180, or 270 degrees clockwise, and rotating one `layer` takes any angle. `interpolation` defaults to `cubic`, and `none` keeps pixel art sharp.
- Colors are `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, or a CSS color such as `white` or `rgba(255, 136, 0, 0.5)`. A fill uses the color's alpha as its opacity, and a gradient keeps the alpha of both colors.
- A text layer uses `font` (default `Sans-serif`) at `size` pixels (default 32); an unknown font fails the call and lists up to ten similar font names.

`filters`, `filter_info`, and `apply_filter` reach the GEGL filter operations that GIMP can apply to a layer, such as `gegl:gaussian-blur`. `apply_filter` merges the filter into the pixels of the layer, so no editable filter remains on it. `pdb_search`, `pdb_describe`, and `pdb_run` reach GIMP's procedure database. `pdb_search` reads spaces and `_` in `query` as `-` for name matches and also matches summaries, ranking exact names first, then whole words, then other name matches, then summary matches. `pdb_run` always sets `run-mode` to non-interactive, so no dialog opens. It takes arguments by name: images and items as ids, files as absolute paths, colors as hex strings, enums and choices by name, units as `pixel`, `inch`, `mm`, `point`, `pica`, or `percent`, and arrays as JSON arrays. Filter property and procedure argument names accept `_` in place of `-`. An unknown operation, procedure, property, or argument fails the call, and the message lists similar or valid names.

`execute_python` runs code in one namespace that keeps its names between calls. The namespace holds `Gimp`, `Gegl`, `Gio`, `GLib`, `GObject`, and `Babl`, and before every call the tool sets `images` in it, which maps each open image id to its `Gimp.Image`. The value assigned to `result` returns as JSON: images as `{"image": <id>}`, layers and other items as `{"item": <id>, "name": <name>}`, colors as hex strings, files as paths, enums by name, and other values as their `repr`. The tool cuts printed output, standard output and standard error together, to 20,000 characters, keeping its start and end, and while the code runs the worker keeps only its start and end, fewer than 60,000 characters, however much the code prints. A `result` over 20,000 characters of JSON becomes a clipped string. Standard input reads as empty. Code that raises an exception or calls `exit()` returns an error result that starts with the traceback or the exit notice, and the worker keeps running. `timeout_seconds` defaults to `requestTimeoutMs` and is at most `toolCallTimeoutMs` less 30 s, both in seconds; when it expires, GIMP stops and the open images are lost.

`make_sprite_sheet` loads 1 to 256 frame files, in any format GIMP reads, as layers of a new image and places them row by row, `columns` frames per row. Each frame is centered in a cell of the largest frame size plus `padding` on every side, and a sheet over 8,192 pixels on a side fails. The sheet stays open as a new image named after the output file, with one layer per frame named `frame <index>: <file name>`, and the result lists the index, file name, and rectangle of each frame. `make_seamless` cross-fades the whole layer with a copy of itself shifted by half its width, with wrap-around, and then cross-fades the result with a copy shifted by half its height, so each edge continues the opposite one when the texture repeats. Raised-cosine weights over the whole layer show the shifted copy at the edges and the original in the middle, mixing color and transparency with premultiplied alpha; a distinct shape away from the middle therefore appears twice, faded, so noise-like textures suit it best.

<a id="image-ids"></a>
### Image and layer ids

Tools name an image by its GIMP image id, a positive integer that `new_image`, `open_image`, `list_images`, and `make_sprite_sheet` report. An id stays valid until `close_image` closes the image or GIMP stops; after a restart, an earlier id names no image or a different one. Opening a file that is already open creates another image with its own id, and the `open_image` result names the other ids. An id that names no open image fails the call and points to `list_images`. `list_images` and `image_info` show the `name` given to `new_image`, or the output file name of a sprite sheet, until `save_xcf` saves the image; otherwise they show GIMP's image name, which is the file name of an opened or saved image.

Tools name a layer by its id or its exact name, both of which `image_info` lists. A name that several layers share fails the call and lists their ids. The `layer` actions `delete`, `rename`, `set`, and `move` require `layer`; elsewhere, an omitted `layer` means the selected layer of the image, or its top layer when none is selected.

<a id="one-gimp-session"></a>
### One GIMP session for every conversation

The Host runs one GIMP MCP server, and the server runs one GIMP worker. Every Session and conversation therefore shares the open images, their selections, and one `execute_python` namespace, and calls run one at a time in arrival order. Open images persist between calls until `close_image` closes them or GIMP stops.

The worker starts on the first tool call with no images open. A crash, an expired request budget, or a cancelled running call stops GIMP and loses the open images and unsaved changes. When GIMP stops during a call, that call fails and says that the state was lost, and the next call starts a fresh worker. When GIMP stops while idle or because a running call was cancelled, the next call fails with that notice without running, and the call after it starts a fresh worker. On macOS and Linux, a watchdog stops GIMP as soon as GIMP's Python process dies, so the running call fails without waiting for its budget. Save `.xcf` files at milestones.

<a id="data-directory"></a>
### Files under the data directory

The first tool call that finds GIMP creates `dataRoot`, and GIMP runs with it as its working directory.

| Path | Contents | Lifetime |
|---|---|---|
| `profile/` | The GIMP profile that `GIMP3_DIRECTORY` names | Kept; the plugin never removes it |
| `payload/<hash>/wasd_gimp_worker.py` | Copy of the worker script as a real file outside the Desktop application archive; `<hash>` is the first 16 hex digits of its SHA-256 | Reused while the script is unchanged; earlier versions stay |
| `snapshots/<uuid>.png` or `snapshots/<uuid>.jpg` | `snapshot` images | Deleted when the call returns |

Other files go where the agent's absolute paths point; `export_image`, `save_xcf`, and `make_sprite_sheet` create missing parent folders.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs of Settings › Built-in plugins and the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`. The file embeds Wilber, the GIMP logo, by Aryeom Han (2024), unaltered in a 36 × 36 canvas, without the Inkscape editor metadata and unused ids of its source: `images/logo/gimp-logo.svg` in the [gimp-data repository](https://gitlab.gnome.org/GNOME/gimp-data), at the commit that the file's comment names. Wilber is licensed under [Creative Commons Attribution-ShareAlike 4.0 International](https://creativecommons.org/licenses/by-sa/4.0/), not under this repository's license, and `icon.svg` is shared under the same CC BY-SA 4.0 license. The GIMP name and Wilber identify the GIMP project; the icon refers to the GIMP integration only. WASD Engine is not affiliated with or endorsed by the GIMP project.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin spans three processes. The Host plugin registers a stdio MCP server, `wasd_gimp`, with the MCP server manager for its own lifetime; the `wasd_` prefix keeps it apart from a `gimp` server that a user configures. The manager runs the server entry, `lib/worker.js`, under the Host's own executable with `ELECTRON_RUN_AS_NODE=1`, so the Desktop app needs no separate Node installation; a source launch of the harness runs `src/worker.ts` through tsx instead. The plugin passes its worker settings to the server as base64url JSON on the command line. The server answers MCP discovery at once and starts no worker until a tool call arrives.

On the first call, the server finds `gimp-console`, creates the profile, copies the worker script out of the package, and starts GIMP with this command line, which it runs without a shell:

```text
GIMP3_DIRECTORY=<dataRoot>/profile <gimp-console> -n -s -c --batch-interpreter=python-fu-eval -b 'import runpy; runpy.run_path("<worker script>", run_name="__main__")' --quit
```

`-n` starts a new GIMP instance, `-s` skips the splash screen, and `-c` sends messages to the console. The batch command runs the worker script in GIMP's Python plug-in process, which inherits the server's pipes: requests arrive on standard input, replies leave on file descriptor 3, and GIMP's own output stays on standard output and standard error. Each tool validates its arguments, sends one request to the worker method of the same name, validates the reply, and turns it into compact text and images; a reply that does not match fails the call with a `WorkerReplyError`. A supervisor runs the calls one at a time and starts a fresh worker after a stop.

The server removes `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `VIRTUAL_ENV`, and `ELECTRON_RUN_AS_NODE` from the environment of GIMP, so the user's Python setup stays out of GIMP's bundled Python. Every GIMP call in the worker uses the non-interactive run mode. GIMP 3.2 keeps running after its Python plug-in process dies and holds the reply pipe open, so where `os.name` is `posix`, the worker starts a `/bin/sh` watchdog that kills GIMP, or its process group when GIMP leads one, when the worker ends without saying goodbye. The worker returns after its `shutdown` reply or when its standard input closes, and GIMP then quits through `--quit`.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host plugin: the configuration schema, with the shared fields spread in, and the server registration |
| [`src/worker.ts`](src/worker.ts) | MCP server process entry: `runAppMcpServer` with the GIMP options, worker starter, tools, and instructions |
| [`src/environment.ts`](src/environment.ts) | `gimp-console` search, the worker command line and environment, the profile, and setup notes |
| [`src/tools.ts`](src/tools.ts) | Tool declarations, worker requests, reply validation, result text, and snapshot files |
| [`src/instructions.ts`](src/instructions.ts) | Server name and instructions |
| [`py/wasd_gimp_worker.py`](py/wasd_gimp_worker.py) | Worker: the protocol loop, the crash watchdog, and one method per tool |

The shared [`dsh-app-mcp`](../app-mcp/README.md) package owns the shared Config fields and the server registration, the server process, the worker protocol client, the supervisor, the result size bounds, the setup host, and the tool helpers, including `execute_python`.

### Verify against real GIMP

From the repository root, run the end-to-end suite. It runs only when the GIMP search finds GIMP 3, which `GIMP_CONSOLE` can select, and it is skipped otherwise. Its temporary data directory gives GIMP a new profile, so its first GIMP start is the slow one.

```sh
pnpm run test:e2e packages/gamedev/gimp/tests/gimp-worker.e2e.ts
```

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Game development tools](../README.md) — the package group and its other game applications.
- [App MCP runtime](../app-mcp/README.md) — the server process, the worker protocol, supervision, and result bounds.
- [MCP server manager](../../mcp/mcp-manager/README.md) — plugin-registered servers, their status, and restarts.
- [MCP client](../../mcp/mcp-client/README.md) — tool naming, server instructions, and image admission.
- [Web app bundle](../../bundle/web-app/README.md) — the Web and Desktop composition that carries the `gimp` row.
- [libgimp 3 API reference](https://developer.gimp.org/api/3.0/libgimp/) — the upstream reference for `execute_python` code.

-----

<a id="model-experience"></a>
## Model Experience

### GIMP tool declarations

#### What the model sees

The model sees 21 tools named `mcp__wasd_gimp__<name>` with the descriptions and input schemas that [`src/tools.ts`](src/tools.ts) declares and [`model-surface.spec.ts.snap`](tests/__snapshots__/model-surface.spec.ts.snap) pins; the generated tool catalog does not list MCP server tools. In `execute_python`, the `timeout_seconds` description names the `requestTimeoutMs` default in seconds, and its maximum is `toolCallTimeoutMs` less 30 s, in whole seconds. The server lists the tools without starting GIMP, so the model sees them whether or not GIMP is installed.

#### Token effect

The 21 declarations come to about 21,100 characters of JSON, names included, and enter every request while the server's tools are registered.

#### KV Cache effect

One configuration always yields identical declarations, so a reconnect keeps the tool-definition prefix stable. The tools register when the server finishes discovery after the Host starts; a request assembled earlier has no GIMP tools, and the first request after registration can lose reuse from the first changed definition onward. A change of `requestTimeoutMs` or `toolCallTimeoutMs` can change the `execute_python` declaration, and a disabled row removes all 21 declarations.

### Server instructions in the system prompt

#### What the model sees

After the server connects, the MCP client adds the instructions from [`src/instructions.ts`](src/instructions.ts) to the system prompt under the heading `### MCP server: wasd_gimp`.

##### GIMP server instructions

```markdown
GIMP 3 runs headless behind these tools: there is no window. One GIMP session serves every conversation, and open images persist between calls until close_image. Refer to an image by the integer id that new_image, open_image, or list_images returns, and to a layer by id or exact name (image_info lists them); call list_images before relying on earlier state. If GIMP restarts after a crash or a timeout, open images and unsaved changes are lost: save .xcf files at milestones. The first result after a start names the GIMP version.

Paths are absolute. Resolve relative names against your working directory. Write game assets inside the game project; for Godot, use a folder under the directory that contains project.godot so the files are reachable as res:// paths.

Look, change, look again:
- snapshot shows an image as it would export: the visible layers composited, transparent areas as a gray checkerboard, and small images enlarged without smoothing. Look after significant changes and fix what looks wrong before exporting. Snapshots and exports never change the image.
- image_info gives sizes, the layer tree, text layer contents, and the selection.
- layer adds, duplicates, deletes, renames, restacks, and merges layers, and sets opacity, visibility, blend mode, and offset.
- select builds a selection (rectangle, ellipse, by color, grow, shrink, feather, invert). Fill, clear, gradients, and filters then act only inside it; select mode none to act on whole layers again.
- draw fills, clears, paints linear gradients, and adds text layers. Colors are #rrggbb, #rrggbbaa (with alpha), or CSS color names.
- transform scales the image or a layer, resizes the canvas, crops, rotates, and flips. Scale pixel art with interpolation none.
- filters lists GEGL filter operations (blur, noise, distort, light, color, artistic, ...), filter_info shows their properties, ranges, and defaults, and apply_filter applies one to a layer.
- pdb_search, pdb_describe, and pdb_run reach any other GIMP procedure, such as converting to indexed colors, with images and layers passed by id.
- execute_python runs Python with Gimp, Gegl, Gio, and GLib imported and images mapping ids to Gimp.Image objects, for anything the other tools do not cover. Assign result to return data.

Game assets:
- Work at the final pixel size, and keep sizes the engine handles well, such as powers of two for tiling textures.
- export_image writes the composited visible layers by extension (.png, .webp, .jpg, .tga, .bmp, .ico) and creates folders. Use .png or .webp to keep transparency; .jpg and .bmp have none, so transparent areas become white.
- Keep the editable source: save_xcf next to the exported asset, for example art/hero.xcf beside art/hero.png, so layers and text stay editable later.
- make_sprite_sheet packs frame files into one grid sheet and reports each frame's rectangle; make_seamless makes a texture tile without seams by cross-fading it with copies of itself shifted by half its size, which can fade and double distinct shapes, so use it on noise-like textures.

close_image discards unsaved changes, so save first when they matter.
```

#### Token effect

The section adds about 3,200 characters to every request while the server is connected.

#### KV Cache effect

The text is constant, so a reconnect renders an identical section. The section appears when the server first connects and disappears when the row is disabled or the server's reconnect attempts run out; each change alters the assembled system prompt, and the [system prompt's cache rules](../../core/system-prompt/README.md#model-experience) decide how much of the prefix stays reusable.

### Tool results and images

#### What the model sees

Each result has one text block, and `snapshot` adds one PNG or JPEG image whose longest edge is at most 1,568 pixels and whose file is at most 3 MiB. After each worker start, the next result begins with `GIMP <version> started (Python <python>) with no images open.` and a blank line. `list_images`, `image_info`, `filter_info`, and `pdb_describe` return compact JSON; the other tools return sentences that name the image, the layer, and sizes, some followed by JSON. Error results carry the failure: a missing GIMP 3 returns the installation message below, a rejected request or a GIMP failure returns the worker's exception type and message with `Error code: WORKER_REMOTE`, an `execute_python` exception returns its traceback, and a stopped worker returns its error code, recent GIMP output when there is any, and the notice that its state was lost. The [MCP client](../../mcp/mcp-client/README.md#model-experience) admits images only on model routes that declare image input and gives other routes diagnostic text instead.

##### GIMP installation message on macOS

```markdown
GIMP 3 was not found. Install GIMP 3 from https://www.gimp.org/downloads/ (on macOS, `brew install --cask gimp` also works), then call the tool again. The GIMP plugin setting gimpConsolePath or the GIMP_CONSOLE environment variable selects a specific gimp-console executable.
```

#### Token effect

Arguments, result text, and admitted images stay in the conversation until compaction. The tools bound their text: `list_images` lists at most 200 images, a layer tree at most 500 entries, `filters` and `pdb_search` at most 200 matches, and `pdb_describe` at most 3,000 characters of help; `execute_python` keeps at most 20,000 characters of printed output and of `result` JSON, `pdb_run` at most 20,000 characters of return values, and the server cuts any text block over 1 MiB of JSON.

#### KV Cache effect

Append-only: calls and their results follow the existing request prefix and do not invalidate it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits describe current gaps in the GIMP tools.

- **One GIMP for every Session** — all Sessions share the open images, their ids, and one Python namespace, so one Session can change or close the images of another, and a long filter or script delays every other GIMP call.
- **No window** — the tools offer no canvas, interface, or screenshot of GIMP, and `pdb_run` runs every procedure non-interactively, without its dialog; `snapshot` is the only way to look at an image.
- **Restarts lose open images** — a crash, an expired `requestTimeoutMs` or `timeout_seconds`, or a cancelled running call stops GIMP; the open images, unsaved changes, selections, and the Python namespace are gone, and the fresh worker starts with no images open.
- **Slow first start** — the first start with a new profile takes about 15 s, and the tool call that triggers it waits.
- **Fixed GIMP search** — the search covers the two settings, macOS application bundles, `PATH`, and Windows installations under `%ProgramFiles%` and `%LOCALAPPDATA%\Programs`; GIMP installed elsewhere needs `gimpConsolePath` or `GIMP_CONSOLE`. A plain `gimp-console` on `PATH` is used without a version check, so a GIMP 2 found there cannot start the worker.
- **No crash watchdog on Windows** — the worker starts its watchdog only where `os.name` is `posix`; elsewhere, when GIMP's Python process dies, GIMP keeps running and holds the reply pipe open, so the running call fails only when its request budget expires.
- **Some procedure values are out of reach** — `pdb_run` cannot set an argument whose type has no JSON form, and it returns integer and number arrays as a placeholder, because GIMP's Python bindings cannot read them.
- **Images need an image-capable route** — on a model route without image input, the model receives diagnostic text instead of snapshots.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
