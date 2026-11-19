/**
 * Keeps the new game guidance out of Chat. The `new-game-guidance` plugin of the `gamedev` preset enters its text as a
 * message of that source kind right after the user's first prompt for a new game, so the model reads it at the end of
 * the prompt; this Definition claims those messages on the Chat target and builds no Node for them, so Chat shows the
 * prompt as the user wrote it.
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'

/** The message source kind that `@deepseek-ai/dsh-new-game-guidance` writes. */
export const NEW_GAME_GUIDANCE_SOURCE = 'new-game-guidance'

/** Claims the guidance messages on the Chat target, so the generic message Definition never presents them. */
export const newGameGuidanceDefinition: ConversationNodeDefinition<null> = {
  kind: 'wasd-new-game-guidance',
  target: 'chat',
  match: (event) => {
    if (event.type !== 'user/message' || !isAppendSurfaceEvent(event)) return null
    // The source kind is merge-extensible; this package does not load the producer's declaration.
    const kind: string = event.data.source.kind
    return kind === NEW_GAME_GUIDANCE_SOURCE ? { id: String(event.data.id), role: 'start', exclusive: true } : null
  },
  start: () => null,
  update: context => context.state,
  buildViewNode: () => null,
}
