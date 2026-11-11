/** Package-local glyphs of the Assets tab: its guide entry and chip glyph, and the file glyph of 3D models. */
import type { ReactNode } from 'react'
import type { IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './icon.module.css'

/**
 * Draw a picture frame with a cube in front of its corner, in the surrounding text color. The frame stops short of
 * the cube instead of being masked, because the guide recolors every filled and stroked shape of its glyphs.
 * @param props - square edge in pixels (default 16) and a layout class.
 * @returns a decorative SVG glyph.
 */
export function AssetsGlyph({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" className={className} aria-hidden="true">
      <path d="M7.05 10.5H3.5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2.3" stroke="currentColor" strokeLinecap="round" />
      <path d="M3.6 8.4 5.4 6.4l1.4 1.4" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="8.6" cy="4.6" r="1" fill="currentColor" />
      <path d="M11.5 7.5l3.25 1.875v3.75L11.5 15l-3.25-1.875v-3.75Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M8.25 9.375 11.5 11.25l3.25-1.875M11.5 11.25V15" stroke="currentColor" strokeLinejoin="round" />
    </svg>
  )
}

// The document outline and folded corner of the shared file glyphs (ui-primitives FileTypeIcon), so a model's row
// matches the image rows beside it.
const FILE_BODY = 'M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 26.0417 25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 26.3909 8.09593 26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 6.86303 25.7177 6.69799 25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 19.3769 0.38885C19.126 0.220541 18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 0.349145C3.31672 0.814671 2.4238 1.70759 1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 6.88011V21.1199C1.60913 23.257 1.60913 24.3256 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 27.6509C5.28351 28 6.35209 28 8.48924 28Z'
const FILE_FOLD = 'M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 6.48096 19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 7.37445H26.3909Z'

/**
 * Draw the file glyph of a 3D model: the shared document outline with a cube on it.
 * @param props - square edge in pixels (default 28) and a layout class.
 * @returns a decorative SVG glyph.
 */
export function ModelFileIcon({ size = 28, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" className={className === undefined ? css.model : `${css.model} ${className}`} aria-hidden="true">
      <path d={FILE_BODY} fill="currentColor" />
      <path d={FILE_FOLD} fill="var(--dsw-static-neutral-00)" fillOpacity=".7" />
      <g color="var(--dsw-static-neutral-00)">
        <path d="M14 10.4l4.5 2.6v5.2L14 20.8l-4.5-2.6V13Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
        <path d="M9.5 13 14 15.6l4.5-2.6M14 15.6v5.2" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" />
      </g>
    </svg>
  )
}
