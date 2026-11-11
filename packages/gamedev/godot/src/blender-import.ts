/**
 * Godot's Blender scene importer, which this headless Godot cannot use. The importer turns a `.blend` file into a scene
 * by running the Blender executable that the editor settings name; in a headless editor without one, its import support
 * query fails, and the editor then skips every pending import of the project, not only the `.blend` file's. Before an
 * import step, a project whose editor scan reaches a `.blend` file therefore gets the importer turned off in
 * `project.godot`, as the desktop editor offers when it finds no Blender. The Godot plugin never lets Godot run Blender.
 * @module @deepseek-ai/dsh-godot/src/blender-import
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { findScannedFile, toResPath } from './project.ts'

/** Section of `project.godot` that holds the importer switch. */
export const BLENDER_IMPORT_SECTION = 'filesystem'

/** Key of the importer switch inside {@link BLENDER_IMPORT_SECTION}: `filesystem/import/blender/enabled`. */
export const BLENDER_IMPORT_KEY = 'import/blender/enabled'

const PROJECT_FILE = 'project.godot'
const HEADER = /^\[([^\]]+)\]$/u

/**
 * `project.godot` text with the Blender importer turned off.
 * @param text - complete file content.
 * @returns the new content, or undefined when the importer is already off.
 */
export function withBlenderImportOff(text: string): string | undefined {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/u)
  const setting = `${BLENDER_IMPORT_KEY}=false`
  let section = ''
  let header = -1
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    const match = HEADER.exec(line)
    if (match !== null) {
      section = match[1] as string
      if (section === BLENDER_IMPORT_SECTION) header = index
      continue
    }
    if (section !== BLENDER_IMPORT_SECTION) continue
    const separator = line.indexOf('=')
    if (separator < 0 || line.slice(0, separator).trim() !== BLENDER_IMPORT_KEY) continue
    if (line.slice(separator + 1).trim() === 'false') return undefined
    lines[index] = setting
    return lines.join(newline)
  }
  if (header >= 0) {
    // Godot writes one blank line after a section header, then the keys.
    const at = lines[header + 1]?.trim() === '' ? header + 2 : header + 1
    lines.splice(at, 0, setting)
    return lines.join(newline)
  }
  const body = text.endsWith('\n') || text === '' ? text : `${text}${newline}`
  return `${body}${newline}[${BLENDER_IMPORT_SECTION}]${newline}${newline}${setting}${newline}`
}

/**
 * Turn the Blender importer off in a project whose editor scan reaches a `.blend` file.
 * @param projectDir - absolute folder holding `project.godot`.
 * @param signal - cancellation.
 * @returns a note for the agent when `project.godot` changed, otherwise undefined.
 */
export async function turnOffBlenderImport(projectDir: string, signal: AbortSignal): Promise<string | undefined> {
  const path = join(projectDir, PROJECT_FILE)
  // A project whose importer is already off needs no scan.
  const updated = withBlenderImportOff(await readFile(path, 'utf8'))
  if (updated === undefined) return undefined
  const blend = await findScannedFile(projectDir, '.blend', signal)
  if (blend === undefined) return undefined
  signal.throwIfAborted()
  await writeFileAtomic(path, updated, { mode: (await stat(path)).mode & 0o777 })
  return `Turned off Godot's Blender import in project.godot (${BLENDER_IMPORT_SECTION}/${BLENDER_IMPORT_KEY}=false) because of `
    + `${toResPath(projectDir, blend)}: this Godot cannot import .blend files, and while the importer was on, no file of the `
    + 'project imported. Export Blender models to .glb with the Blender tools and keep the .blend files as their sources.'
}
