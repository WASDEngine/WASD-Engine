// @vitest-environment jsdom
/**
 * The shipped Web client composition: both sign-in dialogs declare their alternative slots, the setup panel fills
 * them, the plugin opens no Remote call at boot, and a reveal event opens the Session it names.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, vi } from 'vitest'
import { AgentSetup } from '../src/client/AgentSetup.tsx'

const it = createClientTest({ roster: webApp })

it('fills both sign-in dialogs\' alternative slots with the setup panel', async ({ start }) => {
  const c = await start()
  for (const slot of ['settings.account.onboarding.alternative', 'settings.account.menu.alternative'] as const) {
    const entries = c.ctx.slots.entries(slot)
    expect(entries.map(entry => entry.component)).toEqual([AgentSetup])
    expect(entries[0]?.options).toEqual({})
  }
}, 60_000)

it('opens the Session that a reveal event names', async ({ start }) => {
  const c = await start()
  const workspace = c.ctx.get('uiWorkspace')
  expect(workspace).toBeDefined()
  const openSession = vi.spyOn(workspace!, 'openSession').mockImplementation(() => {})
  c.mock.streams.push('$events', { type: 'emit', event: 'game-mcp/reveal', args: [brandString<SessionId>('session-of-claude')] })
  await vi.waitFor(() => { expect(openSession).toHaveBeenCalledWith('session-of-claude') })
}, 60_000)
