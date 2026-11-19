/**
 * Installations and removals that fail after they moved files, that fail or stop before they move any, or that a Stop
 * interrupts: each one leaves the project as it was, or names what it could not put back.
 */
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { BACKUPS_DIR, GameAddonManager } from '../src/manager.ts'
import { NOTICES_FILE } from '../src/notices.ts'
import { GameAddonRecordError, readRecord } from '../src/record.ts'
import { fakeDownloads, PROJECT_GODOT, scratch, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

const flags = vi.hoisted(() => ({
  /** Renames that fail, as Windows fails one whose files another program holds. */
  failRename: undefined as ((from: string, to: string) => string | undefined) | undefined,
  /** Called before each file read. */
  beforeRead: undefined as ((path: string) => void) | undefined,
  /** Called before each file write. */
  beforeWrite: undefined as ((path: string) => void) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      const code = flags.failRename?.(from, to)
      if (code !== undefined) throw Object.assign(new Error(`${code}: operation failed, rename '${from}' -> '${to}'`), { code })
      await actual.rename(from, to)
    },
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const [path] = args
      if (typeof path === 'string') flags.beforeRead?.(path)
      return await actual.readFile(...args)
    }) as typeof actual.readFile,
    writeFile: (async (...args: Parameters<typeof actual.writeFile>) => {
      const [path] = args
      if (typeof path === 'string') flags.beforeWrite?.(path)
      await actual.writeFile(...args)
    }) as typeof actual.writeFile,
  }
})

let dir: Scratch | undefined

afterEach(async () => {
  flags.failRename = undefined
  flags.beforeRead = undefined
  flags.beforeWrite = undefined
  await dir?.cleanup()
  dir = undefined
})

const signal = new AbortController().signal

/** Whether a rename replaces the project's record. */
function writesRecord(to: string): boolean {
  return to.endsWith(`${sep}.wasdengine${sep}addons.json`)
}

async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(root.length + 1)).sort()
}

/**
 * @param beforeDownload - runs as each archive starts to download.
 */
async function setup(beforeDownload?: () => Promise<void>): Promise<{ readonly manager: GameAddonManager; readonly project: string }> {
  dir = await scratch('rollback')
  const served = fakeDownloads()
  const manager = new GameAddonManager({
    catalog: await loadCatalog(await writeCatalog(dir.root)),
    downloads: {
      cacheDir: join(dir.root, 'archives'),
      fetch: async (url, fetchSignal) => {
        await beforeDownload?.()
        return await served.fetch(url, fetchSignal)
      },
    },
    blenderStore: join(dir.root, 'store'),
    assetsDir: join(dir.root, 'assets'),
    importProject: () => Promise.resolve({ issues: [] }),
    now: () => new Date('2026-11-11T12:00:00Z'),
    changed: () => {},
    allowed: () => true,
  })
  return { manager, project: await writeProject(join(dir.root, 'game')) }
}

/** A copy of the camera add-on changed by hand, which an installation with replace takes out. */
async function handCopy(project: string): Promise<void> {
  await mkdir(join(project, 'addons', 'test_camera'), { recursive: true })
  await writeFile(join(project, 'addons', 'test_camera', 'mine.gd'), 'extends Node\n')
}

describe('GameAddonManager.install after the files moved', () => {
  it('undoes an installation whose record cannot be written, putting the replaced folder back', async () => {
    const { manager, project } = await setup()
    await handCopy(project)
    flags.failRename = (_from, to) => writesRecord(to) ? 'EIO' : undefined
    const failure = manager.install(project, 'test-camera', { replace: true }, signal)
    await expect(failure).rejects.toThrow(/^EIO: operation failed/u)
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['mine.gd'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
    await expect(lstat(join(project, NOTICES_FILE))).rejects.toThrow(/ENOENT/u)
    expect(await readRecord(project)).toEqual([])
    // No staging, trash, or backup folder is left.
    expect(await readdir(join(project, '.wasdengine'))).toEqual([])
  })

  it('puts project.godot and the notices back, and names where the replaced folder stays when it cannot move back', async () => {
    const { manager, project } = await setup()
    await handCopy(project)
    flags.failRename = (from, to) => writesRecord(to) ? 'EIO' : from.includes(`${sep}.wasdengine${sep}trash${sep}`) ? 'EPERM' : undefined
    const failure = await manager.install(project, 'test-camera', { replace: true }, signal).then(() => undefined, (error: unknown) => error as Error)
    expect(failure?.message).toMatch(/^EIO: operation failed/u)
    expect(failure?.message).toMatch(/ The installation could not be undone completely: the addons\/test_camera folder it replaced is in /u)
    expect(failure?.message).toMatch(/ is in \.wasdengine\/trash\/[0-9a-f-]{36} \(EPERM: /u)
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
    await expect(lstat(join(project, NOTICES_FILE))).rejects.toThrow(/ENOENT/u)
    expect(await readRecord(project)).toEqual([])
    // The new add-on left addons/, and the hand-made copy waits in the trash that the message names.
    expect(await readdir(join(project, 'addons'))).toEqual([])
    const [trash] = await readdir(join(project, '.wasdengine', 'trash'))
    expect(await tree(join(project, '.wasdengine', 'trash', trash!))).toEqual(['mine.gd'])
  })
})

describe('GameAddonManager.install before the files move', () => {
  it('leaves the project as it was when a Stop comes while another change holds the record\'s lock', async () => {
    const { manager, project } = await setup()
    await handCopy(project)
    // Another change, in this process or another, holds the lock while this installation downloads.
    await mkdir(join(project, '.wasdengine'))
    await writeFile(join(project, '.wasdengine', 'addons.json.lock'), `${process.ppid}\n`)
    const stop = new AbortController()
    flags.beforeWrite = (path) => { if (path.endsWith(`${sep}addons.json.lock`)) stop.abort() }
    await expect(manager.install(project, 'test-camera', { replace: true }, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['mine.gd'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
    await expect(lstat(join(project, NOTICES_FILE))).rejects.toThrow(/ENOENT/u)
    // Only the other change's lock is left; no staging or trash folder is.
    expect(await readdir(join(project, '.wasdengine'))).toEqual(['addons.json.lock'])
  })

  it('leaves the project as it was when its record turns invalid while the archive downloads', async () => {
    const state: { project?: string } = {}
    const { manager, project } = await setup(async () => {
      // Someone else writes a record that this format cannot read.
      await writeFile(join(state.project!, '.wasdengine', 'addons.json'), '{"format": 1, "addons": [{"id": "x"}]}\n')
    })
    state.project = project
    await handCopy(project)
    await mkdir(join(project, '.wasdengine'))
    await expect(manager.install(project, 'test-camera', { replace: true }, signal)).rejects.toThrow(GameAddonRecordError)
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['mine.gd'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(PROJECT_GODOT)
    expect(await readdir(join(project, '.wasdengine'))).toEqual(['addons.json'])
  })
})

describe('GameAddonManager.remove', () => {
  it('leaves the add-on in place when a Stop comes during the scan for files that use it', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-camera', {}, signal)
    await writeFile(join(project, 'player.gd'), 'func _ready():\n\tTestCameraManager.follow(self)\n')
    await mkdir(join(project, 'scenes'))
    await writeFile(join(project, 'scenes', 'level.tscn'), '[gd_scene format=3]\n')
    const godot = await readFile(join(project, 'project.godot'), 'utf8')
    const notices = await readFile(join(project, NOTICES_FILE), 'utf8')
    const stop = new AbortController()
    flags.beforeRead = (path) => { if (path.endsWith(`${sep}player.gd`)) stop.abort() }
    await expect(manager.remove(project, 'test-camera', stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['LICENSE', 'manager.gd', 'nodes/rig.gd', 'plugin.cfg', 'plugin.gd'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(godot)
    expect(await readFile(join(project, NOTICES_FILE), 'utf8')).toBe(notices)
    expect((await readRecord(project)).map(addon => addon.id)).toEqual(['test-camera'])
    await expect(lstat(join(project, BACKUPS_DIR))).rejects.toThrow(/ENOENT/u)
  })

  it('undoes a removal whose record cannot be written, moving the folder back from its backup', async () => {
    const { manager, project } = await setup()
    await manager.install(project, 'test-camera', {}, signal)
    const godot = await readFile(join(project, 'project.godot'), 'utf8')
    const notices = await readFile(join(project, NOTICES_FILE), 'utf8')
    flags.failRename = (_from, to) => writesRecord(to) ? 'EIO' : undefined
    await expect(manager.remove(project, 'test-camera', signal)).rejects.toThrow(/^EIO: operation failed/u)
    expect(await tree(join(project, 'addons', 'test_camera'))).toEqual(['LICENSE', 'manager.gd', 'nodes/rig.gd', 'plugin.cfg', 'plugin.gd'])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(godot)
    expect(await readFile(join(project, NOTICES_FILE), 'utf8')).toBe(notices)
    expect((await readRecord(project)).map(addon => addon.id)).toEqual(['test-camera'])
    // The backup folder it made is gone again; the .gitignore of the backups stays.
    expect(await readdir(join(project, BACKUPS_DIR))).toEqual(['.gitignore'])
  })
})
