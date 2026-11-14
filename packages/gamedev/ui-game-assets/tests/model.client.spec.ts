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
import { checkModelImage, ImageTooLargeError, UnsizedImageError } from '../src/client/picture.ts'
import {
  describeModel, disposeObject, gltfDeclaredBytes, gltfJson, loadModel, ModelTooLargeError, ModelUnsizedError, statsOf, type ModelSource,
} from '../src/client/viewer/model.ts'

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

/** The chunk types of a GLB file. */
const JSON_CHUNK = 0x4e4f534a
const BIN_CHUNK = 0x004e4942

/** JSON text padded to four bytes, as a GLB chunk holds it. */
function json(value: unknown): Uint8Array {
  const text = JSON.stringify(value)
  return new TextEncoder().encode(text.padEnd(Math.ceil(text.length / 4) * 4, ' '))
}

/** One GLB chunk: its length, its type, and its bytes. */
function chunk(type: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + body.byteLength)
  new DataView(out.buffer).setUint32(0, body.byteLength, true)
  new DataView(out.buffer).setUint32(4, type, true)
  out.set(body, 8)
  return out
}

/** A GLB file of chunks, its header stating its whole length. */
function glb(...chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(12 + chunks.reduce((total, part) => total + part.byteLength, 0))
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x46546c67, true)
  view.setUint32(4, 2, true)
  view.setUint32(8, out.byteLength, true)
  let at = 12
  for (const part of chunks) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

/** A PNG signature and IHDR chunk stating a size. */
function pngHeader(width: number, height: number): Uint8Array {
  const size = [width, height].flatMap(value => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return Uint8Array.from([...signature, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...size, 8, 6, 0, 0, 0, 0, 0, 0, 0])
}

function source(
  decoder: ModelSource['decoder'],
  data: Uint8Array<ArrayBuffer>,
  related: Mock<(reference: string) => string | undefined> = vi.fn((reference: string) => `http://host/api/file?path=/p/${reference}`),
) {
  return { decoder, data, related, changed: vi.fn(), maxBytes: 256 * 1024 * 1024, checkImage: vi.fn() } satisfies ModelSource
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
    // A type the loader does not know adds nothing.
    expect(gltfDeclaredBytes({ accessors: [{ count: 9, type: 'VEC9', componentType: 5126 }, { count: 9, type: 'VEC3', componentType: 1 }] })).toBe(0)
  })

  it('refuses a glTF description whose counts are not whole numbers, which the loader would still multiply', async () => {
    const accessor = (count: unknown) => ({ accessors: [{ componentType: 5126, count, type: 'VEC3' }] })
    for (const count of ['300000000', -1, 1.5, [300], true]) expect(() => gltfDeclaredBytes(accessor(count))).toThrow(ModelUnsizedError)
    expect(() => gltfDeclaredBytes({ accessors: [{ bufferView: 0, componentType: 5126, count: '3', type: 'VEC3' }] })).toThrow(ModelUnsizedError)
    expect(() => gltfDeclaredBytes({ bufferViews: [{ extensions: { EXT_meshopt_compression: { count: '1000000', byteStride: 16 } } }] })).toThrow(ModelUnsizedError)
    // A component type the loader looks up as a property name counts as its number.
    expect(gltfDeclaredBytes({ accessors: [{ componentType: '5126', count: 100, type: 'VEC3' }] })).toBe(1200)
    // The loader would fill 300 positions from a count given as text; the model is refused before it allocates.
    const text = JSON.stringify({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ componentType: 5126, count: '300', type: 'VEC3' }],
    })
    await expect(loadModel(source('gltf', encode(text)), new AbortController().signal)).rejects.toBeInstanceOf(ModelUnsizedError)
  })

  it('sizes a GLB file by the JSON chunk the loader reads: any chunk, the last one winning', async () => {
    const heavy = { asset: { version: '2.0' }, accessors: [{ componentType: 5126, count: 100_000_000, type: 'VEC3' }] }
    const binFirst = glb(chunk(BIN_CHUNK, new Uint8Array(4)), chunk(JSON_CHUNK, json(heavy)))
    const twoJson = glb(chunk(JSON_CHUNK, json({ asset: { version: '2.0' } })), chunk(JSON_CHUNK, json(heavy)))
    for (const file of [binFirst, twoJson]) {
      expect(gltfDeclaredBytes(gltfJson(file))).toBe(1_200_000_000)
      await expect(loadModel(source('gltf', file), new AbortController().signal)).rejects.toBeInstanceOf(ModelTooLargeError)
    }
    // Chunks past the length the header states are not read.
    const cut = glb(chunk(JSON_CHUNK, json({ asset: { version: '2.0' } })), chunk(JSON_CHUNK, json(heavy)))
    new DataView(cut.buffer).setUint32(8, cut.byteLength - (8 + json(heavy).byteLength), true)
    expect(gltfDeclaredBytes(gltfJson(cut))).toBe(0)
  })

  it('counts the instance matrices of EXT_mesh_gpu_instancing nodes, one per instance for each primitive', async () => {
    const instanced = {
      asset: { version: '2.0' }, extensionsUsed: ['EXT_mesh_gpu_instancing'], scene: 0, scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1, SCALE: 2 } } } }],
      meshes: [{ primitives: Array.from({ length: 20 }, () => ({ attributes: { POSITION: 0 } })) }],
      accessors: [
        { componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] },
        { componentType: 5121, count: 200_000, type: 'SCALAR' },
        { componentType: 5121, count: 10, type: 'SCALAR' },
      ],
    }
    // 36 bytes of positions and 200,010 of attributes, and 20 primitives × 200,000 instances × 64 bytes of matrices.
    expect(gltfDeclaredBytes(instanced)).toBe(36 + 200_010 + 20 * 200_000 * 64)
    const refused = loadModel({ ...source('gltf', encode(JSON.stringify(instanced))), maxBytes: 1_000_000 }, new AbortController().signal)
    await expect(refused).rejects.toBeInstanceOf(ModelTooLargeError)
  })

  it('checks each image a glTF model names before the loader decodes it, and shows the model without one it refuses', async () => {
    const decodes = vi.fn(async () => ({ width: 16, height: 16, close: () => {} }))
    vi.stubGlobal('createImageBitmap', decodes)
    const blobs = new Map<string, Blob>()
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        const url = `blob:model/${String(blobs.size)}`
        blobs.set(url, blob)
        return url
      },
      revokeObjectURL: () => {},
    }))
    vi.stubGlobal('fetch', vi.fn(async (request: Request | string) => {
      const url = typeof request === 'string' ? request : request.url
      const blob = blobs.get(url)
      if (blob !== undefined) return new Response(blob)
      if (url.startsWith('data:')) return new Response(Uint8Array.from(atob(url.slice(url.indexOf(',') + 1)), character => character.charCodeAt(0)))
      return new Response('missing', { status: 404 })
    }))
    const check = (data: Uint8Array, name: string) => { checkModelImage(data, name, 8192 * 8192) }
    const textured = (image: object, bin: Uint8Array) => glb(chunk(JSON_CHUNK, json({
      asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }], textures: [{ source: 0 }], images: [image],
      buffers: [{ byteLength: bin.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: bin.byteLength - 36 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    })), chunk(BIN_CHUNK, bin))
    const withImage = (png: Uint8Array) => {
      const bin = new Uint8Array(36 + Math.ceil(png.byteLength / 4) * 4)
      bin.set(new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer))
      bin.set(png, 36)
      return bin
    }
    // An image in a buffer whose header states 50000 × 50000 pixels: refused and listed, and nothing decoded.
    const huge = withImage(pngHeader(50_000, 50_000))
    const refusals: unknown[] = []
    const recorded = (data: Uint8Array, name: string) => {
      try {
        check(data, name)
      } catch (error) {
        refusals.push(error)
        throw error
      }
    }
    const big = await loadModel({ ...source('gltf', textured({ bufferView: 1, mimeType: 'image/png', name: 'skin' }, huge)), checkImage: recorded }, new AbortController().signal)
    expect(big.missing).toEqual(['skin'])
    // An image file the model names by a URI, here a data URL, whose header states no size the viewer reads.
    const flat = withImage(new Uint8Array(0))
    const named = { uri: `data:image/png;base64,${btoa('not an image')}` }
    const related = vi.fn((reference: string) => reference)
    const plain = await loadModel({ ...source('gltf', textured(named, flat), related), checkImage: recorded }, new AbortController().signal)
    expect(plain.missing).toEqual(['#/images/0'])
    expect(refusals.map(error => error instanceof ImageTooLargeError || error instanceof UnsizedImageError)).toEqual([true, true])
    expect(refusals[1]).toBeInstanceOf(UnsizedImageError)
    expect(decodes).not.toHaveBeenCalled()
    // An image the check passes decodes as the loader decodes it.
    const small = await loadModel({ ...source('gltf', textured({ bufferView: 1, mimeType: 'image/png' }, withImage(pngHeader(16, 16)))), checkImage: check }, new AbortController().signal)
    await small.settled
    expect(decodes).toHaveBeenCalledTimes(1)
    expect(small.stats.triangles).toBe(1)
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
