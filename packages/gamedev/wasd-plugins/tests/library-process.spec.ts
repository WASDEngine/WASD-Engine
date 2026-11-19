/**
 * The library starts a game as a process of its own with the user's environment and permissions rather than the
 * app's: through LaunchServices with an empty environment on macOS, and detached with only the entries Windows programs
 * need on Windows, plus the game's own `WASD_*` entries.
 */
import { EventEmitter } from 'node:events'
import { readFile, rm, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GameCommand } from '../src/library.ts'

interface Options { readonly env?: NodeJS.ProcessEnv; readonly cwd?: string; readonly detached?: boolean; readonly stdio?: string }
type Done = (error: Error | null, stdout: string, stderr: string) => void

const processes = vi.hoisted(() => ({
  execFile: vi.fn<(program: string, args: string[], options: Options, done: Done) => void>(),
  spawn: vi.fn<(program: string, args: string[], options: Options) => EventEmitter & { unref(): void }>(),
}))
vi.mock('node:child_process', () => ({ execFile: processes.execFile, spawn: processes.spawn }))

const { macosOpen, startDetached, windowsEnvironment } = await import('../src/library-process.ts')

afterEach(() => {
  vi.unstubAllEnvs()
  processes.execFile.mockReset()
  processes.spawn.mockReset()
})

const ONLINE = { WASD_PLAY_TOKEN: 'wpt1.token', WASD_API_ORIGIN: 'https://site.test', WASD_GAME_ID: 'game', WASD_GAME_VERSION: '2' }

const MAC: GameCommand = { platform: 'macos', program: '/library/game/2/Sky Keep.app', cwd: '/library/game/2', env: ONLINE }
const WINDOWS: GameCommand = { platform: 'windows', program: 'C:\\library\\game\\2\\Sky Keep.exe', cwd: 'C:\\library\\game\\2', env: ONLINE }

describe('starting a game', () => {
  it('opens a macOS game\'s bundle through LaunchServices as a new instance, with its own entries only', async () => {
    expect(macosOpen(MAC)).toEqual(['/usr/bin/open', [
      '-n', '-a', '/library/game/2/Sky Keep.app',
      '--env', 'WASD_PLAY_TOKEN=wpt1.token', '--env', 'WASD_API_ORIGIN=https://site.test', '--env', 'WASD_GAME_ID=game', '--env', 'WASD_GAME_VERSION=2',
    ]])
    vi.stubEnv('OPENAI_API_KEY', 'secret')
    processes.execFile.mockImplementation((_program, _args, _options, done) => { done(null, '', '') })
    await startDetached(MAC)
    // `open` hands the game its own environment, so it runs with none: nothing of the app's reaches the game.
    expect(processes.execFile).toHaveBeenCalledOnce()
    const [program, args, options] = processes.execFile.mock.calls[0] as Parameters<typeof processes.execFile>
    expect(program).toBe('/usr/bin/open')
    expect(options.env).toEqual({})
    expect(processes.spawn).not.toHaveBeenCalled()
    // The player token reaches the game in a file only this user reads, never on `open`'s command line.
    expect(args.join(' ')).not.toContain('wpt1.token')
    const file = args.find(arg => arg.startsWith('WASD_PLAY_TOKEN_FILE='))?.slice('WASD_PLAY_TOKEN_FILE='.length) ?? ''
    expect(await readFile(file, 'utf8')).toBe('wpt1.token')
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(args).toEqual(expect.arrayContaining(['--env', 'WASD_API_ORIGIN=https://site.test', '--env', 'WASD_GAME_ID=game']))
    await rm(dirname(file), { recursive: true, force: true })
  })

  it('reports a bundle LaunchServices cannot open', async () => {
    processes.execFile.mockImplementation((_program, _args, _options, done) => {
      done(new Error('Command failed'), '', 'The application /library/game/2/Sky Keep.app cannot be opened because its executable is missing.\n')
    })
    await expect(startDetached(MAC)).rejects.toThrow('The application /library/game/2/Sky Keep.app cannot be opened because its executable is missing.')
  })

  it('starts a Windows game detached, with the entries Windows programs need and its own', async () => {
    const environment: NodeJS.ProcessEnv = {
      SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', Path: 'C:\\Windows\\system32', PATHEXT: '.COM;.EXE', TEMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\ada', APPDATA: 'C:\\Users\\ada\\AppData\\Roaming', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files', CommonProgramFiles: 'C:\\Program Files\\Common Files', PROCESSOR_ARCHITECTURE: 'AMD64',
      NUMBER_OF_PROCESSORS: '8', ComSpec: 'C:\\Windows\\system32\\cmd.exe', USERNAME: 'ada', COMPUTERNAME: 'DESK',
      // The app's own and the user's secrets stay with the app.
      ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect', ANTHROPIC_API_KEY: 'secret', GITHUB_TOKEN: 'secret', WASD_OTHER: 'not the game\'s',
    }
    expect(windowsEnvironment(environment, WINDOWS)).toEqual({
      SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', Path: 'C:\\Windows\\system32', PATHEXT: '.COM;.EXE', TEMP: 'C:\\Temp',
      USERPROFILE: 'C:\\Users\\ada', APPDATA: 'C:\\Users\\ada\\AppData\\Roaming', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files', CommonProgramFiles: 'C:\\Program Files\\Common Files', PROCESSOR_ARCHITECTURE: 'AMD64',
      NUMBER_OF_PROCESSORS: '8', ComSpec: 'C:\\Windows\\system32\\cmd.exe', USERNAME: 'ada', COMPUTERNAME: 'DESK',
      ...ONLINE,
    })
    vi.stubEnv('ANTHROPIC_API_KEY', 'secret')
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    processes.spawn.mockImplementation(() => {
      queueMicrotask(() => { child.emit('spawn') })
      return child
    })
    await startDetached(WINDOWS)
    const [program, args, options] = processes.spawn.mock.calls[0] as Parameters<typeof processes.spawn>
    expect([program, args, options.cwd, options.detached, options.stdio]).toEqual([WINDOWS.program, [], WINDOWS.cwd, true, 'ignore'])
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(options.env).toMatchObject(ONLINE)
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('hands a game only WASD_* entries', async () => {
    const leaky: GameCommand = { ...MAC, env: { ...ONLINE, DYLD_INSERT_LIBRARIES: '/tmp/x.dylib' } }
    expect(() => macosOpen(leaky)).toThrow('a game gets only WASD_* environment entries, not DYLD_INSERT_LIBRARIES')
    await expect(startDetached(leaky)).rejects.toThrow(TypeError)
    await expect(startDetached({ ...leaky, platform: 'windows' })).rejects.toThrow(TypeError)
    expect(processes.execFile).not.toHaveBeenCalled()
    expect(processes.spawn).not.toHaveBeenCalled()
  })
})
