/**
 * Explore Games, the first link at the foot of the left sidebar, above Settings: it opens the WASD Engine site's Explore
 * page of released games in the browser (the system browser in the Desktop app, a new tab in the Web UI). On the narrow
 * rail it shows its globe alone, with the label as a tooltip.
 */
import { IconGlobeOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import css from './ExploreLink.module.css'

/** Registration-side operations of Explore Games. */
export interface ExploreLinkInjected {
  /** Open the Explore page. */
  readonly openExplore: () => void
}

/** Props of {@link ExploreLink}. */
export type ExploreLinkProps = PropsRuntime<'sidebar.footer.action'> & PropsLocale<typeof NS> & InjectFace<ExploreLinkInjected>

/**
 * Render Explore Games.
 * @param props - composed slot props.
 * @returns the sidebar row.
 */
export function ExploreLink({ wide, t, openExplore }: ExploreLinkProps) {
  const label = t('explore.label')
  return (
    <Tooltip label={wide ? t('explore.tooltip') : label} delayMs={500}>
      <button type="button" className={css.row} data-collapsed={!wide} aria-label={label} onClick={openExplore}>
        <span className={css.glyph} aria-hidden="true"><IconGlobeOutlineRegular size={wide ? 16 : 18} /></span>
        {wide && <span className={css.title}>{label}</span>}
      </button>
    </Tooltip>
  )
}
