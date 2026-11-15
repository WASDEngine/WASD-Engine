/**
 * Planning a MagicaVoxel file before three.js meshes it: the cells its meshes sweep, a model placed several times counted
 * once for each placement, the memory its exposed faces take, and the refusals of a model larger than MagicaVoxel makes
 * and of a scene that places more cells than one such model holds, each found without allocating the meshes.
 */
import { describe, expect, it } from 'vitest'
import { VOX_MAX_CELLS, VOX_MAX_SIDE, VOX_QUAD_BYTES, voxPlan, VoxModelTooLargeError, VoxWorkTooLargeError } from '../src/client/viewer/vox.ts'
import { voxFile } from './model-files.client.ts'

describe('voxPlan', () => {
  it('counts each model\'s cells and a quad for each face of its voxels that borders no other voxel', () => {
    // Two voxels side by side in a 2 × 2 × 2 box: ten faces show.
    const plan = voxPlan(voxFile([{ x: 2, y: 2, z: 2, voxels: [[0, 0, 0, 1], [1, 0, 0, 1]] }]))
    expect(plan).toEqual({ cells: 8, bytes: 8 + 10 * VOX_QUAD_BYTES, hasScene: false })
    // A voxel outside its box lands where the mesher puts it, or nowhere.
    expect(voxPlan(voxFile([{ x: 1, y: 1, z: 1, voxels: [[5, 5, 5, 1]] }])).bytes).toBe(1)
  })

  it('counts a model once for each placement the scene graph makes, as the loader meshes it', () => {
    const model = { x: 4, y: 4, z: 4, voxels: [[0, 0, 0, 1]] as const }
    // A group of two transforms over the same shape, and a third through a transform over a group.
    const nodes = [
      { type: 'group', id: 0, children: [1, 2, 3] },
      { type: 'transform', id: 1, child: 10 },
      { type: 'transform', id: 2, child: 10 },
      { type: 'transform', id: 3, child: 4 },
      { type: 'group', id: 4, children: [10] },
      { type: 'shape', id: 10, models: [0] },
    ] as const
    const plan = voxPlan(voxFile([model], nodes))
    expect(plan).toEqual({ cells: 3 * 64, bytes: 3 * (64 + 6 * VOX_QUAD_BYTES), hasScene: true })
  })

  it('refuses a model larger than MagicaVoxel makes from its size alone, before anything is allocated', () => {
    // About 150 bytes that state 1024 × 1024 × 1024 voxels.
    const file = voxFile([{ x: 1024, y: 1024, z: 1024 }])
    expect(file.byteLength).toBeLessThan(200)
    const started = performance.now()
    expect(() => voxPlan(file)).toThrow(VoxModelTooLargeError)
    expect(performance.now() - started).toBeLessThan(100)
    try {
      voxPlan(file)
    } catch (error) {
      expect(error).toMatchObject({ size: { x: 1024, y: 1024, z: 1024 }, limit: VOX_MAX_SIDE })
    }
    // The largest model MagicaVoxel makes is read.
    expect(voxPlan(voxFile([{ x: 256, y: 256, z: 256 }])).cells).toBe(VOX_MAX_CELLS)
    // A model the scene does not place is not meshed, whatever its size.
    expect(voxPlan(voxFile([{ x: 2, y: 2, z: 2 }, { x: 4096, y: 1, z: 1 }], [{ type: 'shape', id: 0, models: [0] }])).cells).toBe(8)
  })

  it('refuses a scene that places more cells than one model of the largest size holds, however it places them', () => {
    // Three placements of a 200³ model.
    const placed = voxFile([{ x: 200, y: 200, z: 200 }], [
      { type: 'group', id: 0, children: [1, 1, 1] },
      { type: 'shape', id: 1, models: [0] },
    ])
    expect(() => voxPlan(placed)).toThrow(VoxWorkTooLargeError)
    // Sixty levels of groups that each place the next level twice: 2⁶⁰ placements of one voxel, planned at once.
    const levels = 60
    const doubling = voxFile([{ x: 1, y: 1, z: 1, voxels: [[0, 0, 0, 1]] }], [
      ...Array.from({ length: levels }, (_, level) => ({ type: 'group' as const, id: level, children: [level + 1, level + 1] })),
      { type: 'shape', id: levels, models: [0] },
    ])
    const started = performance.now()
    expect(() => voxPlan(doubling)).toThrow(VoxWorkTooLargeError)
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('fails where the loader fails: no VOX header, a graph that leads back into itself, a node or model that is missing', () => {
    expect(() => voxPlan(new TextEncoder().encode('not a vox file'))).toThrow('not a VOX file')
    expect(() => voxPlan(voxFile([{ x: 1, y: 1, z: 1 }], [{ type: 'group', id: 0, children: [1] }, { type: 'group', id: 1, children: [0] }]))).toThrow('leads back into itself')
    expect(() => voxPlan(voxFile([{ x: 1, y: 1, z: 1 }], [{ type: 'group', id: 0, children: [7] }]))).toThrow('node 7')
    expect(() => voxPlan(voxFile([{ x: 1, y: 1, z: 1 }], [{ type: 'shape', id: 0, models: [3] }]))).toThrow('model 3')
    const cut = voxFile([{ x: 1, y: 1, z: 1, voxels: [[0, 0, 0, 1]] }])
    expect(() => voxPlan(cut.subarray(0, cut.byteLength - 2))).toThrow(RangeError)
  })
})
