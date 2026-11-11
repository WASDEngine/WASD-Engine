// @vitest-environment jsdom
/**
 * Reading models with the real three.js loaders: glTF with an external buffer and an animation, OBJ with its material
 * library, STL, PLY meshes and point clouds; the counts shown beside a model; disposal; and a Blender file's export.
 */
import { BoxGeometry, BufferGeometry, Group, InstancedMesh, Mesh, MeshPhongMaterial, MeshStandardMaterial, Points, Texture } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { exportOf } from '../src/client/AssetViewer.tsx'
import { formatOf } from '../src/client/formats.ts'
import type { AssetEntry } from '../src/client/scan.ts'
import { disposeObject, loadModel, statsOf, type ModelSource } from '../src/client/viewer/model.ts'

afterEach(() => { vi.unstubAllGlobals() })

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text)

/** A triangle at the origin with a one-second translation clip, its buffer in `tri.bin`. */
function triangleGltf(): { readonly json: string; readonly bin: ArrayBuffer } {
  const floats = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  return {
    bin: floats.buffer,
    json: JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: 'tri' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      buffers: [{ uri: 'tri.bin', byteLength: 68 }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 8 },
        { buffer: 0, byteOffset: 44, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' },
      ],
      animations: [{ name: 'Bob', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 1, output: 2 }] }],
    }),
  }
}

function source(decoder: ModelSource['decoder'], data: Uint8Array<ArrayBuffer>, related = vi.fn((reference: string) => `http://host/api/file?path=/p/${reference}`)) {
  return { decoder, data, related, changed: vi.fn() } satisfies ModelSource
}

describe('loadModel', () => {
  it('reads glTF, fetching its buffer through the related-file URL, with its animation clips', async () => {
    const { json, bin } = triangleGltf()
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (request: Request | string) => {
      fetched.push(typeof request === 'string' ? request : request.url)
      return new Response(bin)
    }))
    const input = source('gltf', encode(json))
    const model = await loadModel(input, new AbortController().signal)
    expect(input.related).toHaveBeenCalledWith('tri.bin')
    expect(fetched).toEqual(['http://host/api/file?path=/p/tri.bin'])
    expect(model.stats).toEqual({ triangles: 1, vertices: 3 })
    expect(model.animations.map(clip => clip.name)).toEqual(['Bob'])
    expect(model.root.getObjectByName('tri')).toBeInstanceOf(Mesh)
  })

  it('reads OBJ with the materials of its library, resolved against the OBJ file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('newmtl red\nKd 1 0 0\n')))
    const input = source('obj', encode('mtllib ../mat/cube.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nusemtl red\nf 1 2 3\nf 1 3 4\n'))
    const model = await loadModel(input, new AbortController().signal)
    expect(input.related).toHaveBeenCalledWith('../mat/cube.mtl')
    expect(model.stats).toEqual({ triangles: 2, vertices: 6 })
    const mesh = model.root.children[0]
    expect(mesh instanceof Mesh && mesh.material instanceof MeshPhongMaterial && mesh.material.color.getHexString()).toBe('ff0000')
  })

  it('shows an OBJ untextured when its material library cannot be fetched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const model = await loadModel(source('obj', encode('mtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')), new AbortController().signal)
    expect(model.stats.triangles).toBe(1)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('missing', { status: 404 })))
    const missing = await loadModel(source('obj', encode('mtllib a.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n')), new AbortController().signal)
    expect(missing.stats.triangles).toBe(1)
  })

  it('reads STL as a lit mesh and PLY as a mesh or, without faces, as points', async () => {
    const stl = await loadModel(source('stl', encode('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n')), new AbortController().signal)
    expect(stl.root).toBeInstanceOf(Mesh)
    expect(stl.root instanceof Mesh && stl.root.material).toBeInstanceOf(MeshStandardMaterial)
    expect(stl.stats).toEqual({ triangles: 1, vertices: 3 })
    const header = 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\n'
    const mesh = await loadModel(source('ply', encode(`${header}element face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n`)), new AbortController().signal)
    expect(mesh.root).toBeInstanceOf(Mesh)
    expect(mesh.stats).toEqual({ triangles: 1, vertices: 3 })
    const cloud = await loadModel(source('ply', encode(`${header}end_header\n0 0 0\n1 0 0\n0 1 0\n`)), new AbortController().signal)
    expect(cloud.root).toBeInstanceOf(Points)
    expect(cloud.stats).toEqual({ triangles: 0, vertices: 3 })
  })

  it('rejects a file that is not a model of its format', async () => {
    await expect(loadModel(source('gltf', encode('not json')), new AbortController().signal)).rejects.toThrow()
    await expect(loadModel(source('dae', encode('<COLLADA')), new AbortController().signal)).rejects.toThrow()
  })

  it('rejects with the abort reason once aborted, after disposing what it read', async () => {
    const controller = new AbortController()
    const dispose = vi.spyOn(BufferGeometry.prototype, 'dispose')
    controller.abort(new Error('closed'))
    const loading = loadModel(source('stl', encode('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n')), controller.signal)
    await expect(loading).rejects.toThrow('closed')
    expect(dispose).toHaveBeenCalled()
    dispose.mockRestore()
  })
})

describe('model resources', () => {
  it('counts instances and releases geometries, materials, and their textures once', () => {
    const geometry = new BoxGeometry()
    const texture = new Texture()
    const material = new MeshStandardMaterial({ map: texture })
    const group = new Group()
    group.add(new InstancedMesh(geometry, material, 4), new Mesh(geometry, material))
    expect(statsOf(group)).toEqual({ triangles: 12 * 5, vertices: 24 * 5 })
    const geometryDispose = vi.spyOn(geometry, 'dispose')
    const materialDispose = vi.spyOn(material, 'dispose')
    const textureDispose = vi.spyOn(texture, 'dispose')
    disposeObject(group)
    expect([geometryDispose.mock.calls.length, materialDispose.mock.calls.length, textureDispose.mock.calls.length]).toEqual([1, 1, 1])
  })
})

describe('exportOf', () => {
  const entry = (path: string): AssetEntry => {
    const format = formatOf(path)
    if (format === undefined) throw new Error(path)
    const slash = path.lastIndexOf('/')
    return { path, name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash), format }
  }
  const blend = entry('assets/models/src/Archer.blend')

  it('prefers the nearest model of the same name: same folder, above, below, then anywhere; GLB first', () => {
    const anywhere = entry('other/archer.glb')
    const below = entry('assets/models/src/export/archer.glb')
    const above = entry('assets/models/archer.gltf')
    const aboveGlb = entry('assets/models/archer.glb')
    const same = entry('assets/models/src/archer.fbx')
    expect(exportOf(blend, [anywhere])).toBe(anywhere)
    expect(exportOf(blend, [anywhere, below])).toBe(below)
    expect(exportOf(blend, [anywhere, below, above])).toBe(above)
    expect(exportOf(blend, [anywhere, below, above, aboveGlb])).toBe(aboveGlb)
    expect(exportOf(blend, [anywhere, below, above, aboveGlb, same])).toBe(same)
  })

  it('ignores images, other Blender files, and other names', () => {
    expect(exportOf(blend, [entry('assets/models/archer.png'), entry('assets/archer.blend'), entry('assets/models/archers.glb')])).toBeUndefined()
  })
})
