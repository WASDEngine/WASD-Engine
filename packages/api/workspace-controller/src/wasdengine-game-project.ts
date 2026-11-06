/**
 * WASD Engine game projects (fork-owned; `wasdengine/FORK.md` lists the fork changes): the
 * Host half of the Create game project dialog. A game project is a Workspace over a folder
 * this controller creates, by default under `<Documents>/WASD Engine`, holding a Git
 * repository with one empty commit, so that a Session in it can start in its own worktree.
 */

import { execFile } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defaultWorkspaceDirectory } from './default-directory.ts'
import { workspaceView } from './feed.ts'
import type { GameProjectCreateRequest, GameProjectCreateValue, GameProjectDefaults } from './types.ts'

/** Folder under the Host account's Documents directory that holds new game projects. */
export const GAME_PROJECTS_DIRECTORY = 'WASD Engine'

/** Upper bound of each Git command, which runs without a terminal to answer prompts. */
const GIT_TIMEOUT_MS = 30_000

/** Author of the first commit when Git finds no identity of its own. */
const FALLBACK_IDENTITY = ['-c', 'user.name=WASD Engine', '-c', 'user.email=noreply@wasdengine.com'] as const

/** Characters that Windows, macOS, or Linux refuse in a folder name, and control characters. */
const RESERVED_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f]/u

/** Longest folder name, in UTF-8 bytes, that common file systems store. */
const MAX_NAME_BYTES = 255

/** Variables that would point Git at a repository other than the new folder's own. */
const GIT_SELECTORS: ReadonlySet<string> = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
])

/** Documents policy of the owning Workspace controller, and whether first use waits for a game project. */
export interface GameProjectConfig {
  /** Fully qualified override of the system Documents directory. */
  readonly documentsDirectory?: string | undefined
  /** Positive maximum duration of the operating system's Documents lookup, in milliseconds. */
  readonly documentsLookupTimeoutMs: number
  /** Whether the first-use default Workspace is off, so the Client asks for a game project. */
  readonly required: boolean
}

/**
 * Run one Git command in a directory.
 * @param args - Git arguments, never a shell string.
 * @param cwd - working directory of the command.
 * @param signal - abort terminates the command.
 * @returns standard output; rejects on a missing executable or a nonzero exit.
 */
export type GitRunner = (args: readonly string[], cwd: string, signal: AbortSignal) => Promise<string>

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `gameProject` Remote namespace. */
    gameProjectController: GameProjectController
  }
}

/** Host service backing the generated `ctx.remote.gameProject` namespace. */
export class GameProjectController extends TypertRemoteService {
  static inject = ['workspaceRegistry']

  private readonly config: GameProjectConfig
  private readonly git: GitRunner

  /**
   * @param ctx - Host context carrying the Workspace registry.
   * @param config - Documents policy and whether first use waits for a game project.
   * @param git - Git command runner; tests replace it to observe a missing or failing Git.
   */
  constructor(ctx: Context, config: GameProjectConfig, git: GitRunner = runGit) {
    super(ctx, 'gameProjectController', { namespace: 'gameProject' })
    this.config = config
    this.git = git
  }

  /**
   * Read where the Create game project dialog starts.
   * @param signal - caller lifetime; cancels the Documents lookup.
   * @returns the suggested parent folder, null when the Documents lookup fails, and whether first use waits for a game project.
   */
  @Remote('defaults')
  async defaults(signal: AbortSignal): Promise<GameProjectDefaults> {
    return { directory: await this.suggestedDirectory(signal), required: this.config.required }
  }

  /**
   * Create a game project folder, give it a Git repository with one empty commit when Git
   * is available, and register it as a Workspace titled with the folder name. A Git failure
   * leaves the folder without a repository instead of failing the creation. Cancellation
   * stops a running Git command; a created folder is still registered.
   * @param request - folder name and fully qualified parent folder.
   * @param signal - caller lifetime.
   * @returns the registered Workspace and whether it holds a repository.
   * @throws `gameProject/invalid-name` for a name that is not one portable folder name;
   * `gameProject/invalid-directory` for a parent that is not fully qualified;
   * `gameProject/exists` when the path is taken; `gameProject/create-failed` when the Host
   * cannot create the parent or the folder, or cannot register it.
   */
  @Remote('create')
  async create(request: GameProjectCreateRequest, signal: AbortSignal): Promise<GameProjectCreateValue> {
    signal.throwIfAborted()
    const paths = process.platform === 'win32' ? win32 : posix
    const name = projectName(request.name)
    const parent = projectDirectory(request.directory, paths)
    const path = paths.join(parent, name)
    try {
      await mkdir(parent, { recursive: true })
    } catch (error: unknown) {
      throw new RemoteError('gameProject/create-failed', `cannot create "${parent}": ${messageOf(error)}`, { path: parent }, { cause: error })
    }
    try {
      await mkdir(path)
    } catch (error: unknown) {
      if (codeOf(error) === 'EEXIST') throw new RemoteError('gameProject/exists', `"${path}" already exists`, { path }, { cause: error })
      throw new RemoteError('gameProject/create-failed', `cannot create "${path}": ${messageOf(error)}`, { path }, { cause: error })
    }
    const git = await this.initializeRepository(path, name, paths, signal)
    let workspace
    try {
      workspace = await this.ctx.workspaceRegistry.create(path)
    } catch (error: unknown) {
      throw new RemoteError('gameProject/create-failed', `cannot register "${path}": ${messageOf(error)}`, { path }, { cause: error })
    }
    return { workspace: workspaceView(workspace), git }
  }

  /** `<Documents>/WASD Engine`, or null when the Host cannot find its Documents directory. */
  private async suggestedDirectory(signal: AbortSignal): Promise<string | null> {
    const paths = process.platform === 'win32' ? win32 : posix
    const lookup = AbortSignal.any([signal, AbortSignal.timeout(this.config.documentsLookupTimeoutMs)])
    let firstUse: string
    try {
      firstUse = await defaultWorkspaceDirectory(this.config.documentsDirectory, lookup)
    } catch (error: unknown) {
      if (signal.aborted) throw error
      return null
    }
    // The first-use directory is `<Documents>/deepseek-harness/default-workspace`.
    return paths.join(paths.dirname(paths.dirname(firstUse)), GAME_PROJECTS_DIRECTORY)
  }

  /** @returns whether the new folder now holds a repository with one commit. */
  private async initializeRepository(path: string, name: string, paths: typeof posix, signal: AbortSignal): Promise<boolean> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(GIT_TIMEOUT_MS)])
    try {
      // An empty template copies no hooks from the account's Git configuration.
      await this.git(['init', '--quiet', '--template='], path, deadline)
    } catch (_missing: unknown) {
      // Without a usable Git the project still works; its Sessions share one folder.
      return false
    }
    const commit = (identity: readonly string[]): Promise<string> => this.git([
      '-c', 'core.hooksPath=.git/hooks', '-c', 'commit.gpgSign=false', ...identity,
      'commit', '--allow-empty', '--no-verify', '--quiet', '-m', `Create ${name}`,
    ], path, deadline)
    if (await succeeds(commit([])) || await succeeds(commit(FALLBACK_IDENTITY))) return true
    // A repository without a commit cannot start a worktree, so the folder keeps none.
    await rm(paths.join(path, '.git'), { recursive: true, force: true })
    return false
  }
}

/** Whether `operation` fulfills. */
async function succeeds(operation: Promise<unknown>): Promise<boolean> {
  try {
    await operation
  } catch (_failure: unknown) {
    // The caller tries the next way or gives the repository up.
    return false
  }
  return true
}

/** The trimmed name, or `gameProject/invalid-name` when it is not one portable folder name. */
function projectName(raw: string): string {
  const name = raw.trim()
  if (name === '' || name === '.' || name === '..' || name.endsWith('.')
    || RESERVED_NAME_CHARACTERS.test(name) || Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new RemoteError('gameProject/invalid-name', `"${raw}" is not a valid folder name`, { name: raw })
  }
  return name
}

/** The normalized parent, or `gameProject/invalid-directory` when it is not fully qualified. */
function projectDirectory(directory: string, paths: typeof posix): string {
  const root = paths.parse(directory).root
  if (!paths.isAbsolute(directory) || (paths === win32 && (root === '\\' || root === '/'))) {
    throw new RemoteError('gameProject/invalid-directory', `"${directory}" is not a fully qualified folder path`, { path: directory })
  }
  return paths.normalize(directory)
}

const runGit: GitRunner = (args, cwd, signal) => new Promise((resolve, reject) => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !GIT_SELECTORS.has(key)))
  execFile('git', [...args], { cwd, env, encoding: 'utf8', signal, windowsHide: true }, (error: Error | null, stdout) => {
    if (error !== null) {
      reject(error)
      return
    }
    resolve(stdout)
  })
})

function codeOf(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
