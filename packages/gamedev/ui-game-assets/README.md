---
description: "Assets tab of the WASD Engine right Sidebar, for maintainers changing how the game project's 2D and 3D art is found, searched, sorted into folders, and shown, or debugging a model or image that does not show."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-assets

English | [中文](README.zh.md)

## Summary

See the game project's art without leaving WASD Engine. The right Sidebar's **Assets** tab finds every image and 3D model in the Session's game project, lists them in a dropdown sorted into the project's folders, searches them by name or path, and shows the chosen one: an image in a zoomable view, a model in a 3D view that turns, zooms, pans, and plays its animations. A Blender file shows the model exported from it. The view reloads when the agent changes the file.

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

Open the right Sidebar and pick **Assets** on its guide, or open the tab from **More tools**. The dropdown at the top of the tab names the asset on screen; open it to search, or to browse the project's folders.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts this row after the Game tools tabs into every Web and Desktop profile:

```yaml
- id: ui-game-assets
  name: '@deepseek-ai/dsh-client-ui-game-assets'
```

The row's Host half does nothing: the row exists so that the Host serves the browser half. The browser half needs the right Sidebar ([`ui-sidebar-right`](../../client/ui-sidebar-right/README.md)), the `workspaceFiles` Remote of [`dsh-api-workspace-files`](../../api/workspace-files/README.md) with its `file` resource, and the Session Controller's sessions. A profile patch entry `- id: ui-game-assets` with `disabled: true` removes the tab. A patch that sets `config` changes the caps:

| Field | Default | Meaning |
|---|---|---|
| `maxFolders` | `2000` | Folders one scan lists, the project folder included, before it stops and says the list is incomplete |
| `maxAssets` | `5000` | Assets one scan collects before it stops and says the list is incomplete |
| `maxPreviewBytes` | `268435456` (256 MiB) | Largest file the viewer reads; a larger asset shows a notice instead |

### What the tab lists

The tab lists files by extension. Images: PNG, JPEG, WebP, GIF, BMP, SVG, AVIF, and ICO, which the browser decodes, and TGA, Radiance HDR (`.hdr`), and OpenEXR (`.exr`), which three.js decodes. Models: glTF (`.gltf`, `.glb`), OBJ, FBX, Collada (`.dae`), STL, PLY, MagicaVoxel (`.vox`), and Blender (`.blend`). A scan walks the Session's workspace, skipping hidden folders, such as `.godot` and `.git`, and `node_modules`; a folder reached through a link to a folder already listed is listed once.

### Picking an asset

The dropdown shows the project's folders that hold assets, folders before files and names in reading order (`tree2` before `tree10`), with each folder's asset count; the project folder's own folders start open. A folder that holds only one folder shares its row with it (`ui/icons`). **All**, **2D**, and **3D** narrow the list to one kind. Typing replaces the folders with the assets whose name or path contains the text, best match first; when none does, the letters match in order, so an abbreviation such as `arcbl` still finds `archer.blend`. The arrow keys move through the rows while the search field keeps the keyboard, Enter opens or closes a folder or picks an asset, the right and left arrows open and close folders, and Escape closes the dropdown. Opening the dropdown shows the selected asset's row.

The tab scans when it is shown and when the dropdown opens, unless the last scan is recent: two seconds, or ten times as long as that scan took. The refresh control scans at once and reads the viewed file again. A scan keeps the previous list on screen while it runs and after it fails; a failed scan shows a notice with **Retry**.

### Images

An image fits the stage with a margin until the reader zooms; transparent pixels show a checkerboard. The wheel and a pinch zoom around the pointer, dragging pans, a double click switches between the fitted view and actual size, and the bar's buttons zoom out, switch between fitted and actual size, and zoom in, from 1% to 6400%. From twice the actual size, pixels draw as squares, which suits pixel art. With the stage focused, `+` and `-` zoom, `0` fits, `1` shows actual size, and the arrow keys pan. HDR and EXR images are tone mapped for the screen with an ACES filmic curve at exposure 1. The bar shows the format, the size in pixels, and the file size.

### Models

A model is framed from the front right and slightly above, on a grid sized to it, lit by a room environment, a sky light, and a sun. Dragging turns the camera, a right drag or a Shift drag pans, the wheel zooms, and the arrow keys pan while the view has focus. The bar shows the format, the triangle count, and the file size, and holds the wireframe switch and **Reset view**, which returns to the framing. A model with animations plays its first clip; the bar's animation menu picks another clip or **No animation**, and a button pauses and resumes. A new version of the same file keeps the camera, the wireframe switch, and the clip of the same name.

Files a model names load from beside it: glTF buffers and images, OBJ material libraries and their textures, and FBX and Collada textures. A name the model stores as an absolute path, such as a path on the computer that authored it, loads by its file name from the model's folder.

### Blender files

The viewer cannot read a `.blend` file. It shows the project's model of the same name instead, looked for in the Blender file's folder, then in the folders above it, then below it, then anywhere, preferring GLB to glTF to other formats, with a notice that names it and **Open the model**, which selects it. A Blender file without such a model shows a notice that asks for a glTF export.

### Failures

A file that is gone, larger than `maxPreviewBytes`, or changing between the windows of a large read shows a notice in place of the view; a failed read offers **Retry**. A file that its loader cannot read shows that the file may be damaged or use a feature the viewer does not support. A browser without WebGL shows that 3D models need it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers the `assets` page type in the right Sidebar's tab registry, with one guide entry at order 45, after the Game tab's, and its body and chip title in the `sidebar.right.pane.tab` seats under the type's id. Each Session's state, an `AssetsSource`, holds the scan and the reader's choices in two snapshot stores that the body reads as `useScan` and `useView`; it is created on the body's first face and released with the Session's scope or the plugin. The body is not kept mounted, so a hidden tab releases its WebGL context, and the state shows again when the tab returns.

A scan lists the workspace breadth first through `workspaceFiles.list`, at most six folders at a time. It keeps a set of the folder paths the Host reports, which name the folder a link resolves to, so a link to a folder already listed, or a loop, is listed once. A listing that fails with `workspace-file/not-found` belongs to a folder removed during the walk; other failures count as unreadable folders.

The viewed file is read through `workspaceFiles.readBytes`: one complete read, or, after the Host's complete-file cap refuses it, consecutive byte windows; a window whose version differs from the first starts the read over once. The body follows the file's `file` resource and reads it again for each new version. Files that a model names load by URL from the authenticated `/api/file` route, which the loaders reach through a `LoadingManager` URL modifier that resolves each name against the viewed file's absolute path.

three.js and its loaders are in one lazily loaded chunk, `client.viewer.js`, which both views import on first use; the client module loader cannot load a chunk that another lazy chunk requires, so a second entry would break the shared code out of reach. The 3D stage draws on demand: a camera move, a texture that arrives late, a resize, or a playing animation requests the next frame.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Empty Host `apply` of the Loader row |
| [`src/client/index.ts`](src/client/index.ts) | `Config`, the tab type, its seats, its copy, and each Session's state and face |
| [`src/client/formats.ts`](src/client/formats.ts) | Listed extensions, their kind, and their decoder |
| [`src/client/scan.ts`](src/client/scan.ts) | The project walk and the name order |
| [`src/client/tree.ts`](src/client/tree.ts) | The folder tree, its rows, the folders to open, and search |
| [`src/client/source.ts`](src/client/source.ts) | One Session's scan and choices |
| [`src/client/read.ts`](src/client/read.ts) | Complete and windowed reads, and related-file URLs |
| [`src/client/AssetsTab.tsx`](src/client/AssetsTab.tsx), [`src/client/AssetPicker.tsx`](src/client/AssetPicker.tsx) | The body, its states, and the dropdown |
| [`src/client/AssetViewer.tsx`](src/client/AssetViewer.tsx) | Reads, reloads, Blender exports, and read failures |
| [`src/client/ImageView.tsx`](src/client/ImageView.tsx), [`src/client/ModelView.tsx`](src/client/ModelView.tsx) | The 2D and 3D views |
| [`src/client/viewer/`](src/client/viewer/) | The lazily loaded three.js chunk: image decoders, model loaders, and the stage |
| [`src/client/icon.tsx`](src/client/icon.tsx) | The tab's glyph and the 3D model file glyph |
| [`src/client/locales.ts`](src/client/locales.ts) | `gameAssets` dictionaries in eight languages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the Sidebar that holds the tab and the service it reads.

- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#assets-tab) — how the tab relates to the game tools that make the art.
- [ui-sidebar-right](../../client/ui-sidebar-right/README.md) — the right Sidebar, its tab registry, and its guide.
- [dsh-api-workspace-files](../../api/workspace-files/README.md) — the listing, the byte reads, and the `file` resource the tab uses.
- [ui-sidebar-files](../../client/ui-sidebar-files/README.md) — the workspace file tree, which lists every file rather than the art.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side view of the project's files that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tab shows and when; they are current package constraints.

- **No live list** — the list follows the project only when the tab shows, the dropdown opens, or the refresh control is used; the viewed file itself reloads as it changes, but the files a model names do not.
- **No Blender rendering** — a Blender file shows only a model exported from it; the tab does not start Blender to convert one.
- **No compressed textures** — glTF models that need Draco or KTX2 decoders, and DDS or KTX images, do not show; Meshopt compression does.
- **Related files from `/api/file`** — textures and buffers that a model names load through the authenticated file route, so its byte limit, the attachments' `maxImageBytes`, also caps each of them.
- **One WebGL context per model view** — each model selection creates the 3D stage again, which takes a moment on slow GPUs.
- **Fixed skip rule** — the scan always skips hidden folders and `node_modules`; art kept in a hidden folder does not show.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
