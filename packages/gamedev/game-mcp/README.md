---
description: "Serve WASD Engine's game tools to other agents on the same computer, such as Claude Code or Codex: the loopback Streamable HTTP endpoint and its token, the provider registry that the game tool plugins and WASD Engine Plugins fill, the search and call tools, the Sessions that connected agents' games run in, the gameMcp Remote and the game-mcp/reveal event, the setup prompt that the Desktop introduction and Settings show, and the refusal of tool calls while WASD Engine is signed out."
kind: "package-reference"
---

# @deepseek-ai/dsh-game-mcp

English | [中文](README.zh.md)

## Summary

Let Claude Code, Codex, and other agents on this computer use WASD Engine's game tools through MCP. The Host plugin listens on `http://127.0.0.1:9273/mcp`, requires the token in its data folder and a signed-in WASD Engine, and offers the `godot_*`, `blender_*`, `gimp_*`, and `supercollider_*` tools that game tool plugins contribute, with `search_game_tools` and `call_game_tool`. A connected agent's Godot game runs in a Session of its own, so it plays in the WASD Engine window's Game tab. [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.md) shows the setup prompt after sign-in.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `game-mcp` into every Web and Desktop profile, after the game tool rows:

```yaml
- id: game-mcp
  name: '@deepseek-ai/dsh-game-mcp'
  config:
    dataRoot: !!js dshHomePath('game-mcp')
```

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | Required | Absolute folder of the access token (`token`) and of the connected agents' Session bindings (`sessions.json`); a relative path fails the plugin load |
| `port` | `9273` | Loopback port of the endpoint, a whole number from 0 to 65,535; 0 picks a free port. While another program holds it, the server listens on a free port until the Host restarts and says so in its view |

A profile patch turns the server off with `- id: game-mcp` and `disabled: true`.

### Set up another agent

Set up with another agent, which [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.md) adds as the last step of the Desktop introduction and as the Other agents section of Settings, shows the setup prompt of the server's view with the server's state and the agents seen since the Host started.

The prompt, which [`src/prompt.ts`](src/prompt.ts) writes, names the server `wasd-engine`, the URL, and the header `Authorization: Bearer <token>`, and gives the setup for Claude Code and Codex:

```text
claude mcp add-json wasd-engine '{"type":"http","url":"http://127.0.0.1:9273/mcp","headers":{"Authorization":"Bearer <token>"}}' --scope user
```

```toml
[mcp_servers.wasd-engine]
url = "http://127.0.0.1:9273/mcp"
http_headers = { "Authorization" = "Bearer <token>" }
```

The token is 32 random bytes in base64url, created on first start in `<dataRoot>/token` with mode 0600, so agents set up once keep working across restarts. Deleting the file makes the next start create another token, after which every agent needs the new prompt.

### What connected agents get

| Tool | From | What it does |
|---|---|---|
| `search_game_tools` | This package | Lists the plugins with their readiness and tool counts, and the tools: every tool's first sentence without a query, or the best matches with their parameters for a query; `plugin` limits the search |
| `call_game_tool` | This package | Calls a tool by `name` with `arguments`, for an agent whose tool list lacks it |
| `godot_*` | [`@deepseek-ai/dsh-godot`](../godot/README.md) | The Session's twelve Godot tools, each with an absolute `project` parameter |
| `blender_*` | [`@deepseek-ai/dsh-blender`](../blender/README.md) through [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.md) | The `wasd_blender` server's tools, renamed from `mcp__wasd_blender__<tool>` |
| `gimp_*` | [`@deepseek-ai/dsh-gimp`](../gimp/README.md) through [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.md) | The `wasd_gimp` server's tools, renamed from `mcp__wasd_gimp__<tool>` |
| `supercollider_*` | [`@deepseek-ai/dsh-supercollider`](../supercollider/README.md) through [`@deepseek-ai/dsh-app-mcp`](../app-mcp/README.md) | The `wasd_supercollider` server's tools, renamed from `mcp__wasd_supercollider__<tool>` |

Every user signs in to WASD Engine: while the account plugin, `@deepseek-ai/dsh-deepseek-account`, reports no stored sign-in or cannot read it, the server answers every tool call, `search_game_tools` and `call_game_tool` included, with an error result that asks the user to sign in, and still lists its tools. It reads the sign-in at each call, so the tools work again as soon as the user signs in. A Host without the account plugin runs every call.

The server's instructions introduce each plugin and append the plugin's own instructions under its title. Connected agents share one Blender, one GIMP, and one SuperCollider worker among themselves, apart from the workers of WASD Engine's own Sessions ([one worker per Session](../app-mcp/README.md#one-worker-per-session)), and the instructions of those plugins say so.

### Games in the WASD Engine window

A Godot call names its project by absolute path: the folder that holds `project.godot`, a folder up to three levels above it, or the `project.godot` file; without `project`, the call uses the agent's previous project. The server resolves the Session that runs the agent's games in that project: the registered game project that contains the folder, or a new registration of the folder itself, holds one Session per agent, created on first use and remembered in `<dataRoot>/sessions.json`, so the agent keeps its Session and its game across restarts. A Session that left its game project, was archived, or no longer exists is replaced by a new one. `godot_run` emits `game-mcp/reveal` with the Session, the window opens the Session through [`@deepseek-ai/dsh-client-ui-game-mcp`](../ui-game-mcp/README.md), and the Game tab opens for the run, as it does for any run an agent starts.

### Provide tools

`ctx.gameMcp.provide(provider)` offers a plugin's tools for the calling plugin's lifetime and returns an idempotent disposer. A provider has a lowercase `id`, which prefixes its tool names, a `title`, a one-sentence `description`, optional `instructions`, `tools()`, and `status(signal)`, which reports `ready`, `starting`, or `unavailable` with a message. Each tool names a harness `ToolDefinition` that runs the calls and may override its description and input schema, mark itself read-only, `prepare` a call (map its arguments and choose the Agent it runs as, through `call.session(directory)`), and turn the value into MCP `content`; without `content` the server sends the text blocks of `output.render`. A prepared call may `reveal` a Session. The server lists a tool only when its name starts with the provider id and an underscore and no earlier tool has it, and it turns a failure of preparation, argument validation, or execution into an error result with the error's message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The listener binds `127.0.0.1` only. Each request must name the endpoint path, pass the MCP SDK's localhost Host and Origin checks, which stop DNS rebinding and cross-site requests from browser pages, and carry the token, which a constant-time comparison checks; other requests get 404, 403, or 401. POST bodies are read within 4 MiB. The MCP SDK's `createMcpHandler` serves the 2026-07-28 protocol revision and, statelessly, the 2025 revisions, from one low-level MCP server per request, whose tool list and instructions come from the catalog at that moment; tool list changes reach agents that subscribed through `subscriptions/listen`.

Stateless serving keeps no connection, so the server names each request's agent itself: from the client information of a 2026-07-28 request envelope, from the client information of an earlier `initialize` request with the same User-Agent, from the User-Agent's product, or as a generic agent. The agent's name titles nothing in the Session list; the setup panel shows the agents seen since the Host started.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `GameMcpServer`: Config, the provider registry, the listener lifecycle, the request checks, and the `gameMcp.watch` stream |
| [`src/http.ts`](src/http.ts) | Loopback listener and the conversion between Node requests and web-standard requests and responses |
| [`src/server.ts`](src/server.ts) | The MCP handler and the `tools/list` and `tools/call` handlers |
| [`src/catalog.ts`](src/catalog.ts) | Tool collection, listing, search, instructions, and running one call |
| [`src/clients.ts`](src/clients.ts) | Agent identities and the agents seen |
| [`src/sessions.ts`](src/sessions.ts) | The connected agents' Sessions and `sessions.json` |
| [`src/token.ts`](src/token.ts), [`src/prompt.ts`](src/prompt.ts) | The token file and check, and the setup prompt |
| [`src/provider.ts`](src/provider.ts), [`src/types.ts`](src/types.ts) | The provider contract, the browser-safe view types, and the `game-mcp/reveal` event |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the tools the server offers, the setup and the account features that host it, and the protocol.

- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#mcp-server-for-other-agents) — how the server connects the game tools, the Sessions, and the window.
- [Godot package](../godot/README.md) — the Godot tools and the Game tab.
- [app-mcp](../app-mcp/README.md) — the Blender, GIMP, and SuperCollider servers whose tools the server forwards.
- [ui-game-mcp](../ui-game-mcp/README.md) — Set up with another agent and the window's opening of connected agents' Sessions.
- [ui-settings-account](../../client/ui-settings-account/README.md) — the required sign-in and the Desktop introduction's last step.
- [Model Context Protocol](https://modelcontextprotocol.io) — the protocol and its Streamable HTTP transport.

-----

<a id="model-experience"></a>
## Model Experience

### The Session's own agent

#### What the model sees

Nothing: the package registers no tool and no system-prompt text in the harness.

#### Token effect

Zero direct tokens.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

### Connected agents' tool list and instructions

#### What the model sees

A connected agent's model sees `search_game_tools`, `call_game_tool`, and every provider tool with the description and input schema that [`src/catalog.ts`](src/catalog.ts) lists, which for the Godot tools are the Session's own tool descriptions with the wording for absolute project paths, and the server instructions: one paragraph that introduces each plugin, then each plugin's instructions under `## <title>`. The agent's own harness decides how it presents them.

#### Token effect

With all nine providers of the Web and Desktop profiles, Godot, Blender, GIMP, SuperCollider, Poly Haven, ElevenLabs, the audio tools, the game add-ons, and WASD Engine Plugins, the instructions come to about 24,000 characters, about 6,500 of them the game add-ons catalog, and the 67 tool declarations to about 66,200 characters of JSON; the agent's harness decides how much of them enters its requests.

#### KV Cache effect

The list and the instructions are identical while the providers and their tools stay the same; a provider whose tools appear later, such as Blender after its MCP server started, changes the list, and agents that subscribed hear of the change.

### Connected agents' tool results

#### What the model sees

A provider tool's result is its rendered text and, for Godot screenshots, Poly Haven previews, the audio review's waveform and spectrogram picture, and the images that the Blender, GIMP, and SuperCollider servers send, its images. A failure becomes an error result with the error's message, such as `Pass project: the absolute path of the folder that holds project.godot.`. `search_game_tools` returns the plugin lines and the tool list as text. While WASD Engine is signed out, every call returns the error result `WASD Engine is signed out, and its game tools need a signed-in user. Ask the user to open WASD Engine and sign in, then call the tool again.`

#### Token effect

Text beyond 100,000 characters is cut with `[output truncated: <n> more characters]`; Godot screenshots are PNG images whose longest edge is at most 1,568 pixels and whose area is at most 1,150,000 pixels unless the call asks for less.

#### KV Cache effect

Append-only in the agent's conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the server serves and to whom; they are current package constraints.

- **Local agents only** — the endpoint binds loopback, so an agent on another computer cannot reach it, and agents in sandboxes without loopback network access cannot either.
- **Full trust** — a holder of the token can run Python in Blender and GIMP and sclang code in SuperCollider, evaluate expressions in games, and run games, with the user's permissions and without approval in WASD Engine; agents ask for approval under their own rules. The prompt carries the token, so the user should paste it only into agents on this computer.
- **One port** — a second Host, such as `dsh web` beside the Desktop app, finds the port taken and listens on a free one, whose URL only the setup of that Host shows.
- **Blank Sessions** — a connected agent's Session has no turns, so the Session list names it New Session, New Session in its game project opens it, and while no provider is signed in, the Get started dialog opens over it when the window shows it.
- **No transcript** — the connected agent's tool calls appear in its own harness, not in the Session; the Session shows its game in the Game tab.
- **Stateless serving** — two instances of the same agent share its Session, its project default, and its game per project.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Godot provider builds its tool definitions with the same `godotToolDefinitions` as the Session's own tools, so a change to a Godot tool reaches connected agents without a change here.

</details>
