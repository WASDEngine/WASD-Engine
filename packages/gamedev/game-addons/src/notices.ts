/**
 * The project's `THIRD_PARTY_NOTICES.md`: one marked section per installed Godot add-on with its name, version,
 * license, copyright line, source, and license text, which a game that ships the add-on must carry. The installer
 * writes and removes only its own marked sections; text outside them is the developer's.
 * @module @deepseek-ai/dsh-game-addons/src/notices
 */
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readProjectText } from './paths.ts'
import type { GameAddon } from './types.ts'

/** File name of the notices in the project folder. */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.md'

const HEADER = '# Third-party notices\n\nThis game includes the third-party software below. WASD Engine keeps the marked sections up to date when it installs or removes an add-on; text outside them is yours to edit.\n'

function begin(id: string): string {
  return `<!-- wasd-addon:${id} -->`
}

function end(id: string): string {
  return `<!-- /wasd-addon:${id} -->`
}

/** A fence longer than any run of backticks in the text, so the license text cannot close it. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/gu)].map(match => match[0].length))
  return '`'.repeat(longest + 1)
}

/**
 * The marked section of one add-on.
 * @param addon - catalog entry.
 * @param licenseText - the license file's text, or undefined when the archive has none.
 * @returns the section, from its begin marker to its end marker.
 */
export function noticeSection(addon: GameAddon, licenseText: string | undefined): string {
  const lines = [
    begin(addon.id),
    `## ${addon.title} ${addon.version}`,
    '',
    `- License: ${addon.license}`,
    `- ${addon.copyright}`,
    `- Source: ${addon.homepage}`,
    ...addon.credit === undefined ? [] : [`- Credit required in the game: ${addon.credit}`],
  ]
  if (licenseText !== undefined) {
    const text = licenseText.replace(/\r\n/gu, '\n').trimEnd()
    const marks = fence(text)
    lines.push('', `${marks}text`, text, marks)
  }
  lines.push(end(addon.id))
  return lines.join('\n')
}

/** Where one add-on's marked section lies in the text, from its begin marker to the end of its end marker. */
function sectionRange(text: string, id: string): { readonly from: number; readonly to: number } | undefined {
  const from = text.indexOf(begin(id))
  if (from < 0) return undefined
  const to = text.indexOf(end(id), from)
  return to < 0 ? undefined : { from, to: to + end(id).length }
}

function withoutSection(text: string, id: string): string {
  const range = sectionRange(text, id)
  if (range === undefined) return text
  const before = text.slice(0, range.from).replace(/\n+$/u, '\n')
  const after = text.slice(range.to).replace(/^\n+/u, '')
  return after === '' ? before : `${before}\n${after}`
}

/** The notices as the file holds them now; a link in its place is refused (`readProjectText`). */
async function readNotices(projectDir: string): Promise<string | undefined> {
  return await readProjectText(projectDir, NOTICES_FILE)
}

/**
 * One add-on's section as the file holds it now.
 * @param projectDir - absolute project folder.
 * @param id - the add-on id.
 * @returns the section from its begin marker to its end marker, or undefined when the file has none.
 */
export async function readNotice(projectDir: string, id: string): Promise<string | undefined> {
  const current = await readNotices(projectDir)
  if (current === undefined) return undefined
  const range = sectionRange(current, id)
  return range === undefined ? undefined : current.slice(range.from, range.to)
}

/**
 * Add or replace one add-on's section.
 * @param projectDir - absolute project folder.
 * @param section - the section from {@link noticeSection} or {@link readNotice}.
 * @param id - the add-on id the section is marked with.
 */
export async function writeNotice(projectDir: string, section: string, id: string): Promise<void> {
  const path = join(projectDir, NOTICES_FILE)
  const current = await readNotices(projectDir) ?? HEADER
  const rest = withoutSection(current, id).replace(/\n*$/u, '\n')
  await writeFileAtomic(path, `${rest}\n${section}\n`, { mode: 0o644 })
}

/**
 * Remove one add-on's section, and the file when only the generated header is left.
 * @param projectDir - absolute project folder.
 * @param id - the add-on id.
 * @returns the section that was removed, or undefined when the file had none.
 */
export async function removeNotice(projectDir: string, id: string): Promise<string | undefined> {
  const path = join(projectDir, NOTICES_FILE)
  const current = await readNotices(projectDir)
  if (current === undefined) return undefined
  const range = sectionRange(current, id)
  if (range === undefined) return undefined
  const rest = withoutSection(current, id).replace(/\n*$/u, '\n')
  if (rest === HEADER) await rm(path, { force: true })
  else await writeFileAtomic(path, rest, { mode: 0o644 })
  return current.slice(range.from, range.to)
}
