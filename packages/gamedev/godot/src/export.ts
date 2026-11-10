/**
 * Web export: one headless LibGodot editor process exports a project with the `WASD Engine Web` preset into a folder
 * that then holds `index.html`, the engine (`index.js`, `index.wasm`), the game's pack (`index.pck`), the audio
 * worklets, and the icons. The preset uses the single-threaded Web template and no GDExtensions, so the build needs no
 * cross-origin isolation and plays in any page that frames it. Godot reads export presets only from the project's
 * `export_presets.cfg`, so the preset is written there for the export alone: the file's original bytes are restored
 * afterwards, or the file is removed when the project had none, and the project's own presets never change.
 * @module @deepseek-ai/dsh-godot/src/export
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { consoleLines, describeExit, formatSeconds, lastLines } from './output.ts'
import { FAILURE_OUTPUT_LINES, launcherArgv } from './run.ts'
import type { ResolvedGodotRuntime } from './runtime.ts'
import type { GodotWebExport } from './types.ts'

/** Name of the export preset the Web export writes for the duration of one export. */
export const WEB_EXPORT_PRESET = 'WASD Engine Web'

/** The page that starts an exported game. */
export const WEB_EXPORT_ENTRY = 'index.html'

/** Most Godot warnings a result lists. */
export const EXPORT_WARNINGS = 10

const PRESETS_FILE = 'export_presets.cfg'
const REQUIRED_FILES = [WEB_EXPORT_ENTRY, 'index.js', 'index.wasm', 'index.pck'] as const

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
  /** Absolute path of the single-threaded Web release template ZIP. */
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
 * Add the Web export preset to an `export_presets.cfg` text, after the project's presets. Godot reads presets
 * from index 0 up to the first missing one, so presets are renumbered without gaps, and an earlier `WASD Engine Web`
 * preset, such as one an interrupted export left behind, is replaced.
 * @param original - the file's text, or undefined when the project has none.
 * @param template - absolute path of the Web release template.
 * @returns the file text for the export.
 */
export function withWebPreset(original: string | undefined, template: string): string {
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
    .filter(sections => !sections.preset.some(line => line.trim() === `name=${quote(WEB_EXPORT_PRESET)}`))
  const blocks = kept.map((sections, index) => [
    `[preset.${index}]`,
    ...sections.preset,
    ...sections.options === undefined ? [] : [`[preset.${index}.options]`, ...sections.options],
  ].join('\n').trimEnd())
  const index = kept.length
  blocks.push([
    `[preset.${index}]`,
    '',
    `name=${quote(WEB_EXPORT_PRESET)}`,
    'platform="Web"',
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
    '',
    `[preset.${index}.options]`,
    '',
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
  ].join('\n'))
  const prefix = other.join('\n').trim()
  return `${prefix === '' ? '' : `${prefix}\n\n`}${blocks.join('\n\n')}\n`
}

/**
 * Notes about how the Web build of a project differs from its desktop runs.
 * @param projectText - `project.godot` text.
 * @returns the notes.
 */
export function webNotes(projectText: string): string[] {
  const method = /^renderer\/rendering_method="([^"]+)"/mu.exec(projectText)?.[1]
  const webMethod = /^renderer\/rendering_method\.web="([^"]+)"/mu.exec(projectText)?.[1]
  if ((method === 'forward_plus' || method === 'mobile') && (webMethod === undefined || webMethod === 'gl_compatibility')) {
    return ['The Web build renders with the Compatibility renderer (WebGL 2), so effects that need Forward+ or Mobile, such as SSAO, SSR, SDFGI, and volumetric fog, are missing or look different there.']
  }
  return []
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
  const project = await readFile(join(options.projectDir, 'project.godot'), 'utf8')
  await mkdir(options.outputDir, { recursive: true })
  return await withFileLock(options.outputDir, async () => {
    await rm(options.outputDir, { recursive: true, force: true })
    await mkdir(options.outputDir, { recursive: true })
    const presetsPath = join(options.projectDir, PRESETS_FILE)
    const original = await readOptional(presetsPath)
    await writeFile(presetsPath, withWebPreset(original?.toString('utf8'), options.template))
    let stdout: string
    let stderr: string
    let ended: string
    const timeout = AbortSignal.timeout(options.timeoutMs)
    try {
      const handle = options.subprocess.spawn({
        argv: launcherArgv(options.runtime, options.hostPid, [
          '--headless', '--path', options.projectDir, '--export-release', WEB_EXPORT_PRESET, join(options.outputDir, WEB_EXPORT_ENTRY),
        ]),
        cwd: options.projectDir,
        stdio: { stdin: 'ignore', stdout: { maxBytes: options.outputBytes }, stderr: { maxBytes: options.outputBytes } },
        graceMs: options.graceMs,
        signal: AbortSignal.any([options.signal, timeout]),
        env: { ELECTRON_RUN_AS_NODE: undefined },
      })
      const outcome = await handle.done
      stdout = (handle.collected.stdout as SubprocessOutputReader).readFrom(0).text
      stderr = (handle.collected.stderr as SubprocessOutputReader).readFrom(0).text
      ended = timeout.aborted ? `did not finish within ${formatSeconds(options.timeoutMs)}` : `ended (${describeExit(outcome)})`
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
      warnings: [...webNotes(project), ...warnings].slice(0, EXPORT_WARNINGS),
    }
  }, { signal: options.signal, waitMs: options.timeoutMs })
}
