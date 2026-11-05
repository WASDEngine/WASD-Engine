/** Brand occupants: the WASDEngine brand marks and the home animation frame layer. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { PixelWhale } from './home-whale/PixelWhale.tsx'
import { applyWasdengineBrand } from './wasdengine-brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the WASDEngine brand marks and frame the blank home with the animation decoration.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.hero.frame', () => ctx.slots.register({
    name: 'conversation.hero.frame',
    id: 'pixel-whale',
  }, PixelWhale))
  applyWasdengineBrand(ctx)
}
