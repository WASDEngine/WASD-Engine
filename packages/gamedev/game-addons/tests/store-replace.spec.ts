/** Replacing an add-on in the Blender add-on store when the new version cannot take the old one's place. */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { GameAddonManager, STORE_MARKER } from '../src/manager.ts'
import { fakeDownloads, scratch, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

const flags = vi.hoisted(() => ({ failStagingRename: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    // A staging folder that cannot be renamed into place, as when Windows antivirus holds a file in it.
    rename: async (from: string, to: string): Promise<void> => {
      if (flags.failStagingRename && basename(from).startsWith('.staging-')) {
        throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' -> '${to}'`), { code: 'EPERM' })
      }
      await actual.rename(from, to)
    },
  }
})

let dir: Scratch | undefined

afterEach(async () => {
  flags.failStagingRename = false
  await dir?.cleanup()
  dir = undefined
})

describe('GameAddonManager for Blender', () => {
  it('keeps the version in the store when its replacement cannot take its place', async () => {
    dir = await scratch('store-replace')
    const store = join(dir.root, 'store')
    const manager = new GameAddonManager({
      catalog: await loadCatalog(await writeCatalog(dir.root)),
      downloads: { cacheDir: join(dir.root, 'archives'), fetch: fakeDownloads().fetch },
      blenderStore: store,
      assetsDir: join(dir.root, 'assets'),
      importProject: () => Promise.resolve({ issues: [] }),
      now: () => new Date('2026-11-11T12:00:00Z'),
      changed: () => {},
    })
    const project = await writeProject(join(dir.root, 'game'))
    // An older version of the extension that another project installed.
    const installed = join(store, 'test_trees')
    await mkdir(installed, { recursive: true })
    await writeFile(join(installed, STORE_MARKER), `${JSON.stringify({ id: 'test-trees', version: '1.0.0', sha256: 'older' })}\n`)
    await writeFile(join(installed, '__init__.py'), '# version 1\n')

    flags.failStagingRename = true
    await expect(manager.install(project, 'test-trees', {}, new AbortController().signal)).rejects.toThrow(/EPERM/u)

    expect(await readFile(join(installed, '__init__.py'), 'utf8')).toBe('# version 1\n')
    expect(JSON.parse(await readFile(join(installed, STORE_MARKER), 'utf8'))).toMatchObject({ version: '1.0.0' })
    expect((await readdir(store)).filter(name => name.startsWith('.'))).toEqual([])

    // Once the rename works, the new version replaces it.
    flags.failStagingRename = false
    await manager.install(project, 'test-trees', {}, new AbortController().signal)
    expect(JSON.parse(await readFile(join(installed, STORE_MARKER), 'utf8'))).toMatchObject({ version: '2.0.0' })
    expect((await readdir(store)).filter(name => name.startsWith('.'))).toEqual([])
  })
})
