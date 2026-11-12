/**
 * Pictures of a model for an agent, drawn off screen with the Assets tab's lighting, grid, and skeleton overlay: one
 * tile per view and pose. `iso` looks from the front right and above through a perspective camera; the axis views
 * look straight at a side through an orthographic camera, so proportions can be measured: `front` at the model's +Z
 * side, `back` at -Z, `right` from +X, `left` from -X, `top` down from +Y, and `bottom` up from -Y. Poses across a
 * clip share one framing, so the motion shows. The model stays the caller's; this module only adds it to its scene.
 */
import {
  AnimationMixer, Box3, OrthographicCamera, PerspectiveCamera, Scene, Vector3, WebGLRenderer, type Camera,
} from 'three'
import type { AssetShading, AssetViewDirection } from '@deepseek-ai/dsh-game-assets/types'
import { applyWireframe, clayMaterial, disposeHelper, gridFor, lightScene, SkeletonOverlay, type LoadedModel } from './model.ts'

/** Background of a tile. */
const TILE_BACKGROUND = 0x2b2e33

/** Where each view's camera sits relative to the model's center, and which way is up in the picture. */
/** A camera's direction from the model's center and the picture's up direction. */
interface ViewCamera {
  readonly direction: readonly [number, number, number]
  readonly up: readonly [number, number, number]
}

const VIEW_CAMERAS: Readonly<Record<AssetViewDirection, ViewCamera>> = {
  iso: { direction: [0.9, 0.55, 1.3], up: [0, 1, 0] },
  front: { direction: [0, 0, 1], up: [0, 1, 0] },
  back: { direction: [0, 0, -1], up: [0, 1, 0] },
  right: { direction: [1, 0, 0], up: [0, 1, 0] },
  left: { direction: [-1, 0, 0], up: [0, 1, 0] },
  top: { direction: [0, 1, 0], up: [0, 0, -1] },
  bottom: { direction: [0, -1, 0], up: [0, 0, 1] },
}

/** What to draw of a model. */
export interface ModelTilePlan {
  readonly views: readonly AssetViewDirection[]
  readonly shading: AssetShading
  readonly skeleton: boolean
  /** Index of the clip to pose the model with; the loaded pose without one. */
  readonly clip?: number
  /** Seconds into the clip of each pose; one pose without a clip. */
  readonly times?: readonly number[]
  readonly tileWidth: number
  readonly tileHeight: number
}

/** One drawn tile. */
export interface ModelTile {
  /** The picture, a 2D canvas the caller may draw from. */
  readonly canvas: HTMLCanvasElement
  readonly view: AssetViewDirection
  /** Seconds into the clip, for a posed tile. */
  readonly time?: number
}

function cameraFor(view: AssetViewDirection, bounds: Box3, aspect: number): Camera {
  const { direction, up } = VIEW_CAMERAS[view]
  const center = bounds.getCenter(new Vector3())
  const size = bounds.getSize(new Vector3())
  const radius = Math.max(size.length() / 2, 1e-3)
  const toward = new Vector3(...direction).normalize()
  if (view === 'iso') {
    const camera = new PerspectiveCamera(35, aspect, radius / 500, radius * 100)
    const vertical = (camera.fov * Math.PI) / 360
    const horizontal = Math.atan(Math.tan(vertical) * aspect)
    const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.08
    camera.position.copy(center).addScaledVector(toward, distance)
    camera.up.set(...up)
    camera.lookAt(center)
    return camera
  }
  // The side the camera faces: its width and height in the model's units.
  const [width, height] = view === 'front' || view === 'back' ? [size.x, size.y] : view === 'left' || view === 'right' ? [size.z, size.y] : [size.x, size.z]
  const halfHeight = Math.max(height / 2, width / 2 / aspect, 1e-3) * 1.12
  const halfWidth = halfHeight * aspect
  const camera = new OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, radius / 100, radius * 8)
  camera.position.copy(center).addScaledVector(toward, radius * 3)
  camera.up.set(...up)
  camera.lookAt(center)
  return camera
}

/**
 * Draw tiles of a model off screen.
 * @param model - the loaded model; it leaves this function in its loaded pose and shading, out of any scene.
 * @param plan - views, shading, skeleton, poses, and the tile size.
 * @returns the tiles: each pose's views in order, poses in time order.
 * @throws {Error} when the browser cannot create a WebGL context.
 */
export function renderModelTiles(model: LoadedModel, plan: ModelTilePlan): ModelTile[] {
  const canvas = document.createElement('canvas')
  canvas.width = plan.tileWidth
  canvas.height = plan.tileHeight
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true })
  const scene = new Scene()
  const clay = clayMaterial()
  const environment = lightScene(renderer, scene)
  const mixer = plan.clip === undefined ? undefined : new AnimationMixer(model.root)
  const clip = plan.clip === undefined ? undefined : model.animations[plan.clip]
  const action = clip === undefined ? undefined : mixer?.clipAction(clip)
  let skeleton: SkeletonOverlay | undefined
  const tiles: ModelTile[] = []
  try {
    renderer.setPixelRatio(1)
    renderer.setSize(plan.tileWidth, plan.tileHeight, false)
    renderer.setClearColor(TILE_BACKGROUND, 1)
    scene.add(model.root)
    if (plan.shading === 'wireframe') applyWireframe(model.root, true)
    if (plan.shading === 'solid') scene.overrideMaterial = clay
    action?.play()
    const times = clip === undefined || plan.times === undefined || plan.times.length === 0 ? [undefined] : plan.times
    const pose = (time: number | undefined): void => {
      if (time !== undefined && action !== undefined) {
        action.time = Math.min(Math.max(0, time), clip?.duration ?? 0)
        mixer?.update(0)
      }
      model.root.updateMatrixWorld(true)
    }
    // One framing for every pose, so the motion shows against a still grid.
    const bounds = new Box3()
    for (const time of times) {
      pose(time)
      bounds.union(new Box3().setFromObject(model.root, true))
    }
    if (bounds.isEmpty()) bounds.set(new Vector3(-0.5, -0.5, -0.5), new Vector3(0.5, 0.5, 0.5))
    const grid = gridFor(bounds)
    scene.add(grid)
    if (plan.skeleton) {
      skeleton = new SkeletonOverlay(model.root, Math.max(4, Math.round(plan.tileHeight / 90)))
      scene.add(skeleton.object)
    }
    const aspect = plan.tileWidth / plan.tileHeight
    for (const time of times) {
      pose(time)
      skeleton?.update()
      for (const view of plan.views) {
        renderer.render(scene, cameraFor(view, bounds, aspect))
        const tile = document.createElement('canvas')
        tile.width = plan.tileWidth
        tile.height = plan.tileHeight
        tile.getContext('2d')?.drawImage(canvas, 0, 0)
        tiles.push(time === undefined ? { canvas: tile, view } : { canvas: tile, view, time })
      }
    }
    scene.remove(grid)
    disposeHelper(grid)
  } finally {
    action?.stop()
    mixer?.stopAllAction()
    mixer?.uncacheRoot(model.root)
    if (plan.shading === 'wireframe') applyWireframe(model.root, false)
    if (skeleton !== undefined) {
      scene.remove(skeleton.object)
      skeleton.dispose()
    }
    scene.remove(model.root)
    scene.overrideMaterial = null
    clay.dispose()
    environment.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
  }
  return tiles
}
