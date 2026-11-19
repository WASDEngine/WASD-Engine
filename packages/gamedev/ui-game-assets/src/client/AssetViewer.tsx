/**
 * The selected asset's viewer: it reads the file, reads it again whenever the `file` resource reports a new version,
 * and hands the bytes to the image or model view. A Blender file shows a model exported from it, found by its name
 * among the project's models, or a notice when there is none.
 */
import type { ReactNode } from 'react'
import { Button, fileSizeText, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { RemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type { AssetsTabInjected } from './AssetsTab.tsx'
import { ImageView } from './ImageView.tsx'
import type { NS } from './locales.ts'
import { ModelView } from './ModelView.tsx'
import { useVersionedRead } from './project-tab.ts'
import { exportOf } from './formats.ts'
import type { AssetFile } from './read.ts'
import type { ViewRequest } from './source.ts'
import type { AssetEntry } from './scan.ts'
import css from './AssetViewer.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** What the viewer needs from the tab. */
export interface AssetViewerProps extends Pick<AssetsTabInjected, 'read' | 'relatedUrl' | 'fileAddress' | 'animations' | 'limits'> {
  /** The asset to show. */
  readonly asset: AssetEntry
  /** The project's assets, where a Blender file's export is looked up. */
  readonly assets: readonly AssetEntry[]
  readonly useResource: PropsRuntime<'sidebar.right.pane.tab'>['useResource']
  /** @param path - workspace path of an asset to select instead. */
  readonly onSelect: (path: string) => void
  /** What an agent asked to show with the asset, once per `request`. */
  readonly requested?: ViewRequest | undefined
  /**
   * Told when an image's animations lack the one an agent asked for, which a Godot file newer than the scan may define.
   * @param request - the ask's `request`.
   */
  readonly onMissingAnimation?: ((request: number) => void) | undefined
  /** Whether the tab is on screen; a hidden view pauses its animation. */
  readonly visible: boolean
  readonly t: Translate
}

/** What a settled read shows. */
type Read =
  | { readonly kind: 'ready'; readonly file: AssetFile }
  | { readonly kind: 'failed'; readonly failure: RemoteFailure }

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
    case 'game-assets/outside':
      return { text: t('viewer.outside'), retry: false }
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
function LoadedAsset({
  asset, useResource, read, relatedUrl, fileAddress, animations, limits, visible, requested, onMissingAnimation, t,
}: AssetViewerProps): ReactNode {
  const { load, gone, retry: readAgain } = useVersionedRead(
    useResource,
    fileAddress(asset.path),
    async (signal): Promise<Read> => {
      const result = await read(asset.path, signal)
      return result.ok ? { kind: 'ready', file: result.value } : { kind: 'failed', failure: result.error }
    },
    settled => (settled.kind === 'ready' ? settled.file.version : undefined),
    [asset.path, read],
  )

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
        {retry && <Button size="sm" variant="outline" onClick={readAgain}>{t('action.retry')}</Button>}
      </div>
    )
  }
  return asset.format.kind === 'image'
    ? (
      <ImageView
        asset={asset} file={load.file} animations={animations} read={read} requested={requested}
        onMissingAnimation={onMissingAnimation} maxDecodedPixels={limits.maxDecodedPixels} visible={visible} t={t}
      />
    )
    : (
      <ModelView
        asset={asset} file={load.file} relatedUrl={relatedUrl} maxBytes={limits.maxPreviewBytes}
        maxDecodedPixels={limits.maxDecodedPixels} visible={visible} requested={requested} t={t}
      />
    )
}
