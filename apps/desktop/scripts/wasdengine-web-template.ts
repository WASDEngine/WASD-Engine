/**
 * Ship the Web export template that the Godot plugin pins with the Desktop app (fork-owned; `wasdengine/FORK.md`
 * lists the fork changes), so that no Web export, a game release's included, downloads it. Before `prepare-dsh.ts`
 * signs the prepared dsh tree and writes its runtime descriptor, `stageWebTemplate` puts the template that the
 * plugin's `webTemplateArchiveUrl`, `webTemplateEntry`, and `webTemplateSha256` defaults pin into
 * `@deepseek-ai/dsh-godot`'s `templates/` folder as `<sha256>.zip`, the name under which the plugin's template manager
 * finds it before downloading, and `applyWasdengineBundledFiles` in `wasdengine-builder-config.mjs` keeps that folder
 * outside `app.asar`, where Godot reads the template by path.
 *
 * The template comes from the release of the pin: `.github/workflows/wasd-web-template.yml` publishes the template
 * file beside the archive, with a `manifest.json` whose `template` lists the entry, size, and SHA-256, which must equal
 * the pin's.
 *
 * Environment: `WASD_WEB_TEMPLATE_DIR` names a local folder holding the release's `manifest.json` and template file;
 * `WASD_WEB_TEMPLATE_BUNDLE=0` packages an unsigned build without the template, whose first Web export then downloads
 * it, and stops a signed build.
 */
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, posix, resolve } from 'node:path'
import { copyVerified, downloadVerified, isRecord } from './wasdengine-runtime-archive.ts'
import { GODOT_PLUGIN_SOURCE, readWebTemplatePin } from './wasdengine-web-template-release.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const LABEL = 'Web export template'
const REMEDY = 'Run .github/workflows/wasd-web-template.yml on main for the pinned version, or pin a published template (wasdengine/FORK.md, Releases).'

/** The Web export template that a prepared tree ships. */
export interface ShippedWebTemplate {
  /** SHA-256 of the template, which names its file. */
  readonly sha256: string
  /** Absolute path of the template in the prepared tree. */
  readonly path: string
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

/** The release manifest, from its URL or from a local release folder. */
async function readManifest(source: string, local: boolean): Promise<unknown> {
  if (local) {
    try {
      return JSON.parse(await readFile(source, 'utf8'))
    } catch (error) {
      throw new Error(`desktop runtime: cannot read the ${LABEL} manifest ${source}. ${REMEDY}`, { cause: error })
    }
  }
  let response: Response
  try {
    response = await fetch(source)
  } catch (error) {
    throw new Error(`desktop runtime: cannot reach the ${LABEL} manifest ${source}: ${(error as Error).message}. ${REMEDY}`, { cause: error })
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`desktop runtime: the ${LABEL} manifest ${source} answered HTTP ${String(response.status)}. ${REMEDY}`)
  }
  return response.json()
}

/**
 * Put the Web export template that the Godot plugin pins into the plugin package of the prepared dsh tree.
 * @param dshRoot - Prepared dsh tree, before signing and the runtime descriptor.
 * @param env - Environment that selects the template's source, whether to ship it, and whether the build is signed.
 * @param root - Repository root whose Godot plugin source holds the pin.
 * @returns The shipped template, or undefined when `WASD_WEB_TEMPLATE_BUNDLE=0` leaves it out of an unsigned build.
 * @throws When a signed build would leave it out, the manifest differs from the pin, the tree has no Godot plugin
 * package, or the template differs from the pin.
 */
export async function stageWebTemplate(
  dshRoot: string, env: NodeJS.ProcessEnv = process.env, root: string = REPOSITORY_ROOT,
): Promise<ShippedWebTemplate | undefined> {
  if (env.WASD_WEB_TEMPLATE_BUNDLE === '0') {
    if (env.DSH_DESKTOP_UNSIGNED !== '1') {
      throw new Error('desktop runtime: a signed build ships the Web export template, but WASD_WEB_TEMPLATE_BUNDLE=0 leaves it out. Unset WASD_WEB_TEMPLATE_BUNDLE to package it.')
    }
    console.log('desktop runtime: WASD_WEB_TEMPLATE_BUNDLE=0, so this unsigned build ships without the Web export template, which its first Web export downloads')
    return undefined
  }
  const pin = readWebTemplatePin(await readFile(join(root, GODOT_PLUGIN_SOURCE), 'utf8'))
  const releaseFolder = new URL('.', pin.archiveUrl)
  const file = posix.basename(pin.entry)
  const local = env.WASD_WEB_TEMPLATE_DIR ?? ''
  const source = local === '' ? new URL('manifest.json', releaseFolder).href : join(local, 'manifest.json')
  const manifest = await readManifest(source, local !== '')
  const template = isRecord(manifest) ? manifest.template : undefined
  const bytes = isRecord(template) ? template.bytes : undefined
  if (!isRecord(template) || template.entry !== pin.entry || template.sha256 !== pin.sha256
    || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`desktop runtime: ${source} does not list the ${LABEL} ${pin.entry} with the SHA-256 ${pin.sha256} that the Godot plugin pins, and its size. ${REMEDY}`)
  }
  const pluginRoot = join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh-godot')
  if (!await isFileAt(join(pluginRoot, 'package.json'))) {
    throw new Error(`desktop runtime: the dsh tree has no @deepseek-ai/dsh-godot package to ship the ${LABEL} in`)
  }
  const folder = join(pluginRoot, 'templates')
  await mkdir(folder, { recursive: true })
  const destination = join(folder, `${pin.sha256}.zip`)
  const staging = join(folder, `.staging-${randomUUID()}.zip`)
  const artifact = { url: new URL(file, releaseFolder).href, bytes, sha256: pin.sha256 }
  try {
    if (local === '') await downloadVerified(artifact.url, staging, artifact, LABEL)
    else await copyVerified(createReadStream(join(local, file)), staging, artifact, join(local, file), LABEL)
    await chmod(staging, 0o644)
    await rename(staging, destination)
  } finally {
    await rm(staging, { force: true })
  }
  console.log(`desktop runtime: shipping the ${LABEL} ${pin.sha256} (${String(bytes)} bytes)`)
  return { sha256: pin.sha256, path: destination }
}
