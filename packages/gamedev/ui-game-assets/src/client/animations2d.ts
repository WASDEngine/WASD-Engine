/**
 * Finding the 2D animations of one image, for the Assets tab and for the agent: the image's own frames, the Godot
 * scenes and resources whose animations show it, a sprite sheet JSON file beside it, and the numbered images it
 * belongs to. Godot files are read only when they name the image's file, and each source's failure leaves the others.
 */
import { formatOf } from './formats.ts'
import { godotSpriteAnimations, ownFramesAnimation, sequenceAnimation, sheetAnimations, uniqueNames, type GodotFile, type SpriteAnimation } from './sprites.ts'

/** Godot scenes and resources read for one image. */
export const MAX_GODOT_READS = 400

/** Largest Godot file or sprite sheet JSON file read, in bytes. */
export const MAX_TEXT_BYTES = 1024 * 1024

/** The project's Godot files and the folders holding `project.godot`. */
type GodotListing = { readonly files: readonly string[]; readonly projects: readonly string[] }

/** Files read at once. */
const READ_CONCURRENCY = 6

/** What finding an image's animations reads. */
export interface AnimationSources {
  /**
   * Read a text file of the workspace.
   * @param path - workspace path.
   * @param signal - cancellation.
   * @returns the text, or undefined when the file is missing, larger than {@link MAX_TEXT_BYTES}, or unreadable.
   */
  readonly readText: (path: string, signal: AbortSignal) => Promise<string | undefined>
  /**
   * List the files of one workspace folder.
   * @param folder - workspace path of the folder; empty for the project folder.
   * @param signal - cancellation.
   * @returns the files' workspace paths, or none when the folder cannot be listed.
   */
  readonly files: (folder: string, signal: AbortSignal) => Promise<readonly string[]>
  /**
   * The project's Godot scenes and resources and the folders holding `project.godot`.
   * @param signal - cancellation.
   * @returns workspace paths.
   */
  readonly godot: (signal: AbortSignal) => Promise<{ readonly files: readonly string[]; readonly projects: readonly string[] }>
}

async function readAll(paths: readonly string[], read: AnimationSources['readText'], signal: AbortSignal): Promise<GodotFile[]> {
  const files: GodotFile[] = []
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const path = paths[next] as string
      next += 1
      const text = await read(path, signal)
      if (text !== undefined) files.push({ path, text })
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker))
  return files
}

/**
 * Find the animations of one image.
 * @param path - workspace path of the image.
 * @param size - the image's size in pixels.
 * @param ownDurations - the durations of the image's own frames, when it has more than one.
 * @param sources - the reads.
 * @param signal - cancellation.
 * @returns the animations with unique names: own frames first, then Godot, sprite sheet, and numbered images.
 */
export async function findAnimations(
  path: string,
  size: { readonly width: number; readonly height: number },
  ownDurations: readonly number[] | undefined,
  sources: AnimationSources,
  signal: AbortSignal,
): Promise<SpriteAnimation[]> {
  const slash = path.lastIndexOf('/')
  const folder = slash < 0 ? '' : path.slice(0, slash)
  const name = path.slice(slash + 1)
  const stem = name.slice(0, name.lastIndexOf('.') > 0 ? name.lastIndexOf('.') : name.length)
  const found: SpriteAnimation[] = []
  if (ownDurations !== undefined && ownDurations.length > 1) found.push(ownFramesAnimation(path, ownDurations))
  const [godot, siblings] = await Promise.all([
    // A source that fails leaves the others' animations.
    sources.godot(signal).catch((): GodotListing => ({ files: [], projects: [] })),
    sources.files(folder, signal).catch((): readonly string[] => []),
  ])
  const godotFiles = await readAll(godot.files.slice(0, MAX_GODOT_READS), sources.readText, signal)
  const godotTexts = godotFiles.filter(file => file.text.includes(name))
  found.push(...godotSpriteAnimations(godotTexts, path, godot.projects, size))
  const sheetPath = folder === '' ? `${stem}.json` : `${folder}/${stem}.json`
  if (siblings.includes(sheetPath)) {
    const text = await sources.readText(sheetPath, signal)
    if (text !== undefined) {
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        // SyntaxError: a JSON file that does not parse describes no sheet.
        json = undefined
      }
      found.push(...sheetAnimations(json, path, sheetPath))
    }
  }
  const sequence = sequenceAnimation(path, siblings.filter(sibling => formatOf(sibling)?.kind === 'image'))
  if (sequence !== undefined) found.push(sequence)
  return uniqueNames(found)
}
