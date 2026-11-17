/**
 * Exports: one headless LibGodot editor process exports a project with a preset of WASD Engine's into a folder.
 *
 * The Web export (`WASD Engine Web`) fills the folder with `index.html`, the engine (`index.js`, `index.wasm`), the
 * game's pack (`index.pck`), the audio worklets, the splash image (`index.png`), and the icons. The preset uses the
 * single-threaded Web template and no GDExtensions, so the build needs no cross-origin isolation and plays in any page
 * that frames it.
 *
 * Godot shows Godot's logo as the boot splash of a project that names no image of its own; the Web and desktop exports
 * show WASD Engine's logo there instead, unless the project turns the image off ({@link wasdSplash}). Godot's Web
 * runtime draws no boot splash: the page's loading screen shows the splash image, which the Web export replaces after
 * Godot wrote it. A desktop build draws its boot splash as it starts, from the image the project's `boot_splash/image`
 * names, so a desktop export names WASD Engine's logo there for its run and puts the image at {@link EXPORT_SPLASH_PATH}.
 *
 * A desktop export (`WASD Engine Windows`, `WASD Engine macOS`) writes one ZIP file named after the game: for Windows,
 * the 64-bit x86 executable with the pack embedded, so the game is one `.exe` file; for macOS, a universal `.app`
 * bundle for Intel and Apple silicon, signed ad hoc, since an Apple silicon Mac runs no unsigned code. Neither build
 * carries a publisher's signature, so Windows SmartScreen and macOS Gatekeeper ask before a downloaded copy first runs.
 * Desktop builds need the VRAM-compressed textures of their processors: S3TC/BPTC for x86 and ETC2/ASTC for Apple
 * silicon, while the editor imports only its host's own formats unless the project's settings ask for more, and an
 * export packs only the formats the project imported. A desktop export therefore turns those import settings on in
 * `project.godot` for its run, so the export's import step adds the missing formats, and restores their earlier values
 * afterwards; the other formats' imported files stay in the project's `.godot` folder, where they spare the next
 * export the work.
 *
 * The dedicated server export (`WASD Engine Server`) writes one Linux x86_64 executable, `server.x86_64`, with the pack
 * embedded and the visuals of every resource stripped, which runs as the game's server with `--headless`.
 *
 * Every preset includes `wasd_multiplayer.cfg`, the WASD Multiplayer add-on's configuration at the project root, which
 * is no resource, so Godot would leave it out of the pack.
 *
 * Godot reads export presets only from the project's `export_presets.cfg`, so a preset is written there for the export
 * alone: the file's original bytes are restored afterwards, or the file is removed when the project had none, and the
 * project's own presets never change.
 *
 * Before an export changes `export_presets.cfg` or `project.godot`, it writes a restore record into the plugin's
 * `export-restore` folder: the files' earlier content and what the export wrote. An export that ends restores the files,
 * deletes the boot splash image it put in the project, and deletes its record; when the app quits during an export, the
 * next start of the plugin, and the next export of the project, replay the record ({@link replayExportRestore}).
 * @module @deepseek-ai/dsh-godot/src/export
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { turnOffBlenderImport } from './blender-import.ts'
import { runGodotCommand } from './command.ts'
import { consoleLines, describeExit, formatSeconds, lastLines } from './output.ts'
import { FAILURE_OUTPUT_LINES } from './run.ts'
import { parseProjectSettings } from './project.ts'
import { launcherArgv, type ResolvedGodotRuntime } from './runtime.ts'
import type { GodotDesktopExport, GodotDesktopPlatform, GodotServerExport, GodotWebExport } from './types.ts'

/** Name of the export preset the Web export writes for the duration of one export. */
export const WEB_EXPORT_PRESET = 'WASD Engine Web'

/** Name of the export preset the dedicated server export writes for the duration of one export. */
export const SERVER_EXPORT_PRESET = 'WASD Engine Server'

/** The executable a dedicated server export writes, with the game's pack embedded. */
export const SERVER_EXPORT_BINARY = 'server.x86_64'

/** The page that starts an exported game. */
export const WEB_EXPORT_ENTRY = 'index.html'

/** The WASD Multiplayer add-on's configuration file, at the project root, which every export includes. */
export const MULTIPLAYER_CONFIG_FILE = 'wasd_multiplayer.cfg'

/** Most Godot warnings a result lists. */
export const EXPORT_WARNINGS = 10

/** The splash image of a Web build, which its page's loading screen shows. */
export const WEB_SPLASH_FILE = 'index.png'

/**
 * WASD Engine's boot splash images, in the plugin's `runtime/` folder, by the splash color they suit: the logo with a
 * light wordmark for a dark color, such as Godot's default, and with a dark wordmark for a light one. Each is 1600 x
 * 1200, twice Godot's own splash image, with the logo centered on a transparent canvas;
 * `apps/desktop/scripts/wasdengine-render-icons.ts` renders them.
 */
export const WASD_SPLASH_IMAGES: Readonly<Record<SplashTone, URL>> = {
  dark: new URL('../runtime/wasd_engine_splash_dark_bg.png', import.meta.url),
  light: new URL('../runtime/wasd_engine_splash_light_bg.png', import.meta.url),
}

/** Whether a splash color is dark or light, which picks the image of {@link WASD_SPLASH_IMAGES}. */
export type SplashTone = 'dark' | 'light'

/**
 * Where a desktop export puts WASD Engine's boot splash in the project for its run: Godot's own `.godot` folder, whose
 * files the editor neither imports nor lists. The export packs the image that `boot_splash/image` names.
 */
export const EXPORT_SPLASH_PATH = 'res://.godot/wasd_engine_splash.png'

/** The `[application]` line that names {@link EXPORT_SPLASH_PATH} as the boot splash image. */
const EXPORT_SPLASH_LINE = `boot_splash/image="${EXPORT_SPLASH_PATH}"`

/**
 * Relative luminance below which a splash color is dark: the light wordmark (#F4F5F7) contrasts more with a darker
 * color than the dark wordmark (#17181D) does, by the WCAG contrast ratio.
 */
const DARK_SPLASH_LUMINANCE = 0.189

/** Godot's splash color for a project that sets none, `Color(0.14, 0.14, 0.14, 1)`. */
const DEFAULT_SPLASH_COLOR = [0.14, 0.14, 0.14] as const

/** Names of the export presets a desktop export writes for the duration of one export, by platform. */
export const DESKTOP_EXPORT_PRESETS: Readonly<Record<GodotDesktopPlatform, string>> = {
  windows: 'WASD Engine Windows',
  macos: 'WASD Engine macOS',
}

/** The VRAM compression formats a desktop build needs imported, by platform, as `project.godot` names their import settings. */
export const DESKTOP_TEXTURE_FORMATS: Readonly<Record<GodotDesktopPlatform, readonly TextureFormat[]>> = {
  windows: ['s3tc_bptc'],
  macos: ['s3tc_bptc', 'etc2_astc'],
}

/** A VRAM compression format whose import `project.godot` switches with `textures/vram_compression/import_<format>`. */
export type TextureFormat = 's3tc_bptc' | 'etc2_astc'

const PRESETS_FILE = 'export_presets.cfg'
const PROJECT_FILE = 'project.godot'
const REQUIRED_FILES = [WEB_EXPORT_ENTRY, 'index.js', 'index.wasm', 'index.pck'] as const
/** The fields every preset of WASD Engine's sets after its export filter; the include filter adds the multiplayer configuration. */
const FILTER_FIELDS = [
  `include_filter="${MULTIPLAYER_CONFIG_FILE}"`,
  'exclude_filter=""',
  'export_path=""',
  'encryption_include_filters=""',
  'encryption_exclude_filters=""',
  'encrypt_pck=false',
  'encrypt_directory=false',
  'script_export_mode=2',
] as const
/** The fields a game's preset sets after its name and platform. */
const PRESET_FIELDS = [
  'runnable=false',
  'dedicated_server=false',
  'custom_features=""',
  'export_filter="all_resources"',
  ...FILTER_FIELDS,
] as const
/**
 * The fields the dedicated server preset sets after its name and platform: every resource keeps its data but its
 * visuals are stripped (`customized_files` maps `res://` to `strip`), and Godot adds the `dedicated_server` feature tag.
 */
const SERVER_PRESET_FIELDS = [
  'runnable=false',
  'dedicated_server=true',
  'custom_features=""',
  'export_filter="customized"',
  'customized_files={',
  '"res://": "strip"',
  '}',
  ...FILTER_FIELDS,
] as const

/** Folder, in the plugin's data folder, that holds the restore records of the exports that change project files. */
export const EXPORT_RESTORE_FOLDER = 'export-restore'

/** Parameters of one export process. */
export interface ExportOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Absolute folder of the restore records, {@link EXPORT_RESTORE_FOLDER} in the plugin's data folder. */
  readonly restoreDir: string
  /** Runtime to launch; its library must be an editor build. */
  readonly runtime: ResolvedGodotRuntime
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** Absolute folder the export empties and fills. */
  readonly outputDir: string
  /**
   * Absolute path of the export template: the single-threaded Web release template ZIP, the desktop one, or the Linux
   * x86_64 release executable of a dedicated server export.
   */
  readonly template: string
  /** Host process id for the runner's parent watch. */
  readonly hostPid: number
  /** Deadline of the export, import included. */
  readonly timeoutMs: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation. */
  readonly signal: AbortSignal
}

/** Parameters of one Web export process. */
export type WebExportOptions = ExportOptions

/** Parameters of one desktop export process. */
export interface DesktopExportOptions extends ExportOptions {
  /** The platform to build for; `template` is its release template: the Windows `.exe` or the macOS `.zip`. */
  readonly platform: GodotDesktopPlatform
}

/** An export that produced no playable build; the message carries Godot's last output. */
export class GodotExportError extends Error {
  override name = 'GodotExportError'
}

/**
 * Quote a string as a Godot `ConfigFile` value.
 * @param value - raw string.
 * @returns the quoted value.
 */
function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/** The two sections of one preset: `[preset.N]` and its `[preset.N.options]` lines, without their headers. */
interface PresetSections {
  readonly preset: string[]
  readonly options: string[] | undefined
}

/**
 * The settings of a project's `[application]` section.
 * @param projectText - `project.godot` text.
 * @returns each setting's value as the file writes it, by its key; the last of repeated keys, as Godot reads them.
 */
function applicationSettings(projectText: string): Map<string, string> {
  const settings = new Map<string, string>()
  let section = ''
  for (const line of projectText.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) {
      section = header[1] as string
      continue
    }
    const setting = section === 'application' ? /^([^\s=]+)=(.*)$/u.exec(line) : null
    if (setting !== null) settings.set(setting[1] as string, (setting[2] as string).trim())
  }
  return settings
}

/**
 * Whether a project names a boot splash image of its own, which its builds then show.
 * @param projectText - `project.godot` text.
 * @returns true when its `[application]` section sets `boot_splash/image`, or a feature override of it, to a path
 *   other than {@link EXPORT_SPLASH_PATH}, which only a desktop export names.
 */
export function customBootSplash(projectText: string): boolean {
  return [...applicationSettings(projectText)].some(([key, value]) =>
    /^boot_splash\/image(?:\.[\w.]+)?$/u.test(key) && /^"[^"\s]/u.test(value) && value !== `"${EXPORT_SPLASH_PATH}"`)
}

/**
 * The WASD Engine boot splash that a project's exports show in place of Godot's logo: none for a project that names a
 * boot splash image of its own or turns the image off (`boot_splash/show_image=false`), else the image of
 * {@link WASD_SPLASH_IMAGES} whose wordmark contrasts more with the project's splash color (`boot_splash/bg_color`,
 * Godot's dark gray when unset or unreadable).
 * @param projectText - `project.godot` text.
 * @returns the tone of the image to show, or undefined for none.
 */
export function wasdSplash(projectText: string): SplashTone | undefined {
  if (customBootSplash(projectText)) return undefined
  const settings = applicationSettings(projectText)
  if (settings.get('boot_splash/show_image') === 'false') return undefined
  const read = /^Color\(([^,]+),([^,]+),([^,)]+)/u.exec(settings.get('boot_splash/bg_color') ?? '')?.slice(1).map(Number)
  const color = read !== undefined && read.every(Number.isFinite) ? read : DEFAULT_SPLASH_COLOR
  // Godot's colors hold sRGB channels from 0 to 1, or beyond them for overbright colors.
  const linear = (channel: number): number => {
    const value = Math.min(1, Math.max(0, channel))
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const [red, green, blue] = color.map(linear) as [number, number, number]
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue < DARK_SPLASH_LUMINANCE ? 'dark' : 'light'
}

/**
 * Name {@link EXPORT_SPLASH_PATH} as a project's boot splash image, after any image setting the project has, so that
 * Godot reads it last, or remove that line again; no other line changes.
 * @param projectText - `project.godot` text.
 * @param named - whether the text names the image.
 * @returns the new text; an `[application]` section is added at the end when the project has none.
 */
export function withExportSplash(projectText: string, named: boolean): string {
  const newline = projectText.includes('\r\n') ? '\r\n' : '\n'
  const kept: string[] = []
  let section = ''
  let applicationEnd = -1
  for (const line of projectText.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) section = header[1] as string
    if (section === 'application' && line.trim() === EXPORT_SPLASH_LINE) continue
    kept.push(line)
    if (section === 'application' && line.trim() !== '') applicationEnd = kept.length
  }
  if (!named) return kept.join(newline)
  if (applicationEnd >= 0) {
    kept.splice(applicationEnd, 0, EXPORT_SPLASH_LINE)
    return kept.join(newline)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return [...kept, '', '[application]', '', EXPORT_SPLASH_LINE, ''].join(newline)
}

/** The real path of {@link EXPORT_SPLASH_PATH} in a project. */
function exportSplashFile(projectDir: string): string {
  return join(projectDir, ...EXPORT_SPLASH_PATH.slice('res://'.length).split('/'))
}

/**
 * Add one preset to an `export_presets.cfg` text, after the project's presets. Godot reads presets from index 0 up to
 * the first missing one, so presets are renumbered without gaps, and an earlier preset of the same name, such as one an
 * interrupted export left behind, is replaced.
 * @param original - the file's text, or undefined when the project has none.
 * @param name - the preset's name.
 * @param platform - Godot's name of the preset's platform, such as `Web` or `Windows Desktop`.
 * @param fields - the preset's fields after its name and platform.
 * @param options - the preset's option lines.
 * @returns the file text for the export.
 */
function withPreset(
  original: string | undefined, name: string, platform: string, fields: readonly string[], options: readonly string[],
): string {
  const { prefix, blocks } = presetBlocks(original, name)
  const index = blocks.length
  blocks.push([
    `[preset.${index}]`,
    '',
    `name=${quote(name)}`,
    `platform=${quote(platform)}`,
    ...fields,
    '',
    `[preset.${index}.options]`,
    '',
    ...options,
  ].join('\n'))
  return `${prefix === '' ? '' : `${prefix}\n\n`}${blocks.join('\n\n')}\n`
}

/**
 * Split an `export_presets.cfg` text into the lines before its presets and its presets other than `name`, renumbered
 * from 0 as Godot reads them.
 * @returns the lines before the presets, the kept presets' text blocks, and whether a preset named `name` was left out.
 */
function presetBlocks(original: string | undefined, name: string): { prefix: string; blocks: string[]; removed: boolean } {
  const presets = new Map<number, PresetSections>()
  const other: string[] = []
  let current: string[] = other
  for (const line of (original ?? '').split(/\r?\n/u)) {
    const header = /^\[preset\.(\d+)(\.options)?\]\s*$/u.exec(line)
    if (header === null) {
      if (/^\[.*\]\s*$/u.test(line)) current = other
      current.push(line)
      continue
    }
    const index = Number(header[1])
    const known = presets.get(index) ?? { preset: [], options: undefined }
    if (header[2] === undefined) {
      presets.set(index, { ...known, preset: [] })
      current = (presets.get(index) as PresetSections).preset
    } else {
      presets.set(index, { ...known, options: [] })
      current = (presets.get(index) as PresetSections).options as string[]
    }
  }
  const all = [...presets.entries()].sort(([left], [right]) => left - right).map(([, sections]) => sections)
  const kept = all.filter(sections => !sections.preset.some(line => line.trim() === `name=${quote(name)}`))
  const blocks = kept.map((sections, index) => [
    `[preset.${index}]`,
    ...sections.preset,
    ...sections.options === undefined ? [] : [`[preset.${index}.options]`, ...sections.options],
  ].join('\n').trimEnd())
  return { prefix: other.join('\n').trim(), blocks, removed: kept.length < all.length }
}

/**
 * Remove the presets named `name` from an `export_presets.cfg` text, renumbering the others.
 * @param text - the file's text.
 * @param name - the preset's name.
 * @returns the new text, which is empty when nothing else remains, or `text` itself when it has no such preset.
 */
export function withoutPreset(text: string, name: string): string {
  const { prefix, blocks, removed } = presetBlocks(text, name)
  if (!removed) return text
  const body = [prefix, ...blocks].filter(part => part !== '').join('\n\n')
  return body === '' ? '' : `${body}\n`
}

/**
 * Add the Web export preset to an `export_presets.cfg` text, after the project's presets, replacing an earlier
 * `WASD Engine Web` preset.
 * @param original - the file's text, or undefined when the project has none.
 * @param template - absolute path of the Web release template.
 * @returns the file text for the export.
 */
export function withWebPreset(original: string | undefined, template: string): string {
  return withPreset(original, WEB_EXPORT_PRESET, 'Web', PRESET_FIELDS, [
    'custom_template/debug=""',
    `custom_template/release=${quote(template)}`,
    'variant/extensions_support=false',
    'variant/thread_support=false',
    'vram_texture_compression/for_desktop=true',
    'vram_texture_compression/for_mobile=false',
    'html/export_icon=true',
    'html/custom_html_shell=""',
    'html/head_include=""',
    'html/canvas_resize_policy=2',
    'html/focus_canvas_on_start=true',
    'html/experimental_virtual_keyboard=false',
    'progressive_web_app/enabled=false',
  ])
}

/**
 * The macOS bundle identifier of a game: `com.wasdengine.game.` and the game's name in lowercase ASCII letters,
 * digits, and hyphens, as macOS takes them.
 * @param name - the game's name.
 * @returns the identifier; `com.wasdengine.game.game` for a name without such characters.
 */
export function bundleIdentifier(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
  const words = ascii.replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 60).replace(/-+$/u, '')
  return `com.wasdengine.game.${words === '' ? 'game' : /^[a-z]/u.test(words) ? words : `game-${words}`}`
}

/**
 * Add a desktop export preset to an `export_presets.cfg` text, after the project's presets, replacing an earlier
 * preset of the same name.
 * @param original - the file's text, or undefined when the project has none.
 * @param platform - the platform to build for.
 * @param template - absolute path of its release template.
 * @param name - the game's name, from which a macOS build takes its bundle identifier.
 * @returns the file text for the export.
 */
export function withDesktopPreset(original: string | undefined, platform: GodotDesktopPlatform, template: string, name: string): string {
  // The debug template is the release one too: Godot reports a missing debug template while it checks a preset.
  const templates = [`custom_template/debug=${quote(template)}`, `custom_template/release=${quote(template)}`]
  switch (platform) {
    case 'windows':
      return withPreset(original, DESKTOP_EXPORT_PRESETS.windows, 'Windows Desktop', PRESET_FIELDS, [
        ...templates,
        'debug/export_console_wrapper=0',
        'binary_format/embed_pck=true',
        'binary_format/architecture="x86_64"',
        'texture_format/s3tc_bptc=true',
        'texture_format/etc2_astc=false',
        'codesign/enable=false',
        'application/modify_resources=true',
      ])
    case 'macos':
      return withPreset(original, DESKTOP_EXPORT_PRESETS.macos, 'macOS', PRESET_FIELDS, [
        'export/distribution_type=1',
        'binary_format/architecture="universal"',
        ...templates,
        'debug/export_console_wrapper=0',
        `application/bundle_identifier=${quote(bundleIdentifier(name))}`,
        'application/app_category="Games"',
        'codesign/codesign=1',
        'notarization/notarization=0',
      ])
    default:
      return assertNever(platform)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unknown desktop platform ${String(value)}`)
}

/**
 * Add the dedicated server export preset to an `export_presets.cfg` text, after the project's presets, replacing an
 * earlier `WASD Engine Server` preset. The preset exports for Linux x86_64 as a dedicated server, with the pack embedded
 * in the executable.
 * @param original - the file's text, or undefined when the project has none.
 * @param template - absolute path of the Linux x86_64 release template.
 * @returns the file text for the export.
 */
export function withServerPreset(original: string | undefined, template: string): string {
  // The debug template is the release one too: Godot reports a missing debug template while it checks a preset.
  return withPreset(original, SERVER_EXPORT_PRESET, 'Linux', SERVER_PRESET_FIELDS, [
    `custom_template/debug=${quote(template)}`,
    `custom_template/release=${quote(template)}`,
    'debug/export_console_wrapper=0',
    'binary_format/embed_pck=true',
    'texture_format/s3tc_bptc=true',
    'texture_format/etc2_astc=false',
    'binary_format/architecture="x86_64"',
    'ssh_remote_deploy/enabled=false',
  ])
}

const IMPORT_SETTING = /^textures\/vram_compression\/import_(s3tc_bptc|etc2_astc)\s*=\s*(\S+)\s*$/u

/**
 * The import settings of the VRAM compression formats in `project.godot` text.
 * @param projectText - `project.godot` text.
 * @returns each format's setting, `true` or `false`, as its `[rendering]` section writes it; absent when unset.
 */
export function textureImports(projectText: string): Partial<Record<TextureFormat, string>> {
  const found: Partial<Record<TextureFormat, string>> = {}
  let section = ''
  for (const line of projectText.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) {
      section = header[1] as string
      continue
    }
    const setting = section === 'rendering' ? IMPORT_SETTING.exec(line) : null
    if (setting !== null) found[setting[1] as TextureFormat] = setting[2] as string
  }
  return found
}

/**
 * Set the import settings of VRAM compression formats in `project.godot` text, in its `[rendering]` section, which is
 * added at the end when the project has none.
 * @param projectText - `project.godot` text.
 * @param values - each format's new value; undefined removes the format's setting.
 * @returns the new text.
 */
export function withTextureImports(projectText: string, values: Partial<Record<TextureFormat, string | undefined>>): string {
  const newline = projectText.includes('\r\n') ? '\r\n' : '\n'
  const lines = projectText.split(/\r?\n/u)
  const pending = new Map(Object.entries(values) as [TextureFormat, string | undefined][])
  const kept: string[] = []
  let section = ''
  let renderingEnd = -1
  for (const line of lines) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) section = header[1] as string
    const setting = section === 'rendering' ? IMPORT_SETTING.exec(line) : null
    if (setting !== null && pending.has(setting[1] as TextureFormat)) {
      const value = pending.get(setting[1] as TextureFormat)
      pending.delete(setting[1] as TextureFormat)
      if (value !== undefined) kept.push(`textures/vram_compression/import_${setting[1]}=${value}`)
    } else {
      kept.push(line)
    }
    if (section === 'rendering' && line.trim() !== '') renderingEnd = kept.length
  }
  const added = [...pending].flatMap(([format, value]) => value === undefined ? [] : [`textures/vram_compression/import_${format}=${value}`])
  if (added.length === 0) return kept.join(newline)
  if (renderingEnd >= 0) {
    kept.splice(renderingEnd, 0, ...added)
    return kept.join(newline)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return [...kept, '', '[rendering]', '', ...added, ''].join(newline)
}

/** A pack larger than this many bytes gets a note: players download all of it before the game starts. */
export const LARGE_PACK_BYTES = 100 * 1024 * 1024

/** The note of a project whose desktop renderer is not the Compatibility renderer that Web builds use. */
export const WEB_RENDERER_NOTE = 'The Web build renders with the Compatibility renderer (WebGL 2), not the project\'s desktop renderer: SSAO, SSR, SDFGI, volumetric fog, TAA, and FSR are missing or different there, shaders read `source_color` textures as sRGB values and scene depth in another range, and instance uniforms fit far fewer objects. godot_run with web set to true shows the game as the Web build draws it.'

/**
 * Notes about how the Web build of a project differs from its desktop runs.
 * @param projectText - `project.godot` text.
 * @returns the notes.
 */
export function webNotes(projectText: string): string[] {
  // An unset rendering method is Forward+, Godot 4's default.
  const method = /^renderer\/rendering_method="([^"]+)"/mu.exec(projectText)?.[1] ?? 'forward_plus'
  return method === 'gl_compatibility' ? [] : [WEB_RENDERER_NOTE]
}

/**
 * The note about a large pack, which players download in full before the game starts.
 * @param files - the exported files.
 * @returns the note, or none for a pack of at most {@link LARGE_PACK_BYTES}.
 */
export function packNotes(files: readonly { readonly path: string; readonly bytes: number }[]): string[] {
  const pack = files.find(file => file.path === 'index.pck')
  if (pack === undefined || pack.bytes <= LARGE_PACK_BYTES) return []
  return [`The game's pack is ${String(Math.round(pack.bytes / (1024 * 1024)))} MB, and players download all of it before the game starts. Textures are most of most packs: lower the size limit of large ones (process/size_limit in their .import files), reuse textures, and keep sounds compressed.`]
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

const TextureValue = z.string().nullable()

/** A restore record as the file holds it. */
const ExportRestoreRecord = z.strictObject({
  format: z.literal(1),
  projectDir: z.string().min(1),
  /** The preset the export added to `export_presets.cfg`. */
  preset: z.string().min(1),
  presets: z.strictObject({
    /** The file's bytes before the export, in base64, or null when the project had none. */
    original: z.string().nullable(),
    /** The text the export wrote. */
    written: z.string(),
  }),
  /**
   * For a desktop export that changed `project.godot`: its text before and during the export, and the import settings
   * the export changed. The boot splash line the export may have added names {@link EXPORT_SPLASH_PATH}, by which it is
   * found again.
   */
  project: z.strictObject({
    original: z.string(),
    written: z.string(),
    before: z.strictObject({ s3tc_bptc: TextureValue.optional(), etc2_astc: TextureValue.optional() }),
  }).optional(),
})

type ExportRestoreRecord = z.infer<typeof ExportRestoreRecord>

/** The path of a project's restore record: one file per project, named by a digest of its absolute folder. */
function restoreRecordPath(restoreDir: string, projectDir: string): string {
  return join(restoreDir, `${createHash('sha256').update(resolve(projectDir)).digest('hex').slice(0, 32)}.json`)
}

/** Write a project's restore record before the export changes the project's files. */
async function writeRestoreRecord(restoreDir: string, record: ExportRestoreRecord): Promise<void> {
  await writeFileAtomic(restoreRecordPath(restoreDir, record.projectDir), `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/** Read a restore record; undefined when there is none or it is not one. */
async function readRestoreRecord(path: string): Promise<ExportRestoreRecord | undefined> {
  const bytes = await readOptional(path)
  if (bytes === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    // SyntaxError: the plugin writes records atomically, so one that is not JSON was changed by hand and restores nothing.
    return undefined
  }
  const parsed = ExportRestoreRecord.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

/**
 * Return the files of an export that ended without restoring them: `export_presets.cfg` gets its earlier bytes back
 * while it holds what the export wrote, and otherwise loses only the export's preset, so changes made since stay; a
 * desktop export's import settings in `project.godot` return to their earlier values, and its boot splash line and
 * image go.
 */
async function replayRecord(record: ExportRestoreRecord): Promise<void> {
  const presetsPath = join(record.projectDir, PRESETS_FILE)
  const presets = (await readOptional(presetsPath))?.toString('utf8')
  if (presets !== undefined) {
    const { original, written } = record.presets
    if (presets === written) {
      if (original === null) await rm(presetsPath, { force: true })
      else await writeFile(presetsPath, Buffer.from(original, 'base64'))
    } else {
      const kept = withoutPreset(presets, record.preset)
      if (kept === '' && original === null) await rm(presetsPath, { force: true })
      else if (kept !== presets) await writeFile(presetsPath, kept)
    }
  }
  if (record.project === undefined) return
  await rm(exportSplashFile(record.projectDir), { force: true })
  const projectPath = join(record.projectDir, PROJECT_FILE)
  const current = (await readOptional(projectPath))?.toString('utf8')
  if (current === undefined) return
  const before = Object.fromEntries(Object.entries(record.project.before).map(([format, value]) => [format, value ?? undefined]))
  const restored = current === record.project.written
    ? record.project.original
    : withExportSplash(withTextureImports(current, before), false)
  if (restored !== current) await writeFile(projectPath, restored)
}

/**
 * Return a project's files after an export of it that ended without restoring them, such as one during which the app
 * quit: replay the restore record that the export left, then delete it. Run it where no export of the project runs.
 * @param restoreDir - absolute folder of the restore records.
 * @param projectDir - absolute project folder.
 * @returns whether a record was replayed.
 */
export async function replayExportRestore(restoreDir: string, projectDir: string): Promise<boolean> {
  const path = restoreRecordPath(restoreDir, projectDir)
  const record = await readRestoreRecord(path)
  if (record !== undefined) await replayRecord(record)
  await rm(path, { force: true })
  return record !== undefined
}

/**
 * The projects that have a restore record: exports of them ended without restoring their files.
 * @param restoreDir - absolute folder of the restore records.
 * @returns absolute project folders.
 */
export async function pendingExportRestores(restoreDir: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(restoreDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const projects: string[] = []
  for (const name of names.filter(entry => /^[0-9a-f]{32}\.json$/u.test(entry)).sort()) {
    const record = await readRestoreRecord(join(restoreDir, name))
    if (record !== undefined) projects.push(record.projectDir)
    else await rm(join(restoreDir, name), { force: true })
  }
  return projects
}

/** What one export run writes and checks. */
interface ExportPlan {
  /** The export preset's name. */
  readonly preset: string
  /** The `export_presets.cfg` text of the export, from the project's own text. */
  readonly presets: (original: string | undefined) => string
  /** The file Godot exports to, inside the output folder. */
  readonly target: string
  /** Files the output folder must hold afterwards. */
  readonly required: readonly string[]
  /** What messages call the export, such as `Web`. */
  readonly label: string
  /** Changes the output folder after Godot's run, before the folder is listed, while the export still holds it. */
  readonly finish?: () => Promise<void>
}

/** The files an export wrote, the note about the Blender importer, and Godot's export warnings. */
interface ExportOutcome {
  readonly files: { path: string; bytes: number }[]
  readonly blenderNote: string | undefined
  readonly warnings: string[]
}

/**
 * Run one export with a preset of WASD Engine's, restoring `export_presets.cfg` afterwards. Exports writing to one
 * output folder run one at a time, across Hosts too.
 * @param options - process parameters, project, template, and output folder.
 * @param plan - the preset, the target file, and the files it must write.
 * @returns the exported files, the note about the Blender importer, and Godot's export warnings.
 * @throws {GodotExportError} when the process ends without writing the required files.
 */
async function runExport(options: ExportOptions, plan: ExportPlan): Promise<ExportOutcome> {
  // An export that the app quit during left the project's files changed.
  await replayExportRestore(options.restoreDir, options.projectDir)
  // The export scans and imports the project like the import step.
  const blenderNote = await turnOffBlenderImport(options.projectDir, options.signal)
  await mkdir(options.outputDir, { recursive: true })
  return await withFileLock(options.outputDir, async () => {
    await rm(options.outputDir, { recursive: true, force: true })
    await mkdir(options.outputDir, { recursive: true })
    const presetsPath = join(options.projectDir, PRESETS_FILE)
    const original = await readOptional(presetsPath)
    const written = plan.presets(original?.toString('utf8'))
    await writeRestoreRecord(options.restoreDir, {
      format: 1, projectDir: options.projectDir, preset: plan.preset,
      presets: { original: original?.toString('base64') ?? null, written },
    })
    await writeFile(presetsPath, written)
    let stdout: string
    let stderr: string
    let ended: string
    try {
      const outcome = await runGodotCommand({
        ...options,
        argv: launcherArgv(options.runtime, options.hostPid, [
          '--headless', '--path', options.projectDir, '--export-release', plan.preset, join(options.outputDir, plan.target),
        ]),
        cwd: options.projectDir,
      })
      stdout = outcome.stdout
      stderr = outcome.stderr
      ended = outcome.timedOut ? `did not finish within ${formatSeconds(options.timeoutMs)}` : `ended (${describeExit(outcome.exit)})`
    } finally {
      if (original === undefined) await rm(presetsPath, { force: true })
      else await writeFile(presetsPath, original)
      await rm(restoreRecordPath(options.restoreDir, options.projectDir), { force: true })
    }
    options.signal.throwIfAborted()
    await plan.finish?.()
    const files: { path: string; bytes: number }[] = []
    for (const entry of await readdir(options.outputDir, { withFileTypes: true })) {
      if (entry.isFile()) files.push({ path: entry.name, bytes: (await stat(join(options.outputDir, entry.name))).size })
    }
    files.sort((left, right) => left.path.localeCompare(right.path))
    const missing = plan.required.filter(name => !files.some(file => file.path === name))
    const lines = [...consoleLines(stderr), ...consoleLines(stdout)]
    if (missing.length > 0) {
      const errors = lines.filter(line => /\bERROR\b/u.test(line)).slice(-FAILURE_OUTPUT_LINES).join('\n')
      const tail = errors || lastLines(stderr, FAILURE_OUTPUT_LINES) || lastLines(stdout, FAILURE_OUTPUT_LINES)
      throw new GodotExportError(`The Godot ${plan.label} export ${ended} without writing ${missing.join(', ')}.${tail === '' ? '' : `\nLast output:\n${tail}`}`)
    }
    const warnings = [...new Set(lines.filter(line => line.startsWith('WARNING:')).map(line => line.slice('WARNING:'.length).trim()))]
    return { files, blenderNote, warnings }
  }, { signal: options.signal, waitMs: options.timeoutMs })
}

/**
 * Export a project for the Web. Exports writing to one output folder run one at a time, across Hosts too. The splash
 * image that Godot wrote becomes WASD Engine's ({@link wasdSplash}) for a project without one of its own.
 * @param options - process parameters, project, template, and output folder.
 * @returns the exported files.
 * @throws {GodotExportError} when the process ends without writing the page, engine, and pack.
 */
export async function exportWeb(options: WebExportOptions): Promise<GodotWebExport> {
  const project = await readFile(join(options.projectDir, PROJECT_FILE), 'utf8')
  const splash = wasdSplash(project)
  const outcome = await runExport(options, {
    preset: WEB_EXPORT_PRESET,
    presets: original => withWebPreset(original, options.template),
    target: WEB_EXPORT_ENTRY,
    required: REQUIRED_FILES,
    label: 'Web',
    ...splash === undefined ? {} : {
      finish: async () => {
        const target = join(options.outputDir, WEB_SPLASH_FILE)
        // An export that failed before Godot wrote its splash image gets none.
        if (await readOptional(target) !== undefined) await writeFile(target, await readFile(fileURLToPath(WASD_SPLASH_IMAGES[splash])))
      },
    },
  })
  const { blenderNote, warnings } = outcome
  return {
    projectDir: options.projectDir,
    outputDir: options.outputDir,
    entry: WEB_EXPORT_ENTRY,
    files: outcome.files,
    totalBytes: outcome.files.reduce((sum, file) => sum + file.bytes, 0),
    warnings: [
      ...blenderNote === undefined ? [] : [blenderNote], ...webNotes(project), ...packNotes(outcome.files), ...warnings,
    ].slice(0, EXPORT_WARNINGS),
  }
}

/**
 * Export a project as a Linux x86_64 dedicated server: one executable, {@link SERVER_EXPORT_BINARY}, with the pack
 * embedded and the visuals of every resource stripped, which the WASD Engine game server hosts start with
 * `--headless`, next to the native libraries of the project's GDExtensions, when it has any. Exports writing to one
 * output folder run one at a time, across Hosts too.
 * @param options - process parameters, project, the Linux x86_64 release template, and output folder.
 * @returns the executable.
 * @throws {GodotExportError} when the process ends without writing the executable.
 */
export async function exportServer(options: ExportOptions): Promise<GodotServerExport> {
  const outcome = await runExport(options, {
    preset: SERVER_EXPORT_PRESET,
    presets: original => withServerPreset(original, options.template),
    target: SERVER_EXPORT_BINARY,
    required: [SERVER_EXPORT_BINARY],
    label: 'dedicated server',
  })
  const binary = join(options.outputDir, SERVER_EXPORT_BINARY)
  // Godot copies the template's mode on some hosts and not on others; the host starts the file as a program.
  await chmod(binary, 0o755)
  return {
    projectDir: options.projectDir,
    outputDir: options.outputDir,
    binary: SERVER_EXPORT_BINARY,
    bytes: (outcome.files.find(file => file.path === SERVER_EXPORT_BINARY) as { bytes: number }).bytes,
    files: outcome.files,
    warnings: [...outcome.blenderNote === undefined ? [] : [outcome.blenderNote], ...outcome.warnings].slice(0, EXPORT_WARNINGS),
  }
}

/**
 * The file name of a desktop build: the game's name without the characters file systems refuse, as Godot's own safe
 * file names leave out.
 * @param name - the game's name, or undefined without one.
 * @returns the name, at most 64 characters, or `Game` when nothing is left.
 */
export function desktopFileName(name: string | undefined): string {
  const safe = (name ?? '').replace(/[\u0000-\u001f\u007f:*?"<>|/\\]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/^\.+/u, '').slice(0, 64).trim()
  return safe === '' ? 'Game' : safe
}

/**
 * Export a project for one desktop platform into one ZIP file named after the game. Exports writing to one output
 * folder run one at a time, across Hosts too. While it runs, the export turns on the import of the platform's VRAM
 * compression formats in `project.godot` and, for a project without a boot splash image of its own, names WASD
 * Engine's ({@link wasdSplash}) at {@link EXPORT_SPLASH_PATH} as the boot splash. Afterwards it deletes that image and
 * restores `project.godot`, also when the file changed meanwhile, in which case only those settings return to their
 * earlier values.
 * @param options - process parameters, project, platform, template, and output folder.
 * @returns the exported ZIP file.
 * @throws {GodotExportError} when the process ends without writing the ZIP file.
 */
export async function exportDesktop(options: DesktopExportOptions): Promise<GodotDesktopExport> {
  // An export that the app quit during left the project's files changed.
  await replayExportRestore(options.restoreDir, options.projectDir)
  const blenderNote = await turnOffBlenderImport(options.projectDir, options.signal)
  const projectPath = join(options.projectDir, PROJECT_FILE)
  const name = parseProjectSettings(await readFile(projectPath, 'utf8')).name
  const entry = `${desktopFileName(name)}.zip`
  await mkdir(options.outputDir, { recursive: true })
  return await withFileLock(options.outputDir, async () => {
    await rm(options.outputDir, { recursive: true, force: true })
    await mkdir(options.outputDir, { recursive: true })
    const presetsPath = join(options.projectDir, PRESETS_FILE)
    const originalPresets = await readOptional(presetsPath)
    const projectText = await readFile(projectPath, 'utf8')
    const before = textureImports(projectText)
    const formats = DESKTOP_TEXTURE_FORMATS[options.platform]
    const missing = formats.filter(format => before[format] !== 'true')
    const splash = wasdSplash(projectText)
    const exportText = withExportSplash(withTextureImports(projectText, Object.fromEntries(missing.map(format => [format, 'true']))), splash !== undefined)
    let stdout: string
    let stderr: string
    let ended: string
    const preset = DESKTOP_EXPORT_PRESETS[options.platform]
    const writtenPresets = withDesktopPreset(originalPresets?.toString('utf8'), options.platform, options.template, name ?? desktopFileName(name))
    await writeRestoreRecord(options.restoreDir, {
      format: 1, projectDir: options.projectDir, preset,
      presets: { original: originalPresets?.toString('base64') ?? null, written: writtenPresets },
      ...exportText === projectText ? {} : {
        project: {
          original: projectText, written: exportText, before: Object.fromEntries(missing.map(format => [format, before[format] ?? null])),
        },
      },
    })
    await writeFile(presetsPath, writtenPresets)
    try {
      if (splash !== undefined) {
        const image = exportSplashFile(options.projectDir)
        await mkdir(dirname(image), { recursive: true })
        await writeFile(image, await readFile(fileURLToPath(WASD_SPLASH_IMAGES[splash])))
      }
      if (exportText !== projectText) await writeFile(projectPath, exportText)
      const outcome = await runGodotCommand({
        ...options,
        argv: launcherArgv(options.runtime, options.hostPid, [
          '--headless', '--path', options.projectDir, '--export-release', preset, join(options.outputDir, entry),
        ]),
        cwd: options.projectDir,
      })
      stdout = outcome.stdout
      stderr = outcome.stderr
      ended = outcome.timedOut ? `did not finish within ${formatSeconds(options.timeoutMs)}` : `ended (${describeExit(outcome.exit)})`
    } finally {
      if (originalPresets === undefined) await rm(presetsPath, { force: true })
      else await writeFile(presetsPath, originalPresets)
      if (exportText !== projectText) {
        const current = await readFile(projectPath, 'utf8')
        // Only the export's own settings return, so a change to project.godot made meanwhile stays.
        const earlier = Object.fromEntries(missing.map(format => [format, before[format]]))
        const restored = current === exportText ? projectText : withExportSplash(withTextureImports(current, earlier), false)
        if (restored !== current) await writeFile(projectPath, restored)
      }
      if (splash !== undefined) await rm(exportSplashFile(options.projectDir), { force: true })
      await rm(restoreRecordPath(options.restoreDir, options.projectDir), { force: true })
    }
    options.signal.throwIfAborted()
    const files: { path: string; bytes: number }[] = []
    for (const found of await readdir(options.outputDir, { withFileTypes: true })) {
      if (found.isFile()) files.push({ path: found.name, bytes: (await stat(join(options.outputDir, found.name))).size })
    }
    const lines = [...consoleLines(stderr), ...consoleLines(stdout)]
    const built = files.find(file => file.path === entry)
    if (built === undefined) {
      const errors = lines.filter(line => /\bERROR\b/u.test(line)).slice(-FAILURE_OUTPUT_LINES).join('\n')
      const tail = errors || lastLines(stderr, FAILURE_OUTPUT_LINES) || lastLines(stdout, FAILURE_OUTPUT_LINES)
      throw new GodotExportError(`The Godot ${DESKTOP_PLATFORM_NAMES[options.platform]} export ${ended} without writing ${entry}.${tail === '' ? '' : `\nLast output:\n${tail}`}`)
    }
    const warnings = [...new Set(lines.filter(line => line.startsWith('WARNING:')).map(line => line.slice('WARNING:'.length).trim()))]
    return {
      projectDir: options.projectDir,
      platform: options.platform,
      outputDir: options.outputDir,
      entry,
      bytes: built.bytes,
      warnings: [...blenderNote === undefined ? [] : [blenderNote], ...warnings].slice(0, EXPORT_WARNINGS),
    }
  }, { signal: options.signal, waitMs: options.timeoutMs })
}

/** The platforms' names as messages write them. */
const DESKTOP_PLATFORM_NAMES: Readonly<Record<GodotDesktopPlatform, string>> = { windows: 'Windows', macos: 'macOS' }
