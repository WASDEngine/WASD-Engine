/**
 * Types WASD Engine Plugins shares between its Host service and its browser half.
 * @module @deepseek-ai/dsh-wasd-plugins/types
 */
import type { GodotWebCheck } from '@deepseek-ai/dsh-godot/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Who can find a released game: `public`, on the site's Explore page, or `private`, only through its link. */
export type WasdVisibility = 'public' | 'private'

/** A desktop platform a game builds for: `windows`, 64-bit x86 Windows, or `macos`, Intel and Apple silicon Macs. */
export type WasdDesktopPlatform = 'windows' | 'macos'

/** The game a project released to on the WASD Engine site it is signed in to. */
export interface WasdReleasedGame {
  /** Game title as the site shows it. */
  readonly title: string
  /** The game's share page, which plays its latest version. */
  readonly url: string
  /** The latest version this project released, from 1. */
  readonly version: number
  /** Who can find the game, as the site answered this project's latest release. */
  readonly visibility: WasdVisibility
}

/** A project folder as the Export / Share button sees it. */
export interface WasdProjectView {
  /** Whether the folder holds `project.godot`: Release supports Godot projects only. */
  readonly godot: boolean
  /**
   * The game the signed-in account released the project to on the site the app is signed in to; absent before the
   * account's first release there.
   */
  readonly game?: WasdReleasedGame
  /**
   * Another folder on this computer that released the same game and still links to it, while this folder never
   * released it, as when this folder is a copy of that one; a release from here then needs to say whether it adds to
   * that game.
   */
  readonly sharedWith?: string
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
  /** Who can find the game from this version on. */
  readonly visibility: WasdVisibility
  /** The desktop builds the site stored as downloads of this version, in platform order, each with its scan status. */
  readonly downloads: readonly WasdDownload[]
  /**
   * What the game's page credits the game was made with, by name: AI models, then each game tool with the add-ons that
   * extend it; absent when the release could not store them.
   */
  readonly credits?: readonly string[]
  /**
   * How the Web build differs from desktop runs, the export's warnings, and what happened to the preview, downloads,
   * and credits.
   */
  readonly warnings: readonly string[]
  /** What the Web check saw in the released build; absent when the release skipped the check or it could not run. */
  readonly webCheck?: GodotWebCheck
  /** Why the Web check could not run; absent when it ran or the release skipped it. */
  readonly webCheckError?: string
}

/**
 * Where a desktop build stands in the site's malware scan: `pending` while the scan runs, `clean` once the scan passed
 * it and the game's page offers it, `flagged` when the scan found malware, or `failed` when the scan could not run on
 * it. The page never offers a `flagged` or `failed` build.
 */
export type WasdDownloadStatus = 'pending' | 'clean' | 'flagged' | 'failed'

/** A desktop build the site stored as a download of a released version. */
export interface WasdDownload {
  /** The platform it runs on. */
  readonly platform: WasdDesktopPlatform
  /** The site's download link of this build, which counts the download and sends the file once the site offers it. */
  readonly url: string
  /** The build's ZIP file size in bytes. */
  readonly bytes: number
  /** Where the build stands in the site's malware scan; a site that does not scan offers every build at once, as `clean`. */
  readonly status: WasdDownloadStatus
}

/** One desktop build an export wrote into the project's `.wasdengine/desktop/<platform>/` folder. */
export interface WasdDesktopBuild {
  /** The platform it runs on. */
  readonly platform: WasdDesktopPlatform
  /** Absolute path of the build's ZIP file. */
  readonly file: string
  /** The ZIP file's size in bytes. */
  readonly bytes: number
}

/** A finished desktop export. */
export interface WasdDesktopExport {
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** The builds, in platform order. */
  readonly builds: readonly WasdDesktopBuild[]
  /** The exports' warnings. */
  readonly warnings: readonly string[]
}

/**
 * What the agent's Browser tool asks the window to do on the page of the Session's Browser tab. Element numbers are
 * those of the page text the window last returned for the tab; `x` and `y` are CSS pixels of the page's viewport, which
 * the tool computes from pixels of the latest screenshot. A click names either `element` or both `x` and `y`.
 */
export type WasdBrowserCommand =
  | { readonly kind: 'open'; readonly url: string }
  | { readonly kind: 'read' }
  | { readonly kind: 'click'; readonly element?: number; readonly x?: number; readonly y?: number }
  | { readonly kind: 'type'; readonly element: number; readonly text: string; readonly submit: boolean }
  | { readonly kind: 'screenshot'; readonly element?: number }

/** Limits the window applies to one command, from the plugin's configuration. */
export interface WasdBrowserLimits {
  /** Most characters of page text in an outcome. */
  readonly maxChars: number
  /** Longest wait in milliseconds for a page to finish loading after the command. */
  readonly loadTimeoutMs: number
  /**
   * Longest wait in milliseconds for one operation on the page, such as a script, a screenshot, or an input event,
   * before the command fails; shorter than the tool call's own timeout.
   */
  readonly operationTimeoutMs: number
  /** Largest screenshot width in pixels. */
  readonly screenshotWidth: number
}

/** One command waiting for a window. */
export interface WasdBrowserRequest {
  /** Request id, which the window claims and settles. */
  readonly id: string
  /** The Session whose agent called the tool. */
  readonly sessionId: SessionId
  /** The command. */
  readonly command: WasdBrowserCommand
  /** Its limits. */
  readonly limits: WasdBrowserLimits
}

/** The commands as windows follow them: those no window has claimed yet, and those still waiting for their outcome. */
export interface WasdBrowserRequests {
  /**
   * Id of this command stream, which a window names when it claims a command. When the stream ends, because the window
   * closed, reloaded, or lost its connection, the commands claimed through it fail at once, and a stream the window
   * opens again has a new id.
   */
  readonly follower: string
  /** The commands no window has claimed yet, oldest first. */
  readonly requests: readonly WasdBrowserRequest[]
  /**
   * Ids of the commands a window claimed whose tool call still waits for the outcome. A window stops a command it took
   * once the command's id is in neither list, because its tool call ended, by its timeout or its cancellation.
   */
  readonly claimed: readonly string[]
}

/** The page of the Session's Browser tab after a command. */
export interface WasdBrowserPage {
  /** The page's address. */
  readonly url: string
  /** The page's title. */
  readonly title: string
  /** The page's text with numbered controls; empty for a screenshot. */
  readonly text: string
  /** Whether the text was cut at the command's `maxChars`. */
  readonly truncated: boolean
  /** Whether the page was still loading when the wait ended. */
  readonly loading: boolean
  /** Why the page failed to load, when it did. */
  readonly error?: string
}

/** A screenshot the window took. */
export interface WasdBrowserImage {
  /** The image bytes, base64-encoded. */
  readonly data: string
  /** The image format. */
  readonly mediaType: 'image/jpeg' | 'image/png'
  /** Image width in pixels. */
  readonly width: number
  /** Image height in pixels. */
  readonly height: number
  /** Width in CSS pixels of the viewport the image shows. */
  readonly viewportWidth: number
  /** Height in CSS pixels of the viewport the image shows. */
  readonly viewportHeight: number
}

/** How a command ended: the page afterwards, with a note on how the window carried it out and a screenshot, or why it failed. */
export type WasdBrowserOutcome =
  | { readonly ok: true; readonly page: WasdBrowserPage; readonly note?: string; readonly image?: WasdBrowserImage }
  | { readonly ok: false; readonly message: string }
