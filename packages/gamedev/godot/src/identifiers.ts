/**
 * The part of a game's app identifiers that comes from the game's name: the last segment of its Android package name
 * and of its macOS and iOS bundle identifier, which sets the game apart from other games on one device.
 * @module @deepseek-ai/dsh-godot/src/identifiers
 */
import { createHash } from 'node:crypto'

/** Most characters the name's words keep in an identifier. */
const MAX_WORDS = 60

/**
 * The part of a game's identifiers that comes from its name: the name in lowercase ASCII letters and digits, with
 * `separator` between its words, at most 60 characters, preceded by `game` and the separator when it would start with a
 * digit, or `game` for a name without such characters. A name with letters or digits that have no ASCII form, such as
 * Chinese, Japanese, or Cyrillic ones, then gets the separator and the first 8 hex digits of the SHA-256 of the name
 * (NFC, trimmed), so that games whose names differ only in those letters get different identifiers.
 * @param name - the game's name.
 * @param separator - `_` for an Android package segment, `-` for an Apple bundle identifier.
 * @returns the identifier part, at most 74 characters.
 */
export function gameIdentifierPart(name: string, separator: '_' | '-'): string {
  const ascii = name.normalize('NFKD').replace(/[̀-ͯ]/gu, '').toLowerCase()
  const words = ascii.replace(/[^a-z0-9]+/gu, separator).replace(new RegExp(`^${separator}+|${separator}+$`, 'gu'), '')
    .slice(0, MAX_WORDS).replace(new RegExp(`${separator}+$`, 'u'), '')
  const base = words === '' ? 'game' : /^[a-z]/u.test(words) ? words : `game${separator}${words}`
  if (!/[\p{L}\p{N}]/u.test(ascii.replace(/[a-z0-9]/gu, ''))) return base
  const digest = createHash('sha256').update(name.normalize('NFC').trim()).digest('hex').slice(0, 8)
  return `${base}${separator}${digest}`
}
