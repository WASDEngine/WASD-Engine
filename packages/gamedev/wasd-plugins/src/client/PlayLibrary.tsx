/**
 * The game library beside the Play page's site, Installed games: the downloads in progress with their progress, failed ones
 * with Try again, and the games installed on this computer, the last started first. Each game shows its picture from
 * the site, or its title on the site's dark card when it has none or the picture does not load; choosing the game opens
 * its page in the Play page, Play starts it, and its menu opens the page, updates a single-player game while a newer
 * build for this computer is out (an online game updates when it starts), and uninstalls it. A game says when its
 * latest version has no download for this computer yet. A game WASD Engine took down offers only Uninstall, and one its
 * creator removed says so and offers Play anyway beside Uninstall.
 */
import { useEffect, useId, useState } from 'react'
import {
  Button, IconCloseOutlineRegular, IconEllipsisOutlineRegular, IconGlobeOutlineRegular, IconInfoOutlineRegular,
  IconLayersOutlineRegular, IconLoadingOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular,
  IconTrashOutlineRegular, IconWarningOutlineRegular, Menu, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { WasdLibraryGame, WasdLibraryRefusal, WasdLibraryTask, WasdLibraryView } from '../types.ts'
import type { NS } from './locales.ts'
import css from './PlayLibrary.module.css'

/** Why a game did not start: the Host's message, and the refusal that the row words itself. */
export interface LaunchFailure {
  /** The Host's message. */
  readonly message: string
  /** Why the library refused to start the game, when it did. */
  readonly refusal?: WasdLibraryRefusal
}

/** The library's operations, each answering undefined once done, or why not. */
export interface PlayLibraryActions {
  /**
   * Start installing a game.
   * @param slug - the game's address on the site.
   * @param version - an earlier version of a single-player game; 0 for the latest.
   */
  readonly install: (slug: string, version: number) => Promise<string | undefined>
  /**
   * Start an installed game.
   * @param id - the game's id.
   * @param anyway - the player chose Play anyway for a game its creator removed.
   */
  readonly launch: (id: string, anyway: boolean) => Promise<LaunchFailure | undefined>
  /**
   * Delete an installed game.
   * @param id - the game's id.
   */
  readonly remove: (id: string) => Promise<string | undefined>
  /**
   * Forget a failed download.
   * @param slug - its game's address.
   */
  readonly dismiss: (slug: string) => void
}

/** Props of {@link PlayLibrary}. */
export type PlayLibraryProps = PlayLibraryActions & PropsLocale<typeof NS> & {
  /** The library, or undefined until the Host answers. */
  readonly library: WasdLibraryView | undefined
  /**
   * Show a game's page on the site in the Play page.
   * @param slug - the game's address on the site.
   */
  readonly openPage: (slug: string) => void
}

/** How many placeholder rows the list shows until the Host answers. */
const SKELETON_ROWS = 3

/** A game's picture, over its title on the dark card that stands in until the picture loads or when it has none. */
function Cover({ title, url }: { readonly title: string; readonly url: string | undefined }) {
  const [shown, setShown] = useState<string>()
  const [failed, setFailed] = useState<string>()
  return (
    <span className={css.cover} data-loaded={url !== undefined && shown === url ? '' : undefined} aria-hidden="true">
      <span className={css.coverTitle}>{title}</span>
      {url !== undefined && failed !== url && (
        <img
          key={url}
          className={css.coverImage}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => { setShown(url) }}
          onError={() => { setFailed(url) }}
        />
      )}
    </span>
  )
}

/** One download in progress, or a failed one. */
function TaskRow({ task, t, install, dismiss }: { readonly task: WasdLibraryTask } & Pick<PlayLibraryProps, 't' | 'install' | 'dismiss'>) {
  const titleId = useId()
  const title = task.title === '' ? task.slug : task.title
  if (task.state === 'failed') {
    return (
      <li className={css.row} data-state="failed">
        <Cover title={title} url={task.coverUrl} />
        <div className={css.body}>
          <span id={titleId} className={css.title}>{title}</span>
          <span className={css.failedMeta}><IconWarningOutlineRegular size={12} />{t('library.failed')}</span>
          {task.message !== undefined && <p className={css.warning} role="alert">{task.message}</p>}
          <div className={css.actions}>
            <Button variant="outline" size="sm" aria-describedby={titleId} onClick={() => { void install(task.slug, 0) }}>
              {t('library.retry')}
            </Button>
            <Tooltip label={t('library.dismiss')} side="top" delayMs={500} portal>
              <button type="button" className={css.iconButton} aria-label={t('library.dismiss')} aria-describedby={titleId} onClick={() => { dismiss(task.slug) }}>
                <IconCloseOutlineRegular size={14} />
              </button>
            </Tooltip>
          </div>
        </div>
      </li>
    )
  }
  const measured = task.state === 'downloading' && task.totalBytes > 0
  const percent = measured ? Math.min(100, Math.floor(task.receivedBytes / task.totalBytes * 100)) : 0
  return (
    <li className={css.row} data-state={task.state}>
      <Cover title={title} url={task.coverUrl} />
      <div className={css.body}>
        <span className={css.title}>{title}</span>
        <span className={css.meta}>{task.state === 'installing' ? t('library.installing') : t('library.downloading', { percent })}</span>
        <div
          className={css.progress}
          role="progressbar"
          aria-label={title}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={measured ? percent : undefined}
        >
          {measured
            ? <span className={css.progressFill} style={{ width: `${String(percent)}%` }} />
            : <span className={css.progressFill} data-indeterminate="" />}
        </div>
      </div>
    </li>
  )
}

/**
 * One installed game. Where the game stands comes from the library's view; a refusal to start it shows at once, until
 * the view says the same.
 */
function GameRow({ game, t, install, launch, remove, openPage }: { readonly game: WasdLibraryGame } & Pick<PlayLibraryProps, 't' | 'install' | 'launch' | 'remove' | 'openPage'>) {
  const titleId = useId()
  const [starting, setStarting] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [message, setMessage] = useState<string>()
  const [refusal, setRefusal] = useState<WasdLibraryRefusal>()
  useEffect(() => { setRefusal(undefined) }, [game.availability, game.unavailableVersion])
  const settle = (done: Promise<string | undefined>): void => {
    setMessage(undefined)
    setRefusal(undefined)
    void done.then(setMessage, (error: unknown) => { setMessage((error as Error).message) })
  }
  const play = (anyway: boolean): void => {
    setStarting(true)
    setMessage(undefined)
    setRefusal(undefined)
    void launch(game.id, anyway).then((failure) => {
      // A refusal is worded below in the player's language; any other failure shows the Host's message.
      setRefusal(failure?.refusal)
      setMessage(failure?.refusal === undefined ? failure?.message : undefined)
    }, (error: unknown) => { setMessage((error as Error).message) }).finally(() => { setStarting(false) })
  }
  const uninstall = (): void => { settle(remove(game.id)) }
  const online = game.multiplayer !== undefined
  const refused = refusal?.reason === 'taken_down' || refusal?.reason === 'removed' ? refusal.reason : undefined
  const availability = game.availability ?? refused
  const unavailable = availability === undefined
    ? game.unavailableVersion ?? (refusal?.reason === 'unavailable' ? refusal.version : undefined)
    : undefined
  const updateVersion = online || availability !== undefined ? undefined : game.updateVersion
  const update = (): void => { settle(install(game.slug, 0)) }
  const platform = t(game.platform === 'macos' ? 'library.platform.macos' : 'library.platform.windows')
  let standing: string | undefined
  if (availability === 'taken_down') standing = t('library.takenDown')
  else if (availability === 'removed') standing = t(online ? 'library.removedOnline' : 'library.removed')
  else if (unavailable !== undefined) standing = t(online ? 'library.unavailableOnline' : 'library.unavailable', { version: unavailable, platform })
  const items: MenuEntry[] = [
    { id: 'page', label: t('library.openPage'), icon: <IconGlobeOutlineRegular size={14} /> },
    ...updateVersion === undefined ? [] : [{ id: 'update', label: t('library.update', { version: updateVersion }), icon: <IconRefreshOutlineRegular size={14} /> }],
    { type: 'separator', id: 'end' },
    { id: 'uninstall', label: t('library.uninstall'), icon: <IconTrashOutlineRegular size={14} />, danger: true },
  ]
  const choose = (id: string): void => {
    setMenuOpen(false)
    if (id === 'page') openPage(game.slug)
    else if (id === 'update') update()
    else if (id === 'uninstall') uninstall()
  }
  return (
    <li className={css.row} data-state="installed" data-availability={availability}>
      <Cover title={game.title} url={game.coverUrl} />
      <div className={css.body}>
        <Tooltip label={game.title} side="top" delayMs={500} portal onlyWhenClipped>
          <button type="button" id={titleId} className={css.open} onClick={() => { openPage(game.slug) }}>
            <span className={css.title}>{game.title}</span>
          </button>
        </Tooltip>
        <span className={css.meta}>
          <span>{t('library.version', { version: game.version })}</span>
          {online && (
            <span className={css.metaPart}><IconGlobeOutlineRegular size={12} />{t('library.online')}</span>
          )}
          {updateVersion !== undefined && (
            <span className={css.metaPart}>
              <Tooltip label={t('library.update', { version: updateVersion })} side="top" delayMs={500} portal>
                <button type="button" className={css.update} aria-describedby={titleId} onClick={update}>{t('library.updateShort')}</button>
              </Tooltip>
            </span>
          )}
        </span>
        <div className={css.actions}>
          {availability === 'taken_down' && (
            <Button variant="outline" size="sm" aria-describedby={titleId} onClick={uninstall}>{t('library.uninstall')}</Button>
          )}
          {availability !== 'taken_down' && (
            <button type="button" className={css.play} aria-describedby={titleId} onClick={() => { play(availability === 'removed') }} disabled={starting}>
              {starting ? <IconLoadingOutlineRegular size={14} className={css.spinner} /> : <IconPlayOutlineRegular size={14} />}
              <span>{starting ? t('library.starting') : t(availability === 'removed' ? 'library.playAnyway' : 'library.play')}</span>
            </button>
          )}
          {availability === 'removed' && (
            <Button variant="outline" size="sm" aria-describedby={titleId} onClick={uninstall}>{t('library.uninstall')}</Button>
          )}
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={items}
            onSelect={choose}
            align="end"
            portal
            autoFocus
            anchor={(
              <Tooltip label={t('library.more', { title: game.title })} side="top" delayMs={500} portal disabled={menuOpen}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('library.more', { title: game.title })}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  onClick={() => { setMenuOpen(open => !open) }}
                >
                  <IconEllipsisOutlineRegular size={16} />
                </button>
              </Tooltip>
            )}
          />
        </div>
        {standing !== undefined && (
          <p className={css.notice} role="status" data-tone={availability === undefined ? 'info' : 'warning'}>
            {availability === undefined
              ? <IconInfoOutlineRegular size={12} className={css.noticeIcon} />
              : <IconWarningOutlineRegular size={12} className={css.noticeIcon} />}
            <span>{standing}</span>
          </p>
        )}
        {message !== undefined && (
          <p className={css.notice} role="alert">
            <IconWarningOutlineRegular size={12} className={css.noticeIcon} />
            <span>{message}</span>
          </p>
        )}
      </div>
    </li>
  )
}

/** The placeholder rows of the list until the Host answers. */
function Skeleton() {
  return (
    <ul className={css.list} aria-hidden="true">
      {Array.from({ length: SKELETON_ROWS }, (_, index) => (
        <li key={index} className={css.row}>
          <span className={`${css.cover} ${css.skeletonFill}`} />
          <div className={css.body}>
            <span className={`${css.skeletonBar} ${css.skeletonFill} ${css.skeletonTitle}`} />
            <span className={`${css.skeletonBar} ${css.skeletonFill} ${css.skeletonMeta}`} />
          </div>
        </li>
      ))}
    </ul>
  )
}

/** The panel's message when it lists nothing: what to do, or why games do not install here. */
function Empty({ title, body }: { readonly title: string; readonly body: string }) {
  return (
    <div className={css.empty}>
      <span className={css.emptyIcon} aria-hidden="true"><IconLayersOutlineRegular size={20} /></span>
      <p className={css.emptyTitle}>{title}</p>
      <p className={css.emptyBody}>{body}</p>
    </div>
  )
}

/**
 * Render the library.
 * @param props - the library, its operations, and the copy.
 * @returns the library column.
 */
export function PlayLibrary({ library, t, install, launch, remove, dismiss, openPage }: PlayLibraryProps) {
  const tasks = library?.tasks ?? []
  const games = library?.games ?? []
  const grouped = tasks.length > 0 && games.length > 0
  return (
    <aside className={css.root} aria-label={t('library.title')}>
      <header className={css.header}>
        <h2 className={css.heading}>{t('library.title')}</h2>
        {games.length > 0 && <span className={css.count}>{games.length}</span>}
      </header>
      <div className={css.scroller} aria-busy={library === undefined}>
        {library === undefined && <Skeleton />}
        {library !== undefined && !library.supported && <Empty title={t('library.unsupportedTitle')} body={t('library.unsupported')} />}
        {library !== undefined && library.supported && tasks.length === 0 && games.length === 0 && (
          <Empty title={t('library.emptyTitle')} body={t('library.empty')} />
        )}
        {tasks.length > 0 && (
          <section className={css.group} aria-label={grouped ? undefined : t('library.downloads')}>
            {grouped && <h3 className={css.groupLabel}>{t('library.downloads')}</h3>}
            <ul className={css.list}>
              {tasks.map(task => <TaskRow key={task.slug} task={task} t={t} install={install} dismiss={dismiss} />)}
            </ul>
          </section>
        )}
        {games.length > 0 && (
          <section className={css.group} aria-label={grouped ? undefined : t('library.installed')}>
            {grouped && <h3 className={css.groupLabel}>{t('library.installed')}</h3>}
            <ul className={css.list}>
              {games.map(game => (
                <GameRow key={game.id} game={game} t={t} install={install} launch={launch} remove={remove} openPage={openPage} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </aside>
  )
}
