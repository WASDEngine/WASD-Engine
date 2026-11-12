/**
 * The 3D view: the model on a three.js stage, framed from the front right and above, with orbit controls (drag to turn,
 * right drag or Shift drag to pan, scroll to zoom, arrow keys to pan), its animations on a timeline that seeks and
 * changes speed, its skeleton drawn over it, clay and wireframe shading, a reset of the camera, and its details: size,
 * geometry, materials, textures, bones, clips, and morph targets with sliders. three.js and the loaders arrive in a
 * chunk loaded on first use. A new version of the same file keeps the camera, the shading, and the playing clip.
 */
import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  fileSizeText, IconChevronDownOutlineRegular, IconInfoOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, Menu, StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelAssetDetails } from '@deepseek-ai/dsh-game-assets/types'
import { DetailsPanel, type MorphControl } from './DetailsPanel.tsx'
import type { NS } from './locales.ts'
import type { AssetFile } from './read.ts'
import type { AssetEntry } from './scan.ts'
import type { ViewRequest } from './source.ts'
import type { ClipClock, ModelStage } from './viewer/index.ts'
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
  /** What an agent asked to show: the clip to play once the model shows; `request` changes for each ask. */
  readonly requested?: ViewRequest | undefined
  readonly t: Translate
}

type ModelModule = typeof import('./viewer/index.ts')

/** The stage once its chunk loaded, or why there is none. */
type StageState =
  | { readonly kind: 'ready'; readonly stage: ModelStage; readonly module: ModelModule }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' }

/** Playback speeds the timeline offers. */
const SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const

/** How long a model's late textures may take before its details are measured without them. */
const TEXTURE_WAIT_MS = 20_000

function WireframeGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.75l5.5 3.1v6.3L8 14.25l-5.5-3.1v-6.3Z" stroke="currentColor" strokeLinejoin="round" />
      <path d="M2.5 4.85 8 8l5.5-3.15M8 8v6.25M2.5 11.15 8 8l5.5 3.15M8 1.75V8" stroke="currentColor" strokeLinejoin="round" strokeOpacity=".55" />
    </svg>
  )
}

function ClayGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="5.75" stroke="currentColor" />
      <path d="M5 6.2a3.6 3.6 0 0 1 2.4-2.1" stroke="currentColor" strokeLinecap="round" strokeOpacity=".7" />
    </svg>
  )
}

function SkeletonGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="3" r="1.5" stroke="currentColor" />
      <path d="M8 4.5v5.5M8 6.5 4.5 8.5M8 6.5l3.5 2M8 10l-2.5 4M8 10l2.5 4" stroke="currentColor" strokeLinecap="round" />
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

/** The clip's time, a slider that seeks, and the speed; it follows the stage's clock on its own. */
function Timeline({ stage, t }: { readonly stage: ModelStage; readonly t: Translate }): ReactNode {
  const [clock, setClock] = useState<ClipClock | undefined>(() => stage.clock())
  const [speed, setSpeed] = useState(1)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    let frame = 0
    let latest: ClipClock | undefined
    setClock(stage.clock())
    const stop = stage.onClock((next) => {
      latest = next
      if (frame !== 0) return
      // One update per animation frame, however often the stage reports.
      frame = requestAnimationFrame(() => {
        frame = 0
        setClock(latest)
      })
    })
    return () => {
      stop()
      if (frame !== 0) cancelAnimationFrame(frame)
    }
  }, [stage])
  if (clock === undefined) return null
  return (
    <div className={css.timeline}>
      <input
        className={css.scrubber}
        type="range"
        min={0}
        max={Math.max(clock.duration, 0.001)}
        step={0.001}
        value={clock.time}
        aria-label={t('model.seek')}
        onChange={(event) => { stage.seek(Number(event.currentTarget.value)) }}
      />
      <span className={css.time}>{t('model.time', { time: clock.time.toFixed(2), duration: clock.duration.toFixed(2) })}</span>
      <Menu
        open={menuOpen}
        side="top"
        align="end"
        portal
        compact
        anchor={(
          <button type="button" className={css.clip} aria-label={t('model.speed')} aria-haspopup="menu" aria-expanded={menuOpen}
            onClick={() => { setMenuOpen(open => !open) }}>
            <span className={css.clipName}>{t('model.speedValue', { speed: String(speed) })}</span>
            <IconChevronDownOutlineRegular size={12} />
          </button>
        )}
        items={SPEEDS.map(value => ({ id: String(value), label: t('model.speedValue', { speed: String(value) }) }))}
        selectedId={String(speed)}
        onClose={() => { setMenuOpen(false) }}
        onSelect={(id) => {
          setMenuOpen(false)
          setSpeed(Number(id))
          stage.setSpeed(Number(id))
        }}
      />
    </div>
  )
}

/**
 * Show one model.
 * @param props - the asset, its bytes, the related-file resolver, the clip an agent asked for, and copy.
 * @returns the stage over its timeline, info bar, controls, and details.
 */
export function ModelView({ asset, file, relatedUrl, requested, t }: ModelViewProps): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<StageState>()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [details, setDetails] = useState<ModelAssetDetails>()
  const [clip, setClip] = useState<number>()
  const [playing, setPlaying] = useState(true)
  const [shading, setShading] = useState<'material' | 'solid' | 'wireframe'>('material')
  const [skeleton, setSkeleton] = useState(false)
  const [bone, setBone] = useState<number>()
  const [showDetails, setShowDetails] = useState(false)
  const [morphs, setMorphs] = useState<readonly MorphControl[]>([])
  const [menuOpen, setMenuOpen] = useState(false)
  // The settings a newly loaded model takes on, read inside the load without reloading when they change; every change
  // of the clip, the playing state, the shading, or the skeleton writes them here beside its state.
  const settings = useRef<{
    clip: number | undefined
    playing: boolean
    shading: 'material' | 'solid' | 'wireframe'
    skeleton: boolean
    clips: readonly string[]
    path: string | undefined
    request: number | undefined
  }>({ clip: undefined, playing: true, shading: 'material', skeleton: false, clips: [], path: undefined, request: undefined })

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
      drawn.setShading(previous.shading)
      drawn.setSkeleton(previous.skeleton)
      drawn.setPlaying(previous.playing)
      drawn.setClip(next)
      settings.current = { ...previous, clip: next, clips, path }
      setClip(next)
      setBone(undefined)
      setMorphs(module.morphTargetsOf(model.root).map(entry => ({ ...entry, values: entry.targets.map(() => 0) })))
      setDetails(module.describeModel(model, asset.format.label, file.data.byteLength))
      setPhase('ready')
      // Texture sizes and missing files are known once the files the model names have loaded.
      let timer: ReturnType<typeof setTimeout> | undefined
      void Promise.race([model.settled, new Promise<void>((resolve) => { timer = setTimeout(resolve, TEXTURE_WAIT_MS) })]).then(() => {
        clearTimeout(timer)
        if (!controller.signal.aborted) setDetails(module.describeModel(model, asset.format.label, file.data.byteLength))
      })
    }, () => {
      if (!controller.signal.aborted) setPhase('failed')
    })
    return () => { controller.abort() }
  }, [stage, file, path, format, relatedUrl, asset.format.label])

  const drawn = stage?.kind === 'ready' ? stage.stage : undefined
  const clips = details?.animations.map(animation => animation.name) ?? settings.current.clips
  const chooseClip = (next: number | undefined): void => {
    settings.current.clip = next
    setClip(next)
    drawn?.setClip(next)
  }

  // A clip an agent asked for plays once the model it belongs to shows.
  useEffect(() => {
    if (requested?.animation === undefined || phase !== 'ready' || settings.current.request === requested.request) return
    const wanted = requested.animation.toLowerCase()
    const index = clips.findIndex(name => name.toLowerCase() === wanted)
    if (index < 0) return
    settings.current.request = requested.request
    settings.current.playing = true
    setPlaying(true)
    drawn?.setPlaying(true)
    chooseClip(index)
  })

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
  const chooseShading = (next: 'material' | 'solid' | 'wireframe'): void => {
    settings.current.shading = next
    setShading(next)
    drawn?.setShading(next)
  }
  const chooseSkeleton = (on: boolean): void => {
    settings.current.skeleton = on
    setSkeleton(on)
    drawn?.setSkeleton(on)
  }
  const hasBones = (details?.boneCount ?? 0) > 0

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
      {drawn !== undefined && clip !== undefined && phase === 'ready' && <Timeline stage={drawn} t={t} />}
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
                chooseClip(id === 'none' ? undefined : Number(id))
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
        <Tooltip label={t('model.skeleton')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('model.skeleton')} aria-pressed={skeleton} disabled={drawn === undefined || !hasBones}
            onClick={() => { chooseSkeleton(!skeleton) }}>
            <SkeletonGlyph />
          </button>
        </Tooltip>
        <Tooltip label={t('model.clay')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('model.clay')} aria-pressed={shading === 'solid'} disabled={drawn === undefined}
            onClick={() => { chooseShading(shading === 'solid' ? 'material' : 'solid') }}>
            <ClayGlyph />
          </button>
        </Tooltip>
        <Tooltip label={t('model.wireframe')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('model.wireframe')} aria-pressed={shading === 'wireframe'} disabled={drawn === undefined}
            onClick={() => { chooseShading(shading === 'wireframe' ? 'material' : 'wireframe') }}>
            <WireframeGlyph />
          </button>
        </Tooltip>
        <Tooltip label={t('model.reset')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('model.reset')} disabled={drawn === undefined}
            onClick={() => { drawn?.resetView() }}>
            <ResetViewGlyph />
          </button>
        </Tooltip>
        <Tooltip label={showDetails ? t('details.hide') : t('details.show')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('details.title')} aria-pressed={showDetails} disabled={details === undefined}
            onClick={() => { setShowDetails(value => !value) }}>
            <IconInfoOutlineRegular size={14} />
          </button>
        </Tooltip>
      </div>
      {showDetails && details !== undefined && (
        <DetailsPanel
          details={details}
          t={t}
          playing={clip === undefined ? undefined : clips[clip]}
          onPlay={(name) => {
            const index = clips.indexOf(name)
            if (index < 0) return
            settings.current.playing = true
            setPlaying(true)
            drawn?.setPlaying(true)
            chooseClip(index)
          }}
          selectedBone={bone}
          onSelectBone={(index) => {
            setBone(index)
            if (index !== undefined && !skeleton) chooseSkeleton(true)
            drawn?.selectBone(index)
          }}
          morphs={morphs}
          onMorph={(key, index, value) => {
            drawn?.setMorph(key, index, value)
            setMorphs(current => current.map((entry) => {
              if (entry.key !== key) return entry
              return { ...entry, values: entry.values.map((old, at) => (at === index ? value : old)) }
            }))
          }}
        />
      )}
    </div>
  )
}
