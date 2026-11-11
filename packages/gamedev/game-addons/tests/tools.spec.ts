/**
 * The `game_addons` tool as the Session's agent calls it through the real tool runtime and executor, with a fake
 * approval service that records each question and answers as the user would.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { GameAddonManager } from '../src/manager.ts'
import { approvalQuestion, gameAddonToolDefinition, registerApproval, SESSION_WORDING, TOOL_NAME } from '../src/tools.ts'
import { entriesWithTreeAssets, fakeDownloads, scratch, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await dir?.cleanup()
  dir = undefined
})

interface Setup {
  readonly manager: GameAddonManager
  readonly project: string
  readonly agent: Agent
  readonly asked: ApprovalRequest[]
  /** Answer of the fake user; `never` sets that policy instead. */
  answer: ApprovalOutcome | 'never'
}

async function setup(): Promise<Setup> {
  dir = await scratch('tools')
  const catalog = await loadCatalog(await writeCatalog(dir.root))
  const project = await writeProject(join(dir.root, 'work', 'game'))
  const manager = new GameAddonManager({
    catalog,
    downloads: { cacheDir: join(dir.root, 'archives'), fetch: fakeDownloads().fetch },
    blenderStore: join(dir.root, 'store'),
    assetsDir: join(dir.root, 'assets'),
    importProject: () => Promise.resolve({ issues: ['res://player.gd:4: Parse Error: x'] }),
    now: () => new Date('2026-11-11T12:00:00Z'),
    changed: () => {},
  })
  ctx = new Context()
  provideWorkingDirectoryFixture(ctx, join(dir.root, 'work'))
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  const state: Setup = { manager, project, agent: undefined as never, asked: [], answer: 'allowed-once' }
  ctx.provide('approval', {
    config: { policy: 'ask' },
    overrideOf: () => state.answer === 'never' ? 'never' : undefined,
    request(req: ApprovalRequest): Promise<ApprovalOutcome> {
      state.asked.push(req)
      return Promise.resolve(state.answer === 'never' ? 'rejected' : state.answer)
    },
  } as never)
  ctx.tools.register(gameAddonToolDefinition({
    manager,
    project: async (requested) => {
      if (requested === undefined || requested === 'game') return project
      throw new Error(`No project.godot in ${requested}.`)
    },
  }, SESSION_WORDING))
  registerApproval(ctx, manager, () => Promise.resolve('game'))
  const scope = ctx.plugin(() => {})
  const route = { provider: 'test', model: 'm' }
  const selection: Model = { current: () => route, select: () => {} }
  const agent: Agent = {
    id: SessionId('owner'), options: {}, session: Session.create(SessionId('owner')), model: selection, inbox: createInboxStub(), status: 'idle', ctx: scope.ctx,
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(agent)
  return Object.assign(state, { agent })
}

let calls = 0

function call(state: Setup, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(ctx!, { signal: new AbortController().signal, callId: ToolCallId(`addons-${calls}`), name: TOOL_NAME, arguments: args, agent: state.agent })
}

function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('game_addons', () => {
  it('searches the catalog with each add-on\'s presence and use, without asking the user', async () => {
    const state = await setup()
    const result = await call(state, { action: 'search', query: 'camera smoothing' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      '2 of 4 catalog add-ons for ' + state.project + ':',
      '- test-camera: Test Camera 1.2.0 (Godot, MIT, 1 KB) [not installed]',
      '  Virtual cameras that follow and frame targets.',
      '  Use when: The camera must follow a moving target with smoothing.',
      '  Skip when: A fixed Camera2D is enough.',
      '  Instead of: other-camera',
      '- other-camera: Other Camera 0.1 (Godot, MIT, 1 KB) [not installed]',
      '  Another camera add-on.',
      '  Use when: Never in tests.',
      '  Instead of: test-camera',
      '  Required credit: Other Camera by Other',
      'Read one with action guide, or install it with action install; tell the user its license first.',
    ].join('\n'))
    expect(await call(state, { action: 'search', query: 'zzz' })).toMatchObject({ isError: false })
    expect(text(await call(state, { action: 'search', host: 'blender', project: 'elsewhere' }))).toContain('- test-rig: Test Rig 5.2.3 (Blender, GPL-2.0-or-later, ships inside Blender)\n')
    expect(state.asked).toEqual([])
  })

  it('shows a guide, noting when the project does not have the add-on yet', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'guide', id: 'test-trees' }))).toBe('Test Trees is not installed in this project; install it with action install before following this guide.\n\n# test-trees\n\nUse it like this.')
    expect(text(await call(state, { action: 'guide' }))).toContain('action guide needs id')
  })

  it('asks the user before installing and removing, naming the add-on, its license, download, and project', async () => {
    const state = await setup()
    const installed = await call(state, { action: 'install', id: 'test-camera' })
    expect(installed.isError).toBe(false)
    expect(state.asked.map(request => [request.toolName, request.reason])).toEqual([[TOOL_NAME,
      'Install Test Camera 1.2.0 (MIT, https://example.test/camera) into the game project game? It downloads 1 KB from example.test. '
      + 'Its scripts become part of the game and run whenever the project is imported or played.']])
    expect(text(installed)).toBe([
      `Installed Test Camera 1.2.0 (MIT) in ${state.project}: addons/test_camera.`,
      'Its guide is now the skill test-camera; load it before using the add-on.',
      'The project\'s import reported:\n- res://player.gd:4: Parse Error: x',
    ].join('\n'))
    expect(text(await call(state, { action: 'list' }))).toContain(`${state.project} has 1 catalog add-on; each one's guide is listed as the skill of its id:\n- test-camera: Test Camera 1.2.0 (Godot, MIT, 1 KB) [installed]`)
    const removed = await call(state, { action: 'remove', id: 'test-camera' })
    expect(text(removed)).toBe('Removed test-camera: deleted addons/test_camera, and its project.godot entries and notice.')
    expect(state.asked[1]?.reason).toBe('Remove Test Camera from the game project game? This deletes addons/test_camera and its project.godot entries; scenes and scripts that use it stop working.')
  })

  it('installs nothing when the user rejects, and asks nobody under the never policy', async () => {
    const state = await setup()
    state.answer = 'rejected'
    const rejected = await call(state, { action: 'install', id: 'test-rig' })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toContain('the user rejected tool "game_addons"')
    expect((await state.manager.presence(state.project)).get('test-rig')).toEqual({ state: 'absent' })
    state.answer = 'never'
    const asked = state.asked.length
    expect((await call(state, { action: 'install', id: 'test-rig' })).isError).toBe(false)
    expect(state.asked).toHaveLength(asked)
    expect(text(await call(state, { action: 'install', id: 'test-rig' }))).toContain('Test Rig 5.2.3 was already installed')
  })

  it('reports an unknown id and a missing project as tool errors', async () => {
    const state = await setup()
    state.answer = 'never'
    expect(text(await call(state, { action: 'install', id: 'nope' }))).toContain('No catalog add-on has the id "nope"')
    expect(text(await call(state, { action: 'list', project: 'elsewhere' }))).toContain('No project.godot in elsewhere.')
  })
})

describe('approvalQuestion', () => {
  it('names the credit a license requires and what a Blender add-on does', async () => {
    const state = await setup()
    expect(approvalQuestion(state.manager, { action: 'install', id: 'other-camera' }, undefined)).toBe(
      'Install Other Camera 0.1 (MIT, https://example.test/other) into the game project? It downloads 1 KB from example.test. '
      + 'Its scripts become part of the game and run whenever the project is imported or played. Its license requires a credit in the game: Other Camera by Other.',
    )
    expect(approvalQuestion(state.manager, { action: 'install', id: 'test-rig' }, 'game')).toBe(
      'Install Test Rig 5.2.3 (GPL-2.0-or-later, https://example.test/rig) into the game project game? It ships inside Blender, so nothing is downloaded. Its Python code runs inside Blender when the agent enables it.',
    )
    expect(approvalQuestion(state.manager, { action: 'remove', id: 'test-trees' }, 'game')).toBe(
      'Remove Test Trees from the game project game? Its guide leaves the project; the Blender add-on stays downloaded for other projects.',
    )
    expect(approvalQuestion(state.manager, { action: 'install', id: 'nope' }, 'game')).toBeUndefined()
  })

  it('names an asset pack that comes with an add-on, its license, and its download', async () => {
    const manager = new GameAddonManager({
      catalog: await loadCatalog(await catalogWithSetup()),
      downloads: { cacheDir: join(dir!.root, 'archives'), fetch: fakeDownloads().fetch },
      blenderStore: join(dir!.root, 'store'),
      assetsDir: join(dir!.root, 'assets'),
      importProject: () => Promise.resolve(undefined),
      now: () => new Date(),
      changed: () => {},
    })
    expect(approvalQuestion(manager, { action: 'install', id: 'test-trees' }, 'game')).toBe(
      'Install Test Trees 2.0.0 (GPL-3.0-or-later, https://example.test/trees) into the game project game? It downloads 1 KB from example.test. '
      + 'With it comes an asset pack (CC0-1.0, https://assets.example.test/): 1 KB from assets.example.test. Its Python code runs inside Blender when the agent enables it.',
    )
  })
})

async function catalogWithSetup(): Promise<string> {
  dir ??= await scratch('tools')
  const catalogDir = await writeCatalog(join(dir.root, 'assets-catalog'), entriesWithTreeAssets())
  await writeFile(join(catalogDir, 'test-trees', 'setup.py'), 'def setup(module, assets):\n    pass\n')
  return catalogDir
}
