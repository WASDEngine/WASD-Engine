// @vitest-environment jsdom
/**
 * The shipped Web client composition: WASD Engine Plugins registers the Release button among the Session header actions
 * and among the New Session options, which a blank Session shows while its header has no actions, Explore Games at the
 * sidebar foot, and the first build tip among the model seat's callouts; unloading the plugin removes all four.
 */
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { expect } from 'vitest'
import { ExploreLink } from '../src/client/ExploreLink.tsx'
import { FirstBuildTip } from '../src/client/FirstBuildTip.tsx'
import { ReleaseButton } from '../src/client/ReleaseButton.tsx'

const it = createClientTest({ roster: webApp })

const SELF = '@deepseek-ai/dsh-wasd-plugins'

it('registers the Release button, Explore Games, and the first build tip, and removes them on unload', async ({ mock, start }) => {
  // The tier proxies a Remote namespace that a roster module injects or the mock answers; the first build tip
  // waits for Agent Teams' namespace, which no roster module injects.
  mock.unary('agentTeams/setEnabled', undefined)
  const c = await start()
  const placements = () => (['conversation.session.header.actions', 'conversation.hero.options'] as const).map(slot => c.ctx.slots.entries(slot)
    .filter(entry => entry.component === ReleaseButton)
    .map((entry) => {
      const face: unknown = typeof entry.inject === 'function' ? entry.inject() : undefined
      return [slot, entry.options.id, entry.options.order, typeof face === 'object' && face !== null && 'placement' in face ? face.placement : undefined]
    }))
  expect(placements()).toEqual([
    [['conversation.session.header.actions', 'wasd-release', -9, 'header']],
    [['conversation.hero.options', 'wasd-release', -9, 'newSession']],
  ])
  expect(c.ctx.slots.entries('sidebar.footer.action').filter(entry => entry.component === ExploreLink)).toHaveLength(1)
  const tips = () => c.ctx.slots.entries('conversation.input.model.callout')
    .filter(entry => entry.component === FirstBuildTip)
    .map(entry => entry.options.id)
  expect(tips()).toEqual(['wasd-first-build'])

  await c.unload(SELF)
  expect(placements()).toEqual([[], []])
  expect(c.ctx.slots.entries('sidebar.footer.action').filter(entry => entry.component === ExploreLink)).toHaveLength(0)
  expect(tips()).toEqual([])
}, 60_000)
