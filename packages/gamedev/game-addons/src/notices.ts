/**
 * The project's `THIRD_PARTY_NOTICES.md`: one marked section per installed Godot add-on with its name, version,
 * license, copyright line, source, and license text, which a game that ships the add-on must carry. The installer
 * writes and removes only its own marked sections; text outside them is the developer's.
 * @module @deepseek-ai/dsh-game-addons/src/notices
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
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

function withoutSection(text: string, id: string): string {
  const from = text.indexOf(begin(id))
  if (from < 0) return text
  const to = text.indexOf(end(id), from)
  if (to < 0) return text
  const before = text.slice(0, from).replace(/\n+$/u, '\n')
  const after = text.slice(to + end(id).length).replace(/^\n+/u, '')
  return after === '' ? before : `${before}\n${after}`
}

async function readNotices(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Add or replace one add-on's section.
 * @param projectDir - absolute project folder.
 * @param section - the section from {@link noticeSection}.
 * @param id - the add-on id the section is marked with.
 */
export async function writeNotice(projectDir: string, section: string, id: string): Promise<void> {
  const path = join(projectDir, NOTICES_FILE)
  const current = await readNotices(path) ?? HEADER
  const rest = withoutSection(current, id).replace(/\n*$/u, '\n')
  await writeFileAtomic(path, `${rest}\n${section}\n`, { mode: 0o644 })
}

/**
 * Remove one add-on's section, and the file when only the generated header is left.
 * @param projectDir - absolute project folder.
 * @param id - the add-on id.
 * @returns whether a section was removed.
 */
export async function removeNotice(projectDir: string, id: string): Promise<boolean> {
  const path = join(projectDir, NOTICES_FILE)
  const current = await readNotices(path)
  if (current === undefined || !current.includes(begin(id))) return false
  const rest = withoutSection(current, id).replace(/\n*$/u, '\n')
  if (rest === HEADER) await rm(path, { force: true })
  else await writeFileAtomic(path, rest, { mode: 0o644 })
  return true
}
