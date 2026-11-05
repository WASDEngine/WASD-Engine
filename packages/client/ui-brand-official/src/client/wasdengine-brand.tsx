/**
 * WASDEngine brand occupants (fork-owned; `wasdengine/FORK.md` lists the fork changes): the WASD
 * keycap mark in the sidebar and blank-home hero brand-mark slots, in every build profile.
 */
import { useId } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Keycaps in the mark's user space, W first: each is a 250-unit rounded square at the origin
 * the Desktop icon sources (`apps/desktop/wasdengine/icon-*.svg`) give its key group, and its
 * letter is that source's `glyph-<key>` stroke in a 100-unit glyph box.
 */
const KEYS = [
  { key: 'w', x: 427, y: 280, letter: 'M8 18 L28 84 L50 34 L72 84 L92 18' },
  { key: 'a', x: 149, y: 558, letter: 'M14 86 L50 14 L86 86 M29 58 L71 58' },
  { key: 's', x: 427, y: 558, letter: 'M80 26 C76 16 64 12 50 12 C34 12 22 20 22 32 C22 46 36 50 50 52 C66 54 80 58 80 72 C80 84 68 90 50 90 C34 90 22 84 18 74' },
  { key: 'd', x: 705, y: 558, letter: 'M22 14 L22 86 L44 86 C70 86 84 70 84 50 C84 30 70 14 44 14 Z' },
] as const

/** The keycap cluster's bounds in user units; the rendered height keeps this aspect ratio. */
const BOUNDS = { x: 149, y: 280, width: 806, height: 528 } as const

/**
 * Render the WASD keycap mark in the host's current ink, letters cut out of the keycaps.
 * @param props.size - rendered width in pixels.
 * @param props.className - host class that keeps the surrounding mark geometry.
 * @returns the decorative mark svg.
 */
export function WasdengineMark({ size, className }: HeroBrandMarkOwnerProps) {
  // One mask per instance: the sidebar and the hero can mount several marks at once.
  const mask = `wasdengine-mark-${useId().replaceAll(':', '')}`
  return (
    <svg
      width={size}
      height={(size * BOUNDS.height) / BOUNDS.width}
      className={className}
      viewBox={`${BOUNDS.x} ${BOUNDS.y} ${BOUNDS.width} ${BOUNDS.height}`}
      fill="none"
      aria-hidden="true"
    >
      <mask id={mask} maskUnits="userSpaceOnUse" x={BOUNDS.x} y={BOUNDS.y} width={BOUNDS.width} height={BOUNDS.height}>
        <rect x={BOUNDS.x} y={BOUNDS.y} width={BOUNDS.width} height={BOUNDS.height} fill="white" />
        <g stroke="black" strokeWidth={16} strokeLinecap="round" strokeLinejoin="round">
          {KEYS.map(({ key, x, y, letter }) => (
            <path key={key} transform={`translate(${x + 60} ${y + 47}) scale(1.3)`} d={letter} />
          ))}
        </g>
      </mask>
      <g mask={`url(#${mask})`} fill="currentColor">
        {KEYS.map(({ key, x, y }) => <rect key={key} x={x} y={y} width={250} height={250} rx={48} />)}
      </g>
    </svg>
  )
}

/**
 * Fill the sidebar brand mark and the hero brand mark with {@link WasdengineMark}. Each
 * registration waits for its slot's declaration and leaves with the caller's fiber.
 * @param ctx - Client root context.
 */
export function applyWasdengineBrand(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, WasdengineMark))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, WasdengineMark))
}
