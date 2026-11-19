/**
 * A connected agent gets one Session per game project: the registration that contains the named folder, or a new
 * one for it, holds the Session, which is created once, remembered across restarts, and recreated when it is gone. A
 * folder in a temporary folder that no registration contains gets no registration: its Session works in the folder.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { GameMcpClient } from '../src/provider.ts'
import { ExternalSessions, GameMcpSessionError } from '../src/sessions.ts'

vi.mock('@deepseek-ai/dsh-atomic-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-atomic-write')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

const CLAUDE: GameMcpClient = { id: 'claude-code', title: 'Claude Code' }
const CODEX: GameMcpClient = { id: 'codex', title: 'Codex' }

interface FakeWorkspace {
  readonly id: string
  readonly path: string
  readonly sessionIds: SessionId[]
}

/** A Workspace registry and a Session controller over in-memory records. */
class Fakes {
  readonly workspaces: FakeWorkspace[] = []
  readonly archivedSessionIds: SessionId[] = []
  readonly agents = new Map<SessionId, Agent>()
  readonly created: SessionId[] = []
  resolveError: { code: string; message: string } | undefined

  readonly registry = {
    list: () => this.workspaces,
    create: vi.fn(async (path: string) => {
      const workspace: FakeWorkspace = { id: `w${this.workspaces.length + 1}`, path, sessionIds: [] }
      this.workspaces.push(workspace)
      return workspace
    }),
    archivedSessionIds: this.archivedSessionIds,
  }

  readonly controller = {
    create: vi.fn(async ({ workspaceId }: { workspaceId?: string; cwd?: string }) => {
      const sessionId = brandString<SessionId>(`session-${this.created.length + 1}`)
      this.created.push(sessionId)
      this.workspaces.find(workspace => workspace.id === workspaceId)?.sessionIds.push(sessionId)
      this.agents.set(sessionId, { id: sessionId } as Agent)
      return { sessionId }
    }),
    resolveAgent: vi.fn(async (sessionId: SessionId) => {
      if (this.resolveError !== undefined) return { error: this.resolveError }
      const agent = this.agents.get(sessionId)
      return agent === undefined ? { error: { code: 'session/not-found', message: 'not found' } } : { agent }
    }),
  }
}

let root: string
let fakes: Fakes
let ctx: Context
const signal = new AbortController().signal

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-mcp-sessions-')))
  await mkdir(join(root, 'game', 'nested'), { recursive: true })
  fakes = new Fakes()
  ctx = new Context()
  ctx.provide('workspaceRegistry', fakes.registry as never)
  ctx.provide('sessionController', fakes.controller as never)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * The connected agents' Sessions.
 * @param file - the bindings file.
 * @param temporaryFolders - the temporary folders; by default none, so the test's folder, which the system's temporary
 *   folder holds, gets registrations.
 * @returns the Sessions.
 */
function sessions(file = join(root, 'data', 'sessions.json'), temporaryFolders: readonly string[] = []): ExternalSessions {
  return new ExternalSessions(ctx, file, temporaryFolders)
}

/** The requests of the Sessions the controller created. */
function createRequests(): unknown[] {
  return fakes.controller.create.mock.calls.map(([request]) => request)
}

describe('ExternalSessions.agent', () => {
  it('registers the folder as a game project, creates the agent\'s Session in it, and remembers it', async () => {
    const agent = await sessions().agent(CLAUDE, join(root, 'game'), signal)
    expect(agent.id).toBe('session-1')
    expect(fakes.registry.create).toHaveBeenCalledWith(join(root, 'game'))
    expect(JSON.parse(await readFile(join(root, 'data', 'sessions.json'), 'utf8'))).toEqual({
      version: 1, sessions: [{ workspaceId: 'w1', client: 'claude-code', sessionId: 'session-1' }],
    })
    // A new instance, as after a Host restart, reads the remembered Session.
    expect((await sessions().agent(CLAUDE, join(root, 'game'), signal)).id).toBe('session-1')
    expect(fakes.controller.create).toHaveBeenCalledTimes(1)
  })

  it('refuses to keep a disk or the home folder as a game project', async () => {
    for (const folder of ['/', homedir()]) {
      await expect(sessions().agent(CLAUDE, folder, signal)).rejects.toThrow('which WASD Engine does not keep as a game project')
    }
    expect(fakes.registry.create).not.toHaveBeenCalled()
  })

  it('uses the nearest registered game project that contains the folder, and gives each agent its own Session', async () => {
    fakes.workspaces.push({ id: 'outer', path: root, sessionIds: [] }, { id: 'inner', path: join(root, 'game'), sessionIds: [] })
    const store = sessions()
    const claude = await store.agent(CLAUDE, join(root, 'game', 'nested'), signal)
    const codex = await store.agent(CODEX, join(root, 'game', 'nested'), signal)
    expect(fakes.registry.create).not.toHaveBeenCalled()
    expect(fakes.workspaces[1]?.sessionIds).toEqual([claude.id, codex.id])
    expect(claude.id).not.toBe(codex.id)
  })

  it('gives each Session name of an agent a Session of its own, titled with the agent and the name, and remembers it', async () => {
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [] })
    const titles: Array<{ sessionId: SessionId; title: string }> = []
    Object.assign(fakes.controller, { rename: vi.fn(async (request: { sessionId: SessionId; title: string }) => { titles.push(request) }) })
    const store = sessions()
    const shared = await store.agent(CLAUDE, join(root, 'game'), signal)
    const builder = await store.agent(CLAUDE, join(root, 'game'), signal, ' Builder ')
    const checker = await store.agent(CLAUDE, join(root, 'game'), signal, 'checker')
    expect(new Set([shared.id, builder.id, checker.id]).size).toBe(3)
    expect((await store.agent(CLAUDE, join(root, 'game'), signal, 'BUILDER')).id).toBe(builder.id)
    expect(titles).toEqual([{ sessionId: builder.id, title: 'Claude Code: Builder' }, { sessionId: checker.id, title: 'Claude Code: checker' }])
    const saved = JSON.parse(await readFile(join(root, 'data', 'sessions.json'), 'utf8')) as { sessions: unknown[] }
    expect(saved.sessions).toEqual([
      { workspaceId: 'game', client: 'claude-code', sessionId: shared.id },
      { workspaceId: 'game', client: 'claude-code', name: 'builder', sessionId: builder.id },
      { workspaceId: 'game', client: 'claude-code', name: 'checker', sessionId: checker.id },
    ])
    // After a Host restart, each name finds its Session again.
    expect((await sessions().agent(CLAUDE, join(root, 'game'), signal, 'Checker')).id).toBe(checker.id)
    expect((await sessions().agent(CLAUDE, join(root, 'game'), signal)).id).toBe(shared.id)
  })

  it('keeps a named Session that cannot be titled, and refuses empty, long, and multi-line names', async () => {
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [] })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    Object.assign(fakes.controller, { rename: vi.fn(async () => { throw new Error('no title service') }) })
    const store = sessions()
    expect((await store.agent(CLAUDE, join(root, 'game'), signal, 'tester')).id).toBe('session-1')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no title service'))
    for (const name of ['', '   ', 'x'.repeat(41), 'two\nlines']) {
      await expect(store.agent(CLAUDE, join(root, 'game'), signal, name)).rejects.toThrow(GameMcpSessionError)
    }
    expect(fakes.controller.create).toHaveBeenCalledTimes(1)
  })

  it('creates one Session for concurrent first calls', async () => {
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [] })
    const store = sessions()
    const agents = await Promise.all([1, 2, 3].map(() => store.agent(CLAUDE, join(root, 'game'), signal)))
    expect(new Set(agents.map(agent => agent.id)).size).toBe(1)
    expect(fakes.controller.create).toHaveBeenCalledTimes(1)
  })

  it('remembers both Sessions when two agents\' first calls come together and the first write is slow', async () => {
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [] })
    const write = vi.mocked(writeFileAtomic)
    const actual = write.getMockImplementation()
    write.mockImplementationOnce(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 50))
      await actual?.(...args)
    })
    const store = sessions()
    const [claude, codex] = await Promise.all([store.agent(CLAUDE, join(root, 'game'), signal), store.agent(CODEX, join(root, 'game'), signal)])
    const saved = JSON.parse(await readFile(join(root, 'data', 'sessions.json'), 'utf8')) as { sessions: { client: string; sessionId: string }[] }
    expect(saved.sessions.map(({ client, sessionId }) => [client, sessionId]).sort()).toEqual([['claude-code', claude.id], ['codex', codex.id]])
  })

  it('creates a new Session when the remembered one left the project, was archived, or no longer exists', async () => {
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [] })
    const store = sessions()
    const first = await store.agent(CLAUDE, join(root, 'game'), signal)
    fakes.archivedSessionIds.push(first.id)
    const second = await store.agent(CLAUDE, join(root, 'game'), signal)
    expect(second.id).not.toBe(first.id)
    fakes.agents.delete(second.id)
    const third = await store.agent(CLAUDE, join(root, 'game'), signal)
    expect(third.id).not.toBe(second.id)
    fakes.workspaces[0]?.sessionIds.splice(0)
    const fourth = await store.agent(CLAUDE, join(root, 'game'), signal)
    expect(fourth.id).not.toBe(third.id)
  })

  it('reports a remembered Session that cannot be resumed', async () => {
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [] })
    const store = sessions()
    await store.agent(CLAUDE, join(root, 'game'), signal)
    fakes.resolveError = { code: 'session/writer-held', message: 'another Host writes this Session' }
    await expect(store.agent(CLAUDE, join(root, 'game'), signal))
      .rejects.toThrow('WASD Engine cannot open the Session of Claude Code: another Host writes this Session')
  })

  it('refuses relative, missing, and file paths, and a Host without game projects', async () => {
    const store = sessions()
    await expect(store.agent(CLAUDE, 'game', signal)).rejects.toThrow(GameMcpSessionError)
    await expect(store.agent(CLAUDE, join(root, 'missing'), signal)).rejects.toThrow('does not exist')
    await writeFile(join(root, 'file.txt'), 'x')
    await expect(store.agent(CLAUDE, join(root, 'file.txt'), signal)).rejects.toThrow('is not a folder')
    const bare = new Context()
    await expect(new ExternalSessions(bare, join(root, 'sessions.json'), []).agent(CLAUDE, root, signal)).rejects.toThrow('keeps no game projects')
    await bare.fiber.dispose()
  })

  it('starts over when the bindings file is not JSON or has another format', async () => {
    const file = join(root, 'sessions.json')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await writeFile(file, 'not json')
    expect((await sessions(file).agent(CLAUDE, join(root, 'game'), signal)).id).toBe('session-1')
    await writeFile(file, JSON.stringify({ version: 99, sessions: [] }))
    expect((await sessions(file).agent(CLAUDE, join(root, 'game'), signal)).id).toBe('session-2')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('skips remembered Sessions it cannot read, and keeps the ones it can', async () => {
    const file = join(root, 'sessions.json')
    const stale = brandString<SessionId>('stale')
    const kept = brandString<SessionId>('kept')
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [stale, kept] })
    fakes.agents.set(stale, { id: stale } as Agent).set(kept, { id: kept } as Agent)
    const unreadable = [
      null,
      'claude-code',
      { workspaceId: 'game', client: 7, sessionId: stale },
      { workspaceId: 'game', client: 'claude-code' },
      { workspaceId: 'game', client: 'claude-code', name: 7, sessionId: stale },
      // A Session works in a game project or in a temporary folder, never both, and always in one of them.
      { workspaceId: 'game', directory: join(root, 'game'), client: 'claude-code', sessionId: stale },
      { client: 'claude-code', sessionId: stale },
    ]
    const readable = { workspaceId: 'game', client: 'codex', sessionId: kept }
    await writeFile(file, JSON.stringify({ version: 1, sessions: [...unreadable, readable] }))
    const store = sessions(file)
    expect((await store.agent(CLAUDE, join(root, 'game'), signal)).id).toBe('session-1')
    expect((await store.agent(CODEX, join(root, 'game'), signal)).id).toBe(kept)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      version: 1, sessions: [readable, { workspaceId: 'game', client: 'claude-code', sessionId: 'session-1' }],
    })
  })
})

describe('ExternalSessions.agent in a temporary folder', () => {
  it('registers no game project: each agent\'s Session, and each named one, works in the folder and is remembered', async () => {
    const temporary = join(root, 'tmp')
    const scratch = join(temporary, 'scratch', 'game')
    await mkdir(scratch, { recursive: true })
    Object.assign(fakes.controller, { rename: vi.fn(async () => {}) })
    const store = sessions(undefined, [temporary])
    const shared = await store.agent(CLAUDE, scratch, signal)
    const builder = await store.agent(CLAUDE, scratch, signal, 'Builder')
    const codex = await store.agent(CODEX, scratch, signal)
    expect(new Set([shared.id, builder.id, codex.id]).size).toBe(3)
    expect(fakes.registry.create).not.toHaveBeenCalled()
    expect(createRequests()).toEqual([{ cwd: scratch }, { cwd: scratch }, { cwd: scratch }])
    expect(JSON.parse(await readFile(join(root, 'data', 'sessions.json'), 'utf8'))).toEqual({
      version: 1,
      sessions: [
        { directory: scratch, client: 'claude-code', sessionId: shared.id },
        { directory: scratch, client: 'claude-code', name: 'builder', sessionId: builder.id },
        { directory: scratch, client: 'codex', sessionId: codex.id },
      ],
    })
    // After a Host restart, the agent and each name find their Sessions again.
    expect((await sessions(undefined, [temporary]).agent(CLAUDE, scratch, signal)).id).toBe(shared.id)
    expect((await sessions(undefined, [temporary]).agent(CLAUDE, scratch, signal, 'BUILDER')).id).toBe(builder.id)
    expect(fakes.controller.create).toHaveBeenCalledTimes(3)
  })

  it('uses a game project registered there, and registers a folder outside the temporary folders', async () => {
    const temporary = join(root, 'tmp')
    await mkdir(join(temporary, 'kept', 'game'), { recursive: true })
    fakes.workspaces.push({ id: 'kept', path: join(temporary, 'kept'), sessionIds: [] })
    const store = sessions(undefined, [temporary])
    const kept = await store.agent(CLAUDE, join(temporary, 'kept', 'game'), signal)
    expect(fakes.workspaces[0]?.sessionIds).toEqual([kept.id])
    await store.agent(CLAUDE, join(root, 'game'), signal)
    expect(fakes.registry.create).toHaveBeenCalledTimes(1)
    expect(fakes.registry.create).toHaveBeenCalledWith(join(root, 'game'))
    expect(createRequests()).toEqual([{ workspaceId: 'kept' }, { workspaceId: 'w2' }])
  })

  it('finds a temporary folder that a symbolic link names, as /tmp names /private/tmp on macOS', async () => {
    const real = join(root, 'private', 'tmp')
    await mkdir(join(real, 'game'), { recursive: true })
    // A junction on Windows, which needs no privilege; other systems ignore the type.
    await symlink(real, join(root, 'tmp'), 'junction')
    const store = sessions(undefined, [join(root, 'tmp')])
    await store.agent(CLAUDE, join(root, 'tmp', 'game'), signal)
    await store.agent(CODEX, join(real, 'game'), signal)
    expect(fakes.registry.create).not.toHaveBeenCalled()
    expect(createRequests()).toEqual([{ cwd: join(real, 'game') }, { cwd: join(real, 'game') }])
  })

  it('creates a new Session when the remembered one was archived or no longer exists', async () => {
    const temporary = join(root, 'tmp')
    await mkdir(join(temporary, 'game'), { recursive: true })
    const store = sessions(undefined, [temporary])
    const first = await store.agent(CLAUDE, join(temporary, 'game'), signal)
    fakes.archivedSessionIds.push(first.id)
    const second = await store.agent(CLAUDE, join(temporary, 'game'), signal)
    expect(second.id).not.toBe(first.id)
    fakes.agents.delete(second.id)
    const third = await store.agent(CLAUDE, join(temporary, 'game'), signal)
    expect(third.id).not.toBe(second.id)
    expect(fakes.registry.create).not.toHaveBeenCalled()
  })
})
