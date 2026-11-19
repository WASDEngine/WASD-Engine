/**
 * A game's app identifiers: its Android package name and its iOS and macOS bundle identifiers. An export uses the one
 * that the project keeps for the platform in `project.godot` ({@link APP_IDENTIFIER_SETTINGS}); the first export for a
 * platform chooses it, from the game's name ({@link gameIdentifierPart}) and six random letters, so that games with
 * similar names stay apart on one device, and keeps it there, so that later builds update the installed app.
 * @module @deepseek-ai/dsh-godot/src/identifiers
 */
import { createHash, randomInt } from 'node:crypto'

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

/** The platforms whose builds carry an app identifier, which a project keeps for each one apart. */
export type AppIdentifierPlatform = 'android' | 'ios' | 'macos'

/** The `project.godot` section that holds WASD Engine's own settings. */
export const WASD_SETTINGS_SECTION = 'wasd_engine'

/** The settings, in {@link WASD_SETTINGS_SECTION}, that keep each platform's app identifier once an export chose it. */
export const APP_IDENTIFIER_SETTINGS: Readonly<Record<AppIdentifierPlatform, string>> = {
  android: 'export/android_package_name',
  ios: 'export/ios_bundle_identifier',
  macos: 'export/macos_bundle_identifier',
}

/** An Android package name: segments that start with a letter, then letters, digits, or `_`. */
const ANDROID_IDENTIFIER = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/u
/** An Apple bundle identifier: segments of letters, digits, or `-`. */
const APPLE_IDENTIFIER = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/u

/** Letters of the random segment of a new identifier, which every platform accepts, also as a segment's first. */
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'

/**
 * The identifier that a game's name gives a platform: `com.wasdengine.game.` and {@link gameIdentifierPart}.
 * @param platform - the platform.
 * @param name - the game's name.
 * @returns the identifier.
 */
export function nameIdentifier(platform: AppIdentifierPlatform, name: string): string {
  return `com.wasdengine.game.${gameIdentifierPart(name, platform === 'android' ? '_' : '-')}`
}

/**
 * A new identifier for a game: the one its name gives, then a segment of six random lowercase letters, so that games
 * whose names give the same identifier stay apart on one device.
 * @param platform - the platform.
 * @param name - the game's name.
 * @returns the identifier.
 */
export function newAppIdentifier(platform: AppIdentifierPlatform, name: string): string {
  const letters = Array.from({ length: 6 }, () => LETTERS[randomInt(LETTERS.length)]).join('')
  return `${nameIdentifier(platform, name)}.${letters}`
}

/**
 * Whether a platform accepts a value as an app identifier.
 * @param platform - the platform.
 * @param value - the value.
 * @returns true for a package name on Android and a bundle identifier on iOS and macOS, at most 155 characters.
 */
export function validAppIdentifier(platform: AppIdentifierPlatform, value: string): boolean {
  return value.length <= 155 && (platform === 'android' ? ANDROID_IDENTIFIER : APPLE_IDENTIFIER).test(value)
}

/**
 * The identifier that a project keeps for a platform, from its {@link APP_IDENTIFIER_SETTINGS} setting.
 * @param projectText - `project.godot` text.
 * @param platform - the platform.
 * @returns the identifier, or undefined when the project keeps none.
 * @throws {Error} when the setting holds a value that the platform does not accept as an identifier.
 */
export function storedAppIdentifier(projectText: string, platform: AppIdentifierPlatform): string | undefined {
  const key = APP_IDENTIFIER_SETTINGS[platform]
  let section = ''
  let stored: string | undefined
  for (const line of projectText.split(/\r?\n/u)) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(line)
    if (header !== null) {
      section = header[1] as string
      continue
    }
    if (section !== WASD_SETTINGS_SECTION) continue
    const setting = /^([^\s=]+)=(.*)$/u.exec(line)
    if (setting?.[1] === key) stored = (setting[2] as string).trim()
  }
  if (stored === undefined) return undefined
  const value = /^"([^"\\]*)"$/u.exec(stored)?.[1]
  if (value === undefined || !validAppIdentifier(platform, value)) {
    throw new Error(`project.godot sets ${WASD_SETTINGS_SECTION}/${key} to ${stored}, which is not ${platform === 'android' ? 'an Android package name' : 'an Apple bundle identifier'}`)
  }
  return value
}

/**
 * Keep an app identifier for a platform in `project.godot`: its {@link APP_IDENTIFIER_SETTINGS} setting takes the
 * value, in place of an earlier one, in the {@link WASD_SETTINGS_SECTION} section, which is added at the end when the
 * project has none; no other line changes.
 * @param projectText - `project.godot` text.
 * @param platform - the platform.
 * @param identifier - the identifier, one {@link validAppIdentifier} accepts.
 * @returns the new text.
 */
export function withAppIdentifier(projectText: string, platform: AppIdentifierPlatform, identifier: string): string {
  const newline = projectText.includes('\r\n') ? '\r\n' : '\n'
  const line = `${APP_IDENTIFIER_SETTINGS[platform]}="${identifier}"`
  const lines = projectText.split(/\r?\n/u)
  let section = ''
  let sectionEnd = -1
  const kept: string[] = []
  for (const current of lines) {
    const header = /^\[([^\]]+)\]\s*$/u.exec(current)
    if (header !== null) section = header[1] as string
    if (section === WASD_SETTINGS_SECTION && current.startsWith(`${APP_IDENTIFIER_SETTINGS[platform]}=`)) continue
    kept.push(current)
    if (section === WASD_SETTINGS_SECTION && current.trim() !== '') sectionEnd = kept.length
  }
  if (sectionEnd >= 0) {
    kept.splice(sectionEnd, 0, line)
    return kept.join(newline)
  }
  while (kept.length > 0 && kept[kept.length - 1] === '') kept.pop()
  return [...kept, '', `[${WASD_SETTINGS_SECTION}]`, '', line, ''].join(newline)
}
