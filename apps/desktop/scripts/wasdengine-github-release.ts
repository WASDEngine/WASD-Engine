/**
 * Publish WASD Engine Desktop builds as the GitHub releases that the update feed serves (fork-owned;
 * `wasdengine/FORK.md`, Releases, lists the release steps).
 *
 * A build packaged with `DSH_DESKTOP_AUTO_UPDATE_ENV=github` checks
 * `https://github.com/<releaseRepository>/releases/latest/download/<feed file>`, which GitHub redirects to that file of
 * the newest release that is neither a draft nor a pre-release. electron-builder names the files of a feed file
 * relative to the feed URL, so an update would download whichever release is newest when its download starts, and the
 * previous version's blockmap, which electron-updater finds for a differential download by replacing the new version
 * with the installed one in the update's URL, would be looked up in the new release. Staging therefore rewrites every
 * file URL of the feed file into the release `v<version>`.
 *
 * - `stage <target> [--unsigned]` checks a packaged target's files against its feed file and its release record and
 *   writes the release files to `.desktop-build/github-release/v<version>/<target>/`: the installers, their blockmaps,
 *   and the stable feed file with a nightly copy, so the Development choice in Settings reads the same release.
 * - `upload <target> [--unsigned] [--published] [--allow-dirty]` stages, then uploads to the release `v<version>`,
 *   which it creates as a draft on the build's commit when it does not exist: installers and blockmaps first, feed
 *   files next, and SHA256SUMS, merged with the lines of the other targets, last.
 * - `publish [--targets mac-arm64,win-x64]` checks that the release holds every target's feed files, the files they
 *   name, and a SHA256SUMS line for every file, then publishes it as the latest release, which the feed then serves.
 *
 * `gh` performs the GitHub operations with its own sign-in or `GH_TOKEN`; `git ls-remote` reads the release tag.
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { desktopBuildRecordFilename, desktopUpdateMetadataFilename } from './desktop-auto-update-environment.mjs'
import { desktopArtifactOutput, desktopTargetBuildPaths } from './desktop-build-paths.mjs'
import { WASDENGINE_DESKTOP_BRAND as BRAND } from '../src/wasdengine-brand.ts'
import { GITHUB_UPDATE_SERVICE, githubReleaseFileUrl, githubUpdateFeedUrl } from './wasdengine-update-service.mjs'

const run = promisify(execFile)
const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')

/** Name of the checksum file of a release, in `sha256sum` format. */
export const SHA256SUMS = 'SHA256SUMS'

/**
 * Desktop targets the GitHub feed serves. The feed holds one `stable-mac.yml`, so a second macOS architecture would
 * need its files merged into that one feed file, which staging does not do.
 */
export type GitHubReleaseTarget = 'mac-arm64' | 'win-x64'

const TARGETS: Readonly<Record<GitHubReleaseTarget, { readonly platform: 'darwin' | 'win32'; readonly arch: 'arm64' | 'x64' }>> = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64' },
  'win-x64': { platform: 'win32', arch: 'x64' },
}

/**
 * Validate a target name from the command line.
 * @param value - Command-line value.
 * @returns The target.
 * @throws When the value names no target the GitHub feed serves.
 */
export function parseGitHubReleaseTarget(value: string): GitHubReleaseTarget {
  if (value === 'mac-arm64' || value === 'win-x64') return value
  throw new Error(`github release: unsupported target ${JSON.stringify(value)}; expected mac-arm64 or win-x64`)
}

/**
 * Name the stable feed file of a target and the nightly copy that the Development channel reads.
 * @param version - Release version.
 * @param target - Release target.
 * @returns The two feed file names.
 */
export function githubFeedFilenames(version: string, target: GitHubReleaseTarget): { readonly stable: string; readonly nightly: string } {
  const { platform } = TARGETS[target]
  return { stable: desktopUpdateMetadataFilename(version, platform, 'stable'), nightly: desktopUpdateMetadataFilename(version, platform, 'nightly') }
}

/** One file of an electron-updater feed file; electron-builder adds fields that staging keeps. */
interface FeedFile {
  readonly url: string
  readonly sha512: string
  readonly size: number
  readonly [field: string]: unknown
}

/** The fields of an electron-updater feed file that staging reads and rewrites. */
interface Feed {
  readonly version: string
  readonly files: readonly FeedFile[]
  readonly path?: string
  readonly sha512?: string
  readonly [field: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseFeedFile(value: unknown, source: string): FeedFile {
  if (!isRecord(value) || typeof value.url !== 'string' || value.url === '' || typeof value.sha512 !== 'string' || value.sha512 === ''
    || typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0) {
    throw new Error(`github release: ${source} lists a file without a url, sha512, and size`)
  }
  return { ...value, url: value.url, sha512: value.sha512, size: value.size }
}

/**
 * Parse an electron-updater feed file. The JSON schema keeps every value a string, number, or boolean, as
 * electron-builder wrote it, so a release date stays the quoted string it was.
 * @param text - Feed file contents.
 * @param source - File name or URL for messages.
 * @returns The feed.
 * @throws When the text is not a feed file with a version and at least one file.
 */
export function parseFeed(text: string, source: string): Feed {
  let value: unknown
  try {
    value = load(text, { schema: JSON_SCHEMA })
  } catch (error) {
    throw new Error(`github release: ${source} is not valid YAML`, { cause: error })
  }
  if (!isRecord(value) || typeof value.version !== 'string' || !Array.isArray(value.files) || value.files.length === 0) {
    throw new Error(`github release: ${source} is not a feed file with a version and files`)
  }
  if ((value.path !== undefined && typeof value.path !== 'string') || (value.sha512 !== undefined && typeof value.sha512 !== 'string')) {
    throw new Error(`github release: ${source} has an invalid path or sha512`)
  }
  const files = value.files.map((file: unknown) => parseFeedFile(file, source))
  return { ...value, version: value.version, files, ...value.path === undefined ? {} : { path: value.path } }
}

/**
 * Rewrite a feed file so every file URL names its file in one release.
 * @param feed - Feed whose file URLs are file names, as electron-builder writes them.
 * @param fileUrl - URL of one release file by name.
 * @returns YAML text of the rewritten feed.
 */
export function rewriteFeed(feed: Feed, fileUrl: (filename: string) => string): string {
  return dump({
    ...feed,
    files: feed.files.map(file => ({ ...file, url: fileUrl(file.url) })),
    ...feed.path === undefined ? {} : { path: fileUrl(feed.path) },
  }, { lineWidth: -1, noRefs: true })
}

async function fileDigest(path: string, algorithm: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): Promise<string> {
  const digest = createHash(algorithm)
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer)
  return digest.digest(encoding)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

async function nonEmptyFile(path: string): Promise<number> {
  let size = 0
  try {
    const details = await stat(path)
    if (details.isFile()) size = details.size
  } catch (error) {
    if (!isMissing(error)) throw error
  }
  if (size === 0) throw new Error(`github release: ${path} is missing or empty`)
  return size
}

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

/** What `stageGitHubRelease` stages and from where. */
export interface StageOptions {
  readonly target: GitHubReleaseTarget
  /** Whether the target was packaged with `--unsigned`, which puts its files in `unsigned-artifacts`. */
  readonly unsigned: boolean
  /** Version the release publishes; the packaged feed file must name it. */
  readonly version: string
  /** Folder of the packaged files; defaults to the target's artifacts folder for the packaging mode. */
  readonly artifactsDirectory?: string
  /** Folder that receives the staged files; defaults to `.desktop-build/github-release/v<version>/<target>`. */
  readonly outputDirectory?: string
  /** URL of one file of the release; defaults to the file in the GitHub release `v<version>`. */
  readonly fileUrl?: (filename: string) => string
}

interface ReleaseRecord {
  readonly commit: string | undefined
  readonly dirty: boolean
}

async function readReleaseRecord(directory: string, target: GitHubReleaseTarget, version: string): Promise<ReleaseRecord> {
  const path = join(directory, desktopBuildRecordFilename(target))
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (isMissing(error)) throw new Error(`github release: ${path} is missing; package ${target} with DSH_DESKTOP_AUTO_UPDATE_ENV=github and without --dir`, { cause: error })
    throw new Error(`github release: ${path} is not a release record`, { cause: error })
  }
  if (!isRecord(value) || value.target !== target || value.version !== version || value.environment !== GITHUB_UPDATE_SERVICE) {
    throw new Error(`github release: ${path} does not record a ${target} build of ${version} for the GitHub feed`)
  }
  const { commit, dirty } = value
  if ((commit !== undefined && (typeof commit !== 'string' || !/^[0-9a-f]{40}$/u.test(commit))) || (dirty !== undefined && typeof dirty !== 'boolean')) {
    throw new Error(`github release: ${path} has an invalid commit`)
  }
  return { commit, dirty: dirty === true }
}

/**
 * Check one packaged target against its feed file and release record, and stage its release files.
 * @param options - Target, packaging mode, version, and folders.
 * @returns The staged files.
 * @throws When the feed file, the release record, or a packaged file is missing or does not match the version, its
 * size, or its SHA-512.
 */
export async function stageGitHubRelease(options: StageOptions): Promise<StagedRelease> {
  const { target, unsigned, version } = options
  const { platform, arch } = TARGETS[target]
  if (platform === 'darwin' && unsigned) throw new Error('github release: unsigned macOS builds carry no update feed; package mac-arm64 signed')
  const output = desktopArtifactOutput(desktopTargetBuildPaths(target), { unsigned, skipNotarization: false })
  const directory = options.artifactsDirectory ?? output.directory
  const names = githubFeedFilenames(version, target)
  const feedPath = join(directory, names.stable)
  let text: string
  try {
    text = await readFile(feedPath, 'utf8')
  } catch (error) {
    if (isMissing(error)) throw new Error(`github release: ${feedPath} is missing; package ${target} with DSH_DESKTOP_AUTO_UPDATE_ENV=github`, { cause: error })
    throw error
  }
  const feed = parseFeed(text, feedPath)
  if (feed.version !== version) throw new Error(`github release: ${feedPath} describes ${feed.version}, not ${version}`)
  const record = await readReleaseRecord(directory, target, version)
  const files: string[] = []
  for (const file of feed.files) {
    if (!/^[\w.-]+$/u.test(file.url)) throw new Error(`github release: ${feedPath} names ${file.url}, which is not a file name`)
    const path = join(directory, file.url)
    const size = await nonEmptyFile(path)
    if (size !== file.size) throw new Error(`github release: ${file.url} has ${String(size)} bytes, but ${names.stable} lists ${String(file.size)}`)
    if (await fileDigest(path, 'sha512', 'base64') !== file.sha512) throw new Error(`github release: ${file.url} does not match the SHA-512 ${names.stable} lists`)
    await nonEmptyFile(`${path}.blockmap`)
    files.push(file.url, `${file.url}.blockmap`)
  }
  if (feed.path !== undefined && !feed.files.some(file => file.url === feed.path && file.sha512 === feed.sha512)) {
    throw new Error(`github release: ${feedPath} names a path that its files do not list with the same SHA-512`)
  }
  if (platform === 'darwin') {
    const image = `${BRAND.artifactBase}-${version}-mac-${arch}${output.suffix}.dmg`
    await nonEmptyFile(join(directory, image))
    files.push(image)
  }
  const destination = options.outputDirectory ?? join(APP_ROOT, '.desktop-build', 'github-release', `v${version}`, target)
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  for (const name of files) await copyFile(join(directory, name), join(destination, name), constants.COPYFILE_FICLONE)
  const rewritten = rewriteFeed(feed, options.fileUrl ?? (name => githubReleaseFileUrl(version, name)))
  for (const name of [names.stable, names.nightly]) await writeFile(join(destination, name), rewritten)
  const feeds = [names.stable, names.nightly]
  return { version, target, directory: destination, files, feeds, commit: record.commit, dirty: record.dirty }
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

/** One asset of a GitHub release. */
export interface ReleaseAsset {
  readonly name: string
  readonly size: number
}

/** What `verifyReleaseFeeds` checks. */
export interface ReleaseCheck {
  readonly version: string
  readonly targets: readonly GitHubReleaseTarget[]
  readonly assets: readonly ReleaseAsset[]
  /** Text of every feed file and of SHA256SUMS that the release holds, by asset name. */
  readonly texts: ReadonlyMap<string, string>
  /** URL of one file of the release; defaults to the file in the GitHub release `v<version>`. */
  readonly fileUrl?: (filename: string) => string
}

/**
 * List what keeps a release from serving every target's update: a missing or differing feed file, a file the feed
 * names that the release lacks or holds with another size, a missing blockmap, a missing macOS disk image, or a
 * release file without a SHA256SUMS line.
 * @param check - Release version, targets, assets, and the texts of its feed files and SHA256SUMS.
 * @returns Problems, empty when the release is complete.
 */
export function verifyReleaseFeeds(check: ReleaseCheck): string[] {
  const { version, assets, texts } = check
  const fileUrl = check.fileUrl ?? ((name: string) => githubReleaseFileUrl(version, name))
  const sizes = new Map(assets.map(asset => [asset.name, asset.size]))
  const problems: string[] = []
  for (const target of check.targets) {
    const names = githubFeedFilenames(version, target)
    const stable = texts.get(names.stable)
    const nightly = texts.get(names.nightly)
    if (stable === undefined || nightly === undefined) {
      problems.push(`${target}: the release lacks ${stable === undefined ? names.stable : names.nightly}`)
      continue
    }
    if (stable !== nightly) problems.push(`${target}: ${names.nightly} differs from ${names.stable}`)
    let feed: Feed
    try {
      feed = parseFeed(stable, names.stable)
    } catch (error) {
      problems.push(`${target}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (feed.version !== version) problems.push(`${target}: ${names.stable} describes ${feed.version}`)
    for (const file of feed.files) {
      const name = [...sizes.keys()].find(asset => fileUrl(asset) === file.url)
      if (name === undefined) {
        problems.push(`${target}: ${names.stable} names ${file.url}, which is not a file of this release`)
        continue
      }
      if (sizes.get(name) !== file.size) problems.push(`${target}: ${name} has ${String(sizes.get(name))} bytes, but ${names.stable} lists ${String(file.size)}`)
      if (!sizes.has(`${name}.blockmap`)) problems.push(`${target}: the release lacks ${name}.blockmap`)
    }
    if (feed.path !== undefined && !feed.files.some(file => file.url === feed.path)) problems.push(`${target}: ${names.stable} has a path that its files do not list`)
    if (target === 'mac-arm64' && !sizes.has(`${BRAND.artifactBase}-${version}-mac-arm64.dmg`)) {
      problems.push(`${target}: the release lacks ${BRAND.artifactBase}-${version}-mac-arm64.dmg`)
    }
  }
  const sums = texts.get(SHA256SUMS)
  if (sums === undefined) {
    problems.push(`the release lacks ${SHA256SUMS}`)
  } else {
    let listed: Set<string>
    try {
      listed = new Set(mergeSha256Sums(sums, new Map()).split('\n').filter(line => line !== '').map(line => line.slice(66)))
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
      listed = new Set()
    }
    for (const asset of assets) if (asset.name !== SHA256SUMS && !listed.has(asset.name)) problems.push(`${SHA256SUMS} has no line for ${asset.name}`)
  }
  return problems
}

/** Runs one `gh` command and returns its standard output. */
export type GhRunner = (args: readonly string[]) => Promise<string>

function commandError(error: unknown): string {
  if (error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' && error.stderr.trim() !== '') return error.stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

/** `gh` on the PATH, with its own sign-in or `GH_TOKEN`. */
const gh: GhRunner = async (args) => {
  try {
    return (await run('gh', [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true })).stdout
  } catch (error) {
    throw new Error(`github release: gh ${args.slice(0, 2).join(' ')} failed: ${commandError(error)}`, { cause: error })
  }
}

async function git(args: readonly string[]): Promise<string> {
  try {
    return (await run('git', [...args], { cwd: REPOSITORY_ROOT, encoding: 'utf8', windowsHide: true })).stdout.trim()
  } catch (error) {
    throw new Error(`github release: git ${args[0] ?? ''} failed: ${commandError(error)}`, { cause: error })
  }
}

/** The release fields this tool reads. */
interface ReleaseView {
  readonly isDraft: boolean
  readonly url: string
  readonly assets: readonly ReleaseAsset[]
}

async function viewRelease(runner: GhRunner, repository: string, tag: string): Promise<ReleaseView | undefined> {
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

async function downloadAssets(runner: GhRunner, repository: string, tag: string, names: readonly string[]): Promise<Map<string, string>> {
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
 * @param staged - Files from `stageGitHubRelease`.
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

/** What `publishGitHubRelease` publishes. */
export interface PublishOptions {
  readonly version: string
  readonly targets: readonly GitHubReleaseTarget[]
  readonly repository?: string
  readonly runner?: GhRunner
}

/**
 * Check that the release `v<version>` serves every target's update, then publish it as the latest release.
 * @param options - Version, targets, and repository.
 * @returns The release URL.
 * @throws When the release is missing or `verifyReleaseFeeds` reports a problem.
 */
export async function publishGitHubRelease(options: PublishOptions): Promise<string> {
  const repository = options.repository ?? BRAND.releaseRepository
  const runner = options.runner ?? gh
  const tag = `v${options.version}`
  const release = await viewRelease(runner, repository, tag)
  if (release === undefined) throw new Error(`github release: ${repository} has no release ${tag}`)
  const present = new Set(release.assets.map(asset => asset.name))
  const wanted = [SHA256SUMS, ...options.targets.flatMap(target => Object.values(githubFeedFilenames(options.version, target)))]
  const texts = await downloadAssets(runner, repository, tag, wanted.filter(name => present.has(name)))
  const problems = verifyReleaseFeeds({ version: options.version, targets: options.targets, assets: release.assets, texts })
  if (problems.length > 0) throw new Error(`github release: ${tag} is not ready to publish:\n  ${problems.join('\n  ')}`)
  await runner(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest'])
  return release.url
}

/**
 * Read the version that the live feed serves for a target, to confirm a publication.
 * @param target - Release target.
 * @param version - Version whose feed file names to read.
 * @returns The version of the target's stable feed file, or the HTTP status when GitHub serves none.
 */
async function liveFeedVersion(target: GitHubReleaseTarget, version: string): Promise<string> {
  const url = `${githubUpdateFeedUrl()}${githubFeedFilenames(version, target).stable}`
  const response = await fetch(url)
  if (!response.ok) {
    await response.body?.cancel()
    return `HTTP ${String(response.status)}`
  }
  return parseFeed(await response.text(), url).version
}

async function productVersion(): Promise<string> {
  const value: unknown = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
  if (!isRecord(value) || typeof value.version !== 'string') throw new Error('github release: package.json has no version')
  return value.version
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2).filter(argument => argument !== '--')
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      unsigned: { type: 'boolean', default: false },
      published: { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
      version: { type: 'string' },
      targets: { type: 'string', default: 'mac-arm64,win-x64' },
    },
  })
  const version = values.version ?? await productVersion()
  if (command === 'stage' || command === 'upload') {
    if (positionals.length !== 1 || positionals[0] === undefined) throw new Error(`usage: wasdengine-github-release.ts ${command} <mac-arm64|win-x64> [--unsigned]`)
    const staged = await stageGitHubRelease({ target: parseGitHubReleaseTarget(positionals[0]), unsigned: values.unsigned, version })
    console.log(`github release: staged ${[...staged.files, ...staged.feeds].join(', ')} in ${staged.directory}`)
    if (command === 'upload') {
      const url = await uploadGitHubRelease(staged, { published: values.published, allowDirty: values['allow-dirty'] })
      console.log(`github release: uploaded ${staged.target} to ${url}`)
    }
    return
  }
  if (command === 'publish') {
    if (positionals.length !== 0) throw new Error('usage: wasdengine-github-release.ts publish [--targets mac-arm64,win-x64]')
    const targets = values.targets.split(',').map(target => parseGitHubReleaseTarget(target.trim()))
    for (const target of Object.keys(TARGETS)) {
      if (!targets.includes(parseGitHubReleaseTarget(target))) console.warn(`github release: ${target} is left out, so its installed apps find no update in this release`)
    }
    const url = await publishGitHubRelease({ version, targets })
    console.log(`github release: published ${url}`)
    for (const target of targets) console.log(`github release: the ${target} feed now serves ${await liveFeedVersion(target, version)}`)
    return
  }
  throw new Error('usage: wasdengine-github-release.ts <stage|upload|publish> ...')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
