/**
 * Keeps a top-level agent's turn going while the todo list it wrote in that
 * turn still has unfinished items. When the model ends the turn with a reply
 * that calls no tool, the plugin steers one reminder that names the unfinished
 * items, so the next step continues the work. Each distinct unfinished list is
 * reminded at most once per turn, and a turn receives at most
 * `maxRemindersPerTurn` reminders. Subagent Sessions, turns that a tool
 * ended, turns the user stopped or steered, and turns with a message from the
 * user waiting are left alone.
 * @module @deepseek-ai/dsh-todo-continuation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'todo-continuation': { kind: 'todo-continuation' } & ContextFormed
  }
}

export const name = 'todo-continuation'

/** Plugin configuration. */
export interface Config {
  /**
   * Most reminders one turn receives. A reminder needs a different
   * unfinished list from every earlier one in the turn, so the cap stops
   * a model that keeps rewriting its list without finishing it.
   */
  maxRemindersPerTurn: number
}

/** Schemastery configuration; the deployment chooses the cap. */
export const Config: z<Config> = z.object({
  maxRemindersPerTurn: z.natural().min(1).required(),
})

/** What the plugin tracks for one Session's open turn. */
interface TurnState {
  /** The open turn's number. */
  readonly turn: number
  /** The latest todo list written in this turn; empty before the first write. */
  todos: readonly TodoItem[]
  /** Whether the turn's latest assistant message called no tool. */
  endedByReply: boolean
  /** Steps the turn has started. */
  steps: number
  /** Whether the user steered the turn after its first step, which then follows the user rather than its list. */
  userSteered: boolean
  /** Keys of the unfinished lists already reminded in this turn. */
  readonly reminded: Set<string>
}

/**
 * The reminder text: the unfinished items in list order, then what to do.
 * @param unfinished - the items whose status is not `completed`.
 * @returns the model-facing reminder.
 */
function reminderText(unfinished: readonly TodoItem[]): string {
  const items = unfinished.map(item => `- [${item.status}] ${item.content}`).join('\n')
  return '<unfinished_todos>\n'
    + 'Your turn is about to end, but your todo list still has unfinished items:\n'
    + `${items}\n\n`
    + 'Continue working on them now, without asking the user whether to continue. Update the list with '
    + 'todo_write as you go, and mark every finished item completed, including any you already finished. '
    + 'Leave an item unfinished only when it needs an answer that only the user can give, or waits on '
    + 'something you cannot do yourself, such as a subagent or background job that is still running; '
    + 'then end your turn with one short sentence that says so.\n'
    + '</unfinished_todos>'
}

/**
 * The reminder's collapsed one-line account.
 * @param count - how many items are unfinished.
 * @returns the account, bounded for a `notice` source.
 */
function summaryOf(count: number): string {
  return boundContextSummary(`${count} ${count === 1 ? 'todo' : 'todos'} left`)
}

/**
 * Whether a message the user sent waits in the agent's inbox, for the next
 * step (steering) or for its own turn (a queued follow-up).
 * @param agent - the agent whose turn is stopping.
 * @returns true when the user's message should run instead of a reminder.
 */
function userMessageWaiting(agent: Agent): boolean {
  return [...agent.inbox.nextStep, ...agent.inbox.nextTurn].some(message => message.source.kind === 'user')
}

/**
 * Build the steered reminder message for one unfinished list.
 * @param unfinished - the items whose status is not `completed`.
 * @returns a `notice`-form message attributed to this plugin.
 */
function reminderMessage(unfinished: readonly TodoItem[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: reminderText(unfinished) }],
    source: { kind: 'todo-continuation', form: 'notice', summary: summaryOf(unfinished.length) },
  })
}

/**
 * Install the turn-state and turn-stopping listeners.
 * @param ctx - plugin context; the listeners leave with its fiber.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const maxReminders = config.maxRemindersPerTurn
  if (!Number.isSafeInteger(maxReminders) || maxReminders < 1) {
    throw new TypeError('todo-continuation: maxRemindersPerTurn must be a positive safe integer')
  }
  const turns = new WeakMap<Session, TurnState>()

  ctx.on('session/event', (session, event) => {
    switch (event.type) {
      case 'turn/start':
        turns.set(session, {
          turn: event.data.turn, todos: [], endedByReply: false, steps: 0, userSteered: false, reminded: new Set(),
        })
        return
      case 'step/start': {
        const state = turns.get(session)
        if (state !== undefined) state.steps++
        return
      }
      case 'user/message': {
        // The turn's own prompt enters in its first step; a user message in a later step steered it.
        const state = turns.get(session)
        if (state !== undefined && state.steps > 1 && event.data.source.kind === 'user') state.userSteered = true
        return
      }
      case 'todo/write': {
        const state = turns.get(session)
        if (state !== undefined) state.todos = event.data.todos
        return
      }
      case 'assistant/message': {
        const state = turns.get(session)
        if (state !== undefined) state.endedByReply = !event.data.message.content.some(block => block.type === 'tool-call')
        return
      }
      case 'turn/end':
        turns.delete(session)
        return
      default:
        // Every other event leaves the open turn's state unchanged.
        return
    }
  })

  ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
    const { session } = agent
    // A Stop that landed while an earlier listener ran ends the turn: steering
    // now would start a new turn behind the user's back.
    if (signal.aborted) return
    // A subagent reports to its parent, which decides whether it continues.
    if (session.header.origin === 'subagent') return
    // The user's own message runs next; a reminder would delay it or contradict it.
    if (userMessageWaiting(agent)) return
    const state = turns.get(session)
    // A turn that a tool ended, such as a dismissed plan review, stays ended,
    // and a turn the user steered follows the user.
    if (state?.turn !== turn || !state.endedByReply || state.userSteered) return
    const unfinished = state.todos.filter(item => item.status !== 'completed')
    if (unfinished.length === 0 || state.reminded.size >= maxReminders) return
    const key = JSON.stringify(unfinished.map(item => [item.status, item.content]))
    if (state.reminded.has(key)) return
    state.reminded.add(key)
    agent.steer(reminderMessage(unfinished))
  })
}
