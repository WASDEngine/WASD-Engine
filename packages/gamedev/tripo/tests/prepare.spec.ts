/**
 * The changes made to each model Tripo makes before a tool saves it: the turn to face +Z, held by a node above the parts
 * of the scene or above a rig's skeleton, and the move of each clip over the spot where the model stands at rest; and the
 * GLB chunks they are read from and written to.
 */
import { describe, expect, it } from 'vitest'
import { parseGlb, readGlb, writeGlb } from '../src/glb.ts'
import { FRONT_NODE, prepareModel, TURN } from '../src/prepare.ts'
import { glbFile, RIG_NODES, riggedGlb, type RigClip } from './fixtures.ts'

/** The parts of a glTF document these specs read. */
type Document = {
  readonly nodes: ReadonlyArray<{
    readonly name?: string
    readonly children?: number[]
    readonly rotation?: number[]
    readonly matrix?: number[]
  }>
  readonly scenes: ReadonlyArray<{ readonly nodes: number[] }>
  readonly animations: ReadonlyArray<{
    readonly samplers: ReadonlyArray<{ readonly input: number; readonly output: number; readonly interpolation?: string }>
    readonly channels: ReadonlyArray<{ readonly sampler: number; readonly target: { readonly node: number; readonly path: string } }>
  }>
  readonly accessors: ReadonlyArray<{ readonly bufferView: number; readonly componentType: number }>
  readonly bufferViews: ReadonlyArray<{ readonly byteOffset?: number; readonly byteLength: number }>
  readonly buffers: ReadonlyArray<{ readonly byteLength: number }>
}

function item<T>(items: readonly T[] | undefined, index: number): T {
  const found = items?.[index]
  if (found === undefined) throw new Error(`no item ${index}`)
  return found
}

function documentOf(data: Uint8Array): { readonly gltf: Document; readonly bin: Uint8Array } {
  const glb = parseGlb(data)
  return { gltf: glb.gltf as Document, bin: glb.bin }
}

/** The values of the root joint's translation in one clip: the tightly packed floats the fixture or the change wrote. */
function rootTrack(data: Uint8Array, clip: number): number[] {
  const { gltf, bin } = documentOf(data)
  const animation = item(gltf.animations, clip)
  const channel = animation.channels.find(entry => entry.target.node === RIG_NODES.root && entry.target.path === 'translation')
  const sampler = item(animation.samplers, channel?.sampler ?? -1)
  const view = item(gltf.bufferViews, item(gltf.accessors, sampler.output).bufferView)
  const start = view.byteOffset ?? 0
  return Array.from(new Float32Array(bin.slice(start, start + view.byteLength).buffer))
}

/** Every key of a clip at the same value. */
function keys(count: number, value: readonly number[]): number[] {
  return Array.from({ length: count }, () => [...value]).flat().map(number => expect.closeTo(number, 6) as number)
}

/** A GLB file holding only a glTF document. */
function documentFile(gltf: Record<string, unknown>): Uint8Array {
  return writeGlb({ gltf: { asset: { version: '2.0' }, ...gltf }, bin: new Uint8Array(0) })
}

describe('the turn to face +Z', () => {
  it('takes +X, where Tripo\'s models face, to +Z', () => {
    const [x, y, z, w] = TURN
    // A quaternion turns v to v + 2w(q×v) + 2q×(q×v).
    const at = (vector: readonly number[], i: number): number => vector[i] ?? 0
    const cross = (a: readonly number[], b: readonly number[]): number[] => [
      at(a, 1) * at(b, 2) - at(a, 2) * at(b, 1), at(a, 2) * at(b, 0) - at(a, 0) * at(b, 2), at(a, 0) * at(b, 1) - at(a, 1) * at(b, 0),
    ]
    const turned = (v: readonly number[]): number[] => {
      const once = cross([x, y, z], v)
      const twice = cross([x, y, z], once)
      return v.map((value, i) => value + 2 * w * (once[i] ?? 0) + 2 * (twice[i] ?? 0))
    }
    expect(turned([1, 0, 0])).toEqual([0, 0, 1].map(value => expect.closeTo(value, 9) as number))
    expect(turned([0, 0, 1])).toEqual([-1, 0, 0].map(value => expect.closeTo(value, 9) as number))
  })

  it('puts a Front node above the scene\'s top node of a model without a rig', () => {
    const prepared = prepareModel(glbFile())
    expect(prepared).toMatchObject({ turned: true, centered: [] })
    const { gltf } = documentOf(prepared.data)
    expect(gltf.nodes).toEqual([{ name: 'Model', mesh: 0 }, { name: FRONT_NODE, rotation: [...TURN], children: [0] }])
    expect(gltf.scenes).toEqual([{ nodes: [1] }])
    expect(readGlb(prepared.data)).toEqual(readGlb(glbFile()))
  })

  it('puts the turn above a rig\'s skeleton and leaves its skinned mesh where it is', () => {
    const prepared = prepareModel(riggedGlb())
    expect(prepared).toMatchObject({ turned: true, centered: [] })
    const { gltf } = documentOf(prepared.data)
    expect(gltf.scenes).toEqual([{ nodes: [RIG_NODES.armature] }])
    expect(item(gltf.nodes, RIG_NODES.armature).children).toEqual([RIG_NODES.body, 5])
    expect(item(gltf.nodes, 5)).toEqual({ name: FRONT_NODE, rotation: [...TURN], children: [RIG_NODES.root] })
  })

  it('turns about the scene\'s origin under a parent that moves the skeleton', () => {
    const prepared = prepareModel(riggedGlb({ armature: { translation: [0.05, 0, 0] } }))
    const front = item(documentOf(prepared.data).gltf.nodes, 5)
    expect(front.rotation).toBeUndefined()
    expect(front.matrix).toEqual([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, -0.05, 0, 0.05, 1].map(value => expect.closeTo(value, 9) as number))
  })

  it('leaves the model as it is when its nodes do not form a forest, its scenes name no node, or a node above a skinned mesh shows a mesh of its own', () => {
    for (const file of [
      documentFile({ scenes: [{ nodes: [0] }], nodes: [{ children: [1] }, { children: [0] }] }),
      documentFile({ scenes: [{ nodes: [0] }], nodes: [{ children: [2] }, { children: [2] }, {}] }),
      documentFile({ scenes: [{ nodes: [0] }], nodes: [{ children: [7] }] }),
      documentFile({ scenes: [{ nodes: [0] }], nodes: ['not a node'] }),
      documentFile({ nodes: [{ mesh: 0 }] }),
      riggedGlb({ armature: { mesh: 0 } }),
    ]) {
      const prepared = prepareModel(file)
      expect(prepared).toEqual({ data: file, turned: false, centered: [] })
    }
  })

  it('leaves the turn out when a clip moves a node above the skeleton', () => {
    const file = riggedGlb({ clips: [{ name: 'idle', times: [0, 1], hips: [[0.3, 0, 0], [0.3, 0, 0]], movesArmature: true }] })
    expect(prepareModel(file)).toEqual({ data: file, turned: false, centered: [] })
  })
})

describe('the move of each clip over the spot where the model stands at rest', () => {
  it('centers the hips\' path of a clip that stays on the spot, on the root joint\'s translation in a clip of its own', () => {
    const run: RigClip = { name: 'run', times: [0, 0.5, 1], hips: [[0.4, 0, 0.1], [0.6, -0.05, 0.3], [0.4, 0, 0.1]] }
    const prepared = prepareModel(riggedGlb({ clips: [run] }))
    expect(prepared).toMatchObject({ turned: true, centered: ['run'] })
    expect(rootTrack(prepared.data, 0)).toEqual(keys(3, [-0.5, 0.5, -0.2]))
    const { gltf, bin } = documentOf(prepared.data)
    const clip = item(gltf.animations, 0)
    expect(clip.samplers).toHaveLength(3)
    expect(clip.channels[1]).toEqual({ sampler: 2, target: { node: RIG_NODES.root, path: 'translation' } })
    expect(clip.samplers[2]).toMatchObject({ input: clip.samplers[1]?.input, interpolation: 'STEP' })
    expect(item(gltf.buffers, 0).byteLength).toBe(bin.byteLength)
    expect(readGlb(prepared.data).animations).toEqual(['run'])
  })

  it('starts a clip that travels on the spot and keeps its path', () => {
    const walk: RigClip = { name: 'walk', times: [0, 1, 2], hips: [[0.1, 0, 0], [0.8, 0, 0], [1.5, 0, 0]] }
    expect(rootTrack(prepareModel(riggedGlb({ clips: [walk] })).data, 0)).toEqual(keys(3, [-0.1, 0.5, 0]))
  })

  it('moves the root joint in its parent\'s frame when the parent turns', () => {
    const idle: RigClip = { name: 'idle', times: [0, 1], hips: [[0.4, 0, 0], [0.4, 0, 0]] }
    const prepared = prepareModel(riggedGlb({ clips: [idle], armature: { rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] } }))
    expect(prepared).toMatchObject({ turned: true, centered: ['idle'] })
    expect(rootTrack(prepared.data, 0)).toEqual(keys(2, [-0.4, 0.5, 0]))
    expect(item(documentOf(prepared.data).gltf.nodes, 5)).toEqual({ name: FRONT_NODE, rotation: [...TURN], children: [RIG_NODES.root] })
  })

  it('moves the values of a CUBICSPLINE track and keeps its tangents', () => {
    const idle: RigClip = { name: 'idle', times: [0, 1], hips: [[0.3, 0, 0], [0.3, 0, 0]], cubic: true }
    const moved = [0, 0, 0, -0.3, 0.5, 0, 0, 0, 0]
    const track = rootTrack(prepareModel(riggedGlb({ clips: [idle] })).data, 0)
    expect(track).toEqual([...moved, ...moved].map(value => expect.closeTo(value, 6) as number))
  })

  it('leaves a clip that is centered already, that moves no joint, or that it cannot read', () => {
    const centered: RigClip = { name: 'sway', times: [0, 1, 2], hips: [[0.1, 0, 0], [-0.1, 0, 0], [0.1, 0, 0]] }
    const still: RigClip = { name: 'still', times: [0, 1], hips: [[0, 0, 0], [0, 0, 0]] }
    const prepared = prepareModel(riggedGlb({ clips: [centered, still] }))
    expect(prepared).toMatchObject({ turned: true, centered: [] })
    expect(documentOf(prepared.data).gltf.animations.map(clip => clip.samplers.length)).toEqual([2, 2])

    const { gltf, bin } = parseGlb(riggedGlb({ clips: [{ name: 'run', times: [0, 1], hips: [[0.4, 0, 0], [0.4, 0, 0]] }] }))
    const hipsOutput = (gltf.animations as Document['animations'])[0]?.samplers[0]?.output ?? -1
    const accessors = gltf.accessors as Array<Record<string, unknown>>
    accessors[hipsOutput] = { ...accessors[hipsOutput], componentType: 5123 }
    expect(prepareModel(writeGlb({ gltf, bin }))).toMatchObject({ turned: true, centered: [] })
  })
})

describe('GLB chunks', () => {
  it('writes a document and its binary chunk, each padded, and reads them back', () => {
    const gltf = { asset: { version: '2.0' }, buffers: [{ byteLength: 3 }] }
    const data = writeGlb({ gltf, bin: new Uint8Array([1, 2, 3]) })
    expect(data.byteLength % 4).toBe(0)
    const read = parseGlb(data)
    expect(read.gltf).toEqual(gltf)
    expect(Array.from(read.bin)).toEqual([1, 2, 3, 0])
    expect(parseGlb(writeGlb({ gltf, bin: new Uint8Array(0) })).bin.byteLength).toBe(0)
  })

  it('refuses a file that is not a complete GLB whose JSON holds a glTF document', () => {
    const complete = writeGlb({ gltf: { asset: { version: '2.0' } }, bin: new Uint8Array(8) })
    const cut = complete.slice(0, complete.byteLength - 4)
    new DataView(cut.buffer).setUint32(8, cut.byteLength, true)
    const withJson = (json: string): Uint8Array => {
      const file = writeGlb({ gltf: { asset: { version: '2.0' } }, bin: new Uint8Array(0) })
      file.set(new TextEncoder().encode(json.padEnd(28, ' ')), 20)
      return file
    }
    for (const [file, message] of [
      [new TextEncoder().encode('<html>not a model</html>'), 'is not a complete GLB file'],
      [cut, 'is a GLB file whose binary chunk is cut short'],
      [withJson('{"asset":'), 'is a GLB file whose JSON does not parse'],
      [withJson('[]'), 'is a GLB file whose JSON is not a glTF document'],
    ] as const) {
      expect(() => prepareModel(file)).toThrow(message)
    }
    expect(readGlb(documentFile({ animations: [{}, { name: 'walk' }] })).animations).toEqual(['animation 1', 'walk'])
  })
})
