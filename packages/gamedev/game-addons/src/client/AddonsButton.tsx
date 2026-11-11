/**
 * The Session header's Add-ons button, after the Release button: it opens a dialog that lists the curated Godot and
 * Blender add-ons with what each does, when it helps, its license, and whether the Session's game project has it, and
 * installs or removes one at the user's click. An installed add-on's guide reaches the Session's agent as a skill.
 * It shows only for a Session in a Workspace.
 */
import { useState } from 'react'
import { Button, IconAppsAddOutlineRegular, IconLoadingOutlineRegular, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GameAddonInstallResult, GameAddonRemoveResult, GameAddonsProjectView, GameAddonView } from '../types.ts'
import type { NS } from './locales.ts'
import css from './AddonsButton.module.css'

/** Most file names a removal notice lists. */
const LISTED_REFERENCES = 5

/** A Remote call's value, or why it failed. */
export type Outcome<T> = { readonly value: T } | { readonly error: string }

/** Registration-side operations of the Add-ons button. */
export interface AddonsButtonInjected {
  /**
   * Read the catalog and what the game project of a Workspace folder has.
   * @param directory - absolute Workspace folder.
   * @returns the project view, or why it could not be read.
   */
  readonly readProject: (directory: string) => Promise<Outcome<GameAddonsProjectView>>
  /**
   * Install one add-on.
   * @param directory - absolute Workspace folder.
   * @param id - catalog id.
   * @returns the installation, or why it failed.
   */
  readonly install: (directory: string, id: string) => Promise<Outcome<GameAddonInstallResult>>
  /**
   * Remove one add-on.
   * @param directory - absolute Workspace folder.
   * @param id - catalog id.
   * @returns the removal, or why it failed.
   */
  readonly remove: (directory: string, id: string) => Promise<Outcome<GameAddonRemoveResult>>
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

/**
 * Render the Add-ons button and its dialog.
 * @param props - composed slot props.
 * @returns the button, or null when the Session belongs to no Workspace.
 */
export function AddonsButton({ sessionId, useWorkspaces, t, readProject, install, remove }: AddonsButtonProps) {
  const directory = useWorkspaces(state => state.items.find(workspace => workspace.sessionIds.includes(sessionId))?.path)
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
  const [busy, setBusy] = useState<string>()
  const [confirming, setConfirming] = useState<string>()
  const [notice, setNotice] = useState<Notice>()
  if (directory === undefined) return null

  const refresh = async (): Promise<void> => {
    const result = await readProject(directory)
    setLoaded('value' in result ? { state: 'ready', view: result.value } : { state: 'failed', message: result.error })
  }
  const show = (): void => {
    setOpen(true)
    setNotice(undefined)
    setConfirming(undefined)
    setLoaded({ state: 'loading' })
    void refresh()
  }
  const close = (): void => {
    if (busy === undefined) setOpen(false)
  }
  const change = async (addon: GameAddonView, action: 'install' | 'remove'): Promise<void> => {
    setBusy(addon.id)
    setConfirming(undefined)
    setNotice(undefined)
    if (action === 'install') {
      const result = await install(directory, addon.id)
      setNotice('value' in result
        ? { tone: 'info', text: t('addons.installedNotice', { title: addon.title }) }
        : { tone: 'warning', text: t('addons.failed', { title: addon.title, message: result.error }) })
    } else {
      const result = await remove(directory, addon.id)
      if ('value' in result) {
        const files = result.value.references.slice(0, LISTED_REFERENCES).join(', ')
        const removed = t('addons.removedNotice', { title: addon.title })
        setNotice({ tone: files === '' ? 'info' : 'warning', text: files === '' ? removed : `${removed} ${t('addons.references', { files })}` })
      } else {
        setNotice({ tone: 'warning', text: t('addons.failed', { title: addon.title, message: result.error }) })
      }
    }
    await refresh()
    setBusy(undefined)
  }

  const groups = loaded.state === 'ready'
    ? ([['godot', t('addons.godot')], ['blender', t('addons.blender')]] as const)
      .map(([host, label]) => ({ host, label, addons: loaded.view.addons.filter(addon => addon.host === host) }))
      .filter(group => group.addons.length > 0)
    : []

  const row = (addon: GameAddonView) => {
    const state = addon.presence?.state ?? 'absent'
    const meta = [
      addon.version,
      addon.license,
      addon.bytes === undefined ? t('addons.shipsWithBlender') : sizeLabel(addon.bytes),
      ...addon.assets === undefined ? [] : [t('addons.withAssets', { license: addon.assets.license })],
    ].join(' · ')
    const working = busy === addon.id
    const icon = loaded.state === 'ready' ? loaded.view.icons[addon.id] : undefined
    return (
      <li key={addon.id} className={css.item}>
        {icon === undefined
          ? <span className={`${css.addonIcon ?? ''} ${css.addonLetter ?? ''}`} aria-hidden="true">{Array.from(addon.title.trim())[0]?.toUpperCase()}</span>
          : <img className={css.addonIcon} src={icon} alt="" aria-hidden="true" draggable={false} />}
        <div className={css.itemText}>
          <div className={css.itemHead}>
            <a className={css.itemTitle} href={addon.homepage} target="_blank" rel="noreferrer noopener">{addon.title}</a>
            <span className={css.meta}>{meta}</span>
            {state === 'installed' && <span className={css.badge}>{t('addons.installed')}</span>}
            {state === 'found' && <span className={css.badge}>{t('addons.found')}</span>}
          </div>
          <p className={css.summary}>{addon.summary}</p>
          <p className={css.useWhen}>{t('addons.useWhen', { text: addon.useWhen })}</p>
          {addon.credit !== undefined && <p className={css.useWhen}>{t('addons.credit', { credit: addon.credit })}</p>}
          {confirming === addon.id && (
            <div className={css.confirm} role="alert">
              <span>{t('addons.removeQuestion', { title: addon.title })}</span>
              <div className={css.confirmActions}>
                <Button size="sm" variant="ghost" onClick={() => { setConfirming(undefined) }}>{t('addons.cancel')}</Button>
                <Button size="sm" variant="outline" onClick={() => { void change(addon, 'remove') }}>{t('addons.remove')}</Button>
              </div>
            </div>
          )}
        </div>
        <div className={css.itemAction}>
          {state === 'absent'
            ? (
              <Button
                size="sm"
                variant="primary"
                disabled={busy !== undefined}
                aria-label={`${t('addons.install')} ${addon.title}`}
                icon={working ? <IconLoadingOutlineRegular size={16} className={css.spinner} /> : undefined}
                onClick={() => { void change(addon, 'install') }}
              >
                {working ? t('addons.working') : t('addons.install')}
              </Button>
            )
            : (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== undefined || confirming === addon.id}
                aria-label={`${t('addons.remove')} ${addon.title}`}
                icon={working ? <IconLoadingOutlineRegular size={16} className={css.spinner} /> : undefined}
                onClick={() => { setConfirming(addon.id) }}
              >
                {working ? t('addons.working') : t('addons.remove')}
              </Button>
            )}
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
