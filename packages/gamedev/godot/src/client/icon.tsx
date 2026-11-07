/** Package-local game controller glyph of the Game tab, its guide entry, and the Godot tool cards. */
import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Draw a game controller outline in the surrounding text color.
 * @param props - square edge in pixels (default 16) and a layout class.
 * @returns a decorative SVG glyph.
 */
export function GameControllerIcon({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path
        d="M5.2 3.7h5.6c1.9 0 3.2 1.3 3.6 3.2l.6 3c.3 1.4-.6 2.6-1.9 2.6-.8 0-1.4-.4-1.8-1.1l-.6-1.1H5.3l-.6 1.1c-.4.7-1 1.1-1.8 1.1-1.3 0-2.2-1.2-1.9-2.6l.6-3c.4-1.9 1.7-3.2 3.6-3.2Z"
        stroke="currentColor"
        strokeLinejoin="round"
      />
      <path d="M5 6.2v2.4M3.8 7.4h2.4" stroke="currentColor" strokeLinecap="round" />
      <circle cx="10.6" cy="6.8" r="0.65" fill="currentColor" />
      <circle cx="11.8" cy="8.1" r="0.65" fill="currentColor" />
    </svg>
  )
}
