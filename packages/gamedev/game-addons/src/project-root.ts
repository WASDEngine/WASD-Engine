/**
 * A whole Godot project installed as one add-on folder, as a starter kit is: the root files that stay out of the game
 * project, and the rewrite of the kit's `res://` paths to the folder that now holds its files.
 * @module @deepseek-ai/dsh-game-addons/src/project-root
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Root entries of a project archive that the installation leaves out when the archive has them: a nested
 * `project.godot` makes Godot treat the folder as another project and skip it, and the import cache and export
 * presets belong to the game project.
 */
export const PROJECT_ROOT_SKIPPED: readonly string[] = ['project.godot', '.godot', 'export_presets.cfg']

/** Text files whose `res://` paths name files of the kit: scenes, resources, scripts, shaders, and data. */
const REBASED_FILES = /\.(?:tscn|tres|gd|gdshader|gdshaderinc|cfg|json)$/u

/**
 * Rewrite the `res://` paths in an unpacked project's text files so that they name the files below its add-on folder.
 * Import settings (`.import`) keep their paths, which Godot writes again at the next import, and binary resources are
 * left as they are.
 * @param folder - absolute folder that holds the unpacked files.
 * @param files - the unpacked paths relative to `folder`, with `/` separators.
 * @param prefix - `res://` path of the add-on folder, ending in `/`.
 * @param signal - cancellation between files.
 * @returns once every text file is rewritten.
 */
export async function rebaseProjectPaths(folder: string, files: readonly string[], prefix: string, signal: AbortSignal): Promise<void> {
  for (const file of files) {
    if (!REBASED_FILES.test(file)) continue
    signal.throwIfAborted()
    const path = join(folder, ...file.split('/'))
    const text = await readFile(path, 'utf8')
    const rebased = text.replaceAll('res://', prefix)
    if (rebased !== text) await writeFile(path, rebased)
  }
}
