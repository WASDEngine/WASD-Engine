---
description: "WASD Engine Plugins, WASD Engine's own always-on features: the wasd_export_web and wasd_release_game tools of every Session and of WASD Engine's MCP server, which export Godot games for the Web and release them to the WASD Engine site as numbered versions with share links; the wasdPlugins Remote; the Release button in the Session header; and Explore Games in the sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-wasd-plugins

English | [中文](README.zh.md)

## Summary

WASD Engine Plugins holds WASD Engine's own features and stays on in every Web and Desktop profile. It exports the user's Godot game for the Web with the built-in Godot and releases it to the WASD Engine site the app is signed in to as the game's next numbered version, at a share link where anyone can play it, pick earlier versions, and comment. Session agents and connected agents get the same tools; the Release button in the Session header asks the agent to release, and Explore Games in the sidebar opens the released games.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `wasd-plugins` into every Web and Desktop profile:

```yaml
- id: wasd-plugins
  name: '@deepseek-ai/dsh-wasd-plugins'
```

| Field | Default | Meaning |
|---|---|---|
| `explorePath` | `/explore` | Path of the Explore page on the WASD Engine site; Explore Games opens it |

The plugin manager lists the package in `WASD_ENGINE_PLUGINS`, which [`@deepseek-ai/dsh-official-bundles`](../../util/official-bundles/README.md) adds to `PROTECTED_PLUGINS`, so the Plugins page, the plugin management tools, and the `pluginManager` Remote refuse to switch the row off. The package needs the `godot` service of [`@deepseek-ai/dsh-godot`](../godot/README.md) for exports and the `deepseekAccount` service for the site's origin and the signed-in token.

### The tools

| Tool | What it does |
|---|---|
| `wasd_export_web` | Exports the Godot project into its `.wasdengine/web/` folder with `ctx.godot.exportWeb()`: a single-threaded build, `index.html` with the engine and the pack, that any static web server can serve. The first export downloads Godot's Web template, about 10 MB |
| `wasd_release_game` | Exports the project, uploads the build to the site's games API as the game's next version (1, 2, 3, ...), and returns the share links. The first release on a site creates the game, titled from `project.godot` unless `title` names one; `notes`, at most 1,000 characters, go to the game page; `cover_image`, a PNG, JPEG, or WebP file, becomes the game's picture on the Explore page |

In a Session, `project` and `cover_image` are relative to the working directory, and without `project` the tools use the nearest `project.godot`. Agents connected through WASD Engine's MCP server reach the tools under the provider `wasd` and must pass absolute paths. Releasing needs a signed-in WASD Engine: signed out, the tool fails with a message that asks the user to sign in, and an expired sign-in fails with a message that asks the user to sign in again.

A project remembers its game per site in `.wasdengine/game.json`, so later releases from the same folder add versions to the same game. When the site no longer has that game, or another account owns it, the release creates a new game. A `title` renames an existing game. The site numbers versions without gaps and keeps every earlier version playable.

### The Release button and Explore Games

The Release button appears in the header of a Session that belongs to a game project, when the Peer may prompt the Session and call `wasdPlugins/project`. It opens a dialog that names the project's last release with a link to its page, refuses a folder without `project.godot`, and takes optional release notes. Release sends the Session a prompt, in the window's language, that asks its agent to call `wasd_release_game` with those notes, or with notes it writes from what changed, and to answer with the share link, so the export and the upload run as a turn the user watches.

Explore Games sits above Settings at the foot of the left sidebar while the Peer may call `wasdPlugins/links`. It opens the site's Explore page with `window.open`, which the Desktop app hands to the system browser and the Web UI opens in a new tab. On the narrow rail it shows its globe alone, with its label as a tooltip.

### The `wasdPlugins` Remote

| Method | Returns |
|---|---|
| `project(projectDir)` | Whether the absolute folder holds `project.godot`, and the game it released to on the site the app is signed in to: title, share page, and latest version |
| `links()` | The site's Explore page |

LiveShare keeps both methods for the owner, because a release publishes under the owner's account.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The site's origin comes from the account plugin: its account view's links name the site even while signed out, and `getPlatformSession()` names it with the token while signed in. Every site call sends the token in `x-dsh-auth-token`, refuses redirects, and maps a 401 to the expired sign-in message; the site's own message explains other refusals, and a 5xx says to try again later.

A release writes the export into a ZIP file in the system's temporary folder, streaming each file through `node:zlib` and storing already compressed formats as they are, then uploads it as the request body of `POST /api/v1/games/<id>/releases` with the notes in the query string, and deletes it. A 404 from the upload, which means the game was removed meanwhile, creates a new game and uploads again. A cover the site refuses becomes a note of the result, because the version is already released.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `WasdPlugins`: Config, tool registration, the game MCP provider, and the `wasdPlugins` Remote |
| [`src/tools.ts`](src/tools.ts) | The tool definitions and their MCP wrappers |
| [`src/release.ts`](src/release.ts) | The site API client, the game link file, and the release flow |
| [`src/zip.ts`](src/zip.ts) | The streaming ZIP writer of the upload |
| [`src/client/`](src/client/) | The Release button, Explore Games, their copy, and the Remote mount |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the export, the MCP server that offers the tools to other agents, and the site that hosts released games.

- [Godot package](../godot/README.md#web-export) — the headless Web export and its template.
- [game-mcp](../game-mcp/README.md) — the MCP server for agents on this computer.
- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — how the game tools, the Sessions, and the window connect.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declarations

#### What the model sees

The Session's agent sees `wasd_export_web`, with the optional `project`, and `wasd_release_game`, with the optional `project`, `notes`, `title`, and `cover_image`. The release description asks the model to release only when the user asks, because each call publishes a public version. A connected agent sees the same tools with absolute-path parameters and the provider's instructions under `## WASD Engine`.

#### Token effect

The two declarations come to about 1,700 characters of JSON; the provider's instructions add about 550 characters to the MCP server's instructions.

#### KV Cache effect

Both declarations are static, so they stay in the cached tool prefix.

### Tool results

#### What the model sees

`wasd_export_web` names the output folder, its files, and their size, and says to open `index.html` through a web server. `wasd_release_game` names the title, the version, the share link, and the link of this version, and says that the share page lists earlier versions and takes comments. Both list notes about the Web build, such as the Compatibility renderer of a Forward+ project, and the export's warnings. Failures carry the reason, such as the signed-out message or Godot's export errors.

#### Token effect

A result is a few hundred characters, plus at most ten notes.

#### KV Cache effect

Append-only in the conversation.

### The Release prompt

#### What the model sees

The Release button sends a user message in the window's language, such as `Release this game on WASD Engine: call wasd_release_game with short release notes about what changed since the last release, then give me the share link.`, or the same request with the user's notes.

#### Token effect

One short user message.

#### KV Cache effect

Append-only, like any user message.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what a release covers; they are current package constraints.

- **Godot only** — the tools export Godot projects; another engine's game needs its own Web build and the site's API.
- **Compatibility renderer** — Web builds render with WebGL 2, so Forward+ and Mobile effects are missing or look different, and the build has no threads and no GDExtensions.
- **One template version** — the Godot plugin pins the Web template of Godot 4.7.2; another runtime version needs its template's archive URL and SHA-256 in that plugin's configuration.
- **Public releases** — every release is public on the site's Explore page; deleting a game takes the site's API.
- **Site per sign-in** — a project releases to the site the app is signed in to; signing in to another site creates another game there.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Every feature of WASD Engine that is neither a game tool nor upstream belongs in this package, so it stays on with the rest. A release calls the site's `GET`, `POST`, and `PATCH /api/v1/games[/<id>]`, `POST /api/v1/games/<id>/releases`, and `PUT /api/v1/games/<id>/cover`.

</details>
