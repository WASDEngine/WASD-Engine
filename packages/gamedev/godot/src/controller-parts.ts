/**
 * What the Godot controller builds from its configuration before it serves: the runtime release and the guide in the
 * system prompt, the checks of the configured paths, the export templates of each platform, and the failures it
 * reports for a game that is not running or a Remote call that failed.
 */
import { isAbsolute } from 'node:path'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { ExportTemplateManager } from './export-template.ts'
import type { Config } from './index.ts'
import { GodotInputError } from './input.ts'
import { GodotProjectError } from './project.ts'
import { GodotRequestError, GodotRunStateError } from './run.ts'
import { GodotSessionError, LowMemoryError, TooManyRunsError } from './runs.ts'
import { GodotRuntimeError, isDownloadUrl } from './runtime.ts'
import type { GodotDesktopPlatform, GodotMobilePlatform } from './types.ts'

/**
 * The Godot release, `major.minor`, of the runtime that the plugin ships or installs: the start of `runtimeVersion`,
 * such as `4.7` for `4.7.2-wasd.4`, which the shipped and managed runtimes must match.
 * @param config - the plugin configuration.
 * @returns the release, or undefined when `libgodotPath` and `runnerPath` name another runtime or `runtimeVersion` does not start with one.
 */
export function godotRelease(config: Pick<Config, 'runtimeVersion' | 'libgodotPath'>): string | undefined {
  if (config.libgodotPath !== '') return undefined
  return /^(\d+\.\d+)(?=[.+-]|$)/u.exec(config.runtimeVersion)?.[1]
}

/**
 * The `godot` system prompt section.
 * @param release - the Godot release that the tools run, when known.
 * @returns the section text.
 */
export function godotPrompt(release: string | undefined): string {
  const builtIn = release === undefined
    ? 'Godot is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. '
      + 'Do not look for one or download one. For a new game, first write project.godot, whose [physics] section sets '
      + '3d/physics_engine="Jolt Physics", a main scene, and its scripts.'
    : `Godot ${release} is built in: the godot_* tools run it, so making, checking, and running a game need no Godot editor or godot command. `
      + `Do not look for one or download one. Write code for Godot ${release}. For a new game, first write project.godot, whose `
      + `config/features starts with "${release}" and whose [physics] section sets 3d/physics_engine="Jolt Physics", a main scene, `
      + 'and its scripts.'
  return `# Godot games

${builtIn}

Test a Godot project with the godot_* tools:
1. godot_run starts or restarts the game and reports import and startup errors; pass screenshot to see the game in the same call.
2. godot_screenshot shows the current frame. godot_input sends keys, text, mouse clicks and motion (in screenshot pixels), and input actions; godot_wait lets game time pass. Look again after acting: godot_input, godot_wait, and godot_eval take screenshot to show the result in the same call.
3. godot_logs reads printed output and errors; godot_eval and godot_scene_tree inspect the running scene; godot_performance measures frame times, rendering, memory, and the time of each script; godot_audio captures and measures the game's audio mix; godot_control pauses, resumes, or steps frames.
4. Fix the first error, then call godot_run again. godot_check finds GDScript errors without running the game.
5. Captures and tests need no changes to the game: godot_run takes launch options (args, engine_args), godot_eval runs GDScript code, godot_view draws any camera at any size or a scene alone, and godot_record saves video.
The user can watch and play the running game in the Game panel.

Released games play in browsers, where Godot draws with its Compatibility renderer (WebGL 2) whatever renderer the project uses, without a RenderingDevice: compute shaders, FogVolumes, and volumetric fog do nothing there. Start new games on it, with renderer/rendering_method="gl_compatibility" under [rendering] in project.godot, so they look the same everywhere; give desktop-only work a path for browsers, and run the game with godot_run web: true to see it as players will. A Web export ends with a Web check of the build in a browser, with a screenshot: while you build, fix the freezes and errors it reports. When the user asks to release, export, or share the game, do only that, without changing the game, and tell them what the check found.`
}

/** Why `godot_record` cannot record: no WASD Engine window encodes the video. */
export const NO_RECORDING_WINDOW = 'godot_record needs the WASD Engine window open, which encodes the video; it records once the window is connected.'

/** A Godot runtime does not resolve. */
export class GodotUnavailableError extends Error {
  override name = 'GodotUnavailableError'
}

/**
 * Refuse a configuration whose paths and download URLs the plugin cannot use: a relative `dataRoot`, `libgodotPath` and
 * `runnerPath` set apart or relative, and download URLs that are not https or of this computer.
 * @param config - validated configuration.
 * @throws {Error} naming the field to fix.
 */
export function validateConfig(config: Config): void {
  if (!isAbsolute(config.dataRoot)) throw new Error(`Godot plugin: dataRoot must be an absolute path, got ${JSON.stringify(config.dataRoot)}.`)
  if ((config.libgodotPath === '') !== (config.runnerPath === '')) throw new Error('Godot plugin: set libgodotPath and runnerPath together.')
  for (const [field, value] of [['libgodotPath', config.libgodotPath], ['runnerPath', config.runnerPath]] as const) {
    if (value !== '' && !isAbsolute(value)) throw new Error(`Godot plugin: ${field} must be an absolute path, got ${JSON.stringify(value)}.`)
  }
  if (!isDownloadUrl(config.runtimeManifestUrl)) {
    throw new Error(`Godot plugin: runtimeManifestUrl must be an https URL, or an http URL of this computer, got ${JSON.stringify(config.runtimeManifestUrl)}.`)
  }
  for (const field of TEMPLATE_FIELDS) {
    const archive = config[`${field}ArchiveUrl`]
    if (!isDownloadUrl(archive)) {
      throw new Error(`Godot plugin: ${field}ArchiveUrl must be an https URL, or an http URL of this computer, got ${JSON.stringify(archive)}.`)
    }
    const path = config[`${field}Path`]
    if (path !== '' && !isAbsolute(path)) throw new Error(`Godot plugin: ${field}Path must be an absolute path, got ${JSON.stringify(path)}.`)
  }
  for (const field of ['androidJavaPath', 'androidSdkPath'] as const) {
    const path = config[field]
    if (path !== '' && !isAbsolute(path)) throw new Error(`Godot plugin: ${field} must be an absolute path, got ${JSON.stringify(path)}.`)
  }
}

/** The export templates the configuration names, by the prefix of their fields. */
const TEMPLATE_FIELDS = ['webTemplate', 'windowsTemplate', 'macosTemplate', 'serverTemplate', 'androidTemplate', 'iosTemplate'] as const

/** A platform's template: the prefix of its configuration fields, the name messages use, and its file extension. */
export interface PlatformTemplate {
  readonly field: typeof TEMPLATE_FIELDS[number]
  readonly platform: string
  readonly extension: string
}

/** Each desktop platform's template. */
export const DESKTOP_TEMPLATES: Readonly<Record<GodotDesktopPlatform, PlatformTemplate>> = {
  windows: { field: 'windowsTemplate', platform: 'Windows', extension: '.exe' },
  macos: { field: 'macosTemplate', platform: 'macOS', extension: '.zip' },
}

/** Each mobile platform's template. */
export const MOBILE_TEMPLATES: Readonly<Record<GodotMobilePlatform, PlatformTemplate>> = {
  android: { field: 'androidTemplate', platform: 'Android', extension: '.apk' },
  ios: { field: 'iosTemplate', platform: 'iOS', extension: '.zip' },
}

/**
 * One export template's manager from the plugin configuration.
 * @param config - validated configuration.
 * @param field - the prefix of the template's fields.
 * @param platform - the platform as messages name it.
 * @param extension - the downloaded file's extension.
 * @param bundledDir - the folder of the templates that the Desktop app ships, empty without one.
 * @returns the manager.
 */
export function templateManager(
  config: Config, field: typeof TEMPLATE_FIELDS[number], platform: string, extension: string, bundledDir: string,
): ExportTemplateManager {
  return new ExportTemplateManager({
    dataRoot: config.dataRoot,
    platform,
    field,
    archiveUrl: config[`${field}ArchiveUrl`],
    entry: config[`${field}Entry`],
    sha256: config[`${field}Sha256`],
    path: config[`${field}Path`],
    bundledDir,
    extension,
  }, (url, init) => fetch(url, { headers: init.headers, signal: init.signal }))
}

/**
 * The refusal of a request for a run that the Session does not have, or that does not accept requests.
 * @returns the Remote failure.
 */
export function notRunning(): RemoteError<'godot/not-running'> {
  return new RemoteError('godot/not-running', 'The game is not running.', {})
}

/**
 * Map a run failure to the Remote failure the Game tab shows.
 * @param error - what the operation threw.
 * @returns the Remote failure of a known run failure, and the error itself otherwise.
 */
export function remoteFailure(error: unknown): unknown {
  if (error instanceof GodotProjectError) return new RemoteError('godot/no-project', error.message, { directory: error.directory }, { cause: error })
  if (error instanceof GodotRuntimeError || error instanceof GodotUnavailableError) {
    return new RemoteError('godot/runtime-unavailable', error.message, { message: error.message }, { cause: error })
  }
  if (error instanceof TooManyRunsError) return new RemoteError('godot/too-many-runs', error.message, { limit: error.limit }, { cause: error })
  if (error instanceof LowMemoryError) {
    const { availableBytes, requiredBytes } = error.shortage
    return new RemoteError('godot/low-memory', error.message, { availableBytes, requiredBytes }, { cause: error })
  }
  if (error instanceof GodotRunStateError || error instanceof GodotSessionError) return new RemoteError('godot/not-running', error.message, {}, { cause: error })
  if (error instanceof GodotRequestError) return new RemoteError('godot/request-failed', error.message, { message: error.message }, { cause: error })
  if (error instanceof GodotInputError) return new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
  return error
}
