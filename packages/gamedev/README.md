---
description: "The game development package group: headless Blender and GIMP for the agent over MCP, Godot games run, tested, and played through LibGodot, the Game tools tabs that list them in Settings and on the Plugins page, and the MCP server that offers them to other agents on the computer."
kind: "package-group"
---

# Game development tools

English | [中文](README.zh.md)

## Summary

The `gamedev/` group gives the agent the applications a game needs, all without a window. Blender and GIMP each reach the agent as an MCP server whose worker runs the application headless; Godot runs the Session's game through LibGodot, returns screenshots, logs, and errors to the agent, takes its input, and streams the game to the Game tab, where the user plays it. Game tools tabs in Settings and on the Plugins page list the three; an MCP server offers them to other agents. The [game tools subsystem page](../../docs/subsystems/gamedev.md) describes how the pieces connect; package READMEs own configuration and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The shared MCP runtime starts and supervises one headless worker per application; the Blender and GIMP packages build their tools on it, and the Godot package owns game runs, their tools, and the Game tab. The Game tools tabs package shows all three in Settings and on the Plugins page, and the game MCP package offers their tools to other agents, with a setup panel in the sign-in dialog from its browser half.

| Package | What it provides |
|---|---|
| [`app-mcp/`](app-mcp/README.md) | Run an application headless behind an MCP stdio server: copy worker scripts out of the package, supervise one JSON-lines worker, and register the server with the MCP manager; also the Config fields, application search, and tool helpers that the Blender and GIMP servers share |
| [`blender/`](blender/README.md) | Blender tools over MCP, backed by the `bpy` module or an installed Blender in background mode |
| [`game-mcp/`](game-mcp/README.md) | WASD Engine's MCP server for other agents on the computer: the game tools over loopback Streamable HTTP with a token, their search, the Sessions that connected agents' games run in, and the setup prompt |
| [`gimp/`](gimp/README.md) | GIMP 3 tools over MCP, backed by `gimp-console` |
| [`godot/`](godot/README.md) | Godot game runs through LibGodot: `godot_*` tools, the `godot` Remote, the frame route, and the Game tab |
| [`ui-game-mcp/`](ui-game-mcp/README.md) | The MCP server's browser half: Set up with another agent in the sign-in dialog, with the setup prompt and whether an agent connected, and the window opening the Session whose game a connected agent starts |
| [`ui-game-tools/`](ui-game-tools/README.md) | The Game tools tabs of Settings › Built-in plugins and the Plugins page: Blender, GIMP, and Godot with their logos and Loader state, and on the Plugins page a switch for each that turns its row off or on in the profile patch |

-----

<a id="related-documentation"></a>
## Related documentation

- [Game tools subsystem reference](../../docs/subsystems/gamedev.md): the process model, the worker protocol, the LibGodot runtime, the Game tab, the Game tools tabs, and the MCP server for other agents.
- [MCP package group](../mcp/README.md): the manager that runs the Blender and GIMP servers.
- [Right sidebar](../client/ui-sidebar-right/README.md): the docking surface that holds the Game tab.
- [Plugins page](../client/ui-plugin-manager/README.md) and [Built-in plugins settings](../client/ui-settings-plugins/README.md): the two pages that hold the Game tools tabs.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
