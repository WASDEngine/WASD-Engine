/**
 * Ship the archives of the add-on catalog's bundled entries with the Desktop app (fork-owned; `wasdengine/FORK.md`
 * lists the fork changes), so that installing one of them downloads nothing. Before `prepare-dsh.ts` signs the
 * prepared dsh tree and writes its runtime descriptor, `stageAddonArchives` reads the catalog of the tree's
 * `@deepseek-ai/dsh-web-app` package and puts the archive and asset pack of every entry whose `addon.json` sets
 * `"bundled": true` into `@deepseek-ai/dsh-game-addons`'s `archives/` folder as `<sha256>.zip`, the name under which
 * the add-on manager reads an archive before downloading it, and `applyWasdengineBundledFiles` in
 * `wasdengine-builder-config.mjs` keeps that folder outside `app.asar`. Each file must have the size and SHA-256 that
 * its entry pins.
 *
 * Environment: `WASD_ADDON_ARCHIVES` names a local folder of archives named `<sha256>.zip`, as the catalog's
 * end-to-end suite keeps them, which replaces the download of each archive it holds; `WASD_ADDON_ARCHIVES_BUNDLE=0`
 * packages an unsigned build without them, whose installs then download them, and stops a signed build.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { copyVerified, downloadVerified, isRecord } from './wasdengine-runtime-archive.ts'

const SHA256 = /^[0-9a-f]{64}$/u
/** Request headers of the downloads, as the add-on manager sends them; some archive hosts refuse requests without a User-Agent. */
const HEADERS = { 'User-Agent': 'WASD Engine' }
/** What pins an add-on archive's size and SHA-256, as the errors name it. */
const PINNED_BY = 'its catalog entry'

/** One archive that a prepared tree ships. */
export interface ShippedAddonArchive {
  /** Catalog id of the entry. */
  readonly id: string
  /** Which pin of the entry: its `archive` or its asset pack, `assets`. */
  readonly pin: 'archive' | 'assets'
  /** SHA-256 of the archive, which names its file. */
  readonly sha256: string
  /** Absolute path of the archive in the prepared tree. */
  readonly path: string
}

/** A pinned archive of a bundled entry. */
interface BundledPin {
  readonly id: string
  readonly pin: 'archive' | 'assets'
  readonly url: string
  readonly sha256: string
  readonly bytes: number
}

async function isFileAt(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

/** The archive and asset pack pins of the catalog's bundled entries, in catalog folder order. */
async function bundledPins(catalog: string): Promise<BundledPin[]> {
  const pins: BundledPin[] = []
  const folders = (await readdir(catalog, { withFileTypes: true })).filter(item => item.isDirectory()).map(item => item.name).sort()
  for (const folder of folders) {
    const path = join(catalog, folder, 'addon.json')
    if (!await isFileAt(path)) continue
    const entry: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!isRecord(entry) || entry.bundled !== true) continue
    for (const pin of ['archive', 'assets'] as const) {
      const value = entry[pin]
      if (value === undefined) continue
      if (!isRecord(value) || typeof value.url !== 'string' || !value.url.startsWith('https://') || typeof value.sha256 !== 'string'
        || !SHA256.test(value.sha256) || typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes <= 0) {
        throw new Error(`desktop runtime: ${path} sets bundled, but its ${pin} lacks an https URL, a SHA-256, or a size`)
      }
      pins.push({ id: folder, pin, url: value.url, sha256: value.sha256, bytes: value.bytes })
    }
  }
  return pins
}

/**
 * Put the archives of the catalog's bundled entries into the add-on plugin package of the prepared dsh tree.
 * @param dshRoot - Prepared dsh tree, before signing and the runtime descriptor.
 * @param env - Environment that selects local archives, whether to ship them, and whether the build is signed.
 * @returns The shipped archives, empty when `WASD_ADDON_ARCHIVES_BUNDLE=0` leaves them out of an unsigned build.
 * @throws When a signed build would leave them out, the tree lacks the catalog or the add-on plugin package, a bundled
 * entry's pin is incomplete, or an archive differs from its pin.
 */
export async function stageAddonArchives(dshRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<ShippedAddonArchive[]> {
  if (env.WASD_ADDON_ARCHIVES_BUNDLE === '0') {
    if (env.DSH_DESKTOP_UNSIGNED !== '1') {
      throw new Error('desktop runtime: a signed build ships the bundled add-on archives, but WASD_ADDON_ARCHIVES_BUNDLE=0 leaves them out. Unset WASD_ADDON_ARCHIVES_BUNDLE to package them.')
    }
    console.log('desktop runtime: WASD_ADDON_ARCHIVES_BUNDLE=0, so this unsigned build ships without the bundled add-on archives, which installs download')
    return []
  }
  const modules = join(dshRoot, 'node_modules', '@deepseek-ai')
  const catalog = join(modules, 'dsh-web-app', 'wasdengine', 'addons')
  let pins: BundledPin[]
  try {
    pins = await bundledPins(catalog)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`desktop runtime: the dsh tree has no add-on catalog at ${catalog}`, { cause: error })
    throw error
  }
  const pluginRoot = join(modules, 'dsh-game-addons')
  if (!await isFileAt(join(pluginRoot, 'package.json'))) {
    throw new Error('desktop runtime: the dsh tree has no @deepseek-ai/dsh-game-addons package to ship the add-on archives in')
  }
  const folder = join(pluginRoot, 'archives')
  await mkdir(folder, { recursive: true })
  const local = env.WASD_ADDON_ARCHIVES ?? ''
  const shipped: ShippedAddonArchive[] = []
  for (const pin of pins) {
    const destination = join(folder, `${pin.sha256}.zip`)
    const label = pin.pin === 'archive' ? `${pin.id} add-on` : `${pin.id} add-on's asset pack`
    if (!shipped.some(item => item.sha256 === pin.sha256)) {
      const staging = join(folder, `.staging-${randomUUID()}.zip`)
      try {
        const cached = local === '' ? '' : join(local, `${pin.sha256}.zip`)
        if (cached !== '' && await isFileAt(cached)) await copyVerified(createReadStream(cached), staging, pin, cached, label, PINNED_BY)
        else await downloadVerified(pin.url, staging, pin, label, { headers: HEADERS, pinnedBy: PINNED_BY })
        await chmod(staging, 0o644)
        await rename(staging, destination)
      } finally {
        await rm(staging, { force: true })
      }
      console.log(`desktop runtime: shipping the ${label} archive (${String(pin.bytes)} bytes)`)
    }
    shipped.push({ id: pin.id, pin: pin.pin, sha256: pin.sha256, path: destination })
  }
  if (pins.length === 0) console.log('desktop runtime: no add-on catalog entry is bundled, so the app ships no add-on archive')
  return shipped
}
