/**
 * The record of every shipped WASD Multiplayer add-on, and what installs and updates of a project's add-on do with the
 * files a game changed: an update brings an older copy up to date only while the game left the add-on's own code alone,
 * and neither an update nor an install overwrites an example the game adapted.
 */
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { addonFileDigest, SHIPPED_ADDON_FILES } from '../src/multiplayer-addon-files.ts'
import { installMultiplayerAddon, olderAddonVersion, pluginVersion, updateMultiplayerAddon } from '../src/multiplayer-project.ts'
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
  it('replaces the add-on\'s own files, changed or not, and keeps the example files and other files the game changed or added', async () => {
    const { dir, addon } = await olderProject()
    await writeFile(join(addon, 'wasd_multiplayer.gd'), 'extends Node\n')
    await writeFile(join(addon, 'internal', 'extra.gd'), 'extends RefCounted\n')
    await writeFile(join(addon, 'examples', 'lobby_menu.gd'), 'extends Control\n')
    const installed = await installMultiplayerAddon(dir, ADDON)
    expect(installed.kept).toEqual(['examples/lobby_menu.gd', 'internal/extra.gd'])
    expect(installed.written).toContain('wasd_multiplayer.gd')
    expect(installed.written.at(-1)).toBe('plugin.cfg')
    expect(await readFile(join(addon, 'wasd_multiplayer.gd'), 'utf8')).toBe(await readFile(join(ADDON, 'wasd_multiplayer.gd'), 'utf8'))
    expect(await readFile(join(addon, 'examples', 'lobby_menu.gd'), 'utf8')).toBe('extends Control\n')
  })

  it('copies every file but the translation records into a project without the add-on', async () => {
    const dir = await multiplayerProject()
    const installed = await installMultiplayerAddon(dir, ADDON)
    expect(installed.kept).toEqual([])
    expect(installed.written).toEqual(expect.arrayContaining(['README.md', 'examples/lobby_menu.tscn', 'internal/config.gd', 'plugin.cfg']))
    expect(installed.written).not.toContain('README.i18n.yaml')
    expect(await readdir(join(dir, 'addons', 'wasd_multiplayer', 'examples'))).toEqual(['lobby_menu.gd', 'lobby_menu.tscn'])
  })
})
