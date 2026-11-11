---
description: "Poly Haven for the agent: the polyhaven_search, polyhaven_asset, and polyhaven_download tools of every Session and of WASD Engine's MCP server, which find CC0 HDRIs, textures, and 3D models in Poly Haven's library, show their files and preview images, and save them into the game project."
kind: "package-reference"
---

# @deepseek-ai/dsh-polyhaven

English | [中文](README.zh.md)

## Summary

The Poly Haven plugin lets the agent find assets for a game in [Poly Haven](https://polyhaven.com)'s library of free HDRI skies, tileable PBR textures, and 3D models, all under CC0, and save them into the game project. The agent searches by description in any language, browses the most downloaded assets by category, looks at an asset's formats, sizes, and preview image, and downloads one format and resolution, such as a glTF model with its textures, with each file's digest checked. Agents connected through WASD Engine's MCP server, such as Claude Code or Codex, get the same tools.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `polyhaven` into every Web and Desktop profile, without configuration:

```yaml
- id: polyhaven
  name: '@deepseek-ai/dsh-polyhaven'
```

The Game tools tabs of Settings › Built-in plugins and the Plugins page list the row with the Poly Haven logo, and the Plugins page's switch turns it off with `- id: polyhaven` and `disabled: true` in the profile patch. Activation makes no request; the first search reads Poly Haven's asset list. The plugin needs the `tools` and `workingDirectory` services. With the `attachments` and `llm` services it shows preview images to a Session whose model accepts images, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tools to connected agents.

| Field | Default | Meaning |
|---|---|---|
| `apiUrl` | `https://api.polyhaven.com` | Base URL of the Poly Haven API |
| `userAgent` | `WASD Engine` | `User-Agent` of every request; Poly Haven's API terms require it to name the software |
| `requestTimeoutMs` | `30000` | Time limit of one `polyhaven_search` or `polyhaven_asset` call |
| `downloadTimeoutMs` | `600000` | Time limit of one `polyhaven_download` call |
| `maxDownloadBytes` | `1073741824` | Largest total size of the files of one download, 1 GiB |
| `catalogMaxAgeMs` | `43200000` | How long the asset list stays in memory, 12 hours, the time the API allows caches to keep it; 0 reads it for every search |

### The tools

| Tool | What it does |
|---|---|
| `polyhaven_search` | Ranks assets for `query` with Poly Haven's search, which matches synonyms in any language, and lists them most relevant first with their id, kind, category, largest resolution, real-world size, polygon count, and description. Without `query` it lists the most downloaded assets and the categories one level below `category`. `type` (`hdris`, `textures`, or `models`) and `category` (a path such as `Furniture/Seating`, matched segment by segment in any letter case) narrow the list; `limit` (1 to 50, default 10) and `offset` page it. When the search answers HTTP 503, the plugin ranks the query's words in names, tags, categories, and descriptions itself |
| `polyhaven_asset` | Shows the asset `id`: its description, authors, tags, real-world size, polygon count, and page on polyhaven.com; each download format with the size of each resolution; a texture's maps and the ones a download takes by default; and, unless `preview` is false, its preview image, a 512-pixel JPEG |
| `polyhaven_download` | Saves one `format` and `resolution` of an asset, with every file the format references, into `directory`, by default `assets/polyhaven/<id>` in the working directory, and names the file that opens it |

| Kind | Formats | Default |
|---|---|---|
| HDRI | `hdr` or `exr` panorama | `hdr` |
| Texture | `jpg`, `png`, or `exr` maps; `gltf`, `blend`, or `mtlx` material with its maps | `jpg` maps: every map but the DirectX normal maps, whose names end in `nor_dx`; `maps` names others |
| Model | `gltf`, `fbx`, `blend`, or `usd` with its buffers and textures | `gltf` |

Without `resolution` a download takes `1k`, or the smallest resolution when the format has no `1k`. A download larger than `maxDownloadBytes` fails before it writes anything and names its size.

A download writes all of its files or none. Each file streams into a temporary file beside its target, its size and MD5 digest must match Poly Haven's file list, and only when every file arrived intact do the files take their targets' places; a failure or cancellation leaves the folder as it was. A file already in place with the same digest is not downloaded again. A file with other contents, such as a texture the user edited, stops the download before anything is written unless `replace` is true. A path in the file list that would leave the download folder stops the download.

Agents connected through WASD Engine's MCP server reach the tools under the provider `polyhaven`, without a Session: `polyhaven_search` and `polyhaven_asset` are marked read-only, the preview image arrives as JPEG bytes after the result's text, and `polyhaven_download` requires `directory` as an absolute path.

### Poly Haven's terms

Poly Haven's assets are CC0, so a game may use them, also commercially, without attribution. Every result names the asset's polyhaven.com page, so the agent can record the source, as the `gamedev` preset asks for every third-party asset. Poly Haven's [API terms](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md) allow commercial use; they require requests that name the software, which `userAgent` does, and a product that makes clear where the content comes from, which the tool names, the results, and the Game tools card do.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs of Settings › Built-in plugins and the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`. The file embeds the colored Poly Haven logo icon of the [Poly Haven logo kit](https://polyhaven.com/logo) unaltered in a 36 × 36 canvas. The logo belongs to Poly Haven and is not CC0 like its assets; Poly Haven's logo terms allow it as the credit that a product built on the Poly Haven API shows, which is the icon's role. WASD Engine is not affiliated with, made by, or endorsed by Poly Haven.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin reads three endpoints of the API and downloads files from the URLs they name. `GET /assets?type=all` returns every asset, about 2.5 MB for 2,400 assets; the list stays in memory for `catalogMaxAgeMs`, and a refresh that fails answers with the list read last. `GET /search?q=<query>&t=<type>` returns every matching id in ranked order; the plugin joins the ids with the list, drops ids the list lacks, then filters by category and pages. `GET /files/<id>` returns the asset's files by group (a map, a format, or `hdri`), resolution, and format, each with its URL, size, MD5 digest, and the files it references; an entry that is not a file three levels down, such as an HDRI's single tonemapped image, is left out, and so is a file whose references cannot all be read. JSON responses are read up to 64 MiB, preview images up to 8 MiB, and only HTTP and HTTPS URLs are fetched. HTTP 429 becomes a message that says when to try again.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, tool registration, the Session's preview attachments, and the game MCP provider |
| [`src/api.ts`](src/api.ts) | The API client: the cached asset list, the search, file trees, preview images, and file requests |
| [`src/files.ts`](src/files.ts) | The formats and resolutions an asset offers, and the files of one download with their paths checked |
| [`src/download.ts`](src/download.ts) | Writing a download's files: temporary files, digests, and conflicts |
| [`src/tools.ts`](src/tools.ts) | The tool definitions and their result text |
| [`src/mcp.ts`](src/mcp.ts) | The tools for connected agents and the provider's instructions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the MCP server that offers the tools to other agents and how the game tools connect.

- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.
- [Poly Haven API](https://api.polyhaven.com/api-docs/swagger.json) — the endpoints this package reads.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `polyhaven_search`, with the optional `query`, `type`, `category`, `limit`, and `offset`; `polyhaven_asset`, with `id` and the optional `preview`; and `polyhaven_download`, with `id` and the optional `format`, `resolution`, `maps`, `directory`, and `replace`. The descriptions say that the assets are CC0, that the search understands descriptions in any language, and that games do best with 1k or 2k, gltf models, and jpg maps. A connected agent sees the same tools, with `directory` required as an absolute path, and the provider's instructions under `## Poly Haven`.

#### Token effect

The three declarations come to about 3,100 characters of JSON; the provider's instructions add about 750 characters to the MCP server's instructions.

#### KV Cache effect

The declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

A search result names the query, the number of matches, and one line per asset with its id, name, kind, category, largest resolution, real-world size, polygon count, and Poly Haven's description, and says that every asset is CC0; a result without a query also lists categories with their asset counts. An asset result lists the formats with the size of each resolution and a texture's maps, followed by the preview image as an attachment when the Session's model accepts images. A download result names the folder, the files and their total size, how many were downloaded, replaced, or already in place, the file that opens the asset, the source page and authors with the license, and how Godot and Blender open the format. A failure names what the asset offers, such as its formats or resolutions, or why Poly Haven refused.

#### Token effect

A search result is about 300 characters per asset, for 10 assets by default and at most 50. An asset result is a few hundred characters plus one 512-pixel image. A download result is a few hundred characters.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tools offer; they are current package constraints.

- **No HDRI extras** — an HDRI's backplate photos, tonemapped JPEG, and color chart are not offered.
- **Model maps** — a model's texture maps download only as part of one of its formats, not alone.
- **No disk cache** — the asset list lives in memory, so each Host start reads it again, and each project downloads its files again.
- **Generic conversation rows** — the Web UI shows the tool calls in the generic tool row, without thumbnails.
- **Previews need image input** — a Session whose model takes text only gets no preview image.
- **Poly Haven's service** — the API may change or stop without notice, and its search ranks by meaning, so it lists close assets even for a query the library has nothing for.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The API publishes its OpenAPI description at `https://api.polyhaven.com/api-docs/swagger.json` and its terms at `ToS.md` of the Poly-Haven/Public-API repository. Asset ids are letters, digits, `_`, and `-`, and the asset list keys each asset by its id. A preview URL is the list's `thumbnail_url` with `width`, `height`, and `format=jpeg` set, which the image CDN serves resized.

</details>
