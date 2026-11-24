/**
 * The record of every shipped WASD Multiplayer add-on, and what installs and updates of a project's add-on do with the
 * files a game changed: an update brings an older copy up to date only while the game left the add-on's own code alone,
 * an install replaces that code after keeping the game's changes in a backup, neither overwrites an example or a
 * Markdown file the game changed, and neither writes through a link.
 */
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addonFileDigest, SHIPPED_ADDON_DOCS, SHIPPED_ADDON_FILES } from '../src/multiplayer-addon-files.ts'
import {
  ADDON_BACKUPS_DIR, installMultiplayerAddon, olderAddonVersion, pluginVersion, updateMultiplayerAddon,
} from '../src/multiplayer-project.ts'
import { ADDON_SOURCE as ADDON, multiplayerProject, olderAddon, PLUGIN_1_2_0, removeProjects } from './multiplayer-site.ts'

const scratch: string[] = []
afterEach(async () => {
  await removeProjects()
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function shippedVersion(): Promise<string> {
  const version = pluginVersion(await readFile(join(ADDON, 'plugin.cfg'), 'utf8'))
  if (version === undefined) throw new Error('the shipped plugin.cfg names no version')
  return version
}

/** The recorded digests of a folder's add-on files: no hidden, `.i18n.yaml`, or Markdown files. */
async function recordedDigests(folder: string, prefix = ''): Promise<Record<string, string>> {
  const digests: Record<string, string> = {}
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = `${prefix}${entry.name}`
    if (entry.name.startsWith('.') || entry.name.endsWith('.i18n.yaml')) continue
    if (entry.isDirectory()) Object.assign(digests, await recordedDigests(join(folder, entry.name), `${path}/`))
    else if (extname(entry.name) !== '.md') digests[path] = addonFileDigest(path, await readFile(join(folder, entry.name)))
  }
  return Object.fromEntries(Object.entries(digests).sort(([left], [right]) => left.localeCompare(right)))
}

/** A player-hosted project with an older copy of the add-on ({@link olderAddon}). */
async function olderProject(): Promise<{ readonly dir: string; readonly addon: string }> {
  const dir = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
  return { dir, addon: await olderAddon(dir) }
}

describe('the record of shipped add-ons', () => {
  it('names the add-on this package ships under its version, with one set of files to a version after 1.2.0', async () => {
    const version = await shippedVersion()
    const files = await recordedDigests(ADDON)
    const advice = `Record this entry under '${version}' in src/multiplayer-addon-files.ts. Replace that version's entry only while no WASD Engine release shipped it; once one did, give the add-on a new version in plugin.cfg and wasd_multiplayer.gd instead:\n${JSON.stringify(files, null, 2)}`
    expect(SHIPPED_ADDON_FILES[version] ?? [], advice).toContainEqual(files)
    for (const [recorded, sets] of Object.entries(SHIPPED_ADDON_FILES)) {
      if (recorded !== '1.2.0') expect(sets, recorded).toHaveLength(1)
    }
  })

  it('records every Markdown file the add-on ships, apart from its versions', async () => {
    const docs = (await readdir(ADDON, { recursive: true })).map(path => path.split(sep).join('/')).filter(path => extname(path) === '.md')
    expect(docs).toEqual(expect.arrayContaining(['README.md', 'README.zh.md']))
    for (const path of docs) {
      const digest = addonFileDigest(path, await readFile(join(ADDON, path)))
      const advice = `Add '${digest}' to SHIPPED_ADDON_DOCS['${path}'] in src/multiplayer-addon-files.ts; a change of the add-on's Markdown files needs no new version.`
      expect(SHIPPED_ADDON_DOCS[path] ?? [], advice).toContain(digest)
    }
  })

  it('reads CRLF line endings of text files as LF', () => {
    const lf = new TextEncoder().encode('extends Node\n\nfunc _ready() -> void:\n\tpass\n')
    const crlf = new TextEncoder().encode('extends Node\r\n\r\nfunc _ready() -> void:\r\n\tpass\r\n')
    expect(addonFileDigest('wasd_multiplayer.gd', crlf)).toBe(addonFileDigest('wasd_multiplayer.gd', lf))
    expect(addonFileDigest('icon.png', crlf)).not.toBe(addonFileDigest('icon.png', lf))
  })

  it('compares versions number by number', () => {
    expect(olderAddonVersion('1.2.0', '1.3.0')).toBe(true)
    expect(olderAddonVersion('1.9.0', '1.10.0')).toBe(true)
    expect(olderAddonVersion('1.3', '1.3.0')).toBe(false)
    expect(olderAddonVersion('1.3.0', '1.2.9')).toBe(false)
    expect(olderAddonVersion('1.2.0-dev', '1.3.0')).toBe(false)
  })
})

describe('an update of a project\'s add-on', () => {
  it('brings an older, unchanged copy up to date, keeping Godot\'s UIDs and the example files the game adapted, added, or removed', async () => {
    const { dir, addon } = await olderProject()
    await writeFile(join(addon, 'examples', 'lobby_menu.gd'), 'extends Control\n# The game\'s own menu.\n')
    await writeFile(join(addon, 'examples', 'my_menu.gd'), 'extends Control\n')
    await rm(join(addon, 'examples', 'lobby_menu.tscn'))
    const version = await shippedVersion()
    expect(await updateMultiplayerAddon(dir, ADDON)).toEqual({ outcome: 'updated', from: '1.2.0', to: version, kept: ['examples/lobby_menu.gd', 'examples/my_menu.gd'] })
    expect(await readFile(join(addon, 'plugin.cfg'), 'utf8')).toBe(await readFile(join(ADDON, 'plugin.cfg'), 'utf8'))
    expect(await readFile(join(addon, 'examples', 'lobby_menu.gd'), 'utf8')).toBe('extends Control\n# The game\'s own menu.\n')
    expect(await readdir(join(addon, 'examples'))).toEqual(['lobby_menu.gd', 'my_menu.gd'])
    expect(await readFile(join(addon, 'wasd_multiplayer.gd.uid'), 'utf8')).toBe('uid://bwasdmultiplayer\n')
    // Up to date now, so the next release leaves it.
    expect(await updateMultiplayerAddon(dir, ADDON)).toBeUndefined()
  })

  it('reads a copy that a Windows checkout gave CRLF line endings as unchanged', async () => {
    const { dir, addon } = await olderProject()
    const script = join(addon, 'internal', 'tokens.gd')
    await writeFile(script, (await readFile(script, 'utf8')).replaceAll('\n', '\r\n'))
    expect(await updateMultiplayerAddon(dir, ADDON)).toMatchObject({ outcome: 'updated', from: '1.2.0' })
  })

  it('leaves an older copy whose own code the game changed or added to, and names those files', async () => {
    const { dir, addon } = await olderProject()
    await writeFile(join(addon, 'wasd_multiplayer.gd'), `${await readFile(join(addon, 'wasd_multiplayer.gd'), 'utf8')}\n# A patch of the game's.\n`)
    await writeFile(join(addon, 'internal', 'extra.gd'), 'extends RefCounted\n')
    await writeFile(join(addon, 'examples', 'lobby_menu.gd'), 'extends Control\n')
    expect(await updateMultiplayerAddon(dir, ADDON)).toEqual({
      outcome: 'changed', from: '1.2.0', to: await shippedVersion(), changed: ['internal/extra.gd', 'wasd_multiplayer.gd'],
    })
    expect(await readFile(join(addon, 'plugin.cfg'), 'utf8')).toBe(PLUGIN_1_2_0)
  })

  it('leaves a copy as new as the shipped one or newer, and a project without the add-on', async () => {
    const { dir, addon } = await olderProject()
    await writeFile(join(addon, 'plugin.cfg'), await readFile(join(ADDON, 'plugin.cfg'), 'utf8'))
    expect(await updateMultiplayerAddon(dir, ADDON)).toBeUndefined()
    await writeFile(join(addon, 'plugin.cfg'), PLUGIN_1_2_0.replace('1.2.0', '99.0.0'))
    expect(await updateMultiplayerAddon(dir, ADDON)).toBeUndefined()
    expect(await updateMultiplayerAddon(await multiplayerProject(), ADDON)).toBeUndefined()
  })

  it('leaves an older copy whose own code is a link in place of a file or a folder, and never writes through it', async () => {
    const { dir, addon } = await olderProject()
    const own = join(dir, 'own')
    await cp(join(addon, 'internal'), own, { recursive: true })
    await writeFile(join(own, 'config.gd'), 'extends RefCounted\n# The game\'s config.\n')
    await rm(join(addon, 'internal'), { recursive: true })
    await symlink(own, join(addon, 'internal'))
    await writeFile(join(dir, 'main.gd'), 'extends Node\n# The game\'s own main script.\n')
    await rm(join(addon, 'wasd_multiplayer.gd'))
    await symlink(join(dir, 'main.gd'), join(addon, 'wasd_multiplayer.gd'))
    expect(await updateMultiplayerAddon(dir, ADDON)).toEqual({
      outcome: 'changed', from: '1.2.0', to: await shippedVersion(), changed: ['internal', 'wasd_multiplayer.gd'],
    })
    expect(await readFile(join(own, 'config.gd'), 'utf8')).toBe('extends RefCounted\n# The game\'s config.\n')
    expect((await lstat(join(addon, 'wasd_multiplayer.gd'))).isSymbolicLink()).toBe(true)
    expect(await readFile(join(addon, 'plugin.cfg'), 'utf8')).toBe(PLUGIN_1_2_0)
  })

  it('keeps the Markdown files the game changed and a link in place of the examples, and replaces the ones WASD Engine shipped', async () => {
    const { dir, addon } = await olderProject()
    const examples = join(dir, 'menus')
    await cp(join(addon, 'examples'), examples, { recursive: true })
    await rm(join(addon, 'examples'), { recursive: true })
    await symlink(examples, join(addon, 'examples'))
    await writeFile(join(addon, 'README.md'), '# Our team notes\n')
    await writeFile(join(addon, 'NOTES.md'), 'More notes.\n')
    // A later add-on whose README.zh.md and new example differ from this one's.
    const later = await mkdtemp(join(tmpdir(), 'dsh-wasd-addon-later-'))
    scratch.push(later)
    await cp(ADDON, later, { recursive: true })
    await writeFile(join(later, 'README.zh.md'), '# WASD Multiplayer\n')
    await writeFile(join(later, 'examples', 'server_menu.gd'), 'extends Control\n')
    await writeFile(join(later, 'plugin.cfg'), PLUGIN_1_2_0.replace('1.2.0', '99.0.0'))
    expect(await updateMultiplayerAddon(dir, later)).toEqual({ outcome: 'updated', from: '1.2.0', to: '99.0.0', kept: ['NOTES.md', 'README.md', 'examples'] })
    expect(await readFile(join(addon, 'README.md'), 'utf8')).toBe('# Our team notes\n')
    expect(await readFile(join(addon, 'README.zh.md'), 'utf8')).toBe('# WASD Multiplayer\n')
    expect(await readFile(join(addon, 'plugin.cfg'), 'utf8')).toContain('version="99.0.0"')
    // The examples stay the game's: nothing went through the link into its folder.
    expect(await readdir(examples)).toEqual(['lobby_menu.gd', 'lobby_menu.tscn'])
  })

  it('removes the files of an earlier add-on that the new one leaves out, with the files Godot keeps beside them, and adds its new examples', async () => {
    const { dir, addon } = await olderProject()
    // A later add-on without internal/counting_peer.gd and with an example 1.2.0 never had.
    const later = await mkdtemp(join(tmpdir(), 'dsh-wasd-addon-later-'))
    scratch.push(later)
    await cp(ADDON, later, { recursive: true })
    await rm(join(later, 'internal', 'counting_peer.gd'))
    await writeFile(join(later, 'examples', 'server_menu.gd'), 'extends Control\n')
    await writeFile(join(later, 'plugin.cfg'), PLUGIN_1_2_0.replace('1.2.0', '99.0.0'))
    await writeFile(join(addon, 'internal', 'counting_peer.gd.uid'), 'uid://bcountingpeer\n')
    expect(await updateMultiplayerAddon(dir, later)).toEqual({ outcome: 'updated', from: '1.2.0', to: '99.0.0', kept: [] })
    expect((await readdir(join(addon, 'internal'))).filter(name => name.startsWith('counting_peer'))).toEqual([])
    expect(await readdir(join(addon, 'examples'))).toEqual(['lobby_menu.gd', 'lobby_menu.tscn', 'server_menu.gd'])
  })
})

describe('an install of the add-on', () => {
  it('replaces the add-on\'s own files after keeping the ones the game changed in a backup, and keeps the example files and other files the game changed or added', async () => {
    const { dir, addon } = await olderProject()
    await writeFile(join(addon, 'wasd_multiplayer.gd'), 'extends Node\n# The game\'s patch.\n')
    await writeFile(join(addon, 'internal', 'config.gd'), 'extends RefCounted\n# The game\'s config.\n')
    await writeFile(join(addon, 'internal', 'extra.gd'), 'extends RefCounted\n')
    await writeFile(join(addon, 'examples', 'lobby_menu.gd'), 'extends Control\n')
    await writeFile(join(addon, 'README.md'), '# Our team notes\n')
    const installed = await installMultiplayerAddon(dir, ADDON)
    expect(installed.kept).toEqual(['README.md', 'examples/lobby_menu.gd', 'internal/extra.gd'])
    expect(installed.written).toContain('wasd_multiplayer.gd')
    expect(installed.written.at(-1)).toBe('plugin.cfg')
    for (const path of ['wasd_multiplayer.gd', 'internal/config.gd']) expect(await readFile(join(addon, path), 'utf8')).toBe(await readFile(join(ADDON, path), 'utf8'))
    expect(await readFile(join(addon, 'examples', 'lobby_menu.gd'), 'utf8')).toBe('extends Control\n')
    expect(await readFile(join(addon, 'README.md'), 'utf8')).toBe('# Our team notes\n')
    // The game's versions of the files it replaced are in a new backup folder, at their paths in the project.
    expect(installed.backup?.files).toEqual(['internal/config.gd', 'wasd_multiplayer.gd'])
    expect(installed.backup?.folder).toMatch(new RegExp(`^${ADDON_BACKUPS_DIR}/\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d\\.\\d{3}Z$`, 'u'))
    const backup = join(dir, installed.backup?.folder ?? '', 'addons', 'wasd_multiplayer')
    expect(await readFile(join(backup, 'wasd_multiplayer.gd'), 'utf8')).toBe('extends Node\n# The game\'s patch.\n')
    expect(await readFile(join(backup, 'internal', 'config.gd'), 'utf8')).toBe('extends RefCounted\n# The game\'s config.\n')
    expect(await readFile(join(dir, '.wasdengine', 'backups', '.gitignore'), 'utf8')).toBe('*\n')
    // Unchanged now, so an install again keeps no backup, and the next backup gets a folder of its own.
    expect((await installMultiplayerAddon(dir, ADDON)).backup).toBeUndefined()
    await writeFile(join(addon, 'plugin.gd'), 'extends EditorPlugin\n')
    const next = await installMultiplayerAddon(dir, ADDON)
    expect(next.backup?.files).toEqual(['plugin.gd'])
    expect(next.backup?.folder).not.toBe(installed.backup?.folder)
  })

  it('moves a link in place of an own file or its folder into the backup instead of writing through it', async () => {
    const { dir, addon } = await olderProject()
    const own = join(dir, 'own')
    await cp(join(addon, 'internal'), own, { recursive: true })
    await writeFile(join(own, 'config.gd'), 'extends RefCounted\n# The game\'s config.\n')
    await rm(join(addon, 'internal'), { recursive: true })
    await symlink(own, join(addon, 'internal'))
    await writeFile(join(dir, 'main.gd'), 'extends Node\n')
    await rm(join(addon, 'wasd_multiplayer.gd'))
    await symlink(join(dir, 'main.gd'), join(addon, 'wasd_multiplayer.gd'))
    const installed = await installMultiplayerAddon(dir, ADDON)
    expect(installed.backup?.files).toEqual(['internal', 'wasd_multiplayer.gd'])
    const backup = join(dir, installed.backup?.folder ?? '', 'addons', 'wasd_multiplayer')
    expect(await readlink(join(backup, 'internal'))).toBe(own)
    expect(await readlink(join(backup, 'wasd_multiplayer.gd'))).toBe(join(dir, 'main.gd'))
    // The linked files stay the game's, and the add-on has real files and folders of its own.
    expect(await readFile(join(own, 'config.gd'), 'utf8')).toBe('extends RefCounted\n# The game\'s config.\n')
    expect(await readFile(join(dir, 'main.gd'), 'utf8')).toBe('extends Node\n')
    expect((await lstat(join(addon, 'internal'))).isDirectory()).toBe(true)
    expect(await readFile(join(addon, 'internal', 'config.gd'), 'utf8')).toBe(await readFile(join(ADDON, 'internal', 'config.gd'), 'utf8'))
    expect((await lstat(join(addon, 'wasd_multiplayer.gd'))).isFile()).toBe(true)
  })

  it('refuses a backup folder that leads outside the project, before it changes anything, and follows one inside it', async () => {
    const { dir, addon } = await olderProject()
    const outside = await mkdtemp(join(tmpdir(), 'dsh-wasd-addon-outside-'))
    scratch.push(outside)
    await writeFile(join(addon, 'wasd_multiplayer.gd'), 'extends Node\n# The game\'s patch.\n')
    await mkdir(join(dir, '.wasdengine'), { recursive: true })
    await symlink(outside, join(dir, '.wasdengine', 'backups'))
    await expect(installMultiplayerAddon(dir, ADDON)).rejects.toThrow(
      `The setup changed nothing: .wasdengine/backups in ${dir} leads outside the project, to ${await realpath(outside)}, where the setup would keep the game's versions of the add-on files it replaces. Make it a folder of the project, then call wasd_multiplayer_setup again.`,
    )
    expect(await readdir(outside)).toEqual([])
    expect(await readFile(join(addon, 'wasd_multiplayer.gd'), 'utf8')).toBe('extends Node\n# The game\'s patch.\n')
    expect(await readFile(join(addon, 'plugin.cfg'), 'utf8')).toBe(PLUGIN_1_2_0)
    // The state folder itself as a link outside is refused the same way.
    await rm(join(dir, '.wasdengine'), { recursive: true })
    await symlink(outside, join(dir, '.wasdengine'))
    await expect(installMultiplayerAddon(dir, ADDON)).rejects.toThrow(/^The setup changed nothing: \.wasdengine in /u)
    expect(await readdir(outside)).toEqual([])
    // A link that stays inside the project leads to a backup inside it.
    await rm(join(dir, '.wasdengine'))
    await mkdir(join(dir, 'state'))
    await symlink(join(dir, 'state'), join(dir, '.wasdengine'))
    const installed = await installMultiplayerAddon(dir, ADDON)
    expect(installed.backup?.files).toEqual(['wasd_multiplayer.gd'])
    const copy = join(dir, 'state', (installed.backup?.folder ?? '').replace(/^\.wasdengine\//u, ''), 'addons', 'wasd_multiplayer', 'wasd_multiplayer.gd')
    expect(await readFile(copy, 'utf8')).toBe('extends Node\n# The game\'s patch.\n')
  })

  it('keeps the examples the game adapted in a folder whose main script is gone', async () => {
    const dir = await multiplayerProject()
    await mkdir(join(dir, 'addons', 'wasd_multiplayer', 'examples'), { recursive: true })
    await writeFile(join(dir, 'addons', 'wasd_multiplayer', 'examples', 'lobby_menu.gd'), 'extends Control\n')
    const installed = await installMultiplayerAddon(dir, ADDON)
    expect(installed.kept).toEqual(['examples/lobby_menu.gd'])
    expect(await readFile(join(dir, 'addons', 'wasd_multiplayer', 'examples', 'lobby_menu.gd'), 'utf8')).toBe('extends Control\n')
  })

  it('copies every file but the translation records into a project without the add-on', async () => {
    const dir = await multiplayerProject()
    const installed = await installMultiplayerAddon(dir, ADDON)
    expect(installed.kept).toEqual([])
    expect(installed.backup).toBeUndefined()
    expect(installed.written).toEqual(expect.arrayContaining(['README.md', 'examples/lobby_menu.tscn', 'internal/config.gd', 'plugin.cfg']))
    expect(installed.written).not.toContain('README.i18n.yaml')
    expect(await readdir(join(dir, 'addons', 'wasd_multiplayer', 'examples'))).toEqual(['lobby_menu.gd', 'lobby_menu.tscn'])
    await expect(lstat(join(dir, '.wasdengine', 'backups'))).rejects.toThrow(/ENOENT/u)
  })
})
