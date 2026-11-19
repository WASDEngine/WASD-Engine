/**
 * The zoom and pan of a picture on a stage: the picture shows fitted until the reader zooms, with the wheel or a pinch
 * around the pointer, or with the keys; dragging and the arrow keys pan, `0` fits, and `1` shows the actual size.
 */
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject,
} from 'react'

/** A width and height in pixels. */
export interface Size {
  readonly width: number
  readonly height: number
}

/** Space kept around a fitted image, in CSS pixels. */
const FIT_MARGIN = 16

/** Smallest zoom, as a scale factor. */
export const MIN_ZOOM = 0.01

/** Largest zoom, as a scale factor. */
export const MAX_ZOOM = 64

/** Scale factor of one zoom step from the buttons and keys. */
export const ZOOM_STEP = 1.5

/** Distance an arrow key pans, in CSS pixels. */
const PAN_STEP = 40

function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/** The zoom, `fit` or a scale, and the pan offset from the centered position. */
export interface ZoomView {
  readonly zoom: 'fit' | number
  readonly x: number
  readonly y: number
}

/** A picture's zoom and pan on its stage, and the stage's handlers. */
export interface ZoomPan {
  /** The stage element, whose size the fitted scale and the pointer positions use. */
  readonly viewportRef: RefObject<HTMLDivElement>
  /** The zoom and the pan offset. */
  readonly view: ZoomView
  /** The scale the picture shows at. */
  readonly scale: number
  /** The picture's place on the stage: its zoomed size and offset; undefined until the picture and stage sizes are known. */
  readonly box: CSSProperties | undefined
  /** Whether the reader is dragging the picture. */
  readonly dragging: boolean
  /** Zoom so that the picture point under a stage point, relative to the stage's center, stays under it. */
  readonly zoomAt: (point: { readonly x: number; readonly y: number }, next: (scale: number) => number) => void
  /** Show the picture fitted. */
  readonly fit: () => void
  /** Show the picture at its actual size. */
  readonly actual: () => void
  /** A client point relative to the stage's center. */
  readonly centered: (clientX: number, clientY: number) => { x: number; y: number }
  /** Starts a drag that pans the picture. */
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void
  /** Pans while the drag holds. */
  readonly onPointerMove: (event: PointerEvent<HTMLDivElement>) => void
  /** Ends the drag of the pointer that started it. */
  readonly endDrag: (event: PointerEvent<HTMLDivElement>) => void
  /** Zooms, fits, shows the actual size, or pans by the key. */
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
}

/**
 * Zoom and pan a picture on a stage.
 * @param shownSize - the picture's size, undefined until it is known.
 * @param active - what the stage shows, such as the playing animation; a change shows it fitted again.
 * @returns the zoom, the picture's place, and the stage's handlers.
 */
export function useZoomPan(shownSize: Size | undefined, active: unknown): ZoomPan {
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
  const [view, setView] = useState<ZoomView>({ zoom: 'fit', x: 0, y: 0 })
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
  const shown = shownSize ?? { width: 0, height: 0 }
  const box: CSSProperties | undefined = shownSize === undefined || viewport === undefined ? undefined : {
    width: `${String(shown.width * scale)}px`,
    height: `${String(shown.height * scale)}px`,
    transform: `translate(${String(viewport.width / 2 - shown.width * scale / 2 + view.x)}px, ${String(viewport.height / 2 - shown.height * scale / 2 + view.y)}px)`,
  }
  return { viewportRef, view, scale, box, dragging, zoomAt, fit, actual, centered, onPointerDown, onPointerMove, endDrag, onKeyDown }
}
