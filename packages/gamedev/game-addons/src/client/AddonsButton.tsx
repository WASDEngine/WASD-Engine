/**
 * The Session header's Add-ons button, after the Export / Share button: it opens a dialog that lists the curated Godot and
 * Blender add-ons under the catalog's categories with what each does, when it helps, its license, and whether the
 * Session's game project has it, each with a switch that says whether agents may use it. A search field narrows the list
 * to the add-ons that hold every word typed. Every add-on is on until the user turns it off; one that is off stays out of
 * every agent's reach, the Session's and those connected through MCP, in every project. It shows only for a Session in a
 * Workspace.
 */
import { useState } from 'react'
import { IconAppsAddOutlineRegular, IconLoadingOutlineRegular, IconSearchOutlineRegular, Input, isMobileDevice, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GameAddonsProjectView, GameAddonView } from '../types.ts'
import { CATEGORY_HEADINGS, CATEGORY_ORDER } from './categories.ts'
import type { NS } from './locales.ts'
import css from './AddonsButton.module.css'

/** A Remote call's value, or why it failed. */
export type Outcome<T> = { readonly value: T } | { readonly error: string }

/** Registration-side operations of the Add-ons button. */
export interface AddonsButtonInjected {
  /**
   * Read the catalog with the switches and, when the Workspace folder holds a game project, what the project has.
   * @param directory - absolute Workspace folder.
   * @returns the view, or why it could not be read.
   */
  readonly readProject: (directory: string) => Promise<Outcome<GameAddonsProjectView>>
  /**
   * Turn one add-on on or off for agents.
   * @param id - catalog id.
   * @param allowed - whether agents may use it.
   * @returns once the Host saved and applied the switch, or why it could not.
   */
  readonly setAllowed: (id: string, allowed: boolean) => Promise<Outcome<void>>
}

/** Props of {@link AddonsButton}. */
export type AddonsButtonProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS> & InjectFace<AddonsButtonInjected>

type Loaded = { readonly state: 'loading' } | { readonly state: 'ready'; readonly view: GameAddonsProjectView } | { readonly state: 'failed'; readonly message: string }

/** A notice under the list: a finished change, or a failure. */
type Notice = { readonly tone: 'info' | 'warning'; readonly text: string }

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Whether the Session's game project has an add-on, installed or copied into its `addons` folder. */
function inGame(addon: GameAddonView): boolean {
  return addon.presence !== undefined && addon.presence.state !== 'absent'
}

/**
 * The letter on the tile of an add-on without an icon: the first of its title, after the "WASD" that every add-on of WASD
 * Engine's own starts with, so that their tiles differ.
 */
function tileLetter(title: string): string {
  return Array.from(title.trim().replace(/^WASD\s+/u, ''))[0]?.toUpperCase() ?? ''
}

/** The words of a search, in lower case. */
function searchWords(query: string): string[] {
  return query.toLowerCase().split(/\s+/u).filter(word => word !== '')
}

/**
 * Whether a search finds an add-on.
 * @param addon - the add-on.
 * @param heading - the heading of its category as the dialog shows it.
 * @param words - the search's words in lower case; none finds every add-on.
 * @returns whether each word is part of the add-on's title, id, application, cue, summary, use, search words, or heading.
 */
function found(addon: GameAddonView, heading: string, words: readonly string[]): boolean {
  if (words.length === 0) return true
  const text = [addon.title, addon.id, addon.host, addon.cue, addon.summary, addon.useWhen, heading, ...addon.tags].join('\n').toLowerCase()
  return words.every(word => text.includes(word))
}

/**
 * Render the Add-ons button and its dialog.
 * @param props - composed slot props.
 * @returns the button, or null when the Session belongs to no Workspace.
 */
export function AddonsButton({ sessionId, useWorkspaces, t, readProject, setAllowed }: AddonsButtonProps) {
  const directory = useWorkspaces(state => state.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [query, setQuery] = useState('')
  if (directory === undefined) return null

  const refresh = async (): Promise<void> => {
    const result = await readProject(directory)
    setLoaded('value' in result ? { state: 'ready', view: result.value } : { state: 'failed', message: result.error })
  }
  const show = (): void => {
    setOpen(true)
    setNotice(undefined)
    setQuery('')
    setLoaded({ state: 'loading' })
    void refresh()
  }
  const close = (): void => {
    if (!busy) setOpen(false)
  }
  const change = async (addon: GameAddonView, allowed: boolean): Promise<void> => {
    setBusy(true)
    setNotice(undefined)
    const result = await setAllowed(addon.id, allowed)
    if ('error' in result) setNotice({ tone: 'warning', text: t('addons.failed', { title: addon.title, message: result.error }) })
    else if (allowed) setNotice({ tone: 'info', text: t('addons.onNotice', { title: addon.title }) })
    else setNotice({ tone: 'info', text: t(inGame(addon) ? 'addons.offInGameNotice' : 'addons.offNotice', { title: addon.title }) })
    // The switches show what the Host accepted, so a refused change leaves them as they were.
    await refresh()
    setBusy(false)
  }

  const words = searchWords(query)
  // The dialog opens with the search field focused, except on a phone, where that would raise the keyboard over the list.
  const searchFocus = isMobileDevice() ? {} : { 'data-modal-autofocus': true }
  const groups = loaded.state === 'ready'
    ? CATEGORY_ORDER
      .map((category) => {
        const label = t(CATEGORY_HEADINGS[category])
        return { category, label, addons: loaded.view.addons.filter(addon => addon.category === category && found(addon, label, words)) }
      })
      .filter(group => group.addons.length > 0)
    : []

  const row = (addon: GameAddonView) => {
    const meta = [
      addon.version,
      addon.license,
      addon.bytes === undefined ? t(addon.shipsWith === 'blender' ? 'addons.shipsWithBlender' : 'addons.shipsWithApp') : sizeLabel(addon.bytes),
      ...addon.assets === undefined ? [] : [t('addons.withAssets', { license: addon.assets.license })],
    ].join(' · ')
    const icon = loaded.state === 'ready' ? loaded.view.icons[addon.id] : undefined
    return (
      <li key={addon.id} className={`${css.item ?? ''} ${addon.allowed ? '' : css.itemOff ?? ''}`}>
        {icon === undefined
          ? <span className={`${css.addonIcon ?? ''} ${css.addonLetter ?? ''}`} aria-hidden="true">{tileLetter(addon.title)}</span>
          : <img className={css.addonIcon} src={icon} alt="" aria-hidden="true" draggable={false} />}
        <div className={css.itemText}>
          <div className={css.itemHead}>
            <a className={css.itemTitle} href={addon.homepage} target="_blank" rel="noreferrer noopener">{addon.title}</a>
            {addon.host === 'blender' && <span className={`${css.badge ?? ''} ${css.badgeHost ?? ''}`}>{t('addons.blenderAddon')}</span>}
            <span className={css.meta}>{meta}</span>
            {inGame(addon) && <span className={css.badge}>{t('addons.inGame')}</span>}
          </div>
          <p className={css.summary}>{addon.summary}</p>
          <p className={css.useWhen}>{t('addons.useWhen', { text: addon.useWhen })}</p>
          {addon.credit !== undefined && <p className={css.useWhen}>{t('addons.credit', { credit: addon.credit })}</p>}
        </div>
        <div className={css.itemAction}>
          <Switch
            checked={addon.allowed}
            label={t('addons.allow', { title: addon.title })}
            disabled={busy}
            onChange={(allowed) => { void change(addon, allowed) }}
          />
        </div>
      </li>
    )
  }

  return (
    <>
      <button type="button" className={css.trigger} onClick={show} title={t('addons.tooltip')}>
        <IconAppsAddOutlineRegular size={14} className={css.icon} />
        {t('addons.button')}
      </button>
      <Modal
        open={open}
        onClose={close}
        title={t('addons.title')}
        closeLabel={t('addons.close')}
        description={t('addons.description')}
        className={css.dialog ?? ''}
        contentClassName={css.content ?? ''}
      >
        <div className={css.body}>
          <div className={css.searchBar}>
            <Input
              className={css.search ?? ''}
              icon={<IconSearchOutlineRegular size={14} />}
              type="text"
              aria-label={t('addons.search')}
              placeholder={t('addons.search')}
              spellCheck={false}
              value={query}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
              {...searchFocus}
            />
          </div>
          {loaded.state === 'loading' && <p className={css.status}><IconLoadingOutlineRegular size={14} className={css.spinner} /></p>}
          {loaded.state === 'failed' && <p className={css.warning}>{t('addons.loadFailed', { message: loaded.message })}</p>}
          {loaded.state === 'ready' && words.length > 0 && groups.length === 0 && <p className={css.status}>{t('addons.noMatch')}</p>}
          {groups.map(group => (
            <section key={group.category} className={css.group} aria-label={group.label}>
              <h3 className={css.groupTitle}>{group.label}</h3>
              <ul className={css.list}>{group.addons.map(row)}</ul>
            </section>
          ))}
          {notice !== undefined && <p className={`${css.notice ?? ''} ${(notice.tone === 'warning' ? css.warning : css.status) ?? ''}`} role="status">{notice.text}</p>}
        </div>
      </Modal>
    </>
  )
}
