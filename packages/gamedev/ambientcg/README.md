---
description: "ambientCG for the agent: the ambientcg_search, ambientcg_asset, and ambientcg_download tools of every Session and of WASD Engine's MCP server, which find CC0 PBR materials, decals, atlases, and HDRIs in ambientCG's library, show their sizes and preview images, and save their texture maps into the game project."
kind: "package-reference"
---

# @deepseek-ai/dsh-ambientcg

English | [中文](README.zh.md)

## Summary

The ambientCG plugin lets the agent find surfaces for a game in [ambientCG](https://ambientcg.com)'s library of more than 2,000 free PBR materials, with decals, atlases of cut-out pieces such as leaves, and HDRI skies, all under CC0, and save their texture maps into the game project. The agent searches by English keywords, looks at an asset's preview image and the size of each resolution, and downloads one resolution: the plugin fetches the asset's ZIP archive, checks it, and writes only the map pictures. Agents connected through WASD Engine's MCP server, such as Claude Code or Codex, get the same tools.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `ambientcg` into every Web and Desktop profile, without configuration:

```yaml
- id: ambientcg
  name: '@deepseek-ai/dsh-ambientcg'
```

The Game tools tabs of Settings › Built-in plugins and the Plugins page list the row with the ambientCG logo, and the Plugins page's switch turns it off with `- id: ambientcg` and `disabled: true` in the profile patch. Activation makes no request; a search reads the page it lists. The plugin needs the `tools` and `workingDirectory` services. With the `attachments` and `llm` services it shows preview images to a Session whose model accepts images, and with the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md) it offers its tools to connected agents.

| Field | Default | Meaning |
|---|---|---|
| `apiUrl` | `https://ambientcg.com/api/v3` | Base URL of the ambientCG API |
| `userAgent` | `WASD Engine` | `User-Agent` of every request, which names the software to ambientCG |
| `requestTimeoutMs` | `30000` | Time limit of one `ambientcg_search` or `ambientcg_asset` call |
| `downloadTimeoutMs` | `600000` | Time limit of one `ambientcg_download` call |
| `maxDownloadBytes` | `1073741824` | Largest archive of one download, and largest total size of the pictures it unpacks, 1 GiB |
| `catalogMaxAgeMs` | `43200000` | How long search pages, assets, and the categories stay in memory, 12 hours; 0 reads them every time |

### The tools

| Tool | What it does |
|---|---|
| `ambientcg_search` | Lists the assets that have every keyword of `query` among their tags, most popular first, with their id, kind, real-world size, how they were made, largest resolution, maps, and tags. ambientCG matches whole English words, so when no asset has them all the plugin looks each word up by itself and ranks the assets that have some: more words first, then the words fewer assets have, then popularity. Without `query` it lists the most popular assets and the categories to search for. `type` (`materials`, `decals`, `atlases`, or `hdris`) narrows the list; `limit` (1 to 50, default 10) and `offset` page it |
| `ambientcg_asset` | Shows the asset `id`: its tags, real-world size, maps, and page on ambientcg.com; each picture format with the size of each resolution's archive; and, unless `preview` is false, its preview image, a 512-pixel render of the material |
| `ambientcg_download` | Saves the map pictures of one `resolution` and `format` of an asset into `directory`, by default `assets/ambientcg/<id>` in the working directory |

| Kind | Formats | What a download writes by default |
|---|---|---|
| Material, decal, atlas | `jpg` (default) or `png` | Every map of the archive but the DirectX normal map `NormalDX`: `Color`, `NormalGL`, `Roughness`, and, where the asset has them, `Metalness`, `AmbientOcclusion`, `Displacement`, `Opacity`, and others; `maps` names the ones to take |
| HDRI | `exr` | The panorama `HDR`; `maps` may name `TONEMAPPED`, a JPEG of it |

`maps` takes the API's names (`color`, `normal`, `roughness`, `ambient-occlusion`), the names in the files (`NormalGL`, `NormalDX`), or common other names (`albedo`, `ao`, `metallic`, `height`, `alpha`); `normal` means the OpenGL normal map, which Godot and Blender read. A map the asset does not list is refused before anything is downloaded. Without `resolution` a download takes `1k`, or the smallest resolution when the format has no `1k`. An archive larger than `maxDownloadBytes` fails before it is fetched and names its size.

ambientCG offers each resolution as one ZIP archive that also holds material files for other programs and a preview. A download fetches the archive into a temporary folder, checks its size against the asset's listing and its SHA-1 digest against the one ambientCG's file host names, reads the archive's directory, and unpacks only the map pictures, each checked against the directory's CRC-32; the temporary folder is removed afterwards. A download writes all of its pictures or none, and a failure or cancellation leaves the folder as it was. A picture already in place with the same contents is not written again, and a picture with other contents, such as a texture the user edited, stops the download before anything is written unless `replace` is true. The plugin remembers the directory of each archive it read, so a repeated download whose pictures are all in place fetches nothing.

Agents connected through WASD Engine's MCP server reach the tools under the provider `ambientcg`, without a Session: `ambientcg_search` and `ambientcg_asset` are marked read-only, the preview image arrives as JPEG bytes after the result's text, and `ambientcg_download` requires `directory` as an absolute path.

In a Godot game, `WasdSurface.from_folder()` of the `wasd-materials` add-on makes a material of a downloaded folder, and `WasdSurface.cutout()` a cut-out of one with an `Opacity` picture; `WasdLook3D.panorama` of `wasd-look` takes an HDRI's `.exr`.

### ambientCG's terms

ambientCG's assets are CC0, so a game may use them, also commercially, without attribution. Every result names the asset's ambientcg.com page, so the agent can record the source, as the `gamedev` preset asks for every third-party asset. ambientCG's API needs no key. Its documentation says that one person runs the site and that the API is not built for heavy use, so the plugin keeps what it read in memory and looks up one word after another instead of at once.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs of Settings › Built-in plugins and the Plugins page ([`ui-game-tools`](../ui-game-tools/README.md)) show the package's [`icon.svg`](icon.svg), which `package.json` names as `icon`: the sphere of the ambientCG logo, 32 units across in a 36 × 36 canvas. ambientCG publishes its logo as pictures only, and a plugin icon must be vector shapes, so the file draws the shapes of ambientCG's own vector icon, its pinned-tab icon, which holds the sphere in one color, and fills each with the color its tile has in the colored logo. The logo belongs to ambientCG and is not CC0 like its assets; ambientCG's [brand page](https://docs.ambientcg.com/brand/) allows it where a product references ambientCG and asks that the use imply no endorsement. WASD Engine is not affiliated with, made by, or endorsed by ambientCG.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin reads two endpoints of the API and downloads archives from the URLs they name. `GET /assets?q=<words>&type=<kinds>&limit=<n>&offset=<n>&include=<fields>` returns one page of the assets that have every word, most popular first, with the number of matches; `GET /assets?id=<id>&type=<kinds>` returns one asset; and `GET /categories` returns the categories with their asset counts. Each page stays in memory under its URL, at most 64 pages, and each asset under its id, at most 2,048, for `catalogMaxAgeMs`; a refresh that fails answers with what was read last. An asset's `downloads` name its archives; the plugin offers those that are ZIP files named by a resolution, with a picture format for a surface (`1K-JPG`) and without one for an HDRI (`1K`), and leaves out animated decals and Substance archives. Assets of other kinds, such as Substance materials, 3D models, and terrains, are not listed.

A download URL redirects to ambientCG's file host. The shared client of the game tools kit ([`asset-library.ts`](../game-mcp/src/asset-library.ts)) fetches only the configured `apiUrl`'s host, over its protocol, and HTTPS hosts of `ambientcg.com` and `struffelproductions.com`, and follows at most five redirects itself, each to such a host, so neither an asset's listing nor a redirect sends a request elsewhere. JSON responses are read up to 64 MiB and preview images up to 8 MiB, and HTTP 429 becomes a message that says when to try again. The kit also holds the preview images of both callers, the tools as connected agents call them, and the writing of files whole or not at all, which the Poly Haven plugin shares.

An archive names each picture `<id>_<archive>_<Map>.<extension>`, such as `Bricks097_1K-JPG_Color.jpg`. The plugin takes the files at the archive's root whose names start with the asset's id and end in `_<Map>` and a picture extension, with only letters, digits, `-`, and `_` between, so the preview `<id>.png` and the `.blend`, `.usdc`, `.mtlx`, and `.tres` files are never written. Two pictures whose names differ only in letter case, which the disks of macOS and Windows hold as one file, stop the download before anything is written. When an archive's size differs from the asset's listing, as after ambientCG updated the asset, the download stops, forgets the asset and the archive's directory, and asks to call again, which reads the new listing.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, tool registration, the Session's preview attachments, and the game MCP provider |
| [`src/api.ts`](src/api.ts) | The API client: search pages, assets, and categories kept in memory, on the kit's client, which fetches preview images and archives |
| [`src/files.ts`](src/files.ts) | The archive of a resolution and format, the names of maps, and the pictures of an archive that a download takes |
| [`src/download.ts`](src/download.ts) | Fetching and checking an archive, reading its directory, and unpacking its pictures |
| [`src/tools.ts`](src/tools.ts) | The tool definitions, the search over some of the words, and the result text |
| [`src/mcp.ts`](src/mcp.ts) | The tools for connected agents and the provider's instructions |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the sibling library plugin, the MCP server that offers the tools to other agents, and how the game tools connect.

- [polyhaven](../polyhaven/README.md) — Poly Haven's HDRIs, textures, and 3D models, with the same three tools.
- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer, and the kit both library plugins share.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.
- [ambientCG API](https://docs.ambientcg.com/api/) — the endpoints this package reads.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `ambientcg_search`, with the optional `query`, `type`, `limit`, and `offset`; `ambientcg_asset`, with `id` and the optional `preview`; and `ambientcg_download`, with `id` and the optional `resolution`, `format`, `maps`, `directory`, and `replace`. The descriptions say that the assets are CC0, that a search takes a few English keywords in their plain form, and that games do best with 1k or 2k and jpg. A connected agent sees the same tools, with `directory` required as an absolute path, and the provider's instructions under `## ambientCG`.

#### Token effect

The three declarations come to about 3,200 characters of JSON; the provider's instructions add about 1,050 characters to the MCP server's instructions, and its line in their overview about 120.

#### KV Cache effect

The declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

A search result names the query, the number of matches, and one line per asset with its id, name, kind, real-world size, how it was made, largest resolution, maps, and tags, and says that every asset is CC0; it says so when no asset has every word and the list ranks those with some, and a result without a query also lists categories with their asset counts. An asset result lists the picture formats with the size of each resolution's archive, followed by the preview image as an attachment when the Session's model accepts images. A download result names the folder, the pictures and their total size, how many were downloaded, replaced, or already in place, the source page with the license, what each saved map holds, and the size one repeat covers. A failure names what the asset offers, such as its resolutions or maps, or why ambientCG refused.

#### Token effect

A search result is about 230 characters per asset, for 10 assets by default and at most 50. An asset result is a few hundred characters plus one 512-pixel image. A download result is a few hundred characters.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tools offer; they are current package constraints.

- **Whole words in English** — ambientCG matches a keyword against whole tags, so `wooden` does not find what `wood` finds; the tool descriptions ask for plain nouns, and a query that no asset has every word of costs one request for each of up to four words.
- **Other kinds** — Substance materials, 3D models, terrains, brushes, plain images, and animated decals are not offered.
- **The whole archive** — a download fetches the archive of a resolution, with files it does not write, even for one map.
- **No disk cache** — search pages and archive directories live in memory, so each Host start reads them again, and the first repeated download after a start fetches its archive once more to compare.
- **No patron files** — ambientCG's API tokens, which give patrons early files, are not supported.
- **Generic conversation rows** — the Web UI shows the tool calls in the generic tool row, without thumbnails.
- **Previews need image input** — a Session whose model takes text only gets no preview image.
- **ambientCG's service** — one person runs the site, and its API or the names inside its archives may change without notice.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The API's documentation is at `https://docs.ambientcg.com/api/v3/`. Asset ids are letters and digits, such as `PavingStones036`, and ambientCG matches them in any letter case. A preview is the asset's `512-JPG-FFFFFF` thumbnail, a render on white. ambientCG's file host is Backblaze B2, which names a file's SHA-1 digest in `x-bz-content-sha1`, or in `x-bz-info-large_file_sha1` for a file uploaded in parts; a response without either is checked by its size and each picture's CRC-32 only. `dimensions` are centimeters, 0 where ambientCG does not know them.

</details>
