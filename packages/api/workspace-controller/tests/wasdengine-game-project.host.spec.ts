/**
 * WASDEngine fork spec for game projects: the Create game project dialog's Host calls create a
 * folder with a Git repository and register it, and `defaultWorkspace: false` replaces the
 * first-use default Workspace with that dialog.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import WorkspaceController, { type Config } from '../src/index.ts'
import { GAME_PROJECTS_DIRECTORY, GameProjectController, type GitRunner } from '../src/wasdengine-game-project.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

const roots: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A Host context with the Workspace registry and Remote stubs, without the Workspace controller. */
async function registryHarness() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-game-project-')))
  tempDirs.push(root)
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)
  const dispose = (): void => {}
  ctx.provide('typert', {
    lookups: { configure: () => dispose },
    contexts: { configureHost: () => dispose },
    resources: { register: vi.fn(() => dispose) },
  } as never)
  new RemoteAccessService(ctx)
  return { ctx, root }
}

/** The registry harness with the Workspace controller, which mounts the game project controller. */
async function harness(config: Config = {}) {
  const { ctx, root } = await registryHarness()
  new WorkspaceController(ctx, { documentsDirectory: root, ...config })
  // The Workspace controller mounts the game project controller as its child plugin.
  const projects = await new Promise<GameProjectController>((resolve) => {
    ctx.inject(['gameProjectController'], (inner) => { resolve(inner.gameProjectController) })
  })
  return { ctx, root, projects }
}

async function failure(promise: Promise<unknown>): Promise<RemoteError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof RemoteError) return error
    throw error
  }
  throw new Error('expected a RemoteError')
}

const signal = (): AbortSignal => new AbortController().signal

describe('game project defaults', () => {
  it('suggests WASD Engine under Documents and requires a game project once the default Workspace is off', async () => {
    const { root, projects } = await harness()
    await expect(projects.defaults(signal())).resolves.toEqual({ directory: join(root, GAME_PROJECTS_DIRECTORY), required: false })

    const off = await harness({ defaultWorkspace: false })
    await expect(off.projects.defaults(signal())).resolves.toEqual({ directory: join(off.root, GAME_PROJECTS_DIRECTORY), required: true })
  })

  it('suggests no folder when the Documents lookup does not finish', async () => {
    const { ctx } = await registryHarness()
    const projects = new GameProjectController(ctx, { documentsLookupTimeoutMs: 1, required: true })
    await expect(projects.defaults(signal())).resolves.toEqual({ directory: null, required: true })
  })

  it('replaces the first-use default Workspace when it is off', async () => {
    const { ctx, root } = await harness({ defaultWorkspace: false })
    await expect(ctx.workspaceController.initializeDefault(signal())).resolves.toBeUndefined()
    expect(ctx.workspaceRegistry.list()).toEqual([])
    expect(existsSync(join(root, 'deepseek-harness'))).toBe(false)
  })
})

describe('game project creation', () => {
  it('creates the folder and its parent, commits once, and registers a Workspace titled with the name', async () => {
    const { ctx, root, projects } = await harness()
    const directory = join(root, GAME_PROJECTS_DIRECTORY)
    const result = await projects.create({ name: '  Space Frogs  ', directory }, signal())

    const path = join(directory, 'Space Frogs')
    expect(result).toMatchObject({ git: true, workspace: { path, title: 'Space Frogs' } })
    expect(ctx.workspaceRegistry.list().map(workspace => workspace.path)).toEqual([path])
    expect(execFileSync('git', ['-C', path, 'rev-list', '--count', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('1')
    expect(execFileSync('git', ['-C', path, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim()).toBe('Create Space Frogs')
    expect(existsSync(join(path, '.git', 'hooks'))).toBe(false)
  })

  it('refuses names that are not one portable folder name and parents that are not fully qualified', async () => {
    const { ctx, root, projects } = await harness()
    for (const name of ['', '   ', '.', '..', 'a/b', 'a\\b', 'level:1', 'ends.', 'tab\there', 'x'.repeat(256)]) {
      expect((await failure(projects.create({ name, directory: root }, signal()))).code).toBe('gameProject/invalid-name')
    }
    expect((await failure(projects.create({ name: 'Game', directory: 'relative/folder' }, signal()))).code)
      .toBe('gameProject/invalid-directory')
    expect(ctx.workspaceRegistry.list()).toEqual([])
  })

  it('refuses a taken path and reports a parent it cannot create', async () => {
    const { ctx, root, projects } = await harness()
    mkdirSync(join(root, 'Taken'))
    const taken = await failure(projects.create({ name: 'Taken', directory: root }, signal()))
    expect(taken.code).toBe('gameProject/exists')
    expect(taken.details).toEqual({ path: join(root, 'Taken') })

    writeFileSync(join(root, 'file'), '')
    const blocked = await failure(projects.create({ name: 'Game', directory: join(root, 'file', 'child') }, signal()))
    expect(blocked.code).toBe('gameProject/create-failed')
    expect(ctx.workspaceRegistry.list()).toEqual([])
  })

  it('registers the folder without a repository when Git is missing', async () => {
    const { ctx, root } = await registryHarness()
    const missing: GitRunner = () => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    const projects = new GameProjectController(ctx, { documentsLookupTimeoutMs: 1, required: true }, missing)
    await expect(projects.create({ name: 'No Git', directory: root }, signal())).resolves.toMatchObject({ git: false })
    expect(existsSync(join(root, 'No Git'))).toBe(true)
    expect(ctx.workspaceRegistry.list().map(workspace => workspace.title)).toEqual(['No Git'])
  })

  it('removes a repository that cannot commit, after a second attempt with its own identity', async () => {
    const { ctx, root } = await registryHarness()
    const commits: string[][] = []
    const failingCommit: GitRunner = async (args, cwd) => {
      if (args[0] === 'init') {
        mkdirSync(join(cwd, '.git'))
        return ''
      }
      commits.push([...args])
      throw new Error('commit failed')
    }
    const projects = new GameProjectController(ctx, { documentsLookupTimeoutMs: 1, required: true }, failingCommit)
    await expect(projects.create({ name: 'No Commit', directory: root }, signal())).resolves.toMatchObject({ git: false })
    expect(existsSync(join(root, 'No Commit', '.git'))).toBe(false)
    expect(commits.map(args => args.includes('user.email=noreply@wasdengine.com'))).toEqual([false, true])
    expect(ctx.workspaceRegistry.list().map(workspace => workspace.title)).toEqual(['No Commit'])
  })
})
