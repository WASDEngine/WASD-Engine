/**
 * The system tools of the game library: unpacking a downloaded build with the system's own ZIP tool (`ditto` on macOS,
 * which keeps an application bundle's modes and signature, and the `tar` that Windows 10 and later ship), and starting
 * a game as a process of its own that outlives the app and runs with the user's own environment and permissions rather
 * than the app's.
 *
 * On macOS a game starts through LaunchServices, as Finder starts an application: `open -n -a <bundle>`, with the
 * game's `WASD_*` entries as `--env`, except its player token, which a file that only the user can read holds instead,
 * `WASD_PLAY_TOKEN_FILE`, because another account's program can read `open`'s command line; the WASD Multiplayer add-on
 * deletes the file once it read it, and the library deletes it after {@link PLAY_TOKEN_FILE_MS} when no game did.
 * The game is then a process of launchd and its own responsible process, so macOS
 * asks the player about the game's own access to the microphone, the camera, and the Desktop, Documents, and Downloads
 * folders instead of letting it use what the player allowed WASD Engine. `open` hands the application it opens its own
 * environment, so it runs with an empty one: the game gets the user session's environment from launchd plus its
 * `WASD_*` entries, and none of the variables WASD Engine read from the login shell, such as API keys. On Windows a
 * game starts detached from the app's process, with the entries Windows programs need ({@link WINDOWS_ENVIRONMENT})
 * plus its `WASD_*` entries.
 * @module @deepseek-ai/dsh-wasd-plugins/src/library-process
 */
import { execFile, spawn, type ExecFileOptions } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GameCommand } from './library.ts'

/** How long the file that hands a macOS game its player token stays when the game never reads it, in milliseconds. */
export const PLAY_TOKEN_FILE_MS = 5 * 60_000

/** Most bytes of a system tool's error output a failure message keeps. */
const MAX_ERROR_OUTPUT = 2000

/** The macOS program that opens applications through LaunchServices. */
const OPEN = '/usr/bin/open'

/** Name of an environment entry that a game gets from the library. */
const GAME_ENTRY = /^WASD_[A-Z0-9_]+$/u

/**
 * Names of the environment entries a Windows game keeps from the app's, compared without case as Windows compares
 * them: where Windows, the user's folders, and the installed programs are, how to find and run programs, and what the
 * computer and the user are called. No other entry of the app's environment reaches a game.
 */
export const WINDOWS_ENVIRONMENT: readonly RegExp[] = [
  /^SystemRoot$/iu, /^SystemDrive$/iu, /^windir$/iu, /^TEMP$/iu, /^TMP$/iu, /^USERPROFILE$/iu, /^HOMEDRIVE$/iu,
  /^HOMEPATH$/iu, /^APPDATA$/iu, /^LOCALAPPDATA$/iu, /^ProgramData$/iu, /^ProgramFiles.*$/iu, /^ProgramW6432$/iu,
  /^CommonProgramFiles.*$/iu, /^CommonProgramW6432$/iu, /^PATH$/iu, /^PATHEXT$/iu, /^ComSpec$/iu,
  /^NUMBER_OF_PROCESSORS$/iu, /^PROCESSOR_.*$/iu, /^OS$/iu, /^USERNAME$/iu, /^USERDOMAIN$/iu, /^COMPUTERNAME$/iu,
  /^PUBLIC$/iu, /^ALLUSERSPROFILE$/iu,
]

/**
 * The ZIP tool of a system.
 * @param system - this computer's system, as `process.platform` names it.
 * @param environment - the process environment, for Windows' system folder.
 * @returns the program and the arguments before the archive and the folder, or undefined without a tool.
 */
export function unpackCommand(
  system: NodeJS.Platform, environment: NodeJS.ProcessEnv,
): ((archive: string, folder: string) => readonly [string, readonly string[]]) | undefined {
  if (system === 'darwin') return (archive, folder) => ['/usr/bin/ditto', ['-x', '-k', archive, folder]]
  if (system === 'win32') {
    // The full path keeps another `tar` on PATH from running in its place.
    const tar = join(environment.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    return (archive, folder) => [tar, ['-x', '-f', archive, '-C', folder]]
  }
  return undefined
}

/**
 * Unpack a ZIP file into an empty folder with the system's ZIP tool.
 * @param system - this computer's system.
 * @returns the unpacking function of the library's dependencies.
 */
export function systemUnpack(system: NodeJS.Platform): (archive: string, folder: string, signal: AbortSignal) => Promise<void> {
  const command = unpackCommand(system, process.env)
  return async (archive, folder, signal) => {
    if (command === undefined) throw new Error('this system has no ZIP tool the library uses')
    const [program, args] = command(archive, folder)
    await runToEnd(program, args, { signal, windowsHide: true })
  }
}

/**
 * Run a program to its end.
 * @param program - the program.
 * @param args - its arguments.
 * @param options - how it runs.
 * @throws {Error} when it fails, with the end of what it wrote to standard error, else with why it failed.
 */
function runToEnd(program: string, args: readonly string[], options: ExecFileOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(program, [...args], { ...options, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const output = String(stderr).trim().slice(-MAX_ERROR_OUTPUT)
      reject(new Error(output === '' ? error.message : output))
    })
  })
}

/** A game's own environment entries; each must be named `WASD_*`. */
function gameEntries(command: GameCommand): (readonly [string, string])[] {
  const entries = Object.entries(command.env)
  const other = entries.find(([name]) => !GAME_ENTRY.test(name))
  if (other !== undefined) throw new TypeError(`a game gets only WASD_* environment entries, not ${other[0]}`)
  return entries
}

/**
 * The `open` command that starts a macOS game through LaunchServices: a new instance of its bundle, with its `WASD_*`
 * entries.
 * @param command - the game; its `program` is the `.app` bundle.
 * @returns the program and its arguments.
 */
export function macosOpen(command: GameCommand): readonly [string, readonly string[]] {
  return [OPEN, ['-n', '-a', command.program, ...gameEntries(command).flatMap(([name, value]) => ['--env', `${name}=${value}`])]]
}

/**
 * The environment of a Windows game: the entries of the app's environment that {@link WINDOWS_ENVIRONMENT} names, plus
 * the game's own `WASD_*` entries.
 * @param environment - the app's environment.
 * @param command - the game.
 * @returns the game's environment.
 */
export function windowsEnvironment(environment: NodeJS.ProcessEnv, command: GameCommand): Record<string, string> {
  const kept = Object.entries(environment).filter((entry): entry is [string, string] =>
    entry[1] !== undefined && WINDOWS_ENVIRONMENT.some(name => name.test(entry[0])))
  return Object.fromEntries([...kept, ...gameEntries(command)])
}

/**
 * Start a game as a process of its own that outlives the app, as the module describes: through LaunchServices on
 * macOS, detached with a Windows game's environment on Windows.
 * @param command - what starts the game, its folder, and its `WASD_*` environment entries.
 * @returns once the game started: once `open` reported the launch on macOS, once the process spawned on Windows.
 */
export function startDetached(command: GameCommand): Promise<void> {
  return command.platform === 'macos' ? openApplication(command) : spawnDetached(command)
}

/** Start a macOS game with `open`, which reports a bundle it cannot open on its error output. */
async function openApplication(command: GameCommand): Promise<void> {
  const token = command.env.WASD_PLAY_TOKEN
  if (token === undefined) {
    await openWith(command)
    return
  }
  const folder = await mkdtemp(join(tmpdir(), 'wasd-play-'))
  const file = join(folder, 'token')
  try {
    await writeFile(file, token, { mode: 0o600, flag: 'wx' })
    const { WASD_PLAY_TOKEN: _onFile, ...env } = command.env
    await openWith({ ...command, env: { ...env, WASD_PLAY_TOKEN_FILE: file } })
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    throw error
  }
  setTimeout(() => { void rm(folder, { recursive: true, force: true }) }, PLAY_TOKEN_FILE_MS).unref()
}

/** Run `open` for a macOS game whose entries the caller chose. */
async function openWith(command: GameCommand): Promise<void> {
  const [program, args] = macosOpen(command)
  // `open` hands the game its own environment, so it gets none, and the game gets the user session's from launchd.
  await runToEnd(program, args, { cwd: command.cwd, env: {} })
}

/** Start a Windows game detached from the app's process, without standard streams. */
function spawnDetached(command: GameCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.program, [], { cwd: command.cwd, env: windowsEnvironment(process.env, command), detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
