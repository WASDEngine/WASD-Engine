---
description: "Game add-ons for the agent: a curated catalog of Godot and Blender add-ons pinned to tested versions, the game_addons tool that installs one into a game project, usage guides that only that project's Sessions see as skills, and the Add-ons dialog in Session headers."
kind: "package-reference"
---

# @deepseek-ai/dsh-game-addons

English | [中文](README.zh.md)

## Summary

The game add-ons plugin offers the agent third-party Godot and Blender add-ons that WASD Engine tested with its own Godot 4.7.2 and Blender 5.2.3, without crowding the model's context. The model sees one fixed `game_addons` tool: it searches the catalog for what a game needs, reads an add-on's usage guide, and installs the add-on into the game project after the user approves. Only then does the guide appear as a skill, and only in that project's Sessions. Users install and remove add-ons in the Session header's Add-ons dialog, and agents connected through WASD Engine's MCP server get the same tool.

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

The WASDEngine overlay [`game-tools.cordis.patch.yml`](../../bundle/web-app/wasdengine/game-tools.cordis.patch.yml) inserts the row `game-addons` into every Web and Desktop profile, and sets the `blender` row's `addonStore` to the same store:

```yaml
- id: game-addons
  name: '@deepseek-ai/dsh-game-addons'
  config:
    catalogDir: !!js <the dsh-web-app package folder>/wasdengine/addons
    dataRoot: !!js dshHomePath('game-addons')
    blenderStore: !!js dshHomePath('game-addons', 'blender')
```

The Game tools tabs list the row with its icon, and the Plugins page's switch turns it off with `- id: game-addons` and `disabled: true` in the profile patch. The plugin needs the `tools`, `workingDirectory`, `skills`, and `typert` services. It imports a project after an installation through the `godot` service of [`@deepseek-ai/dsh-godot`](../godot/README.md) when that service runs. It asks before a change through the `approval` service, and offers its tool to connected agents through the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md).

| Field | Default | Meaning |
|---|---|---|
| `catalogDir` | required | Absolute catalog folder: one folder per add-on with `addon.json` and `SKILL.md` |
| `dataRoot` | required | Absolute folder of the plugin's data: downloaded archives stay in `archives/<sha256>.zip`, and Blender add-ons' asset packs unpack into `blender-assets/<id>/` |
| `blenderStore` | required | Absolute folder of the Blender add-on store, which the `blender` row's `addonStore` names too |
| `downloadTimeoutMs` | `600000` | Time limit of one archive download, including its body |

The plugin loads and checks the whole catalog when it starts, so an invalid entry, a guide whose name differs from its id, or a conflict that names no other entry stops the plugin.

### The catalog

Each entry pins one release: its archive URL, SHA-256, and size, the folder inside the archive to install, its SPDX license, copyright line, and any credit the license requires. It also records the application it extends, when to use it and when Godot or Blender alone is enough, search tags, the development stages at which it helps (`prototype`, `content`, `polish`, `ship`), the add-ons it conflicts with, and the runtime versions it was verified with. A Godot entry names its folder under `res://addons/`, its editor plugin, and the autoloads and project settings that its `_enable_plugin()` adds, because the installer cannot click the editor's plugin switch. A Blender entry names its Python module and whether it is an extension downloaded from its archive or an add-on that ships inside Blender. It may also pin an asset pack (`assets`: URL, SHA-256, size, folder, SPDX license, and page) and name a setup script (`blender.setup`) in its catalog folder, whose `setup(module, assets)` the Blender worker calls after it enables the add-on; MPFB's script points MPFB at MakeHuman's CC0 system assets. The shipped catalog lists only GDScript Godot add-ons, so Web releases keep working, and Blender add-ons whose operators run without a window. Each entry has a smoke test in [`tests/smoke/`](tests/smoke/) that the end-to-end suite runs.

### The tool

| Action | What it does |
|---|---|
| `search` | Ranks catalog add-ons for `query`, or lists all of them, optionally only for `host` (`godot` or `blender`) or `stage`. Each one shows its id, version, license, download size, summary, when to use it, when to skip it, what it conflicts with, any required credit, and whether the project has it |
| `guide` | Returns an add-on's usage guide, noting when the project does not have the add-on yet |
| `install` | Installs `id` into the project; `replace` replaces a copy already in `addons/` without a WASD Engine record |
| `remove` | Removes `id` from the project and names the project files that still use it |
| `list` | Lists the project's catalog add-ons |

`project` names the folder that holds `project.godot`, relative to the working directory; without it, the nearest project is used, as the Godot tools find it. A Godot installation runs these steps:

1. Download the pinned archive into the cache unless it is there, checking its size and SHA-256.
2. Unpack the add-on's folder into a staging folder under `.wasdengine/`, adding the license file when it lies outside that folder in the archive.
3. Move the folder into `res://addons/<folder>/`.
4. Enable the editor plugin and add its autoloads and settings to `project.godot`, keeping every other line.
5. Add a marked section with the license text to `THIRD_PARTY_NOTICES.md`.
6. Record the add-on in `.wasdengine/addons.json`.
7. Import the project once, or twice for add-ons whose formats import fully only on the second pass, and report the import's errors.

A failure before the record is written puts the previous folder and `project.godot` back. Installing an add-on whose conflict is already in the project, or one whose autoload name another script holds, fails with what to do. Installing the same version again downloads nothing and only rewrites `project.godot` entries that were lost. A Blender installation unpacks the extension once into the store, as `<blenderStore>/<module>/`, and its asset pack once into `<dataRoot>/blender-assets/<id>/`, each with a marker that names its archive. Their archives then leave the cache, since the store keeps their files for every project. It writes the store's index, which gives each Blender add-on's module, setup script, and asset folder, and records the add-on in the project. An add-on that ships inside Blender is only recorded. Unpacking reads an archive's central directory and streams one file at a time, so memory stays bounded for MPFB's 268 MB pack too.

A removal deletes what the record lists and removes the add-on's `project.godot` entries and notice. It names up to 20 scenes, scripts, and resources that still refer to the add-on's folder or its autoloads, so the agent can change them. A catalog add-on found in `addons/` without a record can be removed the same way. A Blender add-on leaves only the project's record; the store keeps it for other projects.

### Approval

The tool asks the user before `install` and `remove` under the Session's `ask` approval policy, through the same approval prompt as shell commands. The question names the add-on, its version, license, and project page, the download size and host, any asset pack with its license, page, size, and host, and the project. It says that the add-on's scripts become part of the game, and names any credit the license requires. Under the `never` policy, which full access sets, it proceeds without asking. `search`, `guide`, and `list` never ask. A user's click in the Add-ons dialog is the approval for that change. A connected agent's own harness decides whether to ask its user.

### Guides as skills

The plugin registers the skill provider `game-addons`. For a Session's working directory it finds the game project as the Godot tools do, and lists the guide of each catalog add-on the project has installed or holds in its `addons` folder. The guide's skill name is the add-on id. Its rank, 550, lets project, custom, and user skills of the same name win over it, while bundled skills lose to it. A guide of a copy whose `plugin.cfg` names another version says so in its description. The provider watches the project's `addons` and `.wasdengine` folders, so an add-on installed or removed outside the tool, for example by Git, changes the list the next model step sees.

### Blender add-ons

The `blender` row's `addonStore` reaches each Blender worker as `WASD_ADDON_STORE`. In a worker, `import wasd_addons; wasd_addons.enable("<id>")` enables a store extension through an extensions repository named `wasd`, as `bl_ext.wasd.<module>`, or an add-on that ships inside Blender, such as Rigify, and runs the entry's setup script; `wasd_addons.assets("<id>")` returns the folder of its asset pack. Factory settings, which `new_scene` and executed code can load, disable every add-on and reset their preferences, so the worker enables the add-ons it had enabled again and runs their setup scripts again. Each guide of a Blender add-on starts with that call.

### The Add-ons dialog

The browser half registers an Add-ons button after the Release button of each Session header in a Workspace. Its dialog lists the catalog's Godot and Blender add-ons with their icon, version, license, size, asset pack, summary, use, required credit, and whether the Session's project has them. Each icon is an `icon.png` or `icon.svg` of at most 16 KiB in the entry's catalog folder, which the entry's `icon` names with its source URL, license, and copyright line; `ICONS.md` beside the catalog's folders lists them all with the license texts. The catalog reads each icon once as a data URL, refusing an SVG with scripts or external references, and the `project` Remote returns the icons beside the views, so tool results never carry them. An add-on without an icon shows a tile with its title's first letter. It installs one at a click and removes one after a confirmation, through the `gameAddons` Remote's `project`, `installAddon`, and `removeAddon` methods, which take the Workspace folder. LiveShare classifies the three endpoints as owner-only.

<a id="plugin-icon"></a>
### Plugin icon

The Game tools tabs show the package's [`icon.svg`](icon.svg): a WASD Engine keycap in the palette of the WASD Engine Plugins mark, with a plus. It awaits designer review.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config, catalog loading, tool, approval, skill provider, and game MCP registration, and the `gameAddons` Remote |
| [`src/catalog.ts`](src/catalog.ts) | Entry validation, guide frontmatter, and search ranking |
| [`src/manager.ts`](src/manager.ts) | Presence in a project, installation, removal, references, and the Blender store |
| [`src/archive.ts`](src/archive.ts) | Pinned downloads into the cache, and unpacking one archive folder file by file with yauzl |
| [`src/project-file.ts`](src/project-file.ts) | `project.godot` edits that keep every other line |
| [`src/record.ts`](src/record.ts) | `.wasdengine/addons.json` under its file lock |
| [`src/notices.ts`](src/notices.ts) | Marked sections of `THIRD_PARTY_NOTICES.md` |
| [`src/skills.ts`](src/skills.ts) | The guides' skill provider and the folder watcher |
| [`src/tools.ts`](src/tools.ts) | The `game_addons` definition, its result text, and the approval question |
| [`src/mcp.ts`](src/mcp.ts) | The tool for connected agents and the provider's instructions |
| [`src/client/`](src/client/) | The Add-ons button and dialog |

Search scores each query word by the best field one of whose words it starts: 3 for the id or title, 2 for a tag, and 1 for the summary or use. Common words do not count. A word of five letters or more also matches a field word of four letters or more that it starts with, so `characters` matches the tag `character`. Unzipping reads the archive's directory first, then decompresses entries in batches of about 8 MB with a pause between batches, writes each file with exclusive create, and skips `__MACOSX` and `.DS_Store` entries.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Game tools subsystem page](../../../docs/subsystems/gamedev.md) — the game tools, their rows, and the MCP server.
- [Skills subsystem page](../../../docs/subsystems/skills.md) — provider ranks, the Session catalog, and the `skill` tool.
- [godot](../godot/README.md) — the import step and `godot_script`, which runs the command-line runners of the GUT and GdUnit4 add-ons.
- [blender](../blender/README.md) — the worker and `execute_python`, where `wasd_addons` runs.

-----

<a id="model-experience"></a>
## Model Experience

### Tool declaration

#### What the model sees

The Session's agent sees `game_addons` with `action` (`search`, `guide`, `install`, `remove`, or `list`) and the optional `query`, `host`, `stage`, `id`, `replace`, and `project`. The description names the kinds of add-ons the catalog holds, says that installing asks the user and makes the guide a skill named by the add-on id, and asks the model to prefer what Godot and Blender already do, install only what the user agreed to, and tell the user the license. A connected agent sees the same tool with `project` as an absolute path, and the provider's instructions under `## Game add-ons`.

#### Token effect

The declaration comes to about 2,300 characters of JSON. The provider's instructions add about 1,100 characters to the MCP server's instructions.

#### KV Cache effect

The declaration is static, so it stays in the cached tool prefix whether or not a project has add-ons.

### Guides

#### What the model sees

The Session's skill catalog lists one line per add-on of the project: the add-on id and its guide's description, at most 500 characters. The `skill` tool returns a guide of at most 8,192 characters with the add-on's tested API, a working example, how to verify it with the Godot or Blender tools, and its pitfalls.

#### Token effect

A project without catalog add-ons adds nothing. Each add-on adds one catalog line, about 200 to 350 characters, and a loaded guide adds its length once.

#### KV Cache effect

An installation or removal changes the catalog, which reaches the model as a new catalog message appended to the conversation; earlier requests stay cached.

### Tool results

#### What the model sees

A search lists matching add-ons, about 300 to 600 characters each. An installation names the version, license, installed paths, the guide's skill name, notes such as a required credit or a skipped import, and up to 20 import problems. A removal names the deleted paths and up to 20 files that still use the add-on.

#### Token effect

A search of the whole catalog is about 9,000 characters; a guide result is the guide; other results are a few hundred characters.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the plugin offers; they are current package constraints.

- **Pinned upstream archives** — archives download from their projects' release or tag URLs. A tag archive that GitHub rebuilds with other bytes fails its SHA-256 check until the entry is pinned again.
- **No editor-only add-ons** — the agent cannot use an editor dock, brush, or gizmo, so the catalog leaves out add-ons that work only through the editor interface.
- **No GDExtension add-ons** — WASD Engine's Web release loads no GDExtensions, so the catalog leaves out compiled add-ons such as Terrain3D or LimboAI.
- **Notices stay in the project** — `THIRD_PARTY_NOTICES.md` is not part of an exported game; a game that ships an add-on credits it in its own way.
- **Blender store keeps one version** — every project uses the catalog's version of a Blender extension; a newer catalog version replaces the stored one for all projects.
- **Hand-made copies** — a copy of a catalog add-on found in `addons/` gets the catalog's guide, which may not match its version.
- **Development add-ons ship** — the Web export packs every resource, so a test add-on such as GUT, about 3 MB, ships inside the released game until it is removed.
- **Editor settings** — editor plugins load during the import step with the user's Godot editor settings; Importality adds empty `importality/*` keys to `editor_settings-4.7.tres` there.
- **Add-ons that crash headless** — Sprite Sheet Generator 2.2.3 ends a headless Blender with a segmentation fault after it writes its sheet, so the catalog leaves it out; the agent renders sprite frames with `bpy` instead.
- **Large asset packs** — MPFB comes with MakeHuman's system assets: 312 MB to download with the add-on, and 358 MB in the store and asset folder, which every project shares and a removal keeps.
- **Letter tiles** — Extra Import Hints, GdUnit4, and YATI have only icons built from the Godot or Blender logos, which the trademark terms forbid as another project's logo, and VRM's listing icon has no license. These four show a letter tile.
- **An AGPL icon** — MPFB's icon is MakeHuman's logo under AGPL-3.0-or-later, so `LICENSE-AGPL-3.0.txt` ships beside `ICONS.md` with that license's text.
- **Add-on preferences reset** — factory settings reset Blender add-on preferences; the worker runs each add-on's setup script again, which restores what the catalog sets, such as MPFB's asset folder, but not preferences the agent set.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

To add or update an entry, pin the release's archive and SHA-256, then read its `plugin.gd` for what `_enable_plugin()` adds. Write the guide within the size the catalog content spec checks, and add a smoke test under `tests/smoke/<id>/`. Run `vitest run --config vitest.e2e.config.ts packages/gamedev/game-addons/tests/catalog.e2e.ts` with `WASD_LIBGODOT_DIR` set to an installed runtime folder and uv's bpy 5.2.3 cached; `WASD_ADDON_ARCHIVES` keeps the downloads between runs.

</details>
