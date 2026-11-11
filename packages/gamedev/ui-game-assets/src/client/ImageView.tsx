/**
 * The 2D view: the image on a checkerboard that shows transparency, fitted to the stage until the reader zooms. The
 * wheel and pinch zoom around the pointer, dragging pans, a double click switches between the fitted view and actual
 * size, and pixels stay sharp from twice the actual size. Images the browser decodes show from their bytes; TGA, HDR,
 * and EXR images are decoded by three.js, high dynamic range ones tone mapped for the screen.
 */
import clsx from 'clsx'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { fileSizeText, IconPlusOutlineRegular, StateDot, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { AssetFile } from './read.ts'
import type { AssetEntry } from './scan.ts'
import css from './ImageView.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** What the 2D view draws. */
export interface ImageViewProps {
  /** The image asset. */
  readonly asset: AssetEntry
  /** Its bytes. */
  readonly file: AssetFile
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

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * Show one image.
 * @param props - the asset, its bytes, and copy.
 * @returns the zoomable picture over its info and zoom bar.
 */
export function ImageView({ asset, file, t }: ImageViewProps): ReactNode {
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

  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Size>()
  useEffect(() => {
    const element = viewportRef.current
    if (element === null) return
    const measure = (): void => {
      const box = element.getBoundingClientRect()
      setViewport(current => current?.width === box.width && current.height === box.height
        ? current
        : { width: box.width, height: box.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  // The zoom, `fit` or a scale, and the pan offset from the centered position, updated together from the latest state.
  const [view, setView] = useState<{ readonly zoom: 'fit' | number; readonly x: number; readonly y: number }>({ zoom: 'fit', x: 0, y: 0 })
  const fitScale = natural === undefined || viewport === undefined
    ? 1
    : clampZoom(Math.min(
      Math.max(1, viewport.width - 2 * FIT_MARGIN) / natural.width,
      Math.max(1, viewport.height - 2 * FIT_MARGIN) / natural.height,
    ))
  const fitRef = useRef(fitScale)
  useLayoutEffect(() => { fitRef.current = fitScale }, [fitScale])
  const scale = view.zoom === 'fit' ? fitScale : view.zoom

  // Zoom so the image point under `point`, relative to the stage's center, stays under it.
  const zoomAt = useCallback((point: { readonly x: number; readonly y: number }, next: (scale: number) => number): void => {
    setView((current) => {
      const from = current.zoom === 'fit' ? fitRef.current : current.zoom
      const target = clampZoom(next(from))
      return { zoom: target, x: point.x - (point.x - current.x) * target / from, y: point.y - (point.y - current.y) * target / from }
    })
  }, [])
  const fit = (): void => { setView({ zoom: 'fit', x: 0, y: 0 }) }
  const actual = (): void => { setView({ zoom: 1, x: 0, y: 0 }) }
  // Panning leaves the fitted view at its scale.
  const pan = (move: (current: { readonly x: number; readonly y: number }) => { readonly x: number; readonly y: number }): void => {
    setView(current => ({ zoom: current.zoom === 'fit' ? fitRef.current : current.zoom, ...move(current) }))
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
    const by = (x: number, y: number): void => { pan(current => ({ x: current.x + x, y: current.y + y })) }
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

  const shown = natural ?? { width: 0, height: 0 }
  const box: CSSProperties | undefined = natural === undefined || viewport === undefined ? undefined : {
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
        {typeof picture === 'object' && picture.kind === 'url' && (
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
        {typeof picture === 'object' && picture.kind === 'bitmap' && (
          <canvas ref={drawBitmap} className={pictureClass} style={box} width={picture.bitmap.width} height={picture.bitmap.height} />
        )}
      </div>
      <div className={css.bar}>
        <span className={css.info} title={asset.path}>
          {info.map(([key, text]) => <span key={key} className={css.infoItem}>{text}</span>)}
        </span>
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
      </div>
    </div>
  )
}
