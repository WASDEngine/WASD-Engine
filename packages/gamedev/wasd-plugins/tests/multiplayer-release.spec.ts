/** Releases point a multiplayer project's configuration at its game and store a dedicated game's server build. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GodotServerExport, GodotWebExport } from '@deepseek-ai/dsh-godot'
import { ReleaseFolders } from '../src/folders.ts'
import { releaseGame, type ReleaseDependencies } from '../src/release.ts'
import { GAME, multiplayerProject, multiplayerSite, ORIGIN, removeProjects, TOKEN } from './multiplayer-site.ts'

const scratch: string[] = []
afterEach(async () => {
  await removeProjects()
  await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

const signal = new AbortController().signal

/** The site's games API for releases, on top of the multiplayer site. */
function releaseSite() {
  const multiplayer = multiplayerSite()
  let versions = GAME.version
  // The multiplayer mode each release upload named.
  const modes: (string | null)[] = []
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const game = () => ({ id: GAME.id, slug: GAME.slug, title: GAME.title, url: GAME.url, latest_version: versions })
  const fetchSite: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname === `/api/v1/games/${GAME.id}` && (init?.method ?? 'GET') === 'GET') return json(200, { game: game() })
    if (url.pathname === '/api/v1/games' && init?.method === 'POST') return json(201, { game: { ...game(), latest_version: 0 } })
    if (url.pathname === `/api/v1/games/${GAME.id}/releases`) {
      modes.push(url.searchParams.get('multiplayer'))
      versions++
      return json(201, { game: game(), release: { version: versions, url: `${GAME.url}?v=${String(versions)}`, play_url: `${ORIGIN}/game-files/${GAME.id}/${String(versions)}/index.html`, total_bytes: 12 } })
    }
    return await multiplayer.fetch(input, init)
  }
  return { ...multiplayer, fetch: fetchSite, modes }
}

async function dependencies(fetchSite: typeof fetch, options: { readonly server?: 'fail' | 'none' } = {}) {
  const configs: { web: string | undefined; server: string | undefined } = { web: undefined, server: undefined }
  // Release folders and temporary files of their own, as on a computer of their own.
  const own = await mkdtemp(join(tmpdir(), 'dsh-wasd-multiplayer-release-'))
  scratch.push(own)
  const deps: ReleaseDependencies = {
    access: () => Promise.resolve({ origin: ORIGIN, token: TOKEN }),
    async exportWeb(projectDir, outputDir): Promise<GodotWebExport> {
      configs.web = await readFile(join(projectDir, 'wasd_multiplayer.cfg'), 'utf8').catch(() => undefined)
      await mkdir(outputDir, { recursive: true })
      for (const name of ['index.html', 'index.js', 'index.wasm', 'index.pck']) await writeFile(join(outputDir, name), name)
      return { projectDir, outputDir, entry: 'index.html', totalBytes: 12, warnings: [], files: ['index.html', 'index.js', 'index.pck', 'index.wasm'].map(path => ({ path, bytes: 3 })) }
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
    for (const text of [configs.web, configs.server]) expect(text).toContain(`max_players=20\napi_origin="${ORIGIN}"\napp_origin="${ORIGIN}"\ngame_id="${GAME.id}"\n`)
  })

  it('point a first release\'s configuration at the new game only after the upload, before the server build', async () => {
    const dir = await multiplayerProject({ linked: false, config: '[wasd]\nmode="dedicated"\n' })
    const site = releaseSite()
    const { deps, configs } = await dependencies(site.fetch)
    await releaseGame({ projectDir: dir }, deps, signal)
    expect(configs.web).toBe('[wasd]\nmode="dedicated"\n')
    expect(configs.server).toContain(`game_id="${GAME.id}"`)
    expect(await readFile(join(dir, 'wasd_multiplayer.cfg'), 'utf8')).toContain(`game_id="${GAME.id}"`)
  })

  it('keep the Web version released when the server build fails, and store none for a player-hosted game', async () => {
    const dedicated = await multiplayerProject({ config: '[wasd]\nmode="dedicated"\n' })
    const site = releaseSite()
    const failed = await releaseGame({ projectDir: dedicated }, (await dependencies(site.fetch, { server: 'fail' })).deps, signal)
    expect(failed.version).toBe(3)
    expect(failed.serverBuild).toBeUndefined()
    expect(failed.warnings.at(-1)).toBe('The version is released, but its dedicated server build was not stored, so the game\'s servers keep their earlier build: The Godot dedicated server export ended (exit code 1) without writing server.x86_64.')
    const hosted = await multiplayerProject({ config: '[wasd]\nmode="player_hosted"\n' })
    const { deps, configs } = await dependencies(site.fetch)
    expect((await releaseGame({ projectDir: hosted }, deps, signal)).serverBuild).toBeUndefined()
    expect(configs.server).toBeUndefined()
    expect(site.builds).toEqual([])
    // Each upload names its mode, so the site plays an online version only while it is the latest.
    expect(site.modes).toEqual(['dedicated', 'player_hosted'])
  })
})
