// @vitest-environment jsdom
/**
 * The shipped Web client composition: WASD Engine Plugins registers the Release button among the Session header actions
 * and among the New Session options, which a blank Session shows while its header has no actions, and Explore Games at
 * the sidebar foot; unloading the plugin removes all three.
 */
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { expect } from 'vitest'
import { ExploreLink } from '../src/client/ExploreLink.tsx'
import { ReleaseButton } from '../src/client/ReleaseButton.tsx'

const it = createClientTest({ roster: webApp })

const SELF = '@deepseek-ai/dsh-wasd-plugins'

it('registers the Release button in the Session header and the New Session row, and removes both on unload', async ({ start }) => {
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

  await c.unload(SELF)
  expect(placements()).toEqual([[], []])
  expect(c.ctx.slots.entries('sidebar.footer.action').filter(entry => entry.component === ExploreLink)).toHaveLength(0)
}, 60_000)
