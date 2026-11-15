/**
 * Saving references into a game project: each image goes into `references/<subject>/` under the project's folder,
 * numbered after the files already there, with a sheet of an animated image's frames beside it, and its source in the
 * folder's `SOURCES.md`. An empty `references/.gdignore` keeps Godot from importing the folder, so references never
 * become part of the game or its exports. Everything a save writes is drawn first; then each file takes its number only
 * when no other file has that name, so parallel saves never overwrite each other, and a save that fails or is cancelled
 * while writing removes the files it wrote. An image already saved in the folder, byte for byte, is not saved again.
 * @module @deepseek-ai/dsh-art-references/src/save
 */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, copyFile, link, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileStem, HASH_NAME, IMAGE_EXTENSIONS, type CachedImage } from './finder.ts'
import { drawFramesSheet, UnreadableImage, type FramesLayout, type FramesSheet } from './images.ts'
import type { SavedReference } from './types.ts'

/** The project folder that holds every subject's references. */
export const REFERENCES_FOLDER = 'references'

/** Longest subject folder name. */
const MAX_SUBJECT = 48

/** Longest file name stem after the number. */
const MAX_STEM = 40

/** Saved image files: a number, a name, and an image extension. */
const SAVED_IMAGE = /^\d+-.+\.(?:png|jpg|webp|gif|avif)$/u

/** Error codes of a file system that has no hard links. */
const NO_HARD_LINKS: ReadonlySet<string> = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])

/**
 * A lowercase name made of letters, digits, and hyphens.
 * @param text - any text.
 * @param maxLength - longest result.
 * @returns the name; empty when the text holds no letter or digit.
 */
function slug(text: string, maxLength: number): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/gu, '')
    .slice(0, maxLength).replace(/-+$/u, '')
}

/**
 * The folder name of a subject's references.
 * @param subject - what the references are for, such as "knight" or "Forest tiles".
 * @returns the folder name, such as `forest-tiles`.
 * @throws Error when the subject holds no letter or digit.
 */
export function subjectFolder(subject: string): string {
  const name = slug(subject, MAX_SUBJECT)
  if (name === '') throw new Error('subject must name what the references are for, such as knight or forest tiles.')
  return name
}

/**
 * Text of a title or address as one line of Markdown link text: without line breaks, brackets, or backticks.
 * @param text - the text, which a web page supplied.
 * @returns the cleaned text.
 */
function linkText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/[[\]`]/gu, '').replace(/\s+/gu, ' ').trim()
}

/**
 * An address as a Markdown link target: spaces and parentheses escaped.
 * @param address - an absolute address.
 * @returns the target.
 */
function linkTarget(address: string): string {
  return address.replace(/[\s()<>]/gu, character => `%${(character.codePointAt(0) as number).toString(16).toUpperCase().padStart(2, '0')}`)
}

/**
 * Create `references/.gdignore` when it is missing, leaving an existing one alone.
 * @param project - the game project's folder.
 */
async function ignoreInGodot(project: string): Promise<void> {
  try {
    await writeFile(join(project, REFERENCES_FOLDER, '.gdignore'), '', { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

/**
 * The first lines of a new `SOURCES.md`.
 * @param subject - what the references are for, as the call named it.
 * @returns the heading and the note on what the files are.
 */
function sourcesHeader(subject: string): string {
  return `# References: ${linkText(subject)}\n\n`
    + 'Reference images the agent saved to study shape, style, colors, and motion. They are not game assets: '
    + 'Godot leaves the references folder out of the game (references/.gdignore). Each image belongs to its creator; '
    + 'check its source\'s license before using any of it in the game.\n\n'
}

/**
 * One `SOURCES.md` line.
 * @param saved - the saved file.
 * @param date - the day it was saved, as YYYY-MM-DD.
 * @param local - whether the image was a file on this computer rather than a download.
 * @returns the line, ending in a line break.
 */
function sourceLine(saved: SavedReference, date: string, local: boolean): string {
  const name = saved.file.split('/').at(-1) ?? saved.file
  if (local) {
    // A file on this computer: its name only, since its folders say nothing to a reader of the project.
    const original = basename(saved.image)
    const named = HASH_NAME.test(original.replace(/\.[^.]*$/u, '')) ? '' : ` (\`${linkText(original)}\`)`
    return `- \`${name}\` — a file from this computer${named} — saved ${date}\n`
  }
  const title = linkText(saved.title) || linkText(saved.page)
  const parts = [`[${title}](${linkTarget(saved.page)})`]
  if (saved.image !== saved.page) parts.push(`[image](${linkTarget(saved.image)})`)
  if (saved.video !== undefined) parts.push(`[video](${linkTarget(saved.video)})`)
  return `- \`${name}\` — ${parts.join(' · ')} — saved ${date}\n`
}

/** An image ready to save: its bytes, and the sheet of its frames when it is animated. */
export interface PreparedReference {
  readonly image: CachedImage
  readonly data: Buffer
  readonly frames?: FramesSheet
}

/**
 * Read an image that decodes, such as a download or a file on this computer the finder checked, and draw the sheet of
 * its frames when it is animated, before anything is written.
 * @param image - the image.
 * @param frames - the limits of an animated image's frames sheet.
 * @param signal - cancellation.
 * @returns the image ready to save.
 * @throws UnreadableImage when its file cannot be read or decoded; the signal's reason once it aborts.
 */
export async function prepareReference(image: CachedImage, frames: FramesLayout, signal: AbortSignal): Promise<PreparedReference> {
  signal.throwIfAborted()
  const data = await readFile(image.path).catch((error: unknown) => {
    throw new UnreadableImage(`could not be read (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`, { cause: error })
  })
  if (image.frames <= 1) return { image, data }
  return { image, data, frames: await drawFramesSheet(data, image, frames, signal) }
}

/**
 * The next free file number in a subject folder.
 * @param names - the folder's file names.
 * @returns one more than the highest `NN-` prefix of its files, or 1.
 */
function nextNumber(names: readonly string[]): number {
  return 1 + names.reduce((highest, name) => Math.max(highest, Number(/^(\d+)-/u.exec(name)?.[1] ?? 0)), 0)
}

/**
 * The file in a subject folder that holds exactly an image's bytes, such as one an earlier save of the same image
 * wrote.
 * @param folder - the folder.
 * @param names - its file names.
 * @param prepared - the image.
 * @returns the file's name, or undefined.
 */
async function savedEarlier(folder: string, names: readonly string[], prepared: PreparedReference): Promise<string | undefined> {
  const extension = IMAGE_EXTENSIONS[prepared.image.format]
  for (const name of names) {
    if (!SAVED_IMAGE.test(name) || !name.endsWith(extension) || name.endsWith('.frames.png')) continue
    const path = join(folder, name)
    const found = await stat(path).catch(() => undefined)
    if (found?.isFile() !== true || found.size !== prepared.data.length) continue
    if ((await readFile(path)).equals(prepared.data)) return name
  }
  return undefined
}

/**
 * Give a file a name only while no other file has it: a hard link to the written bytes, or an exclusive copy on a file
 * system without hard links.
 * @param source - the written bytes' temporary file.
 * @param destination - the name.
 * @returns false when another file has the name.
 */
async function publishExclusively(source: string, destination: string): Promise<boolean> {
  try {
    await link(source, destination)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EEXIST') return false
    if (!NO_HARD_LINKS.has(code)) throw error
  }
  try {
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    // A copy that failed part way leaves a partial file of this save's own.
    await rm(destination, { force: true })
    throw error
  }
}

/** The files one image took in a subject folder. */
interface Published {
  readonly number: number
  readonly name: string
  readonly framesName?: string
}

/**
 * Write an image, and its frames sheet, under the lowest free number from `first`: both names take the number only
 * when no other file has either.
 * @param folder - the subject folder.
 * @param first - the number to try first.
 * @param stem - the name after the number.
 * @param prepared - the image.
 * @param written - receives each file's path as it is published, for removal when the save fails.
 * @returns the number and names taken.
 */
async function publishNumbered(
  folder: string,
  first: number,
  stem: string,
  prepared: PreparedReference,
  written: string[],
): Promise<Published> {
  const extension = IMAGE_EXTENSIONS[prepared.image.format]
  const temporaries: string[] = []
  const temporary = async (data: Buffer): Promise<string> => {
    const path = join(folder, `.${randomUUID()}.part`)
    temporaries.push(path)
    await writeFile(path, data)
    return path
  }
  try {
    const image = await temporary(prepared.data)
    const frames = prepared.frames === undefined ? undefined : await temporary(prepared.frames.data)
    for (let number = first; ; number++) {
      const named = `${String(number).padStart(2, '0')}-${stem}`
      const name = `${named}${extension}`
      if (!(await publishExclusively(image, join(folder, name)))) continue
      written.push(join(folder, name))
      if (frames === undefined) return { number, name }
      const framesName = `${named}.frames.png`
      if (await publishExclusively(frames, join(folder, framesName))) {
        written.push(join(folder, framesName))
        return { number, name, framesName }
      }
      // Another file holds this number's frames sheet name: give the number up and try the next.
      written.pop()
      await rm(join(folder, name), { force: true })
    }
  } finally {
    await Promise.allSettled(temporaries.map(path => rm(path, { force: true })))
  }
}

/**
 * Remove the files a failed save wrote, keeping the save's own failure.
 * @param written - their paths.
 */
async function removeWritten(written: readonly string[]): Promise<void> {
  // A file that cannot be removed stays; the save's failure, not the cleanup's, is what the caller learns.
  await Promise.allSettled(written.map(path => rm(path, { force: true })))
}

/**
 * Save images as references of one subject in a game project. Nothing is written once `signal` aborts, and a save that
 * fails or is cancelled while writing removes the files it wrote, so a save either adds every new file and its
 * `SOURCES.md` lines or adds none; an image saved there before, byte for byte, is listed with its earlier file.
 * @param project - absolute path of the game project's folder.
 * @param subject - what the references are for.
 * @param images - the prepared images, in the order to number them.
 * @param now - the time of saving, for `SOURCES.md`.
 * @param signal - cancellation.
 * @returns the saved files.
 * @throws Error when the subject holds no letter or digit, or a file cannot be written; the signal's reason once it
 *   aborts.
 */
export async function saveReferences(
  project: string,
  subject: string,
  images: readonly PreparedReference[],
  now: Date,
  signal: AbortSignal,
): Promise<SavedReference[]> {
  const folderName = subjectFolder(subject)
  const relativeFolder = `${REFERENCES_FOLDER}/${folderName}`
  const folder = join(project, REFERENCES_FOLDER, folderName)
  signal.throwIfAborted()
  await mkdir(folder, { recursive: true })
  await ignoreInGodot(project)
  const written: string[] = []
  try {
    const names = await readdir(folder)
    let number = nextNumber(names)
    const saved: (SavedReference & { readonly local: boolean })[] = []
    for (const prepared of images) {
      signal.throwIfAborted()
      const { image } = prepared
      const described = {
        image: image.image,
        page: image.page,
        title: image.title,
        ...image.video === undefined ? {} : { video: image.video },
        format: image.format, width: image.width, height: image.height, frames: image.frames, delays: image.delays,
      }
      const earlier = await savedEarlier(folder, names, prepared)
      if (earlier !== undefined) {
        const framesName = `${earlier.slice(0, earlier.length - IMAGE_EXTENSIONS[image.format].length)}.frames.png`
        const hasFrames = prepared.frames !== undefined && await stat(join(folder, framesName)).then(file => file.isFile(), () => false)
        saved.push({
          ...described,
          path: join(folder, earlier),
          file: `${relativeFolder}/${earlier}`,
          ...hasFrames ? { framesFile: `${relativeFolder}/${framesName}` } : {},
          savedEarlier: true,
          local: image.local === true,
        })
        continue
      }
      const fallback = image.local === true ? '' : slug(fileStem(image.image), MAX_STEM)
      const stem = slug(image.title, MAX_STEM) || fallback || 'reference'
      const published = await publishNumbered(folder, number, stem, prepared, written)
      number = published.number + 1
      saved.push({
        ...described,
        path: join(folder, published.name),
        file: `${relativeFolder}/${published.name}`,
        ...published.framesName === undefined ? {} : { framesFile: `${relativeFolder}/${published.framesName}` },
        local: image.local === true,
      })
    }
    signal.throwIfAborted()
    const date = now.toISOString().slice(0, 10)
    const lines = saved.filter(entry => entry.savedEarlier !== true).map(entry => sourceLine(entry, date, entry.local)).join('')
    if (lines !== '') await writeSources(folder, subject, lines)
    return saved.map(({ local: _local, ...entry }) => entry)
  } catch (error) {
    await removeWritten(written)
    throw error
  }
}

/**
 * Add lines to a subject folder's `SOURCES.md`, creating it with its heading when it is missing. Saves that run at once
 * keep every line: a new file appears with its heading and lines together, and the other saves append after them.
 * @param folder - the subject folder.
 * @param subject - what the references are for, for a new file's heading.
 * @param lines - the lines, each ending in a line break.
 */
async function writeSources(folder: string, subject: string, lines: string): Promise<void> {
  const path = join(folder, 'SOURCES.md')
  if (await createSources(folder, path, `${sourcesHeader(subject)}${lines}`)) return
  const existing = await readFile(path, 'utf8')
  await appendFile(path, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${lines}`)
}

/**
 * Create `SOURCES.md` with its first content unless it exists. The file appears whole, as a hard link to a written
 * temporary file, so a save that finds it appends after the content; on a file system without hard links it is created
 * in append mode, which puts this content after any lines another save appended first instead of over them.
 * @param folder - the subject folder, for the temporary file.
 * @param path - the file.
 * @param content - the heading and the first lines.
 * @returns false when the file exists already.
 */
async function createSources(folder: string, path: string, content: string): Promise<boolean> {
  const temporary = join(folder, `.${randomUUID()}.part`)
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await link(temporary, path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? ''
    if (code === 'EEXIST') return false
    if (!NO_HARD_LINKS.has(code)) throw error
  } finally {
    await rm(temporary, { force: true })
  }
  try {
    await writeFile(path, content, { flag: 'ax' })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}
