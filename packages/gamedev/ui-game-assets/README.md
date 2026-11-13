---
description: "Assets tab of the WASD Engine right Sidebar, for maintainers changing how the game project's 2D and 3D art is found, searched, sorted into folders, and shown with its animations, skeleton, and details, how the tab draws assets for the agent's asset tools, or debugging a model or image that does not show."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-assets

English | [中文](README.zh.md)

## Summary

See the game project's art without leaving WASD Engine. The right Sidebar's **Assets** tab lists every image and 3D model of the Session's game project in a searchable dropdown sorted into the project's folders, and shows the chosen one: an image in a zoomable view that plays its 2D animations, and a model in a 3D view that plays its clips on a timeline and draws its skeleton, as clay or wireframe. A details panel lists what editing needs. A Blender file shows the model exported from it. The same viewer draws assets for the agent's `asset_view` tool of [`@deepseek-ai/dsh-game-assets`](../game-assets/README.md).

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

The row's Host half does nothing: the row exists so that the Host serves the browser half. The browser half needs the right Sidebar ([`ui-sidebar-right`](../../client/ui-sidebar-right/README.md)), the `workspaceFiles` Remote of [`dsh-api-workspace-files`](../../api/workspace-files/README.md) with its `file` resource, the Session Controller's sessions, and the forwarded events of [`api-remotes`](../../api/remotes/README.md). A profile patch entry `- id: ui-game-assets` with `disabled: true` removes the tab, and then no window draws for the agent's `asset_view`. A patch that sets `config` changes the caps:

| Field | Default | Meaning |
|---|---|---|
| `maxFolders` | `2000` | Folders one scan lists, the project folder included, before it stops and says the list is incomplete |
| `maxAssets` | `5000` | Assets one scan collects before it stops and says the list is incomplete |
| `maxPreviewBytes` | `268435456` (256 MiB) | Largest file the viewer reads, and the most memory a glTF model's description may size itself; a larger asset shows a notice instead |
| `maxDecodedPixels` | `67108864` (8192 × 8192) | Most pixels of an image the viewer decodes, as its header states them before any pixel is decoded; a larger image shows a notice instead, and an agent's picture of it fails with `ASSET_TOO_LARGE` |
| `maxAgentDraws` | `3` | Pictures the window draws at once for agents; later requests wait their turn |
| `maxAgentDrawBytes` | `67108864` (64 MiB) | Largest total memory the pictures the window draws at once for agents decode, as each request counts it: an image its file and the pixels its header states, a model its file with a glTF model's buffers and images; a larger draw draws alone |

### What the tab lists

The tab lists files by extension. Images: PNG, JPEG, WebP, GIF, BMP, SVG, AVIF, and ICO, which the browser decodes, and TGA, Radiance HDR (`.hdr`), and OpenEXR (`.exr`), which three.js decodes. Models: glTF (`.gltf`, `.glb`), OBJ, FBX, Collada (`.dae`), STL, PLY, MagicaVoxel (`.vox`), and Blender (`.blend`). A scan walks the Session's workspace, skipping hidden folders, such as `.godot` and `.git`, and `node_modules`; a folder reached through a link to a folder already listed is listed once. The scan also notes the Godot scenes and resources (`.tscn`, `.tres`), at most 2,000, and the folders that hold `project.godot`, for the 2D animations they define.

### Picking an asset

The dropdown shows the project's folders that hold assets, folders before files and names in reading order (`tree2` before `tree10`), with each folder's asset count; the project folder's own folders start open. A folder that holds only one folder shares its row with it (`ui/icons`). **All**, **2D**, and **3D** narrow the list to one kind. Typing replaces the folders with the assets whose name or path contains the text, best match first; when none does, the letters match in order, so an abbreviation such as `arcbl` still finds `archer.blend`. The arrow keys move through the rows while the search field keeps the keyboard, Enter opens or closes a folder or picks an asset, the right and left arrows open and close folders, and Escape closes the dropdown. Opening the dropdown shows the selected asset's row.

The tab scans when it is shown and when the dropdown opens, unless the last scan is recent: two seconds, or ten times as long as that scan took. The refresh control scans at once and reads the viewed file again. A scan keeps the previous list on screen while it runs and after it fails; a failed scan shows a notice with **Retry**.

The tab opens with an asset selected when it is opened with the navigation parameters `{ path, animation, grid }`, as `ctx.sidebarRight.openTab('assets', { params })` passes them and an agent's `show` does; the viewer then reads an image as the grid and plays the named clip or 2D animation.

### Images

An image fits the stage with a margin until the reader zooms; transparent pixels show a checkerboard. The wheel and a pinch zoom around the pointer, dragging pans, a double click switches between the fitted view and actual size, and the bar's buttons zoom out, switch between fitted and actual size, and zoom in, from 1% to 6400%. From twice the actual size, pixels draw as squares, which suits pixel art. With the stage focused, `+` and `-` zoom, `0` fits, `1` shows actual size, and the arrow keys pan. HDR and EXR images are tone mapped for the screen with an ACES filmic curve at exposure 1. An image whose header states more pixels than `maxDecodedPixels` shows a notice with its size instead, before any of its pixels are decoded. The bar shows the format, the size in pixels, and the file size, and its info control opens the details: the size, the transparency (none, cutout, or translucent), the number of colors up to 256, and the animations.

### 2D animations

The bar's animation menu lists the 2D animations the image plays or takes part in, found when it shows:

- **Own frames** of an animated GIF, WebP, or PNG, decoded with the browser's `ImageDecoder` at their own durations, named `frames`.
- **Godot animations** of the scenes and resources that name the image: SpriteFrames animations, embedded in a scene for an AnimatedSprite2D or saved as a `.tres`, whose frames are the image or regions of it (AtlasTexture), and the frame grids (`hframes` × `vframes`) of Sprite2D nodes and Godot 3's Sprite nodes, over the whole texture or, with `region_enabled`, over its `region_rect`, cut into cells as Godot cuts them, animated by the `frame` and `frame_coords` tracks of an AnimationPlayer's animations or, without any, played cell by cell. The text formats of Godot 4 and Godot 3 are read; `res://` paths resolve against the folder that holds `project.godot` and never lead out of it, and a frame whose path would is left out.
- **Sprite sheet JSON** of the same name beside the image, as Aseprite and TexturePacker write it: each frame tag is an animation, played forward, in reverse, or ping-pong, and a file without tags plays every frame.
- **Numbered images** beside it, such as `walk_01.png` to `walk_12.png`, in number order at 12 frames per second.

Choosing one plays it on the stage, frame by frame, with pixels drawn as squares: each frame shows once its picture is decoded, one of the image's own frames or another image of the project, and the next frame's picture decodes while it shows; the decoded pictures are kept within a budget of 64 Mi pixels, the least recently shown let go first and decoded again when they show, so an animation of any length plays every frame. While the tab is off screen, the animation waits where it stands. The timeline under the stage pauses and plays, moves to a frame, shows the frame number, and sets the speed from a quarter to twice. **Sprite grid…** in the menu reads the image as a sheet of the columns, rows, and frame count the reader gives, guessing a strip of square frames, draws the grid over the image, and plays it as the animation `grid`. A name that repeats across files gains the file's name.

### Models

A model is framed from the front right and slightly above, on a grid sized to it, lit by a room environment, a sky light, and a sun. Dragging turns the camera, a right drag or a Shift drag pans, the wheel zooms, and the arrow keys pan while the view has focus. The bar shows the format, the triangle count, and the file size, and holds the clip menu, play and pause, the skeleton switch, which draws the bones and joints over the model, the clay switch, which draws every surface in one gray, the wireframe switch, **Reset view**, which returns to the framing, and the info control. A model with animations plays its first clip, and the timeline under the stage moves through it and sets the speed from a quarter to twice. A new version of the same file keeps the camera, the shading, the skeleton switch, and the clip of the same name. While the tab is off screen, in a collapsed sidebar, behind another tab of its pane, or in a Session that is not on screen, the 3D view draws nothing and its clip waits where it stands.

The details list the size and bounds, measured in the model's rest pose as the agent's details measure them, whatever clip plays, and from the vertices whose position is a finite number, then the triangles, vertices, meshes, and nodes, the clips (choosing one plays it), the bones as a tree (choosing one marks it on the skeleton), the morph targets of each mesh with a slider each, the materials with their color, metalness, roughness, flags, and textures by slot, the textures with their sizes, and the files the model names that are missing.

Files a model names load from beside it: glTF buffers and images, OBJ material libraries and their textures, and FBX and Collada textures. A name the model stores as an absolute path, such as a path on the computer that authored it, loads by its file name from the model's folder. Files load only from inside the project folder: a name that `..` leads out of it, a web address or another URL, and a path that the file route does not serve, such as one with a control character or any file of a project on a UNC share, load nothing and are listed as missing.

### Blender files

The viewer cannot read a `.blend` file. It shows the project's model of the same name instead, looked for in the Blender file's folder, then in the folders above it, then below it, then anywhere, preferring GLB to glTF to other formats, with a notice that names it and **Open the model**, which selects it. A Blender file without such a model shows a notice that asks for a glTF export.

### Failures

A file that is gone, larger than `maxPreviewBytes`, or changing between the windows of a large read shows a notice in place of the view; a failed read offers **Retry**. A file that its loader cannot read shows that the file may be damaged or use a feature the viewer does not support. A glTF model whose description sizes more than `maxPreviewBytes` of arrays that the loader fills itself, its accessors without a buffer view and its Meshopt-compressed buffer views once decoded, shows that it needs too much memory, before the loader allocates any of them, so a description of a few hundred bytes cannot ask the window for gigabytes. A browser without WebGL shows that 3D models need it.

### For the agent

The plugin answers the `game-assets/render` request that `asset_view` emits for a Session this window may read: it reads the asset through `workspaceFiles`, measures the same details the panel shows, and draws the pictures off screen. The answer's details fit the limits the request carries ([`src/client/answer.ts`](src/client/answer.ts)): each longer list keeps its first entries and the details count all of them, a longer name ends in an ellipsis, a longer path is left out, a frame size, such as a Godot region with a fraction, is given in whole pixels and left out when it is larger than the request's `edge`, and a picture's caption shortens the clip or animation name it gives to fit the request's `caption` length; the panel's own details stay whole. An image wider or taller than `edge` fails with `ASSET_TOO_LARGE`, since its details could not give its size. A model is drawn with the tab's lighting, grid, skeleton overlay, and clay or wireframe shading, one tile per view or pose, as a JPEG; an image is drawn on a checkerboard, small pixel art enlarged by a whole factor, with a grid and cell numbers when asked, or as a sheet of an animation's frames labeled with their index and duration, as a PNG. An image whose header states more pixels than `maxDecodedPixels` fails with `ASSET_TOO_LARGE` before any of its pixels are decoded, and so does another image an animation's frames show. A picture keeps no full-size copy of an image: a still draws from the decoded image straight into a picture of the requested size, and an animation's sheet decodes only the own frames it shows, one at a time, each at the size of its tile, whatever the number of frames. Requests from several agents, such as a model's parallel calls, the teammates of an agent team, subagents, and agents connected through the MCP server, are drawn in the order they came, up to `maxAgentDraws` at once while the memory they decode adds up to at most `maxAgentDrawBytes`; a larger draw draws alone. A request counts its file and, for an image, four bytes for each pixel its header states, more for the formats three.js decodes (12 for TGA, 24 for HDR and EXR), read from the image's first 256 KiB before it waits for its turn; a model counts its file with the buffers and images a glTF model names. A request whose call ends while it waits leaves the queue, and one that ends while it draws gives up its place at once. Each request reads and draws in its own Session, the one the request names. An image's Godot animations come from a walk of the Session's project that started after the request arrived, so an agent finds a scene or resource it wrote just before its call: the requests that arrived before a walk started share it while it runs and while it is fresh, and the requests that arrive while it runs share the next walk, which starts when it ends. A window without WebGL passes a model to another window. The `game-assets/reveal` notification opens the Session, if it is not on screen, and its Assets tab with the asset selected; a reveal that waits for its Session to come on screen stops when another reveal arrives.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser plugin registers the `assets` page type in the right Sidebar's tab registry, with one guide entry at order 45, after the Game tab's, and its body and chip title in the `sidebar.right.pane.tab` seats under the type's id. Each Session's state, an `AssetsSource`, holds the scan and the reader's choices in two snapshot stores that the body reads as `useScan` and `useView`; it is created on the body's first face and released with the Session's scope or the plugin. The body is not kept mounted, so a hidden tab releases its WebGL context, and the state shows again when the tab returns. A selection may carry an animation to play, with a request number, so each agent's ask plays once.

A scan lists the workspace breadth first through `workspaceFiles.list`, at most six folders at a time. It keeps a set of the folder paths the Host reports, which name the folder a link resolves to, so a link to a folder already listed, or a loop, is listed once. A listing that fails with `workspace-file/not-found` belongs to a folder removed during the walk; other failures count as unreadable folders.

The viewed file is read through `workspaceFiles.readBytes`: one complete read, or, after the Host's complete-file cap refuses it, consecutive byte windows; a window whose version differs from the first starts the read over once. The body follows the file's `file` resource and reads it again for each new version. Files that a model names load by URL from the authenticated `/api/file` route, which the loaders reach through a `LoadingManager` URL modifier that resolves each name against the viewed file's absolute path; the modifier remembers each name, so a texture that fails is reported by the name the model stores. The route serves any absolute path, so the modifier keeps names inside the project folder, which is the viewed file's absolute path without the segments of its workspace path, compared without regard to case, or the file's own folder when they differ, as for a file reached through a link. A name it refuses gets a `data:` URL without a comma, which fetches and images refuse without any request, so it fails like a missing file and is never fetched from the page's origin or the web.

The 2D view and the agent's pictures read an image's header before decoding it ([`src/client/image-size.ts`](src/client/image-size.ts)): PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, TGA, HDR, and EXR state their size there; an SVG has none, and its picture is drawn at the size it is shown. The browser's formats decode into an image element, which the 2D view's own element shares through one object URL. An image's animations are found once it decodes: its own frames through `ImageDecoder`, which decodes each frame once for its duration and again when the frame is drawn, the Godot files of the latest scan that name its file, read six at a time, at most 400 of at most 1 MiB each, a sprite sheet JSON of the same name in its folder's listing, and numbered images in that listing. The Godot reader parses section headers, properties, and the variant syntax of their values, then resolves SpriteFrames, AtlasTexture, Sprite2D, Animation, and AnimationLibrary resources by id.

three.js and its loaders are in one lazily loaded chunk, `client.viewer.js`, which both views and the agent's pictures import on first use; the client module loader cannot load a chunk that another lazy chunk requires, so a second entry would break the shared code out of reach, nothing in the chunk imports the browser half's other modules, and the browser half's other modules import no value that the chunk imports too, such as `assertNever` of `@deepseek-ai/dsh-util-values`, which the bundler would move into a third chunk that the viewer chunk requires. The 3D stage draws on demand: a camera move, a texture that arrives late, a resize, or a playing animation requests the next frame, and the stage requests none while the tab's information reports it not `visible`. The format table is a copy of `@deepseek-ai/dsh-game-assets/formats`, because a plugin's browser bundle imports no other plugin's values; [`tests/formats.client.spec.ts`](tests/formats.client.spec.ts) keeps the two equal.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Empty Host `apply` of the Loader row |
| [`src/client/index.ts`](src/client/index.ts) | `Config`, the tab type, its seats, its copy, each Session's state and face, and the answers to render and reveal requests |
| [`src/client/formats.ts`](src/client/formats.ts) | Listed extensions, their kind, and their decoder |
| [`src/client/scan.ts`](src/client/scan.ts) | The project walk and the name order |
| [`src/client/tree.ts`](src/client/tree.ts) | The folder tree, its rows, the folders to open, and search |
| [`src/client/source.ts`](src/client/source.ts) | One Session's scan and choices |
| [`src/client/walks.ts`](src/client/walks.ts) | The project walks that the pictures drawn for a Session share |
| [`src/client/read.ts`](src/client/read.ts) | Complete and windowed reads, and related-file URLs |
| [`src/client/AssetsTab.tsx`](src/client/AssetsTab.tsx), [`src/client/AssetPicker.tsx`](src/client/AssetPicker.tsx) | The body, its states, its navigation, and the dropdown |
| [`src/client/AssetViewer.tsx`](src/client/AssetViewer.tsx) | Reads, reloads, Blender exports, and read failures |
| [`src/client/ImageView.tsx`](src/client/ImageView.tsx), [`src/client/ModelView.tsx`](src/client/ModelView.tsx) | The 2D and 3D views with their animation controls |
| [`src/client/DetailsPanel.tsx`](src/client/DetailsPanel.tsx) | The details of an image or a model |
| [`src/client/godot.ts`](src/client/godot.ts) | The Godot text resource reader and its 2D animations |
| [`src/client/sprites.ts`](src/client/sprites.ts), [`src/client/animations2d.ts`](src/client/animations2d.ts), [`src/client/frames.ts`](src/client/frames.ts) | 2D animations: grids, sequences, sheets, Godot, and own frames, and finding an image's |
| [`src/client/sprite-player.ts`](src/client/sprite-player.ts) | One shown image's decoded pictures and animations |
| [`src/client/image-size.ts`](src/client/image-size.ts), [`src/client/picture.ts`](src/client/picture.ts) | Image sizes from file headers, and decoding images and measuring their pixels |
| [`src/client/agent.ts`](src/client/agent.ts), [`src/client/render2d.ts`](src/client/render2d.ts) | Answering a render request: decoding, measuring, drawing, and encoding |
| [`src/client/answer.ts`](src/client/answer.ts) | Fitting an answer's details to the request's limits |
| [`src/client/queue.ts`](src/client/queue.ts) | The order and number of the pictures drawn for agents at once |
| [`src/client/viewer/`](src/client/viewer/) | The lazily loaded three.js chunk: image decoders, model loaders, measurement, the stage, the skeleton overlay, and the agent's model tiles |
| [`src/client/icon.tsx`](src/client/icon.tsx) | The tab's glyph and the 3D model file glyph |
| [`src/client/locales.ts`](src/client/locales.ts) | `gameAssets` dictionaries in eight languages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the Sidebar that holds the tab, the service it reads, and the tools it draws for.

- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#assets-tab) — how the tab relates to the game tools that make the art.
- [game-assets](../game-assets/README.md) — the agent's asset tools, whose pictures this tab draws.
- [ui-sidebar-right](../../client/ui-sidebar-right/README.md) — the right Sidebar, its tab registry, and its guide.
- [dsh-api-workspace-files](../../api/workspace-files/README.md) — the listing, the byte reads, and the `file` resource the tab uses.
- [ui-sidebar-files](../../client/ui-sidebar-files/README.md) — the workspace file tree, which lists every file rather than the art.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `asset_view` tool of [`@deepseek-ai/dsh-game-assets`](../game-assets/README.md#model-experience), whose results carry the details and pictures this tab's viewer measures and draws for a `game-assets/render` request; the tab itself registers nothing model-facing.

#### KV Cache effect

None of its own; `asset_view` results are append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tab shows and when; they are current package constraints.

- **No live list** — the list follows the project only when the tab shows, the dropdown opens, or the refresh control is used; the viewed file itself reloads as it changes, but the files a model names and the Godot files of an animation do not.
- **No Blender rendering** — a Blender file shows only a model exported from it; the tab does not start Blender to convert one.
- **No compressed textures** — glTF models that need Draco or KTX2 decoders, and DDS or KTX images, do not show; Meshopt compression does.
- **Related files from `/api/file`** — textures and buffers that a model names load through the authenticated file route, so its byte limit, the attachments' `maxImageBytes`, also caps each of them, and a project on a UNC share, whose paths the route does not serve, shows its models without the files they name.
- **One WebGL context per model view** — each model selection creates the 3D stage again, which takes a moment on slow GPUs; an agent's picture uses another context while it draws its tiles, one picture's tiles at a time.
- **Every window draws** — each owner window that may read the Session draws the request, and the Host uses the first answer, so a second window adds no drawing capacity.
- **Counted sizes** — `maxAgentDrawBytes` counts a draw as its request does: an image's file and the pixels its header states, and a model's file with a glTF model's buffers and images; the textures a model names and the other images an animation's frames show decode uncounted, and a model's textures are not checked against `maxDecodedPixels`.
- **Own frames need `ImageDecoder`** — a browser without it, such as Safari before 17, shows an animated image's first frame only.
- **Fixed skip rule** — the scan always skips hidden folders and `node_modules`; art kept in a hidden folder does not show.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
