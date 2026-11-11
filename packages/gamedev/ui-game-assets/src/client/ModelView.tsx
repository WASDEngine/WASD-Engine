/**
 * The 3D view: the model on a three.js stage, framed from the front right and above, with orbit controls (drag to turn,
 * right drag or Shift drag to pan, scroll to zoom, arrow keys to pan), its animations, a wireframe switch, and a reset of
 * the camera. three.js and the loaders arrive in a chunk loaded on first use. A new version of the same file keeps the
 * camera and the playing clip.
 */
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  fileSizeText, IconChevronDownOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, Menu, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { AssetFile } from './read.ts'
import type { AssetEntry } from './scan.ts'
import type { ModelStage } from './viewer/index.ts'
import css from './ModelView.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** What the 3D view draws. */
export interface ModelViewProps {
  /** The model asset. */
  readonly asset: AssetEntry
  /** Its bytes. */
  readonly file: AssetFile
  /**
   * The URL of a file the model names.
   * @param base - absolute path of the model file.
   * @param reference - the name as the model stores it.
   * @returns the URL to load.
   */
  readonly relatedUrl: (base: string, reference: string) => string
  readonly t: Translate
}

type ModelModule = typeof import('./viewer/index.ts')

/** The stage once its chunk loaded, or why there is none. */
type StageState =
  | { readonly kind: 'ready'; readonly stage: ModelStage; readonly module: ModelModule }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' }

/** What the bar shows about the loaded model. */
interface Details {
  readonly triangles: number
  readonly clips: readonly string[]
}

function WireframeGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.75l5.5 3.1v6.3L8 14.25l-5.5-3.1v-6.3Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M2.5 4.85 8 8l5.5-3.15M8 8v6.25M2.5 11.15 8 8l5.5 3.15M8 1.75V8" stroke="currentColor" strokeLinejoin="round" strokeOpacity=".55" />
    </svg>
  )
}

function ResetViewGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 5.5v-2a1 1 0 0 1 1-1h2M10.5 2.5h2a1 1 0 0 1 1 1v2M13.5 10.5v2a1 1 0 0 1-1 1h-2M5.5 13.5h-2a1 1 0 0 1-1-1v-2" stroke="currentColor" strokeLinecap="round" />
      <circle cx="8" cy="8" r="1.75" stroke="currentColor" />
    </svg>
  )
}

/**
 * Show one model.
 * @param props - the asset, its bytes, the related-file resolver, and copy.
 * @returns the stage over its info bar and controls.
 */
export function ModelView({ asset, file, relatedUrl, t }: ModelViewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<StageState>()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [details, setDetails] = useState<Details>()
  const [clip, setClip] = useState<number>()
  const [playing, setPlaying] = useState(true)
  const [wireframe, setWireframe] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  // The settings a newly loaded model takes on, read inside the load without reloading when they change; every change
  // of the clip, the playing state, or the wireframe switch writes them here beside its state.
  const settings = useRef<{
    clip: number | undefined
    playing: boolean
    wireframe: boolean
    clips: readonly string[]
    path: string | undefined
  }>({ clip: undefined, playing: true, wireframe: false, clips: [], path: undefined })

  useEffect(() => {
    let disposed = false
    let created: ModelStage | undefined
    void import('./viewer/index.ts').then((module) => {
      const canvas = canvasRef.current
      if (disposed || canvas === null) return
      try {
        created = new module.ModelStage(canvas)
      } catch {
        // Error: three.js could not create a WebGL context, which the browser has turned off or does not offer.
        setStage({ kind: 'unavailable' })
        return
      }
      setStage({ kind: 'ready', stage: created, module })
    }, () => {
      if (!disposed) setStage({ kind: 'failed' })
    })
    return () => {
      disposed = true
      created?.dispose()
    }
  }, [])

  useEffect(() => {
    const element = viewportRef.current
    if (stage?.kind !== 'ready' || element === null) return
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      stage.stage.resize(box.width, box.height, window.devicePixelRatio)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [stage])

  // A rescan lists the asset again as a new object; only its path, its format, and the read file decide a reload.
  const { path, format } = asset
  useEffect(() => {
    if (stage?.kind !== 'ready' || format.kind !== 'model' || format.decoder === 'blend') return
    const controller = new AbortController()
    const { module, stage: drawn } = stage
    void module.loadModel({
      decoder: format.decoder,
      data: file.data,
      related: reference => relatedUrl(file.absolutePath, reference),
      changed: () => { drawn.requestRender() },
    }, controller.signal).then((model) => {
      if (controller.signal.aborted) {
        model.dispose()
        return
      }
      const previous = settings.current
      const sameFile = previous.path === path
      const clips = model.animations.map(animation => animation.name)
      // A new version of the same file keeps its clip when one of that name is still there; a new file plays its first.
      // A reader who chose no animation keeps none.
      const kept = sameFile && previous.clip !== undefined ? clips.indexOf(previous.clips[previous.clip] ?? '') : -1
      const restPose = sameFile && previous.clip === undefined && previous.clips.length > 0
      const first = clips.length > 0 ? 0 : undefined
      const next = kept >= 0 ? kept : restPose ? undefined : first
      drawn.show(model, sameFile)
      drawn.setWireframe(previous.wireframe)
      drawn.setPlaying(previous.playing)
      drawn.setClip(next)
      settings.current = { ...previous, clip: next, clips, path }
      setClip(next)
      setDetails({ triangles: model.stats.triangles, clips })
      setPhase('ready')
    }, () => {
      if (!controller.signal.aborted) setPhase('failed')
    })
    return () => { controller.abort() }
  }, [stage, file, path, format, relatedUrl])

  const drawn = stage?.kind === 'ready' ? stage.stage : undefined
  const clips = details?.clips ?? []
  const clipLabel = (index: number | undefined): string => {
    if (index === undefined) return t('model.restPose')
    const name = clips[index]
    return name === undefined || name === '' ? t('model.clip', { number: index + 1 }) : name
  }
  const numbers = new Intl.NumberFormat(document.documentElement.lang || undefined)
  const info: readonly (readonly [key: string, text: string])[] = [
    ['format', asset.format.label],
    ...details === undefined ? [] : [[
      'triangles',
      t(details.triangles === 1 ? 'model.triangles.one' : 'model.triangles.other', { count: numbers.format(details.triangles) }),
    ] as const],
    ['size', fileSizeText(file.data.byteLength)],
  ]
  let status: ReactNode
  if (stage?.kind === 'unavailable') status = <div className={css.status} role="alert">{t('viewer.noWebgl')}</div>
  else if (stage?.kind === 'failed' || phase === 'failed') status = <div className={css.status} role="alert">{t('viewer.unreadable')}</div>
  else if (phase === 'loading') status = <div className={css.status} role="status" aria-label={t('viewer.loading', { name: asset.name })}><StateDot state="ongoing" /></div>

  return (
    <div className={css.root}>
      <div ref={viewportRef} className={css.viewport}>
        <canvas
          ref={canvasRef}
          className={clsx(css.canvas, phase !== 'ready' && css.hidden)}
          tabIndex={0}
          role="img"
          aria-label={t('model.canvas', { name: asset.name })}
        />
        {status}
      </div>
      <div className={css.bar}>
        <span className={css.info} title={asset.path}>
          {info.map(([key, text]) => <span key={key} className={css.infoItem}>{text}</span>)}
        </span>
        {clips.length > 0 && (
          <>
            <Menu
              open={menuOpen}
              side="top"
              align="end"
              portal
              compact
              anchor={(
                <button type="button" className={css.clip} aria-label={t('model.animation')} aria-haspopup="menu" aria-expanded={menuOpen}
                  title={clipLabel(clip)} onClick={() => { setMenuOpen(open => !open) }}>
                  <span className={css.clipName}>{clipLabel(clip)}</span>
                  <IconChevronDownOutlineRegular size={12} />
                </button>
              )}
              items={[
                { id: 'none', label: t('model.restPose') },
                { type: 'separator', id: 'clips' },
                ...clips.map((_, index) => ({ id: String(index), label: clipLabel(index) })),
              ]}
              selectedId={clip === undefined ? 'none' : String(clip)}
              onClose={() => { setMenuOpen(false) }}
              onSelect={(id) => {
                setMenuOpen(false)
                const next = id === 'none' ? undefined : Number(id)
                settings.current.clip = next
                setClip(next)
                drawn?.setClip(next)
              }}
            />
            <Tooltip label={playing ? t('model.pause') : t('model.play')} side="top" delayMs={500}>
              <button type="button" className={css.tool} aria-label={playing ? t('model.pause') : t('model.play')} disabled={clip === undefined}
                onClick={() => {
                  settings.current.playing = !playing
                  setPlaying(!playing)
                  drawn?.setPlaying(!playing)
                }}>
                {playing ? <IconPauseOutlineRegular size={14} /> : <IconPlayOutlineRegular size={14} />}
              </button>
            </Tooltip>
          </>
        )}
        <Tooltip label={t('model.wireframe')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('model.wireframe')} aria-pressed={wireframe} disabled={drawn === undefined}
            onClick={() => {
              settings.current.wireframe = !wireframe
              setWireframe(!wireframe)
              drawn?.setWireframe(!wireframe)
            }}>
            <WireframeGlyph />
          </button>
        </Tooltip>
        <Tooltip label={t('model.reset')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('model.reset')} disabled={drawn === undefined}
            onClick={() => { drawn?.resetView() }}>
            <ResetViewGlyph />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
