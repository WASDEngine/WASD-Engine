/**
 * Releases point a multiplayer project's configuration at its game, bring an older, unchanged WASD Multiplayer add-on
 * up to date, tell the site which add-on the builds carry, and store a dedicated game's server build.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotServerExport, GodotWebExport } from '@deepseek-ai/dsh-godot'
import { ReleaseFolders } from '../src/folders.ts'
import { parseMultiplayerConfig, pluginVersion } from '../src/multiplayer-project.ts'
import { ReleaseError, releaseGame, type ReleaseDependencies } from '../src/release.ts'
import { ADDON_SOURCE, GAME, multiplayerProject, multiplayerSite, olderAddon, ORIGIN, PLUGIN_1_2_0, removeProjects, TOKEN } from './multiplayer-site.ts'

const scratch: string[] = []
afterEach(async () => {
  await removeProjects()
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const signal = new AbortController().signal

/**
 * The site's games API for releases, on top of the multiplayer site.
 * @param options - `refuse` answers every release upload with a refusal.
 */
function releaseSite(options: { readonly refuse?: boolean } = {}) {
  const multiplayer = multiplayerSite()
  let versions = GAME.version
  // The multiplayer mode and the add-on version each release upload named.
  const modes: (string | null)[] = []
  const addons: (string | null)[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const game = () => ({ id: GAME.id, slug: GAME.slug, title: GAME.title, url: GAME.url, latest_version: versions })
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === `/api/v1/games/${GAME.id}` && (init?.method ?? 'GET') === 'GET') return json(200, { game: game() })
    if (url.pathname === '/api/v1/games' && init?.method === 'POST') return json(201, { game: { ...game(), latest_version: 0 } })
    if (url.pathname === `/api/v1/games/${GAME.id}/releases`) {
      if (options.refuse === true) return json(413, { type: 'error', error: { type: 'invalid_request_error', message: 'A release may be at most 2048 MB.' } })
      modes.push(url.searchParams.get('multiplayer'))
      addons.push(url.searchParams.get('multiplayer_addon'))
      versions++
      return json(201, { game: game(), release: { version: versions, url: `${GAME.url}?v=${String(versions)}`, play_url: `${ORIGIN}/game-files/${GAME.id}/${String(versions)}/index.html`, total_bytes: 12 } })
    }
    return await multiplayer.fetch(input, init)
  }
  return { ...multiplayer, fetch: fetchSite, modes, addons }
}

async function dependencies(fetchSite: typeof fetch, options: { readonly server?: 'fail' | 'none'; readonly web?: 'fail' } = {}) {
  // The configuration and the add-on's plugin.cfg each export saw.
  const configs: Record<'web' | 'server' | 'plugin', string | undefined> = { web: undefined, server: undefined, plugin: undefined }
  // Release folders and temporary files of their own, as on a computer of their own.
  const own = await mkdtemp(join(tmpdir(), 'dsh-wasd-multiplayer-release-'))
  scratch.push(own)
  const deps: ReleaseDependencies = {
    access: () => Promise.resolve({ origin: ORIGIN, token: TOKEN }),
    async exportWeb(projectDir, outputDir): Promise<GodotWebExport> {
      configs.web = await readFile(join(projectDir, 'wasd_multiplayer.cfg'), 'utf8').catch(() => undefined)
      configs.plugin = await readFile(join(projectDir, 'addons', 'wasd_multiplayer', 'plugin.cfg'), 'utf8').catch(() => undefined)
      if (options.web === 'fail') throw new Error('The Godot Web export ended (exit code 1) without writing index.html.')
      await mkdir(outputDir, { recursive: true })
      for (const name of ['index.html', 'index.js', 'index.wasm', 'index.pck']) await writeFile(join(outputDir, name), name)
      return {
        projectDir, outputDir, entry: 'index.html', totalBytes: 12, fileName: 'Arena', warnings: [],
        files: ['index.html', 'index.js', 'index.pck', 'index.wasm'].map(path => ({ path, bytes: 3 })),
      }
    },
    ...options.server === 'none' ? {} : {
      async exportServer(projectDir: string, outputDir: string): Promise<GodotServerExport> {
        configs.server = await readFile(join(projectDir, 'wasd_multiplayer.cfg'), 'utf8')
        if (options.server === 'fail') throw new Error('The Godot dedicated server export ended (exit code 1) without writing server.x86_64.')
        await rm(outputDir, { recursive: true, force: true })
        await mkdir(outputDir, { recursive: true })
        await writeFile(join(outputDir, 'server.x86_64'), 'ELF')
        await writeFile(join(outputDir, 'libsteer.so'), 'so')
        return { projectDir, outputDir, binary: 'server.x86_64', bytes: 3, files: [{ path: 'libsteer.so', bytes: 2 }, { path: 'server.x86_64', bytes: 3 }], warnings: [] }
      },
    },
    exportDesktop: () => Promise.reject(new Error('no desktop builds in these releases')),
    fetch: fetchSite,
    folders: new ReleaseFolders(join(own, 'release-folders')),
    tempDir: own,
  }
  return { deps, configs }
}

describe('releases of multiplayer games', () => {
  it('export the server build of a dedicated game after the Web build and store it with the new version', async () => {
    const dir = await multiplayerProject({ config: '[wasd]\nmode="dedicated"\nmax_players=20\ngame_id=""\n' })
    const site = releaseSite()
    const { deps, configs } = await dependencies(site.fetch)
    const released = await releaseGame({ projectDir: dir }, deps, signal)
    expect(released).toMatchObject({ version: 3, serverBuild: { version: 3, bytes: expect.any(Number) as number } })
    expect(site.builds).toEqual([{ game: GAME.id, version: '3', files: ['libsteer.so', 'server.x86_64'] }])
    // The project was linked, so the Web build already names its game and its site.
    for (const text of [configs.web, configs.server]) {
      expect(parseMultiplayerConfig(text ?? '')).toEqual({ mode: 'dedicated', maxPlayers: 20, apiOrigin: ORIGIN, appOrigin: ORIGIN, gameId: GAME.id, version: 0 })
    }
  })

  it('keep the configuration\'s other keys, sections, and comments when they point it at the game', async () => {
    const config = '; Our tuning.\n[wasd]\n\nmode="dedicated"\nsite_origins=["https://play.studio.test"]\ncount_traffic=false\nserver_fps=30\nserver_idle_fps=5\n\n[studio]\nbuild="nightly"\n'
    const dir = await multiplayerProject({ config })
    const site = releaseSite()
    const { deps, configs } = await dependencies(site.fetch)
    await releaseGame({ projectDir: dir }, deps, signal)
    const written = await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')
    expect(written).toBe(`; Our tuning.\n[wasd]\n\nmode="dedicated"\nsite_origins=["https://play.studio.test"]\ncount_traffic=false\nserver_fps=30\nserver_idle_fps=5\nmax_players=8\napi_origin="${ORIGIN}"\napp_origin="${ORIGIN}"\ngame_id="${GAME.id}"\nversion=0\n\n[studio]\nbuild="nightly"\n`)
    for (const text of [configs.web, configs.server]) expect(text).toBe(written)
  })

  it('make a dedicated game\'s first release create the game before the builds export, so both name it', async () => {
    const dir = await multiplayerProject({ linked: false, config: '[wasd]\nmode="dedicated"\n' })
    const site = releaseSite()
    const { deps, configs } = await dependencies(site.fetch)
    await releaseGame({ projectDir: dir }, deps, signal)
    for (const text of [configs.web, configs.server]) expect(text).toContain(`game_id="${GAME.id}"`)
    expect(await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')).toContain(`game_id="${GAME.id}"`)
  })

  it('point a player-hosted game\'s first release at the release\'s site before the export, and at the new game after the upload', async () => {
    const dir = await multiplayerProject({ linked: false, config: '[wasd]\nmode="player_hosted"\napi_origin="https://setup.example"\n' })
    const site = releaseSite()
    const { deps, configs } = await dependencies(site.fetch)
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(parseMultiplayerConfig(configs.web ?? '')).toMatchObject({ apiOrigin: ORIGIN, appOrigin: ORIGIN, gameId: '' })
    expect(configs.web).not.toContain('setup.example')
    expect(await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')).toContain(`game_id="${GAME.id}"`)
  })

  it('bring an older, unchanged WASD Multiplayer add-on up to date before the export, and say so', async () => {
    const dir = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    const addon = await olderAddon(dir)
    await writeFile(join(addon, 'examples', 'lobby_menu.gd'), 'extends Control\n')
    const site = releaseSite()
    const { deps, configs } = await dependencies(site.fetch)
    const released = await releaseGame({ projectDir: dir }, { ...deps, addonSource: ADDON_SOURCE }, signal)
    const shipped = await readFile(join(ADDON_SOURCE, 'plugin.cfg'), 'utf8')
    const version = pluginVersion(shipped) ?? ''
    expect(configs.plugin).toBe(shipped)
    expect(released.warnings).toContain(`This project's WASD Multiplayer add-on was 1.2.0; the release updated it to ${version} before the export. The add-on files the game changed or added stayed as they were: examples/lobby_menu.gd.`)
    // The site learns the add-on that the builds carry.
    expect(site.addons).toEqual([version])
    // A release of a project without the add-on's folder, from a computer of its own, leaves the project as it is.
    const plain = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    const own = await dependencies(site.fetch)
    expect((await releaseGame({ projectDir: plain }, { ...own.deps, addonSource: ADDON_SOURCE }, signal)).warnings).toEqual([])
    expect(own.configs.plugin).toBeUndefined()
    expect(site.modes).toEqual(['player_hosted', 'player_hosted'])
    expect(site.addons).toEqual([version, null])
  })

  it('build with an older add-on whose own code the game changed, and say what to ask the user', async () => {
    const dir = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    const addon = await olderAddon(dir)
    await writeFile(join(addon, 'wasd_multiplayer.gd'), 'extends Node\n')
    const site = releaseSite()
    const { deps, configs } = await dependencies(site.fetch)
    const released = await releaseGame({ projectDir: dir }, { ...deps, addonSource: ADDON_SOURCE }, signal)
    const version = pluginVersion(await readFile(join(ADDON_SOURCE, 'plugin.cfg'), 'utf8')) ?? ''
    expect(configs.plugin).toBe(PLUGIN_1_2_0)
    expect(released.warnings).toContain(`This project's WASD Multiplayer add-on is 1.2.0, older than WASD Engine's ${version}, and the game changed the add-on's own code (wasd_multiplayer.gd), so the release built the game with it as it is. Ask the user whether to call wasd_multiplayer_setup, which replaces the add-on's own files with ${version}'s, first keeping the ones the game changed in a backup folder that its result names, and keeps the files the game added and the example files it changed; then apply the game's changes again from that backup where ${version} still needs them.`)
    // The builds carry 1.2.0, and the site learns it.
    expect(site.addons).toEqual(['1.2.0'])
  })

  it('name only a major.minor.patch add-on version to the site, and none for a game that plays offline', async () => {
    const site = releaseSite()
    const release = async (version: string | undefined, config?: string) => {
      const dir = await multiplayerProject(config === undefined ? {} : { config })
      const addon = await olderAddon(dir)
      const plugin = join(addon, 'plugin.cfg')
      if (version === undefined) await rm(plugin)
      else await writeFile(plugin, PLUGIN_1_2_0.replace('1.2.0', version))
      await releaseGame({ projectDir: dir }, (await dependencies(site.fetch)).deps, signal)
    }
    const hosted = '[wasd]\nmode="player_hosted"\n'
    for (const version of ['1.2.0-dev', '1.2', '123456789.12345.1', undefined, '10.20.30']) await release(version, hosted)
    // A game without a mode plays offline and names neither.
    await release('1.2.0')
    expect(site.modes).toEqual(['player_hosted', 'player_hosted', 'player_hosted', 'player_hosted', 'player_hosted', null])
    expect(site.addons).toEqual([null, null, null, null, '10.20.30', null])
  })

  it('say in the failure of a later step that the release updated the add-on, which the next release no longer says', async () => {
    const version = pluginVersion(await readFile(join(ADDON_SOURCE, 'plugin.cfg'), 'utf8')) ?? ''
    const note = `This project's WASD Multiplayer add-on was 1.2.0; the release updated it to ${version} before the export.`
    const dir = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    await olderAddon(dir)
    const failedExport = { ...(await dependencies(releaseSite().fetch, { web: 'fail' })).deps, addonSource: ADDON_SOURCE }
    const exportFailure = await releaseGame({ projectDir: dir }, failedExport, signal).catch((error: unknown) => error)
    expect(exportFailure).toBeInstanceOf(ReleaseError)
    expect((exportFailure as Error).message).toBe(`The Godot Web export ended (exit code 1) without writing index.html.\n${note}`)
    expect(((exportFailure as Error).cause as Error).message).toBe('The Godot Web export ended (exit code 1) without writing index.html.')
    // The add-on is up to date now, so a refused upload after it has nothing to say of it.
    const refusing = releaseSite({ refuse: true })
    await expect(releaseGame({ projectDir: dir }, { ...(await dependencies(refusing.fetch)).deps, addonSource: ADDON_SOURCE }, signal))
      .rejects.toThrow(/^WASD Engine could not store the release: A release may be at most 2048 MB\.$/u)

    const other = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    await olderAddon(other)
    await expect(releaseGame({ projectDir: other }, { ...(await dependencies(refusing.fetch)).deps, addonSource: ADDON_SOURCE }, signal))
      .rejects.toThrow(`WASD Engine could not store the release: A release may be at most 2048 MB.\n${note}`)
  })

  it('release nothing when a dedicated game\'s server build fails, and store none for a player-hosted game', async () => {
    const dedicated = await multiplayerProject({ config: '[wasd]\nmode="dedicated"\n' })
    const site = releaseSite()
    await expect(releaseGame({ projectDir: dedicated }, (await dependencies(site.fetch, { server: 'fail' })).deps, signal)).rejects.toThrow(
      'Nothing was released: the game\'s dedicated server build failed, and no player could join a version without one: The Godot dedicated server export ended (exit code 1) without writing server.x86_64.')
    await expect(releaseGame({ projectDir: dedicated }, (await dependencies(site.fetch, { server: 'none' })).deps, signal)).rejects.toThrow(
      'Nothing was released: the game\'s dedicated server build failed, and no player could join a version without one: this WASD Engine cannot export dedicated server builds.')
    expect(site.modes).toEqual([])
    const hosted = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    const { deps, configs } = await dependencies(site.fetch)
    expect((await releaseGame({ projectDir: hosted }, deps, signal)).serverBuild).toBeUndefined()
    expect(configs.server).toBeUndefined()
    expect(site.builds).toEqual([])
    // Each upload names its mode, so the site plays an online version only while it is the latest.
    expect(site.modes).toEqual(['player_hosted'])
  })
})
