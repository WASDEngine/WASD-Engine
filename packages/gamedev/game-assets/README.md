---
description: "Assets for the agent: the asset_search and asset_view tools of every Session and of WASD Engine's MCP server, which list the game project's 2D art and 3D models and have the WASD Engine window draw one as the Assets tab shows it, with the details needed to edit it."
kind: "package-reference"
---

# @deepseek-ai/dsh-game-assets

English | [中文](README.zh.md)

## Summary

The asset tools let the agent see the game project's art as the user sees it in the Assets tab. `asset_search` lists the project's images and models by folder. `asset_view` has the WASD Engine window draw one asset with the tab's own viewer and reports what it measured: a model from any side, as clay or wireframe, with its skeleton and poses across a clip, and its geometry, materials, bones, and clips; an image with its transparency, colors, and 2D animation frames. `show` opens the asset in the user's Assets tab. Agents connected through the MCP server get them too.

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

### Default composition

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `game-assets` into every Web and Desktop profile, after the Assets tab's row `ui-game-assets`, whose browser half draws the pictures:

```yaml
- id: game-assets
  name: '@deepseek-ai/dsh-game-assets'
```

The plugin needs the `tools` and `workingDirectory` services. With the `attachments` and `llm` services it hands the drawn images to a Session whose model accepts images, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tools to connected agents. A profile patch entry `- id: game-assets` with `disabled: true` removes the tools.

| Field | Default | Meaning |
|---|---|---|
| `renderTimeoutMs` | `120000` | Time limit of one `asset_view` call, which waits for the window to read and draw the asset |
| `imageEdge` | `1024` | Longest edge in pixels of the returned image when the call names no `size` |
| `maxImageEdge` | `1568` | Largest `size` a call may ask for |
| `maxImagePixels` | `1150000` | Largest area in pixels of one returned image, the bound of the image-capable models |
| `maxPreviewBytes` | `268435456` | Largest file the window reads to draw it, 256 MiB |
| `maxFolders` | `2000` | Folders one project walk lists, the project folder included |
| `maxAssets` | `5000` | Assets one project walk collects |

### The tools

| Tool | What it does |
|---|---|
| `asset_search` | Lists the project's images (PNG, JPEG, WebP, GIF, BMP, SVG, AVIF, ICO, TGA, HDR, EXR) and models (glTF and GLB, OBJ, FBX, DAE, STL, PLY, VOX, and Blender files) with their kind, format, and size, and the folders with how many images and models each holds. `query` keeps the assets whose name or path contains it, best match first, and otherwise those whose path holds its letters in order; `kind` (`2d` or `3d`) and `folder` narrow the list; `limit` (1 to 200, default 50) and `offset` page it. The walk skips hidden folders and `node_modules` like the Assets tab |
| `asset_view` | Draws the asset at `path`, relative to the project folder or absolute inside it, and reports its details. See below |

`asset_view` draws a model in the `views` it names, each a tile of one picture: `iso` from the front right and above in perspective, and `front`, `back`, `right`, `left`, `top`, and `bottom` straight at one side without perspective (front at the +Z side, right from +X, top down from +Y), so proportions can be measured. `shading` is `material` (the default), `solid` clay, or `wireframe`; `skeleton` draws the bones over the model. With `animation`, a clip's name, it draws `frames` poses across the clip (6 by default, at most 16) from the first view, or, with `time`, the views at that second. A Blender file draws the model of the same name exported from it, nearest first, as the Assets tab does; without one the call fails and suggests a GLB export or Blender's `render_preview`. The picture is a JPEG.

`asset_view` draws an image on a checkerboard that shows its transparency, at the largest whole scale that fits `size` for small pixel art and smoothly scaled below its actual size; `region` draws one rectangle of it to see details up close. `grid` reads the image as a sprite sheet of `columns` × `rows` (and `count`) frames: the picture shows the grid with each cell's number, and the details list it as the animation `grid`. With `animation`, the name of one of the image's animations, it draws the animation's frames in order, each labeled with its index and duration, every frame up to 16 or `frames` of them; `fps` sets the speed of a grid or of numbered images. The picture is a PNG, so pixels stay exact.

The details of a model name its format and file size, its size and bounds, its triangles, vertices, meshes, and nodes, each material with its type, color, metalness, roughness, flags, and textures by slot, the textures with their sizes, the bones as a tree, each clip with its length, tracks, and animated bones, the morph targets of each mesh, and the files it names that are missing. The details of an image name its format, file size, size in pixels, transparency (none, cutout, or translucent), number of colors up to 256, and its 2D animations: its own frames (animated GIF, WebP, or PNG), numbered images beside it (`walk_01.png`, `walk_02.png`, …), the SpriteFrames animations and Sprite2D frame grids of the Godot scenes and resources that use it, the frames and tags of a sprite sheet JSON file of the same name (Aseprite or TexturePacker), and the call's grid, each with its frame count, speed, and length.

A Session whose model does not accept images gets the details alone, and the window draws nothing. `show` emits the `game-assets/reveal` event, so the windows that may read the Session open it, if it is not on screen, and its Assets tab with the asset selected, the call's `grid` over an image, and `animation` playing when the call names one. A teammate or subagent shows the asset in the Session of the agent that leads its subagent tree, the Session the user watches, and in its own Session when that lead is gone.

Several agents can look at different assets at the same time: a model's parallel calls, the teammates of an agent team, subagents, and agents connected through the MCP server. Each call reads and draws in the calling agent's own Session and gets its own pictures and details, and the window draws up to three at once ([`ui-game-assets`](../ui-game-assets/README.md#for-the-agent)). A teammate started in a folder below the project names assets from its own working directory, and the window reads them from the project folder the Session's header records; the files the result names, such as a Godot resource that animates an image, and a window's failures come back from the teammate's own folder.

Agents connected through WASD Engine's MCP server reach the tools under the provider `asset`. Both take `project`, the absolute path of the game project's folder, and run in the connected agent's own Session of the registered game project that holds it, which the server creates on first use and every agent of the same product shares, such as Claude Code's subagents; asset paths and `folder` are relative to `project`. Both are marked read-only, `asset_view` keeps its `renderTimeoutMs`, and the drawn picture arrives as image bytes after the result's text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`asset_search` walks the project folder on the Host. `asset_view` resolves the path and its format on the Host, finds a Blender file's export with the same walk, and then emits the scoped waterfall `game-assets/render` with the calling Agent, the call's cancellation, and the JSON request: the workspace path, the kind, the options, whether to draw images, and the byte and area bounds. [`api-remotes`](../../api/remotes/README.md) forwards it to the owner windows that may read the Session; the first answer wins, and a window that cannot help, such as one without WebGL for a model, delegates with `next()`. The Assets tab's browser half answers it ([`ui-game-assets`](../ui-game-assets/README.md)): it reads the file through `workspaceFiles`, measures it, and draws the pictures off screen with the tab's three.js viewer. The request names the asset relative to the folder in the Session's header, against which the window resolves the Session's paths, and carries the size of the file and of the buffers and images a glTF file names. The Host gives the files the window's details name, and a window failure's path, from the calling agent's working directory again. While no window is connected to the Host, the call fails at once with `ASSET_NO_WINDOW`, because the gateway would keep the request for a window that connects later; when no connected window can help, the waterfall reaches the plugin's last link with the same failure. A window's own failure, such as a clip name the model lacks, reaches the agent with its message. The Host checks every answer field by field with [`src/result.ts`](src/result.ts) before it stores the images as attachments or sends them over MCP, and the result keeps the details as JSON.

The format table and the Blender export lookup live in [`src/formats.ts`](src/formats.ts), exported as `@deepseek-ai/dsh-game-assets/formats`. A plugin's browser bundle cannot import another plugin's values, so the Assets tab keeps a copy, and a spec there keeps the two equal.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, tool registration, the Session's image attachments, the render waterfall, the reveal event, and the game MCP provider |
| [`src/types.ts`](src/types.ts) | The browser-safe request, details, and result types and the two events, exported as `./types` |
| [`src/formats.ts`](src/formats.ts) | The listed formats and the Blender export lookup, exported as `./formats` |
| [`src/scan.ts`](src/scan.ts) | The Host's walk of the project folder |
| [`src/tools.ts`](src/tools.ts) | The tool definitions, argument checks, and result content |
| [`src/describe.ts`](src/describe.ts) | The text of search results and details |
| [`src/result.ts`](src/result.ts) | Validation of a window's answer |
| [`src/mcp.ts`](src/mcp.ts) | The tools for connected agents and the provider's instructions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the viewer that draws the pictures, the MCP server, and the event forwarding.

- [ui-game-assets](../ui-game-assets/README.md) — the Assets tab, whose viewer draws for the agent.
- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#assets-tab) — how the tools and the tab fit with the other game tools.
- [api-remotes](../../api/remotes/README.md) — the forwarded events that reach the windows.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `asset_search`, with the optional `query`, `kind`, `folder`, `limit`, and `offset`, and `asset_view`, with `path` and the optional `views`, `shading`, `skeleton`, `animation`, `frames`, `time`, `grid`, `fps`, `region`, `size`, and `show`. The descriptions list the formats, say how each view looks, and say that the details give what is needed to edit the asset. A connected agent sees the same tools, with `project` required, and the provider's instructions under `## Assets`.

#### Token effect

The two declarations come to about 4,800 characters of JSON, and about 5,100 with the `project` parameter that connected agents see; the provider's instructions add about 800 characters to the MCP server's instructions.

#### KV Cache effect

The declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

A search result names the project folder and the number of assets, the folders with their counts, one line per asset with its kind, format, and size, and how to page. A view result is the details as lines of text, the bones as an indented tree, followed by what the picture shows and the picture as an image attachment; a model that does not accept images is told that no picture was drawn. A failure names what went wrong, such as a path outside the project, a format the viewer does not read, the clips or animations the asset has when the call names another, or that no WASD Engine window is open.

#### Token effect

A search result is about 50 characters per asset, for 50 by default and at most 200. A view result is a few hundred characters for an image and up to a few thousand for a model with many bones, at most 160 of them listed, plus one picture of at most 1,568 pixels on its longest edge and 1,150,000 pixels in all.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tools offer; they are current package constraints.

- **A window draws** — the pictures and details come from an open WASD Engine window; with none open, `asset_view` fails at once, and an agent can still use Blender's `render_preview` for a model.
- **Calls wait for the window** — a call's `renderTimeoutMs` includes the time its request waits behind other agents' pictures in the window.
- **No Blender files** — a Blender file shows only through a model exported from it, as in the Assets tab.
- **One window answers** — every owner window that may read the Session starts drawing, and the first answer is used.
- **Godot animations by name** — a Sprite2D's `frame` track is matched by the node's name, and Godot files over 1 MiB, or beyond the first 400, are not read.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
