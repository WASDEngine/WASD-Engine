/**
 * The `game_addons` tool as the Session's agent calls it through the real tool runtime and executor, with an approval
 * service under the `ask` policy that records every question: the agent installs and removes add-ons without one.
 */
import { mkdir, writeFile } from 'node:fs/promises'
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
import { loadCatalog, loadGuides } from '../src/catalog.ts'
import { GameAddonManager } from '../src/manager.ts'
import { MCP_WORDING } from '../src/mcp.ts'
import { gameAddonToolDefinition, SESSION_WORDING, TOOL_NAME, type GameAddonToolWording } from '../src/tools.ts'
import { fakeDownloads, guideText, scratch, URLS, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

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
  /** Ids of the add-ons the user turned off; the manager reads it at every call. */
  readonly off: Set<string>
}

/** What a test changes in the catalog folder before it loads, and the guides that go with the add-ons. */
interface SetupOptions {
  readonly catalog?: (catalogDir: string) => Promise<void>
  readonly guides?: (root: string) => Promise<readonly string[]>
}

async function setup(wording: GameAddonToolWording = SESSION_WORDING, options: SetupOptions = {}): Promise<Setup> {
  dir = await scratch('tools')
  const catalogDir = await writeCatalog(dir.root)
  await options.catalog?.(catalogDir)
  const catalog = await loadCatalog(catalogDir)
  const guides = await loadGuides(await options.guides?.(dir.root) ?? [], catalog)
  const project = await writeProject(join(dir.root, 'work', 'game'))
  const downloads = fakeDownloads()
  const off = new Set<string>()
  const manager = new GameAddonManager({
    catalog,
    downloads: { cacheDir: join(dir.root, 'archives'), fetch: downloads.fetch },
    blenderStore: join(dir.root, 'store'),
    assetsDir: join(dir.root, 'assets'),
    importProject: () => Promise.resolve({ issues: ['res://player.gd:4: Parse Error: x'] }),
    now: () => new Date('2026-11-11T12:00:00Z'),
    changed: () => {},
    allowed: id => !off.has(id),
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
    guides,
    project: async (requested) => {
      if (requested === undefined || requested === 'game') return project
      throw new Error(`No project.godot in ${requested}.`)
    },
  }, wording))
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
  return { manager, project, agent, downloads: downloads.requests, asked, off }
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
      'Curated add-ons for the game, WASD Engine\'s own and third-party ones, each pinned to a version tested with this Godot (GDScript only, so Web releases keep working) or Blender: lighting, sky, weather, terrain, water, grass, scattering, roads, and dungeons; materials, effects, light shafts, mirrors, trails, fur, surface marks, and screen looks; humans, rigs, animations, a character controller, and crowds; cloth, ropes, ragdolls, vehicles, and destruction; AI, state charts, dialogue, and inventories; cameras and shake; menus, HUD, loading screens, and button prompts; 2D levels; starter kits; texture baking; and tests. '
      + 'action search without words gives the catalog\'s index, a few words on every add-on by category; with an add-on\'s id, a category, or words it says when each match helps, when to skip it, and whether the project has it. guide shows an add-on\'s usage guide, or a guide that a search without words lists; install adds one to the project; remove takes one out of the project; list shows the project\'s add-ons. '
      + 'Install an add-on yourself, without asking the user first, when the game needs what it does and Godot or Blender alone would take much longer; then tell the user what you added and its license.',
    )
  })

  it('searches the catalog with each add-on\'s presence and use', async () => {
    const state = await setup()
    const result = await call(state, { action: 'search', query: 'camera smoothing' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      '2 matching add-ons for ' + state.project + ':',
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
    expect(text(await call(state, { action: 'search', query: 'zzz' }))).toBe('No catalog add-on matches. Search with other words, or without a query for the catalog\'s index; Godot and Blender may already do this without an add-on.')
    expect(text(await call(state, { action: 'search', host: 'blender', project: 'elsewhere' }))).toContain('- test-rig: Test Rig 5.2.3 (Blender, GPL-2.0-or-later, ships inside Blender)\n')
  })

  it('gives the catalog\'s index for a search without words or filters, with what the project has', async () => {
    const state = await setup()
    expect((await call(state, { action: 'install', id: 'test-camera' })).isError).toBe(false)
    expect(text(await call(state, { action: 'search' }))).toBe([
      `The catalog's 4 add-ons for ${state.project}, under their categories, with what each is for:`,
      'Environment: lighting, sky, weather, terrain, water, grass, trees, scattering, roads, dungeons, level layout (environment)',
      '- test-trees (Blender): procedural low-poly trees',
      'Characters: humans, rigs, animation clips, movement, faces, crowds (characters)',
      '- test-rig (Blender): control rigs for characters',
      'Camera and game feel (camera)',
      '- other-camera: another camera add-on',
      '- test-camera: cameras that follow and frame targets [installed]',
      'Search with an add-on\'s id, a category, or words for when it helps, when to skip it, its size, license, and conflicts; read its guide with action guide, or install it with action install.',
    ].join('\n'))
    // Blank words are no words.
    expect(text(await call(state, { action: 'search', query: '  ' }))).toContain('under their categories')
  })

  it('describes one add-on for its id, and a category\'s add-ons for the category', async () => {
    const state = await setup()
    const named = text(await call(state, { action: 'search', query: 'other-camera' }))
    expect(named).toContain(`1 matching add-on for ${state.project}:\n- other-camera: Other Camera 0.1`)
    expect(named).not.toContain('- test-camera:')
    const category = text(await call(state, { action: 'search', category: 'camera' }))
    expect(category).toContain(`2 matching add-ons for ${state.project}:`)
    expect(category).not.toContain('test-trees')
    expect(text(await call(state, { action: 'search', category: 'testing' }))).toContain('No catalog add-on matches.')
  })

  it('shows a guide, noting when the project does not have the add-on yet', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'guide', id: 'test-trees' }))).toBe('Test Trees is not installed in this project; install it with action install before following this guide.\n\n# test-trees\n\nUse it like this.')
    expect(text(await call(state, { action: 'guide' }))).toContain('action guide needs id')
  })

  /** A Blender guide that links a file of its folder and names a Blender tool as a Session lists it. */
  async function linkingGuide(catalogDir: string): Promise<void> {
    await writeFile(join(catalogDir, 'test-trees', 'SKILL.md'), guideText('test-trees', '\n\nRun it with `mcp__wasd_blender__execute_python`; the kinds are in [references/kinds.md](references/kinds.md).'))
    await mkdir(join(catalogDir, 'test-trees', 'references'))
    await writeFile(join(catalogDir, 'test-trees', 'references', 'kinds.md'), '# Kinds\n\nOak and birch; preview them with `mcp__wasd_blender__render_preview`.\n')
  }

  it('shows a guide with the files of its folder that it links, which its reader cannot open through the link', async () => {
    const state = await setup(SESSION_WORDING, { catalog: linkingGuide })
    expect(text(await call(state, { action: 'guide', id: 'test-trees' }))).toBe([
      'Test Trees is not installed in this project; install it with action install before following this guide.',
      '# test-trees',
      'Use it like this.',
      'Run it with `mcp__wasd_blender__execute_python`; the kinds are in [references/kinds.md](references/kinds.md).',
      'The file references/kinds.md, which this guide links:',
      '# Kinds',
      'Oak and birch; preview them with `mcp__wasd_blender__render_preview`.',
    ].join('\n\n'))
  })

  it('names the Blender tools as a connected agent calls them, in guides and in a Blender add-on\'s installation note', async () => {
    const state = await setup(MCP_WORDING, { catalog: linkingGuide })
    const guide = text(await call(state, { action: 'guide', id: 'test-trees' }))
    expect(guide).toContain('Run it with `blender_execute_python`; the kinds are in [references/kinds.md](references/kinds.md).')
    expect(guide).toContain('Oak and birch; preview them with `blender_render_preview`.')
    expect(guide).not.toContain('mcp__')
    const installed = text(await call(state, { action: 'install', id: 'test-rig' }))
    expect(installed).toContain('In each Blender Session, run `import wasd_addons; wasd_addons.enable("test-rig")` with blender_execute_python before using Test Rig.')
    expect(installed).not.toContain('mcp__')
  })

  /** A guide that goes with the add-ons, naming two of them, linking a file of its folder, and naming a Blender tool. */
  async function lookGuide(root: string): Promise<readonly string[]> {
    const folder = join(root, 'guides', 'test-look')
    await mkdir(join(folder, 'references'), { recursive: true })
    await writeFile(join(folder, 'SKILL.md'), '---\nname: test-look\ndescription: Make a game look finished. Read it before building its look.\n---\n\n# Look\n\nFrame it with `test-camera` or `other-camera`, check it with `mcp__wasd_blender__render_preview`, and see [references/steps.md](references/steps.md).\n')
    await writeFile(join(folder, 'references', 'steps.md'), 'Light first.\n')
    return [join(folder, 'SKILL.md')]
  }

  it('lists the guides that go with the add-ons after the index, shows one by its name, and names the add-ons in it that the user turned off', async () => {
    const state = await setup(MCP_WORDING, { guides: lookGuide })
    expect(text(await call(state, { action: 'search' }))).toMatch(/install it with action install\.\nBefore the work each of these guides is for, read it with action guide and its name as id:\n- test-look: Make a game look finished\. Read it before building its look\.$/u)
    const look = await call(state, { action: 'guide', id: 'test-look' })
    expect(look.isError).toBe(false)
    expect(text(look)).toBe('# Look\n\nFrame it with `test-camera` or `other-camera`, check it with `blender_render_preview`, and see [references/steps.md](references/steps.md).\n\nThe file references/steps.md, which this guide links:\n\nLight first.')
    state.off.add('test-camera')
    expect(text(await call(state, { action: 'guide', id: 'test-look' }))).toMatch(/^The user turned off test-camera in WASD Engine's Add-ons dialog, so agents cannot use it: do its steps without it\.\n\n# Look\n/u)
    state.off.add('other-camera')
    expect(text(await call(state, { action: 'guide', id: 'test-look' }))).toMatch(/^The user turned off other-camera, test-camera in WASD Engine's Add-ons dialog, so agents cannot use them: do their steps without them\.\n\n/u)
    expect(state.asked).toEqual([])
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
    expect(text(removed)).toBe('Removed test-camera and its project.godot entries and notice. Its files moved to the backup .wasdengine/backups/test-camera/2026-11-11T12-00-00.000Z: addons/test_camera.')
    expect((await state.manager.presence(state.project)).get('test-camera')).toEqual({ state: 'absent' })
    expect(state.asked).toEqual([])
  })

  it('points a connected agent to an installed add-on\'s guide through the guide action, since it has no skills', async () => {
    const state = await setup(MCP_WORDING)
    expect(text(await call(state, { action: 'install', id: 'test-camera' }))).toBe([
      `Installed Test Camera 1.2.0 (MIT) in ${state.project}: addons/test_camera.`,
      'Read its guide with action guide and id test-camera before using the add-on.',
      'Tell the user that you added it and why, with its license.',
      'The project\'s import reported:\n- res://player.gd:4: Parse Error: x',
    ].join('\n'))
    expect(text(await call(state, { action: 'list' }))).toContain(`${state.project} has 1 catalog add-on; read each one's guide with action guide:\n- test-camera:`)
  })

  it('reports an add-on that is already installed without asking the model to tell the user again', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'install', id: 'test-rig' }))).toContain('Tell the user that you added it')
    const again = text(await call(state, { action: 'install', id: 'test-rig' }))
    expect(again).toContain('Test Rig 5.2.3 was already installed')
    expect(again).not.toContain('Tell the user')
    expect(state.asked).toEqual([])
  })

  it('hides an add-on that the user turned off from searches, refuses its guide and installation, and marks it in the list', async () => {
    const state = await setup()
    expect((await call(state, { action: 'install', id: 'test-camera' })).isError).toBe(false)
    state.off.add('test-camera')
    const refusal = 'The user turned Test Camera (test-camera) off in WASD Engine\'s Add-ons dialog, so agents cannot use it. Do the work without it, or ask the user to turn it on there.'
    const search = text(await call(state, { action: 'search', query: 'camera smoothing' }))
    expect(search).toContain(`1 matching add-on for ${state.project}:\n- other-camera: Other Camera 0.1 (Godot, MIT, 1 KB) [not installed]\n`)
    expect(search).not.toContain('- test-camera:')
    const guide = await call(state, { action: 'guide', id: 'test-camera' })
    expect(guide.isError).toBe(true)
    expect(text(guide)).toContain(refusal)
    expect(text(await call(state, { action: 'install', id: 'test-camera' }))).toContain(refusal)
    expect(text(await call(state, { action: 'list' }))).toContain(`${state.project} has 1 catalog add-on; each one's guide is listed as the skill of its id, except the ones the user turned off, which agents cannot use:\n- test-camera: Test Camera 1.2.0 (Godot, MIT, 1 KB) [installed, turned off by the user]\n`)
    expect(text(await call(state, { action: 'remove', id: 'test-camera' }))).toContain('Removed test-camera')
    for (const id of ['other-camera', 'test-rig', 'test-trees']) state.off.add(id)
    expect(text(await call(state, { action: 'search' }))).toBe('The user turned off every catalog add-on in WASD Engine\'s Add-ons dialog, so agents cannot use any. Do the work without add-ons, or ask the user to turn the ones it needs on there.')
    expect(state.asked).toEqual([])
  })

  it('reports an unknown id and a missing project as tool errors', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'install', id: 'nope' }))).toContain('No catalog add-on has the id "nope"')
    expect(text(await call(state, { action: 'list', project: 'elsewhere' }))).toContain('No project.godot in elsewhere.')
  })
})
