---
description: "3D models for the agent: the tripo_* tools of every Session and of WASD Engine's MCP server, which make textured 3D models with Tripo's P2 model from a prompt, an image, or views of an object, give them new textures, rig them, and animate them, and save each as a .glb file in the game project, made through the WASD Engine API and charged to the signed-in account's plan."
kind: "package-reference"
---

# @deepseek-ai/dsh-tripo

English | [中文](README.zh.md)

## Summary

The Tripo plugin lets the agent make a game's 3D models with Tripo: `tripo_generate` makes a model with PBR textures from a prompt, an image, or views of an object with Tripo's P2 model; `tripo_texture` retextures it, `tripo_rig` adds a skeleton, `tripo_animate` adds preset animations, and `tripo_task` waits again for a task. Each call saves a `.glb` file in the game project. The WASD Engine API runs the tasks with its own Tripo key and charges them to the signed-in account's plan. Agents connected through WASD Engine's MCP server get the same tools.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `tripo` into every Web and Desktop profile, with the WASDEngine API origin, the same expression as the account sign-in's `inferenceOrigin` in [`gateway.cordis.patch.yml`](../../bundle/base/wasdengine/gateway.cordis.patch.yml):

```yaml
- id: tripo
  name: '@deepseek-ai/dsh-tripo'
  config:
    apiOrigin: !!js >-
      ctx.get('launchEnvironment')?.getFrom('WASDENGINE_ORIGIN', ['process', 'user-env'])?.value || 'https://api.wasdengine.com'
```

The Game tools tabs of Settings › Built-in plugins and the Plugins page list the row as Tripo, and the Plugins page's switch turns it off with `- id: tripo` and `disabled: true` in the profile patch. Activation makes no request. The plugin needs the `tools` and `workingDirectory` services; each call reads the account token of the `deepseekAccount` service, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tools to connected agents.

| Field | Default | Meaning |
|---|---|---|
| `apiOrigin` | `https://api.wasdengine.com` | Origin of the WASD Engine API; the account sign-in releases its token only to its `inferenceOrigin`, so the two must match |
| `taskTimeoutMs` | `600000` | Time limit of one call, which waits for Tripo's task and saves its model; the call stops waiting 30 s before it (a quarter of the limit for a limit under two minutes) to keep time for the download |

### The tools

Each tool saves its model at `path`, which ends in `.glb`, and returns the task's `task_id`, which the next step takes. `path` and every image are relative to the Session's working directory or absolute; a network path is refused on every platform. A call checks every argument, the target path, and each image before it starts a task, so a refused call costs nothing. Without `replace`, the call then creates the target file, empty, only while no file has the path, so of two calls that write one path at once only one starts a task and neither overwrites a file; the finished model takes the empty file's place, and a call that fails removes it again, with any folder it made for it.

| Tool | Arguments | What it makes |
|---|---|---|
| `tripo_generate` | `prompt` (at most 1,024 characters), `image`, or `views` (`front`, required, and one to three of `left`, `back`, `right`), exactly one of them; `face_limit` (48 to 50,000, or 25,000 with `quad`); `quad` | A model with PBR textures (base color, metallic, roughness, and normal maps) by Tripo's P2 model |
| `tripo_texture` | `task_id` of a `tripo_generate` call; `prompt`, `image`, or both, the image then setting the style | The same model with a new texture at the same quality |
| `tripo_rig` | `task_id` of a `tripo_generate` or `tripo_texture` call; `rig_type` (`biped`, `quadruped`, `hexapod`, `octopod`, `avian`, `serpentine`, `aquatic`, or `others`) | The model with a skeleton; without `rig_type`, a free rig check picks the skeleton first, or the call fails when Tripo finds none that fits |
| `tripo_animate` | `task_id` of a `tripo_rig` call; `animations`, one to five, each once; `in_place` (default true: no root motion) | The rigged model with the animations as clips, which Godot imports into its AnimationPlayer: a biped takes `idle`, `walk`, `run`, `jump`, `fall`, `climb`, `dive`, `turn`, `slash`, `shoot`, and `hurt`; a quadruped, hexapod, or octopod `walk`; a serpentine or aquatic rig `march`; avian and other rigs none |
| `tripo_task` | `task_id`; `path` (optional) | Waits for a task that an earlier call stopped waiting for, without starting it again, and saves its model at `path` |

An image is sent as it is when it is a PNG, JPEG, or WebP file that is upright, one frame, at most 2,048 pixels on its longest side, and at most 7 MB; any other image sharp reads is turned upright, scaled down, and converted, as the [image generation](../image-generation/README.md) tool does with the code it exports as `@deepseek-ai/dsh-image-generation/files`. The images of one model may hold 16 MB in all. A call asks how its task goes every 3 seconds, tries a status request that fails in passing again up to five times in a row, and tries a start that the API answers busy (429), as when the account already runs as many tasks as it may at once, again after the pause it names, at most 10 s, until the call's time runs out, so parallel calls take turns. When the call stops waiting, its error names the task and asks the agent to call `tripo_task` with it, so a slow task is saved without being made, and paid for, twice. The model file is checked as a complete glTF 2.0 binary and changed as the next paragraph says before it is written through a temporary file beside the target, and the result names the file, its size, the axis it faces, its animation clips, and for a rig its skeleton and the animations `tripo_animate` takes.

Tripo's models face +X, so each saved model is turned a quarter turn about +Y to face +Z, glTF's front, which Godot imports as a model's front. A node named `Front` holds the turn above each part of the scene, and in a rig above the skeleton: an importer that also applies a skinned mesh's own node, such as three.js, would turn the model twice if the turn were above the skinned mesh. Tripo's clips can hold the model away from the spot where it stands at rest even in place; its in-place run held a fox's hips about 0.4 units ahead of it. Each clip is therefore moved across the ground on its skeleton root's translation: a clip whose hips end near where they start is centered over the spot where they are at rest, and one whose hips end farther than a tenth of the skeleton's size away starts there and keeps its path. A model whose nodes do not form a tree, or whose turn a moving or stretching parent would bend, is saved without the turn, and its result names no axis.

Agents connected through WASD Engine's MCP server reach the tools under the provider `tripo`, titled Tripo, without a Session: `path`, `image`, and every view must be absolute paths. Their tasks are charged to the account WASD Engine is signed in to, and the server refuses every call while it is signed out. The provider's description in the overview of the server instructions asks the agent to prefer it to modeling 3D models itself, and its guide to prefer it to modeling characters, creatures, and props in Blender or code. The provider spends the account's AI usage (`spendsUsage`), so while a Free account whose usage is used up stays on Free, the server offers connected agents none of its tools ([Free accounts whose usage is used up](../game-mcp/README.md#free-accounts-whose-usage-is-used-up)).

### Prices and the account

The WASD Engine API charges each task that succeeds to the AI usage of the account's plan, at Tripo's API price for the credits Tripo reports it used: a textured P2 model costs eleven times a new texture, a rig two and a half times, and each animation as much as a texture; a rig check is free, and a task that fails costs nothing. Once the plan's AI usage is used up, a start fails with the API's "Usage limit reached" message and asks the agent to have the user upgrade or turn on auto recharge; a task already running still finishes and saves. While WASD Engine is signed out, every call asks the agent to have the user sign in; a token the API refuses (HTTP 401) is reported to the account service, which signs the account out when it is still the stored one.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`: a WASD Engine keycap, in the palette of the WASD Engine Plugins mark, with a cube for a 3D model, drawn for WASD Engine like the [game add-ons](../game-addons/README.md#plugin-icon) icon. It is no Tripo logo. Tripo is a trademark of its owner. WASD Engine is not affiliated with, made by, or endorsed by Tripo.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each call posts one JSON object to a start route on `apiOrigin` (`/v1/3d/generate` with `prompt`, or `images` as `{ view, mime_type, data }` with the file in base64, and `face_limit` and `quad`; `/v1/3d/texture` with `task_id`, `prompt`, and `image`; `/v1/3d/rig-check` with `task_id`; `/v1/3d/rig` with `task_id` and `rig_type`; `/v1/3d/animate` with `task_id`, `animations`, and `in_place`), then reads `GET /v1/3d/tasks/<task_id>` until the task's `status` is `success` or `failed`, then downloads `GET /v1/3d/tasks/<task_id>/model`, reading at most 256 MiB. Every request carries the token that `deepseekAccount.resolveToken` releases for its URL in `x-dsh-auth-token` and never follows redirects. An error answer carries the API's message, which the client words for the agent by status. Sharp loads at the first call that converts an image.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the account token, tool registration, and the game MCP provider |
| [`src/api.ts`](src/api.ts) | The API client: starts, status requests, waiting, downloads, and their error wording |
| [`src/glb.ts`](src/glb.ts) | GLB files: reading and writing their JSON and binary chunks, and the meshes, skins, and animation clips a file names |
| [`src/prepare.ts`](src/prepare.ts) | The turn of each model to face +Z, and the move of each clip over the spot where the model stands at rest |
| [`src/tools.ts`](src/tools.ts) | The tool definitions, argument checks, images, the target file, and result text |
| [`src/mcp.ts`](src/mcp.ts) | The tools for connected agents and the provider's instructions |
| [`src/types.ts`](src/types.ts) | The kinds of task, the skeletons, the views, and a task as the API reports it |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the MCP server that offers the tools to other agents, the tool whose images make the best models, and how the game tools connect.

- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [image-generation](../image-generation/README.md) — `image_generate`, whose concept images `tripo_generate` turns into models.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.
- [Tripo API documentation](https://developers.tripo3d.ai/en/docs) — Tripo's models, texturing, rigging, and animations.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `tripo_generate`, `tripo_texture`, `tripo_rig`, `tripo_animate`, and `tripo_task`. `tripo_generate`'s description lists the kinds of models it makes, asks the agent to prefer it to modeling them in Blender or building them from primitives in code and to use Blender to adjust what it makes and for exact or modular shapes, says that the best results come from one image of the whole object on a plain background in the game's art style, such as a concept from `image_generate`, with a character in a T-pose or A-pose, says that every model has PBR textures, that the call waits, often a minute, and that every saved model faces +Z, glTF's front, and asks the agent to look at it with `asset_view` and to scale it and turn it to the game's forward direction in Godot or Blender. The other descriptions say what each step builds on and returns, which skeletons Tripo animates with which animations, that in-place clips stay on the spot where the character stands at rest, and how to load more than five clips into one AnimationLibrary. A connected agent sees the same tools, with every file described as an absolute path, and the provider's instructions under `## Tripo`. No text the model sees says what a model costs, so the agent makes what the game needs; only the failure once the account's AI usage is used up asks it to pass on the upgrade to the user.

#### Token effect

The five declarations come to about 6,500 characters of JSON; the provider's instructions add about 1,500 characters to the MCP server's instructions.

#### KV Cache effect

The declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

A result is one or two sentences: the file, its size, whether it replaced a file, the axis it faces, the task's `task_id` and the tool that takes it next, the animation clips of an animated model, and the skeleton and animations of a rig. A failure says what to change: an argument out of range, a path that exists, an image that is missing or not an image, Tripo's reason for a failed task, a task that is still running with the `tripo_task` call that waits for it again, a used-up plan, whose message from the WASD Engine API names the account page where the user upgrades or turns on auto recharge and which the agent is asked to pass on to the user, or a signed-out app.

#### Token effect

A result is one or two sentences.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tools offer; they are current package constraints.

- **Tripo's own models only** — a texture, rig, or animation builds on a task the account made with these tools; a model made elsewhere, such as in Blender or downloaded, cannot be textured, rigged, or animated by Tripo here.
- **Five animations a file** — Tripo adds at most five preset animations in one task; more come in further files whose clips the game loads into one AnimationLibrary.
- **Preset animations only** — avian and other rigs get no animations, and no rig gets animations beyond Tripo's presets; animate those in Blender or Godot.
- **Scale as Tripo makes it** — a model comes at Tripo's size, which the agent fits to the game in Godot or Blender, as it turns a model that faces +Z for a game whose forward is another axis.
- **Clips moved by their hips** — a clip's path is read from its hips with their parent placed as the clip starts, so a clip whose root joint turns as it plays is centered to within that turn; a clip that travels less than a tenth of the skeleton's size counts as staying on the spot.
- **The result is not shown to the model** — the result names the file; the agent looks at it with `asset_view`, or a connected agent with its own model viewer.
- **Generic conversation rows** — the Web UI shows the tool calls in the generic tool row, without a preview of the model.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The API's 3D routes pin the model (P2), the texture quality (standard, with PBR maps), the rig models, and the GLB output, upload the images to Tripo themselves, keep Tripo's task ids and download links from the client, serve a task only to the account that started it, and charge a task once, when they first see it succeed, at the credits Tripo reports. The preset animation names here repeat the API's list; a name the API does not take for a rig comes back as its 400 message.

</details>
