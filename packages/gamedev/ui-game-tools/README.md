---
description: "Game tools tabs of the WASD Engine Web UI, in Settings › Built-in plugins and on the Plugins page, for maintainers changing how Blender, GIMP, Godot, and SuperCollider appear there with their logos and Loader state, or debugging the switch that turns a tool off or on in the profile patch."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-game-tools

English | [中文](README.zh.md)

## Summary

See and switch the agent's game tools where plugins are listed. Settings › Built-in plugins opens on a Game tools tab that lists Blender, GIMP, Godot, and SuperCollider with their logos and whether each one runs. The Plugins page has a Game tools tab with the same cards and a switch for each tool, which turns it off or on in the profile. Neither tab shows whether a tool's application is installed; the tools' own results report setup problems.

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

Open **Settings** › **Built-in plugins** to see the game tools; the section starts on the **Game tools** tab. To turn a tool off or on, open **Plugins** in the sidebar and select **Game tools**. Both tabs list Blender, GIMP, Godot, and SuperCollider in that order and mark a tool that the profile does not mount.

### Default composition

The fork patch file [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts this row after the three tool rows into every Web and Desktop profile:

```yaml
- id: ui-game-tools
  name: '@deepseek-ai/dsh-client-ui-game-tools'
```

The row takes no configuration, and its Host half does nothing: the row exists so that the Host serves the browser half. The browser half needs the `pluginInventory` Remote. Its Settings tab appears in the Built-in plugins section of [`ui-settings-plugins`](../../client/ui-settings-plugins/README.md); its Plugins page tab registers once the `pluginManager` Remote exists and appears on the page of [`ui-plugin-manager`](../../client/ui-plugin-manager/README.md). A profile patch entry `- id: ui-game-tools` with `disabled: true` removes both tabs and leaves the tools running.

### Reading a card

Each card shows the tool's logo, its title and description in the current language, and its state. The logo is the package's `icon.svg`, which the Host sends with the package metadata; a package without an icon, or an icon that fails to decode, shows the default plugin artwork. An enabled tool carries no tag. **Off** marks a tool whose row is disabled, **Failed** a tool whose start failed, and **Not in this profile** a tool that no row of the profile mounts; the Host's startup diagnostic shows below the description. A dot beside the title marks a tool that waits for its dependencies, loads, or unloads, and a note shows a package metadata error.

### The switch

On the Plugins page tab, each tool that the profile mounts has a switch while the Host manages the profile. The switch calls `pluginManager.setPluginEnabled` with the tool's Loader entry, and the [plugin manager](../../boot/plugin-manager/README.md#use-this-package) records the change in the profile patch and applies it: turning a tool off sets `disabled: true` on the row's entry there, adding `- id: <row>` when the patch has none, and turning it on removes an entry that holds nothing else, or sets `disabled: false`. While the change runs, the switch is disabled with a progress dot beside it, and screen readers hear which tool changes; a switch that had the focus gets it back when the change ends. A change that applies shows nothing more; a change that waits for a restart, one that a higher-priority patch overrides, and one that fails each show a toast that names the tool and the reason, and the toast stays until it fades, even after the person leaves the tab or the Plugins page. A row that the profile patch cannot address uniquely, or that plugin management needs, shows a disabled switch with the reason as its hover text. A Host that manages no profile shows the cards without switches and a line that says why.

### Reading again and failures

The Settings tab reads the plugin inventory each time it mounts. The Plugins page tab also reads each time it mounts, and again after each switch change, each change that the plugin manager announces, and each reconnection, so a change made elsewhere on the Plugins page or in another client shows there too; during a later read it keeps the cards of the last one. Both tabs show placeholder cards until the first read answers. A failed first read shows a message with **Retry**, and a Peer without owner access, such as a LiveShare viewer, reads that only the owner can see the game tools. A failed later read on the Plugins page keeps the cards and offers **Retry** below them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package adds two tabs through the extension points of their pages, without changing either page. Its browser plugin registers the Settings tab into `settings.plugins.tab` with id `game-tools` and order 5, before the inventory's Plugin list at order 10, and, in a scope that waits for `remote.pluginManager`, the Plugins page tab into `plugins.tab` with the same id and order −10, after Installed and before Discover, together with the `shell.overlay` entry `game-tools.toast`, which shows the switch toasts outside the tab. Every registration uses `ctx.slots.inject()`, so it follows late slot declaration and teardown; the package imports only types from other plugins.

No Remote call runs while the plugin activates. The Settings tab calls `pluginInventory.list()` from its mount effect. The Plugins page tab's controller reads `pluginInventory.list()` for `managementAvailable` and then `pluginManager.listPlugins()`, whose rows carry either a `patchId` or a `readOnlyReason`. It keeps the tab state in a snapshot store, which the tab and the toast read, numbers its reads so that only the newest answer lands, and turns each `ChangeResult` of a switch into a notice; a write that applies leaves another tool's notice in place. Both tabs pick the tools by package name from `GAME_TOOL_MODULES`, which the web-app overlay drift spec compares with the overlay's tool rows.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Empty Host `apply` of the Loader row |
| [`src/client/index.ts`](src/client/index.ts) | Dictionaries, the two tab registrations, and the toast registration |
| [`src/client/tools.ts`](src/client/tools.ts) | `GAME_TOOL_MODULES`, the entry lookup, and the read failure classes |
| [`src/client/controller.ts`](src/client/controller.ts) | Plugins page tab reads, switch writes, and notices |
| [`src/client/presentation.ts`](src/client/presentation.ts) | Lock reasons and notice sentences |
| [`src/client/GameToolsNoticeToast.tsx`](src/client/GameToolsNoticeToast.tsx) | The `shell.overlay` toast of the notices |
| [`src/client/GameToolCard.tsx`](src/client/GameToolCard.tsx) | Cards, placeholders, and the read failure notice that both tabs share |
| [`src/client/SettingsGameToolsTab.tsx`](src/client/SettingsGameToolsTab.tsx), [`src/client/PluginsGameToolsTab.tsx`](src/client/PluginsGameToolsTab.tsx) | The two tabs |
| [`src/client/locales.ts`](src/client/locales.ts) | `gameTools` dictionaries in eight languages |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the tool rows, the two pages that hold the tabs, and the Host services the tabs read.

- [Game tools subsystem page](../../../docs/subsystems/gamedev.md#game-tools-tabs) — how the tabs relate to the tool rows and their logos.
- [ui-settings-plugins](../../client/ui-settings-plugins/README.md) — the Built-in plugins section that holds the Settings tab.
- [ui-plugin-manager](../../client/ui-plugin-manager/README.md) — the Plugins page and its `plugins.tab` slot.
- [plugin-manager](../../boot/plugin-manager/README.md) — the Host operations behind the switch.
- [plugin-inventory](../../host/plugin-inventory/README.md) — the Host's read-only Loader projection that both tabs read.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side view and switch of the game tool rows that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the tabs show and when; they are current package constraints.

- **Three fixed tools** — the tabs list the packages in `GAME_TOOL_MODULES`; a tool row added to the overlay appears in the tabs only after its package joins that list, and the overlay drift spec fails until both agree.
- **Loader state only** — a card shows whether its row is enabled, loading, or failed, not whether the tool's application is set up, such as Blender's `bpy` environment, an installed GIMP 3, the LibGodot runtime, or SuperCollider; the tools' results and the Game tab report those.
- **One Settings read per mount or retry** — the Settings tab does not follow later changes while it stays mounted; reopening Settings reads again.
- **Unannounced profile edits** — the plugin manager announces no change for a hand edit of the profile patch, which HMR applies, so the Plugins page tab shows it only when the tab mounts again; the tab has no Refresh control, and the page hides its own while a contributed tab is open.
- **No logos in the Plugin list** — the Plugin list tab of Built-in plugins still shows the three tools without logos, among the global plugins, which start folded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
