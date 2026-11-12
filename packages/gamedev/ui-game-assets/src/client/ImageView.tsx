/**
 * The 2D view: the image on a checkerboard that shows transparency, fitted to the stage until the reader zooms. The
 * wheel and pinch zoom around the pointer, dragging pans, a double click switches between the fitted view and actual
 * size, and pixels stay sharp from twice the actual size. Images the browser decodes show from their bytes; TGA, HDR,
 * and EXR images are decoded by three.js, high dynamic range ones tone mapped for the screen. The Animation menu plays
 * the 2D animations the image plays or takes part in, frame by frame with a timeline and a speed, and its Sprite grid
 * reads the image as a sheet of the columns and rows the reader gives, drawn over it. The details list the image's
 * size, transparency, colors, and animations.
 */
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import {
  fileSizeText, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconInfoOutlineRegular, IconPauseOutlineRegular,
  IconPlayOutlineRegular, IconPlusOutlineRegular, Menu, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssetGrid } from '@deepseek-ai/dsh-game-assets/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AnimationSources } from './animations2d.ts'
import { DetailsPanel } from './DetailsPanel.tsx'
import type { NS } from './locales.ts'
import type { AssetFile } from './read.ts'
import type { AssetEntry } from './scan.ts'
import type { ViewRequest } from './source.ts'
import { SpritePlayer, type SpriteState } from './sprite-player.ts'
import { gridAnimation, gridRegions, stripGuess, type SpriteAnimation } from './sprites.ts'
import css from './ImageView.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** What the 2D view draws. */
export interface ImageViewProps {
  /** The image asset. */
  readonly asset: AssetEntry
  /** Its bytes. */
  readonly file: AssetFile
  /** The reads that find the image's animations; without them the image has none. */
  readonly animations?: AnimationSources | undefined
  /**
   * Read another image of the workspace, for frames that show it.
   * @param path - workspace path.
   * @param signal - cancellation.
   * @returns the file, or the failure.
   */
  readonly read?: ((path: string, signal: AbortSignal) => Promise<RemoteResult<AssetFile>>) | undefined
  /** What an agent asked to show: a sprite grid and a 2D animation to play once found; `request` changes for each ask. */
  readonly requested?: ViewRequest | undefined
  readonly t: Translate
}

/** A decoded picture: a Blob URL the browser decodes, or a bitmap three.js decoded. */
type Picture =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'bitmap'; readonly bitmap: ImageBitmap }

interface Size {
  readonly width: number
  readonly height: number
}

/** Space kept around a fitted image, in CSS pixels. */
const FIT_MARGIN = 16
/** Zoom bounds, as scale factors. */
const MIN_ZOOM = 0.01
const MAX_ZOOM = 64
/** Scale factor of one zoom step from the buttons and keys. */
const ZOOM_STEP = 1.5
/** From this scale up, pixels draw as squares. */
const PIXELATED_FROM = 2
/** Distance an arrow key pans, in CSS pixels. */
const PAN_STEP = 40
/** Edge used for an image without an intrinsic size, such as an SVG with only a viewBox. */
const FALLBACK_EDGE = 512
/** Playback speeds the timeline offers. */
const SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const
/** Most columns or rows of a sprite grid. */
const MAX_GRID = 256
/** Id of the menu item that opens the sprite grid. */
const GRID_ITEM = '\u0000grid'
/** Id of the menu item that shows the still image. */
const STILL_ITEM = '\u0000still'

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

function clampCount(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_GRID, Math.max(1, Math.round(value))) : 1
}

/**
 * Show one image.
 * @param props - the asset, its bytes, the reads for its animations, the animation an agent asked for, and copy.
 * @returns the zoomable picture over its timeline, sprite grid, info and zoom bar, and details.
 */
export function ImageView({ asset, file, animations: sources, read, requested, t }: ImageViewProps): ReactNode {
  const format = asset.format
  const [picture, setPicture] = useState<Picture | 'failed'>()
  const [natural, setNatural] = useState<Size>()
  useEffect(() => {
    if (format.kind !== 'image') return
    let disposed = false
    let release = (): void => {}
    setPicture(undefined)
    setNatural(undefined)
    if (format.decoder === 'browser') {
      const url = URL.createObjectURL(new Blob([file.data], format.mediaType === undefined ? {} : { type: format.mediaType }))
      release = () => { URL.revokeObjectURL(url) }
      setPicture({ kind: 'url', url })
    } else {
      const decoder = format.decoder
      void import('./viewer/index.ts').then(module => module.decodeImage(decoder, file.data)).then((bitmap) => {
        if (disposed) {
          bitmap.close()
          return
        }
        release = () => { bitmap.close() }
        setNatural({ width: bitmap.width, height: bitmap.height })
        setPicture({ kind: 'bitmap', bitmap })
      }, () => {
        if (!disposed) setPicture('failed')
      })
    }
    return () => {
      disposed = true
      release()
    }
  }, [file, format])

  // The animation player: the decoded image and its frames, and the animations found for it.
  const [player, setPlayer] = useState<SpritePlayer>()
  const [sprite, setSprite] = useState<SpriteState>()
  useEffect(() => {
    if (format.kind !== 'image') return
    const created = new SpritePlayer(asset.path, format, read ?? (() => Promise.reject(new Error('no reads'))), () => import('./viewer/index.ts'))
    const controller = new AbortController()
    setPlayer(created)
    setSprite(undefined)
    void created.load(file, sources, controller.signal).then((state) => {
      if (state !== undefined && !controller.signal.aborted) setSprite(state)
    }, () => {
      // Error: an image the player cannot decode shows without animations, as the view shows it.
    })
    return () => {
      controller.abort()
      created.close()
    }
  }, [asset.path, file, format, read, sources])

  const [grid, setGrid] = useState<AssetGrid>()
  const [gridOpen, setGridOpen] = useState(false)
  const [active, setActive] = useState<string>()
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [menuOpen, setMenuOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
  const [showDetails, setShowDetails] = useState(false)
  const [, setDrawn] = useState(0)
  const handled = useRef<number>()
  useEffect(() => {
    setGrid(undefined)
    setGridOpen(false)
    setActive(undefined)
    setFrame(0)
  }, [file])

  const imageSize = sprite === undefined ? natural : { width: sprite.picture.width, height: sprite.picture.height }
  const animations = useMemo<readonly SpriteAnimation[]>(() => {
    const found = sprite?.animations ?? []
    if (grid === undefined || imageSize === undefined) return found
    return [...found, gridAnimation(asset.path, imageSize.width, imageSize.height, grid)]
  }, [sprite, grid, imageSize?.width, imageSize?.height, asset.path])
  const animation = active === undefined ? undefined : animations.find(candidate => candidate.name === active)
  const current = animation?.frames[Math.min(frame, animation.frames.length - 1)]

  // An agent's grid shows over the image, and the animation it asked for plays once it is found.
  useEffect(() => {
    if (requested === undefined || sprite === undefined || handled.current === requested.request) return
    if (requested.grid !== undefined && grid !== requested.grid) {
      setGrid(requested.grid)
      setGridOpen(true)
      return
    }
    const wanted = requested.animation?.toLowerCase()
    const match = wanted === undefined ? undefined : animations.find(candidate => candidate.name.toLowerCase() === wanted)
    if (wanted !== undefined && match === undefined) return
    handled.current = requested.request
    if (match === undefined) return
    setActive(match.name)
    setFrame(0)
    setPlaying(true)
  }, [requested, sprite, animations, grid])

  // Playback: each frame shows for its duration at the chosen speed; a looping animation starts over.
  useEffect(() => {
    if (animation === undefined || !playing || animation.frames.length < 2 || current === undefined) return
    const timer = setTimeout(() => {
      setFrame((index) => {
        const next = index + 1
        if (next < animation.frames.length) return next
        if (animation.loop) return 0
        setPlaying(false)
        return index
      })
    }, Math.max(10, current.durationMs / speed))
    return () => { clearTimeout(timer) }
  }, [animation, playing, current, speed])

  // A frame of another image is read on first show; the canvas draws it once it is ready.
  useEffect(() => {
    if (current === undefined || player === undefined || player.ready(current) !== undefined) return
    const controller = new AbortController()
    void player.picture(current, controller.signal).then(() => {
      if (!controller.signal.aborted) setDrawn(count => count + 1)
    })
    return () => { controller.abort() }
  }, [current, player])

  const frameSize = current === undefined ? undefined : current.region ?? (player?.ready(current) ?? imageSize)
  const shownSize = animation === undefined ? natural : frameSize ?? natural

  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Size>()
  useEffect(() => {
    const element = viewportRef.current
    if (element === null) return
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      setViewport(currentBox => currentBox?.width === box.width && currentBox.height === box.height
        ? currentBox
        : { width: box.width, height: box.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // The zoom, `fit` or a scale, and the pan offset from the centered position, updated together from the latest state.
  const [view, setView] = useState<{ readonly zoom: 'fit' | number; readonly x: number; readonly y: number }>({ zoom: 'fit', x: 0, y: 0 })
  // Another animation, or the still image, shows fitted.
  useEffect(() => { setView({ zoom: 'fit', x: 0, y: 0 }) }, [active])
  const fitScale = shownSize === undefined || viewport === undefined
    ? 1
    : clampZoom(Math.min(
      Math.max(1, viewport.width - 2 * FIT_MARGIN) / shownSize.width,
      Math.max(1, viewport.height - 2 * FIT_MARGIN) / shownSize.height,
    ))
  const fitRef = useRef(fitScale)
  useLayoutEffect(() => { fitRef.current = fitScale }, [fitScale])
  const scale = view.zoom === 'fit' ? fitScale : view.zoom

  // Zoom so the image point under `point`, relative to the stage's center, stays under it.
  const zoomAt = useCallback((point: { readonly x: number; readonly y: number }, next: (scale: number) => number): void => {
    setView((currentView) => {
      const from = currentView.zoom === 'fit' ? fitRef.current : currentView.zoom
      const target = clampZoom(next(from))
      return {
        zoom: target,
        x: point.x - (point.x - currentView.x) * target / from,
        y: point.y - (point.y - currentView.y) * target / from,
      }
    })
  }, [])
  const fit = (): void => { setView({ zoom: 'fit', x: 0, y: 0 }) }
  const actual = (): void => { setView({ zoom: 1, x: 0, y: 0 }) }
  // Panning leaves the fitted view at its scale.
  const pan = (move: (currentView: { readonly x: number; readonly y: number }) => { readonly x: number; readonly y: number }): void => {
    setView(currentView => ({ zoom: currentView.zoom === 'fit' ? fitRef.current : currentView.zoom, ...move(currentView) }))
  }

  const centered = (clientX: number, clientY: number): { x: number; y: number } => {
    const box = viewportRef.current?.getBoundingClientRect()
    return box === undefined ? { x: 0, y: 0 } : { x: clientX - box.left - box.width / 2, y: clientY - box.top - box.height / 2 }
  }
  // React's wheel listener is passive, so the zoom listener is attached here to keep the page from scrolling.
  useEffect(() => {
    const element = viewportRef.current
    if (element === null) return
    const wheel = (event: WheelEvent): void => {
      event.preventDefault()
      const box = element.getBoundingClientRect()
      const perStep = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 0.05 : 0.0015
      const factor = Math.exp(-event.deltaY * perStep)
      zoomAt({ x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }, from => from * factor)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { element.removeEventListener('wheel', wheel) }
  }, [zoomAt])

  const drag = useRef<{
    readonly pointer: number
    readonly x: number
    readonly y: number
    readonly from: { readonly x: number; readonly y: number }
  }>()
  const [dragging, setDragging] = useState(false)
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: { x: view.x, y: view.y } }
    setDragging(true)
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const start = drag.current
    if (start?.pointer !== event.pointerId) return
    pan(() => ({ x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y }))
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (drag.current?.pointer !== event.pointerId) return
    drag.current = undefined
    setDragging(false)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const by = (x: number, y: number): void => { pan(currentView => ({ x: currentView.x + x, y: currentView.y + y })) }
    switch (event.key) {
      case '+':
      case '=': zoomAt({ x: 0, y: 0 }, from => from * ZOOM_STEP); break
      case '-': zoomAt({ x: 0, y: 0 }, from => from / ZOOM_STEP); break
      case '0': fit(); break
      case '1': actual(); break
      case 'ArrowLeft': by(PAN_STEP, 0); break
      case 'ArrowRight': by(-PAN_STEP, 0); break
      case 'ArrowUp': by(0, PAN_STEP); break
      case 'ArrowDown': by(0, -PAN_STEP); break
      default: return
    }
    event.preventDefault()
  }

  const drawBitmap = useCallback((canvas: HTMLCanvasElement | null): void => {
    if (canvas === null || typeof picture !== 'object' || picture.kind !== 'bitmap') return
    canvas.getContext('2d')?.drawImage(picture.bitmap, 0, 0)
  }, [picture])

  // The current frame, drawn at its own size; the zoom scales the canvas.
  const frameCanvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const canvas = frameCanvas.current
    if (canvas === null || current === undefined || player === undefined) return
    const source = player.ready(current) ?? (current.path === asset.path ? sprite?.picture : undefined)
    const context = canvas.getContext('2d')
    if (context === null) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    if (source === undefined) return
    const region = current.region ?? { x: 0, y: 0, width: source.width, height: source.height }
    context.imageSmoothingEnabled = false
    context.drawImage(source.source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height)
  })

  const shown = shownSize ?? { width: 0, height: 0 }
  const box: CSSProperties | undefined = shownSize === undefined || viewport === undefined ? undefined : {
    width: `${String(shown.width * scale)}px`,
    height: `${String(shown.height * scale)}px`,
    transform: `translate(${String(viewport.width / 2 - shown.width * scale / 2 + view.x)}px, ${String(viewport.height / 2 - shown.height * scale / 2 + view.y)}px)`,
  }
  const pictureClass = clsx(css.picture, scale >= PIXELATED_FROM && css.pixelated, box === undefined && css.measuring)
  const alt = t('image.alt', { name: asset.name })
  const info: readonly (readonly [key: string, text: string])[] = [
    ['format', format.label],
    ...natural === undefined ? [] : [['dimensions', t('image.dimensions', { width: natural.width, height: natural.height })] as const],
    ['size', fileSizeText(file.data.byteLength)],
  ]
  const percent = t('image.zoom', { percent: Math.round(scale * 100) })
  const shownGrid = gridOpen && animation === undefined && grid !== undefined && imageSize !== undefined
    ? gridRegions(imageSize.width, imageSize.height, grid)
    : []
  const details = sprite === undefined || player === undefined ? undefined : player.details(sprite, animations, file.data.byteLength)
  const choose = (name: string | undefined): void => {
    setActive(name)
    setFrame(0)
    setPlaying(true)
  }
  const openGrid = (): void => {
    if (grid === undefined && imageSize !== undefined) setGrid(stripGuess(imageSize.width, imageSize.height) ?? { columns: 1, rows: 1 })
    setGridOpen(true)
  }
  const setGridField = (field: 'columns' | 'rows' | 'count', value: number): void => {
    setGrid((currentGrid) => {
      const base = currentGrid ?? { columns: 1, rows: 1 }
      const next = field === 'count' ? { ...base, count: Math.min(clampCount(value), base.columns * base.rows) } : { ...base, [field]: clampCount(value) }
      const cells = next.columns * next.rows
      return next.count === undefined || next.count <= cells ? next : { columns: next.columns, rows: next.rows }
    })
    setFrame(0)
  }

  return (
    <div className={css.root}>
      <div
        ref={viewportRef}
        className={clsx(css.viewport, dragging && css.dragging)}
        tabIndex={0}
        role="img"
        aria-label={alt}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={(event) => {
          if (view.zoom === 'fit') zoomAt(centered(event.clientX, event.clientY), () => 1)
          else fit()
        }}
        onKeyDown={onKeyDown}
      >
        {picture === undefined && <div className={css.status}><StateDot state="ongoing" /></div>}
        {picture === 'failed' && <div className={css.status} role="alert">{t('viewer.unreadable')}</div>}
        {animation === undefined && typeof picture === 'object' && picture.kind === 'url' && (
          <img
            className={pictureClass}
            style={box}
            src={picture.url}
            alt=""
            draggable={false}
            onLoad={(event) => {
              const image = event.currentTarget
              setNatural({ width: image.naturalWidth || FALLBACK_EDGE, height: image.naturalHeight || FALLBACK_EDGE })
            }}
            onError={() => { setPicture('failed') }}
          />
        )}
        {animation === undefined && typeof picture === 'object' && picture.kind === 'bitmap' && (
          <canvas ref={drawBitmap} className={pictureClass} style={box} width={picture.bitmap.width} height={picture.bitmap.height} />
        )}
        {animation !== undefined && frameSize !== undefined && (
          <canvas
            ref={frameCanvas}
            className={clsx(pictureClass, css.frame)}
            style={box}
            width={frameSize.width}
            height={frameSize.height}
          />
        )}
        {shownGrid.length > 0 && imageSize !== undefined && box !== undefined && (
          <svg className={css.grid} style={box} viewBox={`0 0 ${String(imageSize.width)} ${String(imageSize.height)}`} preserveAspectRatio="none" aria-hidden="true">
            {shownGrid.map(cell => (
              <rect key={`${String(cell.x)},${String(cell.y)}`} x={cell.x} y={cell.y} width={cell.width} height={cell.height} />
            ))}
          </svg>
        )}
      </div>
      {animation !== undefined && (
        <div className={css.timeline}>
          <Tooltip label={playing ? t('image.pause') : t('image.play')} side="top" delayMs={500}>
            <button type="button" className={css.tool} aria-label={playing ? t('image.pause') : t('image.play')} disabled={animation.frames.length < 2}
              onClick={() => {
                if (!playing && !animation.loop && frame >= animation.frames.length - 1) setFrame(0)
                setPlaying(!playing)
              }}>
              {playing ? <IconPauseOutlineRegular size={14} /> : <IconPlayOutlineRegular size={14} />}
            </button>
          </Tooltip>
          <input
            className={css.scrubber}
            type="range"
            min={0}
            max={Math.max(0, animation.frames.length - 1)}
            step={1}
            value={Math.min(frame, animation.frames.length - 1)}
            aria-label={t('image.seek')}
            onChange={(event) => {
              setPlaying(false)
              setFrame(Number(event.currentTarget.value))
            }}
          />
          <span className={css.counter}>{t('image.frame', { number: Math.min(frame, animation.frames.length - 1) + 1, count: animation.frames.length })}</span>
          <Menu
            open={speedOpen}
            side="top"
            align="end"
            portal
            compact
            anchor={(
              <button type="button" className={css.menuButton} aria-label={t('model.speed')} aria-haspopup="menu" aria-expanded={speedOpen}
                onClick={() => { setSpeedOpen(open => !open) }}>
                <span className={css.menuLabel}>{t('model.speedValue', { speed: String(speed) })}</span>
                <IconChevronDownOutlineRegular size={12} />
              </button>
            )}
            items={SPEEDS.map(value => ({ id: String(value), label: t('model.speedValue', { speed: String(value) }) }))}
            selectedId={String(speed)}
            onClose={() => { setSpeedOpen(false) }}
            onSelect={(id) => {
              setSpeedOpen(false)
              setSpeed(Number(id))
            }}
          />
        </div>
      )}
      {gridOpen && (
        <div className={css.gridBar} role="group" aria-label={t('image.grid.title')}>
          <span className={css.gridTitle}>{t('image.grid.title')}</span>
          {(['columns', 'rows', 'count'] as const).map(field => (
            <label key={field} className={css.gridField}>
              <span>{t(`image.grid.${field}`)}</span>
              <input
                type="number"
                min={1}
                max={field === 'count' ? (grid?.columns ?? 1) * (grid?.rows ?? 1) : MAX_GRID}
                value={field === 'count' ? grid?.count ?? (grid?.columns ?? 1) * (grid?.rows ?? 1) : grid?.[field] ?? 1}
                onChange={(event) => { setGridField(field, Number(event.currentTarget.value)) }}
              />
            </label>
          ))}
          <Tooltip label={t('image.grid.play')} side="top" delayMs={500}>
            <button type="button" className={css.tool} aria-label={t('image.grid.play')} disabled={grid === undefined}
              onClick={() => { choose('grid') }}>
              <IconPlayOutlineRegular size={14} />
            </button>
          </Tooltip>
          <Tooltip label={t('image.grid.close')} side="top" delayMs={500}>
            <button type="button" className={css.tool} aria-label={t('image.grid.close')}
              onClick={() => {
                setGridOpen(false)
                if (active === 'grid') choose(undefined)
                setGrid(undefined)
              }}>
              <IconCloseOutlineRegular size={14} />
            </button>
          </Tooltip>
        </div>
      )}
      <div className={css.bar}>
        <span className={css.info} title={asset.path}>
          {info.map(([key, text]) => <span key={key} className={css.infoItem}>{text}</span>)}
        </span>
        {sprite !== undefined && (
          <Menu
            open={menuOpen}
            side="top"
            align="end"
            portal
            compact
            anchor={(
              <button type="button" className={css.menuButton} aria-label={t('image.animation')} aria-haspopup="menu" aria-expanded={menuOpen}
                title={active ?? t('image.still')} onClick={() => { setMenuOpen(open => !open) }}>
                <span className={css.menuLabel}>{active ?? t('image.still')}</span>
                <IconChevronDownOutlineRegular size={12} />
              </button>
            )}
            items={[
              { id: STILL_ITEM, label: t('image.still') },
              ...animations.length === 0 ? [] : [{ type: 'separator' as const, id: 'animations' }],
              ...animations.map(candidate => ({ id: candidate.name, label: candidate.name })),
              { type: 'separator' as const, id: 'grid-separator' },
              { id: GRID_ITEM, label: t('image.grid.open') },
            ]}
            selectedId={active ?? STILL_ITEM}
            onClose={() => { setMenuOpen(false) }}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === GRID_ITEM) openGrid()
              else choose(id === STILL_ITEM ? undefined : id)
            }}
          />
        )}
        <Tooltip label={t('image.zoomOut')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('image.zoomOut')} disabled={scale <= MIN_ZOOM}
            onClick={() => { zoomAt({ x: 0, y: 0 }, from => from / ZOOM_STEP) }}>
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
        </Tooltip>
        <Tooltip label={view.zoom === 'fit' ? t('image.actual') : t('image.fit')} side="top" delayMs={500}>
          <button type="button" className={css.percent} aria-label={view.zoom === 'fit' ? t('image.actual') : t('image.fit')}
            onClick={() => { if (view.zoom === 'fit') actual(); else fit() }}>
            {percent}
          </button>
        </Tooltip>
        <Tooltip label={t('image.zoomIn')} side="top" delayMs={500}>
          <button type="button" className={css.tool} aria-label={t('image.zoomIn')} disabled={scale >= MAX_ZOOM}
            onClick={() => { zoomAt({ x: 0, y: 0 }, from => from * ZOOM_STEP) }}>
            <IconPlusOutlineRegular size={14} />
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
        <DetailsPanel details={details} t={t} playing={active} onPlay={(name) => { choose(name) }} />
      )}
    </div>
  )
}
