/** Fake Agents registered in a real Agent registry, for the Godot Host specs. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, Model } from '@deepseek-ai/dsh-agent'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

/** A registered fake Agent and its lifetime controls. */
export interface FakeAgent {
  readonly agent: Agent
  /** Dispose the Agent's Context, as Session disposal does. */
  dispose(): Promise<void>
}

/**
 * Register a fake Agent.
 * @param ctx - Context with the Agent registry.
 * @param id - Session id.
 * @param route - model route `model.current()` reports; null reports none.
 * @returns the Agent.
 */
export async function fakeAgent(ctx: Context, id: string, route: { provider: string; model: string } | null = { provider: 'test', model: 'vision' }): Promise<FakeAgent> {
  const scope = ctx.plugin(() => {})
  const sessionId = SessionId(id)
  const model: Model = { current: () => route ?? undefined, select: () => {} }
  const agent: Agent = {
    id: sessionId, options: {}, session: Session.create(sessionId), model, inbox: createInboxStub(), status: 'idle', ctx: scope.ctx,
    send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const unregister = ctx.agents.register(agent)
  await unregister
  return {
    agent,
    async dispose() {
      await scope.dispose()
      await unregister()
    },
  }
}
