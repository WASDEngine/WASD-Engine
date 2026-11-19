// @vitest-environment jsdom
/**
 * Reading models with the real three.js loaders: glTF with an external buffer and an animation, OBJ with its material
 * library, STL, PLY meshes and point clouds, VOX with and without a scene graph, FBX, and Collada; files named outside
 * the project or on the web; files that ask for more memory than the viewer sets aside, refused before the loader
 * allocates it; the textures of every format, each checked before it is decoded and decoded from the checked bytes;
 * the counts shown beside a model; measurements of vertices that are not finite; disposal; and a Blender file's export.
 */
import { BoxGeometry, BufferGeometry, DataTexture, Group, ImageLoader, InstancedMesh, Mesh, MeshLambertMaterial, MeshPhongMaterial, MeshStandardMaterial, Points, Texture } from 'three'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { exportOf, formatOf } from '../src/client/formats.ts'
import { relatedUrl } from '../src/client/read.ts'
import type { AssetEntry } from '../src/client/scan.ts'
import { checkModelImage, ImageTooLargeError, UnsizedImageError } from '../src/client/picture.ts'
import { describeModel, disposeObject, loadModel, statsOf, type ModelSource } from '../src/client/viewer/model.ts'
import { colladaImageNames, gltfDeclaredBytes, gltfJson, ModelTooLargeError, ModelUnsizedError } from '../src/client/viewer/model-sizes.ts'
import { FbxInflateError } from '../src/client/viewer/fbx.ts'
import { VoxModelTooLargeError, VoxWorkTooLargeError } from '../src/client/viewer/vox.ts'
import { fbx, fbxFile, pngHeader, tgaFile, voxFile } from './model-files.client.ts'

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

function source(
  decoder: ModelSource['decoder'],
  data: Uint8Array<ArrayBuffer>,
  related: Mock<(reference: string) => string | undefined> = vi.fn((reference: string) => `http://host/api/file?path=/p/${reference}`),
) {
  return { decoder, data, related, changed: vi.fn(), maxBytes: 256 * 1024 * 1024, checkImage: vi.fn(() => 0) } satisfies ModelSource
}

describe('loadModel', () => {
  it('reads glTF, fetching its buffer through the related-file URL, with its animation clips', async () => {
    const { json, bin } = triangleGltf()
    const fetched: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (request: Request | string, init?: RequestInit) => {
      fetched.push(`${init?.method ?? 'GET'} ${typeof request === 'string' ? request : request.url}`)
      return new Response(bin)
    }))
    const input = source('gltf', encode(json))
    const model = await loadModel(input, new AbortController().signal)
    expect(input.related).toHaveBeenCalledWith('tri.bin')
    // The buffer's size is asked for before the loader reads it.
    expect(fetched).toEqual(['HEAD http://host/api/file?path=/p/tri.bin', 'GET http://host/api/file?path=/p/tri.bin'])
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
    const related = (path: string) => vi.fn((reference: string) => relatedUrl('http://host/', '/Users/me/Knight', path, reference, 1000))
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
    // Twenty positions take 240 bytes, as many as the viewer sets aside here, and as many as the file's own size fits in.
    const small = await loadModel({ ...source('gltf', encode(zeros(20))), maxBytes: 240 }, new AbortController().signal)
    expect(small.stats.vertices).toBe(20)
    await expect(loadModel({ ...source('gltf', encode(zeros(21))), maxBytes: 240 }, new AbortController().signal)).rejects.toBeInstanceOf(ModelTooLargeError)
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
    const check = (data: Uint8Array, name: string) => checkModelImage(data, name, 8192 * 8192)
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
        return check(data, name)
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

/** A file route that serves files by name and records each request's method and name. */
function serve(files: Readonly<Record<string, Uint8Array<ArrayBuffer> | string>>, headers: (name: string) => HeadersInit = () => ({})) {
  const requests: string[] = []
  const blobs = new Map<string, Blob>()
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      const url = `blob:model/${String(blobs.size)}`
      blobs.set(url, blob)
      return url
    },
    revokeObjectURL: (url: string) => { blobs.delete(url) },
  }))
  vi.stubGlobal('fetch', vi.fn(async (request: Request | string, init?: RequestInit) => {
    const url = typeof request === 'string' ? request : request.url
    const blob = blobs.get(url)
    if (blob !== undefined) {
      requests.push(`${init?.method ?? 'GET'} blob`)
      return new Response(blob)
    }
    if (url.startsWith('data:')) throw new TypeError('Failed to fetch')
    const name = new URL(url).searchParams.get('path') ?? ''
    requests.push(`${init?.method ?? 'GET'} ${name}`)
    const file = files[name]
    if (file === undefined) return new Response('missing', { status: 404 })
    return new Response(init?.method === 'HEAD' ? null : file, { headers: headers(name) })
  }))
  return { requests, blobs }
}

/** Related files served by name from the fake route; `data:` and `blob:` URLs pass through, as the viewer's do. */
const byName = vi.fn((reference: string) => (/^(?:data|blob):/u.test(reference) ? reference : `http://host/api/file?path=${encodeURIComponent(reference)}`))

/** Image decodes, each answered at once with a 16 × 16 image; records each URL as the loader resolves it. */
function decodes() {
  const loaded: string[] = []
  vi.spyOn(ImageLoader.prototype, 'load').mockImplementation(function (this: ImageLoader, name, onLoad) {
    const url = this.manager.resolveURL(`${this.path}${name}`)
    loaded.push(url)
    const image = Object.assign(document.createElement('img'), { width: 16, height: 16, src: url })
    this.manager.itemStart(url)
    queueMicrotask(() => {
      onLoad?.(image)
      this.manager.itemEnd(url)
    })
    return image
  })
  return loaded
}

const OBJ_TRIANGLE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nusemtl skin\nf 1/1 2/2 3/3\n'

describe('loadModel: the memory of every format and its textures', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('refuses a glTF model whose named files take more than one model may, from their sizes, before reading them', async () => {
    const description = JSON.stringify({
      asset: { version: '2.0' }, buffers: [{ uri: 'a.bin', byteLength: 4 }, { uri: 'b.bin', byteLength: 4 }], images: [{ uri: 'a.bin' }],
    })
    const route = serve({ 'a.bin': new Uint8Array(4), 'b.bin': new Uint8Array(4) }, name => ({ 'X-Asset-Size': name === 'a.bin' ? '600' : '500' }))
    const refused = loadModel({ ...source('gltf', encode(description), byName), maxBytes: 1000 }, new AbortController().signal)
    await expect(refused).rejects.toBeInstanceOf(ModelTooLargeError)
    await expect(refused).rejects.toMatchObject({ bytes: description.length + 1100, limit: 1000 })
    // Each distinct file is sized once, and none is read.
    expect(route.requests).toEqual(['HEAD a.bin', 'HEAD b.bin'])
  })

  it('refuses a VOX file larger than MagicaVoxel makes, or whose meshes take more than one model may, before meshing it', async () => {
    const huge = loadModel(source('vox', voxFile([{ x: 1024, y: 1024, z: 1024 }])), new AbortController().signal)
    await expect(huge).rejects.toBeInstanceOf(VoxModelTooLargeError)
    const placed = voxFile([{ x: 200, y: 200, z: 200 }], [{ type: 'group', id: 0, children: [1, 1, 1] }, { type: 'shape', id: 1, models: [0] }])
    await expect(loadModel(source('vox', placed), new AbortController().signal)).rejects.toBeInstanceOf(VoxWorkTooLargeError)
    // A 64³ box of 64 KB, beyond the memory set aside here.
    const roomy = voxFile([{ x: 64, y: 64, z: 64, voxels: [[0, 0, 0, 1]] }])
    await expect(loadModel({ ...source('vox', roomy), maxBytes: 64 * 1024 }, new AbortController().signal)).rejects.toBeInstanceOf(ModelTooLargeError)
  })

  it('reads a VOX file with a scene graph, and one without, whose models the loader leaves for the viewer to mesh', async () => {
    const cube = { x: 2, y: 2, z: 2, voxels: [[0, 0, 0, 1], [1, 1, 1, 2]] as const }
    const scene = await loadModel(source('vox', voxFile([cube], [{ type: 'transform', id: 0, child: 1 }, { type: 'shape', id: 1, models: [0] }])), new AbortController().signal)
    // Two voxels apart: six quads of two triangles each.
    expect(scene.stats.triangles).toBe(24)
    const plain = await loadModel(source('vox', voxFile([cube, { x: 1, y: 1, z: 1, voxels: [[0, 0, 0, 1]] }])), new AbortController().signal)
    expect(plain.root).toBeInstanceOf(Group)
    expect(plain.root.children).toHaveLength(2)
    expect(plain.stats.triangles).toBe(36)
  })

  it('refuses an FBX file whose arrays take more than one model may, or whose compressed data inflates past its length', async () => {
    const large = fbxFile([{ name: 'Objects', children: [{ name: 'Geometry', properties: [fbx.long(1)], children: [{ name: 'Vertices', properties: [fbx.doubles(3, [0, 1, 2])] }] }] }])
    await expect(loadModel({ ...source('fbx', large), maxBytes: 400 }, new AbortController().signal)).rejects.toBeInstanceOf(ModelTooLargeError)
    const bomb = fbxFile([{ name: 'Objects', children: [{ name: 'Vertices', properties: [fbx.doubles(4, [], new Uint8Array(1024 * 1024))] }] }])
    await expect(loadModel(source('fbx', bomb), new AbortController().signal)).rejects.toBeInstanceOf(FbxInflateError)
  })

  it('checks each texture of an OBJ material library before decoding it, and decodes it from the checked bytes', async () => {
    const loaded = decodes()
    const route = serve({
      'mat/hero.mtl': 'newmtl skin\nmap_Kd big.png\nmap_Ks small.png\nmap_bump -bm 0.5 rough.tga\n',
      'mat/big.png': pngHeader(50_000, 50_000),
      'mat/small.png': pngHeader(16, 16),
      'mat/rough.tga': tgaFile(2, 2),
    })
    const checked: string[] = []
    const checkImage = (data: Uint8Array, name: string) => {
      checked.push(name)
      return checkModelImage(data, name, 8192 * 8192)
    }
    const model = await loadModel({ ...source('obj', encode(`mtllib mat/hero.mtl\n${OBJ_TRIANGLE}`), byName), checkImage }, new AbortController().signal)
    await model.settled
    expect(model.missing).toEqual(['big.png'])
    expect(checked.toSorted()).toEqual(['mat/big.png', 'mat/rough.tga', 'mat/small.png'])
    // Each texture is fetched once; the image the browser decodes comes from its checked bytes.
    expect(route.requests.toSorted()).toEqual(['GET mat/big.png', 'GET mat/hero.mtl', 'GET mat/rough.tga', 'GET mat/small.png'])
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatch(/^blob:model\//u)
    const material = (model.root.children[0] as Mesh).material as MeshPhongMaterial
    expect(material.map?.image).toBeNull()
    expect(material.specularMap?.image).toMatchObject({ width: 16, height: 16 })
    // TGA decodes into pixels, as three.js's TGA loader decodes it.
    expect(material.bumpMap).toBeInstanceOf(DataTexture)
    expect(material.bumpMap?.image).toMatchObject({ width: 2, height: 2 })
    expect(material.bumpScale).toBe(0.5)
  })

  it('counts every texture of a model against the memory set aside for its textures, decoded and in its files', async () => {
    decodes()
    const lines = ['newmtl skin', 'map_Kd a.png', 'map_Ks b.png', 'map_Ke c.png']
    // Each image takes 1024 × 1024 × 4 bytes decoded, and two fit what is set aside.
    serve({ 'm.mtl': lines.join('\n'), 'a.png': pngHeader(1024, 1024), 'b.png': pngHeader(1024, 1024), 'c.png': pngHeader(1024, 1024) })
    const obj = encode(`mtllib m.mtl\n${OBJ_TRIANGLE}`)
    const decoded = await loadModel({ ...source('obj', obj, byName), maxBytes: 2 * 1024 * 1024 * 4, checkImage: (data, name) => checkModelImage(data, name, 8192 * 8192) }, new AbortController().signal)
    await decoded.settled
    expect(decoded.missing).toHaveLength(1)
    // A texture file whose response states more bytes than are left is refused before its body is read.
    const route = serve({ 'm.mtl': lines.join('\n'), 'a.png': pngHeader(1, 1), 'b.png': pngHeader(1, 1), 'c.png': pngHeader(1, 1) }, name => (name === 'b.png' ? { 'Content-Length': '5000' } : {}))
    const files = await loadModel({ ...source('obj', obj, byName), maxBytes: 4000, checkImage: (data, name) => checkModelImage(data, name, 8192 * 8192) }, new AbortController().signal)
    await files.settled
    expect(files.missing).toEqual(['b.png'])
    expect(route.requests).toContain('GET b.png')
  })

  it('checks an FBX file\'s embedded images and its images in files of their own, listing an embedded one it refuses', async () => {
    const loaded = decodes()
    const route = serve({ 'skin.png': pngHeader(16, 16) })
    const file = fbxFile([
      {
        name: 'Objects',
        children: [
          { name: 'Video', properties: [fbx.long(10), fbx.string('Video::big'), fbx.string('Clip')], children: [{ name: 'RelativeFilename', properties: [fbx.string('big.png')] }, { name: 'Content', properties: [fbx.raw(pngHeader(50_000, 50_000))] }] },
          { name: 'Texture', properties: [fbx.long(20), fbx.string('Texture::big'), fbx.string('')], children: [{ name: 'FileName', properties: [fbx.string('big.png')] }] },
          { name: 'Video', properties: [fbx.long(11), fbx.string('Video::skin'), fbx.string('Clip')], children: [{ name: 'RelativeFilename', properties: [fbx.string('C:\\art\\skin.png')] }] },
          { name: 'Texture', properties: [fbx.long(21), fbx.string('Texture::skin'), fbx.string('')], children: [{ name: 'FileName', properties: [fbx.string('skin.png')] }] },
        ],
      },
      { name: 'Connections', children: [{ name: 'C', properties: [fbx.string('OO'), fbx.long(10), fbx.long(20)] }, { name: 'C', properties: [fbx.string('OO'), fbx.long(11), fbx.long(21)] }] },
    ])
    const model = await loadModel({ ...source('fbx', file, byName), checkImage: (data, name) => checkModelImage(data, name, 8192 * 8192) }, new AbortController().signal)
    await model.settled
    expect(model.missing).toEqual(['(embedded)'])
    expect(route.requests.toSorted()).toEqual(['GET blob', 'GET skin.png'])
    expect(loaded).toHaveLength(1)
    // The loader's URL of the embedded image goes once every texture settled, with the viewer's own.
    expect(route.blobs.size).toBe(0)
  })

  it('checks a Collada file\'s images before its loader runs, and hands the loader the checked bytes', async () => {
    const loaded = decodes()
    const route = serve({ 'skin.png': pngHeader(16, 16), 'big.png': pngHeader(50_000, 50_000) })
    const dae = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
  <asset><unit name="meter" meter="1"/><up_axis>Y_UP</up_axis></asset>
  <library_images>
    <image id="skin-image"><init_from>skin.png</init_from></image>
    <image id="big-image"><init_from>big.png</init_from></image>
  </library_images>
  <library_effects><effect id="skin-effect"><profile_COMMON>
    <newparam sid="skin-surface"><surface type="2D"><init_from>skin-image</init_from></surface></newparam>
    <newparam sid="skin-sampler"><sampler2D><source>skin-surface</source></sampler2D></newparam>
    <technique sid="common"><lambert><diffuse><texture texture="skin-sampler" texcoord="UVMap"/></diffuse></lambert></technique>
  </profile_COMMON></effect></library_effects>
  <library_materials><material id="skin-material"><instance_effect url="#skin-effect"/></material></library_materials>
  <library_geometries><geometry id="tri"><mesh>
    <source id="tri-pos"><float_array id="tri-pos-array" count="9">0 0 0 1 0 0 0 1 0</float_array>
      <technique_common><accessor source="#tri-pos-array" count="3" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>
    <vertices id="tri-verts"><input semantic="POSITION" source="#tri-pos"/></vertices>
    <triangles material="skin" count="1"><input semantic="VERTEX" source="#tri-verts" offset="0"/><p>0 1 2</p></triangles>
  </mesh></geometry></library_geometries>
  <library_visual_scenes><visual_scene id="scene"><node id="n"><instance_geometry url="#tri"><bind_material><technique_common><instance_material symbol="skin" target="#skin-material"/></technique_common></bind_material></instance_geometry></node></visual_scene></library_visual_scenes>
  <scene><instance_visual_scene url="#scene"/></scene>
</COLLADA>`
    expect(colladaImageNames(dae)).toEqual(['skin.png', 'big.png'])
    const model = await loadModel({ ...source('dae', encode(dae), byName), checkImage: (data, name) => checkModelImage(data, name, 8192 * 8192) }, new AbortController().signal)
    await model.settled
    expect(model.missing).toEqual(['big.png'])
    // Each image is fetched once, before the loader runs; the loader decodes the checked bytes.
    expect(route.requests).toEqual(['GET skin.png', 'GET big.png'])
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatch(/^blob:model\//u)
    const mesh = model.root.getObjectByProperty('type', 'Mesh') as Mesh
    expect(mesh.material).toBeInstanceOf(MeshLambertMaterial)
    expect(model.textureName((mesh.material as MeshLambertMaterial).map as Texture)).toBe('skin.png')
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
