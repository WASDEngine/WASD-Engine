/**
 * The Session header's Add-ons button, after the Export / Share button: it opens a dialog that lists the curated Godot and
 * Blender add-ons with what each does, when it helps, its license, and whether the Session's game project has it, each
 * with a switch that says whether agents may use it. Every add-on is on until the user turns it off; one that is off
 * stays out of every agent's reach, the Session's and those connected through MCP, in every project. It shows only for a
 * Session in a Workspace.
 */
import { useState } from 'react'
import { IconAppsAddOutlineRegular, IconLoadingOutlineRegular, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GameAddonsProjectView, GameAddonView } from '../types.ts'
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
  if (directory === undefined) return null

  const refresh = async (): Promise<void> => {
    const result = await readProject(directory)
    setLoaded('value' in result ? { state: 'ready', view: result.value } : { state: 'failed', message: result.error })
  }
  const show = (): void => {
    setOpen(true)
    setNotice(undefined)
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

  const groups = loaded.state === 'ready'
    ? ([['godot', t('addons.godot')], ['blender', t('addons.blender')]] as const)
      .map(([host, label]) => ({ host, label, addons: loaded.view.addons.filter(addon => addon.host === host) }))
      .filter(group => group.addons.length > 0)
    : []

  const row = (addon: GameAddonView) => {
    const meta = [
      addon.version,
      addon.license,
      addon.bytes === undefined ? t('addons.shipsWithBlender') : sizeLabel(addon.bytes),
      ...addon.assets === undefined ? [] : [t('addons.withAssets', { license: addon.assets.license })],
    ].join(' · ')
    const icon = loaded.state === 'ready' ? loaded.view.icons[addon.id] : undefined
    return (
      <li key={addon.id} className={`${css.item ?? ''} ${addon.allowed ? '' : css.itemOff ?? ''}`}>
        {icon === undefined
          ? <span className={`${css.addonIcon ?? ''} ${css.addonLetter ?? ''}`} aria-hidden="true">{Array.from(addon.title.trim())[0]?.toUpperCase()}</span>
          : <img className={css.addonIcon} src={icon} alt="" aria-hidden="true" draggable={false} />}
        <div className={css.itemText}>
          <div className={css.itemHead}>
            <a className={css.itemTitle} href={addon.homepage} target="_blank" rel="noreferrer noopener">{addon.title}</a>
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
          {loaded.state === 'loading' && <p className={css.status}><IconLoadingOutlineRegular size={14} className={css.spinner} /></p>}
          {loaded.state === 'failed' && <p className={css.warning}>{t('addons.loadFailed', { message: loaded.message })}</p>}
          {groups.map(group => (
            <section key={group.host} className={css.group} aria-label={group.label}>
              <h3 className={css.groupTitle}>{group.label}</h3>
              <ul className={css.list}>{group.addons.map(row)}</ul>
            </section>
          ))}
          {notice !== undefined && <p className={notice.tone === 'warning' ? css.warning : css.status} role="status">{notice.text}</p>}
        </div>
      </Modal>
    </>
  )
}
