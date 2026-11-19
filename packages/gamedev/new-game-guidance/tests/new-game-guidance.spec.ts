/**
 * The new game guidance plugin in a composition with the real Agent loop, session projections, and the local
 * filesystem, driven by a scripted model: the user's first prompt in a Session whose project folder holds only hidden
 * entries and system files is followed by the guidance, as its own logged message right after the prompt and ahead of
 * context that other listeners add; later prompts, folders that hold files or cannot be listed, Sessions without a
 * folder, subagent Sessions, turns that no message from the user starts, rejected steps, and an unloaded plugin get
 * none.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, GenerateOptions, MessageSource } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as NewGameGuidance from '../src/index.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Context that the test's own listeners and notices add. */
    'new-game-guidance-test': { kind: 'new-game-guidance-test' } & ContextFormed
  }
}

const GUIDANCE = '* Make what is on screen look great\n* Play the game yourself before you finish'

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Make a project folder in this test's temporary root.
 * @param name - the folder's name.
 * @param entries - files to create in it; a name ending in `/` is a folder.
 * @returns the folder's absolute path.
 */
async function projectFolder(name: string, entries: readonly string[]): Promise<string> {
  root ??= await mkdtemp(join(tmpdir(), 'dsh-new-game-guidance-'))
  const folder = join(root, name)
  await mkdir(folder)
  for (const entry of entries) {
    if (entry.endsWith('/')) await mkdir(join(folder, entry))
    else await writeFile(join(folder, entry), '')
  }
  return folder
}

/** A new game project's folder: its `.git` folder, a hidden file, and the system files Windows leaves. */
function newGameFolder(name = 'new-game'): Promise<string> {
  return projectFolder(name, ['.git/', '.DS_Store', 'Thumbs.db', 'desktop.ini'])
}

/**
 * Boot the real loop spine, the local filesystem, and the plugin under test.
 * @param before - registers listeners and plugins that load before the plugin.
 * @returns the booted context.
 */
async function compose(before?: (context: Context) => void | Promise<void>): Promise<Context> {
  const created = new Context()
  ctx = created
  await mountAgentLoopTestDependencies(created)
  await created.plugin(FsLocal)
  await created.plugin(AgentLoop, { agents: [] })
  await before?.(created)
  await created.plugin(NewGameGuidance, { text: GUIDANCE })
  return created
}

/**
 * Start a top-level agent in a project folder on its own scripted model.
 * @param context - the booted context.
 * @param id - the Session's id, also the model route's name.
 * @param folder - the Session's project folder; undefined starts a Session without one.
 * @param replies - the model's replies, one per request.
 * @returns the agent and its model.
 */
async function startAgent(
  context: Context, id: string, folder: string | undefined, replies: readonly string[],
): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(replies.map(textResponse))
  context.llm.registerAdapter([id], adapter)
  const agent = await context.agentLoop.create(SessionId(id), { provider: id, model: 'mock' }, folder === undefined ? {} : { cwd: folder })
  return { agent, adapter }
}

/**
 * Send one message and wait until the agent is idle again.
 * @param agent - the agent.
 * @param text - the message's text.
 * @param source - who sent it; the user by default.
 */
async function send(agent: Agent, text: string, source: MessageSource = { kind: 'user' }): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source }))
  await Promise.resolve()
  await agent.whenIdle()
}

/** The text of a message's text blocks. */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content.map(block => block.type === 'text' ? block.text : '').join('')
}

/** Every user-role message the agent's log holds, in order, as its source kind and text. */
function logged(agent: Agent): { kind: string; text: string }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    .map(event => ({ kind: event.data.source.kind, text: textOf(event.data.content) }))
}

/** The texts of the user-role messages one model request carried, in order. */
function requestTexts(request: GenerateOptions | undefined): string[] {
  return (request?.messages ?? []).filter(message => message.role === 'user').map(message => textOf(message.content))
}

/** A context message that one of the test's listeners adds. */
function testContext(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'new-game-guidance-test' } })
}

describe('the first prompt for a new game', () => {
  it('is followed by the guidance, as its own logged message right after the prompt, and later prompts are not', async () => {
    const context = await compose()
    const folder = await newGameFolder()
    const { agent, adapter } = await startAgent(context, 'game', folder, ['Here is your racing game.', 'Added a boost pad.'])
    await send(agent, 'Make a racing game.')
    await send(agent, 'Add a boost pad.')

    expect(logged(agent)).toEqual([
      { kind: 'user', text: 'Make a racing game.' },
      { kind: 'new-game-guidance', text: GUIDANCE },
      { kind: 'user', text: 'Add a boost pad.' },
    ])
    expect(requestTexts(adapter.requests[0])).toEqual(['Make a racing game.', GUIDANCE])
    expect(requestTexts(adapter.requests[1])).toEqual(['Make a racing game.', GUIDANCE, 'Add a boost pad.'])
  })

  it('is followed by the guidance ahead of the context that other listeners add to the step', async () => {
    const context = await compose((composing) => {
      // Like the clock context: prepended, it adds its message after every other message of the step.
      composing.on('agent/pre-step', async (_payload, next): Promise<PreStepDecision> => {
        const decision = await next()
        return decision.kind === 'reject' ? decision : { ...decision, messages: [...decision.messages, testContext('clock')] }
      }, { prepend: true })
      // Like workspace instructions: it adds its message right after the claimed messages.
      composing.on('agent/pre-step', async ({ messages }, next): Promise<PreStepDecision> => {
        const decision = await next()
        if (decision.kind === 'reject') return decision
        const last = decision.messages.findLastIndex(message => messages.includes(message))
        return { ...decision, messages: decision.messages.toSpliced(last + 1, 0, testContext('instructions')) }
      })
    })
    const folder = await newGameFolder()
    const { agent, adapter } = await startAgent(context, 'ordered', folder, ['Here is your racing game.'])
    await send(agent, 'Make a racing game.')

    expect(requestTexts(adapter.requests[0])).toEqual(['Make a racing game.', GUIDANCE, 'instructions', 'clock'])
  })

  it('waits for the user when another producer starts the Session\'s first turn', async () => {
    const context = await compose()
    const folder = await newGameFolder()
    const { agent, adapter } = await startAgent(context, 'noticed', folder, ['Noted.', 'Here is your racing game.'])
    await send(agent, 'A scheduled check ran.', { kind: 'new-game-guidance-test', form: 'notice', summary: 'Check ran' })
    await send(agent, 'Make a racing game.')

    expect(requestTexts(adapter.requests[0])).toEqual(['A scheduled check ran.'])
    expect(requestTexts(adapter.requests[1])).toEqual(['A scheduled check ran.', 'Make a racing game.', GUIDANCE])
  })

  it('waits for the next prompt when a listener rejects the step that claimed the first one', async () => {
    const context = await compose((composing) => {
      composing.on('agent/pre-step', async ({ messages }, next): Promise<PreStepDecision> => {
        const rejected = messages.some(message => textOf(message.content) === 'Never mind.')
        return rejected ? { kind: 'reject' } : await next()
      })
    })
    const folder = await newGameFolder()
    const { agent, adapter } = await startAgent(context, 'rejected', folder, ['Here is your racing game.'])
    await send(agent, 'Never mind.')
    await send(agent, 'Make a racing game.')

    expect(logged(agent)).toEqual([
      { kind: 'user', text: 'Make a racing game.' },
      { kind: 'new-game-guidance', text: GUIDANCE },
    ])
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('Sessions that get no guidance', () => {
  it('leaves a game whose folder holds files alone, and its first prompt stays the first once the folder is emptied', async () => {
    const context = await compose()
    const folder = await projectFolder('started-game', ['.git/', 'project.godot'])
    const { agent, adapter } = await startAgent(context, 'started', folder, ['Added a boost pad.', 'Here is a new game.'])
    await send(agent, 'Add a boost pad.')
    await rm(join(folder, 'project.godot'))
    await send(agent, 'Start over with a new game.')

    expect(logged(agent).map(message => message.kind)).toEqual(['user', 'user'])
    expect(requestTexts(adapter.requests[1])).toEqual(['Add a boost pad.', 'Start over with a new game.'])
  })

  it('leaves a Session whose folder is gone, and one without a folder, alone', async () => {
    const context = await compose()
    const folder = await newGameFolder('moved-game')
    const moved = await startAgent(context, 'moved', folder, ['I cannot find the project.'])
    await rm(folder, { recursive: true })
    const folderless = await startAgent(context, 'folderless', undefined, ['Here is your racing game.'])
    await send(moved.agent, 'Make a racing game.')
    await send(folderless.agent, 'Make a racing game.')

    expect(logged(moved.agent).map(message => message.kind)).toEqual(['user'])
    expect(logged(folderless.agent).map(message => message.kind)).toEqual(['user'])
  })

  it('leaves a subagent Session, whose first message comes from its parent, alone', async () => {
    const context = await compose()
    const folder = await newGameFolder()
    const adapter = new MockAdapter([textResponse('Here is the level.')])
    context.llm.registerAdapter(['child'], adapter)
    const { agent } = await context.agentLoop.createAgent(context, {
      sessionId: SessionId('child'),
      meta: { cwd: folder, origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'child', model: 'mock' },
    })
    await send(agent, 'Build the first level.')

    expect(logged(agent).map(message => message.kind)).toEqual(['user'])
    expect(requestTexts(adapter.requests[0])).toEqual(['Build the first level.'])
  })

  it('stops adding the guidance once the plugin unloads', async () => {
    const created = new Context()
    ctx = created
    await mountAgentLoopTestDependencies(created)
    await created.plugin(FsLocal)
    await created.plugin(AgentLoop, { agents: [] })
    const fiber = created.plugin(NewGameGuidance, { text: GUIDANCE })
    await fiber
    await fiber.dispose()
    const folder = await newGameFolder()
    const { agent } = await startAgent(created, 'unloaded', folder, ['Here is your racing game.'])
    await send(agent, 'Make a racing game.')

    expect(logged(agent).map(message => message.kind)).toEqual(['user'])
  })
})

describe('configuration', () => {
  it('rejects guidance that is only whitespace when applied directly', async () => {
    await expect(NewGameGuidance.apply(new Context(), { text: ' \n\t' }))
      .rejects.toThrow('new-game-guidance: text must not be blank')
  })

  it('requires the deployment to choose the guidance', () => {
    expect(() => NewGameGuidance.Config({} as NewGameGuidance.Config)).toThrow()
    expect(NewGameGuidance.Config({ text: GUIDANCE })).toEqual({ text: GUIDANCE })
  })
})
