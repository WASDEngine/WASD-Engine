/**
 * The system tools of the game library: unpacking a downloaded build with the system's own ZIP tool (`ditto` on macOS,
 * which keeps an application bundle's modes and signature, and the `tar` that Windows 10 and later ship), and starting
 * a game as a process of its own, detached from the app's, so it keeps running after the app quits.
 * @module @deepseek-ai/dsh-wasd-plugins/src/library-process
 */
import { execFile, spawn } from 'node:child_process'
import { join } from 'node:path'
import type { GameCommand } from './library.ts'

/** Most bytes of a ZIP tool's error output a failure message keeps. */
const MAX_ERROR_OUTPUT = 2000

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
  return (archive, folder, signal) => new Promise((resolve, reject) => {
    if (command === undefined) {
      reject(new Error('this system has no ZIP tool the library uses'))
      return
    }
    const [program, args] = command(archive, folder)
    execFile(program, [...args], { signal, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const output = stderr.trim().slice(-MAX_ERROR_OUTPUT)
      reject(new Error(output === '' ? error.message : output))
    })
  })
}

/**
 * Start a game as a process of its own: detached, with no standard streams, and with the app's environment except
 * `ELECTRON_RUN_AS_NODE`, which the Desktop app's Host runs with.
 * @param command - the executable, its folder, and its environment entries.
 * @returns once the process started.
 */
export function startDetached(command: GameCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...command.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(command.program, [], { cwd: command.cwd, env, detached: true, stdio: 'ignore' })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
