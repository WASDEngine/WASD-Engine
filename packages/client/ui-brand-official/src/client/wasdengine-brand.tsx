/**
 * WASDEngine brand occupants (fork-owned; `wasdengine/FORK.md` lists the fork changes): the WASD Engine
 * keycap symbol in the sidebar and blank-home hero brand-mark slots, and the Join Discord row at the
 * sidebar foot, in every build profile.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { applyWasdengineDiscord } from './wasdengine/discord.tsx'

/** Brand colors of the keycap parts: the raised W key, the A, S, and D keys, and the ink outlines. */
export const WASDENGINE_KEY_TONES = {
  highlight: { top: '#A585FF', side: '#8E63FF', front: '#6338D9', ink: '#17181D' },
  plain: { top: '#FFFFFF', side: '#EDEFF2', front: '#D2D6DD', ink: '#17181D' },
} as const

/**
 * One keycap of the brand symbol in its own 225-unit frame, back to front. The Desktop icon
 * sources (`apps/desktop/wasdengine/icon-*.svg`) and the Web favicons draw the same paths and
 * colors; on a light ground they add a drop shadow beneath each keycap, which the mark omits.
 */
export const WASDENGINE_KEYCAP = [
  { part: 'body', tone: 'side', d: 'M36 0H189A36 36 0 0 1 225 36V189A36 36 0 0 1 189 225H36A36 36 0 0 1 0 189V36A36 36 0 0 1 36 0Z' },
  { part: 'topEdge', tone: 'ink', d: 'M10.5525 10.5525A36 36 0 0 1 36 0H189A36 36 0 0 1 214.4475 10.5525L184.6575 17.8425L40.3425 17.8425Z' },
  { part: 'leftSide', tone: 'side', d: 'M10.5525 214.4475A36 36 0 0 1 0 189V36A36 36 0 0 1 10.5525 10.5525L40.3425 17.8425L40.3425 157.6575Z' },
  { part: 'rightSide', tone: 'side', d: 'M214.4475 10.5525A36 36 0 0 1 225 36V189A36 36 0 0 1 214.4475 214.4475L184.6575 157.6575L184.6575 17.8425Z' },
  { part: 'front', tone: 'front', d: 'M214.4475 214.4475A36 36 0 0 1 189 225H36A36 36 0 0 1 10.5525 214.4475L40.3425 157.6575L184.6575 157.6575Z' },
  { part: 'top', tone: 'top', d: 'M56.25 11.25H168.75A22.5 22.5 0 0 1 191.25 33.75V141.75A22.5 22.5 0 0 1 168.75 164.25H56.25A22.5 22.5 0 0 1 33.75 141.75V33.75A22.5 22.5 0 0 1 56.25 11.25Z' },
  { part: 'outline', tone: 'ink', d: 'M36 -7.875H189A43.875 43.875 0 0 1 232.875 36V189A43.875 43.875 0 0 1 189 232.875H36A43.875 43.875 0 0 1 -7.875 189V36A43.875 43.875 0 0 1 36 -7.875ZM36 7.875A28.125 28.125 0 0 0 7.875 36V189A28.125 28.125 0 0 0 36 217.125H189A28.125 28.125 0 0 0 217.125 189V36A28.125 28.125 0 0 0 189 7.875ZM56.25 3.375H168.75A30.375 30.375 0 0 1 199.125 33.75V141.75A30.375 30.375 0 0 1 168.75 172.125H56.25A30.375 30.375 0 0 1 25.875 141.75V33.75A30.375 30.375 0 0 1 56.25 3.375ZM56.25 19.125A14.625 14.625 0 0 0 41.625 33.75V141.75A14.625 14.625 0 0 0 56.25 156.375H168.75A14.625 14.625 0 0 0 183.375 141.75V33.75A14.625 14.625 0 0 0 168.75 19.125ZM3.5775 210.8025L33.3675 154.0125L47.3175 161.325L17.5275 218.115ZM207.4725 218.115L177.6825 161.325L191.6325 154.0125L221.4225 210.8025ZM12.42 2.9025L42.21 10.1925L38.475 25.4925L8.6625 18.2025ZM216.3375 18.2025L186.525 25.4925L182.79 10.1925L212.58 2.9025Z' },
] as const

/** Keycap origins in the 1024-unit frame of the Desktop icon sources, W first. */
export const WASDENGINE_KEYS = [
  { key: 'w', x: 445, y: 292, tone: 'highlight' },
  { key: 'a', x: 184, y: 553, tone: 'plain' },
  { key: 's', x: 445, y: 553, tone: 'plain' },
  { key: 'd', x: 706, y: 553, tone: 'plain' },
] as const

/** The keycaps' bounds with their outlines, in icon-frame units; the rendered height keeps this aspect ratio. */
const BOUNDS = { x: 176.125, y: 284.125, width: 762.75, height: 501.75 } as const

/**
 * Render the WASD Engine keycap symbol in its brand colors.
 * @param props.size - rendered width in pixels.
 * @param props.className - host class that keeps the surrounding mark geometry.
 * @returns the decorative mark svg.
 */
export function WasdengineMark({ size, className }: HeroBrandMarkOwnerProps) {
  return (
    <svg
      width={size}
      height={(size * BOUNDS.height) / BOUNDS.width}
      className={className}
      viewBox={`${BOUNDS.x} ${BOUNDS.y} ${BOUNDS.width} ${BOUNDS.height}`}
      fill="none"
      aria-hidden="true"
    >
      {WASDENGINE_KEYS.map(({ key, x, y, tone }) => (
        <g key={key} transform={`translate(${x} ${y})`}>
          {WASDENGINE_KEYCAP.map(({ part, tone: paint, d }) => <path key={part} d={d} fill={WASDENGINE_KEY_TONES[tone][paint]} />)}
        </g>
      ))}
    </svg>
  )
}

/**
 * Fill the sidebar brand mark and the hero brand mark with {@link WasdengineMark}, and, once the
 * locale service is available, put the Join Discord row at the sidebar foot. Each registration
 * waits for its slot's declaration and leaves with the caller's fiber.
 * @param ctx - Client root context.
 */
export function applyWasdengineBrand(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, WasdengineMark))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, WasdengineMark))
  ctx.inject(['slots', 'locale'], applyWasdengineDiscord)
}
