/**
 * The 2D view: the image on a checkerboard that shows transparency, fitted to the stage until the reader zooms. The
 * wheel and pinch zoom around the pointer, dragging pans, a double click switches between the fitted view and actual
 * size, and pixels stay sharp from twice the actual size. Images the browser decodes show from their bytes; TGA, HDR,
 * and EXR images are decoded by three.js, high dynamic range ones tone mapped for the screen. An image whose header
 * states more pixels than the viewer decodes shows a notice instead. The Animation menu plays the 2D animations the
 * image plays or takes part in, frame by frame with a timeline and a speed, each frame once its picture is decoded and
 * only while the view is on screen, and its Sprite grid reads the image as a sheet of the columns and rows the reader
 * gives, drawn over it. The details list the image's size, transparency, colors, and animations.
 */
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  fileSizeText, IconChevronDownOutlineRegular, IconCloseOutlineRegular, IconPauseOutlineRegular,
  IconPlayOutlineRegular, IconPlusOutlineRegular, Menu, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { AssetGrid } from '@deepseek-ai/dsh-game-assets/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { AnimationSources } from './animations2d.ts'
import { DetailsPanel, useDetailsSwitch } from './DetailsPanel.tsx'
import type { NS } from './locales.ts'
import type { AssetFile } from './read.ts'
import type { AssetEntry } from './scan.ts'
import type { ViewRequest } from './source.ts'
import { FALLBACK_EDGE } from './picture.ts'
import { SpritePlayer, type SpriteState } from './sprite-player.ts'
import { gridAnimation, gridRegions, stripGuess, type SpriteAnimation } from './sprites.ts'
import { MAX_ZOOM, MIN_ZOOM, useZoomPan, ZOOM_STEP, type Size } from './zoom-pan.ts'
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
  /**
   * Told, once the image's animations are found, when they lack the one an agent asked for.
   * @param request - the ask's `request`.
   */
  readonly onMissingAnimation?: ((request: number) => void) | undefined
  /** The most pixels the viewer decodes for one image; a larger image shows a notice. */
  readonly maxDecodedPixels: number
  /** Whether the view is on screen; a hidden view's animation waits where it stands. */
  readonly visible: boolean
  readonly t: Translate
}

/** The shown image's picture: a Blob URL the browser decodes, a bitmap three.js decoded, or why there is none. */
type Shown =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'bitmap'; readonly bitmap: CanvasImageSource; readonly width: number; readonly height: number }
  | { readonly kind: 'tooLarge'; readonly width: number; readonly height: number }
  | { readonly kind: 'failed' }

/** From this scale up, pixels draw as squares. */
const PIXELATED_FROM = 2
/** Playback speeds the timeline offers. */
const SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const
/** Most columns or rows of a sprite grid. */
const MAX_GRID = 256
/** Id of the menu item that opens the sprite grid. */
const GRID_ITEM = '\u0000grid'
/** Id of the menu item that shows the still image. */
const STILL_ITEM = '\u0000still'

function clampCount(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_GRID, Math.max(1, Math.round(value))) : 1
}

/**
 * Show one image.
 * @param props - the asset, its bytes, the reads for its animations, the animation an agent asked for, and copy.
 * @returns the zoomable picture over its timeline, sprite grid, info and zoom bar, and details.
 */
export function ImageView({
  asset, file, animations: sources, read, requested, onMissingAnimation, maxDecodedPixels, visible, t,
}: ImageViewProps): ReactNode {
  const format = asset.format
  const [picture, setPicture] = useState<Shown>()
  const [natural, setNatural] = useState<Size>()
  // The player decodes the image once, from the URL the image element shows, and finds its animations.
  const [player, setPlayer] = useState<SpritePlayer>()
  const [sprite, setSprite] = useState<SpriteState>()
  useEffect(() => {
    if (format.kind !== 'image') return
    const created = new SpritePlayer(
      asset.path, format, file.data, read ?? (() => Promise.reject(new Error('no reads'))), () => import('./viewer/index.ts'), maxDecodedPixels,
    )
    const controller = new AbortController()
    setPlayer(created)
    setSprite(undefined)
    setNatural(undefined)
    if (created.tooLarge !== undefined) {
      setPicture({ kind: 'tooLarge', ...created.tooLarge })
    } else if (created.url !== undefined) {
      setPicture({ kind: 'url', url: created.url })
    } else {
      setPicture(undefined)
      void created.picture().then((decoded) => {
        if (controller.signal.aborted) return
        setNatural({ width: decoded.width, height: decoded.height })
        setPicture({ kind: 'bitmap', bitmap: decoded.source, width: decoded.width, height: decoded.height })
      }, () => {
        if (!controller.signal.aborted) setPicture({ kind: 'failed' })
      })
    }
    if (created.tooLarge === undefined) {
      void created.load(sources, controller.signal).then((state) => {
        if (state !== undefined && !controller.signal.aborted) setSprite(state)
      }, () => {
        // Error: an image the player cannot decode shows without animations, as the view shows it.
      })
    }
    return () => {
      controller.abort()
      created.close()
    }
  }, [asset.path, file, format, read, sources, maxDecodedPixels])

  const [grid, setGrid] = useState<AssetGrid>()
  const [gridOpen, setGridOpen] = useState(false)
  const [active, setActive] = useState<string>()
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [menuOpen, setMenuOpen] = useState(false)
  const [speedOpen, setSpeedOpen] = useState(false)
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
  const shownFrame = animation === undefined ? 0 : Math.min(frame, animation.frames.length - 1)
  const current = animation?.frames[shownFrame]
  // The current frame's picture: playback moves on only once it is decoded, or once it failed.
  const currentState = current === undefined || player === undefined ? undefined : player.frame(current)
  const settled = currentState !== undefined && currentState.kind !== 'pending'

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
    if (wanted !== undefined && match === undefined) {
      onMissingAnimation?.(requested.request)
      return
    }
    handled.current = requested.request
    if (match === undefined) return
    setActive(match.name)
    setFrame(0)
    setPlaying(true)
  }, [requested, sprite, animations, grid, onMissingAnimation])

  // Playback: each frame shows for its duration at the chosen speed once its picture is decoded, while the view is on
  // screen; a looping animation starts over.
  useEffect(() => {
    if (animation === undefined || !playing || !visible || !settled || animation.frames.length < 2 || current === undefined) return
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
  }, [animation, playing, visible, settled, current, speed])

  // A frame's picture, one of the image's own frames or another image, decodes when the frame comes up, and the next
  // frame's while it shows; the canvas draws a frame once its picture is ready.
  useEffect(() => {
    if (animation === undefined || current === undefined || player === undefined) return
    let live = true
    if (player.frame(current).kind === 'pending') {
      void player.request(current).then(() => {
        if (live) setDrawn(count => count + 1)
      })
    }
    const following = animation.frames[(shownFrame + 1) % animation.frames.length]
    if (following !== undefined && visible) void player.request(following)
    return () => { live = false }
  }, [animation, current, shownFrame, player, visible])

  const currentPicture = currentState?.kind === 'ready' ? currentState.picture : undefined
  const frameSize = current === undefined ? undefined : current.region ?? (currentPicture ?? imageSize)
  const shownSize = animation === undefined ? natural : frameSize ?? natural

  const {
    viewportRef, view, scale, box, dragging, zoomAt, fit, actual, centered, onPointerDown, onPointerMove, endDrag, onKeyDown,
  } = useZoomPan(shownSize, active)

  const drawBitmap = useCallback((canvas: HTMLCanvasElement | null): void => {
    if (canvas === null || picture?.kind !== 'bitmap') return
    canvas.getContext('2d')?.drawImage(picture.bitmap, 0, 0)
  }, [picture])

  // The current frame, drawn at its own size once its picture is ready; the zoom scales the canvas.
  const frameCanvas = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const canvas = frameCanvas.current
    if (canvas === null || current === undefined || player === undefined) return
    const context = canvas.getContext('2d')
    if (context === null) return
    context.clearRect(0, 0, canvas.width, canvas.height)
    const state = player.frame(current)
    if (state.kind !== 'ready') return
    const source = state.picture
    const region = current.region ?? { x: 0, y: 0, width: source.width, height: source.height }
    context.imageSmoothingEnabled = false
    context.drawImage(source.source, region.x, region.y, region.width, region.height, 0, 0, canvas.width, canvas.height)
  })

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
  const detailsSwitch = useDetailsSwitch(details !== undefined, css.tool, t)
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
        {picture?.kind === 'failed' && <div className={css.status} role="alert">{t('viewer.unreadable')}</div>}
        {picture?.kind === 'tooLarge' && (
          <div className={css.status} role="alert">{t('viewer.imageTooLarge', { width: picture.width, height: picture.height })}</div>
        )}
        {animation === undefined && picture?.kind === 'url' && (
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
            onError={() => { setPicture({ kind: 'failed' }) }}
          />
        )}
        {animation === undefined && picture?.kind === 'bitmap' && (
          <canvas ref={drawBitmap} className={pictureClass} style={box} width={picture.width} height={picture.height} />
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
        {detailsSwitch.button}
      </div>
      {detailsSwitch.shown && details !== undefined && (
        <DetailsPanel details={details} t={t} playing={active} onPlay={(name) => { choose(name) }} />
      )}
    </div>
  )
}
