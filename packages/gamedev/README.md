---
description: "The game development package group: headless Blender, GIMP, and SuperCollider for the agent over MCP, Godot games run, tested, and played through LibGodot, Poly Haven's CC0 assets found and downloaded into the project, character voices, sound effects, and music made with ElevenLabs, curated Godot and Blender add-ons installed into a project with usage guides only its Sessions see, the Game tools tabs that list them in Settings and on the Plugins page, the Assets tab that shows the project's art, the MCP server that offers them to other agents on the computer, and the todo continuation that keeps the agent working through its todo list."
kind: "package-group"
---

# Game development tools

English | [中文](README.zh.md)

## Summary

The `gamedev/` group gives the agent the applications a game needs, without a window. Blender, GIMP, and SuperCollider run headless behind MCP servers. Godot runs and tests the Session's game through LibGodot and streams it to the Game tab for the user. Poly Haven supplies CC0 assets, ElevenLabs makes voices, sound effects, and music, and the game add-ons install tested Godot and Blender add-ons. Game tools tabs list the seven, an Assets tab shows the project's art, and an MCP server offers them to other agents. The [game tools subsystem page](../../docs/subsystems/gamedev.md) describes how the pieces connect.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The shared MCP runtime starts and supervises one headless worker per application; the Blender, GIMP, and SuperCollider packages build their tools on it, and the Godot package owns game runs, their tools, and the Game tab. The Poly Haven package searches Poly Haven's library and downloads its assets, the ElevenLabs package makes speech, sound effects, and music through the WASD Engine API, and the game add-ons package installs catalog add-ons into game projects and lists their guides as skills of those projects' Sessions. The Game tools tabs package shows all seven in Settings and on the Plugins page, the Assets tab package shows the project's 2D and 3D art beside the Game tab, and the game MCP package offers their tools to other agents of signed-in users, with its browser half's setup at the end of the Desktop introduction and in Settings. WASD Engine Plugins, which stays on, exports Godot games for the Web and releases them to the WASD Engine site with share links. The todo continuation keeps the agent of the `gamedev` preset working while the todo list it wrote in the current turn has unfinished items.

| Package | What it provides |
|---|---|
| [`app-mcp/`](app-mcp/README.md) | Run an application headless behind an MCP stdio server: copy worker scripts out of the package, supervise one JSON-lines worker, and register the server with the MCP manager; also the Config fields, application search, and tool helpers that the Blender, GIMP, and SuperCollider servers share |
| [`blender/`](blender/README.md) | Blender tools over MCP, backed by the `bpy` module or an installed Blender in background mode; the Desktop app ships `bpy` for macOS on Apple silicon and Windows x64 |
| [`elevenlabs/`](elevenlabs/README.md) | ElevenLabs tools: find voices for characters or clone the user's own with consent, and save speech by Eleven v4 Turbo, sound effects by SFX v3, and music by Music v2.5 into the game project, made by the WASD Engine API and charged to the signed-in account's plan |
| [`game-mcp/`](game-mcp/README.md) | WASD Engine's MCP server for other agents on the computer: the game tools over loopback Streamable HTTP with a token, their search, the Sessions that connected agents' games run in, and the setup prompt |
| [`gimp/`](gimp/README.md) | GIMP 3 tools over MCP, backed by `gimp-console` |
| [`godot/`](godot/README.md) | Godot game runs through LibGodot: `godot_*` tools, the `godot` Remote, the frame route, and the Game tab |
| [`game-addons/`](game-addons/README.md) | Game add-ons: a curated catalog of Godot and Blender add-ons pinned to tested versions, the system prompt section that lists it, the `game_addons` tool that searches it and installs or removes one in the game project when the agent decides that the game needs it, usage guides that only that project's Sessions see as skills, and the Add-ons dialog in Session headers |
| [`polyhaven/`](polyhaven/README.md) | Poly Haven tools: search Poly Haven's library of CC0 HDRIs, textures, and 3D models, show an asset's files and preview image, and download one format and resolution into the game project, with every file's digest checked |
| [`supercollider/`](supercollider/README.md) | SuperCollider tools over MCP: sound and music rendered offline with scsynth from sclang code, with levels, loudness, and a waveform and spectrogram image for the agent; the Desktop app ships SuperCollider without its GUI |
| [`todo-continuation/`](todo-continuation/README.md) | Todo continuation: when the model ends a turn with a reply while the todo list it wrote in that turn has pending or in-progress items, one reminder naming them continues the turn, at most once per distinct list and up to a configured cap per turn |
| [`ui-game-assets/`](ui-game-assets/README.md) | The right sidebar's Assets tab: the game project's images and models in a dropdown sorted into its folders, with search and an All / 2D / 3D filter, a zoomable image view, a three.js model view with animations, and Blender files shown through their exported models |
| [`ui-game-mcp/`](ui-game-mcp/README.md) | The MCP server's browser half: Set up with another agent after sign-in, as the Desktop introduction's last step and the Other agents section of Settings, with the agents' logos, the setup prompt, and whether an agent connected, and the window opening the Session whose game a connected agent starts |
| [`ui-game-tools/`](ui-game-tools/README.md) | The Game tools tabs of Settings › Built-in plugins and the Plugins page: Blender, ElevenLabs, the game add-ons, GIMP, Godot, Poly Haven, and SuperCollider with their logos and Loader state, and on the Plugins page a switch for each that turns its row off or on in the profile patch |
| [`wasd-plugins/`](wasd-plugins/README.md) | WASD Engine Plugins, WASD Engine's own always-on features: the Web export and release tools of every Session and of the MCP server, which publish Godot games to the WASD Engine site as numbered versions with share links, in the Desktop app the agent's `browser_*` tools, which search and browse in the right sidebar's Browser, the Release button in the Session header and on the New Session screen, and Explore Games in the sidebar |

-----

<a id="related-documentation"></a>
## Related documentation

- [Game tools subsystem reference](../../docs/subsystems/gamedev.md): the process model, the worker protocol, the SuperCollider bridge, the LibGodot runtime, the Game tab, the Game tools tabs, and the MCP server for other agents.
- [MCP package group](../mcp/README.md): the manager that runs the Blender and GIMP servers.
- [Right sidebar](../client/ui-sidebar-right/README.md): the docking surface that holds the Game tab.
- [Plugins page](../client/ui-plugin-manager/README.md) and [Built-in plugins settings](../client/ui-settings-plugins/README.md): the two pages that hold the Game tools tabs.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
