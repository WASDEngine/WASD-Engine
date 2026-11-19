/**
 * The Audio tab's list of sounds: folder headings that fold their sounds away, or ranked search results that name
 * each sound's folder. A click plays a sound, or pauses the selected one while it plays; the arrow keys move through
 * the sounds and keep playing when a sound plays, so a listener can run through a folder of effects by ear.
 */
import clsx from 'clsx'
import { memo, useCallback, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { IconChevronRightOutlineRegular, IconFolderCloseRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { clockText } from './format.ts'
import { AudioGlyph } from './icon.tsx'
import type { NS } from './locales.ts'
import type { ListRow, SoundItem } from './rows.ts'
import css from './SoundList.module.css'

/** Props of {@link SoundList}. */
export interface SoundListProps extends PropsLocale<typeof NS> {
  readonly rows: readonly ListRow[]
  /** Workspace path of the selected sound. */
  readonly selected: string | undefined
  /** Workspace path of the sound playing in this tab. */
  readonly playing: string | undefined
  /** @param item - the clicked sound. */
  readonly onActivate: (item: SoundItem) => void
  /** @param step - `1` to move to the next sound, `-1` to the previous one. */
  readonly onStep: (step: 1 | -1) => void
  /** @param folder - workspace path of the folder to fold or unfold. */
  readonly onToggleFolder: (folder: string) => void
}

/** A sound's length in its row: hundredths under ten seconds, tenths under a minute, then the clock. */
function durationText(item: SoundItem, t: SoundListProps['t']): string {
  const seconds = item.probe?.seconds
  if (seconds === undefined) return ''
  if (seconds >= 60) return clockText(seconds)
  return t('unit.seconds', { value: seconds.toFixed(seconds < 10 ? 2 : 1) })
}

/**
 * Render the list.
 * @param props - the rows, the selection, the playing sound, the handlers, and copy.
 * @returns the list.
 */
export function SoundList({ rows, selected, playing, onActivate, onStep, onToggleFolder, t }: SoundListProps): ReactNode {
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const focusedWithin = useRef(false)
  // Stable handlers, so a row renders again only when its own props change.
  const activating = useRef(onActivate)
  activating.current = onActivate
  const activate = useCallback((item: SoundItem) => { activating.current(item) }, [])
  const register = useCallback((path: string, element: HTMLButtonElement | null) => {
    if (element === null) buttons.current.delete(path)
    else buttons.current.set(path, element)
  }, [])
  // The selected row takes the focus when the arrow keys or an agent moved the selection while the list had it.
  useEffect(() => {
    if (selected === undefined) return
    const button = buttons.current.get(selected)
    if (button === undefined) return
    button.scrollIntoView({ block: 'nearest' })
    if (focusedWithin.current) button.focus({ preventScroll: true })
  }, [selected])
  const firstSound = rows.find(row => row.type === 'sound')
  const tabbable = selected !== undefined && rows.some(row => row.type === 'sound' && row.item.entry.path === selected)
    ? selected
    : firstSound?.type === 'sound' ? firstSound.item.entry.path : undefined
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    onStep(event.key === 'ArrowDown' ? 1 : -1)
  }
  return (
    <div
      className={css.list}
      aria-label={t('list.label')}
      role="group"
      onKeyDown={onKeyDown}
      onFocus={() => { focusedWithin.current = true }}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) focusedWithin.current = false }}
    >
      {rows.map((row) => {
        if (row.type === 'folder') {
          const label = row.folder === '' ? t('list.projectFolder') : row.folder
          return (
            <button
              key={`folder:${row.folder}`}
              type="button"
              className={css.folder}
              aria-expanded={row.open}
              tabIndex={-1}
              title={label}
              onClick={() => { onToggleFolder(row.folder) }}
            >
              <IconChevronRightOutlineRegular size={14} className={clsx(css.chevron, row.open && css.chevronOpen)} />
              <IconFolderCloseRegular size={14} className={css.folderGlyph} />
              <span className={css.folderName}>{label}</span>
              <span className={css.count} aria-label={t(row.count === 1 ? 'list.count.one' : 'list.count.other', { count: row.count })}>{row.count}</span>
            </button>
          )
        }
        const { path } = row.item.entry
        return (
          <SoundRow
            key={path}
            item={row.item}
            withFolder={row.withFolder}
            selected={path === selected}
            playing={path === playing}
            tabbable={path === tabbable}
            onActivate={activate}
            register={register}
            t={t}
          />
        )
      })}
    </div>
  )
}

/** Props of one sound's row. */
interface SoundRowProps extends PropsLocale<typeof NS> {
  readonly item: SoundItem
  readonly withFolder: boolean
  readonly selected: boolean
  readonly playing: boolean
  readonly tabbable: boolean
  readonly onActivate: (item: SoundItem) => void
  readonly register: (path: string, element: HTMLButtonElement | null) => void
}

/** One sound's row, which renders again only when its own props change. */
const SoundRow = memo(function SoundRow({
  item, withFolder, selected, playing, tabbable, onActivate, register, t,
}: SoundRowProps): ReactNode {
  const { entry } = item
  return (
    <button
      ref={(element) => { register(entry.path, element) }}
      type="button"
      className={clsx(css.sound, withFolder && css.soundFlat)}
      aria-current={selected ? 'true' : undefined}
      tabIndex={tabbable ? 0 : -1}
      title={entry.path}
      onClick={() => { onActivate(item) }}
    >
      <span className={clsx(css.state, playing && css.statePlaying)} aria-hidden="true"><AudioGlyph size={14} /></span>
      <span className={css.soundName}>{entry.name}</span>
      {withFolder && entry.folder !== '' && <span className={css.soundFolder}>{entry.folder}</span>}
      <span className={css.duration}>{durationText(item, t)}</span>
    </button>
  )
})
