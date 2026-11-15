/**
 * WASD Engine: the prompt Remote records `answersQuestion` on the source of a steered message that carries part of the
 * user's answer to the agent's question, and refuses it on a queued or empty prompt.
 */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentModel, modelSelectionProjectionDefinition, type Agent } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type Session, type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionPromptRequest, SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

let nextRequestId = 1
function promptRequest(payload: Omit<SessionPromptRequest, 'requestId'>): SessionPromptRequest {
  return { ...payload, requestId: `answer-${String(nextRequestId++)}` as SessionRequestId }
}

async function modelFor(context: Context, session: Session): Promise<AgentModel> {
  const projection = await context.sessionProjections.register(modelSelectionProjectionDefinition)
  return new AgentModel(() => projection.stateOf(session), session, { provider: 'p', model: 'm' })
}

/** A live Agent whose delivery verbs record the messages the Remote admits. */
async function composed() {
  const context = ctx = new Context()
  await context.plugin(SessionStore)
  await context.plugin(SessionProjectionRegistry)
  await context.plugin(AgentRegistry)
  const session = context.sessions.create('session-answer' as SessionId, { meta: { cwd: '/proj' } })
  const steer = vi.fn<(message: UserMessage) => void>()
  const followup = vi.fn<(message: UserMessage) => void>()
  const agent: Agent = {
    id: session.id, session, model: await modelFor(context, session), options: { provider: 'p', model: 'm' },
    inbox: createInboxStub(), status: 'running', ctx: context, followup, steer,
    cancel: vi.fn(), whenIdle: () => Promise.resolve(),
    runMaintenance: async () => { throw new Error('unexpected maintenance') },
    send: vi.fn(), inject: vi.fn(),
  }
  await context.agents.register(agent)
  const remote = await createSessionTestRemote(context, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return { remote, agent, steer, followup }
}

describe('a prompt that answers a question', () => {
  it('records answersQuestion on the steered message\'s source, and leaves other prompts\' sources as they were', async () => {
    const { remote, agent, steer } = await composed()
    const answer = promptRequest({ sessionId: agent.id, mode: 'steer', content: [{ type: 'text', text: 'Images for my answer:' }], answersQuestion: true })
    await expect(remote.prompt(answer)).resolves.toMatchObject({ ok: true })
    const plain = promptRequest({ sessionId: agent.id, mode: 'steer', content: [{ type: 'text', text: 'Stop after the terrain.' }] })
    await expect(remote.prompt(plain)).resolves.toMatchObject({ ok: true })
    expect(steer.mock.calls.map(([message]) => message.source)).toEqual([
      { kind: 'user', rpcId: answer.requestId, answersQuestion: true },
      { kind: 'user', rpcId: plain.requestId },
    ])
  })

  it('refuses answersQuestion on a queued or empty prompt, before delivery', async () => {
    const { remote, agent, steer, followup } = await composed()
    for (const request of [
      promptRequest({ sessionId: agent.id, mode: 'queue', content: [{ type: 'text', text: 'Images:' }], answersQuestion: true }),
      promptRequest({ sessionId: agent.id, mode: 'steer', content: [], answersQuestion: true }),
    ]) {
      await expect(remote.prompt(request)).resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/bad-request', message: 'a prompt that answers a question must steer content' },
      })
    }
    expect(steer).not.toHaveBeenCalled()
    expect(followup).not.toHaveBeenCalled()
  })
})
