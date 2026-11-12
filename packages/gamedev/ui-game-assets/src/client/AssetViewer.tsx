/**
 * The selected asset's viewer: it reads the file, reads it again whenever the `file` resource reports a new version,
 * and hands the bytes to the image or model view. A Blender file shows a model exported from it, found by its name
 * among the project's models, or a notice when there is none.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, fileSizeText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { AssetsTabInjected } from './AssetsTab.tsx'
import { ImageView } from './ImageView.tsx'
import type { NS } from './locales.ts'
import { ModelView } from './ModelView.tsx'
import type { AssetFile } from './read.ts'
import type { ViewRequest } from './source.ts'
import { NAME_ORDER, type AssetEntry } from './scan.ts'
import css from './AssetViewer.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** What the viewer needs from the tab. */
export interface AssetViewerProps extends Pick<AssetsTabInjected, 'read' | 'relatedUrl' | 'fileAddress' | 'animations'> {
  /** The asset to show. */
  readonly asset: AssetEntry
  /** The project's assets, where a Blender file's export is looked up. */
  readonly assets: readonly AssetEntry[]
  readonly useResource: PropsRuntime<'sidebar.right.pane.tab'>['useResource']
  /** @param path - workspace path of an asset to select instead. */
  readonly onSelect: (path: string) => void
  /** What an agent asked to show with the asset, once per `request`. */
  readonly requested?: ViewRequest | undefined
  readonly t: Translate
}

/** Where a read stands. */
type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly file: AssetFile }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

/**
 * The model exported from a Blender file: a listed model of the same name, nearest first, in the Blender file's folder,
 * then in a folder above it, then in a folder below it, then anywhere; GLB before glTF before other formats. The agent's
 * asset tools pick the same model with their copy in `@deepseek-ai/dsh-game-assets/formats`.
 * @param blend - the Blender file.
 * @param assets - the project's assets.
 * @returns the export, or undefined when the project has none.
 */
export function exportOf(blend: AssetEntry, assets: readonly AssetEntry[]): AssetEntry | undefined {
  const stem = (name: string): string => name.slice(0, name.lastIndexOf('.')).toLowerCase()
  const wanted = stem(blend.name)
  const distance = (folder: string): number => {
    if (folder === blend.folder) return 0
    const above = blend.folder === '' ? undefined : blend.folder.split('/')
    const below = folder === '' ? [] : folder.split('/')
    if (above !== undefined && (folder === '' || blend.folder.startsWith(`${folder}/`))) return above.length - below.length
    if (blend.folder === '' || folder.startsWith(`${blend.folder}/`)) return 100 + below.length - (above?.length ?? 0)
    return 1000
  }
  const preference = (asset: AssetEntry): number => asset.format.label === 'GLB' ? 0 : asset.format.label === 'glTF' ? 1 : 2
  return assets
    .filter(asset => asset.format.kind === 'model' && asset.format.decoder !== 'blend' && stem(asset.name) === wanted)
    .sort((left, right) => distance(left.folder) - distance(right.folder)
      || preference(left) - preference(right)
      || NAME_ORDER.compare(left.path, right.path))[0]
}

/**
 * The sentence for a failed read.
 * @param failure - the read's failure.
 * @param t - copy.
 * @returns the sentence, and whether a retry can help.
 */
function failureText(failure: RemoteFailure, t: Translate): { readonly text: string; readonly retry: boolean } {
  switch (failure.code) {
    case 'workspace-file/not-found':
      return { text: t('viewer.notFound'), retry: false }
    case 'workspace-file/too-large':
      return { text: t('viewer.tooLarge', { limit: fileSizeText(failure.details.limit) }), retry: false }
    case 'game-assets/changed':
      return { text: t('viewer.changed'), retry: true }
    default:
      return { text: t('viewer.failed'), retry: true }
  }
}

/**
 * Show one asset.
 * @param props - the asset, the project's assets, the reads, and copy.
 * @returns the image or model view, the Blender export, or a centered state.
 */
export function AssetViewer(props: AssetViewerProps): ReactNode {
  const { asset, assets, onSelect, t } = props
  if (asset.format.kind !== 'model' || asset.format.decoder !== 'blend') return <LoadedAsset {...props} />
  const exported = exportOf(asset, assets)
  if (exported === undefined) {
    return <div className={css.centered}><p className={css.message}>{t('blend.none')}</p></div>
  }
  return (
    <div className={css.column}>
      <div className={css.notice} role="status">
        <span className={css.noticeText}>{t('blend.export', { name: exported.name })}</span>
        <Button size="sm" variant="outline" className={css.noticeAction} onClick={() => { onSelect(exported.path) }}>
          {t('blend.open')}
        </Button>
      </div>
      <LoadedAsset key={exported.path} {...props} asset={exported} />
    </div>
  )
}

/** Read an asset, again for each new version, and show it. */
function LoadedAsset({ asset, useResource, read, relatedUrl, fileAddress, animations, requested, t }: AssetViewerProps): ReactNode {
  const resource = useResource<'file'>(fileAddress(asset.path))
  const version = resource.status === 'live' ? resource.value?.version : undefined
  // A read waits for the resource's first frame, so opening a file reads it once, not before and after its version arrives.
  const waiting = resource.status === 'loading'
  const gone = resource.status === 'failed' && resource.failure?.code === 'workspace-file/not-found'
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const loaded = useRef<{ readonly version: string; readonly attempt: number }>()
  useEffect(() => {
    if (waiting || gone) return
    const known = loaded.current
    if (known !== undefined && known.attempt === attempt && (version === undefined || known.version === version)) return
    const controller = new AbortController()
    // A newer version replaces the shown one once it is read; until then the shown one stays.
    setLoad(current => current.kind === 'ready' ? current : { kind: 'loading' })
    void read(asset.path, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        loaded.current = { version: result.value.version, attempt }
        setLoad({ kind: 'ready', file: result.value })
      } else {
        loaded.current = undefined
        setLoad({ kind: 'failed', failure: result.error })
      }
    })
    return () => { controller.abort() }
  }, [asset.path, version, waiting, gone, attempt, read])

  if (gone) {
    return <div className={css.centered} role="alert"><p className={css.message}>{t('viewer.notFound')}</p></div>
  }
  if (load.kind === 'loading') {
    return <div className={css.centered} role="status" aria-label={t('viewer.loading', { name: asset.name })}><StateDot state="ongoing" /></div>
  }
  if (load.kind === 'failed') {
    const { text, retry } = failureText(load.failure, t)
    return (
      <div className={css.centered} role="alert">
        <p className={css.message}>{text}</p>
        {retry && <Button size="sm" variant="outline" onClick={() => { setAttempt(count => count + 1) }}>{t('action.retry')}</Button>}
      </div>
    )
  }
  return asset.format.kind === 'image'
    ? <ImageView asset={asset} file={load.file} animations={animations} read={read} requested={requested} t={t} />
    : <ModelView asset={asset} file={load.file} relatedUrl={relatedUrl} requested={requested} t={t} />
}
