/**
 * Types that the game add-ons Host service shares with its browser half: catalog entries, what a project has
 * installed, and the views the Add-ons dialog shows.
 * @module @deepseek-ai/dsh-game-addons/types
 */

/** The application an add-on extends. */
export type GameAddonHost = 'godot' | 'blender'

/** A point in a game's development at which an add-on usually helps. */
export type GameAddonStage = 'prototype' | 'content' | 'polish' | 'ship'

/** The pinned archive an add-on installs from. */
export interface GameAddonArchive {
  /** HTTPS URL of the zip archive. */
  readonly url: string
  /** SHA-256 of the archive, as 64 lowercase hexadecimal digits. */
  readonly sha256: string
  /** Size of the archive in bytes. */
  readonly bytes: number
  /** Folder inside the archive whose contents are installed, with `/` separators; empty for the archive's root. */
  readonly root: string
  /** License file inside the archive, with `/` separators, copied beside the installed files when it lies outside `root`. */
  readonly license?: string
}

/** A data pack that a Blender add-on reads, such as character assets, installed with it beside the add-on store. */
export interface GameAddonAssets {
  /** HTTPS URL of the zip archive. */
  readonly url: string
  /** SHA-256 of the archive, as 64 lowercase hexadecimal digits. */
  readonly sha256: string
  /** Size of the archive in bytes. */
  readonly bytes: number
  /** Folder inside the archive whose contents form the pack, with `/` separators; empty for the archive's root. */
  readonly root: string
  /** SPDX license identifier of the pack. */
  readonly license: string
  /** Page that describes the pack. */
  readonly homepage: string
}

/** The icon of a catalog add-on: an image in its catalog folder, with where it came from. */
export interface GameAddonIcon {
  /** `icon.png` or `icon.svg` in the entry's catalog folder. */
  readonly file: string
  /** HTTPS URL the image was downloaded from. */
  readonly source: string
  /** SPDX license identifier of the image. */
  readonly license: string
  /** Copyright line that the license requires to travel with the image; absent for public-domain and CC0 images. */
  readonly copyright?: string
}

/** An autoload singleton that a Godot add-on's editor plugin adds when it is enabled. */
export interface GodotAutoload {
  /** Global name of the singleton. */
  readonly name: string
  /** `res://` path of its script or scene. */
  readonly path: string
}

/** A project setting that a Godot add-on's editor plugin sets when it is enabled. */
export interface GodotProjectSetting {
  /** Section of `project.godot`, such as `dialogue_manager`. */
  readonly section: string
  /** Key within the section, such as `general/states`. */
  readonly key: string
  /** Value as `project.godot` writes it: a Godot variant literal such as `true`, `3`, or `"text"`. */
  readonly value: string
}

/** How a Godot add-on is placed and enabled in a project. */
export interface GodotAddonSpec {
  /** Folder under `res://addons/` that receives the add-on. */
  readonly addonDir: string
  /** Editor plugin configuration inside `addonDir`, usually `plugin.cfg`; absent for an add-on without editor plugin. */
  readonly plugin?: string
  /** Autoloads its editor plugin adds when enabled, which the installer writes into `project.godot`. */
  readonly autoloads?: readonly GodotAutoload[]
  /** Project settings its editor plugin sets when enabled. */
  readonly settings?: readonly GodotProjectSetting[]
  /** Whether resources of the add-on's formats import fully only on a second import pass. */
  readonly importTwice?: boolean
}

/** How a Blender add-on is enabled in the Blender worker. */
export interface BlenderAddonSpec {
  /** Python package name: the extension id of an extension, or the module of an add-on inside Blender. */
  readonly module: string
  /** `extension`: downloaded from its archive into the add-on store; `core`: ships inside Blender. */
  readonly kind: 'extension' | 'core'
  /**
   * Python file in the entry's catalog folder whose `setup(module, assets)` the Blender worker calls after it enables
   * the add-on, and again after factory settings reset the add-on's preferences: `module` is the module the add-on
   * runs as, `assets` the folder of its asset pack or None.
   */
  readonly setup?: string
}

/** The runtime versions a catalog entry was verified with. */
export interface GameAddonVerification {
  /** Godot version, such as `4.7.2`. */
  readonly godot?: string
  /** Blender `bpy` version, such as `5.2.3`. */
  readonly bpy?: string
  /** Date of the verification, `YYYY-MM-DD`. */
  readonly date: string
}

/** One add-on of the curated catalog. */
export interface GameAddon {
  /** Kebab-case id; also the name of the add-on's usage skill. */
  readonly id: string
  /** Display name. */
  readonly title: string
  /** The application it extends. */
  readonly host: GameAddonHost
  /** Upstream version the archive holds. */
  readonly version: string
  /** What it gives the game, in one sentence. */
  readonly summary: string
  /** When the agent should suggest it. */
  readonly useWhen: string
  /** When Godot or Blender alone is enough. */
  readonly avoidWhen?: string
  /** Lowercase search words. */
  readonly tags: readonly string[]
  /** Development stages at which it usually helps. */
  readonly stages: readonly GameAddonStage[]
  /** SPDX license identifier. */
  readonly license: string
  /** Copyright line of the license. */
  readonly copyright: string
  /** In-game credit line that the license requires, if any. */
  readonly credit?: string
  /** Project page. */
  readonly homepage: string
  /** Pinned archive; absent for a Blender add-on that ships inside Blender. */
  readonly archive?: GameAddonArchive
  /** Data pack installed with a Blender add-on. */
  readonly assets?: GameAddonAssets
  /** Icon the Add-ons dialog shows. */
  readonly icon?: GameAddonIcon
  /** Placement in a Godot project, for `host: 'godot'`. */
  readonly godot?: GodotAddonSpec
  /** Enabling in Blender, for `host: 'blender'`. */
  readonly blender?: BlenderAddonSpec
  /** Ids of add-ons that do the same job; at most one of them is installed in a project. */
  readonly conflicts?: readonly string[]
  /** The runtimes the entry was verified with. */
  readonly verified: GameAddonVerification
}

/** One add-on a project uses, as its `.wasdengine/addons.json` records it. */
export interface InstalledGameAddon {
  /** Catalog id. */
  readonly id: string
  /** Display name at installation. */
  readonly title: string
  /** The application it extends. */
  readonly host: GameAddonHost
  /** Installed upstream version. */
  readonly version: string
  /** SPDX license identifier. */
  readonly license: string
  /** Archive URL it was installed from; absent for a Blender add-on that ships inside Blender. */
  readonly source?: string
  /** SHA-256 of that archive. */
  readonly sha256?: string
  /** Project-relative paths the installation created, with `/` separators. */
  readonly paths: readonly string[]
  /** Installation time, as an ISO 8601 string. */
  readonly installedAt: string
}

/** How a project uses one catalog add-on. */
export type GameAddonPresence =
  /** Installed through WASD Engine and recorded in `.wasdengine/addons.json`. */
  | { readonly state: 'installed'; readonly version: string }
  /** Its folder is in `res://addons/` without a record, for example copied in by hand; `version` from `plugin.cfg`. */
  | { readonly state: 'found'; readonly version?: string }
  /** Not in the project. */
  | { readonly state: 'absent' }

/** One catalog add-on as the Add-ons dialog and the search show it. */
export interface GameAddonView {
  /** Catalog id. */
  readonly id: string
  /** Display name. */
  readonly title: string
  /** The application it extends. */
  readonly host: GameAddonHost
  /** Version the catalog installs. */
  readonly version: string
  /** What it gives the game. */
  readonly summary: string
  /** When to use it. */
  readonly useWhen: string
  /** When Godot or Blender alone is enough. */
  readonly avoidWhen?: string
  /** Search words. */
  readonly tags: readonly string[]
  /** Development stages at which it usually helps. */
  readonly stages: readonly GameAddonStage[]
  /** SPDX license identifier. */
  readonly license: string
  /** In-game credit line that the license requires, if any. */
  readonly credit?: string
  /** Project page. */
  readonly homepage: string
  /** Download size in bytes, its asset pack included; absent when nothing is downloaded. */
  readonly bytes?: number
  /** The asset pack installed with it, if any. */
  readonly assets?: GameAddonAssetsView
  /** Ids of add-ons that do the same job. */
  readonly conflicts: readonly string[]
  /** How the project uses it; absent when no project was given. */
  readonly presence?: GameAddonPresence
}

/** What the views show of an add-on's asset pack. */
export interface GameAddonAssetsView {
  /** SPDX license identifier of the pack. */
  readonly license: string
  /** Size of the pack's archive in bytes. */
  readonly bytes: number
  /** Page that describes the pack. */
  readonly homepage: string
}

/** What the Add-ons dialog shows for one game project. */
export interface GameAddonsProjectView {
  /** Absolute folder that holds `project.godot`. */
  readonly projectDir: string
  /** Every catalog add-on with its presence in the project, Godot add-ons first, each group by title. */
  readonly addons: readonly GameAddonView[]
  /** Icons of the add-ons that have one, as data URLs, by id. */
  readonly icons: Readonly<Record<string, string>>
}

/** The outcome of one installation. */
export interface GameAddonInstallResult {
  /** The installed add-on. */
  readonly addon: InstalledGameAddon
  /** Absolute folder that holds `project.godot`. */
  readonly projectDir: string
  /** Whether it was already installed at the catalog's version, so nothing changed. */
  readonly unchanged: boolean
  /** Problems the import of the project reported after installation, at most 20. */
  readonly importIssues: readonly string[]
  /** Facts the caller should pass on, such as a skipped import. */
  readonly notes: readonly string[]
}

/** The outcome of one removal. */
export interface GameAddonRemoveResult {
  /** Catalog id. */
  readonly id: string
  /** Absolute folder that holds `project.godot`. */
  readonly projectDir: string
  /** Project-relative paths that were deleted. */
  readonly removed: readonly string[]
  /** Project files outside the add-on that still name its folder, at most 20, which now need changes. */
  readonly references: readonly string[]
}
