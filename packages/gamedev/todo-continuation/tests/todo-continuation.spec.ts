/**
 * The todo continuation plugin in a composition with the real Agent loop, tool runtime, session projections, and
 * `todo_write` tool, driven by a scripted model: a turn that ends with unfinished todos continues with one reminder,
 * an unchanged list or the per-turn cap lets the turn end, and finished lists, lists from earlier turns, turns that a
 * tool ended, subagent Sessions, and an unloaded plugin get no reminder.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { afterEach, describe, expect, it } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as TodoContinuation from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

/** The reminder the plugin steers for two pending items, verbatim. */
const TWO_PENDING_REMINDER = '<unfinished_todos>\n'
  + 'Your turn is about to end, but your todo list still has unfinished items:\n'
  + '- [in_progress] Texture the terrain\n'
  + '- [pending] Texture the trees\n\n'
  + 'Continue working on them now, without asking the user whether to continue. Update the list with '
  + 'todo_write as you go, and mark every finished item completed, including any you already finished. '
  + 'Leave an item unfinished only when it needs an answer that only the user can give, or waits on '
  + 'something you cannot do yourself, such as a subagent or background job that is still running; '
  + 'then end your turn with one short sentence that says so.\n'
  + '</unfinished_todos>'

const OPEN_LIST: TodoItem[] = [
  { content: 'Texture the terrain', status: 'in_progress' },
  { content: 'Texture the trees', status: 'pending' },
]

const DONE_LIST: TodoItem[] = [
  { content: 'Texture the terrain', status: 'completed' },
  { content: 'Texture the trees', status: 'completed' },
]

/** A model step that writes the given todo list. */
function writeTodos(id: string, todos: TodoItem[]): StreamChunk[] {
  return toolCallResponse(id, 'todo_write', { todos })
}

/** Boot the real loop spine, `todo_write`, a turn-ending tool, and the plugin under test. */
async function compose(config: TodoContinuation.Config = { maxRemindersPerTurn: 3 }): Promise<Context> {
  const created = new Context()
  ctx = created
  await mountAgentLoopTestDependencies(created)
  await created.plugin(AgentLoop, { agents: [] })
  await created.plugin(ToolTodo, { allowParallelInProgress: true })
  created.tools.register(defineContentToolFixture({
    name: 'finish_review',
    description: 'Ends the turn.',
    parameters: {},
    execute(_args, exec) {
      exec.concludeTurn()
      return Promise.resolve([{ type: 'text', text: 'ended' }])
    },
  }))
  await created.plugin(TodoContinuation, config)
  return created
}

/** Register a scripted model and start an agent on it. */
async function startAgent(context: Context, script: StreamChunk[][]): Promise<{ agent: Agent; adapter: MockAdapter }> {
  const adapter = new MockAdapter(script)
  context.llm.registerAdapter(['mock'], adapter)
  const agent = await context.agentLoop.create(SessionId('root'), { provider: 'mock', model: 'mock' })
  return { agent, adapter }
}

/** Send one user message and wait until the agent is idle again. */
async function ask(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await Promise.resolve()
  await agent.whenIdle()
}

/** Every reminder this plugin added to the agent's log, with its source. */
function reminders(agent: Agent): { text: string; source: unknown }[] {
  return agent.session.snapshotEvents()
    .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message' && event.data.source.kind === 'todo-continuation')
    .map(event => ({
      text: event.data.content.map(block => block.type === 'text' ? block.text : '').join(''),
      source: event.data.source,
    }))
}

/** How many turns the agent's log closed. */
function turnEnds(agent: Agent): number {
  return agent.session.snapshotEvents().filter(event => event.type === 'turn/end').length
}

describe('a turn that ends with unfinished todos', () => {
  it('continues the same turn with one reminder naming the unfinished items', async () => {
    const context = await compose()
    const { agent, adapter } = await startAgent(context, [
      writeTodos('w1', OPEN_LIST),
      textResponse('I textured the terrain. Want me to do the trees next?'),
      writeTodos('w2', DONE_LIST),
      textResponse('Both are textured.'),
    ])
    await ask(agent, 'Texture the terrain and the trees.')

    expect(reminders(agent)).toEqual([{
      text: TWO_PENDING_REMINDER,
      source: { kind: 'todo-continuation', form: 'notice', summary: '2 todos left' },
    }])
    expect(adapter.requests).toHaveLength(4)
    expect(JSON.stringify(adapter.requests[2]?.messages)).toContain('<unfinished_todos>')
    expect(turnEnds(agent)).toBe(1)
  })

  it('lets the turn end when the model stops again without changing the list', async () => {
    const context = await compose()
    const { agent, adapter } = await startAgent(context, [
      writeTodos('w1', OPEN_LIST),
      textResponse('Here is the design. Shall I build it?'),
      textResponse('I need your answer on the design first.'),
    ])
    await ask(agent, 'Design and build a level.')

    expect(reminders(agent)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(3)
    expect(turnEnds(agent)).toBe(1)
  })

  it('reminds again after the list changes, up to the configured cap', async () => {
    const context = await compose({ maxRemindersPerTurn: 2 })
    const { agent, adapter } = await startAgent(context, [
      writeTodos('w1', OPEN_LIST),
      textResponse('Stopping here.'),
      writeTodos('w2', [{ content: 'Texture the terrain', status: 'completed' }, { content: 'Texture the trees', status: 'pending' }]),
      textResponse('Stopping again.'),
      writeTodos('w3', [{ content: 'Texture the terrain', status: 'completed' }, { content: 'Texture the trees', status: 'in_progress' }]),
      textResponse('Stopping a third time.'),
    ])
    await ask(agent, 'Texture the terrain and the trees.')

    expect(reminders(agent).map(reminder => reminder.source)).toEqual([
      { kind: 'todo-continuation', form: 'notice', summary: '2 todos left' },
      { kind: 'todo-continuation', form: 'notice', summary: '1 todo left' },
    ])
    expect(reminders(agent)[1]?.text).toContain('\n- [pending] Texture the trees\n\n')
    expect(adapter.requests).toHaveLength(6)
    expect(turnEnds(agent)).toBe(1)
  })
})

describe('turns that get no reminder', () => {
  it('ends a turn whose list is finished, or that wrote no list', async () => {
    const context = await compose()
    const { agent, adapter } = await startAgent(context, [
      writeTodos('w1', DONE_LIST),
      textResponse('Both are textured.'),
      textResponse('The trees use the bark texture.'),
    ])
    await ask(agent, 'Texture the terrain and the trees.')
    await ask(agent, 'Which texture do the trees use?')

    expect(reminders(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(3)
  })

  it('counts only the list written in the current turn', async () => {
    const context = await compose()
    const { agent, adapter } = await startAgent(context, [
      writeTodos('w1', OPEN_LIST),
      textResponse('Stopping here.'),
      textResponse('I need your answer first.'),
      textResponse('You are welcome.'),
    ])
    await ask(agent, 'Texture the terrain and the trees.')
    await ask(agent, 'Thanks.')

    expect(reminders(agent)).toHaveLength(1)
    expect(adapter.requests).toHaveLength(4)
    expect(turnEnds(agent)).toBe(2)
  })

  it('leaves a turn that a tool ended', async () => {
    const context = await compose()
    const { agent, adapter } = await startAgent(context, [
      writeTodos('w1', OPEN_LIST),
      toolCallResponse('f1', 'finish_review', {}),
    ])
    await ask(agent, 'Plan the textures.')

    expect(reminders(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(2)
  })

  it('leaves a subagent Session to its parent', async () => {
    const context = await compose()
    const adapter = new MockAdapter([writeTodos('w1', OPEN_LIST), textResponse('Stopping here.')])
    context.llm.registerAdapter(['mock'], adapter)
    const { agent } = await context.agentLoop.createAgent(context, {
      sessionId: SessionId('child'),
      meta: { origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ask(agent, 'Texture the terrain and the trees.')

    expect(reminders(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(2)
  })

  it('stops reminding once the plugin unloads', async () => {
    const created = new Context()
    ctx = created
    await mountAgentLoopTestDependencies(created)
    await created.plugin(AgentLoop, { agents: [] })
    await created.plugin(ToolTodo, { allowParallelInProgress: true })
    const fiber = created.plugin(TodoContinuation, { maxRemindersPerTurn: 3 })
    await fiber
    await fiber.dispose()
    const { agent, adapter } = await startAgent(created, [writeTodos('w1', OPEN_LIST), textResponse('Stopping here.')])
    await ask(agent, 'Texture the terrain and the trees.')

    expect(reminders(agent)).toEqual([])
    expect(adapter.requests).toHaveLength(2)
  })
})

describe('configuration', () => {
  it('rejects a cap below one when applied directly', () => {
    expect(() => { TodoContinuation.apply(new Context(), { maxRemindersPerTurn: 0 }) })
      .toThrow('todo-continuation: maxRemindersPerTurn must be a positive safe integer')
  })

  it('requires the deployment to choose the cap', () => {
    expect(() => TodoContinuation.Config({} as TodoContinuation.Config)).toThrow()
    expect(TodoContinuation.Config({ maxRemindersPerTurn: 4 })).toEqual({ maxRemindersPerTurn: 4 })
  })
})
