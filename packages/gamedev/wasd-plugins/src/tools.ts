/**
 * The model-facing tools of WASD Engine Plugins: `wasd_export_web` builds a Godot project for the Web,
 * `wasd_export_desktop` builds it for Windows and macOS, `wasd_export_mobile` builds it for Android and iOS,
 * `wasd_record_preview` records the game's preview, an
 * animation for the site, a GIF for link previews, and a still, and `wasd_release_game` builds the project and
 * publishes the build as the next version of its game on the WASD Engine site, public or private, with the preview
 * and, when asked, desktop downloads. The same
 * definitions serve the Session's own agent, which may name the project relative to its working directory, and agents
 * connected through WASD Engine's MCP server, which name it by absolute path, run the game in a Session of theirs, and
 * name their own model for the game's credits, which a release's call credits before the release collects them.
 * @module @deepseek-ai/dsh-wasd-plugins/src/tools
 */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { APPLE_TEAM_ID, type GodotWebCheck, type GodotWebExport } from '@deepseek-ai/dsh-godot'
import type { GameMcpClient, GameMcpContent, GameMcpProvider, GameMcpTool, JsonObject } from '@deepseek-ai/dsh-game-mcp'
import { defineTool, type InferValue, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { IMAGE_SCHEMA, type StoredScreenshot } from './browser.ts'
import { MAX_MODEL_NAME } from './credits.ts'
import { MOBILE_PLATFORM_NAMES, MOBILE_PLATFORMS } from './exports.ts'
import { DESKTOP_PLATFORMS, MAX_NOTES, MAX_TITLE, PLATFORM_NAMES, type ReleaseRequest } from './release.ts'
import type {
  WasdDesktopExport, WasdDesktopPlatform, WasdDownloadStatus, WasdMobileExport, WasdMobilePlatform, WasdRelease, WasdWebZip,
} from './types.ts'
import { formatWebCheck } from './web-check-text.ts'

/** What a preview recording asks for. */
export interface PreviewRequest {
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** Length of the clip in seconds. */
  readonly seconds: number
  /** Seconds into the clip of the still. Default: the middle. */
  readonly stillAt?: number
  /** Input played from the start of the recording, as `godot_input` takes it; the Godot plugin validates it. */
  readonly events?: readonly unknown[]
  /** Unit of the events' pointer coordinates. Default: `screenshot`. */
  readonly coordinateSpace?: 'screenshot' | 'window'
}

/** A recorded preview, saved in the project's preview folder. */
export interface RecordedPreview {
  /** Absolute path of the GIF, which link previews of the game's share link show. */
  readonly gif: string
  /** Absolute path of the animation, the animated WebP that Explore and the game's page play. */
  readonly webp: string
  /** Absolute path of the still. */
  readonly image: string
  /** Frames in the GIF. */
  readonly frames: number
  /** Playing time of the GIF in seconds. */
  readonly seconds: number
  /** GIF width in pixels. */
  readonly width: number
  /** GIF height in pixels. */
  readonly height: number
  /** GIF size in bytes. */
  readonly gifBytes: number
  /** Animation width in pixels. */
  readonly webpWidth: number
  /** Animation height in pixels. */
  readonly webpHeight: number
  /** Animation size in bytes. */
  readonly webpBytes: number
  /** Still width in pixels. */
  readonly imageWidth: number
  /** Still height in pixels. */
  readonly imageHeight: number
  /** Still size in bytes. */
  readonly imageBytes: number
  /** Whether the recording started the game, because none ran. */
  readonly started: boolean
  /** Whether the game was paused in every frame. */
  readonly paused: boolean
  /** The still as the calling Session's model receives it; absent when that model cannot see images. */
  readonly view?: StoredScreenshot
}

/** The preview lengths the tools offer, from the plugin's configuration. */
export interface PreviewLengths {
  /** Default clip length in seconds. */
  readonly seconds: number
  /** Longest clip in seconds. */
  readonly maxSeconds: number
}

/** What the tools need from the plugin. */
export interface WasdToolHost {
  /**
   * The project folder of one call.
   * @param requested - the folder the call names: absolute, or relative to the calling Session's working directory;
   * undefined for the nearest project.
   * @param exec - the call's execution.
   * @returns the absolute folder holding `project.godot`.
   */
  project(requested: string | undefined, exec: ToolRunContext): Promise<string>
  /**
   * A file path of one call.
   * @param requested - absolute, or relative to the calling Session's working directory.
   * @param exec - the call's execution.
   * @returns the absolute path.
   */
  file(requested: string, exec: ToolRunContext): Promise<string>
  /**
   * Export a project for the Web into its `.wasdengine/web` folder.
   * @param projectDir - absolute project folder.
   * @param zip - whether to also pack the build into one ZIP file in its `.wasdengine/web-zip` folder.
   * @param signal - cancellation.
   * @returns the exported files, and the ZIP file when `zip` asked for one.
   */
  exportWeb(projectDir: string, zip: boolean, signal: AbortSignal): Promise<GodotWebExport & { readonly zip?: WasdWebZip }>
  /**
   * Check a Web build in a browser: watch the game start and run without input.
   * @param outputDir - absolute folder of the Web build.
   * @param signal - cancellation.
   * @returns what the check saw.
   * @throws {Error} with the reason when the check cannot run.
   */
  checkWeb(outputDir: string, signal: AbortSignal): Promise<GodotWebCheck>
  /**
   * Export a project for desktop platforms into its `.wasdengine/desktop/<platform>` folders, one platform after the
   * other.
   * @param projectDir - absolute project folder.
   * @param platforms - the platforms, in the order they build.
   * @param signal - cancellation.
   * @returns the builds.
   */
  exportDesktop(projectDir: string, platforms: readonly WasdDesktopPlatform[], signal: AbortSignal): Promise<WasdDesktopExport>
  /**
   * Export a project for mobile platforms into its `.wasdengine/mobile/<platform>` folders, one platform after the
   * other; a platform that fails is reported, and the others still build.
   * @param projectDir - absolute project folder.
   * @param platforms - the platforms, in the order they build.
   * @param appleTeamId - the Team ID the iOS Xcode project signs with; undefined finds the Mac's one team, else none.
   * @param signal - cancellation.
   * @returns the builds and the platforms that failed.
   * @throws {Error} with every platform's failure when none builds.
   */
  exportMobile(
    projectDir: string, platforms: readonly WasdMobilePlatform[], appleTeamId: string | undefined, signal: AbortSignal,
  ): Promise<WasdMobileExport>
  /**
   * Record the game's preview in the Session of the call's Agent and save it in the project's preview folder.
   * @param request - project, length, input, and the still's moment.
   * @param exec - the call's execution.
   * @returns the saved preview.
   */
  recordPreview(request: PreviewRequest, exec: ToolRunContext): Promise<RecordedPreview>
  /**
   * Export a project for the Web and release the build with the game's preview and what the game was made with.
   * @param request - project, notes, title, preview files, and whether to start a new game.
   * @param exec - the call's execution: its cancellation, and its Agent, whose Session can record a missing preview.
   * @param audience - who releases: a Session's own agent, whose model the release credits, or a connected agent, whom
   *   its call credited already ({@link ConnectedCredits.claim}), in a Session that runs the window's model.
   * @returns the release.
   */
  release(request: ReleaseRequest, exec: ToolRunContext, audience: WasdToolAudience): Promise<WasdRelease>
}

/** Who calls the tools: a Session's own agent, or an agent connected through WASD Engine's MCP server. */
export type WasdToolAudience = 'session' | 'connected'

/** What the MCP tools need from the plugin's credits. */
export interface ConnectedCredits {
  /**
   * Credit the project that a connected agent's release names: with the agent, by the model the release names, else by
   * the model its application named for the project last, else by its application's name, and with the tools that agent
   * used before it named a project.
   * @param client - the connected agent.
   * @param project - absolute folder holding `project.godot`, as the release names it.
   * @param model - the name of the model the agent says it is, as the release gave it; undefined when it gave none.
   * @param signal - cancellation.
   * @returns once the project's credits hold them; a project that cannot be read, or whose credits cannot be written,
   *   credits nothing.
   */
  claim(client: GameMcpClient, project: string, model: string | undefined, signal: AbortSignal): Promise<void>
}

const STRING = { type: 'string', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const NUMBER = { type: 'number', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const
const WARNINGS = { type: 'array', required: true, items: { type: 'string' } } as const

const PROJECT = {
  type: 'string',
  description: 'Folder containing project.godot, relative to the working directory. Default: the nearest one.',
} as const

const ZIP = {
  type: 'boolean',
  description: 'true also packs the build into one ZIP file named after the game, with index.html at its root, in the project\'s .wasdengine/web-zip folder: the file game sites such as itch.io take as an HTML5 game. Default: false.',
} as const

const CHECK = {
  type: 'boolean',
  description: 'false skips the Web check, which opens the exported build in a browser of WASD Engine\'s own, watches the game start and run for a short while without input, and reports how long it took to start, how long the page froze, its frame rate and draw calls, and the errors and warnings it printed, with what they mean for players. Default: true.',
} as const

const WEB_CHECK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    seconds: NUMBER,
    started: BOOLEAN,
    startSeconds: { type: 'number' },
    readySeconds: { type: 'number' },
    longestFreezeSeconds: NUMBER,
    freezes: INTEGER,
    fps: { type: 'number' },
    slowestFrameMs: { type: 'number' },
    drawCalls: { type: 'object', additionalProperties: false, properties: { median: NUMBER, max: NUMBER } },
    programs: INTEGER,
    messages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { level: STRING, text: STRING, count: INTEGER } } },
    moreMessages: INTEGER,
    findings: { type: 'array', required: true, items: { type: 'string' } },
    crashed: { type: 'string' },
  },
} as const

/**
 * Describe a tool's Web check, or why it could not run.
 * @param value - the result's check fields.
 * @returns the paragraphs to add, none when the call skipped the check.
 */
function webCheckText(value: { readonly webCheck?: WebCheckValue; readonly webCheckError?: string }): string[] {
  if (value.webCheck !== undefined) return [formatWebCheck(value.webCheck)]
  return value.webCheckError === undefined ? [] : [`Web check: it could not run: ${value.webCheckError}`]
}

/**
 * Run a Web check for a tool call and settle it into the result's check fields; a check that cannot run never fails the call.
 * @param host - plugin operations.
 * @param outputDir - absolute folder of the Web build.
 * @param signal - the call's cancellation, which still cancels the call.
 * @returns the check's report, or why it could not run.
 */
async function webCheckFields(
  host: WasdToolHost, outputDir: string, signal: AbortSignal,
): Promise<{ webCheck: WebCheckValue } | { webCheckError: string }> {
  try {
    return { webCheck: copyWebCheck(await host.checkWeb(outputDir, signal)) }
  } catch (error) {
    signal.throwIfAborted()
    return { webCheckError: (error as Error).message }
  }
}

/** A Web check as tool results carry it. */
type WebCheckValue = InferValue<typeof WEB_CHECK_SCHEMA>

/**
 * Copy a Web check into a tool result's value.
 * @param check - the report.
 * @returns the copy.
 */
function copyWebCheck(check: GodotWebCheck): WebCheckValue {
  return {
    ...check,
    ...check.drawCalls === undefined ? {} : { drawCalls: { ...check.drawCalls } },
    messages: check.messages.map(message => ({ ...message })),
    findings: [...check.findings],
  }
}

const RECORDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    gif: STRING,
    webp: STRING,
    image: STRING,
    frames: INTEGER,
    seconds: NUMBER,
    width: INTEGER,
    height: INTEGER,
    gifBytes: INTEGER,
    webpWidth: INTEGER,
    webpHeight: INTEGER,
    webpBytes: INTEGER,
    imageWidth: INTEGER,
    imageHeight: INTEGER,
    imageBytes: INTEGER,
    started: BOOLEAN,
    paused: BOOLEAN,
    view: {
      type: 'object',
      additionalProperties: false,
      properties: { width: INTEGER, height: INTEGER, image: IMAGE_SCHEMA },
    },
  },
} as const

/** A `wasd_record_preview` result. */
export type RecordedPreviewValue = InferValue<typeof RECORDING_SCHEMA>

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : megabytes(bytes)
}

/** What each platform's build holds and where it runs, as results describe it. */
const BUILD_CONTENTS: Readonly<Record<WasdDesktopPlatform, string>> = {
  windows: 'a ZIP file with one .exe that holds the whole game, for 64-bit Windows',
  macos: 'a ZIP file with the game\'s Mac app, for Intel and Apple silicon Macs',
}

/** How players get a release's desktop builds. */
const INSTALLED_BY_APP = 'Players get the downloads through the share page\'s Install with WASD Engine button: the WASD Engine app installs the build for their computer, keeps it up to date, and starts it.'

/** How a downloaded build first opens, which every desktop result says, since neither build has a publisher's signature. */
const FIRST_OPEN = 'Neither build is signed by a publisher, so a downloaded copy asks before it first runs: on Windows, SmartScreen\'s "Windows protected your PC" needs More info, then Run anyway; on a Mac, Gatekeeper blocks the first open until the user chooses Open Anyway in System Settings > Privacy & Security.'

/** What a release result adds after a download's size when the share page does not offer the download yet, or never will. */
const SCAN_STANDING: Readonly<Record<WasdDownloadStatus, string>> = {
  clean: '',
  pending: ', being scanned for malware',
  flagged: ', flagged as malware: never offered',
  failed: ', not scannable for malware: never offered',
}

/**
 * What a release result says about where the share page offers its downloads, with the first-run note while any of them
 * is offered or waits on its scan.
 * @param statuses - each download's scan status.
 * @returns the note.
 */
function downloadsNote(statuses: readonly WasdDownloadStatus[]): string {
  if (statuses.every(status => status === 'clean')) return INSTALLED_BY_APP
  return [
    'WASD Engine scans each download for malware before the share page offers it.',
    ...statuses.includes('pending') ? ['A download being scanned becomes installable from the share page once the scan passes, usually within a few minutes.'] : [],
    ...statuses.some(status => status === 'flagged' || status === 'failed') ? ['A download the scan flagged or could not scan is never offered.'] : [],
    ...statuses.some(status => status === 'clean' || status === 'pending') ? [INSTALLED_BY_APP] : [],
  ].join(' ')
}

const PLATFORMS_SCHEMA = { type: 'array', items: { type: 'string', enum: DESKTOP_PLATFORMS } } as const

const MOBILE_PLATFORMS_SCHEMA = { type: 'array', items: { type: 'string', enum: MOBILE_PLATFORMS } } as const

/** How the user gets an Android build onto a device, and keeps its key. */
function androidNote(build: { readonly keystore?: string; readonly keystoreCreated?: boolean }): string {
  return [
    'To install it, copy it to the phone or tablet and open it there, allowing installs from that app when Android asks, or run adb install with the device connected.',
    'Stores that take APK files take it as it is; Google Play takes new apps only as Android App Bundles, which this export does not build.',
    ...build.keystore === undefined ? [] : [
      `It is signed with ${build.keystoreCreated === true ? 'a key the export just created for' : 'the key of'} this computer's Android builds, ${build.keystore}: keep a copy of that file and of release-key.json beside it, since an installed app updates only to a build signed with the same key.`,
    ],
  ].join(' ')
}

/** How the user turns an iOS build into the app. */
function iosNote(build: { readonly appleTeamId?: string }): string {
  return [
    'Open it in Xcode on a Mac;',
    build.appleTeamId === undefined
      ? 'Xcode asks for the Apple developer team to sign with, under Signing & Capabilities, where a free Apple account works for the user\'s own devices.'
      : `it signs with the Apple developer team ${build.appleTeamId}, which Signing & Capabilities can change.`,
    'Then Run installs it on a connected iPhone or iPad, and Product > Archive builds it for TestFlight and the App Store, which need a paid Apple Developer Program membership.',
  ].join(' ')
}

/** What each mobile build holds, by platform, as results describe it. */
const MOBILE_CONTENTS: Readonly<Record<WasdMobilePlatform, string>> = {
  android: 'an APK file for Android phones and tablets with 64-bit ARM processors',
  ios: 'an Xcode project for iPhone and iPad, with the files it builds from beside it',
}

/**
 * The mobile platforms of a call, each once, in build order.
 * @param requested - the call's platforms; undefined picks every platform.
 * @returns the platforms.
 */
function mobilePlatformsOf(requested: readonly WasdMobilePlatform[] | undefined): WasdMobilePlatform[] {
  if (requested === undefined) return [...MOBILE_PLATFORMS]
  return MOBILE_PLATFORMS.filter(platform => requested.includes(platform))
}

/**
 * The platforms of a call, each once, in build order.
 * @param requested - the call's platforms; undefined picks every platform.
 * @returns the platforms.
 */
function platformsOf(requested: readonly string[] | undefined): WasdDesktopPlatform[] {
  if (requested === undefined) return [...DESKTOP_PLATFORMS]
  for (const platform of requested) {
    if (!(DESKTOP_PLATFORMS as readonly string[]).includes(platform)) throw new Error(`platforms are ${DESKTOP_PLATFORMS.map(item => `"${item}"`).join(' and ')}, not ${JSON.stringify(platform)}.`)
  }
  return DESKTOP_PLATFORMS.filter(platform => requested.includes(platform))
}

function withWarnings(text: string, warnings: readonly string[]): string {
  return warnings.length === 0 ? text : `${text}\nNotes:\n${warnings.map(warning => `- ${warning}`).join('\n')}`
}

function describeRecording(value: RecordedPreviewValue): string {
  return [
    `Recorded the game's preview: the animation ${value.webp} (${value.webpWidth}x${value.webpHeight}, ${size(value.webpBytes)}) that Explore and the game's page play, the GIF ${value.gif} (${value.frames} frames, ${value.seconds.toFixed(1)} s, ${value.width}x${value.height}, ${size(value.gifBytes)}) that link previews of its share link show, and the still ${value.image} (${value.imageWidth}x${value.imageHeight}, ${size(value.imageBytes)}). wasd_release_game uploads them with the next release.`,
    ...value.started ? ['The recording started the game, which keeps running.'] : [],
    ...value.paused ? ['The game was paused throughout, so the preview shows no motion: resume it with godot_control, then record again.'] : [],
    ...value.view === undefined ? [] : ['The image below is the still.'],
  ].join('\n')
}

/**
 * Build the WASD Engine Plugins tool definitions.
 * @param host - plugin operations the tools call.
 * @param lengths - the preview lengths the recording tool offers.
 * @param audience - who calls them: for connected agents, the release also takes the name of the agent's model.
 * @returns the definitions, not registered.
 */
export function wasdToolDefinitions(host: WasdToolHost, lengths: PreviewLengths, audience: WasdToolAudience = 'session'): ToolDefinition[] {
  return [defineTool({
    name: 'wasd_export_web',
    description: 'Export the Godot project for the Web with the built-in Godot: a single-threaded HTML5 build (index.html, index.js, index.wasm, index.pck) in the project\'s .wasdengine/web folder, which any static web server can serve, and with zip also one ZIP file of it for game sites such as itch.io. The Web build renders with the Compatibility renderer. Then a Web check opens the build in a browser and reports what players would meet: freezes, frame rate, and the errors the build printed. The first export downloads Godot\'s Web template, about 10 MB. To publish the game on WASD Engine for others to play, call wasd_release_game instead.',
    parameters: { project: PROJECT, check: CHECK, zip: ZIP },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectDir: STRING,
          outputDir: STRING,
          entry: STRING,
          files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { path: STRING, bytes: INTEGER } } },
          totalBytes: INTEGER,
          zip: { type: 'object', additionalProperties: false, properties: { file: STRING, bytes: INTEGER } },
          warnings: WARNINGS,
          webCheck: WEB_CHECK_SCHEMA,
          webCheckError: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: withWarnings(
          [
            `Exported ${value.projectDir} for the Web into ${value.outputDir}: ${value.files.map(file => file.path).join(', ')} (${megabytes(value.totalBytes)}). Open ${value.entry} through a web server, not from the file system.`,
            ...value.zip === undefined ? [] : [`Packed it into ${value.zip.file} (${megabytes(value.zip.bytes)}), with index.html at its root: upload that file to a game site such as itch.io as an HTML5 game, or unpack it on any static web server.`],
            ...webCheckText(value),
          ].join('\n'),
          value.warnings,
        ),
      }],
    },
    async execute(args, exec) {
      const exported = await host.exportWeb(await host.project(args.project, exec), args.zip === true, exec.signal)
      const checked = args.check === false ? {} : await webCheckFields(host, exported.outputDir, exec.signal)
      return {
        ...exported, files: exported.files.map(file => ({ ...file })), warnings: [...exported.warnings],
        ...exported.zip === undefined ? {} : { zip: { ...exported.zip } }, ...checked,
      }
    },
  }), defineTool({
    name: 'wasd_export_desktop',
    description: 'Export the Godot game for desktop computers with the built-in Godot, one ZIP file per platform in the project\'s .wasdengine/desktop folder: windows holds one .exe with the whole game for 64-bit Windows, and macos holds the game\'s Mac app for Intel and Apple silicon Macs, signed ad hoc. The user can share the files or upload them anywhere. The first export for each platform downloads its Godot template, about 38 MB for Windows and 123 MB for macOS. To offer the builds as downloads on the game\'s WASD Engine page, pass desktop to wasd_release_game instead.',
    parameters: {
      project: PROJECT,
      platforms: { ...PLATFORMS_SCHEMA, description: 'The platforms to build for. Default: both, ["windows", "macos"].' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectDir: STRING,
          builds: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { platform: STRING, file: STRING, bytes: INTEGER } } },
          warnings: WARNINGS,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: withWarnings([
          `Exported ${value.projectDir} for desktop computers:`,
          ...value.builds.map(build => `- ${PLATFORM_NAMES[build.platform as WasdDesktopPlatform]}: ${build.file} (${megabytes(build.bytes)}), ${BUILD_CONTENTS[build.platform as WasdDesktopPlatform]}.`),
          FIRST_OPEN,
        ].join('\n'), value.warnings),
      }],
    },
    async execute(args, exec) {
      const platforms = platformsOf(args.platforms)
      if (platforms.length === 0) throw new Error('platforms must name at least one of "windows" and "macos".')
      const exported = await host.exportDesktop(await host.project(args.project, exec), platforms, exec.signal)
      return { projectDir: exported.projectDir, builds: exported.builds.map(build => ({ ...build })), warnings: [...exported.warnings] }
    },
  }), defineTool({
    name: 'wasd_export_mobile',
    description: 'Export the Godot game for phones and tablets with the built-in Godot, into the project\'s .wasdengine/mobile folder: android builds one APK file for Android phones and tablets with 64-bit ARM processors, signed and ready to install, and ios builds an Xcode project, which Xcode on a Mac turns into the iPhone and iPad app. An Android export needs a Java runtime and the Android SDK on this computer, which Android Studio installs, and signs every Android build of this computer\'s games with one key, which the first Android export creates. A platform that cannot build is reported while the other still builds. The first export for each platform downloads its Godot template, about 99 MB for Android and 189 MB for iOS.',
    parameters: {
      project: PROJECT,
      platforms: { ...MOBILE_PLATFORMS_SCHEMA, description: 'The platforms to build for. Default: both, ["android", "ios"].' },
      apple_team_id: { type: 'string', description: 'The Apple Developer Team ID, 10 capital letters and digits such as ABCDE12345, that the iOS Xcode project signs with, when the user gives one. Default: the one team of this Mac\'s Apple Development certificates; without one, Xcode asks for the team.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectDir: STRING,
          builds: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: STRING, file: STRING, bytes: INTEGER, identifier: STRING,
                keystore: { type: 'string' }, keystoreCreated: { type: 'boolean' }, appleTeamId: { type: 'string' },
              },
            },
          },
          failures: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { platform: STRING, error: STRING } } },
          warnings: WARNINGS,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: withWarnings([
          `Exported ${value.projectDir} for phones and tablets:`,
          ...value.builds.map((build) => {
            const platform = build.platform as WasdMobilePlatform
            const what = `- ${MOBILE_PLATFORM_NAMES[platform]}: ${build.file} (${megabytes(build.bytes)}), ${MOBILE_CONTENTS[platform]}, ${platform === 'android' ? 'package' : 'bundle identifier'} ${build.identifier}.`
            return `${what} ${platform === 'android' ? androidNote(build) : iosNote(build)}`
          }),
          ...value.failures.map(failure => `- ${MOBILE_PLATFORM_NAMES[failure.platform as WasdMobilePlatform]} did not build: ${failure.error}`),
        ].join('\n'), value.warnings),
      }],
    },
    async execute(args, exec) {
      const platforms = mobilePlatformsOf(args.platforms)
      if (platforms.length === 0) throw new Error('platforms must name at least one of "android" and "ios".')
      if (args.apple_team_id !== undefined && !APPLE_TEAM_ID.test(args.apple_team_id)) {
        throw new Error(`apple_team_id is 10 capital letters and digits, such as ABCDE12345, not ${JSON.stringify(args.apple_team_id)}.`)
      }
      const exported = await host.exportMobile(await host.project(args.project, exec), platforms, args.apple_team_id, exec.signal)
      return {
        projectDir: exported.projectDir,
        builds: exported.builds.map(build => ({ ...build })),
        failures: exported.failures.map(failure => ({ ...failure })),
        warnings: [...exported.warnings],
      }
    },
  }), defineTool({
    name: 'wasd_record_preview',
    description: 'Record the game\'s preview for WASD Engine: a few seconds of the running game as an animation that Explore and the game\'s page play and a GIF that link previews of its share link show, and a still image, which wasd_release_game uploads. First start the game with godot_run and bring it to its gameplay, such as past its title menu; events then play from the start of the recording, as godot_input takes them, so the clip shows the game in action. Without a running game, the recording starts the game and records its first seconds. The result shows the still: when it does not show the game well, record again. Each recording replaces the project\'s previous preview in its .wasdengine/preview folder.',
    parameters: {
      project: PROJECT,
      seconds: { type: 'number', description: `Length of the clip in seconds, from 1 to ${lengths.maxSeconds}. Default: ${lengths.seconds}.` },
      events: {
        type: 'array',
        items: { type: 'object', additionalProperties: true },
        description: 'Input played in order from the start of the recording, in the event format of godot_input: keys, typed text, mouse buttons and motion, input actions, joypad events, and { "wait": seconds }. What still plays when the clip ends is released.',
      },
      coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of the events\' x, y, dx, dy: pixels of the latest godot_screenshot (default) or of the game window.' },
      still_at: { type: 'number', description: 'Seconds into the clip at which the still is taken. Default: the middle.' },
    },
    output: {
      schema: RECORDING_SCHEMA,
      render: (_args, value) => [
        { type: 'text', text: describeRecording(value) },
        ...value.view === undefined ? [] : [{ type: 'image' as const, attachment: { ...value.view.image, attachmentId: brandString<AttachmentId>(value.view.image.attachmentId) } }],
      ],
    },
    async execute(args, exec) {
      const seconds = args.seconds ?? lengths.seconds
      if (!(seconds >= 1 && seconds <= lengths.maxSeconds)) throw new Error(`seconds must be from 1 to ${lengths.maxSeconds}.`)
      if (args.still_at !== undefined && !(args.still_at >= 0 && args.still_at <= seconds)) throw new Error(`still_at must be from 0 to ${seconds}.`)
      const projectDir = await host.project(args.project, exec)
      const recorded = await host.recordPreview({
        projectDir,
        seconds,
        ...args.still_at === undefined ? {} : { stillAt: args.still_at },
        ...args.events === undefined ? {} : { events: args.events },
        ...args.coordinate_space === undefined ? {} : { coordinateSpace: args.coordinate_space },
      }, exec)
      return { ...recorded, ...recorded.view === undefined ? {} : { view: { ...recorded.view, image: { ...recorded.view.image } } } }
    },
  }), releaseDefinition(host, audience)]
}

/** Description of the release's `model` argument, which only connected agents get. */
const MODEL_ARGUMENT = `The name of the AI model you are, as its maker writes it, such as Claude Opus 5.5; at most ${MAX_MODEL_NAME} characters. The game's page credits it beside the game tools and add-ons that made the game. Default: the model you named for this project before, else your application's name.`

/**
 * Build the release tool.
 * @param host - plugin operations the tool calls.
 * @param audience - who calls it: a connected agent's release also takes the name of its model.
 * @returns the definition.
 */
function releaseDefinition(host: WasdToolHost, audience: WasdToolAudience): ToolDefinition {
  return defineTool({
    name: 'wasd_release_game',
    description: 'Release the Godot game on WASD Engine: export it for the Web, upload the build as the game\'s next version (1, 2, 3, ...) with its preview, and return its share link, where anyone with the link can play it in a browser, switch to earlier versions, and comment. A public game is also listed on WASD Engine\'s Explore page; a private one is not, so only people with its link find it. With desktop, the release also builds the game for Windows and macOS and offers each build as a download on the game\'s page. The preview is the animation, GIF, and still that wasd_record_preview saved, unless preview_gif or preview_image name other files; record it first, so Explore, the game\'s page, and the share link show the game in action. A game that has no preview on WASD Engine yet and none to upload gets the first seconds of the game recorded without input. The first release creates the game, titled from project.godot unless title is given; later releases add versions to it, unless new_game starts a new game. The game\'s page credits what made the game: your model, the game tools that worked on the project, and its add-ons. A game set up for a dedicated server also gets its server build stored with the version, and its servers switch to it. Every call publishes a new version, so call it only when the user asks to release, publish, or share the game.',
    parameters: {
      project: PROJECT,
      notes: { type: 'string', description: `What changed in this version, shown on the game page; at most ${MAX_NOTES} characters.` },
      title: { type: 'string', description: `Game title for the first release, or a new title for the game; at most ${MAX_TITLE} characters. Default: the project's name.` },
      preview_image: { type: 'string', description: 'PNG, JPEG, or WebP picture that Explore shows for the game, relative to the working directory; 16:9 fits best. Default: the still that wasd_record_preview saved.' },
      preview_gif: { type: 'string', description: 'Animated GIF that link previews of the share link show, and that Explore and the game\'s page then play in place of the recorded animation, relative to the working directory. Default: the GIF that wasd_record_preview saved, with its animation.' },
      new_game: { type: 'boolean', description: 'true releases the build as version 1 of a new game, which the project releases to from then on. false adds the version to the game the project released to before, also when another project folder on this computer releases that game, as a copy does. Leave it out unless the user chose; such a folder then fails with the question to ask the user.' },
      visibility: { type: 'string', enum: ['public', 'private'], description: 'public lists the game on WASD Engine\'s Explore page; private keeps it off Explore, so only people with its link can find it. The choice applies to the whole game from this version on. Default: the game\'s current visibility; a new game is public.' },
      desktop: { ...PLATFORMS_SCHEMA, description: 'Also build the game for these desktop platforms and offer each build as a download of this version on the game\'s page: windows, one .exe for 64-bit Windows, and macos, a Mac app for Intel and Apple silicon. The first build for each platform downloads its Godot template, about 38 MB for Windows and 123 MB for macOS. Default: none.' },
      check: CHECK,
      ...audience === 'connected' ? { model: { type: 'string', description: MODEL_ARGUMENT } } : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: STRING,
          version: INTEGER,
          url: STRING,
          gameUrl: STRING,
          playUrl: STRING,
          totalBytes: INTEGER,
          visibility: STRING,
          downloads: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: { platform: STRING, url: STRING, bytes: INTEGER, status: STRING } } },
          credits: { type: 'array', items: { type: 'string' } },
          serverBuild: {
            type: 'object',
            additionalProperties: false,
            description: 'The dedicated server build stored with this version.',
            properties: { version: INTEGER, bytes: INTEGER },
          },
          warnings: WARNINGS,
          webCheck: WEB_CHECK_SCHEMA,
          webCheckError: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: withWarnings([
          `Released ${value.title} version ${value.version} (${megabytes(value.totalBytes)}).`,
          value.visibility === 'private'
            ? 'The game is private: Explore does not list it, so only people with its link can find it.'
            : 'The game is public: Explore lists it.',
          `Share link: ${value.gameUrl}`,
          `This version: ${value.url}`,
          ...value.downloads.map(download => `${PLATFORM_NAMES[download.platform as WasdDesktopPlatform]} download: ${download.url} (${megabytes(download.bytes)}${SCAN_STANDING[download.status as WasdDownloadStatus]})`),
          ...value.credits === undefined ? [] : [`Made with, as the game's page credits it: ${value.credits.join(', ')}.`],
          ...value.serverBuild === undefined ? [] : [`Server build: stored for version ${value.serverBuild.version} (${megabytes(value.serverBuild.bytes)}); the game's dedicated servers switch to it after a 60-second warning to their players.`],
          'The share page plays the latest version, lists the earlier ones with their release dates, and takes comments.',
          ...value.downloads.length === 0 ? [] : [downloadsNote(value.downloads.map(download => download.status as WasdDownloadStatus))],
          'Sent in Messages or posted on Reddit, Discord, Slack, or Telegram, the share link shows the game\'s GIF (its picture while it has none); opened in a browser, it plays the game.',
          ...webCheckText(value),
        ].join('\n'), value.warnings),
      }],
    },
    async execute(args, exec) {
      const projectDir = await host.project(args.project, exec)
      const previewImage = args.preview_image === undefined ? undefined : await host.file(args.preview_image, exec)
      const previewGif = args.preview_gif === undefined ? undefined : await host.file(args.preview_gif, exec)
      const { credits, warnings, ...released } = await host.release({
        projectDir,
        ...args.notes === undefined ? {} : { notes: args.notes },
        ...args.title === undefined ? {} : { title: args.title },
        ...previewImage === undefined ? {} : { previewImage },
        ...previewGif === undefined ? {} : { previewGif },
        ...args.new_game === undefined ? {} : { newGame: args.new_game },
        ...args.visibility === undefined ? {} : { visibility: args.visibility },
        ...args.desktop === undefined ? {} : { desktop: platformsOf(args.desktop) },
        ...args.check === undefined ? {} : { check: args.check },
      }, exec, audience)
      const { webCheck, webCheckError, ...rest } = released
      return {
        ...rest,
        downloads: rest.downloads.map(download => ({ ...download })),
        ...credits === undefined ? {} : { credits: [...credits] },
        ...released.serverBuild === undefined ? {} : { serverBuild: { ...released.serverBuild } },
        warnings: [...warnings],
        ...webCheck === undefined ? {} : { webCheck: copyWebCheck(webCheck) },
        ...webCheckError === undefined ? {} : { webCheckError },
      }
    },
  })
}

/** Absolute-path arguments of the tools offered to connected agents, by tool. */
const MCP_PATHS: Readonly<Record<string, Readonly<Record<string, { readonly type: 'string'; readonly description: string }>>>> = {
  wasd_export_web: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
  },
  wasd_export_desktop: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
  },
  wasd_export_mobile: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
  },
  wasd_record_preview: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
  },
  wasd_release_game: {
    project: { type: 'string', description: 'Absolute path of the folder that holds project.godot.' },
    preview_image: { type: 'string', description: 'Absolute path of a PNG, JPEG, or WebP picture that Explore shows for the game; 16:9 fits best. Default: the still that wasd_record_preview saved.' },
    preview_gif: { type: 'string', description: 'Absolute path of an animated GIF that link previews of the share link show, and that Explore and the game\'s page then play in place of the recorded animation. Default: the GIF that wasd_record_preview saved, with its animation.' },
  },
}

/**
 * Tools that run the game in the connected agent's Session for the project: the recording, which needs the Session,
 * and a release, which records a missing preview in it when it has one.
 */
const MCP_SESSION_TOOLS: ReadonlySet<string> = new Set(['wasd_record_preview', 'wasd_release_game'])

/** Media types of preview stills, by file extension. */
const STILL_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpg: 'image/jpeg' }

/**
 * The content a connected agent receives from a recording: the text, then the still from its file.
 * @param definition - the recording tool.
 * @param value - the call's result.
 * @param args - the call's arguments.
 * @returns the text and the still.
 */
async function recordingContent(definition: ToolDefinition, value: RecordedPreviewValue, args: JsonObject): Promise<GameMcpContent[]> {
  const text = definition.output.render(args, value as never).flatMap(block => block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : [])
  const mimeType = STILL_TYPES[value.image.slice(value.image.lastIndexOf('.') + 1).toLowerCase()]
  if (mimeType === undefined) return text
  return [...text, { type: 'image', data: (await readFile(value.image)).toString('base64'), mimeType }]
}

/**
 * Offer one tool to agents connected through WASD Engine's MCP server, which name paths absolutely. A release first
 * credits the project with the agent, by the model it names, and with the tools the agent used before it named a
 * project, and reports the named model with the call.
 * @param definition - the tool, as {@link wasdToolDefinitions} builds it for connected agents.
 * @param credits - the plugin's credits.
 * @returns the server tool.
 */
function mcpTool(definition: ToolDefinition, credits: ConnectedCredits): GameMcpTool {
  const paths = MCP_PATHS[definition.name] ?? {}
  const { properties } = definition.parameters as { readonly properties: Readonly<Record<string, object>> }
  return {
    name: definition.name,
    definition,
    inputSchema: { type: 'object', additionalProperties: false, properties: { ...properties, ...paths } as Record<string, JsonObject>, required: ['project'] },
    readOnly: false,
    async prepare(args, call) {
      for (const name of Object.keys(paths)) {
        const value = args[name]
        if (name === 'project' ? typeof value !== 'string' || !isAbsolute(value) : value !== undefined && (typeof value !== 'string' || !isAbsolute(value))) {
          throw new Error(`${name} must be an absolute path.`)
        }
      }
      if (!MCP_SESSION_TOOLS.has(definition.name)) return { args }
      // The game plays in the connected agent's Session of the project, in the WASD Engine window's Game tab.
      if (definition.name === 'wasd_record_preview') return { args, agent: await call.session(args.project as string) }
      if (args.model !== undefined && typeof args.model !== 'string') throw new Error('model must be a string.')
      const model = typeof args.model === 'string' ? args.model : undefined
      await credits.claim(call.client, args.project as string, model, call.signal)
      const named = model === undefined ? {} : { model }
      try {
        return { args, agent: await call.session(args.project as string), ...named }
      } catch {
        // Without a Session the release still goes out; it only cannot record a missing preview.
        return { args, ...named }
      }
    },
    ...definition.name === 'wasd_record_preview'
      ? { content: (value, args) => recordingContent(definition, value as RecordedPreviewValue, args) }
      : {},
  }
}

/**
 * The WASD Engine provider of WASD Engine's MCP server.
 * @param definitions - the export, preview, and release tool definitions for connected agents.
 * @param credits - the plugin's credits.
 * @param multiplayer - the multiplayer tools, already offered for connected agents; none by default.
 * @param multiplayerInstructions - the multiplayer part of the provider's instructions, with `multiplayer`.
 * @returns the provider.
 */
export function wasdMcpProvider(
  definitions: readonly ToolDefinition[], credits: ConnectedCredits, multiplayer: readonly GameMcpTool[] = [], multiplayerInstructions = '',
): GameMcpProvider {
  const tools = [...definitions.map(definition => mcpTool(definition, credits)), ...multiplayer]
  const release = 'wasd_export_web builds the Godot project for the Web into its .wasdengine/web folder, wasd_export_desktop builds it for Windows and macOS into its .wasdengine/desktop folder, and wasd_export_mobile builds it for Android and iOS into its .wasdengine/mobile folder. wasd_record_preview records the game\'s preview, a short animation, a GIF, and a still of the running game, which Explore, the game\'s page, and link previews of the share link show: start the game with godot_run, bring it to its gameplay, then record with events that play it. wasd_release_game builds the project and publishes the build as the game\'s next numbered version on WASD Engine with the recorded preview, and returns the share link, where anyone with the link can play the game, pick earlier versions, and comment; visibility public also lists the game on Explore, private keeps it off, and desktop adds Windows and macOS downloads. The game\'s page credits what made the game: pass model, the name of the AI model you are, and it lists the game tools and add-ons that worked on the project. Release only when the user asks to, and pass notes that say what changed. Releasing needs WASD Engine to be signed in.'
  return {
    id: 'wasd',
    title: 'WASD Engine',
    description: multiplayer.length === 0
      ? 'Export the game for the Web, Windows, macOS, Android, and iOS, record its preview, and release it on WASD Engine with a share link.'
      : 'Export the game for the Web, Windows, macOS, Android, and iOS, record its preview, release it on WASD Engine with a share link, and put it online, player-hosted for free or on a dedicated server.',
    instructions: multiplayerInstructions === '' ? release : `${release}\n\n${multiplayerInstructions}`,
    tools: () => tools,
    status: () => Promise.resolve({ state: 'ready' }),
  }
}
