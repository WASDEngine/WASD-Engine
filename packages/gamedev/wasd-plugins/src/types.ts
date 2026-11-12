/**
 * Types WASD Engine Plugins shares between its Host service and its browser half.
 * @module @deepseek-ai/dsh-wasd-plugins/types
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'

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

/** The commands no window has claimed yet, as the window follows them. */
export interface WasdBrowserRequests {
  /** The commands, oldest first. */
  readonly requests: readonly WasdBrowserRequest[]
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
