/**
 * Check that the Web export template that the Godot plugin pins can be downloaded, so that no Desktop release ships a
 * plugin whose Web exports fail at the template download (fork-owned; `wasdengine/FORK.md`, Releases).
 *
 * The `webTemplateArchiveUrl`, `webTemplateEntry`, and `webTemplateSha256` defaults of
 * `packages/gamedev/godot/src/index.ts` name a file of the GitHub release `web-template-<version>`, which
 * `.github/workflows/wasd-web-template.yml` publishes with a `manifest.json` once it has checked the archive against
 * the manifest and the template against the pin. Desktop builds do not bundle the template, so packaging never notices
 * a missing release. `wasdengine-github-release.ts publish` and `.github/workflows/wasd-desktop-windows.yml` run this
 * check; the workflow imports this module with plain Node before it installs dependencies, so the module imports only
 * Node's built-in modules.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

/** Path, relative to the repository root, of the Godot plugin source whose config defaults pin the Web template. */
export const GODOT_PLUGIN_SOURCE = 'packages/gamedev/godot/src/index.ts'

const TEMPLATE_WORKFLOW = '.github/workflows/wasd-web-template.yml'
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const SHA256 = /^[0-9a-f]{64}$/u
/** URL of a file of a GitHub release; captures the repository and the release tag. */
const RELEASE_FILE = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/[^/]+$/u
const run = promisify(execFile)

/** The Web export template that the Godot plugin's config defaults pin. */
export interface WebTemplatePin {
  /** `webTemplateArchiveUrl`: the export templates archive that a Web export downloads. */
  readonly archiveUrl: string
  /** `webTemplateEntry`: the template's path in the archive. */
  readonly entry: string
  /** `webTemplateSha256`: the SHA-256 that the template must have. */
  readonly sha256: string
}

/** Fetches one URL and follows its redirects, as the global `fetch` does. */
export type FetchUrl = (url: string) => Promise<Response>

function configDefault(source: string, path: string, key: string): string {
  const value = new RegExp(String.raw`\b${key}: z\.string\(\)[^\n]*?\.default\('([^'\n]+)'\)`, 'u').exec(source)?.[1]
  if (value === undefined) throw new Error(`Web template: ${path} has no ${key} default`)
  return value
}

/**
 * Read the Web template pin from the Godot plugin source, as `wasdengine/web-template/template.py pin` reads its
 * `webTemplateSha256`.
 * @param source - Text of `packages/gamedev/godot/src/index.ts`.
 * @param path - Where the text came from, for errors.
 * @returns The archive URL, the template entry, and the template SHA-256 that the plugin's config defaults name.
 * @throws When the text lacks one of the three defaults, or the `webTemplateSha256` default is not a SHA-256.
 */
export function readWebTemplatePin(source: string, path: string = GODOT_PLUGIN_SOURCE): WebTemplatePin {
  const sha256 = configDefault(source, path, 'webTemplateSha256')
  if (!SHA256.test(sha256)) throw new Error(`Web template: the webTemplateSha256 default of ${path} is not a SHA-256`)
  return { archiveUrl: configDefault(source, path, 'webTemplateArchiveUrl'), entry: configDefault(source, path, 'webTemplateEntry'), sha256 }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * List what keeps the pinned Web template from downloading as a Web export downloads it: a template release that is
 * missing or still a draft, whose files GitHub serves to nobody; a `manifest.json` that names another archive URL,
 * template entry, or template SHA-256 than the pin; and an archive whose size or SHA-256 differs from the manifest's.
 * `wasd-web-template.yml` checks the template in the archive against the manifest before it publishes, so an archive
 * that matches the manifest holds the pinned template.
 * @param pin - The pin that {@link readWebTemplatePin} read.
 * @param fetchUrl - Fetches a URL; defaults to the global `fetch`.
 * @returns Problems, empty when the template downloads as pinned.
 */
export async function webTemplateReleaseProblems(pin: WebTemplatePin, fetchUrl: FetchUrl = fetch): Promise<string[]> {
  const file = RELEASE_FILE.exec(pin.archiveUrl)
  const repository = file?.[1]
  const tag = file?.[2]
  if (repository === undefined || tag === undefined) {
    return [`the Godot plugin's webTemplateArchiveUrl ${pin.archiveUrl} is not a file of a GitHub release, whose manifest.json this check reads`]
  }
  const manifestUrl = `https://github.com/${repository}/releases/download/${tag}/manifest.json`
  const manifest = await fetchUrl(manifestUrl)
  if (!manifest.ok) {
    await manifest.body?.cancel()
    return [
      `the Web template release ${tag} that the Godot plugin pins is missing or still a draft: ${manifestUrl} answered HTTP ${String(manifest.status)}. `
      + `Run ${TEMPLATE_WORKFLOW} on main with version ${tag.replace(/^web-template-/u, '')}; it publishes only a build whose template has `
      + `the pinned SHA-256 ${pin.sha256} (wasdengine/FORK.md, Releases)`,
    ]
  }
  let value: unknown
  try {
    value = JSON.parse(await manifest.text())
  } catch (error) {
    return [`${manifestUrl} is not JSON: ${error instanceof Error ? error.message : String(error)}`]
  }
  const template = isRecord(value) ? value.template : undefined
  const archive = isRecord(value) ? value.archive : undefined
  if (!isRecord(template) || typeof template.entry !== 'string' || typeof template.sha256 !== 'string'
    || !isRecord(archive) || typeof archive.url !== 'string' || typeof archive.bytes !== 'number' || typeof archive.sha256 !== 'string') {
    return [`${manifestUrl} lacks the template's entry and SHA-256 or the archive's URL, size, and SHA-256`]
  }
  const problems: string[] = []
  if (archive.url !== pin.archiveUrl) problems.push(`${manifestUrl} names the archive ${archive.url}, but the Godot plugin downloads ${pin.archiveUrl}`)
  if (template.entry !== pin.entry) problems.push(`${manifestUrl} names the template ${template.entry}, but the Godot plugin reads ${pin.entry}`)
  if (template.sha256 !== pin.sha256) {
    problems.push(`${tag} holds the template ${template.sha256}, but the Godot plugin pins ${pin.sha256}; a published template never changes, `
      + 'so pin that template, or publish a new template version and pin it')
  }
  const download = await fetchUrl(pin.archiveUrl)
  if (!download.ok) {
    await download.body?.cancel()
    problems.push(`${pin.archiveUrl} answered HTTP ${String(download.status)}`)
    return problems
  }
  const data = new Uint8Array(await download.arrayBuffer())
  const digest = createHash('sha256').update(data).digest('hex')
  if (data.byteLength !== archive.bytes || digest !== archive.sha256) {
    problems.push(`${pin.archiveUrl} has ${String(data.byteLength)} bytes with the SHA-256 ${digest}, `
      + `but ${manifestUrl} lists ${String(archive.bytes)} bytes with ${archive.sha256}`)
  }
  return problems
}

/** Where {@link pinnedWebTemplateProblems} reads the Godot plugin source, and how it fetches. */
export interface PinnedWebTemplateOptions {
  /** Commit whose plugin source `git show` reads; the working tree's file when absent. */
  readonly commit?: string
  /** Repository root; defaults to this checkout's. */
  readonly root?: string
  /** Fetches a URL; defaults to the global `fetch`. */
  readonly fetchUrl?: FetchUrl
}

/**
 * Check the Web template that this repository's Godot plugin pins, at a commit or in the working tree, as
 * {@link webTemplateReleaseProblems} does.
 * @param options - Commit, repository root, and fetch.
 * @returns Problems, empty when the template downloads as pinned.
 * @throws When the plugin source cannot be read, as for a commit that the clone lacks, or it holds no pin.
 */
export async function pinnedWebTemplateProblems(options: PinnedWebTemplateOptions = {}): Promise<string[]> {
  const root = options.root ?? REPOSITORY_ROOT
  const { commit } = options
  if (commit === undefined) {
    return await webTemplateReleaseProblems(readWebTemplatePin(await readFile(join(root, GODOT_PLUGIN_SOURCE), 'utf8')), options.fetchUrl)
  }
  const path = `${commit}:${GODOT_PLUGIN_SOURCE}`
  let source: string
  try {
    source = (await run('git', ['show', path], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true })).stdout
  } catch (error) {
    throw new Error(`Web template: git show ${path} failed; fetch that commit first`, { cause: error })
  }
  return await webTemplateReleaseProblems(readWebTemplatePin(source, path), options.fetchUrl)
}
