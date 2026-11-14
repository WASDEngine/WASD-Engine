// @vitest-environment jsdom
/**
 * The 3D view over a stand-in for its three.js chunk: the size it shows is the rest pose's, as the agent's details give
 * it, also after a clip poses the model and its textures settle; a model that asks for too much memory shows a notice;
 * and the stage stops drawing while the view is off screen and draws again when it shows.
 */
import type { ModelAssetDetails } from '@deepseek-ai/dsh-game-assets/types'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatOf } from '../src/client/formats.ts'
import { ModelView, type ModelViewProps } from '../src/client/ModelView.tsx'

/** A stand-in for the stage: it records what the view asks of it, and whether a clip poses the model. */
class FakeStage {
  posed = false
  readonly visible: boolean[] = []
  show(): void {}
  setShading(): void {}
  setSkeleton(): void {}
  setPlaying(): void {}
  setClip(index: number | undefined): void { this.posed = index !== undefined }
  setVisible(visible: boolean): void { this.visible.push(visible) }
  resize(): void {}
  requestRender(): void {}
  clock(): undefined { return undefined }
  onClock(): () => void { return () => {} }
  selectBone(): void {}
  setMorph(): void {}
  resetView(): void {}
  seek(): void {}
  setSpeed(): void {}
  dispose(): void {}
}

const viewer = vi.hoisted(() => ({
  stages: [] as unknown[],
  settled: Promise.withResolvers<undefined>(),
  tooLarge: false,
}))

vi.mock('../src/client/viewer/index.ts', () => {
  class ModelTooLargeError extends Error {}
  /** Details whose bounds show whether the stage's clip posed the model when it was measured. */
  const describeModel = (): ModelAssetDetails => {
    const posed = (viewer.stages.at(-1) as FakeStage | undefined)?.posed === true
    return {
      kind: 'model', format: 'GLB', bytes: 3, min: [0, 0, 0], max: posed ? [9, 9, 9] : [1, 2, 1], triangles: 2, vertices: 4, meshes: 1, nodes: 2,
      materials: [], materialCount: 0, textures: [], textureCount: 0, bones: [], boneCount: 0,
      animations: [{ name: 'Wave', seconds: 1, tracks: 1, targets: ['Arm'], targetCount: 1 }], morphTargets: [], missing: [],
    }
  }
  return {
    ModelTooLargeError,
    ModelStage: class extends FakeStage {
      constructor() {
        super()
        viewer.stages.push(this)
      }
    },
    loadModel: async () => {
      if (viewer.tooLarge) throw new ModelTooLargeError('too large')
      return { root: {}, animations: [{ name: 'Wave', duration: 1 }], stats: { triangles: 2, vertices: 4 }, missing: [], settled: viewer.settled.promise, textureName: () => '', dispose: () => {} }
    },
    describeModel,
    morphTargetsOf: () => [],
  }
})

const t = ((key: string, params?: Readonly<Record<string, unknown>>) => (params === undefined ? key : `${key} ${JSON.stringify(params)}`)) as ModelViewProps['t']

function props(overrides: Partial<ModelViewProps> = {}): ModelViewProps {
  const format = formatOf('robot.glb')
  if (format === undefined) throw new Error('no format')
  return {
    asset: { path: 'models/robot.glb', name: 'robot.glb', folder: 'models', format },
    file: { data: new Uint8Array([1, 2, 3]), absolutePath: '/p/models/robot.glb', version: 'v1' },
    relatedUrl: () => undefined,
    maxBytes: 1024,
    maxDecodedPixels: 8192 * 8192,
    visible: true,
    t,
    ...overrides,
  }
}

beforeEach(() => {
  viewer.stages.length = 0
  viewer.settled = Promise.withResolvers<undefined>()
  viewer.tooLarge = false
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ModelView', () => {
  it('shows the size of the rest pose while a clip plays, also after the model\'s textures settle', async () => {
    render(<ModelView {...props()} />)
    const details = await screen.findByRole('button', { name: 'details.title' })
    await waitFor(() => { expect(details.hasAttribute('disabled')).toBe(false) })
    fireEvent.click(details)
    // The first clip plays, which poses the model, and the size stays the rest pose's.
    expect((viewer.stages[0] as FakeStage).posed).toBe(true)
    expect(screen.getByText('1 × 2 × 1')).toBeTruthy()
    await act(async () => {
      viewer.settled.resolve(undefined)
      await viewer.settled.promise
    })
    expect(screen.getByText('1 × 2 × 1')).toBeTruthy()
    expect(screen.queryByText('9 × 9 × 9')).toBeNull()
  })

  it('stops drawing while the view is off screen, and draws again when it shows', async () => {
    const view = render(<ModelView {...props()} />)
    await waitFor(() => { expect(viewer.stages).toHaveLength(1) })
    const stage = viewer.stages[0] as FakeStage
    await waitFor(() => { expect(stage.visible).toEqual([true]) })
    view.rerender(<ModelView {...props({ visible: false })} />)
    view.rerender(<ModelView {...props({ visible: true })} />)
    expect(stage.visible).toEqual([true, false, true])
  })

  it('shows a notice for a model that asks for more memory than the viewer sets aside', async () => {
    viewer.tooLarge = true
    render(<ModelView {...props()} />)
    expect((await screen.findByRole('alert')).textContent).toBe('viewer.modelTooLarge {"limit":"1.0KB"}')
  })
})
