/**
 * The Apple Developer team of an iOS export's Xcode project. Godot writes the preset's Team ID into the project's
 * signing settings and refuses to export without one. An export takes the Team ID it is given, else the one team of
 * the Mac's Apple Development certificates ({@link detectAppleTeam}); without either, it exports with
 * {@link UNSET_TEAM_ID} and removes that from the project afterwards ({@link removeTeam}), so that Xcode asks for the
 * team when the project is opened.
 * @module @deepseek-ai/dsh-godot/src/ios
 */
import { X509Certificate } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { runGodotCommand } from './command.ts'

/** An Apple Developer Team ID: 10 capital letters and digits. */
export const APPLE_TEAM_ID = /^[A-Z0-9]{10}$/u

/** The Team ID an iOS export without a team gives Godot, and then removes from the Xcode project. */
export const UNSET_TEAM_ID = 'WASDNOTEAM'

/**
 * The warning every iOS export of Godot 4.7.2 prints, because its launch screen reads `application/boot_splash/fullsize`,
 * a project setting Godot 4 no longer has; it says nothing about the project, so results leave it out.
 */
export const IOS_SPLASH_SETTING_WARNING = 'Property not found: application/boot_splash/fullsize'

/** The Common Name prefix of the certificates Xcode creates to sign apps during development. */
const DEVELOPMENT_CERTIFICATE = 'Apple Development'

/** Parameters of {@link detectAppleTeam}. */
export interface AppleTeamOptions {
  /** Host subprocess service, which runs `security`. */
  readonly subprocess: SubprocessRuntime
  /** The Host's operating system; only macOS has the keychain. */
  readonly platform: NodeJS.Platform
  /** Deadline of `security`. */
  readonly timeoutMs: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation. */
  readonly signal: AbortSignal
  /** The current time, which the certificates must be valid at. */
  readonly now: Date
}

/**
 * The Team IDs of PEM certificates that are valid at a time: each certificate's Organizational Unit, as Apple writes
 * the team into the certificates it issues.
 * @param pem - PEM text of any number of certificates.
 * @param now - the time.
 * @returns the distinct Team IDs, sorted.
 */
export function certificateTeams(pem: string, now: Date): string[] {
  const teams = new Set<string>()
  for (const block of pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu) ?? []) {
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(block)
    } catch {
      // A block that does not parse names no team.
      continue
    }
    if (new Date(certificate.validFrom) > now || new Date(certificate.validTo) <= now) continue
    const team = /^OU=(.+)$/mu.exec(certificate.subject)?.[1]
    if (team !== undefined && APPLE_TEAM_ID.test(team)) teams.add(team)
  }
  return [...teams].sort()
}

/**
 * The Team ID of the Mac's valid Apple Development certificates, which `security` lists from the user's keychains.
 * @param options - the subprocess service, the operating system, and the limits of `security`.
 * @returns the Team ID when the certificates name exactly one team; undefined otherwise, outside macOS, and when
 *   `security` fails.
 */
export async function detectAppleTeam(options: AppleTeamOptions): Promise<string | undefined> {
  if (options.platform !== 'darwin') return undefined
  let outcome
  try {
    outcome = await runGodotCommand({
      subprocess: options.subprocess,
      argv: ['/usr/bin/security', 'find-certificate', '-a', '-c', DEVELOPMENT_CERTIFICATE, '-p'],
      cwd: '/',
      timeoutMs: options.timeoutMs,
      graceMs: options.graceMs,
      outputBytes: options.outputBytes,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal.aborted) throw error
    // Without `security`, the export leaves the team for Xcode to ask for.
    return undefined
  }
  options.signal.throwIfAborted()
  if (outcome.exit.exitCode !== 0) return undefined
  const teams = certificateTeams(outcome.stdout, options.now)
  return teams.length === 1 ? teams[0] : undefined
}

/**
 * The name of an iOS build's Xcode project, target, and app binary: the game's name in ASCII letters and digits.
 * @param name - the game's name.
 * @returns the name, at most 64 characters; `Game` for a name without such characters, prefixed with `Game` when it
 *   would start with a digit.
 */
export function iosBinaryName(name: string | undefined): string {
  const ascii = (name ?? '').normalize('NFKD').replace(/[̀-ͯ]/gu, '').replace(/[^A-Za-z0-9]+/gu, '').slice(0, 64)
  return ascii === '' ? 'Game' : /^[0-9]/u.test(ascii) ? `Game${ascii}`.slice(0, 64) : ascii
}

/**
 * Remove a Team ID from an exported Xcode project: the target's development team and signing settings in
 * `<binary>.xcodeproj/project.pbxproj`, and the team of `<binary>/export_options.plist`, which archives exported from the
 * command line use. Xcode then asks for the team.
 * @param outputDir - absolute folder of the exported project.
 * @param binary - the project's name, {@link iosBinaryName}.
 * @param team - the Team ID to remove.
 */
export async function removeTeam(outputDir: string, binary: string, team: string): Promise<void> {
  const projectFile = join(outputDir, `${binary}.xcodeproj`, 'project.pbxproj')
  const project = await readFile(projectFile, 'utf8')
  const setting = new RegExp(`^\\s*(?:DevelopmentTeam|DEVELOPMENT_TEAM) = "?${team}"?;\\s*$`, 'u')
  const kept = project.split('\n').filter(line => !setting.test(line)).join('\n')
  if (kept !== project) await writeFile(projectFile, kept)
  const optionsFile = join(outputDir, binary, 'export_options.plist')
  let options: string
  try {
    options = await readFile(optionsFile, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const without = options.replace(new RegExp(`\\s*<key>teamID</key>\\s*<string>${team}</string>`, 'u'), '')
  if (without !== options) await writeFile(optionsFile, without)
}
