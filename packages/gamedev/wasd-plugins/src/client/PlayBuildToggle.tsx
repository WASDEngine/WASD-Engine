/**
 * The Play and Build switch at the top of the left sidebar, in the New Session bar's place: Play shows the Play page
 * (the WASD Engine site's games and the game library) in the main column, and Build returns to the Sessions where
 * games are made. Play is on while the Play page is the main panel. On the narrow rail the two show their icons alone,
 * with their labels as tooltips.
 */
import { IconEditOutlineRegular, IconPlayOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { PLAY_PANEL } from './play.ts'
import css from './PlayBuildToggle.module.css'

/** @returns the class names that are set, joined. */
function classes(...names: readonly (string | false | undefined)[]): string {
  return names.filter(name => typeof name === 'string' && name !== '').join(' ')
}

/** Registration-side operations of the switch. */
export interface PlayBuildToggleInjected {
  /** Show the Play page. */
  readonly play: () => void
  /** Return to the Sessions. */
  readonly build: () => void
}

/** Props of {@link PlayBuildToggle}. */
export type PlayBuildToggleProps = PropsRuntime<'sidebar.mode'> & PropsLocale<typeof NS> & InjectFace<PlayBuildToggleInjected>

/**
 * Render the switch.
 * @param props - composed slot props.
 * @returns the two-way switch.
 */
export function PlayBuildToggle({ wide, usePanelInfo, t, play, build }: PlayBuildToggleProps) {
  const playing = usePanelInfo(info => info.activePanelId === PLAY_PANEL)
  const modes = [
    { id: 'play', label: t('mode.play'), tooltip: t('mode.playTooltip'), icon: IconPlayOutlineRegular, active: playing, choose: play },
    { id: 'build', label: t('mode.build'), tooltip: t('mode.buildTooltip'), icon: IconEditOutlineRegular, active: !playing, choose: build },
  ] as const
  return (
    <div className={classes(css.root, !wide && css.rail)} role="group" aria-label={t('mode.label')}>
      {modes.map(({ id, label, tooltip, icon: Icon, active, choose }) => (
        <Tooltip key={id} label={wide ? tooltip : label} delayMs={500} side="right">
          <button
            type="button"
            className={classes(css.mode, active && css.active)}
            aria-pressed={active}
            aria-label={label}
            data-mode={id}
            onClick={() => { if (!active) choose() }}
          >
            <Icon size={wide ? 14 : 18} className={css.icon} />
            {wide && <span className={css.label}>{label}</span>}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
