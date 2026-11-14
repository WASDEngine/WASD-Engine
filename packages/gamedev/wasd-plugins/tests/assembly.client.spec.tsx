// @vitest-environment jsdom
/**
 * The shipped Web client composition: WASD Engine Plugins registers the Export / Share button among the Session header actions
 * and among the New Session options, which a blank Session shows while its header has no actions, the Play and Build
 * switch in the sidebar's mode seat with the Play page as its main panel, and the first build tip among the model
 * seat's callouts; unloading the plugin removes all of them.
 */
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { expect } from 'vitest'
import { PLAY_PANEL } from '../src/client/play.ts'
import { PlayBuildToggle } from '../src/client/PlayBuildToggle.tsx'
import { PlayPage } from '../src/client/PlayPage.tsx'
import { FirstBuildTip } from '../src/client/FirstBuildTip.tsx'
import { ExportShareButton } from '../src/client/ExportShareButton.tsx'

const it = createClientTest({ roster: webApp })

const SELF = '@deepseek-ai/dsh-wasd-plugins'

it('registers the Export / Share button, the Play page and its switch, and the first build tip, and removes them on unload', async ({ mock, start }) => {
  // The tier proxies a Remote namespace that a roster module injects or the mock answers; the first build tip
  // waits for Agent Teams' namespace, which no roster module injects.
  mock.unary('agentTeams/setEnabled', undefined)
  const c = await start()
  const placements = () => (['conversation.session.header.actions', 'conversation.hero.options'] as const).map(slot => c.ctx.slots.entries(slot)
    .filter(entry => entry.component === ExportShareButton)
    .map((entry) => {
      const face: unknown = typeof entry.inject === 'function' ? entry.inject() : undefined
      return [slot, entry.options.id, entry.options.order, typeof face === 'object' && face !== null && 'placement' in face ? face.placement : undefined]
    }))
  expect(placements()).toEqual([
    [['conversation.session.header.actions', 'wasd-export-share', -9, 'header']],
    [['conversation.hero.options', 'wasd-export-share', -9, 'newSession']],
  ])
  const play = () => [
    ...c.ctx.slots.entries('sidebar.mode').filter(entry => entry.component === PlayBuildToggle).map(() => 'switch'),
    ...c.ctx.slots.entries('main').filter(entry => entry.component === PlayPage).map(entry => entry.options.key),
  ]
  expect(play()).toEqual(['switch', PLAY_PANEL])
  const tips = () => c.ctx.slots.entries('conversation.input.model.callout')
    .filter(entry => entry.component === FirstBuildTip)
    .map(entry => entry.options.id)
  expect(tips()).toEqual(['wasd-first-build'])

  await c.unload(SELF)
  expect(placements()).toEqual([[], []])
  expect(play()).toEqual([])
  expect(tips()).toEqual([])
}, 60_000)
