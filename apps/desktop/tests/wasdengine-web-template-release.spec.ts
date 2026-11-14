/**
 * WASDEngine fork guard for the Web template check of Desktop releases: the pin comes from the Godot plugin's config
 * defaults, at a commit or in the working tree, and a template release that is missing, still a draft, or different
 * from the pin is reported (`apps/desktop/scripts/wasdengine-web-template-release.ts`).
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GODOT_PLUGIN_SOURCE, pinnedWebTemplateProblems, readWebTemplatePin, webTemplateReleaseProblems, type FetchUrl, type WebTemplatePin,
} from '../scripts/wasdengine-web-template-release.ts'

const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')
const RELEASE = 'https://github.com/WASDEngine/WASD-Engine/releases/download/web-template-9.9.9-wasd.1/'
const MANIFEST = `${RELEASE}manifest.json`
const ARCHIVE = 'archive bytes'
const PIN: WebTemplatePin = { archiveUrl: `${RELEASE}web-template-9.9.9-wasd.1.tpz`, entry: 'templates/web_nothreads_release.zip', sha256: 'c'.repeat(64) }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** A `manifest.json` as `wasd-web-template.yml` publishes it, for the archive `ARCHIVE` holding the pinned template. */
function manifest(changes: { readonly template?: Record<string, unknown>; readonly archive?: Record<string, unknown> } = {}): string {
  return JSON.stringify({
    version: '9.9.9-wasd.1',
    godot: '4.7.2-stable',
    emscripten: '4.0.20',
    template: { entry: PIN.entry, bytes: 10, sha256: PIN.sha256, ...changes.template },
    archive: { url: PIN.archiveUrl, bytes: Buffer.byteLength(ARCHIVE), sha256: sha256(ARCHIVE), ...changes.archive },
  })
}

/** Serves the given files by URL and answers 404, as GitHub does for a draft's files, for every other URL. */
function releaseFiles(files: Readonly<Record<string, string>>): { readonly fetchUrl: FetchUrl; readonly fetched: string[] } {
  const fetched: string[] = []
  const fetchUrl: FetchUrl = async (url) => {
    fetched.push(url)
    const body = files[url]
    return body === undefined ? new Response('Not Found', { status: 404 }) : new Response(body)
  }
  return { fetchUrl, fetched }
}

/** The config default lines of the Godot plugin that pin a template. */
function pluginSource(pin: WebTemplatePin): string {
  return [
    `    webTemplateArchiveUrl: z.string().default('${pin.archiveUrl}'),`,
    `    webTemplateEntry: z.string().default('${pin.entry}'),`,
    `    webTemplateSha256: z.string().pattern(/^[0-9a-f]{64}$/u).default('${pin.sha256}'),`,
    '',
  ].join('\n')
}

describe('Web template release check', () => {
  it('reads the pin from the Godot plugin\'s config defaults and refuses a source without one', () => {
    const source = readFileSync(join(REPOSITORY_ROOT, GODOT_PLUGIN_SOURCE), 'utf8')
    const pin = readWebTemplatePin(source)
    const releaseArchive = /^https:\/\/github\.com\/WASDEngine\/WASD-Engine\/releases\/download\/(web-template-[^/]+)\/\1\.tpz$/u
    expect(pin.archiveUrl).toMatch(releaseArchive)
    expect(pin.entry).toBe('templates/web_nothreads_release.zip')
    expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(readWebTemplatePin(pluginSource(PIN))).toEqual(PIN)
    expect(() => readWebTemplatePin(source.replace('webTemplateEntry: z.string()', 'webTemplateFile: z.string()'), 'index.ts'))
      .toThrow('index.ts has no webTemplateEntry default')
    expect(() => readWebTemplatePin(source.replace(pin.sha256, 'not-a-digest'))).toThrow('the webTemplateSha256 default of packages/gamedev/godot/src/index.ts is not a SHA-256')
  })

  it('reports nothing when the release holds the pinned template, after reading its manifest and archive', async () => {
    const release = releaseFiles({ [MANIFEST]: manifest(), [PIN.archiveUrl]: ARCHIVE })
    await expect(webTemplateReleaseProblems(PIN, release.fetchUrl)).resolves.toEqual([])
    expect(release.fetched).toEqual([MANIFEST, PIN.archiveUrl])
  })

  it('reports a template release that is missing or still a draft, with the workflow that publishes it', async () => {
    const problems = await webTemplateReleaseProblems(PIN, releaseFiles({}).fetchUrl)
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain(`web-template-9.9.9-wasd.1 that the Godot plugin pins is missing or still a draft: ${MANIFEST} answered HTTP 404`)
    expect(problems[0]).toContain(`.github/workflows/wasd-web-template.yml on main with version 9.9.9-wasd.1; it publishes only a build whose template has the pinned SHA-256 ${PIN.sha256}`)
  })

  it('reports a manifest and an archive that differ from the pin', async () => {
    const other = 'd'.repeat(64)
    const release = releaseFiles({
      [MANIFEST]: manifest({ template: { entry: 'templates/web_release.zip', sha256: other }, archive: { url: `${RELEASE}other.tpz` } }),
      [PIN.archiveUrl]: 'other archive bytes',
    })
    expect(await webTemplateReleaseProblems(PIN, release.fetchUrl)).toEqual([
      `${MANIFEST} names the archive ${RELEASE}other.tpz, but the Godot plugin downloads ${PIN.archiveUrl}`,
      `${MANIFEST} names the template templates/web_release.zip, but the Godot plugin reads ${PIN.entry}`,
      `web-template-9.9.9-wasd.1 holds the template ${other}, but the Godot plugin pins ${PIN.sha256}; a published template never changes, `
      + 'so pin that template, or publish a new template version and pin it',
      `${PIN.archiveUrl} has 19 bytes with the SHA-256 ${sha256('other archive bytes')}, `
      + `but ${MANIFEST} lists ${String(Buffer.byteLength(ARCHIVE))} bytes with ${sha256(ARCHIVE)}`,
    ])
  })

  it('reports an archive that does not download, a manifest that is not one, and an archive outside GitHub releases', async () => {
    expect(await webTemplateReleaseProblems(PIN, releaseFiles({ [MANIFEST]: manifest() }).fetchUrl)).toEqual([`${PIN.archiveUrl} answered HTTP 404`])
    expect(await webTemplateReleaseProblems(PIN, releaseFiles({ [MANIFEST]: 'not json' }).fetchUrl)).toEqual([expect.stringContaining(`${MANIFEST} is not JSON: `)])
    expect(await webTemplateReleaseProblems(PIN, releaseFiles({ [MANIFEST]: '{"template":{}}' }).fetchUrl))
      .toEqual([`${MANIFEST} lacks the template's entry and SHA-256 or the archive's URL, size, and SHA-256`])
    expect(await webTemplateReleaseProblems({ ...PIN, archiveUrl: 'https://example.com/web-template.tpz' }, releaseFiles({}).fetchUrl))
      .toEqual(['the Godot plugin\'s webTemplateArchiveUrl https://example.com/web-template.tpz is not a file of a GitHub release, whose manifest.json this check reads'])
  })

  it('checks the pin of a commit or of the working tree, and refuses a commit that the clone lacks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wasd-web-template-release-'))
    roots.push(root)
    const source = join(root, GODOT_PLUGIN_SOURCE)
    mkdirSync(dirname(source), { recursive: true })
    writeFileSync(source, pluginSource(PIN))
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    git('init', '--quiet')
    git('add', '.')
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Pin the template')
    const commit = git('rev-parse', 'HEAD')
    writeFileSync(source, pluginSource({ ...PIN, sha256: 'e'.repeat(64) }))
    const files = { [MANIFEST]: manifest(), [PIN.archiveUrl]: ARCHIVE }
    await expect(pinnedWebTemplateProblems({ commit, root, fetchUrl: releaseFiles(files).fetchUrl })).resolves.toEqual([])
    await expect(pinnedWebTemplateProblems({ root, fetchUrl: releaseFiles(files).fetchUrl }))
      .resolves.toEqual([expect.stringContaining(`but the Godot plugin pins ${'e'.repeat(64)}`)])
    await expect(pinnedWebTemplateProblems({ commit: 'f'.repeat(40), root, fetchUrl: releaseFiles(files).fetchUrl }))
      .rejects.toThrow(`git show ${'f'.repeat(40)}:${GODOT_PLUGIN_SOURCE} failed; fetch that commit first`)
  })
})
