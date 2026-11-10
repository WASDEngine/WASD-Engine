// @vitest-environment jsdom
/**
 * The shipped Web client composition: the setup for another agent fills the Desktop introduction's last step and adds
 * the Other agents section to Settings, the plugin opens no Remote call at boot, and a reveal event opens the Session it
 * names.
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, expect, vi } from 'vitest'
import { AgentSetupIcon, AgentSetupSection, AgentSetupStep } from '../src/client/AgentSetup.tsx'

const it = createClientTest({ roster: webApp })

afterEach(() => { vi.unstubAllGlobals() })

it('adds the Other agents section to Settings, after General', async ({ start }) => {
  const c = await start()
  const entries = c.ctx.slots.entries('settings.section').filter(entry => entry.component === AgentSetupSection)
  expect(entries.map(entry => [entry.options.id, entry.options.order])).toEqual([['other-agents', 5]])
  const label = entries[0]?.options.label
  expect(typeof label === 'function' ? label() : label).toBe('Other agents')
  const icons = c.ctx.slots.entries('settings.section.icon').filter(entry => entry.component === AgentSetupIcon)
  expect(icons.map(entry => entry.options.id)).toEqual(['other-agents'])
}, 60_000)

it('fills the Desktop introduction\'s last step, after sign-in', async ({ start }) => {
  // The account plugin declares the introduction, and with it the step's slot, in the Desktop app only.
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  const entries = c.ctx.slots.entries('settings.account.onboarding.agents')
  expect(entries.map(entry => entry.component)).toEqual([AgentSetupStep])
}, 60_000)

it('opens the Session that a reveal event names', async ({ start }) => {
  const c = await start()
  const workspace = c.ctx.get('uiWorkspace')
  expect(workspace).toBeDefined()
  const openSession = vi.spyOn(workspace!, 'openSession').mockImplementation(() => {})
  c.mock.streams.push('$events', { type: 'emit', event: 'game-mcp/reveal', args: [brandString<SessionId>('session-of-claude')] })
  await vi.waitFor(() => { expect(openSession).toHaveBeenCalledWith('session-of-claude') })
}, 60_000)
