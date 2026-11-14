/**
 * Saving references into a game project: each image goes into `references/<subject>/` under the project's folder,
 * numbered after the files already there, with a sheet of an animated image's frames beside it, and its source in the
 * folder's `SOURCES.md`. An empty `references/.gdignore` keeps Godot from importing the folder, so references never
 * become part of the game or its exports.
 * @module @deepseek-ai/dsh-art-references/src/save
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileStem, HASH_NAME, IMAGE_EXTENSIONS, writeAtomically, type CachedImage } from './finder.ts'
import { drawFramesSheet, type FramesLayout } from './images.ts'
import type { SavedReference } from './types.ts'

/** The project folder that holds every subject's references. */
export const REFERENCES_FOLDER = 'references'

/** Longest subject folder name. */
const MAX_SUBJECT = 48

/** Longest file name stem after the number. */
const MAX_STEM = 40

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
 * The next free file number in a subject folder.
 * @param folder - the folder.
 * @returns one more than the highest `NN-` prefix of its files, or 1.
 */
async function nextNumber(folder: string): Promise<number> {
  const names = await readdir(folder)
  return 1 + names.reduce((highest, name) => Math.max(highest, Number(/^(\d+)-/u.exec(name)?.[1] ?? 0)), 0)
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

/**
 * Save downloaded images as references of one subject in a game project.
 * @param project - absolute path of the game project's folder.
 * @param subject - what the references are for.
 * @param images - the downloaded images, in the order to number them.
 * @param frames - the limits of an animated image's frames sheet.
 * @param now - the time of saving, for `SOURCES.md`.
 * @returns the saved files.
 * @throws Error when the subject holds no letter or digit, or a file cannot be written.
 */
export async function saveReferences(
  project: string,
  subject: string,
  images: readonly CachedImage[],
  frames: FramesLayout,
  now: Date,
): Promise<SavedReference[]> {
  const folderName = subjectFolder(subject)
  const relativeFolder = `${REFERENCES_FOLDER}/${folderName}`
  const folder = join(project, REFERENCES_FOLDER, folderName)
  await mkdir(folder, { recursive: true })
  await ignoreInGodot(project)
  let number = await nextNumber(folder)
  const saved: SavedReference[] = []
  for (const image of images) {
    const fallback = image.local === true ? '' : slug(fileStem(image.image), MAX_STEM)
    const stem = `${String(number).padStart(2, '0')}-${slug(image.title, MAX_STEM) || fallback || 'reference'}`
    const name = `${stem}${IMAGE_EXTENSIONS[image.format]}`
    const data = await readFile(image.path)
    await writeAtomically(join(folder, name), data)
    let framesFile: string | undefined
    if (image.frames > 1) {
      const sheet = await drawFramesSheet(data, image, frames)
      await writeAtomically(join(folder, `${stem}.frames.png`), sheet.data)
      framesFile = `${relativeFolder}/${stem}.frames.png`
    }
    saved.push({
      path: join(folder, name),
      file: `${relativeFolder}/${name}`,
      image: image.image,
      page: image.page,
      title: image.title,
      ...image.video === undefined ? {} : { video: image.video },
      format: image.format, width: image.width, height: image.height, frames: image.frames, delays: image.delays,
      ...framesFile === undefined ? {} : { framesFile },
    })
    number++
  }
  const sources = join(folder, 'SOURCES.md')
  const date = now.toISOString().slice(0, 10)
  const lines = saved.map((entry, index) => sourceLine(entry, date, images[index]?.local === true)).join('')
  try {
    await writeFile(sources, `${sourcesHeader(subject)}${lines}`, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const existing = await readFile(sources, 'utf8')
    await appendFile(sources, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}${lines}`)
  }
  return saved
}
