/**
 * The game add-ons plugin loaded into a Host composition with the real system prompt, tool runtime, executor, Agent
 * registry, skill registry, `skill` tool, and Remote registry: the system prompt lists the catalog, the Session's agent
 * installs and removes add-ons under the `ask` approval policy without a question to the user, a Session in a game
 * project sees an add-on's guide only once the add-on is installed and loads it through the `skill` tool, an add-on
 * that the user turned off stays out of the prompt, the tool, the guides, and the Blender index, and the plugin's tool,
 * prompt section, guides, and game MCP provider leave with its fiber.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as ToolSkill from '@deepseek-ai/dsh-tool-skill'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime, { type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import GameAddons, { STORE_INDEX, TOOL_NAME } from '../src/index.ts'
import { STORE_SETUP_DIR } from '../src/manager.ts'
import { PROMPT_SECTION, sessionPrompt } from '../src/prompt.ts'
import { editableCatalogEntries, entriesWithTreeAssets, fakeDownloads, scratch, URLS, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined
let ctx: Context | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx?.fiber.dispose()
  ctx = undefined
  await dir?.cleanup()
  dir = undefined
})

const signal = new AbortController().signal

/**
 * @param catalogDir - the catalog folder; the test catalog by default.
 * @param before - runs with the configuration before the plugin starts, such as to leave a store from an earlier version.
 * @param allowed - the user's switches; every add-on is on by default.
 * @param guides - the `SKILL.md` files of the guides that go with the add-ons; none by default.
 */
async function compose(
  catalogDir?: string,
  before?: (config: { readonly blenderStore: string }) => Promise<void>,
  allowed?: Record<string, boolean>,
  guides?: readonly string[],
) {
  dir = await scratch('compose')
  const project = await writeProject(join(dir.root, 'work', 'game'))
  const downloads = fakeDownloads()
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => downloads.fetch(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, init?.signal ?? signal))
  ctx = new Context()
  provideWorkingDirectoryFixture(ctx, project)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(ToolSkill)
  const imports: string[] = []
  ctx.provide('godot', { importProject: (projectDir: string) => { imports.push(projectDir); return Promise.resolve({ issues: [] }) } } as never)
  const asked: ApprovalRequest[] = []
  ctx.provide('approval', { config: { policy: 'ask' }, overrideOf: () => undefined, request: (request: ApprovalRequest) => { asked.push(request); return Promise.resolve('rejected') } } as never)
  const providers: string[] = []
  const instructions = new Map<string, string | undefined>()
  ctx.provide('gameMcp', {
    provide: (provider: { id: string; instructions?: string }) => {
      providers.push(provider.id)
      instructions.set(provider.id, provider.instructions)
      return () => { providers.splice(providers.indexOf(provider.id), 1) }
    },
  } as never)
  const config = { catalogDir: catalogDir ?? await writeCatalog(dir.root), dataRoot: join(dir.root, 'data'), blenderStore: join(dir.root, 'data', 'blender') }
  await before?.(config)
  // The fiber resolves the raw configuration, which turns `allowed` into its live reference.
  const fiber = ctx.plugin(GameAddons, {
    ...config, ...allowed === undefined ? {} : { allowed }, ...guides === undefined ? {} : { guides: [...guides] },
  })
  await fiber
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
  return { ctx, fiber, project, agent, downloads, imports, config, providers, instructions, asked }
}

/** The text of the plugin's system prompt section, or undefined when the prompt has none. */
async function promptSection(context: Context): Promise<string | undefined> {
  return (await context.systemPrompt.assemble()).sections.find(section => section.name === PROMPT_SECTION)?.text
}

let calls = 0

function call(context: Context, agent: Agent, name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> {
  calls += 1
  return executeToolFixture(context, { signal, callId: ToolCallId(`compose-${calls}`), name, arguments: args, agent })
}

function text(result: ToolExecutionResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

async function guideNames(context: Context, project: string, agent: Agent): Promise<string[]> {
  return (await context.skills.list({ cwd: project, scope: agent })).filter(skill => skill.provider === 'game-addons').map(skill => skill.name)
}

describe('game add-ons plugin', () => {
  it('lists the whole catalog in the system prompt', async () => {
    const { ctx: context, config } = await compose()
    expect(await promptSection(context)).toBe(sessionPrompt((await loadCatalog(config.catalogDir)).entries))
  })

  it('lists an add-on\'s guide only after an installation that asked nobody, loads it through the skill tool, and drops it on removal', async () => {
    const { ctx: context, project, agent, downloads, imports, config, asked } = await compose()
    expect(context.tools.get(TOOL_NAME)).toBeDefined()
    expect((JSON.parse(await readFile(join(config.blenderStore, STORE_INDEX), 'utf8')) as { addons: Record<string, unknown> }).addons['test-rig']).toEqual({ module: 'rigify', kind: 'core', version: '5.2.3' })
    expect(await guideNames(context, project, agent)).toEqual([])
    expect(text(await call(context, agent, 'skill', { name: 'test-camera' }))).toMatch(/unknown|not available/iu)
    const installed = await call(context, agent, TOOL_NAME, { action: 'install', id: 'test-camera' })
    expect(installed.isError).toBe(false)
    expect(downloads.requests).toEqual([URLS.camera])
    expect(imports).toEqual([project, project])
    expect(await guideNames(context, project, agent)).toEqual(['test-camera'])
    const guide = text(await call(context, agent, 'skill', { name: 'test-camera' }))
    expect(guide).toContain('<skill_content name="test-camera">')
    expect(guide).toContain('Use it like this.')
    expect((await call(context, agent, TOOL_NAME, { action: 'remove', id: 'test-camera' })).isError).toBe(false)
    expect(await guideNames(context, project, agent)).toEqual([])
    expect(asked).toEqual([])
  })

  it('serves the Add-ons dialog: every add-on with its switch, and its presence in the Workspace folder\'s project when there is one', async () => {
    const { ctx: context, project, agent } = await compose()
    const workspace = join(project, '..')
    await call(context, agent, TOOL_NAME, { action: 'install', id: 'test-rig' })
    const view = await context.gameAddons.project(workspace, signal)
    expect(view.projectDir).toBe(project)
    expect(view.addons.map(addon => [addon.id, addon.allowed, addon.presence?.state])).toEqual([
      ['other-camera', true, 'absent'], ['test-camera', true, 'absent'], ['test-rig', true, 'installed'], ['test-trees', true, 'absent'],
    ])
    const empty = join(dir!.root, 'empty')
    await mkdir(empty)
    const outside = await context.gameAddons.project(empty, signal)
    expect(outside.projectDir).toBeUndefined()
    expect(outside.addons.map(addon => [addon.id, addon.presence])).toEqual([
      ['other-camera', undefined], ['test-camera', undefined], ['test-rig', undefined], ['test-trees', undefined],
    ])
    await expect(context.gameAddons.project('relative', signal)).rejects.toThrow(/absolute path/u)
    await expect(context.gameAddons.setAllowed('nope', false)).rejects.toMatchObject({ code: 'game-addons/unknown-addon' })
    // Without the Loader's Settings service, a switch cannot be saved.
    await expect(context.gameAddons.setAllowed('test-camera', false)).rejects.toMatchObject({ code: 'game-addons/settings-unavailable' })
  })

  it('keeps an add-on that the user turned off out of the prompt, the tool, the guides, the Blender index, and the graphics review\'s list', async () => {
    const { ctx: context, project, agent, config, downloads } = await compose(undefined, undefined, { 'test-camera': false, 'test-rig': false, 'test-trees': true })
    const entries = (await loadCatalog(config.catalogDir)).entries
    expect(await promptSection(context)).toBe(sessionPrompt(entries.filter(entry => entry.id !== 'test-camera' && entry.id !== 'test-rig')))
    expect(context.gameAddons.allowedEntries().map(entry => entry.id)).toEqual(['other-camera', 'test-trees'])
    const refused = await call(context, agent, TOOL_NAME, { action: 'install', id: 'test-camera' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('The user turned Test Camera (test-camera) off in WASD Engine\'s Add-ons dialog, so agents cannot use it.')
    expect(downloads.requests).toEqual([])
    // A copy that someone put into addons/ by hand gets no guide either.
    await mkdir(join(project, 'addons', 'test_camera'), { recursive: true })
    expect(await guideNames(context, project, agent)).toEqual([])
    const index = JSON.parse(await readFile(join(config.blenderStore, STORE_INDEX), 'utf8')) as { addons: Record<string, Record<string, unknown>> }
    expect(index.addons['test-rig']).toMatchObject({ allowed: false })
    expect(index.addons['test-trees']).not.toHaveProperty('allowed')
  })

  it('withdraws its tool, prompt section, guides, and game MCP provider with its fiber', async () => {
    const { ctx: context, fiber, project, agent, providers } = await compose()
    expect(providers).toEqual(['game'])
    await call(context, agent, TOOL_NAME, { action: 'install', id: 'test-rig' })
    expect(await guideNames(context, project, agent)).toEqual(['test-rig'])
    expect(await promptSection(context)).toBeDefined()
    await fiber.dispose()
    expect(context.tools.get(TOOL_NAME)).toBeUndefined()
    expect(await promptSection(context)).toBeUndefined()
    expect(await guideNames(context, project, agent)).toEqual([])
    expect(providers).toEqual([])
  })

  it('replaces at its start a store index that names setup scripts in the catalog, as earlier versions wrote it', async () => {
    const root = await scratch('setup-catalog')
    try {
      const catalogDir = await writeCatalog(root.root, entriesWithTreeAssets())
      await writeFile(join(catalogDir, 'test-trees', 'setup.py'), 'def setup(module, assets):\n    pass\n')
      // 0.1.1 and 0.1.2 indexed the catalog file, which the Desktop app keeps inside app.asar, where Blender's Python
      // cannot read it.
      const stale = '/Applications/WASD Engine.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/wasdengine/addons/test-trees/setup.py'
      const { config } = await compose(catalogDir, async ({ blenderStore }) => {
        await mkdir(blenderStore, { recursive: true })
        await writeFile(join(blenderStore, STORE_INDEX), `${JSON.stringify({ format: 1, addons: { 'test-trees': { module: 'test_trees', kind: 'extension', version: '2.0.0', setup: stale } } })}\n`)
      })
      const setup = (JSON.parse(await readFile(join(config.blenderStore, STORE_INDEX), 'utf8')) as { addons: Record<string, { setup?: string }> }).addons['test-trees']?.setup
      expect(setup).toBe(join(config.blenderStore, STORE_SETUP_DIR, 'test-trees', 'setup.py'))
      expect(await readFile(setup ?? '', 'utf8')).toBe('def setup(module, assets):\n    pass\n')
    } finally {
      await root.cleanup()
    }
  })

  it('shows a guide that goes with the add-ons through its tool and lists it in the game MCP provider\'s instructions', async () => {
    const root = await scratch('guides')
    try {
      await mkdir(join(root.root, 'look'))
      await writeFile(join(root.root, 'look', 'SKILL.md'), '---\nname: test-look\ndescription: Make a game look finished.\n---\n\nFrame it with `test-camera`.\n')
      const { ctx: context, agent, instructions } = await compose(undefined, undefined, undefined, [join(root.root, 'look', 'SKILL.md')])
      expect(text(await call(context, agent, TOOL_NAME, { action: 'guide', id: 'test-look' }))).toBe('Frame it with `test-camera`.')
      expect(text(await call(context, agent, TOOL_NAME, { action: 'search' }))).toContain('\n- test-look: Make a game look finished.')
      expect(instructions.get('game')).toContain('read it with action guide and its name as id:\n- test-look: Make a game look finished.')
    } finally {
      await root.cleanup()
    }
  })

  it('does not start with a guide it cannot read', async () => {
    await expect(compose(undefined, undefined, undefined, ['/nonexistent/look/SKILL.md'])).rejects.toThrow(/Cannot read the guide \/nonexistent\/look\/SKILL\.md/u)
  })

  it('does not start with an invalid catalog', async () => {
    const root = await scratch('bad-catalog')
    try {
      const entries = editableCatalogEntries()
      ;(entries['test-camera'] as Record<string, unknown>).conflicts = ['missing']
      const catalogDir = await writeCatalog(root.root, entries)
      await expect(compose(catalogDir)).rejects.toThrow(/conflict missing is not another catalog add-on/u)
    } finally {
      await root.cleanup()
    }
  })
})
