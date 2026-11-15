/**
 * REAL-composition proof: a test-only `cordis.yml` boots the agent loop's Host rows and the agent preset registry
 * through the vendored Loader, with a `gamedev` preset whose rows come from the shipped overlay: the `planning` group,
 * which isolates plan mode, `tool-todo`, and `todo-continuation`. A scripted model drives Agents bound to the presets,
 * so the reminder reaches the model through the preset's scoped events, an Agent of a preset without the plugin gets
 * none, plan mode, whose service the preset hides from the plugin's own lookup, holds the reminder back, and the images
 * a user attaches to an answer, which the question card steers in marked as part of the answer, do not stop it while a
 * new instruction from the user does.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader, { type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import * as AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as AgentPreset from '@deepseek-ai/dsh-agent-preset'
import * as AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import * as Llm from '@deepseek-ai/dsh-llm'
import { createUserMessage, type MessageSource, type StreamChunk } from '@deepseek-ai/dsh-llm'
import * as PlanMode from '@deepseek-ai/dsh-plan-mode'
import * as SessionStore from '@deepseek-ai/dsh-session'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import * as Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as TodoContinuation from '../src/index.ts'

/** The fork's overlay that declares the shipped `gamedev` preset. */
const GAMEDEV_OVERLAY = fileURLToPath(new URL('../../../bundle/web-app/wasdengine/gamedev.cordis.patch.yml', import.meta.url))

/** The `gamedev` rows the todo continuation works with: plan mode's isolated group, `todo_write`, and the plugin. */
const PRESET_ROWS = ['planning', 'tool-todo', 'todo-continuation'] as const

/** What the Loader imports for each row of the test composition, as the module namespace a real import returns. */
const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', Llm],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjection],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', Tools],
  ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ['@deepseek-ai/dsh-agent-preset-registry', AgentPresetRegistry],
  ['@deepseek-ai/dsh-agent-preset', AgentPreset],
  ['@deepseek-ai/dsh-plan-mode', PlanMode],
  ['@deepseek-ai/dsh-tool-todo', ToolTodo],
  ['@deepseek-ai/dsh-todo-continuation', TodoContinuation],
])

const OPEN_LIST: TodoItem[] = [
  { content: 'Texture the terrain', status: 'in_progress' },
  { content: 'Texture the trees', status: 'pending' },
]

const DONE_LIST: TodoItem[] = [
  { content: 'Texture the terrain', status: 'completed' },
  { content: 'Texture the trees', status: 'completed' },
]

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** The shipped `gamedev` preset's rows named by {@link PRESET_ROWS}, as the overlay declares them. */
function shippedRows(): EntryOptions[] {
  const preset = loadOverlayPatches('todo-continuation', GAMEDEV_OVERLAY)
    .flatMap(patch => patch.insert ?? [])
    .find(entry => entry.id === 'preset-gamedev')
  const config = preset?.config as { plugins?: EntryOptions[] } | undefined
  const rows = (config?.plugins ?? []).filter(entry => (PRESET_ROWS as readonly string[]).includes(entry.id))
  expect(rows.map(entry => entry.id)).toEqual([...PRESET_ROWS])
  return rows
}

/**
 * Boot the test composition through the Loader: the Host rows, the preset registry, the `gamedev` preset with the
 * shipped rows, and a `plain` preset with `todo_write` alone.
 * @returns the booted root context.
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-todo-continuation-loader-'))
  const configPath = join(root, 'cordis.yml')
  // JSON is YAML, so the shipped rows keep their exact values.
  const preset = (id: string, plugins: unknown[]): string[] => [
    `- id: preset-${id}`,
    "  name: '@deepseek-ai/dsh-agent-preset'",
    `  config: ${JSON.stringify({ id, plugins })}`,
  ]
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-agent-preset-registry'",
    '  config:',
    '    default: gamedev',
    ...preset('gamedev', shippedRows()),
    ...preset('plain', [{ id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } }]),
    '',
  ].join('\n'))
  const created = new Context()
  context = created
  created.baseUrl = `${pathToFileURL(root).href}/`
  await created.plugin(Loader)
  created.loader.builtins.include = Include
  created.loader.builtins.group = Group
  // Entry trees call only the module loader's `import`; this one answers from the test's own imports.
  Reflect.set(created.loader, 'internal', {
    version: 'v2',
    import: (specifier: string): Promise<unknown> => MODULES.has(specifier)
      ? Promise.resolve(MODULES.get(specifier))
      : Promise.reject(new Error(`unexpected Loader import: ${specifier}`)),
  })
  await created.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await created.loader.await()
  const unloaded = [...created.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  expect(unloaded.map(entry => entry.options.name)).toEqual([])
  for (const id of ['gamedev', 'plain']) expect(await created.agentPresets.resolve(id)).toEqual({ id })
  return created
}

/** Start an Agent bound to a preset, as the Session controller does, on its own scripted model. */
async function startAgent(
  booted: Context, id: string, preset: string, script: StreamChunk[][],
): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(script)
  booted.llm.registerAdapter([`mock-${id}`], adapter)
  const { agent } = await booted.agents.create({
    sessionId: SessionId(id),
    meta: { agentPreset: preset },
    agentOptions: { provider: `mock-${id}`, model: 'mock' },
    setup: async (agentCtx) => { await booted.agentPresets.mount(agentCtx, preset) },
  })
  return { agent, adapter }
}

/** Send one user message and wait until the agent is idle again. */
async function ask(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await Promise.resolve()
  await agent.whenIdle()
}

/** The sources of the reminders this plugin added to the agent's log. */
function reminders(agent: Agent): unknown[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'todo-continuation')
    .map(event => event.data.source)
}

describe('todo continuation in a Loader-booted gamedev preset', () => {
  it('reminds an Agent of the gamedev preset through its scoped events, and leaves an Agent of another preset alone', async () => {
    const booted = await boot()
    const game = await startAgent(booted, 'game', 'gamedev', [
      toolCallResponse('w1', 'todo_write', { todos: OPEN_LIST }),
      textResponse('I textured the terrain. Want me to do the trees next?'),
      toolCallResponse('w2', 'todo_write', { todos: DONE_LIST }),
      textResponse('Both are textured.'),
    ])
    const plain = await startAgent(booted, 'plain', 'plain', [
      toolCallResponse('w1', 'todo_write', { todos: OPEN_LIST }),
      textResponse('I textured the terrain. Want me to do the trees next?'),
    ])
    await ask(game.agent, 'Texture the terrain and the trees.')
    await ask(plain.agent, 'Texture the terrain and the trees.')

    expect(reminders(game.agent)).toEqual([{ kind: 'todo-continuation', form: 'notice', summary: '2 todos left' }])
    expect(game.adapter.requests).toHaveLength(4)
    expect(JSON.stringify(game.adapter.requests[2]?.messages)).toContain('<unfinished_todos>')
    expect(reminders(plain.agent)).toEqual([])
    expect(plain.adapter.requests).toHaveLength(2)
  })

  it('holds the reminder back while plan mode, whose service the preset isolates in its planning group, is on', async () => {
    const booted = await boot()
    const { agent, adapter } = await startAgent(booted, 'planner', 'gamedev', [
      toolCallResponse('w1', 'todo_write', { todos: OPEN_LIST }),
      textResponse('# Texture plan\n\nTerrain first, then the trees.'),
      toolCallResponse('w2', 'todo_write', { todos: OPEN_LIST }),
      textResponse('I textured the terrain. Want me to do the trees next?'),
      toolCallResponse('w3', 'todo_write', { todos: DONE_LIST }),
      textResponse('Both are textured.'),
    ])
    expect(booted.get('planMode')).toBeUndefined()
    const planMode = booted.agentPresets.serviceFor(agent, 'planMode')
    if (planMode === undefined) throw new Error('the gamedev preset has no plan mode')
    expect(planMode.set(agent, true)).toBe('committed')
    await ask(agent, 'Plan the textures.')

    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('You are in plan mode.')
    expect(reminders(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(2)

    expect(planMode.set(agent, false)).toBe('committed')
    await ask(agent, 'Go ahead.')
    expect(reminders(agent)).toEqual([{ kind: 'todo-continuation', form: 'notice', summary: '2 todos left' }])
    expect(adapter.requests).toHaveLength(6)
  })

  it('keeps reminding after the user answers with images, and follows the user once they steer the turn', async () => {
    const booted = await boot()
    // The Host's prompt for a question card's images carries `answersQuestion`; a typed instruction does not.
    const steerer = (name: string, source: MessageSource, text: string) => defineContentToolFixture({
      name,
      description: `Stands for the user steering in: ${text}`,
      parameters: {},
      execute(_args, exec) {
        exec.agent?.steer(createUserMessage({ content: [{ type: 'text', text }], source }))
        return Promise.resolve([{ type: 'text', text: 'answered' }])
      },
    })
    booted.tools.register(steerer('answer_with_images', { kind: 'user', rpcId: 'answer-1', answersQuestion: true } as MessageSource, 'Images for my answer:'))
    booted.tools.register(steerer('steer_instruction', { kind: 'user', rpcId: 'steer-1' } as MessageSource, 'Stop after the terrain.'))
    const answered = await startAgent(booted, 'answered', 'gamedev', [
      toolCallResponse('w1', 'todo_write', { todos: OPEN_LIST }),
      toolCallResponse('a1', 'answer_with_images', {}),
      textResponse('I textured the terrain in the look you chose. Want me to do the trees next?'),
      toolCallResponse('w2', 'todo_write', { todos: DONE_LIST }),
      textResponse('Both are textured.'),
    ])
    const steered = await startAgent(booted, 'steered', 'gamedev', [
      toolCallResponse('w1', 'todo_write', { todos: OPEN_LIST }),
      toolCallResponse('s1', 'steer_instruction', {}),
      textResponse('Stopping after the terrain, as you asked.'),
    ])
    await ask(answered.agent, 'Texture the terrain and the trees.')
    await ask(steered.agent, 'Texture the terrain and the trees.')

    expect(reminders(answered.agent)).toEqual([{ kind: 'todo-continuation', form: 'notice', summary: '2 todos left' }])
    expect(answered.adapter.requests).toHaveLength(5)
    expect(reminders(steered.agent)).toEqual([])
    expect(steered.adapter.requests).toHaveLength(3)
  })

  it('keeps the function plugin\'s namespace free of a default export, which would make the Loader discard it', () => {
    expect('default' in TodoContinuation).toBe(false)
  })
})
