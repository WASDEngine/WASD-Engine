/**
 * Remote contribution and registrations of the game MCP browser plugin: the setup panel in both sign-in dialogs,
 * and the window opening each Session that a connected agent's call asks it to show, such as the one whose game
 * the agent started; the Session's Game tab then opens for the agent's run.
 */
import type { Context } from '@deepseek-ai/cordis'
import { writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-game-mcp/remote'
import type { GameMcpView } from '@deepseek-ai/dsh-game-mcp/types'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { AgentSetup, type AgentSetupInjected } from './AgentSetup.tsx'
import { de, en, es, fr, ja, NS, pt, ru, zh } from './locales.ts'
import { createServerSource, type ServerSource } from './source.ts'

/** Services required before the Remote contribution mounts. */
export const inject = ['remote', 'slots', 'locale', 'remoteAccess']

/** The sign-in dialogs' alternative slots, which the setup panel fills. */
const ALTERNATIVE_SLOTS = ['settings.account.onboarding.alternative', 'settings.account.menu.alternative'] as const

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-game-mcp: dictionaries')
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
    for (const slot of ALTERNATIVE_SLOTS) {
      yield ctx.slots.inject(slot, () => ctx.slots.register({ name: slot, locale: NS, inject: injected }, AgentSetup))
    }
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
