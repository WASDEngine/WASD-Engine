/**
 * The new game guidance in Chat: the Definition claims only appended user messages whose source is the guidance, and in
 * a Chat assembled from the real message, assistant, and turn Definitions, a new game's first turn shows the user's
 * prompt and the reply while the guidance that followed the prompt has no Node; without the Definition the guidance
 * shows as a context row.
 */
import { describe, expect, it } from 'vitest'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ChatConversationViewNode } from '../../../client/ui-chat/src/client/contract/chat-nodes.ts'
import type { ChatSnapshot } from '../../../client/ui-chat/src/client/contract/snapshot.ts'
import { assistantDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'
import { messageDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/message.ts'
import { turnProcessDefinition } from '../../../client/ui-chat/src/client/conversation-nodes/turn-process.ts'
import { ConversationNodeAssembler } from '../../../client/ui-conversation/src/client/conversation/assembler.ts'
import { NEW_GAME_GUIDANCE_SOURCE, newGameGuidanceDefinition } from '../src/client/new-game-guidance.ts'

const PROMPT = 'Make a racing game.'
const GUIDANCE = '* Make what is on screen look great\n* Play the game yourself before you finish'

/** One logged event as the Client history delivers it. */
function event(type: string, seq: number, data: unknown, surfaceOp: 'append' | null = null) {
  return { type, seq: SessionSeq(seq), time: seq * 1_000, ...surfaceOp === null ? {} : { surfaceOp }, data } as never
}

/** A logged user-role message with one text block. */
function userMessage(id: string, source: Record<string, unknown>, text: string, seq: number, surfaceOp: 'append' | null = 'append') {
  return event('user/message', seq, { id, role: 'user', source, content: [{ type: 'text', text }] }, surfaceOp)
}

/** A new game's first turn: the user's prompt, the guidance right after it, and the model's reply. */
const FIRST_TURN = [
  event('turn/start', 1, { turn: 1 }),
  event('step/start', 2, { turn: 1, step: 1 }),
  userMessage('prompt', { kind: 'user', rpcId: 'request-1' }, PROMPT, 3),
  userMessage('guidance', { kind: NEW_GAME_GUIDANCE_SOURCE }, GUIDANCE, 4),
  event('assistant/message', 5, {
    turn: 1, step: 1, stream: [],
    message: { id: 'reply', role: 'assistant', source: { kind: 'model', provider: 'fake', model: 'fake' }, content: [{ type: 'text', text: 'Here is your racing game.' }] },
  }, 'append'),
  event('step/end', 6, { turn: 1, step: 1 }),
  event('turn/end', 7, { turn: 1, reason: { kind: 'completed' } }),
]

/**
 * Assemble the first turn's Chat from the real Chat Definitions plus the given ones.
 * @param extra - Definitions registered beside Chat's own.
 * @returns the Chat Nodes in order.
 */
function chatNodes(extra: readonly ConversationNodeDefinition[]): ChatConversationViewNode[] {
  const assembler = new ConversationNodeAssembler(
    { entries: () => [...extra, messageDefinition, assistantDefinition, turnProcessDefinition], fallbackEntry: () => undefined },
    { entries: () => [chatViewDefinition] },
  )
  assembler.replaceWindow(FIRST_TURN.map(entry => ({ type: 'event' as const, event: entry })), false)
  assembler.activateTarget('chat')
  const view = assembler.snapshot('chat') as ChatSnapshot
  return [...view.nodes.values()] as ChatConversationViewNode[]
}

/** The text of a Chat Node's message content, or undefined for a Node without content. */
function contentText(node: ChatConversationViewNode | undefined): string | undefined {
  const data = node?.data as { content?: readonly { type: string; text?: string }[] } | undefined
  return data?.content?.map(block => block.text ?? '').join('')
}

describe('newGameGuidanceDefinition', () => {
  it('claims only appended user messages whose source is the guidance', () => {
    expect(newGameGuidanceDefinition.match(userMessage('guidance', { kind: NEW_GAME_GUIDANCE_SOURCE }, GUIDANCE, 4)))
      .toEqual({ id: 'guidance', role: 'start', exclusive: true })
    expect(newGameGuidanceDefinition.match(userMessage('prompt', { kind: 'user' }, PROMPT, 3))).toBeNull()
    expect(newGameGuidanceDefinition.match(userMessage('todos', { kind: 'todo-continuation', form: 'notice', summary: '2 todos left' }, 'todos', 8))).toBeNull()
    expect(newGameGuidanceDefinition.match(userMessage('guidance', { kind: NEW_GAME_GUIDANCE_SOURCE }, GUIDANCE, 4, null))).toBeNull()
    expect(newGameGuidanceDefinition.match(FIRST_TURN[4] as never)).toBeNull()
  })

  it('leaves the guidance out of a new game\'s first turn in Chat, which shows the prompt and the reply', () => {
    const nodes = chatNodes([newGameGuidanceDefinition])

    expect(nodes.map(node => node.kind)).not.toContain('context')
    expect(nodes.filter(node => node.kind === 'user').map(contentText)).toEqual([PROMPT])
    expect(nodes.map(node => node.kind)).toContain('assistant-step')
    expect(JSON.stringify(nodes)).not.toContain('Play the game yourself')
  })

  it('is what keeps the guidance out: without it Chat shows the guidance as a context row', () => {
    const nodes = chatNodes([])

    expect(nodes.filter(node => node.kind === 'context').map(contentText)).toEqual([GUIDANCE])
  })
})
