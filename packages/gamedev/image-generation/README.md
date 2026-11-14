---
description: "Image generation for the agent: the image_generate tool of every Session and of WASD Engine's MCP server, which makes game art, UI pieces, and textures with Google's Nano Banana 2.1 from a prompt and up to 14 images to edit or match, and saves them into the game project, made by the WASD Engine API and charged to the signed-in account's plan."
kind: "package-reference"
---

# @deepseek-ai/dsh-image-generation

English | [中文](README.zh.md)

## Summary

The image generation plugin lets the agent make a game's 2D art, UI pieces, concept art, and textures with Google's Nano Banana 2.1. From a prompt, and up to 14 existing images to edit or to match, it makes one image and saves it as a `.png`, `.jpg`, or `.webp` file in the game project. The WASD Engine API makes the image with its own Gemini API key and charges it to the signed-in account's plan. Agents connected through WASD Engine's MCP server get the same tool.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `image-generation` into every Web and Desktop profile, with the WASDEngine API origin, the same expression as the account sign-in's `inferenceOrigin` in [`gateway.cordis.patch.yml`](../../bundle/base/wasdengine/gateway.cordis.patch.yml):

```yaml
- id: image-generation
  name: '@deepseek-ai/dsh-image-generation'
  config:
    apiOrigin: !!js >-
      ctx.get('launchEnvironment')?.getFrom('WASDENGINE_ORIGIN', ['process', 'user-env'])?.value || 'https://api.wasdengine.com'
```

The Game tools tabs of Settings › Built-in plugins and the Plugins page list the row as Nano Banana, and the Plugins page's switch turns it off with `- id: image-generation` and `disabled: true` in the profile patch. Activation makes no request. The plugin needs the `tools` and `workingDirectory` services; each call reads the account token of the `deepseekAccount` service, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tool to connected agents.

| Field | Default | Meaning |
|---|---|---|
| `apiOrigin` | `https://api.wasdengine.com` | Origin of the WASD Engine API; the account sign-in releases its token only to its `inferenceOrigin`, so the two must match |
| `generationTimeoutMs` | `330000` | Time limit of one `image_generate` call; the API waits up to 300 s for Google |

### The tool

`image_generate` makes one image from `prompt` (at most 10,000 characters) and saves it at `path`, whose extension picks the file type: `.png`, `.jpg` or `.jpeg`, or `.webp`.

| Argument | Meaning |
|---|---|
| `images` | Up to 14 existing images, to edit or to match a character, an object, or an art style, in the order the prompt refers to them. Nano Banana 2.1 keeps up to 4 characters and 10 objects consistent |
| `aspect_ratio` | `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `21:9`, `1:4`, `4:1`, `1:8`, or `8:1`; without it, the shape closest to the first image's, or `1:1` without images |
| `size` | `1K` (about 1 megapixel, the default), `2K` (about 4), or `4K` (about 16) |
| `replace` | Overwrite `path` when it exists; without it, an existing file is refused |

`path` and each image are relative to the Session's working directory or absolute. A call checks every argument, the target path, and each image before the paid request, so a refused call costs nothing. An image is sent as it is when it is a PNG, JPEG, or WebP file that is upright, one frame, at most 2,048 pixels on its longest side, and at most 7 MB; any other image sharp reads, such as a GIF, a TIFF, an SVG, or a larger photo, is turned upright, scaled down, and sent as PNG, JPEG, or WebP. The images of one call may hold 14 MB in all. Nano Banana answers with a JPEG file, which is saved unchanged for a `.jpg` path and converted for `.png` or `.webp`; it is written through a temporary file beside the target and appears complete or not at all. A result names the file, its pixel size and file size, the model, size, and shape, and the images it was made from.

Nano Banana makes no transparent backgrounds, so the tool's description tells the agent to ask for one flat background color and make it transparent with GIMP, with a little tolerance for the JPEG's edges, and to make textures seamless with GIMP. Every image carries Google's invisible SynthID watermark.

Agents connected through WASD Engine's MCP server reach the tool under the provider `image`, titled Nano Banana, without a Session: `path` and every image must be absolute paths. Their images are charged to the account WASD Engine is signed in to, and the server refuses every call while it is signed out.

### Prices and the account

The WASD Engine API charges each image to the AI usage of the account's plan at Google's API prices for Nano Banana 2.1, by the tokens Google reports: a 2K image costs half again as much as a 1K image and a 4K image more than three times as much, plus a little for the prompt, the images sent, and thinking. A request that returns no image, such as one Google's safety filters block, costs nothing. Once the plan's AI usage is used up, a call fails with the API's "Usage limit reached" message and asks the agent to have the user upgrade or turn on auto recharge. While WASD Engine is signed out, every call asks the agent to have the user sign in; a token the API refuses (HTTP 401) is reported to the account service, which signs the account out when it is still the stored one.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`: a package-local picture with a spark in the WASD Engine keycap purple, not Google's or Nano Banana's logo. WASD Engine is not affiliated with, made by, or endorsed by Google.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each call posts one JSON object to `POST /v1/images/generate` on `apiOrigin`: `prompt`, `images` as `{ mime_type, data }` with the file in base64, `aspect_ratio`, and `size`, with the token that `deepseekAccount.resolveToken` releases for that URL in `x-dsh-auth-token`, and never follows redirects. The answer is the image file (`image/png`, `image/jpeg`, or `image/webp`) with its pixel size in `x-image-width` and `x-image-height`; the client reads at most 64 MiB. An error answer carries the API's message, which the client words for the agent by status. Sharp loads at the first call that reads or converts an image.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, the account token, tool registration, and the game MCP provider |
| [`src/api.ts`](src/api.ts) | The API client and its error wording |
| [`src/files.ts`](src/files.ts) | Fitting each image to what the API takes, and converting the result to the path's file type |
| [`src/tools.ts`](src/tools.ts) | The tool definition, argument checks, the shape of edits, file writing, and result text |
| [`src/mcp.ts`](src/mcp.ts) | The tool for connected agents and the provider's instructions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the MCP server that offers the tool to other agents and how the game tools connect.

- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.
- [Gemini image generation](https://ai.google.dev/gemini-api/docs/image-generation) — Nano Banana's prompts, editing, and reference images.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `image_generate`, with `prompt`, `path`, and the optional `images`, `aspect_ratio`, `size`, and `replace`. The description names the model, lists the kinds of game art, UI art, and textures it makes, says to pass images to work from references, to edit, or to keep a character, object, or style consistent, and to say what to take from each, says that Nano Banana makes no transparent backgrounds and how to get one with GIMP, how to ask for a texture and make it seamless with GIMP, to look at each result with `asset_view`, and that each image costs AI usage from the user's WASD Engine plan, more at 2K and 4K. A connected agent sees the same tool, with `path` and `images` described as absolute paths, and the provider's instructions under `## Nano Banana`.

#### Token effect

The declaration comes to about 2,100 characters of JSON; the provider's instructions add about 900 characters to the MCP server's instructions.

#### KV Cache effect

The declaration is static, so it stays in the cached tool prefix.

### Tool results

#### What the model sees

A result is one or two sentences: the file, its pixel size and file size, whether it replaced a file, the model, size, and shape, and the images it was made from. A failure says what to change: an argument out of range, a path that exists, an image that is missing or not an image, a refusal by Google's safety filters, a used-up plan, or a signed-out app.

#### Token effect

A result is one or two sentences.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tool offers; they are current package constraints.

- **No transparency** — Nano Banana makes no alpha channel; sprites and UI pieces need their background made transparent in GIMP.
- **JPEG output** — the Gemini API's `generateContent` answers JPEG and offers no output type, so a `.png` keeps JPEG artifacts; Gemini's Interactions API, whose `response_format` can ask for PNG, would avoid them.
- **No guaranteed tiling** — a texture is not seamless until GIMP makes it so; the API offers no tiling mode.
- **No true pixel art** — pixel-art styles come out on an uneven grid with more colors than a palette; downscale them with nearest-neighbor sampling in GIMP and reduce their colors.
- **One image per call** — a set of sprites or icons is one call each, kept consistent by passing earlier images.
- **The result is not shown to the model** — the result names the file; the agent looks at it with `asset_view`, or a connected agent with its own image reading.
- **Generic conversation rows** — the Web UI shows the tool call in the generic tool row, without a preview of the image.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The API's image route pins the model, `gemini-nano-banana-2.1`, and image-only output, refuses images whose headers do not match their type, reads the size of the image it returns, and bills the tokens Google reports. The request fields are the tool's arguments under the same names; `aspect_ratio` is always sent, the first image's closest shape when the call names none, so an edit keeps its image's shape.

</details>
