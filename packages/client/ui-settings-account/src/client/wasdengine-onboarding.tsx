/**
 * WASD Engine look of the desktop onboarding (fork-owned; `wasdengine/FORK.md` lists the fork changes): the welcome
 * and purpose headings show the brand kit lockup where upstream writes the product name, the welcome introduction sets
 * the product name in bold, and the Game programming card shows the game tools' logos in place of upstream's code-file
 * icons. `OnboardingWelcomeStep` renders {@link WasdengineHeadingBrand} and {@link emphasizeWasdengine};
 * `OnboardingPurposeStep` renders {@link WasdengineHeadingBrand} and {@link WasdengineToolIcons}.
 */
import type { ReactNode } from 'react'
import blender from './assets/wasdengine-tool-blender.svg'
import gimp from './assets/wasdengine-tool-gimp.svg'
import godot from './assets/wasdengine-tool-godot.svg'
import supercollider from './assets/wasdengine-tool-supercollider.svg'
import { WASDENGINE_PRODUCT_NAME } from './wasdengine-copy.ts'
import { WasdengineLockup } from './wasdengine-sign-in.tsx'
import css from './wasdengine-onboarding.module.css'

/** The Game programming card's tools in display order; each tile file carries its logo's credit and terms. */
const TOOL_TILES: readonly (readonly [name: string, src: string])[] = [
  ['godot', godot], ['blender', blender], ['gimp', gimp], ['supercollider', supercollider],
]

/**
 * Show the brand kit lockup in place of the product name in a heading, at the heading's font size.
 * @param props.label - the localized product name, which the heading keeps as visually hidden text, so assistive
 * technology, copied text, and the heading's text content still name the product.
 * @returns the decorative lockup followed by the hidden name.
 */
export function WasdengineHeadingBrand({ label }: { readonly label: string }): ReactNode {
  return (
    <span className={css.brand}>
      <WasdengineLockup className={css.lockup} />
      <span className={css.label}>{label}</span>
    </span>
  )
}

/**
 * Set each occurrence of the product name in a localized message in bold.
 * @param text - the message, which names the product as `WASD Engine` in every language.
 * @returns the message, with each occurrence of the product name in a `strong` element.
 */
export function emphasizeWasdengine(text: string): ReactNode {
  return text.split(WASDENGINE_PRODUCT_NAME).flatMap((part, index) => index === 0
    ? [part]
    : [<strong key={index} className={css.name}>{WASDENGINE_PRODUCT_NAME}</strong>, part])
}

/**
 * Draw the Game programming card's tool tiles, Godot, Blender, GIMP, and SuperCollider, in place of upstream's code-file
 * icons. Each tile is an `svg` element, the element the card's icon row lays out and animates, that shows its tile file.
 * @param props.size - edge length in pixels.
 * @returns the four decorative tiles.
 */
export function WasdengineToolIcons({ size }: { readonly size: number }): ReactNode {
  return TOOL_TILES.map(([name, src]) => (
    <svg key={name} width={size} height={size} viewBox="0 0 20 20" data-wasdengine-tool={name} aria-hidden>
      <image href={src} width="20" height="20" />
    </svg>
  ))
}
