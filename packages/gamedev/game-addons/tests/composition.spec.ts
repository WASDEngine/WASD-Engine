/**
 * The game add-ons plugin loaded into a Host composition with the real system prompt, tool runtime, executor, Agent
 * registry, skill registry, `skill` tool, and Remote registry: the system prompt lists the catalog, the Session's agent
 * installs and removes add-ons under the `ask` approval policy without a question to the user, a Session in a game
 * project sees an add-on's guide only once the add-on is installed and loads it through the `skill` tool, and the
 * plugin's tool, prompt section, guides, and game MCP provider leave with its fiber.
 */
import { readFile } from 'node:fs/promises'
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
import { PROMPT_SECTION, sessionPrompt } from '../src/prompt.ts'
import { editableCatalogEntries, fakeDownloads, scratch, URLS, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

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

async function compose(catalogDir?: string) {
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
  ctx.provide('gameMcp', { provide: (provider: { id: string }) => { providers.push(provider.id); return () => { providers.splice(providers.indexOf(provider.id), 1) } } } as never)
  const config = { catalogDir: catalogDir ?? await writeCatalog(dir.root), dataRoot: join(dir.root, 'data'), blenderStore: join(dir.root, 'data', 'blender') }
  const fiber = ctx.plugin(GameAddons, GameAddons.Config(config))
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
  return { ctx, fiber, project, agent, downloads, imports, config, providers, asked }
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

  it('serves the Add-ons dialog: the catalog with presence, installation, and removal by Workspace folder', async () => {
    const { ctx: context, project } = await compose()
    const workspace = join(project, '..')
    const view = await context.gameAddons.project(workspace, signal)
    expect(view.projectDir).toBe(project)
    expect(view.addons.map(addon => [addon.id, addon.presence?.state])).toEqual([
      ['other-camera', 'absent'], ['test-camera', 'absent'], ['test-rig', 'absent'], ['test-trees', 'absent'],
    ])
    expect((await context.gameAddons.installAddon(workspace, 'test-rig', signal)).addon.id).toBe('test-rig')
    expect((await context.gameAddons.project(workspace, signal)).addons.find(addon => addon.id === 'test-rig')?.presence).toEqual({ state: 'installed', version: '5.2.3' })
    expect((await context.gameAddons.removeAddon(workspace, 'test-rig', signal)).removed).toEqual([])
    await expect(context.gameAddons.project('relative', signal)).rejects.toThrow(/absolute path/u)
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
