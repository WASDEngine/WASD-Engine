/**
 * The `game_addons` tool as the Session's agent calls it through the real tool runtime and executor, with an approval
 * service under the `ask` policy that records every question: the agent installs and removes add-ons without one. Its
 * searches keep to the application a query names and give every match of filters alone, in full in every project when
 * the descriptions fit, its guide results stay within the result limit, and its failures carry their class and code.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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
import ToolRuntime, { type ToolErrorInfo, type ToolExecutionResult, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { afterEach, describe, expect, it } from 'vitest'
import { loadCatalog, loadGuides } from '../src/catalog.ts'
import { GameAddonManager } from '../src/manager.ts'
import { MCP_WORDING } from '../src/mcp.ts'
import { gameAddonToolDefinition, SESSION_WORDING, TOOL_NAME, type GameAddonToolWording } from '../src/tools.ts'
import { editableCatalogEntries, fakeDownloads, guideText, scratch, URLS, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined
let ctx: Context | undefined

/** The `resultChars` of the plugin's default Config, which the tool of these specs keeps its results within. */
const RESULT_CHARS = 8192

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
    resultChars: RESULT_CHARS,
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

/** The class and code that a failed call records. */
function failure(result: ToolExecutionResult): ToolErrorInfo | undefined {
  return result.isError ? result.error.info : undefined
}

/** The length of a text in Unicode code points. */
function codePoints(value: string): number {
  return Array.from(value).length
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
      '2 matching add-ons:',
      '- test-camera: Test Camera 1.2.0 (Godot, MIT, 1 KB)',
      '  Virtual cameras that follow and frame targets.',
      '  Use when: The camera must follow a moving target with smoothing.',
      '  Skip when: A fixed Camera2D is enough.',
      '  Instead of: other-camera',
      '- other-camera: Other Camera 0.1 (Godot, MIT, 1 KB)',
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
    expect(named).toContain('1 matching add-on:\n- other-camera: Other Camera 0.1')
    expect(named).not.toContain('- test-camera:')
    const category = text(await call(state, { action: 'search', category: 'camera' }))
    expect(category).toContain('2 matching add-ons:')
    expect(category).not.toContain('test-trees')
    expect(text(await call(state, { action: 'search', category: 'testing' }))).toContain('No catalog add-on matches.')
  })

  it('keeps to the add-ons of the application that a query names, and gives the index for a query of common words alone', async () => {
    const state = await setup()
    for (const query of ['blender', 'blender add-ons', 'Blender addons', 'an add-on for Blender']) {
      const blender = text(await call(state, { action: 'search', query }))
      expect(blender, query).toMatch(/^2 matching add-ons:\n- test-rig: Test Rig 5\.2\.3 \(Blender,/u)
      expect(blender, query).toContain('\n- test-trees: Test Trees 2.0.0 (Blender,')
      expect(blender, query).not.toContain('camera')
    }
    const godot = text(await call(state, { action: 'search', query: 'godot plugin' }))
    expect(godot).toMatch(/^2 matching add-ons:\n- other-camera: /u)
    expect(godot).toContain('\n- test-camera: ')
    // Beside words that rank, the application still filters, and an explicit host wins over the query's.
    expect(text(await call(state, { action: 'search', query: 'blender rigging' }))).toMatch(/^1 matching add-on:\n- test-rig: /u)
    expect(text(await call(state, { action: 'search', query: 'blender camera' }))).toContain('No catalog add-on matches.')
    expect(text(await call(state, { action: 'search', host: 'godot', query: 'blender' }))).toMatch(/^2 matching add-ons:\n- other-camera: /u)
    // A query of common words, or one that names both applications, narrows nothing.
    for (const query of ['game', 'add-ons', 'a plugin for my game', 'godot blender']) {
      expect(text(await call(state, { action: 'search', query })), query).toMatch(/^The catalog's 4 add-ons for .*, under their categories/u)
    }
  })

  /** The numbers of the camera add-ons that {@link manyCameras} adds. */
  const CAMERA_NUMBERS = Array.from({ length: 12 }, (_, index) => index + 1)

  /** Twelve more camera add-ons, each described at the lengths the catalog allows, more than one result describes. */
  async function manyCameras(catalogDir: string): Promise<void> {
    for (const number of CAMERA_NUMBERS) {
      const id = `camera-${String(number)}`
      const entry = editableCatalogEntries()['other-camera'] as Record<string, unknown>
      delete entry.conflicts
      delete entry.credit
      Object.assign(entry, {
        id,
        title: `Camera ${String(number)}`,
        summary: 'Frames a moving target with smoothing and dead zones, '.repeat(4).slice(0, 200),
        useWhen: 'The camera must follow a moving target and keep it framed, '.repeat(6).slice(0, 300),
        avoidWhen: 'A fixed camera or one Camera3D child of the player is enough, '.repeat(6).slice(0, 300),
        godot: { addonDir: `camera_${String(number)}`, plugin: 'plugin.cfg' },
      })
      await mkdir(join(catalogDir, id))
      await writeFile(join(catalogDir, id, 'addon.json'), `${JSON.stringify(entry, null, 2)}\n`)
      await writeFile(join(catalogDir, id, 'SKILL.md'), guideText(id))
    }
  }

  it('gives every match of a search with filters alone, in full when they fit in one result and else under their category', async () => {
    const state = await setup(SESSION_WORDING, { catalog: manyCameras })
    expect((await call(state, { action: 'install', id: 'test-camera' })).isError).toBe(false)
    const cameras = text(await call(state, { action: 'search', category: 'camera' }))
    expect(cameras).toBe([
      `The 14 matching add-ons for ${state.project}, too many to describe in one result, under their categories, with what each is for:`,
      'Camera and game feel (camera)',
      // The catalog orders add-ons by title.
      ...[...CAMERA_NUMBERS].sort((a, b) => `Camera ${String(a)}`.localeCompare(`Camera ${String(b)}`, 'en')).map(number => `- camera-${String(number)}: another camera add-on`),
      '- other-camera: another camera add-on',
      '- test-camera: cameras that follow and frame targets [installed]',
      'Search with an add-on\'s id, or add words, for when it helps, when to skip it, its size, license, and conflicts; read its guide with action guide, or install it with action install.',
    ].join('\n'))
    // The matches in full would not fit, so none of them comes in full.
    expect(codePoints(cameras)).toBeLessThanOrEqual(RESULT_CHARS)
    expect(text(await call(state, { action: 'search', stage: 'prototype' }))).toMatch(/^1 matching add-on:\n- test-camera: Test Camera 1\.2\.0 \(Godot, MIT, 1 KB\) \[installed\]\n/u)
    const blender = text(await call(state, { action: 'search', host: 'blender' }))
    expect(blender).toMatch(/^2 matching add-ons:\n- test-rig: /u)
    // Words to rank by still give the best matches in full.
    expect(text(await call(state, { action: 'search', category: 'camera', query: 'camera' }))).toMatch(/^The best 8 of 14 matching add-ons; narrow the search/u)
  })

  it('describes the matches of filters alone in full in every project, with a note on each that the project has when the notes fit, else a count', async () => {
    const state = await setup()
    expect((await call(state, { action: 'install', id: 'test-camera' })).isError).toBe(false)
    /** The camera category's search result within a result limit, outside a project or in the setup's. */
    const search = async (limit: number, project?: string): Promise<string> => {
      const definition = gameAddonToolDefinition({
        manager: state.manager,
        guides: new Map(),
        resultChars: limit,
        project: () => project === undefined ? Promise.reject(new Error('No project.')) : Promise.resolve(project),
      }, SESSION_WORDING)
      const value = await definition.execute({ action: 'search', category: 'camera' }, { signal: new AbortController().signal } as ToolRunContext) as JsonValue
      return definition.output.render({}, value).map(block => block.type === 'text' ? block.text : '').join('')
    }
    const outside = await search(RESULT_CHARS)
    const lines = outside.split('\n')
    expect(lines[0]).toBe('2 matching add-ons:')
    const noted = outside.replace('- test-camera: Test Camera 1.2.0 (Godot, MIT, 1 KB)\n', '- test-camera: Test Camera 1.2.0 (Godot, MIT, 1 KB) [installed]\n')
    expect(noted).not.toBe(outside)
    expect(await search(codePoints(noted), state.project)).toBe(noted)
    // Where the note does not fit, one line counts what the project has, and the descriptions stay whole.
    expect(await search(codePoints(noted) - 1, state.project)).toBe([...lines.slice(0, -1), 'This project has 1 of them, which action list names.'].join('\n'))
    expect(await search(codePoints(noted) - 1)).toBe(outside)
    // Where the descriptions do not fit, every project gets the matches by cue.
    expect(await search(codePoints(outside))).toBe(outside)
    expect(await search(codePoints(outside) - 1)).toMatch(/^The 2 matching add-ons, too many to describe in one result/u)
    expect(await search(codePoints(outside) - 1, state.project)).toMatch(/^The 2 matching add-ons for .+, too many to describe/u)
  })

  it('shows a guide, noting when the project does not have the add-on yet', async () => {
    const state = await setup()
    expect(text(await call(state, { action: 'guide', id: 'test-trees' }))).toBe('Test Trees is not installed in this project; install it with action install before following this guide.\n\n# test-trees\n\nUse it like this.')
    const noId = await call(state, { action: 'guide' })
    expect(text(noId)).toContain('action guide needs id')
    expect(failure(noId)).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
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

  /** The start of the test trees' guide result, before the files it links: the note on its absence and its text. */
  const TREES_HEAD = 'Test Trees is not installed in this project; install it with action install before following this guide.\n\n# test-trees\n\nUse it like this.'

  /** A guide that links a short file and a long one, which do not both fit beside it in one result. */
  async function longLinks(catalogDir: string): Promise<void> {
    await writeFile(join(catalogDir, 'test-trees', 'SKILL.md'), guideText('test-trees', '\n\nThe kinds are in [references/kinds.md](references/kinds.md), the bark in [references/bark.md](references/bark.md).'))
    await mkdir(join(catalogDir, 'test-trees', 'references'))
    await writeFile(join(catalogDir, 'test-trees', 'references', 'kinds.md'), 'Oak and birch; preview them with `mcp__wasd_blender__render_preview`.\n')
    await writeFile(join(catalogDir, 'test-trees', 'references', 'bark.md'), `${'Rough oak bark. '.repeat(520)}\n`)
  }

  it('keeps a guide with the files it links within the result limit, and shows a file that did not fit by its reference', async () => {
    const state = await setup(MCP_WORDING, { catalog: longLinks })
    const guide = text(await call(state, { action: 'guide', id: 'test-trees' }))
    expect(guide).toBe([
      TREES_HEAD,
      'The kinds are in [references/kinds.md](references/kinds.md), the bark in [references/bark.md](references/bark.md).',
      'The file references/kinds.md, which this guide links:',
      'Oak and birch; preview them with `blender_render_preview`.',
      'The file references/bark.md, which this guide links, did not fit in this result; read it with action guide, id test-trees, and reference references/bark.md.',
    ].join('\n\n'))
    expect(text(await call(state, { action: 'guide', id: 'test-trees', reference: 'references/bark.md' })))
      .toBe(`The file references/bark.md, which the guide test-trees links:\n\n${'Rough oak bark. '.repeat(520).trim()}`)
    expect(text(await call(state, { action: 'guide', id: 'test-trees', reference: 'references/kinds.md' })))
      .toBe('The file references/kinds.md, which the guide test-trees links:\n\nOak and birch; preview them with `blender_render_preview`.')
    const unknown = await call(state, { action: 'guide', id: 'test-trees', reference: 'references/leaves.md' })
    expect(text(unknown)).toContain('the guide test-trees links no file "references/leaves.md"; it links references/kinds.md, references/bark.md.')
    expect(failure(unknown)).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    expect(failure(await call(state, { action: 'guide', id: 'test-camera', reference: 'references/kinds.md' }))).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
  })

  it('counts the result limit in code points, keeping a linked file that fills it exactly', async () => {
    const state = await setup(SESSION_WORDING, { catalog: async (catalogDir) => {
      await writeFile(join(catalogDir, 'test-trees', 'SKILL.md'), guideText('test-trees', '\n\nThe bark is in [references/bark.md](references/bark.md).'))
      await mkdir(join(catalogDir, 'test-trees', 'references'))
      await writeFile(join(catalogDir, 'test-trees', 'references', 'bark.md'), 'Bark.\n')
    } })
    const bark = join(dir!.root, 'catalog', 'test-trees', 'references', 'bark.md')
    const shown = `${TREES_HEAD}\n\nThe bark is in [references/bark.md](references/bark.md).\n\nThe file references/bark.md, which this guide links:\n\n`
    // Each tree is one code point and two UTF-16 units, so only a count in code points lets the file in.
    const room = RESULT_CHARS - codePoints(shown)
    await writeFile(bark, '🌳'.repeat(room))
    const full = text(await call(state, { action: 'guide', id: 'test-trees' }))
    expect(full).toBe(`${shown}${'🌳'.repeat(room)}`)
    expect(codePoints(full)).toBe(RESULT_CHARS)
    await writeFile(bark, '🌳'.repeat(room + 1))
    expect(text(await call(state, { action: 'guide', id: 'test-trees' }))).toMatch(/did not fit in this result; read it with action guide, id test-trees, and reference references\/bark\.md\.$/u)
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
    // The project sets its own smoothing after the installation, which the removal keeps and names.
    const godot = join(state.project, 'project.godot')
    await writeFile(godot, (await readFile(godot, 'utf8')).replace('general/smoothing=true', 'general/smoothing=false'))
    const removed = await call(state, { action: 'remove', id: 'test-camera' })
    expect(text(removed)).toBe([
      'Removed test-camera and its project.godot entries and notice. Its files moved to the backup .wasdengine/backups/test-camera/2026-11-11T12-00-00.000Z: addons/test_camera.',
      'The project changed these project.godot settings of the add-on since its installation, so they keep the project\'s values: [test_camera] general/smoothing.',
    ].join('\n'))
    expect((await state.manager.presence(state.project)).get('test-camera')).toEqual({ state: 'absent' })
    // A Blender add-on leaves no folder in the project, so its removal moves nothing to a backup.
    expect((await call(state, { action: 'install', id: 'test-trees' })).isError).toBe(false)
    expect(text(await call(state, { action: 'remove', id: 'test-trees' }))).toBe('Removed test-trees and its project.godot entries and notice.')
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
    expect(search).toContain('1 matching add-on:\n- other-camera: Other Camera 0.1 (Godot, MIT, 1 KB)\n')
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
    const unknown = await call(state, { action: 'install', id: 'nope' })
    expect(text(unknown)).toContain('No catalog add-on has the id "nope"')
    expect(failure(unknown)).toEqual({ name: 'GameAddonError', code: 'GAME_ADDON_NOT_FOUND' })
    expect(text(await call(state, { action: 'list', project: 'elsewhere' }))).toContain('No project.godot in elsewhere.')
  })

  it('records the class and code of each refusal, so that a result says why without its text', async () => {
    const state = await setup()
    expect((await call(state, { action: 'install', id: 'test-camera' })).isError).toBe(false)
    expect(failure(await call(state, { action: 'install', id: 'other-camera' }))).toEqual({ name: 'GameAddonError', code: 'GAME_ADDON_CONFLICT' })
    expect(failure(await call(state, { action: 'remove', id: 'test-rig' }))).toEqual({ name: 'GameAddonError', code: 'GAME_ADDON_NOT_INSTALLED' })
    expect(failure(await call(state, { action: 'install' }))).toEqual({ name: 'ToolArgsError', code: 'INVALID_ARGS' })
    state.off.add('test-trees')
    expect(failure(await call(state, { action: 'guide', id: 'test-trees' }))).toEqual({ name: 'GameAddonError', code: 'GAME_ADDON_PERMISSION_DENIED' })
    expect(failure(await call(state, { action: 'install', id: 'test-trees' }))).toEqual({ name: 'GameAddonError', code: 'GAME_ADDON_PERMISSION_DENIED' })
  })
})
