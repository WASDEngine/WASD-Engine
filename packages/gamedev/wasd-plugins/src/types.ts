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
   * The dedicated server build the release stored with this version, for a project whose multiplayer mode is
   * `dedicated`; absent otherwise, and when the server export or its upload failed, which a warning then explains.
   */
  readonly serverBuild?: WasdServerBuild
  /**
   * How the Web build differs from desktop runs, the export's warnings, and what happened to the preview, downloads,
   * credits, and server build.
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
 * A mobile platform a game builds for: `android`, Android phones and tablets with 64-bit ARM processors, or `ios`,
 * iPhone and iPad through an Xcode project.
 */
export type WasdMobilePlatform = 'android' | 'ios'

/** One mobile build an export wrote into the project's `.wasdengine/mobile/<platform>/` folder. */
export interface WasdMobileBuild {
  /** The platform it runs on. */
  readonly platform: WasdMobilePlatform
  /** Absolute path of the Android APK file, or of the iOS Xcode project's `.xcodeproj` folder. */
  readonly file: string
  /** Size in bytes of the APK file, or of the Xcode project with every file it builds from. */
  readonly bytes: number
  /** The app's Android package name or iOS bundle identifier. */
  readonly identifier: string
  /** For Android, the absolute path of the keystore whose key signed the APK. */
  readonly keystore?: string
  /** For Android, whether this export created that keystore. */
  readonly keystoreCreated?: boolean
  /** For iOS, the Team ID the Xcode project signs with; absent when Xcode asks for the team. */
  readonly appleTeamId?: string
}

/** A mobile platform an export could not build, and why. */
export interface WasdMobileFailure {
  /** The platform. */
  readonly platform: WasdMobilePlatform
  /** What went wrong, and what to install or change. */
  readonly error: string
}

/** A finished mobile export: each platform builds on its own, so one can fail while the other builds. */
export interface WasdMobileExport {
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** The builds, in platform order. */
  readonly builds: readonly WasdMobileBuild[]
  /** The platforms that did not build, in platform order. */
  readonly failures: readonly WasdMobileFailure[]
  /** The exports' warnings. */
  readonly warnings: readonly string[]
}

/** A Web build packed into one ZIP file for game sites, in the project's `.wasdengine/web-zip/` folder. */
export interface WasdWebZip {
  /** Absolute path of the ZIP file. */
  readonly file: string
  /** The ZIP file's size in bytes. */
  readonly bytes: number
}

/** A dedicated server build that a release stored. */
export interface WasdServerBuild {
  /** The release it belongs to. */
  readonly version: number
  /** Size of the uploaded archive in bytes. */
  readonly bytes: number
}

/** The links tools asked a window to open that no window took yet. */
export interface WasdLinkRequests {
  /** The links, oldest first; a window claims one before it opens it. */
  readonly links: readonly { readonly id: string; readonly url: string }[]
}

/** One dedicated server as the Multiplayer dialog lists it. */
export interface WasdServerSummary {
  /** The server's id. */
  readonly id: string
  /** The server's name. */
  readonly name: string
  /** Size as the site names it, such as `Small`; the size id when the site sends no name. */
  readonly size: string
  /** State, such as `running` or `stopped_bandwidth`. */
  readonly state: string
  /** Players on the server now. */
  readonly players: number
  /** Share of this month's bandwidth used, 0 to 100, when the site reports it. */
  readonly bandwidthPercent?: number
}

/** A project's multiplayer, as the Multiplayer dialog shows it. */
export interface WasdMultiplayerView {
  /** Whether the folder holds `project.godot`. */
  readonly godot: boolean
  /** The mode the project's `res://wasd_multiplayer.cfg` names; absent before setup. */
  readonly mode?: 'player_hosted' | 'dedicated'
  /** The game the project released to on the site the app is signed in to. */
  readonly game?: WasdReleasedGame
  /** The game's dedicated servers; empty while signed out, before the first release, or in player-hosted mode. */
  readonly servers: readonly WasdServerSummary[]
  /** The site's page that lists the account's servers. */
  readonly serversUrl: string
  /** Why the servers could not be read, when they could not. */
  readonly error?: string
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

/** How a game plays online: `player_hosted`, with one player's game hosting, or `dedicated`, on the game's servers. */
export type WasdMultiplayerMode = 'player_hosted' | 'dedicated'

/**
 * The storage identity that the Play page acquires its guest with through `dshDesktop.browser`. The Desktop shell
 * recognizes the Play page's guest by it, because no Browser tab's storage identity can be it; both sides name the
 * literal through this type, so they cannot differ.
 */
export type WasdPlayStorage = 'wasd-engine-play'

/**
 * Where a game link came from, as the Desktop shell saw it:
 * - `play`: the Play page's own guest navigated its main frame to the link itself while that frame showed a page of
 *   `origin`, as the site's Install button does. Only such a link installs a game, and only when `origin` is the
 *   site's.
 * - `page`: any other page in the app: a Browser tab, the agent's tabs among them, a frame inside a page, a window a
 *   page opened, or a navigation of the Play page's guest that another frame started.
 * - `system`: the operating system, such as a link opened in another application or on the app's command line.
 */
export type DesktopWasdLinkSource =
  | { readonly kind: 'play'; readonly origin: string }
  | { readonly kind: 'page' }
  | { readonly kind: 'system' }

/** A game link the Desktop shell was asked to open. */
export interface DesktopWasdLink {
  /** The `wasdengine://games/<slug>` link; the shell drops `install` from the links of sources that never install. */
  readonly url: string
  /** Where it came from. */
  readonly source: DesktopWasdLinkSource
}

/**
 * The Desktop shell's WASD Engine game links, at `dshDesktop.wasdLinks` of the application page: the
 * `wasdengine://games/<slug>` links that the system or a Browser or Play page asked the app to open, such as the
 * site's Install buttons, which carry `install=1` and, for an earlier version of a single-player game, `v=<n>`. The
 * shell keeps them, each with its source, until the page takes them, also the one that started the app. It passes a
 * link that repeats one of the same source within seconds once, and a few links of one source a minute at most, so no
 * page can keep pulling the window to the Play page.
 */
export interface DesktopWasdLinksBridge {
  /** @returns the links that waited, oldest first; each is handed out once. */
  take(): Promise<DesktopWasdLink[]>
  /**
   * Hear about new links, which {@link DesktopWasdLinksBridge.take} then returns.
   * @param listener - called after links arrive.
   * @returns the function that stops listening.
   */
  subscribe(listener: () => void): () => void
}

/**
 * Where an installed game stands on the site when the site no longer offers it, as the site answered when the library
 * last asked: `taken_down` when WASD Engine took it down, after which it never starts, or `removed` when its creator
 * removed it, after which it starts only once the player confirms.
 */
export type WasdLibraryAvailability = 'taken_down' | 'removed'

/** A game the library installed on this computer. */
export interface WasdLibraryGame {
  /** The game's id on the site. */
  readonly id: string
  /** The game's address on the site, `/games/<slug>`. */
  readonly slug: string
  /** Game title. */
  readonly title: string
  /** The installed version. */
  readonly version: number
  /** The site's latest version when the library last asked. */
  readonly latestVersion: number
  /**
   * The newest version whose build for this computer the site offered when the library last asked, while it is newer
   * than `version`: `latestVersion`, or an earlier version when the later ones have no build for this computer's
   * system. A single-player game offers it as Update; absent when there is none or the game is no longer offered.
   */
  readonly updateVersion?: number
  /**
   * `latestVersion`, while it is newer than `version` and the site offered no build of it for this computer when the
   * library last asked. An online game does not start until it has one, because online play needs the latest version.
   */
  readonly unavailableVersion?: number
  /** Where the game stands on the site once the site no longer offers it; absent while it does, or before the library asked. */
  readonly availability?: WasdLibraryAvailability
  /** How the game plays online; absent for a single-player game. An online game starts only at its latest version. */
  readonly multiplayer?: WasdMultiplayerMode
  /** The platform of the installed build. */
  readonly platform: WasdDesktopPlatform
  /** Size of the downloaded build in bytes. */
  readonly bytes: number
  /** When it was installed, in ISO 8601. */
  readonly installedAt: string
  /** The game's picture on the site, when it has one. */
  readonly coverUrl?: string
}

/** A download and installation the library is working on, or one that failed. */
export interface WasdLibraryTask {
  /** The game's address on the site. */
  readonly slug: string
  /** Game title, once the site named it. */
  readonly title: string
  /** The version it installs, once the site named it; 0 before. */
  readonly version: number
  /** `downloading`, `installing` (unpacking), or `failed`. */
  readonly state: 'downloading' | 'installing' | 'failed'
  /** Bytes received so far. */
  readonly receivedBytes: number
  /** Bytes of the whole download; 0 before the site named its size. */
  readonly totalBytes: number
  /** Why it failed, for a failed task. */
  readonly message?: string
  /** The game's picture on the site, once the site named the game and when it has one. */
  readonly coverUrl?: string
}

/** The library: the games installed on this computer, the last started first, and the tasks in progress. */
export interface WasdLibraryView {
  /** Installed games. */
  readonly games: readonly WasdLibraryGame[]
  /** Downloads in progress, and failed ones until they are dismissed or retried. */
  readonly tasks: readonly WasdLibraryTask[]
  /** Whether games install on this computer: Windows or macOS; the site has builds for no other system. */
  readonly supported: boolean
}

/**
 * Why the library refused to start a game, which the Play page says in the player's language: WASD Engine took the
 * game down (`taken_down`); its creator removed it and the player did not confirm Play anyway (`removed`); or its
 * latest version, which online play needs, has no build for this computer yet (`unavailable`, with that `version`).
 */
export type WasdLibraryRefusal =
  | { readonly reason: 'taken_down' }
  | { readonly reason: 'removed' }
  | { readonly reason: 'unavailable'; readonly version: number }

/** What happened to a library request: done, or why not, with the refusal when the library refused to start a game. */
export type WasdLibraryOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string; readonly refusal?: WasdLibraryRefusal }
