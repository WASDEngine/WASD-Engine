/**
 * Body and chip title of the Audio tab: a search field and refresh control, the All / Effects / Dialogue / Music
 * filter, the selected sound's player, and the list of the project's sounds. Showing the tab walks the project unless
 * the latest walk is fresh; an agent's request to show a sound selects it.
 */
import clsx from 'clsx'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { audioCategoryOf, audioFormatOf } from '@deepseek-ai/dsh-game-audio/audio'
import {
  Button, IconCloseFillRegular, IconRefreshOutlineRegular, IconSearchOutlineRegular, Input, SegmentedControl, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `useResource` standard prop and the right Sidebar's tab props.
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { AudioGlyph } from './icon.tsx'
import type { NS } from './locales.ts'
import type { PlaybackState } from './playback.ts'
import type { SoundFile } from './read.ts'
import { listRows, shownSounds, soundItems, stepSound, type SoundItem } from './rows.ts'
import { SoundList } from './SoundList.tsx'
import { SoundPlayer, type PlaybackControls, type PlayRequest } from './SoundPlayer.tsx'
import type { KindFilter, ProbeEntry, ScanState, ViewState } from './source.ts'
import css from './AudioTab.module.css'

/** Business face of the Audio tab body, bound to one Session. */
export interface AudioTabInjected {
  /** The walk, the listener's choices, the header facts, and the window's player; bound as `use<Name>` hooks. */
  readonly hooks: {
    readonly scan: HostObservable<ScanState>
    readonly view: HostObservable<ViewState>
    readonly probes: HostObservable<ReadonlyMap<string, ProbeEntry>>
    readonly playback: HostObservable<PlaybackState>
  }
  /** Walk the project now, unless a walk runs. */
  readonly rescan: () => void
  /** Walk the project unless the latest walk is fresh or one runs. */
  readonly refresh: () => void
  /** @param path - workspace path of the sound to select, or undefined for none. */
  readonly select: (path: string | undefined) => void
  /** @param query - the search text. */
  readonly setQuery: (query: string) => void
  /** @param filter - which kinds the list shows. */
  readonly setFilter: (filter: KindFilter) => void
  /** @param folder - workspace path of the folder to fold or unfold. */
  readonly toggleFolder: (folder: string) => void
  /**
   * Claim a tab's navigation once.
   * @param tabId - the tab.
   * @param revision - the navigation's revision.
   * @returns whether the revision is new for the tab.
   */
  readonly takeNavigation: (tabId: string, revision: number) => boolean
  /**
   * Read a sound completely.
   * @param path - workspace path.
   * @param signal - cancellation.
   * @returns the file, or the failure to show.
   */
  readonly read: (path: string, signal: AbortSignal) => Promise<RemoteResult<SoundFile>>
  /**
   * The `file` resource address of a sound.
   * @param path - workspace path.
   * @returns the address.
   */
  readonly fileAddress: (path: string) => string
  /** The window's player. */
  readonly playback: PlaybackControls
  /** Prefix of this Session's player keys. */
  readonly keyPrefix: string
  /** Longest stretch the details measure, in seconds. */
  readonly maxMeasuredSeconds: number
  /** Longest sound the player decodes, in seconds. */
  readonly maxDecodedSeconds: number
}

/** Full props of the Audio tab body. */
export type AudioTabProps =
  & Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useResource' | 'useTabInfo'>
  & InjectFace<AudioTabInjected>
  & PropsLocale<typeof NS>

/**
 * The selected sound as the list knows it, or, for one the latest walk does not list yet, as its path names it.
 * @param path - workspace path of the selection.
 * @param items - the listed sounds.
 * @returns the sound, or undefined without a selection or for a path of no listed format.
 */
export function selectedSound(path: string | undefined, items: readonly SoundItem[]): SoundItem | undefined {
  if (path === undefined) return undefined
  const listed = items.find(item => item.entry.path === path)
  if (listed !== undefined) return listed
  const format = audioFormatOf(path)
  if (format === undefined) return undefined
  const slash = path.lastIndexOf('/')
  return { entry: { path, name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash), format }, kind: audioCategoryOf(path).category }
}

/** Message of an empty list, by why it is empty. */
function emptyListText(filter: KindFilter, query: string, t: AudioTabProps['t']): string {
  if (query.trim() !== '') return t('list.noMatch')
  switch (filter) {
    case 'effect':
      return t('list.noEffect')
    case 'dialogue':
      return t('list.noDialogue')
    case 'music':
      return t('list.noMusic')
    case 'all':
      return t('list.noMatch')
  }
}

/**
 * Render the Audio tab of one Session.
 * @param props - the runtime hooks, the Session's face, and copy.
 * @returns the tab body.
 */
export function AudioTab(props: AudioTabProps): ReactNode {
  const {
    useResource, useTabInfo, useScan, useView, useProbes, usePlayback, rescan, refresh, select, setQuery, setFilter, toggleFolder,
    takeNavigation, read, fileAddress, playback, keyPrefix, maxMeasuredSeconds, maxDecodedSeconds, t,
  } = props
  const id = useId()
  const scanState = useScan(state => state)
  const view = useView(state => state)
  const probes = useProbes(state => state)
  const playingKey = usePlayback(state => state.playing ? state.key : undefined)
  const playingPath = playingKey?.startsWith(`${keyPrefix}\n`) === true ? playingKey.split('\n')[1] : undefined
  useEffect(() => { refresh() }, [refresh])
  const { id: tabId, navigation } = useTabInfo().tab
  // Each navigation that names a sound selects it once, also when the body mounts after it.
  useEffect(() => {
    if (!takeNavigation(tabId, navigation.revision)) return
    const params = navigation.params
    if (params === undefined || !('path' in params) || typeof params.path !== 'string') return
    setQuery('')
    setFilter('all')
    select(params.path)
    rescan()
  }, [navigation, tabId, takeNavigation, select, setQuery, setFilter, rescan])
  const scan = scanState.scan
  const items = useMemo(() => scan === undefined ? [] : soundItems(scan, probes), [scan, probes])
  const shown = useMemo(() => shownSounds(items, view), [items, view])
  const rows = useMemo(() => listRows(shown, view), [shown, view])
  const selected = useMemo(() => selectedSound(view.selected, items), [view.selected, items])
  const [playRequest, setPlayRequest] = useState<PlayRequest>()
  const tokens = useRef(0)
  const requestPlay = (path: string): void => {
    tokens.current += 1
    setPlayRequest({ path, token: tokens.current })
  }
  const onPlayed = useCallback((token: number) => {
    setPlayRequest(current => current?.token === token ? undefined : current)
  }, [])
  const activate = (item: SoundItem): void => {
    const path = item.entry.path
    if (path === playingPath && playingKey !== undefined) {
      playback.pause(playingKey)
      return
    }
    if (path !== view.selected) select(path)
    requestPlay(path)
  }
  const step = (direction: 1 | -1): void => {
    const next = stepSound(rows, view.selected, direction)
    if (next === undefined) return
    select(next.entry.path)
    if (playingPath !== undefined) requestPlay(next.entry.path)
  }

  let content: ReactNode
  if (scan === undefined) {
    content = scanState.status === 'failed'
      ? (
        <div className={css.centered} role="alert">
          <p className={css.message}>{t('list.failed')}</p>
          <Button size="sm" variant="outline" onClick={rescan}>{t('action.retry')}</Button>
        </div>
      )
      : <div className={css.centered} role="status" aria-label={t('list.scanning')}><StateDot state="ongoing" /></div>
  } else if (scan.sounds.length === 0 && selected === undefined) {
    content = (
      <div className={css.centered}>
        <AudioGlyph size={28} className={css.emptyGlyph} />
        <p className={css.title}>{t('state.empty.title')}</p>
        <p className={css.message}>{t('state.empty.description')}</p>
      </div>
    )
  } else {
    const filterOptions: readonly KindFilter[] = ['all', 'effect', 'dialogue', 'music']
    content = (
      <>
        <SegmentedControl<KindFilter>
          id={`${id}-filter`}
          className={css.filter}
          label={t('filter.label')}
          value={view.filter}
          options={filterOptions.map(value => ({ value, label: t(`filter.${value}`) }))}
          onChange={setFilter}
        />
        <div className={css.player}>
          {selected === undefined
            ? <p className={css.choose}>{t('state.choose')}</p>
            : (
              <SoundPlayer
                key={selected.entry.path}
                item={selected}
                keyPrefix={keyPrefix}
                useResource={useResource}
                read={read}
                fileAddress={fileAddress}
                playback={playback}
                usePlayback={usePlayback}
                playRequest={playRequest}
                onPlayed={onPlayed}
                maxMeasuredSeconds={maxMeasuredSeconds}
                maxDecodedSeconds={maxDecodedSeconds}
                t={t}
              />
            )}
        </div>
        <div id={`${id}-filter-${view.filter}-panel`} role="tabpanel" aria-labelledby={`${id}-filter-${view.filter}`} className={css.listArea}>
          {scanState.status === 'failed' && (
            // The list stays as the last walk found it; the notice offers another walk.
            <div className={css.notice} role="alert">
              <span className={css.noticeText}>{t('list.failed')}</span>
              <Button size="sm" variant="outline" onClick={rescan}>{t('action.retry')}</Button>
            </div>
          )}
          {rows.length === 0
            ? <p className={css.listMessage}>{emptyListText(view.filter, view.query, t)}</p>
            : (
              <SoundList
                rows={rows}
                selected={view.selected}
                playing={playingPath}
                onActivate={activate}
                onStep={step}
                onToggleFolder={toggleFolder}
                t={t}
              />
            )}
          {scan.truncated && <p className={css.listMessage}>{t('list.truncated')}</p>}
          {scan.unreadable > 0 && <p className={css.listMessage}>{t('list.unreadable')}</p>}
        </div>
      </>
    )
  }

  return (
    <div className={css.root} data-game-audio>
      <div className={css.toolbar}>
        <div className={css.searchRow}>
          <Input
            className={clsx(css.search, view.query !== '' && css.searchWithQuery)}
            icon={<IconSearchOutlineRegular size={14} />}
            type="text"
            aria-label={t('search.label')}
            placeholder={t('search.label')}
            spellCheck={false}
            autoComplete="off"
            value={view.query}
            onChange={(event) => { setQuery(event.target.value) }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && view.query !== '') {
                event.preventDefault()
                setQuery('')
              }
            }}
          />
          {view.query !== '' && (
            <button type="button" className={css.searchClear} aria-label={t('search.clear')} onClick={() => { setQuery('') }}>
              <IconCloseFillRegular size={14} />
            </button>
          )}
        </div>
        <Tooltip label={t('action.refresh')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.tool}
            aria-label={t('action.refresh')}
            aria-busy={scanState.status === 'scanning'}
            onClick={rescan}
          >
            {scanState.status === 'scanning' ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />}
          </button>
        </Tooltip>
      </div>
      <div className={css.stage}>{content}</div>
    </div>
  )
}

/**
 * Render the tab chip title.
 * @param props - Audio tab copy.
 * @returns the Audio glyph followed by the tab name.
 */
export function AudioTabTitle({ t }: PropsLocale<typeof NS>): ReactNode {
  return (
    <>
      <AudioGlyph />
      <span className={css.chipTitle}>{t('tab.title')}</span>
    </>
  )
}
