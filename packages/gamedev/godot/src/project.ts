/**
 * Locating a Session's Godot project, reading the `project.godot` settings the Host shows, and mapping between
 * file paths and `res://` paths.
 * @module @deepseek-ai/dsh-godot/src/project
 */
import type { Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** How many directory levels below the working directory the search for the nearest `project.godot` descends. */
export const PROJECT_SEARCH_DEPTH = 3

/**
 * Directories never searched: version control data, dependencies, Godot's import cache, agent state, and WASD Engine's
 * project state, which holds the backups of removed add-ons.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules', '.godot', '.agents', '.wasdengine'])

const PROJECT_FILE = 'project.godot'

/** A Godot project folder and the settings the Host reports. */
export interface GodotProject {
  /** Absolute folder holding `project.godot`. */
  readonly dir: string
  /** `application/config/name`, when set. */
  readonly name?: string
  /** `application/run/main_scene`, when set. */
  readonly mainScene?: string
}

/** No usable `project.godot` for a request; `directory` is where the Host looked. */
export class GodotProjectError extends Error {
  override name = 'GodotProjectError'

  /**
   * @param message - actionable explanation for the model or user.
   * @param directory - directory that was searched or named.
   */
  constructor(message: string, readonly directory: string) {
    super(message)
  }
}

/** Settings read from `project.godot`. */
export interface ProjectSettings {
  /** `application/config/name`. */
  readonly name?: string
  /** `application/run/main_scene`. */
  readonly mainScene?: string
}

/**
 * Decode a Godot quoted string value.
 * @param value - raw value text after `=`.
 * @returns the string, or undefined when the value is not a plain quoted string.
 */
function parseGodotString(value: string): string | undefined {
  const match = /^"((?:[^"\\]|\\.)*)"$/u.exec(value)
  if (match === null) return undefined
  return (match[1] as string).replace(/\\(.)/gu, (_escape, character: string) => {
    if (character === 'n') return '\n'
    if (character === 't') return '\t'
    return character
  })
}

/**
 * List the `[application]` settings of `project.godot` text.
 * @param text - complete file content.
 * @yields each setting's key, such as `config/name`, and its raw value text after `=`.
 */
function* applicationSettings(text: string): Generator<readonly [string, string]> {
  let section = ''
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    const header = /^\[([^\]]+)\]$/u.exec(line)
    if (header !== null) {
      section = header[1] as string
      continue
    }
    const separator = line.indexOf('=')
    if (section === 'application' && separator >= 0) yield [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
  }
}

/**
 * Read `application/config/name` and `application/run/main_scene` from `project.godot` text.
 * @param text - complete file content.
 * @returns the settings that are present as plain quoted strings.
 */
export function parseProjectSettings(text: string): ProjectSettings {
  let name: string | undefined
  let mainScene: string | undefined
  for (const [key, raw] of applicationSettings(text)) {
    const value = parseGodotString(raw)
    if (key === 'config/name') name = value
    else if (key === 'run/main_scene') mainScene = value
  }
  return { ...name === undefined ? {} : { name }, ...mainScene === undefined ? {} : { mainScene } }
}

/**
 * Name the folder inside a project where Godot keeps the project's import data and caches: `.godot`, or `godot`
 * when `application/config/use_hidden_project_data_directory` is `false`.
 * @param text - complete `project.godot` content.
 * @returns the folder name.
 */
export function projectDataDirectory(text: string): string {
  let hidden = true
  for (const [key, value] of applicationSettings(text)) {
    if (key === 'config/use_hidden_project_data_directory') hidden = value !== 'false'
  }
  return hidden ? '.godot' : 'godot'
}

/**
 * List a folder's entries in name order.
 * @param directory - absolute folder.
 * @returns the entries; an absent or unreadable folder has none.
 */
export async function readDirectory(directory: string): Promise<Dirent[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') return []
    throw error
  }
  const byName = new Map(entries.map(entry => [entry.name, entry]))
  return [...byName.keys()].sort().map(name => byName.get(name) as Dirent)
}

/**
 * Whether a path names a file.
 * @param path - absolute path.
 * @returns false when nothing exists there or it is not a file.
 */
export async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return false
    throw error
  }
}

/**
 * Find the shallowest folder holding `project.godot`, breadth first in name order.
 * @param root - absolute working directory.
 * @param signal - cancellation.
 * @returns the folder, or undefined when none exists within {@link PROJECT_SEARCH_DEPTH} levels.
 */
async function findNearestProject(root: string, signal: AbortSignal): Promise<string | undefined> {
  let level = [root]
  for (let depth = 0; depth <= PROJECT_SEARCH_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = []
    for (const directory of level) {
      signal.throwIfAborted()
      const entries = await readDirectory(directory)
      if (entries.some(entry => entry.name === PROJECT_FILE && entry.isFile())) return directory
      for (const entry of entries) {
        if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) next.push(join(directory, entry.name))
      }
    }
    level = next
  }
  return undefined
}

/**
 * Read a project folder's settings.
 * @param dir - absolute folder holding `project.godot`.
 * @returns the project.
 */
export async function readGodotProject(dir: string): Promise<GodotProject> {
  return { dir, ...parseProjectSettings(await readFile(join(dir, PROJECT_FILE), 'utf8')) }
}

/**
 * Resolve the project a request names, or the nearest one below the working directory.
 * @param workingDirectory - absolute Session working directory.
 * @param requested - folder or `project.godot` path relative to the working directory; undefined searches.
 * @param signal - cancellation.
 * @returns the project with its settings.
 * @throws {GodotProjectError} when no `project.godot` is found.
 */
export async function resolveGodotProject(
  workingDirectory: string,
  requested: string | undefined,
  signal: AbortSignal,
): Promise<GodotProject> {
  if (requested !== undefined) {
    const target = resolve(workingDirectory, requested)
    const dir = basename(target) === PROJECT_FILE ? dirname(target) : target
    if (!await isFile(join(dir, PROJECT_FILE))) {
      throw new GodotProjectError(`No project.godot in ${dir}; pass the folder that contains project.godot, relative to the working directory.`, dir)
    }
    signal.throwIfAborted()
    return readGodotProject(dir)
  }
  const dir = await findNearestProject(workingDirectory, signal)
  if (dir === undefined) {
    throw new GodotProjectError(`No project.godot in ${workingDirectory} or the ${PROJECT_SEARCH_DEPTH} folder levels below it; create a Godot project there or pass project.`, workingDirectory)
  }
  return readGodotProject(dir)
}

/**
 * Validate a scene a run request names.
 * @param project - project to run.
 * @param scene - `res://` path of an existing scene file, or a `uid://` reference.
 * @returns the scene unchanged.
 * @throws {GodotProjectError} for another path form or a missing scene file.
 */
export async function resolveScene(project: GodotProject, scene: string): Promise<string> {
  if (scene.startsWith('uid://')) return scene
  if (!scene.startsWith('res://')) throw new GodotProjectError(`scene must be a res:// or uid:// path, got ${scene}.`, project.dir)
  if (!await isFile(join(project.dir, scene.slice('res://'.length)))) {
    throw new GodotProjectError(`The scene ${scene} does not exist in ${project.dir}.`, project.dir)
  }
  return scene
}

/** Files found below a project folder. */
export interface ProjectFiles {
  /** Up to the requested number of absolute paths, in path order. */
  readonly files: readonly string[]
  /** All matching files. */
  readonly total: number
}

/**
 * List files with one extension below a project folder, in path order, skipping the folders the project search skips.
 * @param root - absolute project folder.
 * @param extension - file name suffix such as `.gd`.
 * @param limit - maximum number of paths returned.
 * @param signal - cancellation.
 * @returns up to `limit` absolute paths and the total number found.
 */
export async function listProjectFiles(root: string, extension: string, limit: number, signal: AbortSignal): Promise<ProjectFiles> {
  const files: string[] = []
  let total = 0
  const walk = async (directory: string): Promise<void> => {
    signal.throwIfAborted()
    for (const entry of await readDirectory(directory)) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) await walk(path)
      } else if (entry.isFile() && entry.name.endsWith(extension)) {
        total += 1
        if (files.length < limit) files.push(path)
      }
    }
  }
  await walk(root)
  return { files, total }
}

/** File whose folder, with everything below it, the editor does not scan for import. */
const IGNORE_MARKER = '.gdignore'

/**
 * Find a file with one extension that the editor's file scan reaches: the first in path order, skipping hidden entries,
 * folders that hold a `.gdignore` file, and the folders the project search skips.
 * @param root - absolute project folder.
 * @param extension - lower-case file name suffix such as `.blend`, matched without regard to case.
 * @param signal - cancellation.
 * @returns the absolute path, or undefined when the project has no such file.
 */
export async function findScannedFile(root: string, extension: string, signal: AbortSignal): Promise<string | undefined> {
  const walk = async (directory: string): Promise<string | undefined> => {
    signal.throwIfAborted()
    const entries = await readDirectory(directory)
    if (directory !== root && entries.some(entry => entry.name === IGNORE_MARKER)) return undefined
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        const found = SKIPPED_DIRECTORIES.has(entry.name) ? undefined : await walk(path)
        if (found !== undefined) return found
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
        return path
      }
    }
    return undefined
  }
  return await walk(root)
}

/**
 * Map a path inside a project to its `res://` form.
 * @param projectDir - absolute project folder.
 * @param path - absolute path inside the folder.
 * @returns the `res://` path with forward slashes.
 */
export function toResPath(projectDir: string, path: string): string {
  return `res://${relative(projectDir, path).split(sep).join('/')}`
}

/**
 * Resolve a `res://` path, an absolute path, or a working-directory-relative path to an absolute path inside the project.
 * @param projectDir - absolute project folder.
 * @param workingDirectory - absolute Session working directory.
 * @param path - path as the model gave it.
 * @returns the absolute path, or undefined when it lies outside the project.
 */
export function resolveProjectPath(projectDir: string, workingDirectory: string, path: string): string | undefined {
  const absolute = path.startsWith('res://') ? join(projectDir, path.slice('res://'.length)) : resolve(workingDirectory, path)
  const inside = relative(projectDir, absolute)
  return inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside) ? undefined : absolute
}
