// @vitest-environment jsdom
/**
 * Reading models with the real three.js loaders: glTF with an external buffer and an animation, OBJ with its material
 * library, STL, PLY meshes and point clouds; files named outside the project or on the web; glTF descriptions that ask
 * for more memory than the viewer sets aside; the counts shown beside a model; measurements of vertices that are not
 * finite; disposal; and a Blender file's export.
 */
import { BoxGeometry, BufferGeometry, Group, InstancedMesh, Mesh, MeshPhongMaterial, MeshStandardMaterial, Points, Texture } from 'three'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { exportOf } from '../src/client/AssetViewer.tsx'
import { formatOf } from '../src/client/formats.ts'
import { relatedUrl } from '../src/client/read.ts'
import type { AssetEntry } from '../src/client/scan.ts'
import { describeModel, disposeObject, gltfDeclaredBytes, gltfJson, loadModel, ModelTooLargeError, statsOf, type ModelSource } from '../src/client/viewer/model.ts'

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

function source(
  decoder: ModelSource['decoder'],
  data: Uint8Array<ArrayBuffer>,
  related: Mock<(reference: string) => string | undefined> = vi.fn((reference: string) => `http://host/api/file?path=/p/${reference}`),
) {
  return { decoder, data, related, changed: vi.fn(), maxBytes: 256 * 1024 * 1024 } satisfies ModelSource
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

  it('requests no file a model names outside the project or on the web, and lists it as missing', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (request: Request | string) => {
      const url = typeof request === 'string' ? request : request.url
      fetched.push(url)
      // Browsers refuse a data URL without a comma without any request.
      if (/^data:[^,]*$/u.test(url)) throw new TypeError('Failed to fetch')
      return new Response('newmtl red\nKd 1 0 0\n')
    }))
    const related = (path: string) => vi.fn((reference: string) => relatedUrl('http://host/', `/Users/me/Knight/${path}`, path, reference))
    const obj = await loadModel(source('obj', encode('mtllib ../../../../Pictures/private.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), related('models/hero.obj')), new AbortController().signal)
    expect(fetched).toEqual([])
    expect(obj.missing).toEqual(['private.mtl'])
    expect(obj.stats.triangles).toBe(1)
    // A buffer on the web fails the model without a request to the web.
    const { json } = triangleGltf()
    const web = JSON.stringify({ ...JSON.parse(json) as object, buffers: [{ uri: 'https://tracker.example/t%0A.bin', byteLength: 68 }] })
    await expect(loadModel(source('gltf', encode(web), related('models/tri.gltf')), new AbortController().signal)).rejects.toThrow('Failed to load buffer')
    expect(fetched).toHaveLength(1)
    expect(fetched[0]).toMatch(/^data:[^,]*$/u)
  })

  it('refuses a glTF description that sizes more arrays than the viewer sets aside, before the loader allocates them', async () => {
    // Three positions the loader fills with zeros itself: an accessor without a buffer view.
    const zeros = (count: number) => JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ componentType: 5126, count, type: 'VEC3' }],
    })
    const small = await loadModel({ ...source('gltf', encode(zeros(3))), maxBytes: 36 }, new AbortController().signal)
    expect(small.stats.vertices).toBe(3)
    // About 4.8 GB of zeros from a description of a few hundred bytes.
    const huge = zeros(400_000_000)
    expect(gltfDeclaredBytes(JSON.parse(huge))).toBe(4_800_000_000)
    const refused = loadModel(source('gltf', encode(huge)), new AbortController().signal)
    await expect(refused).rejects.toBeInstanceOf(ModelTooLargeError)
    await expect(refused).rejects.toMatchObject({ bytes: 4_800_000_000, limit: 256 * 1024 * 1024 })
    // A Meshopt-compressed buffer view decodes into the size it gives, inside a GLB file as in a .gltf file.
    const meshopt = { asset: { version: '2.0' }, bufferViews: [{ buffer: 0, byteLength: 4, extensions: { EXT_meshopt_compression: { buffer: 0, byteLength: 4, count: 1_000_000_000, byteStride: 16, mode: 'ATTRIBUTES' } } }] }
    const text = new TextEncoder().encode(JSON.stringify(meshopt).padEnd(Math.ceil(JSON.stringify(meshopt).length / 4) * 4, ' '))
    const glb = new Uint8Array(20 + text.byteLength)
    const view = new DataView(glb.buffer)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, glb.byteLength, true)
    view.setUint32(12, text.byteLength, true)
    view.setUint32(16, 0x4e4f534a, true)
    glb.set(text, 20)
    expect(gltfDeclaredBytes(gltfJson(glb))).toBe(16_000_000_000)
    await expect(loadModel(source('gltf', glb), new AbortController().signal)).rejects.toBeInstanceOf(ModelTooLargeError)
    // Sizes the loader refuses itself add nothing.
    expect(gltfDeclaredBytes({ accessors: [{ count: -1, type: 'VEC3', componentType: 5126 }, { count: 1.5, type: 'VEC3', componentType: 5126 }, { count: 9, type: 'VEC9', componentType: 5126 }] })).toBe(0)
  })

  it('measures a model whose vertices are not all finite by the vertices that are, so its details stay plain JSON', async () => {
    const model = await loadModel(source('stl', encode('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 2 0 0\nvertex 0 3 0\nendloop\nendfacet\nfacet normal 0 0 1\nouter loop\nvertex nan 0 0\nvertex 1 inf 0\nvertex 0 1 1\nendloop\nendfacet\nendsolid t\n')), new AbortController().signal)
    const details = describeModel(model, 'STL', 100)
    expect([details.min, details.max]).toEqual([[0, 0, 0], [2, 3, 1]])
    expect(JSON.parse(JSON.stringify(details))).toEqual(details)
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
