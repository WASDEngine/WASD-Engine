/**
 * The Sessions through which connected agents work: one per agent and game project, and one more for each Session name
 * that the agent's calls give, so agents that share one connection, such as the subagents of one session, can each run
 * a game of their own. A call names a directory; the game project registration that contains it, or a new one for the
 * directory itself, holds the agent's Sessions. A directory in a temporary folder that no registration contains, such as
 * an agent's scratch folder, gets no registration: its Sessions work in the directory outside every game project, so
 * throwaway work stays out of the user's game projects. Sessions are created on first use and remembered in a JSON file,
 * so the agent keeps its Sessions, and the Sessions their games, across agent and Host restarts. The agent's unnamed Session
 * stays untitled and blank until someone prompts in it, so New Session in that game project opens it, and its Game tab,
 * rather than a second blank Session; a named Session is titled with the agent and the name.
 * @module @deepseek-ai/dsh-game-mcp/src/sessions
 */
import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, parse } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace'
import type { GameMcpClient } from './provider.ts'
import { inTemporaryFolder, within } from './temporary-folders.ts'

/** Format version of the bindings file. */
const FILE_VERSION = 1

/** Longest Session name a call may give, after trimming. */
export const MAX_SESSION_NAME_CHARS = 40

/** Where a remembered Session works: in the game project registration that holds it, or in a temporary folder that none contains. */
type Place = { readonly workspaceId: string } | { readonly directory: string }

/** One remembered Session: where it works, the agent, the Session name if any, and the Session. */
type Binding = Place & {
  readonly client: string
  /** The Session name in lowercase; absent for the agent's unnamed Session. */
  readonly name?: string
  readonly sessionId: string
}

/** A connected agent's call cannot reach a Session; the message tells the agent why. */
export class GameMcpSessionError extends Error {
  override name = 'GameMcpSessionError'
}

function bindingKey(place: Place, client: string, name: string | undefined): string {
  return JSON.stringify(['workspaceId' in place ? ['workspace', place.workspaceId] : ['directory', place.directory], client, name ?? null])
}

/**
 * The binding that one entry of the bindings file records.
 * @param value - the entry.
 * @returns the binding with the entry's known fields, or undefined when the entry records none.
 */
function bindingOf(value: unknown): Binding | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { workspaceId, directory, client, name, sessionId } = value as Record<string, unknown>
  if (typeof client !== 'string' || typeof sessionId !== 'string' || (name !== undefined && typeof name !== 'string')) return undefined
  const rest = { client, ...name === undefined ? {} : { name }, sessionId }
  // A Session works in a game project registration or in a temporary folder outside every one, never both.
  if (typeof workspaceId === 'string' && directory === undefined) return { workspaceId, ...rest }
  if (typeof directory === 'string' && workspaceId === undefined) return { directory, ...rest }
  return undefined
}

/**
 * Validate a Session name that a call gives.
 * @param name - the name as the call gave it.
 * @returns the name without surrounding spaces, and its key: the name in lowercase.
 * @throws {GameMcpSessionError} for a name that is empty or longer than {@link MAX_SESSION_NAME_CHARS} characters after
 *   trimming, or that holds a control character.
 */
export function sessionName(name: string): { readonly title: string; readonly key: string } {
  const title = name.trim()
  if (title === '' || title.length > MAX_SESSION_NAME_CHARS || /\p{Cc}/u.test(title)) {
    throw new GameMcpSessionError(`session must be a name of 1 to ${MAX_SESSION_NAME_CHARS} characters without line breaks, got ${JSON.stringify(name)}.`)
  }
  return { title, key: title.toLowerCase() }
}

/**
 * The registration that contains a path: the one whose folder is the path or its nearest ancestor.
 * @param workspaces - registrations with canonical paths.
 * @param path - canonical directory.
 * @returns the registration, or undefined when none contains the path.
 */
function containing(workspaces: readonly Workspace[], path: string): Workspace | undefined {
  let best: Workspace | undefined
  for (const workspace of workspaces) {
    if (!within(workspace.path, path)) continue
    if (best === undefined || workspace.path.length > best.path.length) best = workspace
  }
  return best
}

/**
 * Whether a folder is the root of a disk or holds the user's home folder, which a call names by mistake, such as `/` or
 * `~`, and which would make every file of the user's part of one game project.
 * @param canonical - real path of the folder.
 * @returns true for such a folder.
 */
async function holdsHome(canonical: string): Promise<boolean> {
  if (canonical === parse(canonical).root) return true
  const home = await realpath(homedir()).catch(() => homedir())
  return within(canonical, home)
}

/** The connected agents' Sessions, persisted in one JSON file. */
export class ExternalSessions {
  private bindings: Promise<Map<string, Binding>> | undefined
  private readonly queues = new Map<string, Promise<unknown>>()
  /** The latest write of the bindings file. */
  private saving: Promise<void> = Promise.resolve()

  /**
   * @param ctx - Host context with the optional Workspace registry and Session controller.
   * @param file - absolute path of the bindings file.
   * @param temporaryFolders - absolute folders in which a directory that no registration contains gets none.
   */
  constructor(private readonly ctx: Context, private readonly file: string, private readonly temporaryFolders: readonly string[]) {}

  /**
   * Resolve the Agent of an agent's Session in the game project that holds a directory, or, for a directory in a
   * temporary folder that no game project holds, in the directory without a game project.
   * @param client - calling agent.
   * @param directory - absolute path of an existing directory.
   * @param signal - cancellation before the Session is created or resumed.
   * @param name - the Session name the call gives, which picks a Session of its own; undefined picks the agent's
   *   unnamed Session. Names that differ only in case pick the same Session.
   * @returns the live Agent.
   * @throws {GameMcpSessionError} when the path or the name is unusable, the Host keeps no game projects, or the
   * Session cannot be created or resumed.
   */
  async agent(client: GameMcpClient, directory: string, signal: AbortSignal, name?: string): Promise<Agent> {
    const named = name === undefined ? undefined : sessionName(name)
    if (!isAbsolute(directory)) throw new GameMcpSessionError(`The project path must be absolute, got ${JSON.stringify(directory)}.`)
    let canonical: string
    try {
      canonical = await realpath(directory)
    } catch {
      throw new GameMcpSessionError(`${directory} does not exist.`)
    }
    if (!(await stat(canonical)).isDirectory()) throw new GameMcpSessionError(`${directory} is not a folder.`)
    const registry = this.ctx.get('workspaceRegistry')
    const controller = this.ctx.get('sessionController')
    if (registry === undefined || controller === undefined) {
      throw new GameMcpSessionError('This WASD Engine Host keeps no game projects, so connected agents cannot run games through it.')
    }
    signal.throwIfAborted()
    const found = containing(registry.list(), canonical)
    if (found === undefined && await holdsHome(canonical)) {
      throw new GameMcpSessionError(`${directory} is a disk or holds the home folder, which WASD Engine does not keep as a game project; pass the folder of one game.`)
    }
    const workspace = found
      ?? (await inTemporaryFolder(this.temporaryFolders, canonical) ? undefined : await registry.create(canonical))
    const place: Place = workspace === undefined ? { directory: canonical } : { workspaceId: workspace.id }
    const key = bindingKey(place, client.id, named?.key)
    return this.serialize(key, async () => {
      const bindings = await this.load()
      const stored = bindings.get(key)
      if (stored !== undefined && (workspace === undefined || workspace.sessionIds.includes(brandString<SessionId>(stored.sessionId)))
        && !registry.archivedSessionIds.includes(brandString<SessionId>(stored.sessionId))) {
        const resumed = await controller.resolveAgent(brandString<SessionId>(stored.sessionId))
        if ('agent' in resumed) return resumed.agent
        if (resumed.error.code !== 'session/not-found') {
          throw new GameMcpSessionError(`WASD Engine cannot open the Session of ${client.title}: ${resumed.error.message}`)
        }
      }
      signal.throwIfAborted()
      // Untitled: until someone prompts in it, the Session is blank, and New Session in the game project opens it.
      const created = await controller.create(workspace === undefined ? { cwd: canonical } : { workspaceId: workspace.id })
      const resolved = await controller.resolveAgent(created.sessionId)
      if ('error' in resolved) throw new GameMcpSessionError(`WASD Engine cannot open the Session of ${client.title}: ${resolved.error.message}`)
      if (named !== undefined) {
        try {
          await controller.rename({ sessionId: created.sessionId, title: `${client.title}: ${named.title}` })
        } catch (error) {
          // The title only tells the Sessions apart in the window; the Session works without it.
          this.ctx.logger.warn(`game-mcp: cannot title the Session of ${client.title} named ${JSON.stringify(named.title)}: ${(error as Error).message}`)
        }
      }
      const binding: Binding = {
        ...place, client: client.id, ...named === undefined ? {} : { name: named.key }, sessionId: created.sessionId,
      }
      bindings.set(key, binding)
      await this.save(bindings)
      return resolved.agent
    })
  }

  /** Run one binding's lookups and creations after the earlier ones settle, so an agent gets one Session per project. */
  private serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(key) ?? Promise.resolve()).then(operation)
    const tail = task.catch(() => {
      // The caller receives the failure; the queue only orders operations.
    })
    this.queues.set(key, tail)
    void tail.then(() => { if (this.queues.get(key) === tail) this.queues.delete(key) })
    return task
  }

  private load(): Promise<Map<string, Binding>> {
    this.bindings ??= (async () => {
      const bindings = new Map<string, Binding>()
      let text: string
      try {
        text = await readFile(this.file, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return bindings
        throw error
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        this.ctx.logger.warn(`game-mcp: ${this.file} is not JSON; connected agents get new Sessions`)
        return bindings
      }
      const entries = (parsed as { sessions?: unknown }).sessions
      if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION || !Array.isArray(entries)) {
        this.ctx.logger.warn(`game-mcp: ${this.file} has an unknown format; connected agents get new Sessions`)
        return bindings
      }
      for (const entry of entries) {
        const binding = bindingOf(entry)
        if (binding !== undefined) bindings.set(bindingKey(binding, binding.client, binding.name), binding)
      }
      return bindings
    })().catch((error: unknown) => {
      // A failed read is retried by the next call instead of failing every later one.
      this.bindings = undefined
      throw error
    })
    return this.bindings
  }

  /**
   * Write the bindings after the earlier writes settle, as they are when the write starts, so a write that two
   * agents' first calls start together cannot replace a later one with an older list.
   */
  private save(bindings: Map<string, Binding>): Promise<void> {
    const write = this.saving.then(async () => {
      const sessions = [...bindings.values()]
      await writeFileAtomic(this.file, `${JSON.stringify({ version: FILE_VERSION, sessions }, null, 2)}\n`, { mode: 0o600 })
    })
    this.saving = write.catch(() => {
      // The caller receives the failure; the chain only orders the writes.
    })
    return write
  }
}
