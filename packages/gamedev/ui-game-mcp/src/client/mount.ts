/**
 * Remote contribution and registrations of the game MCP browser plugin: the setup for another agent as the Desktop
 * introduction's last step, after sign-in, and as the Other agents section of Settings, and the window opening each
 * Session that a connected agent's call asks it to show, such as the one whose game the agent started; the Session's
 * Game tab then opens for the agent's run.
 */
import type { Context } from '@deepseek-ai/cordis'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-game-mcp/remote'
import type { GameMcpView } from '@deepseek-ai/dsh-game-mcp/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AgentSetupIcon, AgentSetupSection, AgentSetupStep, type AgentSetupInjected } from './AgentSetup.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { createServerSource, type ServerSource } from './source.ts'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess']

/** Id of the Other agents section of Settings. */
const SECTION_ID = 'other-agents'

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-game-mcp: dictionaries')
  const t = ctx.locale.bind(NS)
  // The Host forwards the event only to windows that may read the Session.
  ctx.effect(() => ctx.remote.$on('game-mcp/reveal', (sessionId) => { ctx.get('uiWorkspace')?.openSession(sessionId) }), 'ui-game-mcp: reveal Sessions')
  ctx.remoteAccess.whenAccess('gameMcp/watch', function* () {
    const source: ServerSource = createServerSource(() => ctx.remote.$stream<GameMcpView>({
      name: 'game MCP server',
      open: signal => ctx.remote.gameMcp.watch(signal),
      ended: () => new Error('the game MCP server stream ended'),
    }))
    yield () => { source.close() }
    const injected = (): AgentSetupInjected => ({
      hooks: { server: source.observable },
      copyText: writeClipboard,
    })
    // The introduction shows the step after sign-in; Settings, which only a signed-in user reaches, keeps the section.
    yield ctx.slots.inject('settings.account.onboarding.agents', () => ctx.slots.register({
      name: 'settings.account.onboarding.agents', locale: NS, inject: injected,
    }, AgentSetupStep))
    yield ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section', id: SECTION_ID, order: 5, label: () => t('nav'), locale: NS, inject: injected,
    }, AgentSetupSection))
    yield ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
      name: 'settings.section.icon', id: SECTION_ID,
    }, AgentSetupIcon))
  })
}

/**
 * Mount the game MCP Remote, then the UI that calls it; the UI is withdrawn before the Remote.
 * @param ctx - client plugin lifetime.
 * @param contribution - generated game MCP Remote definitions.
 * @returns the disposer that removes both contributions.
 */
export async function mountGameMcp(ctx: Context, contribution: TypertRemoteContribution): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(contribution)
  const ui = ctx.inject(['remote.gameMcp', ...inject.slice(1)], registerUi)
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}
