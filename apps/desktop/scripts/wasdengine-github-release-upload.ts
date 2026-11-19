/**
 * Upload the staged release files of one Desktop target to the GitHub release `v<version>` (fork-owned;
 * `wasdengine/FORK.md`, Releases). It imports nothing but Node's own modules and the brand constants, so `node` runs it
 * as it is: the Windows workflow's publish job, the only job that holds a token that may write releases, installs no
 * package and runs no build.
 *
 * `wasdengine-github-release.ts stage` writes the files and `staged.json`, which names them; this module's command,
 * `node apps/desktop/scripts/wasdengine-github-release-upload.ts <staged folder> [--published] [--allow-dirty]`, uploads
 * them as `wasdengine-github-release.ts upload` does. The release is created as a draft when it does not exist, and a
 * published release takes no new file without `--published`: the repository's releases are immutable once published.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { WASDENGINE_DESKTOP_BRAND as BRAND } from '../src/wasdengine-brand.ts'

const run = promisify(execFile)
const REPOSITORY_ROOT = resolve(import.meta.dirname, '..', '..', '..')

/** Name of the checksum file of a release, in `sha256sum` format. */
export const SHA256SUMS = 'SHA256SUMS'

/** Name of the file in a staged folder that lists the release files staged there. */
export const STAGED_RELEASE = 'staged.json'

/**
 * Desktop targets the GitHub feed serves. The feed holds one `stable-mac.yml`, so a second macOS architecture would
 * need its files merged into that one feed file, which staging does not do.
 */
export type GitHubReleaseTarget = 'mac-arm64' | 'win-x64'

/** A packaged target's release files, staged for upload. */
export interface StagedRelease {
  readonly version: string
  readonly target: GitHubReleaseTarget
  readonly directory: string
  /** Installers and blockmaps, uploaded before the feed files. */
  readonly files: readonly string[]
  /** The stable feed file and its nightly copy. */
  readonly feeds: readonly string[]
  /** Commit the build was packaged from, as its release record names it. */
  readonly commit: string | undefined
  /** Whether the checkout had uncommitted changes when the build was packaged. */
  readonly dirty: boolean
}

/** One asset of a GitHub release. */
export interface ReleaseAsset {
  readonly name: string
  readonly size: number
}

/** Runs one `gh` command and returns its standard output. */
export type GhRunner = (args: readonly string[]) => Promise<string>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Compute a file's digest.
 * @param path - File to read.
 * @param algorithm - Hash algorithm.
 * @param encoding - Encoding of the digest.
 * @returns The digest.
 */
export async function fileDigest(path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
  const digest = createHash(algorithm)
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest(encoding)
}

/**
 * Merge the checksum lines of some release files into a `sha256sum` file.
 * @param existing - Current SHA256SUMS text, or an empty string.
 * @param digests - SHA-256 by file name; each replaces that file's line.
 * @returns Sorted lines, ending with a newline.
 * @throws When the existing text has a line that is not `<sha256>  <name>`.
 */
export function mergeSha256Sums(existing: string, digests: ReadonlyMap<string, string>): string {
  const lines = new Map<string, string>()
  for (const line of existing.split('\n')) {
    if (line.trim() === '') continue
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) throw new Error(`github release: ${SHA256SUMS} has an invalid line: ${line}`)
    lines.set(match[2], match[1])
  }
  for (const [name, digest] of digests) lines.set(name, digest)
  return `${[...lines].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([name, digest]) => `${digest}  ${name}`).join('\n')}\n`
}

function commandError(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() !== '') return error.stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

/** `gh` on the PATH, with its own sign-in or `GH_TOKEN`. */
export const gh: GhRunner = async (args) => {
  try {
    return (await run('gh', [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout
  } catch (error) {
    throw new Error(`github release: gh ${args.slice(0, 2).join(' ')} failed: ${commandError(error)}`, { cause: error })
  }
}

/**
 * Run `git` in this checkout.
 * @param args - Arguments after `git`.
 * @returns Its trimmed standard output.
 */
export async function git(args: readonly string[]): Promise<string> {
  try {
    return (await run('git', [...args], { cwd: REPOSITORY_ROOT, encoding: 'utf8', windowsHide: true })).stdout.trim()
  } catch (error) {
    throw new Error(`github release: git ${args[0] ?? ''} failed: ${commandError(error)}`, { cause: error })
  }
}

/** The release fields this tool reads. */
export interface ReleaseView {
  readonly isDraft: boolean
  readonly url: string
  readonly assets: readonly ReleaseAsset[]
}

/**
 * Read a release.
 * @param runner - Runs `gh`.
 * @param repository - `owner/name` of the repository.
 * @param tag - Release tag.
 * @returns Whether it is a draft, its URL, and its assets; undefined when the release does not exist.
 */
export async function viewRelease(runner: GhRunner, repository: string, tag: string): Promise<ReleaseView | undefined> {
  let text: string
  try {
    text = await runner(['release', 'view', tag, '--repo', repository, '--json', 'isDraft,url,assets'])
  } catch (error) {
    if (error instanceof Error && /release not found/iu.test(error.message)) return undefined
    throw error
  }
  const value: unknown = JSON.parse(text)
  if (!isRecord(value) || typeof value.isDraft !== 'boolean' || typeof value.url !== 'string' || !Array.isArray(value.assets)) {
    throw new Error(`github release: gh release view ${tag} returned unexpected fields`)
  }
  const assets = value.assets.map((asset: unknown) => {
    if (!isRecord(asset) || typeof asset.name !== 'string' || typeof asset.size !== 'number') throw new Error(`github release: ${tag} lists an asset without a name and size`)
    return { name: asset.name, size: asset.size }
  })
  return { isDraft: value.isDraft, url: value.url, assets }
}

/**
 * Read the commit of a tag in a GitHub repository, following an annotated tag.
 * @param repository - `owner/name` of the repository.
 * @param tag - Tag name.
 * @returns The commit, or undefined when the tag does not exist.
 */
export async function remoteTagCommit(repository: string, tag: string): Promise<string | undefined> {
  const listing = await git(['ls-remote', '--tags', `https://github.com/${repository}.git`, `refs/tags/${tag}`, `refs/tags/${tag}^{}`])
  const refs = new Map(listing.split('\n').filter(line => line !== '').map((line) => {
    const [sha, ref] = line.split('\t')
    return [ref, sha] as const
  }))
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`)
}

/**
 * Download some assets of a release as text.
 * @param runner - Runs `gh`.
 * @param repository - `owner/name` of the repository.
 * @param tag - Release tag.
 * @param names - Asset names.
 * @returns Each asset's text, by name.
 */
export async function downloadAssets(
  runner: GhRunner, repository: string, tag: string, names: readonly string[],
): Promise<Map<string, string>> {
  const directory = await mkdtemp(join(tmpdir(), 'wasdengine-github-release-'))
  try {
    const texts = new Map<string, string>()
    for (const name of names) {
      await runner(['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', directory, '--clobber'])
      texts.set(name, await readFile(join(directory, name), 'utf8'))
    }
    return texts
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/**
 * Record a staged target's files in its folder (`staged.json`), for an upload elsewhere.
 * @param staged - Files from `stageGitHubRelease`.
 */
export async function writeStagedRelease(staged: StagedRelease): Promise<void> {
  const { version, target, files, feeds, commit, dirty } = staged
  await writeFile(join(staged.directory, STAGED_RELEASE), `${JSON.stringify({ version, target, files, feeds, commit, dirty }, null, 2)}\n`)
}

/**
 * Read the files that `writeStagedRelease` recorded in a staged folder, and check that each is there.
 * @param directory - The staged folder.
 * @returns The staged release, its files in that folder.
 * @throws When `staged.json` is missing or invalid, or names a file that the folder lacks.
 */
export async function readStagedRelease(directory: string): Promise<StagedRelease> {
  const path = join(directory, STAGED_RELEASE)
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  const names = (list: unknown): list is string[] => Array.isArray(list) && list.length > 0 && list.every(name => typeof name === 'string' && /^[\w.-]+$/u.test(name))
  if (
    !isRecord(value) || typeof value.version !== 'string' || (value.target !== 'mac-arm64' && value.target !== 'win-x64')
    || !names(value.files) || !names(value.feeds) || typeof value.dirty !== 'boolean'
    || (value.commit !== undefined && (typeof value.commit !== 'string' || !/^[0-9a-f]{40}$/u.test(value.commit)))
  ) {
    throw new Error(`github release: ${path} does not describe staged release files`)
  }
  for (const name of [...value.files, ...value.feeds]) {
    const details = await stat(join(directory, name)).catch(() => undefined)
    if (details === undefined || !details.isFile() || details.size === 0) throw new Error(`github release: ${path} names ${name}, which the folder lacks`)
  }
  return {
    version: value.version, target: value.target, directory, files: value.files, feeds: value.feeds,
    commit: typeof value.commit === 'string' ? value.commit : undefined, dirty: value.dirty,
  }
}

/** How `uploadGitHubRelease` treats the release, and the commands it runs. */
export interface UploadOptions {
  /** Add files to a release that is already published, which changes the live feed. */
  readonly published: boolean
  /** Upload a build packaged from a checkout with uncommitted changes. */
  readonly allowDirty: boolean
  readonly repository?: string
  readonly runner?: GhRunner
  /** Reads the commit of the release tag; defaults to {@link remoteTagCommit}. */
  readonly tagCommit?: (repository: string, tag: string) => Promise<string | undefined>
  /** Reads the commit of a build whose release record names none; defaults to the checkout's `HEAD`. */
  readonly headCommit?: () => Promise<string>
}

/**
 * Upload one staged target to the GitHub release `v<version>`, creating the release as a draft on the build's commit
 * when it does not exist. Installers and blockmaps go first and feed files next, so a published release never names a
 * file it lacks; SHA256SUMS, merged with the lines already in the release, goes last.
 * @param staged - Files from `stageGitHubRelease`, or `readStagedRelease`.
 * @param options - Release handling.
 * @returns The release URL.
 * @throws When the build is dirty, the release tag names another commit, or the release is published and
 * `options.published` is false.
 */
export async function uploadGitHubRelease(staged: StagedRelease, options: UploadOptions): Promise<string> {
  const repository = options.repository ?? BRAND.releaseRepository
  const runner = options.runner ?? gh
  const tag = `v${staged.version}`
  if (staged.dirty && !options.allowDirty) {
    throw new Error(`github release: ${staged.target} was packaged from a checkout with uncommitted changes; package it from the release commit or pass --allow-dirty`)
  }
  const commit = staged.commit ?? await (options.headCommit ?? (() => git(['rev-parse', 'HEAD'])))()
  const tagged = await (options.tagCommit ?? remoteTagCommit)(repository, tag)
  if (tagged !== undefined && tagged !== commit) {
    throw new Error(`github release: ${tag} names commit ${tagged}, but ${staged.target} was packaged from ${commit}`)
  }
  let release = await viewRelease(runner, repository, tag)
  if (release === undefined) {
    await runner(['release', 'create', tag, '--repo', repository, '--draft', '--title', `${BRAND.productName} ${staged.version}`, '--notes', '', '--target', commit])
    release = await viewRelease(runner, repository, tag)
    if (release === undefined) throw new Error(`github release: ${tag} is missing after gh release create`)
  } else if (!release.isDraft && !options.published) {
    throw new Error(`github release: ${tag} is already published, so new files change the live feed; pass --published to upload them anyway`)
  }
  const upload = (names: readonly string[]) => runner(['release', 'upload', tag, ...names.map(name => join(staged.directory, name)), '--repo', repository, '--clobber'])
  await upload(staged.files)
  await upload(staged.feeds)
  const digests = new Map<string, string>()
  for (const name of [...staged.files, ...staged.feeds]) digests.set(name, await fileDigest(join(staged.directory, name), 'sha256', 'hex'))
  const existing = release.assets.some(asset => asset.name === SHA256SUMS)
    ? (await downloadAssets(runner, repository, tag, [SHA256SUMS])).get(SHA256SUMS) ?? ''
    : ''
  await writeFile(join(staged.directory, SHA256SUMS), mergeSha256Sums(existing, digests))
  await upload([SHA256SUMS])
  return release.url
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter(argument => argument !== '--'),
    allowPositionals: true,
    options: {
      published: { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
    },
  })
  if (positionals.length !== 1 || positionals[0] === undefined) {
    throw new Error('usage: wasdengine-github-release-upload.ts <staged folder> [--published] [--allow-dirty]')
  }
  const staged = await readStagedRelease(resolve(positionals[0]))
  const url = await uploadGitHubRelease(staged, { published: values.published, allowDirty: values['allow-dirty'] })
  console.log(`github release: uploaded ${staged.target} to ${url}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
