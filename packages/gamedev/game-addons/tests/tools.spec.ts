/**
 * The `game_addons` tool as the Session's agent calls it through the real tool runtime and executor, with an approval
 * service under the `ask` policy that records every question: the agent installs and removes add-ons without one.
 */
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
import { gameAddonToolDefinition, SESSION_WORDING, TOOL_NAME } from '../src/tools.ts'
import { fakeDownloads, scratch, URLS, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

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
  readonly downloads: string[]
  /** Every question the approval service received. */
  readonly asked: ApprovalRequest[]
}

async function setup(): Promise<Setup> {
  dir = await scratch('tools')
  const catalog = await loadCatalog(await writeCatalog(dir.root))
  const project = await writeProject(join(dir.root, 'work', 'game'))
  const downloads = fakeDownloads()
  const manager = new GameAddonManager({
    catalog,
    downloads: { cacheDir: join(dir.root, 'archives'), fetch: downloads.fetch },
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
  const asked: ApprovalRequest[] = []
  ctx.provide('approval', {
    config: { policy: 'ask' },
    overrideOf: () => undefined,
    request(req: ApprovalRequest): Promise<ApprovalOutcome> {
      asked.push(req)
      return Promise.resolve('rejected')
    },
  } as never)
  ctx.tools.register(gameAddonToolDefinition({
    manager,
    project: async (requested) => {
      if (requested === undefined || requested === 'game') return project
      throw new Error(`No project.godot in ${requested}.`)
    },
  }, SESSION_WORDING))
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
  return { manager, project, agent, downloads: downloads.requests, asked }
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
  it('tells the model what kinds of add-ons there are and to install what the game needs without asking the user', async () => {
    await setup()
    expect(ctx!.tools.get(TOOL_NAME)?.description).toBe(
      'Curated third-party add-ons for the game, each pinned to a version tested with this Godot (GDScript only, so Web releases keep working) or Blender: cameras, dialogue, behavior trees, state charts, inventories, unit tests, tile terrain, procedural maps, importers for Tiled, LDtk, and sprite editors, screen shake, sky, scattering, and for Blender rigging, humans, trees, landscapes, and VRM. '
      + 'action search finds add-ons for a need and says when each helps, when to skip it, and whether the project has it; guide shows an add-on\'s usage guide; install adds one to the project; remove deletes one; list shows the project\'s add-ons. '
      + 'Install an add-on yourself, without asking the user first, when the game needs what it does and Godot or Blender alone would take much longer; then tell the user what you added and its license.',
    )
  })

  it('searches the catalog with each add-on\'s presence and use', async () => {
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
      'Read one with action guide, or install it with action install.',
    ].join('\n'))
    expect(await call(state, { action: 'search', query: 'zzz' })).toMatchObject({ isError: false })
    expect(text(await call(state, { action: 'search', host: 'blender', project: 'elsewhere' }))).toContain('- test-rig: Test Rig 5.2.3 (Blender, GPL-2.0-or-later, ships inside Blender)\n')
  })

  it('shows a guide, noting when the project does not have the add-on yet', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'guide', id: 'test-trees' }))).toBe('Test Trees is not installed in this project; install it with action install before following this guide.\n\n# test-trees\n\nUse it like this.')
    expect(text(await call(state, { action: 'guide' }))).toContain('action guide needs id')
  })

  it('installs and removes an add-on without asking the user under the ask policy, and asks the model to tell the user', async () => {
    const state = await setup()
    const installed = await call(state, { action: 'install', id: 'test-camera' })
    expect(installed.isError).toBe(false)
    expect(text(installed)).toBe([
      `Installed Test Camera 1.2.0 (MIT) in ${state.project}: addons/test_camera.`,
      'Its guide is now the skill test-camera; load it before using the add-on.',
      'Tell the user that you added it and why, with its license.',
      'The project\'s import reported:\n- res://player.gd:4: Parse Error: x',
    ].join('\n'))
    expect(state.downloads).toEqual([URLS.camera])
    expect(text(await call(state, { action: 'list' }))).toContain(`${state.project} has 1 catalog add-on; each one's guide is listed as the skill of its id:\n- test-camera: Test Camera 1.2.0 (Godot, MIT, 1 KB) [installed]`)
    const removed = await call(state, { action: 'remove', id: 'test-camera' })
    expect(text(removed)).toBe('Removed test-camera: deleted addons/test_camera, and its project.godot entries and notice.')
    expect((await state.manager.presence(state.project)).get('test-camera')).toEqual({ state: 'absent' })
    expect(state.asked).toEqual([])
  })

  it('reports an add-on that is already installed without asking the model to tell the user again', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'install', id: 'test-rig' }))).toContain('Tell the user that you added it')
    const again = text(await call(state, { action: 'install', id: 'test-rig' }))
    expect(again).toContain('Test Rig 5.2.3 was already installed')
    expect(again).not.toContain('Tell the user')
    expect(state.asked).toEqual([])
  })

  it('reports an unknown id and a missing project as tool errors', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'install', id: 'nope' }))).toContain('No catalog add-on has the id "nope"')
    expect(text(await call(state, { action: 'list', project: 'elsewhere' }))).toContain('No project.godot in elsewhere.')
  })
})
