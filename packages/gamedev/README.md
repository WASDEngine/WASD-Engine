---
description: "The game development package group: headless Blender, GIMP, and SuperCollider for the agent over MCP, Godot games run, tested, and played through LibGodot, and the Game tools tabs that list them in Settings and on the Plugins page."
kind: "package-group"
---

# Game development tools

English | [中文](README.zh.md)

## Summary

The `gamedev/` group gives the agent the applications a game needs, all without a window. Blender, GIMP, and SuperCollider each reach the agent as an MCP server whose worker runs the application headless; Godot runs the Session's game through LibGodot, returns screenshots, logs, and errors to the agent, takes its input, and streams the game to the Game tab, where the user plays it. Game tools tabs in Settings and on the Plugins page list the four with their logos. The [game tools subsystem page](../../docs/subsystems/gamedev.md) describes how the pieces connect; package READMEs own configuration and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The shared MCP runtime starts and supervises one headless worker per application; the Blender, GIMP, and SuperCollider packages build their tools on it, and the Godot package owns game runs, their tools, and the Game tab. The Game tools tabs package shows all four in Settings and on the Plugins page.

| Package | What it provides |
|---|---|
| [`app-mcp/`](app-mcp/README.md) | Run an application headless behind an MCP stdio server: copy worker scripts out of the package, supervise one JSON-lines worker, and register the server with the MCP manager; also the Config fields, application search, and tool helpers that the Blender, GIMP, and SuperCollider servers share |
| [`blender/`](blender/README.md) | Blender tools over MCP, backed by the `bpy` module or an installed Blender in background mode |
| [`gimp/`](gimp/README.md) | GIMP 3 tools over MCP, backed by `gimp-console` |
| [`godot/`](godot/README.md) | Godot game runs through LibGodot: `godot_*` tools, the `godot` Remote, the frame route, and the Game tab |
| [`supercollider/`](supercollider/README.md) | SuperCollider tools over MCP: sound and music rendered offline with scsynth from sclang code, with levels, loudness, and a waveform and spectrogram image for the agent; the Desktop app ships SuperCollider without its GUI |
| [`ui-game-tools/`](ui-game-tools/README.md) | The Game tools tabs of Settings › Built-in plugins and the Plugins page: Blender, GIMP, Godot, and SuperCollider with their logos and Loader state, and on the Plugins page a switch for each that turns its row off or on in the profile patch |

-----

<a id="related-documentation"></a>
## Related documentation

- [Game tools subsystem reference](../../docs/subsystems/gamedev.md): the process model, the worker protocol, the SuperCollider bridge, the LibGodot runtime, the Game tab, and the Game tools tabs.
- [MCP package group](../mcp/README.md): the manager that runs the Blender and GIMP servers.
- [Right sidebar](../client/ui-sidebar-right/README.md): the docking surface that holds the Game tab.
- [Plugins page](../client/ui-plugin-manager/README.md) and [Built-in plugins settings](../client/ui-settings-plugins/README.md): the two pages that hold the Game tools tabs.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
