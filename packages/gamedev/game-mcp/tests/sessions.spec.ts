/**
 * A connected agent gets one Session per game project: the registration that contains the named folder, or a new
 * one for it, holds the Session, which is created once, remembered across restarts, and recreated when it is gone.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GameMcpClient } from '../src/provider.ts'
import { ExternalSessions, GameMcpSessionError } from '../src/sessions.ts'

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
    create: vi.fn(async ({ workspaceId }: { workspaceId: string }) => {
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

function sessions(file = join(root, 'data', 'sessions.json')): ExternalSessions {
  return new ExternalSessions(ctx, file)
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

  it('uses the nearest registered game project that contains the folder, and gives each agent its own Session', async () => {
    fakes.workspaces.push({ id: 'outer', path: root, sessionIds: [] }, { id: 'inner', path: join(root, 'game'), sessionIds: [] })
    const store = sessions()
    const claude = await store.agent(CLAUDE, join(root, 'game', 'nested'), signal)
    const codex = await store.agent(CODEX, join(root, 'game', 'nested'), signal)
    expect(fakes.registry.create).not.toHaveBeenCalled()
    expect(fakes.workspaces[1]?.sessionIds).toEqual([claude.id, codex.id])
    expect(claude.id).not.toBe(codex.id)
  })

  it('creates one Session for concurrent first calls', async () => {
    fakes.workspaces.push({ id: 'game', path: join(root, 'game'), sessionIds: [] })
    const store = sessions()
    const agents = await Promise.all([1, 2, 3].map(() => store.agent(CLAUDE, join(root, 'game'), signal)))
    expect(new Set(agents.map(agent => agent.id)).size).toBe(1)
    expect(fakes.controller.create).toHaveBeenCalledTimes(1)
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
    await expect(new ExternalSessions(bare, join(root, 'sessions.json')).agent(CLAUDE, root, signal)).rejects.toThrow('keeps no game projects')
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
})
