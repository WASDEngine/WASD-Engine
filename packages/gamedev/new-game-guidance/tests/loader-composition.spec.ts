/**
 * REAL-composition proof: a test-only `cordis.yml` boots the agent loop's Host rows, the local filesystem, and the
 * agent preset registry through the vendored Loader, with a `gamedev` preset whose `time-context` and
 * `new-game-guidance` rows come from the shipped overlay. A scripted model drives Agents bound to the presets, so the
 * shipped guidance reaches the model right after the user's first prompt for a new game and ahead of the clock
 * context, while an Agent of a preset without the plugin gets none.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import * as FsLocal from '@deepseek-ai/dsh-fs-local'
import * as Llm from '@deepseek-ai/dsh-llm'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as SessionStore from '@deepseek-ai/dsh-session'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as SessionProjection from '@deepseek-ai/dsh-session-projection'
import * as SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as TimeContext from '@deepseek-ai/dsh-time-context'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Tools from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as NewGameGuidance from '../src/index.ts'

/** The fork's overlay that declares the shipped `gamedev` preset. */
const GAMEDEV_OVERLAY = fileURLToPath(new URL('../../../bundle/web-app/wasdengine/gamedev.cordis.patch.yml', import.meta.url))

/** The `gamedev` rows this test boots: the clock context, which adds its own message to each step, and the plugin. */
const PRESET_ROWS = ['time-context', 'new-game-guidance'] as const

/** The guidance the shipped row gives, which the model reads after the first prompt for a new game. */
const SHIPPED_GUIDANCE = [
  '* Put your effort into making what\'s on screen look, move and sound great',
  '* People and humanoid figures should look and move like real people, with fitting animations',
  '* The environment should be believable, textured, with lighting that sells the mood',
  '* Work autonomously without asking me questions. Run and play the demo yourself and fix anything that looks or plays wrong before you finish',
].join('\n')

/** What the Loader imports for each row of the test composition, as the module namespace a real import returns. */
const MODULES = new Map<string, unknown>([
  ['@deepseek-ai/dsh-llm', Llm],
  ['@deepseek-ai/dsh-session', SessionStore],
  ['@deepseek-ai/dsh-session-projection', SessionProjection],
  ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
  ['@deepseek-ai/dsh-tools', Tools],
  ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
  ['@deepseek-ai/dsh-fs-local', FsLocal],
  ['@deepseek-ai/dsh-agent', AgentRegistry],
  ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ['@deepseek-ai/dsh-agent-preset-registry', AgentPresetRegistry],
  ['@deepseek-ai/dsh-agent-preset', AgentPreset],
  ['@deepseek-ai/dsh-time-context', TimeContext],
  ['@deepseek-ai/dsh-new-game-guidance', NewGameGuidance],
])

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
  const preset = loadOverlayPatches('new-game-guidance', GAMEDEV_OVERLAY)
    .flatMap(patch => patch.insert ?? [])
    .find(entry => entry.id === 'preset-gamedev')
  const config = preset?.config as { plugins?: EntryOptions[] } | undefined
  const rows = (config?.plugins ?? []).filter(entry => (PRESET_ROWS as readonly string[]).includes(entry.id))
  expect(rows.map(entry => entry.id)).toEqual([...PRESET_ROWS])
  return rows
}

/**
 * Boot the test composition through the Loader: the Host rows, the local filesystem, the preset registry, the
 * `gamedev` preset with the shipped rows, and a `plain` preset with no rows.
 * @returns the booted root context.
 */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-new-game-guidance-loader-'))
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
    "- name: '@deepseek-ai/dsh-fs-local'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    "- name: '@deepseek-ai/dsh-agent-preset-registry'",
    '  config:',
    '    default: gamedev',
    ...preset('gamedev', shippedRows()),
    ...preset('plain', []),
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

/**
 * Make a new game project's folder, holding only its `.git` folder, under the test's root.
 * @param name - the folder's name.
 * @returns its absolute path.
 */
async function newGameFolder(name: string): Promise<string> {
  if (root === undefined) throw new Error('boot the composition first')
  const folder = join(root, name)
  await mkdir(join(folder, '.git'), { recursive: true })
  return folder
}

/** Start an Agent bound to a preset in a project folder, as the Session controller does, on its own scripted model. */
async function startAgent(booted: Context, id: string, preset: string, folder: string): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter([textResponse('Here is your racing game.')])
  booted.llm.registerAdapter([`mock-${id}`], adapter)
  const { agent } = await booted.agents.create({
    sessionId: SessionId(id),
    meta: { agentPreset: preset, cwd: folder },
    agentOptions: { provider: `mock-${id}`, model: 'mock' },
    setup: async (agentCtx) => { await booted.agentPresets.mount(agentCtx, preset) },
  })
  return { agent, adapter }
}

/** Send one message from the user and wait until the agent is idle again. */
async function ask(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await Promise.resolve()
  await agent.whenIdle()
}

/** The source kinds of the user-role messages in the agent's log, in order. */
function loggedKinds(agent: Agent): string[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .map(event => event.data.source.kind)
}

/** The texts of the user-role messages one model request carried, in order. */
function requestTexts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? []).filter(message => message.role === 'user')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('new game guidance in a Loader-booted gamedev preset', () => {
  it('follows the first prompt of an Agent of the gamedev preset with the shipped guidance, and leaves another preset alone', async () => {
    const booted = await boot()
    const game = await startAgent(booted, 'game', 'gamedev', await newGameFolder('game'))
    const plain = await startAgent(booted, 'plain', 'plain', await newGameFolder('plain'))
    await ask(game.agent, 'Make a racing game.')
    await ask(plain.agent, 'Make a racing game.')

    expect(loggedKinds(game.agent)).toEqual(['user', 'new-game-guidance', 'time-context'])
    expect(requestTexts(game.adapter.requests[0]).slice(0, 2)).toEqual(['Make a racing game.', SHIPPED_GUIDANCE])
    expect(loggedKinds(plain.agent)).toEqual(['user'])
    expect(requestTexts(plain.adapter.requests[0])).toEqual(['Make a racing game.'])
  })

  it('keeps the function plugin\'s namespace free of a default export, which would make the Loader discard it', () => {
    expect('default' in NewGameGuidance).toBe(false)
  })
})
