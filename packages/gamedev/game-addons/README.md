---
description: "Game add-ons for the agent: a curated catalog of Godot and Blender add-ons pinned to tested versions, the system prompt section that lists them, the game_addons tool with which the agent installs one into a game project when it decides that the game needs it, usage guides that only that project's Sessions see as skills, and the Add-ons dialog in Session headers, whose switches choose the add-ons that agents may use."
kind: "package-reference"
---

# @deepseek-ai/dsh-game-addons

English | [中文](README.zh.md)

## Summary

The plugin offers the agent third-party Godot and Blender add-ons tested with WASD Engine's Godot 4.7.2 and Blender 5.2.3. The system prompt lists each under its category with a few words on its use; a search says when to use it. The agent installs one with the `game_addons` tool when the game needs it, without asking, and tells the user; its guide then becomes a skill of that project's Sessions. Agents connected through WASD Engine's MCP server get the same tool. In the Session header's Add-ons dialog, the user can turn any add-on off for every agent; all start on.

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

The Game tools tabs list the row with its icon, and the Plugins page's switch turns it off with `- id: game-addons` and `disabled: true` in the profile patch. The plugin needs the `tools`, `systemPrompt`, `workingDirectory`, `skills`, and `typert` services. It imports a project after an installation through the `godot` service of [`@deepseek-ai/dsh-godot`](../godot/README.md) when that service runs, offers its tool to connected agents through the `gameMcp` service of [`@deepseek-ai/dsh-game-mcp`](../game-mcp/README.md), and saves the Add-ons dialog's switches through the `settings` service of [`@deepseek-ai/dsh-settings`](../../settings/settings/README.md), which a Loader profile provides.

| Field | Default | Meaning |
|---|---|---|
| `catalogDir` | required | Absolute catalog folder: one folder per add-on with `addon.json` and `SKILL.md` |
| `dataRoot` | required | Absolute folder of the plugin's data: downloaded archives stay in `archives/<sha256>.zip`, and Blender add-ons' asset packs unpack into `blender-assets/<id>/` |
| `blenderStore` | required | Absolute folder of the Blender add-on store, which the `blender` row's `addonStore` names too |
| `downloadTimeoutMs` | `600000` | Time limit of one archive download, including its body |
| `allowed` | `{}` | Whether agents may use each catalog add-on, by id; an add-on without an entry is on. A volatile field: the Add-ons dialog writes it while the app runs, and a profile patch may set it, such as `allowed: { gut: false }` |

The plugin loads and checks the whole catalog when it starts, so an invalid entry, a guide whose name differs from its id, or a conflict that names no other entry stops the plugin. An `allowed` id that the catalog does not have, such as one of an add-on that a later catalog dropped, changes nothing; the plugin names it in a warning at its start and after each change of `allowed`.

### The catalog

Each entry pins one release: its archive URL, SHA-256, and size, the folder inside the archive to install, its SPDX license, copyright line, and any credit the license requires. It also records the application it extends, its category and a cue of at most 60 characters, which are all an agent reads of an add-on before it searches, when to use it and when Godot or Blender alone is enough, search tags, the development stages at which it helps (`prototype`, `content`, `polish`, `ship`), the add-ons it conflicts with, and the runtime versions it was verified with. A Godot entry names its folder under `res://addons/`, its editor plugin, and the autoloads and project settings that its `_enable_plugin()` adds, because the installer cannot click the editor's plugin switch. It may also name overlay folders (`godot.overlay`): folders of the catalog, in its own catalog folder or beside the entries, whose files the installer adds to the add-on folder without replacing a file of the archive. An entry may leave paths of the archive's folder out of the installation (`archive.exclude`): demos, example scenes, screenshots, C# files, and an editor plugin that only the Godot editor can use, none of which a game should pack; a path that the archive lacks fails the installation, so an entry cannot silently stop fitting its archive. An overlay file may stand where an excluded file was: Starter Kit FPS's `objects/player.gd` captures the mouse in a Web build only after a click, Maaack's Menus Template's credits label holds a neutral text in place of the template's placeholders, Controller Icons' `ControllerIcons.gd` no longer asks a browser for the keyboard's layout, which printed an error there, and Easy Vehicle Physics' `scripts/wheel.gd` drives over a ground whose group names no surface instead of stopping with an error. Such a file is a changed copy of the archive's file and keeps the archive's license. A starter kit is a whole Godot project and not an add-on folder (`archive.projectRoot`): the installer leaves out its `project.godot`, `.godot` folder, and `export_presets.cfg`, unpacks the rest into the entry's folder under `res://addons/`, and rewrites the `res://` paths in its scenes, scripts, resources, shaders, and `.cfg` and `.json` files to that folder, while the kit's input actions and autoloads come from the entry's `settings` and `autoloads`. The two Universal Animation Library entries, Quaternius's CC0 animation packs, add their import settings this way, which import each pack as an `AnimationLibrary` retargeted to Godot's humanoid skeleton, and both add `humanoid-retarget/`, which holds the bone maps and `retarget.gd`, the script that prepares a model's import to play the clips. Overlay files enter the game, so WASD Engine dedicates those it wrote to the public domain (CC0-1.0), as the notice's copyright line says. An entry for an add-on that WASD Engine wrote has no archive: a Godot entry is then its overlay folders alone, such as WASD Cloth's `wasd-cloth/addon/`, the cloth nodes, wind zones, flag shader, and checker, or WASD Water's `wasd-water/addon/`, the water node, its shaders, looks, and foam texture, and the floater, or WASD Post's `wasd-post/addon/`, the screen pass, its shader, and its looks, and a Blender extension names `blender.files`, the catalog folder with its `blender_manifest.toml` and Python package, such as WASD Cloth for Blender's `wasd-cloth-blender/extension/`. A Blender entry names its Python module and whether it is an extension, from its archive or its catalog files, or an add-on that ships inside Blender. It may also pin an asset pack (`assets`: URL, SHA-256, size, folder, SPDX license, and page) and name a setup script (`blender.setup`) in its catalog folder, whose `setup(module, assets)` the Blender worker calls after it enables the add-on; MPFB's script points MPFB at MakeHuman's CC0 system assets. An entry may set `bundled`, as the two Universal Animation Libraries and MPFB, with its MakeHuman asset pack, do: the Desktop app's packaging then puts its archive, and its asset pack's, into this package's `archives/` folder as `<sha256>.zip`, outside `app.asar`, where an install reads it in place, never downloading or removing it; without such a file, as in the Web profile or a source checkout, the install downloads the archive as for any entry. The shipped catalog lists only GDScript Godot add-ons, so Web releases keep working, and Blender add-ons whose operators run without a window. Each entry has a smoke test in [`tests/smoke/`](tests/smoke/) that the end-to-end suite runs, and the suite loads every script of a Godot entry with `godot_check`'s script loader, in a whole-project check's order and in the reverse one, which must report no errors. A Godot smoke test's run must print no error either, a line that starts with `ERROR:` or `SCRIPT ERROR:`, because a game that prints one in a browser is not released; what Godot reports while it shuts down, about resources a scene left in use, does not count, and a smoke test names in `errors` a part of each other error line that its run prints and that a game does not meet, as Beehave's names the one its debugger prints when the game quits. It also runs the Web export's feature scan on each installed Godot entry: the entry's own files may raise only the notes that its smoke test names (`webNotes`), and its guide then says what the add-on does in a Web build. And it fails when two entries that do not conflict declare the same global class, which would stop both from loading in one project.

### The tool

| Action | What it does |
|---|---|
| `search` | Without words or filters, shows the catalog's index: every add-on under its category, with its cue and whether the project has it. With `query` (an add-on's id, or words), `category`, `host` (`godot` or `blender`), or `stage`, ranks the matches and shows the best 8 with how many matched; an id shows that add-on alone. Each match shows its id, version, license, download size, or that it ships inside Blender or with WASD Engine when nothing is downloaded for it, summary, when to use it, when to skip it, what it conflicts with, any required credit, and whether the project has it |
| `guide` | Returns an add-on's usage guide, noting when the project does not have the add-on yet |
| `install` | Installs `id` into the project; `replace` replaces a copy already in `addons/` without a WASD Engine record |
| `remove` | Takes `id` out of the project, keeping its folder in a backup, and names the project files that still use it |
| `list` | Lists the project's catalog add-ons |

`project` names the folder that holds `project.godot`, relative to the working directory; without it, the nearest project is used, as the Godot tools find it. An add-on that the user turned off is missing from `search`, whose count covers only the add-ons agents may use; `guide` and `install` refuse it with a message that tells the agent to do the work without it or to ask the user to turn it on in the Add-ons dialog; `list` still shows it when the project has it, marked as turned off; and `remove` still takes it out. With every add-on off, `search` says so. A Godot installation runs these steps:

1. Download the pinned archive into the cache unless it is there, checking its size and SHA-256. An add-on without an archive downloads nothing.
2. Unpack the add-on's folder into a staging folder under `.wasdengine/`, without the paths the entry leaves out, adding the license file when it lies outside that folder in the archive, and the files of the entry's overlay folders; a project archive also loses its `project.godot`, import cache, and export presets, and has its `res://` paths rewritten to the add-on's folder; an add-on without an archive is its overlay files alone.
3. Take the lock of the project's record, `.wasdengine/addons.json.lock`, and check the project again.
4. Move the folder into `res://addons/<folder>/`.
5. Enable the editor plugin and add its autoloads and settings to `project.godot` as the file is at that moment, keeping every other line. A setting whose value is a Dictionary, such as Extra Import Hints' `[importer_defaults] scene`, gets the add-on's entries merged into the project's own, and the value the setting held before, or that the project had none, is kept in `.wasdengine/addon-settings.json` beside the record.
6. Add a marked section with the license text to `THIRD_PARTY_NOTICES.md`.
7. Record the add-on in `.wasdengine/addons.json` and release the lock.
8. Import the project once, or twice for add-ons whose formats import fully only on the second pass, and report the import's errors.

Every installation and removal holds the record's lock while it changes the project, so those of the Session's agent, its teammates, connected agents, and the Add-ons dialog take turns, also across processes, and none writes back a `project.godot` or notices file that another changed. A failure in steps 4 to 7 undoes the steps before it: the previous folder goes back, and `project.godot` and the notices lose only what the installation wrote, keeping what others changed meanwhile. The error names whatever could not be put back, such as a replaced folder left in `.wasdengine/trash/`. A Stop before step 4 leaves the project as it was; from step 4 on, the installation completes, and a Stop ends only the import. Installing an add-on whose conflict is already in the project, or one whose autoload name another script holds, fails with what to do. Installing the same version again downloads nothing and only rewrites `project.godot` entries that were lost. A Blender installation unpacks the extension once into the store, as `<blenderStore>/<module>/`, and its asset pack once into `<dataRoot>/blender-assets/<id>/`, each with a marker that names its archive. An extension that WASD Engine wrote is copied there from its catalog folder instead, with a marker that names the SHA-256 of its files' paths and bytes, so an installation after any of them changed replaces the copy. Their archives then leave the cache, since the store keeps their files for every project. It writes the store's index, which gives each Blender add-on's module, setup script, and asset folder, and records the add-on in the project. The index names each setup script by a copy in `<blenderStore>/.wasd-setup/<id>/`, with a marker that names the SHA-256 of its path and bytes, and never by the catalog file: Blender workers run setup scripts with their own Python, which cannot read the catalog inside the Desktop app's `app.asar`. The plugin writes the index and the copies at every start too, which replaces an index that an earlier version wrote with catalog paths. An add-on that ships inside Blender is only recorded. Unpacking reads an archive's central directory and streams one file at a time, so memory stays bounded for MPFB's 268 MB pack too.

A removal first lists up to 20 scenes, scripts, and resources that still refer to the add-on's folder or its autoloads, so the agent can change them; a Stop during that scan changes nothing. Holding the record's lock, it then takes the add-on's folder out of the project and removes the add-on's `project.godot` entries and notice: each setting, or entry of a Dictionary setting, that still holds the add-on's value gets back the value it held before the installation, or goes when it had none, unless another installed add-on sets it too, and one changed since keeps its value. A failure undoes the removal as it undoes an installation. The folder moves to a new backup folder of the add-on, `.wasdengine/backups/<id>/<time>/`, named by the time of the removal, such as `2026-11-12T09-45-10.000Z`, and the result names it; no backup replaces another, and none is deleted. A `.gitignore` in `.wasdengine/backups/` keeps the backups out of version control, and an installation with `replace` keeps the folder it replaces the same way and names that backup in a note. A catalog add-on found in `addons/` without a record can be removed the same way. A Blender add-on leaves only the project's record; the store keeps it for other projects.

The project's record may come from someone else, so a removal takes out only the paths it lists inside the add-on's folder `addons/<folder>/`: a record path elsewhere stops the removal before anything changes, and a record whose paths hold a backslash, a colon, or a `..` segment is invalid. No change follows a symbolic link out of the project: an installation or removal whose `addons` or `.wasdengine` folder leads elsewhere fails before it moves or writes anything there, and a linked add-on folder moves as the link.

### When the agent installs one

The agent decides when an add-on is worth installing. The plugin adds the `game-addons` section to the system prompt, in the slot of the Godot games section. It tells the agent to install an add-on, without asking the user first, when the work at hand needs what the add-on does and plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps; to skip it when the engine's own nodes and tools or a short script do the job, and never to install one in case it is needed later; and, after an installation, to load the guide before using the add-on and to tell the user what it added and why, with the license and any credit the license requires. The catalog's index follows: under a heading per category, one line per add-on that the user has not turned off, with its id, `(Blender)` for a Blender add-on, and its cue. The section asks the agent to read, before it builds what a listed add-on does, when the add-on helps, when to skip it, and its size, license, and conflicts from a search with the id, a category, or words. The section reads the switches at every model step, and it is left out while every add-on is off.

`install` and `remove` ask nobody under every approval policy, like the other game tools, and the Session's permission mode does not confine them. A user's click in the Add-ons dialog changes the project the same way. Connected agents read the same judgment in the MCP server's instructions, which list no add-on: their overview, the guide, and the tool's description ask them to read the catalog's index with `action: search` before they plan a game, and their own harness decides whether to ask its user.

### Guides as skills

The plugin registers the skill provider `game-addons`. For a Session's working directory it finds the game project as the Godot tools do, and lists the guide of each catalog add-on the project has installed or holds in its `addons` folder, unless the user turned the add-on off; a guide listed before that is no longer served. The guide's skill name is the add-on id. Its rank, 550, lets project, custom, and user skills of the same name win over it, while bundled skills lose to it. A guide of a copy whose `plugin.cfg` names another version says so in its description. The provider watches the project's `addons` and `.wasdengine` folders, so an add-on installed or removed outside the tool, for example by Git, changes the list the next model step sees; a change of `allowed` refreshes the list too.

### Blender add-ons

The `blender` row's `addonStore` reaches each Blender worker as `WASD_ADDON_STORE`. In a worker, `import wasd_addons; wasd_addons.enable("<id>")` enables a store extension through an extensions repository named `wasd`, as `bl_ext.wasd.<module>`, or an add-on that ships inside Blender, such as Rigify, and runs the entry's setup script; `wasd_addons.assets("<id>")` returns the folder of its asset pack. Factory settings, which `new_scene` and executed code can load, disable every add-on and reset their preferences, so the worker enables the add-ons it had enabled again and runs their setup scripts again. Each guide of a Blender add-on starts with that call. The store's index marks an add-on that the user turned off with `allowed: false` and the refusal of the tool, which `enable` and `assets` raise; the plugin writes the index again after each change of `allowed`, one write after another, so the last change stays.

### The Add-ons dialog

The browser half registers an Add-ons button after the Export / Share button of each Session header in a Workspace. Its dialog lists the catalog's add-ons under the catalog's categories, in the order of the index that agents read, each with its icon, a tag on a Blender add-on, version, license, size, or where it ships when nothing is downloaded for it (inside Blender, or with WASD Engine for an add-on that WASD Engine wrote), asset pack, summary, use, required credit, whether the Session's project has it, and a switch that says whether agents may use it; a Workspace folder without a Godot project shows the list and switches without presence. A search field above the list, which holds the focus when the dialog opens except on a phone, narrows the list to the add-ons that hold every word typed in their title, id, application, cue, summary, use, search words, or category heading, and keeps its place while the list scrolls. Each icon is an `icon.png` or `icon.svg` of at most 16 KiB in the entry's catalog folder, which the entry's `icon` names with its source URL, license, and copyright line; `ICONS.md` beside the catalog's folders lists them all with the license texts. The catalog reads each icon once as a data URL, refusing an SVG with scripts or external references, and the `project` Remote returns the icons beside the views, so tool results never carry them. WASD Engine's own add-ons show icons from [Lucide](https://lucide.dev), one for what each add-on does; each file sets the stroke color to WASD Engine's purple, because an icon drawn as an image does not take the page's text color. An add-on without an icon shows a tile with the first letter of its title, after the "WASD" that the titles of WASD Engine's own add-ons start with. A switch calls the `gameAddons` Remote's `setAllowed`, which sets `allowed.<id>` with one path edit of the Settings service: the edit lands in the row's profile patch and applies without a restart, to every project and to every agent, the Session's and connected ones. The switches show what the Host accepted, so a refused write leaves them as they were with a notice that says why; every switch waits while one change is saved, and the notice after a change, which stays in sight at the bottom of the list, says what changed for agents and, for an add-on the Session's game has, that the game keeps it until an agent removes it. The dialog neither installs nor removes add-ons; agents do. The dialog reads its list through the Remote's `project`, which takes the Workspace folder; LiveShare classifies both endpoints as owner-only.

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
| [`src/index.ts`](src/index.ts) | Config, catalog loading, tool, prompt section, skill provider, and game MCP registration, the `gameAddons` Remote, and the switches' writes and their effect on the guides and the Blender index |
| [`src/catalog.ts`](src/catalog.ts) | Entry validation, the categories, guide frontmatter, and search ranking |
| [`src/manager.ts`](src/manager.ts) | Presence in a project, installation, removal, references, the Blender store, and the refusal of add-ons that the user turned off |
| [`src/archive.ts`](src/archive.ts) | Pinned downloads into the cache, and unpacking one archive folder file by file with yauzl, without the paths an entry leaves out |
| [`src/project-root.ts`](src/project-root.ts) | What an installation never takes from a project archive, and the rewrite of its `res://` paths to the add-on's folder |
| [`src/project-file.ts`](src/project-file.ts) | `project.godot` edits that keep every other line, and their undo, which keeps what others changed since |
| [`src/record.ts`](src/record.ts) | `.wasdengine/addons.json` and its file lock, which every installation and removal holds while it changes the project, and `.wasdengine/addon-settings.json`, the values of the settings installations changed |
| [`src/paths.ts`](src/paths.ts) | Record path rules, and project paths resolved so that no change leaves the project |
| [`src/notices.ts`](src/notices.ts) | Marked sections of `THIRD_PARTY_NOTICES.md` |
| [`src/skills.ts`](src/skills.ts) | The guides' skill provider and the folder watcher |
| [`src/tools.ts`](src/tools.ts) | The `game_addons` definition and its result text |
| [`src/prompt.ts`](src/prompt.ts) | The `game-addons` system prompt section and the provider's instructions: when to install an add-on, and the catalog's index by category |
| [`src/mcp.ts`](src/mcp.ts) | The tool and provider for connected agents |
| [`src/client/`](src/client/) | The Add-ons button and dialog |

A query that is an add-on's id returns that add-on alone. Otherwise search scores each query word by the best field one of whose words it starts: 3 for the id or title, 2 for a tag or the cue, and 1 for the summary or use. Common words do not count. A word of five letters or more also matches a field word of four letters or more that it starts with, so `characters` matches the tag `character`. Unzipping reads the archive's directory first, then decompresses entries in batches of about 8 MB with a pause between batches, writes each file with exclusive create, and skips `__MACOSX` and `.DS_Store` entries.

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

### System prompt section

#### What the model sees

The Session's agent sees the `game-addons` section just before the Godot games section: the section text below, then the catalog's index: a heading for each category that holds an add-on, and under it one line per add-on that the user has not turned off, Godot add-ons first, as in the index lines below; a heading names what the category's shipped entries cover and ends with the category's search value in parentheses. A connected agent reads the same judgment in the MCP server's instructions under `## Game add-ons`, without the index: the guide sends it to `action: search` without a query for the same index, and to a search with an add-on's id, a category, or words for the details, and names the absolute `project`, the `guide` action, and Blender's `wasd_addons.enable` call in place of the guide skill. The guide ends with the order in which a 3D game's look is built: the written look first, then light, surfaces, the world, characters, motion, feedback, and the interface, one screen look last, and the screenshots that check it. It names the steps and no add-on, so it holds whichever add-ons the user turned off; the Session's agent reads the same order in the bundled `game-look` skill, which names each step's add-on. Connected agents so read the index once, from that search. Before that guide, which Claude Code's model reads only through `search_game_tools`, the overview of the instructions lists the provider's description: curated add-ons that do common game jobs better than new code, with examples, and the request to read the catalog's index with `game_addons` `action: search` before planning a game and to install what fits once `project.godot` exists, which an installation needs and a new game project's folder does not have yet.

##### Section text

```markdown
# Game add-ons

game_addons installs tested third-party add-ons into the game project: Godot add-ons written in GDScript and Blender add-ons that run without a window, each pinned to a version tested with the built-in Godot and Blender. Decide yourself when one is worth it; you do not need to ask the user first. Install an add-on when the work at hand needs what it does and building that with plain Godot or Blender would take much longer or turn out worse, at the stage of the game where it helps. Skip it when Godot's own nodes, Blender's own tools, or a short script do the job, and do not install one in case it is needed later.
Before you build what a listed add-on does, read about it: action search with an add-on's id, a category, or words shows when it helps, when to skip it, its download size, license, and conflicts. After installing one, load its guide, the skill named by its id, before using it, and tell the user what you added and why, with its license and any credit it requires. Remove an add-on only when the game no longer uses it.

Every add-on, under its category, with what it is for:
```

##### Index lines

```markdown
Characters: humans, rigs, animation clips, movement, faces, crowds (characters)
- universal-animation-library: 45 humanoid clips: move, jump, fight, die; retargeting
- mpfb (Blender): realistic rigged humans: skin, hair, clothes, a face
Game systems: AI, state, dialogue, inventories (gameplay)
- beehave: behavior trees for NPC and enemy AI
```

#### Token effect

With the 56 add-ons of the shipped catalog the section comes to about 5,500 characters, about 1,370 tokens, in every request of every Session, with or without a Godot project. Each added entry adds one line of about 30 to 90 characters, and each add-on that the user turns off takes its line away; with every add-on off the section is left out. The shipped catalog spec keeps the section within 8,000 characters, which holds about 90 entries.

#### KV Cache effect

The text changes only with the shipped catalog and the user's switches, so it stays in the cached system prompt prefix between changes; a WASD Engine update that changes the catalog, or a switch that the user flips, changes it once, at the next model step of each Session, which logs the new system prompt.

### Tool declaration

#### What the model sees

The Session's agent sees `game_addons` with `action` (`search`, `guide`, `install`, `remove`, or `list`) and the optional `query`, `category`, `host`, `stage`, `id`, `replace`, and `project`. The description names the kinds of add-ons the catalog holds, says that a search without words gives the index and one with an id, a category, or words the details, and tells the model to install one itself, without asking the user first, when the game needs what it does and Godot or Blender alone would take much longer, and then to tell the user what it added and its license. A connected agent sees the same tool with `project` as an absolute path, and a description that ends `Before you plan a game, read the catalog's index with action search and no query.`, since it has no catalog section in a system prompt.

#### Token effect

The declaration comes to about 3,000 characters of JSON. The provider's instructions add about 1,500 characters to the MCP server's instructions; they list no add-on, since connected agents read the index with `action: search`.

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

A search without words or filters lists the index, one line of about 30 to 100 characters per add-on, with `[installed]` or another note on the add-ons the project has. A search with an id, a category, or words lists at most 8 matches, about 300 to 600 characters each, and says how many matched when there are more. An installation names the version, license, installed paths, the guide's skill name, or for a connected agent, which has no skills, the `guide` action that shows the guide, notes such as a required credit or a skipped import, and up to 20 import problems, and asks the model to tell the user that it added the add-on, why, and its license, except when the project already had that version. A removal names the paths it took out, the backup that keeps them, and up to 20 files that still use the add-on. A list marks an add-on that the user turned off, and a guide or installation of one fails with a message of about 180 characters that says so.

#### Token effect

The index of the whole catalog is about 3,000 characters and a search with words at most about 5,000; a guide result is the guide; other results are a few hundred characters.

#### KV Cache effect

Append-only in the conversation.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the plugin offers; they are current package constraints.

- **No question before a change** — the agent installs and removes catalog add-ons on its own judgment under every approval policy and permission mode, so a user learns of an installation from the agent's reply, the tool call in the transcript, and the project's `.wasdengine/addons.json`. The Add-ons dialog keeps agents from installing an add-on again; taking one out of a game is the agent's `remove`.
- **Switches for every project** — the switches belong to the profile, so an add-on that is off is off in every game, and turning it off leaves it in the games that have it, where the agent no longer sees its guide while it changes code that uses it.
- **Switches copy the row** — a switch write saves the whole `game-addons` row's configuration in the profile patch, as every Settings write does, so a later change of the row's other fields in the bundle's overlay does not reach that profile while its patch holds the row.
- **Blender workers keep what they enabled** — a worker that enabled an add-on before the user turned it off keeps it until factory settings load or the worker stops; only `enable` and `assets` calls after the change refuse it.
- **The index in every request** — every Session's system prompt lists the catalog's index, also in Sessions without a Godot project; a catalog of more than about 90 entries outgrows the section's 8,000-character budget and needs an index of categories alone.
- **A cue is all the agent knows at first** — the index gives an add-on six to ten words, so an agent that does not search before it builds may pass over an add-on that fits; the section asks for that search.
- **Kits rewrite paths as text** — a starter kit's `res://` paths are rewritten wherever its scenes, scripts, resources, shaders, and `.cfg` and `.json` files spell them; a path that a kit's code builds from parts must start from a rewritten `res://`, as Starter Kit FPS's `Audio.play("sounds/land.ogg")` does. A kit's smoke test runs its level from the add-on folder to show that it does.
- **Changed copies need care on updates** — an overlay file that stands in for an excluded archive file, such as Starter Kit FPS's player script, Controller Icons' `ControllerIcons.gd`, and Easy Vehicle Physics' `scripts/wheel.gd`, is a copy of one upstream version; pinning a new version means making the change again.
- **Editor plugins left out** — where an add-on's editor plugin only adds brushes, docks, or a setup wizard, the entry leaves the plugin out and declares what its `_enable_plugin()` would add; the add-on's guide then shows how to do from code what the editor would.
- **Pinned upstream archives** — archives download from their projects' release or tag URLs. A tag archive that GitHub rebuilds with other bytes fails its SHA-256 check until the entry is pinned again.
- **No editor-only add-ons** — the agent cannot use an editor dock, brush, or gizmo, so the catalog leaves out add-ons that work only through the editor interface.
- **No GDExtension add-ons** — WASD Engine's Web release loads no GDExtensions, so the catalog leaves out compiled add-ons such as Terrain3D or LimboAI.
- **Notices stay in the project** — `THIRD_PARTY_NOTICES.md` is not part of an exported game; a game that ships an add-on credits it in its own way.
- **Blender store keeps one version** — every project uses the catalog's version of a Blender extension; a newer catalog version replaces the stored one for all projects.
- **Hand-made copies** — a copy of a catalog add-on found in `addons/` gets the catalog's guide, which may not match its version.
- **Development add-ons ship** — the Web export packs every resource, so a test add-on such as GUT, about 3 MB, ships inside the released game until it is removed. An entry's `archive.exclude` keeps demos and examples out of the project, as ProtonScatter's 12 MB of demos, but not files the add-on needs.
- **The Web scan reads text** — the Web export names an add-on's file for a feature that browsers lack whenever the file spells that feature, also in code that a game never runs, such as an editor panel's preview; the entry's smoke test lists those notes and its guide says what they mean.
- **Editor settings** — editor plugins load during the import step with the user's Godot editor settings; Importality adds empty `importality/*` keys to `editor_settings-4.7.tres` there.
- **Add-ons that crash headless** — Sprite Sheet Generator 2.2.3 ends a headless Blender with a segmentation fault after it writes its sheet, so the catalog leaves it out; the agent renders sprite frames with `bpy` instead.
- **Other writers of `project.godot`** — an installation or removal reads and writes `project.godot` within moments while it holds the record's lock, but the Godot editor, the agent's file tools, and other programs do not take that lock, so a change that one of them saves between that read and that write is lost.
- **Backups take space** — each removal and replacement of an add-on adds a backup folder in `.wasdengine/backups/<id>/`, which stays until someone deletes it; deleting a backup folder frees its space.
- **Large asset packs** — MPFB comes with MakeHuman's system assets: 312 MB to download with the add-on, and 358 MB in the store and asset folder, which every project shares and a removal keeps.
- **Letter tiles** — Extra Import Hints, GdUnit4, and YATI have only icons built from the Godot or Blender logos, which the trademark terms forbid as another project's logo, and VRM's listing icon has no license. These four show a letter tile.
- **An AGPL icon** — MPFB's icon is MakeHuman's logo under AGPL-3.0-or-later, so `LICENSE-AGPL-3.0.txt` ships beside `ICONS.md` with that license's text.
- **Humanoid clips only** — the Universal Animation Library clips play on humanoid rigs that a bone map names; `retarget.gd` ships maps for MPFB's `game_engine` and `mixamo` rigs, Rigify's game skeleton, Mixamo downloads, and Quaternius's mannequins, and the agent writes a map for another rig. Limb directions follow the clips within about 10 degrees on those rigs, and MPFB's `game_engine` torso up to about 23 degrees in deep bends.
- **Add-on preferences reset** — factory settings reset Blender add-on preferences; the worker runs each add-on's setup script again, which restores what the catalog sets, such as MPFB's asset folder, but not preferences the agent set.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

To add or update an entry, pin the release's archive and SHA-256, then read its `plugin.gd` for what `_enable_plugin()` adds. Pin a commit's archive when a project publishes no release, or when its last release lacks work on its main branch that the entry needs, and end `version` with `+` and the commit's first seven characters. Give the entry a `category` and a `cue` that says in a few words what the add-on is for, since that line decides whether an agent looks further, and change the category's heading in `CATEGORY_TITLES` when the entry adds a kind the heading does not name. Leave out with `archive.exclude` what a game should not pack, and run the suite, which fails on an excluded path that the add-on's own files still need. Also leave out an archive's `.gdignore` files that lie in folders a game loads from: Godot neither imports nor exports such a folder, so its shaders and resources load in the editor and are missing from every exported game. The suite fails on them, as it did on SimpleGrassTextured's shader and material folders, which only a Web check of an exported game had shown. When a pack's own download links expire, as itch.io's do, pin a copy on a WASD Engine GitHub release instead. Write the guide within the size the catalog content spec checks, and add a smoke test under `tests/smoke/<id>/`. A test of something drawn runs as `render` with an `override.cfg` that selects the Compatibility renderer, which Web builds use, and waits by the wall clock, since such a run is not held to the display's frame rate. Before a guide says what an add-on does in a Web build, export a project with it through `wasd_export_web` and read the Web check: Maaack's Scene Loader was left out of the catalog because its loading screen never shows there, where a single-threaded build loads the scene in one blocking step. Run `vitest run --config vitest.e2e.config.ts packages/gamedev/game-addons/tests/catalog.e2e.ts` with `WASD_LIBGODOT_DIR` set to an installed runtime folder and uv's bpy 5.2.3 cached; `WASD_ADDON_ARCHIVES` keeps the downloads between runs. A smoke test may copy another smoke folder's files (`files`), run a `prepare` script between two imports, as the animation packs run `retarget.gd`, and name other Godot add-ons to install beside its own (`with`) when it tests what they do together, as WASD Face names WASD Character, whose characters it gives faces; `tests/smoke/universal-animation-library/rigs.py` makes their rigs with MPFB and Rigify. Change an entry's `version` when its overlay files change, because installing the same version again leaves a project's copies as they are.

</details>
