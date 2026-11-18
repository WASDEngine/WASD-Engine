/**
 * The Desktop app ships the Web export template that the Godot plugin pins and the archives of the add-on catalog's
 * bundled entries, each checked against its pin, where the plugins look before they download.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bundledArchivesDir } from '../../../packages/gamedev/game-addons/src/archive.ts'
import { bundledTemplatesDir } from '../../../packages/gamedev/godot/src/export-template.ts'
import { localMacOSPackageEnvironment } from '../scripts/desktop-package-environment.mjs'
import { stageAddonArchives } from '../scripts/wasdengine-addon-archives.ts'
import { applyWasdengineBundledFiles, BUNDLED_FILES_ASAR_UNPACK } from '../scripts/wasdengine-builder-config.mjs'
import { downloadVerified } from '../scripts/wasdengine-runtime-archive.ts'
import { stageWebTemplate } from '../scripts/wasdengine-web-template.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const RELEASE = 'https://github.com/WASDEngine/WASD-Engine/releases/download/web-template-9.9-test/'
const ENTRY = 'templates/web_nothreads_release.zip'
const TEMPLATE = Buffer.from('the Web template zip')
const PACK = Buffer.from('the asset pack zip')
const TOOL = Buffer.from('the code add-on zip')

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wasd-bundled-files-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** A prepared dsh tree with the Godot, add-on, and Web app packages, and a catalog of one bundled and one other entry. */
async function dshTree(entries: Record<string, object> = {
  'asset-pack': { bundled: true, archive: { url: 'https://assets.example.test/pack.zip', sha256: sha256(PACK), bytes: PACK.length } },
  'code-tool': { archive: { url: 'https://code.example.test/tool.zip', sha256: sha256(TOOL), bytes: TOOL.length } },
}): Promise<string> {
  const dsh = join(root, 'dsh')
  const modules = join(dsh, 'node_modules', '@deepseek-ai')
  for (const name of ['dsh-godot', 'dsh-game-addons', 'dsh-web-app']) {
    await mkdir(join(modules, name), { recursive: true })
    await writeFile(join(modules, name, 'package.json'), '{}')
  }
  const catalog = join(modules, 'dsh-web-app', 'wasdengine', 'addons')
  for (const [id, entry] of Object.entries(entries)) {
    await mkdir(join(catalog, id), { recursive: true })
    await writeFile(join(catalog, id, 'addon.json'), JSON.stringify({ id, ...entry }))
  }
  // An overlay folder beside the entries has no addon.json.
  await mkdir(join(catalog, 'shared-overlay'), { recursive: true })
  return dsh
}

/** A repository whose Godot plugin source pins the template, and a local release folder that holds it. */
async function templateRelease(
  manifest: object = { template: { entry: ENTRY, bytes: TEMPLATE.length, sha256: sha256(TEMPLATE) } }, file = TEMPLATE,
): Promise<{ readonly repository: string; readonly local: string }> {
  const repository = join(root, 'repository')
  await mkdir(join(repository, 'packages', 'gamedev', 'godot', 'src'), { recursive: true })
  await writeFile(join(repository, 'packages', 'gamedev', 'godot', 'src', 'index.ts'), [
    `    webTemplateArchiveUrl: z.string().default('${RELEASE}web-template-9.9-test.tpz'),`,
    `    webTemplateEntry: z.string().default('${ENTRY}'),`,
    `    webTemplateSha256: z.string().pattern(/^[0-9a-f]{64}$/u).default('${sha256(TEMPLATE)}'),`,
  ].join('\n'))
  const local = join(root, 'release')
  await mkdir(local, { recursive: true })
  await writeFile(join(local, 'manifest.json'), JSON.stringify(manifest))
  await writeFile(join(local, 'web_nothreads_release.zip'), file)
  return { repository, local }
}

/** A fetch that serves fixed bodies by URL and records each request's URL and User-Agent. */
function serve(bodies: Readonly<Record<string, string | Buffer>>): { readonly requests: { url: string; agent: string | undefined }[] } {
  const requests: { url: string; agent: string | undefined }[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, agent: (init?.headers as Record<string, string> | undefined)?.['User-Agent'] })
    const body = bodies[url]
    return Promise.resolve(body === undefined ? new Response('missing', { status: 404 }) : new Response(new Uint8Array(Buffer.from(body))))
  })
  return { requests }
}

posix('Web export template staging', () => {
  it('ships the pinned template from a local release folder where the Godot plugin looks before downloading', async () => {
    const { repository, local } = await templateRelease()
    const dsh = await dshTree()
    const shipped = await stageWebTemplate(dsh, { WASD_WEB_TEMPLATE_DIR: local }, repository)
    const plugin = join(dsh, 'node_modules', '@deepseek-ai', 'dsh-godot')
    expect(shipped).toEqual({ sha256: sha256(TEMPLATE), path: join(bundledTemplatesDir(plugin), `${sha256(TEMPLATE)}.zip`) })
    expect(await readFile(shipped!.path)).toEqual(TEMPLATE)
    expect((await stat(shipped!.path)).mode & 0o777).toBe(0o644)
    expect(await readdir(dirname(shipped!.path))).toEqual([`${sha256(TEMPLATE)}.zip`])
  })

  it('downloads the manifest and the template from the release of the pin', async () => {
    const { repository } = await templateRelease()
    const manifest = JSON.stringify({ template: { entry: ENTRY, bytes: TEMPLATE.length, sha256: sha256(TEMPLATE) } })
    const { requests } = serve({ [`${RELEASE}manifest.json`]: manifest, [`${RELEASE}web_nothreads_release.zip`]: TEMPLATE })
    const shipped = await stageWebTemplate(await dshTree(), {}, repository)
    expect(await readFile(shipped!.path)).toEqual(TEMPLATE)
    expect(requests.map(request => request.url)).toEqual([`${RELEASE}manifest.json`, `${RELEASE}web_nothreads_release.zip`])
  })

  it.each([
    ['a manifest that lists another template', { template: { entry: ENTRY, bytes: TEMPLATE.length, sha256: '0'.repeat(64) } }, TEMPLATE, /does not list the Web export template/u],
    ['a manifest without the template size', { template: { entry: ENTRY, sha256: sha256(TEMPLATE) } }, TEMPLATE, /does not list the Web export template/u],
    [
      'a template that differs from the pin', { template: { entry: ENTRY, bytes: TEMPLATE.length, sha256: sha256(TEMPLATE) } },
      Buffer.from('another zip of length 20'.slice(0, TEMPLATE.length)), /does not match the SHA-256 its manifest lists/u,
    ],
  ])('refuses %s and ships nothing', async (_case, manifest, file, message) => {
    const { repository, local } = await templateRelease(manifest, file)
    const dsh = await dshTree()
    await expect(stageWebTemplate(dsh, { WASD_WEB_TEMPLATE_DIR: local }, repository)).rejects.toThrow(message)
    const folder = bundledTemplatesDir(join(dsh, 'node_modules', '@deepseek-ai', 'dsh-godot'))
    expect(await readdir(folder).catch(() => [])).toEqual([])
  })

  it('leaves the template out of an unsigned build that asks to, and stops a signed one', async () => {
    const { repository } = await templateRelease()
    const dsh = await dshTree()
    expect(await stageWebTemplate(dsh, { WASD_WEB_TEMPLATE_BUNDLE: '0', DSH_DESKTOP_UNSIGNED: '1' }, repository)).toBeUndefined()
    await expect(stageWebTemplate(dsh, { WASD_WEB_TEMPLATE_BUNDLE: '0' }, repository)).rejects.toThrow(/a signed build ships the Web export template/u)
  })
})

posix('add-on archive staging', () => {
  it('ships the archives of bundled entries from a local folder where the add-on manager looks before downloading', async () => {
    const local = join(root, 'archives')
    await mkdir(local)
    await writeFile(join(local, `${sha256(PACK)}.zip`), PACK)
    await writeFile(join(local, `${sha256(TOOL)}.zip`), TOOL)
    const dsh = await dshTree()
    const shipped = await stageAddonArchives(dsh, { WASD_ADDON_ARCHIVES: local })
    const folder = bundledArchivesDir(join(dsh, 'node_modules', '@deepseek-ai', 'dsh-game-addons'))
    expect(shipped).toEqual([{ id: 'asset-pack', pin: 'archive', sha256: sha256(PACK), path: join(folder, `${sha256(PACK)}.zip`) }])
    expect(await readdir(folder)).toEqual([`${sha256(PACK)}.zip`])
    expect(await readFile(join(folder, `${sha256(PACK)}.zip`))).toEqual(PACK)
  })

  it('downloads a bundled archive and asset pack as the add-on manager does, with its User-Agent', async () => {
    const assets = Buffer.from('the textures of a Blender add-on')
    const dsh = await dshTree({
      'blender-tool': {
        bundled: true,
        archive: { url: 'https://code.example.test/tool.zip', sha256: sha256(TOOL), bytes: TOOL.length },
        assets: { url: 'https://assets.example.test/textures.zip', sha256: sha256(assets), bytes: assets.length },
      },
    })
    const { requests } = serve({ 'https://code.example.test/tool.zip': TOOL, 'https://assets.example.test/textures.zip': assets })
    const shipped = await stageAddonArchives(dsh, {})
    expect(shipped.map(item => item.pin)).toEqual(['archive', 'assets'])
    expect(requests).toEqual([
      { url: 'https://code.example.test/tool.zip', agent: 'WASD Engine' },
      { url: 'https://assets.example.test/textures.zip', agent: 'WASD Engine' },
    ])
  })

  it('refuses an archive that differs from its entry, and a bundled entry without a complete pin', async () => {
    const local = join(root, 'archives')
    await mkdir(local)
    await writeFile(join(local, `${sha256(PACK)}.zip`), TOOL.subarray(0, PACK.length))
    await expect(stageAddonArchives(await dshTree(), { WASD_ADDON_ARCHIVES: local }))
      .rejects.toThrow(/asset-pack add-on archive .* its catalog entry lists/u)
    await rm(join(root, 'dsh'), { recursive: true })
    const incomplete = await dshTree({ 'asset-pack': { bundled: true, archive: { url: 'https://assets.example.test/pack.zip', bytes: PACK.length } } })
    await expect(stageAddonArchives(incomplete, {})).rejects.toThrow(/sets bundled, but its archive lacks/u)
  })

  it('leaves the archives out of an unsigned build that asks to, and stops a signed one', async () => {
    const dsh = await dshTree()
    expect(await stageAddonArchives(dsh, { WASD_ADDON_ARCHIVES_BUNDLE: '0', DSH_DESKTOP_UNSIGNED: '1' })).toEqual([])
    await expect(stageAddonArchives(dsh, { WASD_ADDON_ARCHIVES_BUNDLE: '0' })).rejects.toThrow(/a signed build ships the bundled add-on archives/u)
  })
})

describe('verified downloads', () => {
  const data = Buffer.from('the bytes of a large archive')
  const url = 'https://archives.example.test/large.zip'

  /** A fetch whose transfers break off after their first bytes, as HTTP/2 streams can, the first `breaks` times. */
  function transfers(breaks: number): { readonly calls: () => number } {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      calls += 1
      if (calls > breaks) return Promise.resolve(new Response(new Uint8Array(data)))
      return Promise.resolve(new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(data.subarray(0, 4)))
          controller.error(new TypeError('terminated'))
        },
      })))
    })
    return { calls: () => calls }
  }

  /** A fetch that answers each call with the next of `answers`, a status or a Response; the last one repeats. */
  function answers(...replies: readonly (number | (() => Response | Promise<Response>))[]): { readonly calls: () => number } {
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      const reply = replies[Math.min(calls, replies.length - 1)]!
      calls += 1
      return Promise.resolve(typeof reply === 'number' ? new Response('busy', { status: reply }) : reply())
    })
    return { calls: () => calls }
  }

  const pin = { url, bytes: data.length, sha256: sha256(data) }
  const quick = { retryDelayMs: 0 }

  it('starts a transfer that breaks off over, up to three attempts in all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const twice = transfers(2)
    await downloadVerified(url, join(root, 'third.zip'), pin, 'test', quick)
    expect(await readFile(join(root, 'third.zip'))).toEqual(data)
    expect(twice.calls()).toBe(3)
    vi.mocked(globalThis.fetch).mockRestore()
    const always = transfers(3)
    await expect(downloadVerified(url, join(root, 'never.zip'), pin, 'test', quick)).rejects.toThrow(/terminated/u)
    expect(always.calls()).toBe(3)
  })

  it('tries again after a transient HTTP status, and stops at once at another', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const busy = answers(503, 429, () => new Response(new Uint8Array(data)))
    await downloadVerified(url, join(root, 'busy.zip'), pin, 'test', quick)
    expect(await readFile(join(root, 'busy.zip'))).toEqual(data)
    expect(busy.calls()).toBe(3)
    expect(warn.mock.calls[0]?.[0]).toMatch(/answered HTTP 503\); starting over, attempt 2 of 3/u)
    vi.mocked(globalThis.fetch).mockRestore()
    const down = answers(502)
    await expect(downloadVerified(url, join(root, 'down.zip'), pin, 'test', quick)).rejects.toThrow(/answered HTTP 502/u)
    expect(down.calls()).toBe(3)
    vi.mocked(globalThis.fetch).mockRestore()
    const missing = answers(404)
    await expect(downloadVerified(url, join(root, 'missing.zip'), pin, 'test', quick)).rejects.toThrow(/answered HTTP 404/u)
    expect(missing.calls()).toBe(1)
  })

  it('gives up on a response or transfer that stalls, and starts it over', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const silent = vi.spyOn(globalThis, 'fetch')
    /** A response that sends a few bytes and then nothing more. */
    const stalled = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(data.subarray(0, 4))) },
    }))
    let calls = 0
    silent.mockImplementation((_input, init) => {
      calls += 1
      // The first call never answers until the attempt gives up, and the second stalls after its first bytes.
      if (calls === 1) return new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }) })
      return Promise.resolve(calls === 2 ? stalled() : new Response(new Uint8Array(data)))
    })
    await downloadVerified(url, join(root, 'stalled.zip'), pin, 'test', { ...quick, stallMs: 50 })
    expect(await readFile(join(root, 'stalled.zip'))).toEqual(data)
    expect(calls).toBe(3)
    // A server that never answers fails the download after three attempts.
    silent.mockReset()
    silent.mockImplementation((_input, init) => new Promise((_resolve, reject) => { init!.signal!.addEventListener('abort', () => { reject(new Error('aborted')) }) }))
    await expect(downloadVerified(url, join(root, 'quiet.zip'), pin, 'test', { ...quick, stallMs: 50 }))
      .rejects.toThrow('desktop runtime: downloading the test archive https://archives.example.test/large.zip stalled: nothing arrived for 50 ms')
    expect(silent).toHaveBeenCalledTimes(3)
  })

  it('stops at once at bytes that differ from the pin', async () => {
    const whole = transfers(0)
    await expect(downloadVerified(url, join(root, 'other.zip'), { ...pin, sha256: '0'.repeat(64) }, 'test', { pinnedBy: 'its pin' }))
      .rejects.toThrow(/does not match the SHA-256 its pin lists/u)
    expect(whole.calls()).toBe(1)
  })
})

describe('bundled file packaging hooks', () => {
  it('keeps the shipped template and archives outside app.asar, in the folders the plugins read, in the ordinary release entry', async () => {
    expect(applyWasdengineBundledFiles({ asarUnpack: ['first'] })).toEqual({ asarUnpack: ['first', ...BUNDLED_FILES_ASAR_UNPACK] })
    const folder = (path: string) => path.split(/[\\/]/u).at(-1)
    expect(BUNDLED_FILES_ASAR_UNPACK).toEqual([
      `**/node_modules/@deepseek-ai/dsh-godot/${folder(bundledTemplatesDir(root))}/**/*`,
      `**/node_modules/@deepseek-ai/dsh-game-addons/${folder(bundledArchivesDir(root))}/**/*`,
    ])
    const environment = { ...localMacOSPackageEnvironment({}), DSH_DESKTOP_TARGET_PLATFORM: 'darwin', DSH_DESKTOP_TARGET_ARCH: 'arm64' }
    for (const [name, value] of Object.entries(environment)) if (value !== undefined) vi.stubEnv(name, value)
    try {
      const { default: createReleaseConfig } = await import('../electron-builder.config.mjs')
      expect(createReleaseConfig().asarUnpack).toEqual(expect.arrayContaining([...BUNDLED_FILES_ASAR_UNPACK]))
    } finally { vi.unstubAllEnvs() }
  })

  it('stages both before prepare-dsh signs the dsh tree and writes its runtime descriptor', async () => {
    const prepare = await readFile(new URL('../scripts/prepare-dsh.ts', import.meta.url), 'utf8')
    for (const step of ["'runtime:web-template', () => stageWebTemplate(DSH_OUTPUT_ROOT)", "'runtime:addon-archives', () => stageAddonArchives(DSH_OUTPUT_ROOT)"]) {
      const at = prepare.indexOf(step)
      expect(at, step).toBeGreaterThan(prepare.indexOf("'runtime:materialize-modules'"))
      expect(at, step).toBeLessThan(prepare.indexOf("'sign:dsh-native'"))
      expect(at, step).toBeLessThan(prepare.indexOf("'runtime:write-descriptor'"))
    }
  })
})
