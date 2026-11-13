/**
 * Exports: one headless LibGodot editor process exports a project with a preset of WASD Engine's into a folder.
 *
 * The Web export (`WASD Engine Web`) fills the folder with `index.html`, the engine (`index.js`, `index.wasm`), the
 * game's pack (`index.pck`), the audio worklets, and the icons. The preset uses the single-threaded Web template and no
 * GDExtensions, so the build needs no cross-origin isolation and plays in any page that frames it. Godot's Web runtime
 * draws no boot splash; only the page's loading screen shows the splash image, Godot's logo unless the project names
 * its own, so for a project without one the preset's head include hides that image and the loading screen shows the
 * progress bar alone on the project's splash color.
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
 * Godot reads export presets only from the project's `export_presets.cfg`, so a preset is written there for the export
 * alone: the file's original bytes are restored afterwards, or the file is removed when the project had none, and the
 * project's own presets never change.
 * @module @deepseek-ai/dsh-godot/src/export
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { turnOffBlenderImport } from './blender-import.ts'
import { runGodotCommand } from './command.ts'
import { consoleLines, describeExit, formatSeconds, lastLines } from './output.ts'
import { FAILURE_OUTPUT_LINES } from './run.ts'
import { parseProjectSettings } from './project.ts'
import { launcherArgv, type ResolvedGodotRuntime } from './runtime.ts'
import type { GodotDesktopExport, GodotDesktopPlatform, GodotWebExport } from './types.ts'

/** Name of the export preset the Web export writes for the duration of one export. */
export const WEB_EXPORT_PRESET = 'WASD Engine Web'

/** The page that starts an exported game. */
export const WEB_EXPORT_ENTRY = 'index.html'

/** Most Godot warnings a result lists. */
export const EXPORT_WARNINGS = 10

/**
 * Markup the Web build's page includes in its head to hide the loading screen's splash image, `#status-splash` in
 * Godot's page template, which shows Godot's logo for a project without a boot splash image of its own.
 */
export const HIDE_SPLASH_HEAD = '<style>#status-splash{display:none!important}</style>'

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
/** The fields every preset of WASD Engine's sets, after its name and platform. */
const PRESET_FIELDS = [
  'runnable=false',
  'dedicated_server=false',
  'custom_features=""',
  'export_filter="all_resources"',
  'include_filter=""',
  'exclude_filter=""',
  'export_path=""',
  'encryption_include_filters=""',
  'encryption_exclude_filters=""',
  'encrypt_pck=false',
  'encrypt_directory=false',
  'script_export_mode=2',
] as const

/** Parameters of one export process. */
export interface WebExportOptions {
  /** Host subprocess service. */
  readonly subprocess: SubprocessRuntime
  /** Runtime to launch; its library must be an editor build. */
  readonly runtime: ResolvedGodotRuntime
  /** Absolute folder holding `project.godot`. */
  readonly projectDir: string
  /** Absolute folder the export empties and fills. */
  readonly outputDir: string
  /** Absolute path of the export template: the single-threaded Web release template ZIP, or the desktop one. */
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

/** Parameters of one desktop export process. */
export interface DesktopExportOptions extends WebExportOptions {
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
 * Whether a project names a boot splash image of its own, which its Web build's loading screen then shows.
 * @param projectText - `project.godot` text.
 * @returns true when its `[application]` section sets `boot_splash/image`, or a feature override of it, to a path.
 */
export function customBootSplash(projectText: string): boolean {
  let section = ''
  for (const line of projectText.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) {
      section = header[1] as string
      continue
    }
    if (section === 'application' && /^boot_splash\/image(?:\.[\w.]+)?="[^"\s]/u.test(line)) return true
  }
  return false
}

/**
 * Add one preset to an `export_presets.cfg` text, after the project's presets. Godot reads presets from index 0 up to
 * the first missing one, so presets are renumbered without gaps, and an earlier preset of the same name, such as one an
 * interrupted export left behind, is replaced.
 * @param original - the file's text, or undefined when the project has none.
 * @param name - the preset's name.
 * @param platform - Godot's name of the preset's platform, such as `Web` or `Windows Desktop`.
 * @param options - the preset's option lines.
 * @returns the file text for the export.
 */
function withPreset(original: string | undefined, name: string, platform: string, options: readonly string[]): string {
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
  const kept = [...presets.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, sections]) => sections)
    .filter(sections => !sections.preset.some(line => line.trim() === `name=${quote(name)}`))
  const blocks = kept.map((sections, index) => [
    `[preset.${index}]`,
    ...sections.preset,
    ...sections.options === undefined ? [] : [`[preset.${index}.options]`, ...sections.options],
  ].join('\n').trimEnd())
  const index = kept.length
  blocks.push([
    `[preset.${index}]`,
    '',
    `name=${quote(name)}`,
    `platform=${quote(platform)}`,
    ...PRESET_FIELDS,
    '',
    `[preset.${index}.options]`,
    '',
    ...options,
  ].join('\n'))
  const prefix = other.join('\n').trim()
  return `${prefix === '' ? '' : `${prefix}\n\n`}${blocks.join('\n\n')}\n`
}

/**
 * Add the Web export preset to an `export_presets.cfg` text, after the project's presets, replacing an earlier
 * `WASD Engine Web` preset.
 * @param original - the file's text, or undefined when the project has none.
 * @param template - absolute path of the Web release template.
 * @param hideSplash - include {@link HIDE_SPLASH_HEAD} in the page, for a project without a boot splash image of its own.
 * @returns the file text for the export.
 */
export function withWebPreset(original: string | undefined, template: string, hideSplash: boolean): string {
  return withPreset(original, WEB_EXPORT_PRESET, 'Web', [
    'custom_template/debug=""',
    `custom_template/release=${quote(template)}`,
    'variant/extensions_support=false',
    'variant/thread_support=false',
    'vram_texture_compression/for_desktop=true',
    'vram_texture_compression/for_mobile=false',
    'html/export_icon=true',
    'html/custom_html_shell=""',
    `html/head_include=${quote(hideSplash ? HIDE_SPLASH_HEAD : '')}`,
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
      return withPreset(original, DESKTOP_EXPORT_PRESETS.windows, 'Windows Desktop', [
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
      return withPreset(original, DESKTOP_EXPORT_PRESETS.macos, 'macOS', [
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

/**
 * Export a project for the Web. Exports writing to one output folder run one at a time, across Hosts too.
 * @param options - process parameters, project, template, and output folder.
 * @returns the exported files.
 * @throws {GodotExportError} when the process ends without writing the page, engine, and pack.
 */
export async function exportWeb(options: WebExportOptions): Promise<GodotWebExport> {
  // The export scans and imports the project like the import step.
  const blenderNote = await turnOffBlenderImport(options.projectDir, options.signal)
  const project = await readFile(join(options.projectDir, 'project.godot'), 'utf8')
  await mkdir(options.outputDir, { recursive: true })
  return await withFileLock(options.outputDir, async () => {
    await rm(options.outputDir, { recursive: true, force: true })
    await mkdir(options.outputDir, { recursive: true })
    const presetsPath = join(options.projectDir, PRESETS_FILE)
    const original = await readOptional(presetsPath)
    await writeFile(presetsPath, withWebPreset(original?.toString('utf8'), options.template, !customBootSplash(project)))
    let stdout: string
    let stderr: string
    let ended: string
    try {
      const outcome = await runGodotCommand({
        ...options,
        argv: launcherArgv(options.runtime, options.hostPid, [
          '--headless', '--path', options.projectDir, '--export-release', WEB_EXPORT_PRESET, join(options.outputDir, WEB_EXPORT_ENTRY),
        ]),
        cwd: options.projectDir,
      })
      stdout = outcome.stdout
      stderr = outcome.stderr
      ended = outcome.timedOut ? `did not finish within ${formatSeconds(options.timeoutMs)}` : `ended (${describeExit(outcome.exit)})`
    } finally {
      if (original === undefined) await rm(presetsPath, { force: true })
      else await writeFile(presetsPath, original)
    }
    options.signal.throwIfAborted()
    const files: { path: string; bytes: number }[] = []
    for (const entry of await readdir(options.outputDir, { withFileTypes: true })) {
      if (entry.isFile()) files.push({ path: entry.name, bytes: (await stat(join(options.outputDir, entry.name))).size })
    }
    files.sort((left, right) => left.path.localeCompare(right.path))
    const missing = REQUIRED_FILES.filter(name => !files.some(file => file.path === name))
    const lines = [...consoleLines(stderr), ...consoleLines(stdout)]
    if (missing.length > 0) {
      const errors = lines.filter(line => /\bERROR\b/u.test(line)).slice(-FAILURE_OUTPUT_LINES).join('\n')
      const tail = errors || lastLines(stderr, FAILURE_OUTPUT_LINES) || lastLines(stdout, FAILURE_OUTPUT_LINES)
      throw new GodotExportError(`The Godot Web export ${ended} without writing ${missing.join(', ')}.${tail === '' ? '' : `\nLast output:\n${tail}`}`)
    }
    const warnings = [...new Set(lines.filter(line => line.startsWith('WARNING:')).map(line => line.slice('WARNING:'.length).trim()))]
    return {
      projectDir: options.projectDir,
      outputDir: options.outputDir,
      entry: WEB_EXPORT_ENTRY,
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
      warnings: [
        ...blenderNote === undefined ? [] : [blenderNote], ...webNotes(project), ...packNotes(files), ...warnings,
      ].slice(0, EXPORT_WARNINGS),
    }
  }, { signal: options.signal, waitMs: options.timeoutMs })
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
 * folder run one at a time, across Hosts too. The export turns on the import of the platform's VRAM compression
 * formats in `project.godot` while it runs and then restores those settings, also when `project.godot` changed
 * meanwhile, in which case only those settings return to their earlier values.
 * @param options - process parameters, project, platform, template, and output folder.
 * @returns the exported ZIP file.
 * @throws {GodotExportError} when the process ends without writing the ZIP file.
 */
export async function exportDesktop(options: DesktopExportOptions): Promise<GodotDesktopExport> {
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
    const exportText = withTextureImports(projectText, Object.fromEntries(missing.map(format => [format, 'true'])))
    let stdout: string
    let stderr: string
    let ended: string
    await writeFile(presetsPath, withDesktopPreset(originalPresets?.toString('utf8'), options.platform, options.template, name ?? desktopFileName(name)))
    try {
      if (exportText !== projectText) await writeFile(projectPath, exportText)
      const outcome = await runGodotCommand({
        ...options,
        argv: launcherArgv(options.runtime, options.hostPid, [
          '--headless', '--path', options.projectDir, '--export-release', DESKTOP_EXPORT_PRESETS[options.platform], join(options.outputDir, entry),
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
        // Only the import settings return, so a change to project.godot made meanwhile stays.
        const earlier = Object.fromEntries(missing.map(format => [format, before[format]]))
        const restored = current === exportText ? projectText : withTextureImports(current, earlier)
        if (restored !== current) await writeFile(projectPath, restored)
      }
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
