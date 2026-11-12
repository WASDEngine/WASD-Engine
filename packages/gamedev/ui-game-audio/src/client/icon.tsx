/** Package-local glyphs of the Audio tab: its guide entry, chip, and volume glyph, and the player's repeat glyph. */
import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Draw a speaker sending out two sound waves, in the surrounding text color.
 * @param props - square edge in pixels (default 16) and a layout class.
 * @returns a decorative SVG glyph.
 */
export function AudioGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 6H4.8L8 3.3v9.4L4.8 10H2.5a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M10.4 6a2.8 2.8 0 0 1 0 4" stroke="currentColor" strokeLinecap="round" />
      <path d="M12.4 4.1a5.4 5.4 0 0 1 0 7.8" stroke="currentColor" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Draw two arrows chasing each other around a rounded loop: the sound repeats.
 * @param props - square edge in pixels (default 16) and a layout class.
 * @returns a decorative SVG glyph.
 */
export function RepeatGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M2.5 7.5V7A2.5 2.5 0 0 1 5 4.5h7.5" stroke="currentColor" strokeLinecap="round" />
      <path d="M10.8 2.8 12.5 4.5l-1.7 1.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M13.5 8.5V9A2.5 2.5 0 0 1 11 11.5H3.5" stroke="currentColor" strokeLinecap="round" />
      <path d="M5.2 13.2 3.5 11.5l1.7-1.7" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
