/**
 * The lock of the shipped Godot entries: it records the catalog of the engine's version, and an entry whose
 * installation puts other content into a project than the lock records for its version must change its version, since
 * projects that have that version would never get the change. The lock's hash covers the parts of an entry that reach
 * a project, the `archive` and `godot` fields, the fields of its notice, and the overlay files, and no other field.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { catalogLock, engineVersion, LOCK_COMMAND, lockProblems, lockText, readLock, type LockedAddon } from './catalog-lock.ts'
import { editableCatalogEntries, scratch, writeCatalog } from './fixtures.ts'
import { CATALOG_DIR } from './shipped-catalog.ts'

describe('the lock of the shipped Godot entries', () => {
  it('records the catalog of the engine\'s version, and holds each entry whose installation changed since to a new version', async () => {
    const problems = lockProblems(await readLock(), await catalogLock(CATALOG_DIR), await engineVersion())
    expect(problems, problems.join('\n')).toEqual([])
  })

  it('asks for the lock of the new release after a version bump, and for a new version of an entry whose installation changed', () => {
    const one = { version: '1.0', sha256: 'a'.repeat(64) }
    const lock = { release: '0.2.4', addons: { first: one, second: one } }
    const changed = { version: '1.0', sha256: 'b'.repeat(64) }
    expect(lockProblems(lock, { first: one, second: one, added: changed }, '0.2.4')).toEqual([])
    expect(lockProblems(lock, { first: one }, '0.2.5')).toEqual([
      `catalog.lock.json records the Godot entries that WASD Engine 0.2.4 shipped, but the engine's version is 0.2.5. Once the catalog holds what 0.2.5 ships, write the lock for it in the engine folder: ${LOCK_COMMAND}`,
    ])
    const [unchanged] = lockProblems(lock, { first: changed, second: { version: '1.0+wasd.1', sha256: changed.sha256 } }, '0.2.4')
    expect(unchanged).toMatch(/^These Godot entries install other content than catalog\.lock\.json records .*: first 1\.0\. /u)
    expect(unchanged).toContain('Change each one\'s version')
    expect(unchanged).toContain(LOCK_COMMAND)
  })

  it('hashes the archive, godot, and notice fields and the overlay files of each Godot entry, whatever the order of its fields', async (test) => {
    const folder = await scratch('catalog-lock')
    test.onTestFinished(() => folder.cleanup())
    const entries = editableCatalogEntries()
    const camera = entries['test-camera'] as Record<string, unknown>
    ;(camera.godot as Record<string, unknown>).overlay = ['test-camera/overlay', 'camera-tools']
    const catalogDir = await writeCatalog(folder.root, entries)
    const overlay = join(catalogDir, 'camera-tools', 'tools')
    await mkdir(overlay, { recursive: true })
    await mkdir(join(catalogDir, 'test-camera', 'overlay'))
    await writeFile(join(overlay, 'framing.gd'), 'extends SceneTree\n')
    await writeFile(join(catalogDir, 'test-camera', 'overlay', 'rig.gd.import'), '[remap]\n')
    const base = await catalogLock(catalogDir)
    // Blender entries are left out, and folders without an entry are overlay folders.
    expect(Object.keys(base).sort()).toEqual(['other-camera', 'test-camera'])
    expect(base['test-camera']?.version).toBe('1.2.0')
    /** The camera entry's hash once `change` changed its catalog files. */
    const hashAfter = async (change: () => Promise<void>): Promise<string | undefined> => {
      await change()
      const hash = (await catalogLock(catalogDir))['test-camera']?.sha256
      await writeCatalog(folder.root, entries)
      await writeFile(join(overlay, 'framing.gd'), 'extends SceneTree\n')
      await rm(join(overlay, '.DS_Store'), { force: true })
      await rm(join(overlay, 'new.gd'), { force: true })
      return hash
    }
    const entryFile = join(catalogDir, 'test-camera', 'addon.json')
    const rewrite = (fields: Record<string, unknown>): Promise<void> => writeFile(entryFile, `${JSON.stringify(fields, null, 2)}\n`)
    // What an installation does not read leaves the hash as it is.
    expect(await hashAfter(() => rewrite(Object.fromEntries(Object.entries(camera).reverse())))).toBe(base['test-camera']?.sha256)
    expect(await hashAfter(() => rewrite({ ...camera, summary: 'Other words.' }))).toBe(base['test-camera']?.sha256)
    expect(await hashAfter(() => writeFile(join(overlay, '.DS_Store'), 'Finder'))).toBe(base['test-camera']?.sha256)
    // A setting, a path the archive leaves out, a line of its notice, and an overlay file's bytes each change it.
    const godot = camera.godot as Record<string, unknown>
    expect(await hashAfter(() => rewrite({ ...camera, godot: { ...godot, settings: [{ section: 'test_camera', key: 'general/smoothing', value: 'false' }] } }))).not.toBe(base['test-camera']?.sha256)
    expect(await hashAfter(() => rewrite({ ...camera, archive: { ...camera.archive as Record<string, unknown>, exclude: ['nodes'] } }))).not.toBe(base['test-camera']?.sha256)
    expect(await hashAfter(() => rewrite({ ...camera, copyright: 'Copyright (c) 2026 Another Author' }))).not.toBe(base['test-camera']?.sha256)
    expect(await hashAfter(() => rewrite({ ...camera, credit: 'Test Camera by Test Author' }))).not.toBe(base['test-camera']?.sha256)
    expect(await hashAfter(() => writeFile(join(overlay, 'framing.gd'), 'extends SceneTree\n# changed\n'))).not.toBe(base['test-camera']?.sha256)
    expect(await hashAfter(() => writeFile(join(overlay, 'new.gd'), 'extends Node\n'))).not.toBe(base['test-camera']?.sha256)
    // The lock file names its release, lists the entries by id, and reads back as written.
    const path = join(folder.root, 'catalog.lock.json')
    const lock = { release: '0.2.4', addons: { 'test-camera': base['test-camera'] as LockedAddon, 'other-camera': base['other-camera'] as LockedAddon } }
    await writeFile(path, lockText(lock))
    expect(Object.keys((await readLock(path)).addons)).toEqual(['other-camera', 'test-camera'])
    expect(await readLock(path)).toEqual({ release: '0.2.4', addons: base })
  })
})
