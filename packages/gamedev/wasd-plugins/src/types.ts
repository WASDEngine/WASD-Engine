/**
 * Types WASD Engine Plugins shares between its Host service and its browser half.
 * @module @deepseek-ai/dsh-wasd-plugins/types
 */

/** The game a project released to on the WASD Engine site it is signed in to. */
export interface WasdReleasedGame {
  /** Game title as the site shows it. */
  readonly title: string
  /** The game's share page, which plays its latest version. */
  readonly url: string
  /** The latest version this project released, from 1. */
  readonly version: number
}

/** A project folder as the Release button sees it. */
export interface WasdProjectView {
  /** Whether the folder holds `project.godot`: Release supports Godot projects only. */
  readonly godot: boolean
  /** The game the project released to on the site the app is signed in to; absent before its first release. */
  readonly game?: WasdReleasedGame
}

/** Pages of the WASD Engine site the app is signed in to, or would sign in to. */
export interface WasdSiteLinks {
  /** The Explore page, which lists every released game. */
  readonly explore: string
}

/** A finished release. */
export interface WasdRelease {
  /** Game title. */
  readonly title: string
  /** The released version, from 1. */
  readonly version: number
  /** Share page of this version: it plays this version even after later releases. */
  readonly url: string
  /** Share page of the game: it plays the latest version and lists the earlier ones. */
  readonly gameUrl: string
  /** Page that starts this version's build directly, without the share page around it. */
  readonly playUrl: string
  /** Size of the uploaded build in bytes, unpacked. */
  readonly totalBytes: number
  /** How the Web build differs from desktop runs, and the export's warnings. */
  readonly warnings: readonly string[]
}
