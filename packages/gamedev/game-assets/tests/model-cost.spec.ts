/**
 * What a window's draw of a model costs, counted on the Host: the files each format names that load with it, resolved
 * as the window resolves them and only inside the folder it reads by real path; the memory their textures, a VOX
 * file's meshes, and an FBX file's arrays take; the findings kept by size and modification time; and model files read
 * a few at a time.
 */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, open, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ModelDecoder } from '../src/formats.ts'
import { imagePixels, MAX_NAMED_FILES, ModelCosts, mtlTextures, namedPath, type ModelCost } from '../src/model-cost.ts'

/** A PNG header stating a size. */
function png(width: number, height: number): Buffer {
  const header = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0, 0, 0, 0, 0, 8, 6, 0, 0, 0,
  ])
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

/** One FBX 7.4 property, by its type code and its bytes after the code. */
type Property = readonly [string, Buffer]

const property = {
  string: (text: string): Property => {
    const bytes = Buffer.from(text)
    const length = Buffer.alloc(4)
    length.writeUInt32LE(bytes.byteLength)
    return ['S', Buffer.concat([length, bytes])]
  },
  raw: (data: Buffer): Property => {
    const length = Buffer.alloc(4)
    length.writeUInt32LE(data.byteLength)
    return ['R', Buffer.concat([length, data])]
  },
  long: (value: number): Property => {
    const bytes = Buffer.alloc(8)
    bytes.writeBigInt64LE(BigInt(value))
    return ['L', bytes]
  },
  /** A compressed double array stating `length` values. */
  doubles: (length: number, data: Buffer): Property => {
    const deflated = deflateSync(data)
    const header = Buffer.alloc(12)
    header.writeUInt32LE(length, 0)
    header.writeUInt32LE(1, 4)
    header.writeUInt32LE(deflated.byteLength, 8)
    return ['d', Buffer.concat([header, deflated])]
  },
}

interface Node {
  readonly name: string
  readonly properties?: readonly Property[]
  readonly children?: readonly Node[]
}

/** One FBX 7.4 node record at an offset. */
function record(node: Node, offset: number): Buffer {
  const properties = Buffer.concat((node.properties ?? []).map(([type, bytes]) => Buffer.concat([Buffer.from(type), bytes])))
  const parts: Buffer[] = []
  let at = offset + 13 + node.name.length + properties.byteLength
  for (const child of node.children ?? []) {
    const bytes = record(child, at)
    parts.push(bytes)
    at += bytes.byteLength
  }
  if (parts.length > 0) {
    parts.push(Buffer.alloc(13))
    at += 13
  }
  const header = Buffer.alloc(13)
  header.writeUInt32LE(at, 0)
  header.writeUInt32LE(node.properties?.length ?? 0, 4)
  header.writeUInt32LE(properties.byteLength, 8)
  header.writeUInt8(node.name.length, 12)
  return Buffer.concat([header, Buffer.from(node.name, 'latin1'), properties, ...parts])
}

/** A binary FBX 7.4 file of top-level nodes. */
function fbxFile(nodes: readonly Node[]): Buffer {
  const version = Buffer.alloc(4)
  version.writeUInt32LE(7400)
  const header = Buffer.concat([Buffer.from('Kaydara FBX Binary  \0', 'latin1'), Buffer.from([0x1a, 0]), version])
  const records: Buffer[] = []
  let at = header.byteLength
  for (const node of nodes) {
    const bytes = record(node, at)
    records.push(bytes)
    at += bytes.byteLength
  }
  return Buffer.concat([header, ...records, Buffer.alloc(13 + 160)])
}

/** A MagicaVoxel file of one model and no scene graph. */
function voxFile(size: readonly [number, number, number], voxels: readonly (readonly [number, number, number, number])[]): Buffer {
  const chunk = (id: string, content: Buffer): Buffer => {
    const header = Buffer.alloc(12)
    header.write(id, 0, 'latin1')
    header.writeUInt32LE(content.byteLength, 4)
    return Buffer.concat([header, content])
  }
  const sizes = Buffer.alloc(12)
  size.forEach((value, index) => { sizes.writeUInt32LE(value, index * 4) })
  const count = Buffer.alloc(4)
  count.writeUInt32LE(voxels.length)
  const version = Buffer.alloc(4)
  version.writeUInt32LE(150)
  return Buffer.concat([Buffer.from('VOX ', 'latin1'), version, chunk('SIZE', sizes), chunk('XYZI', Buffer.concat([count, Buffer.from(voxels.flat())]))])
}

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-assets-cost-')))
  await mkdir(join(root, 'models', 'textures'), { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The cost of a model in the project, by a counter of its own unless one is given. */
async function costOf(
  path: string,
  decoder: ModelDecoder,
  costs = new ModelCosts({ entries: 8, parses: 2 }),
  signal = new AbortController().signal,
): Promise<ModelCost> {
  const absolute = join(root, path)
  const info = await stat(absolute)
  return await costs.cost({ path: absolute, decoder, size: info.size, mtimeMs: info.mtimeMs, root, maxBytes: 16 * 1024 * 1024 }, signal)
}

describe('named files', () => {
  it('resolve as the window resolves them: from the model\'s folder, an absolute name by its file name, never out of the folder it reads', () => {
    const model = join(root, 'models', 'hero.obj')
    expect(namedPath(root, model, 'hero.mtl')).toBe(join(root, 'models', 'hero.mtl'))
    expect(namedPath(root, model, '../shared/skin%20base.png')).toBe(join(root, 'shared', 'skin base.png'))
    expect(namedPath(root, model, 'C:\\Users\\artist\\skin.png')).toBe(join(root, 'models', 'skin.png'))
    expect(namedPath(root, model, '/Users/artist/skin.png')).toBe(join(root, 'models', 'skin.png'))
    for (const reference of ['../../outside.png', 'https://tracker.example/t.png', 'https%3A%2F%2Ftracker.example%2Ft.png', 'data:image/png;base64,AAAA']) {
      expect(namedPath(root, model, reference), reference).toBeUndefined()
    }
    expect(namedPath(root, '/elsewhere/hero.obj', 'hero.mtl')).toBeUndefined()
  })

  it('of an MTL file are its texture maps, the first of each kind in each material, without their options', () => {
    expect(mtlTextures([
      'newmtl a', 'map_Kd a.png', 'map_kd ignored.png', 'map_Bump -bm 0.5 a_n.png', 'bump b.png', 'Kd 1 1 1', '# map_Ks comment.png',
      'newmtl b', 'map_Ks -s 1 1 1 -o 0 0 0 shiny.png', 'map_d https://tracker.example/t.png', 'disp height map.png',
    ].join('\r\n'))).toEqual(['a.png', 'a_n.png', 'shiny.png', 'height map.png'])
  })
})

describe('image headers', () => {
  it('state the pixels of PNG, JPEG, GIF, WebP, BMP, and TGA textures', () => {
    expect(imagePixels(png(64, 32), 'a.png')).toEqual({ width: 64, height: 32 })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 40, 3, 0, 0, 0, 0])
    expect(imagePixels(jpeg, 'a.jpg')).toEqual({ width: 40, height: 20 })
    expect(imagePixels(Buffer.from('GIF89a\x10\x00\x08\x00\x00\x00\x00', 'latin1'), 'a.gif')).toEqual({ width: 16, height: 8 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'latin1')
    webp.write('WEBPVP8X', 8, 'latin1')
    webp.writeUIntLE(99, 24, 3)
    webp.writeUIntLE(49, 27, 3)
    expect(imagePixels(webp, 'a.webp')).toEqual({ width: 100, height: 50 })
    const bmp = Buffer.alloc(26)
    bmp.write('BM', 0, 'latin1')
    bmp.writeInt32LE(12, 18)
    bmp.writeInt32LE(-6, 22)
    expect(imagePixels(bmp, 'a.bmp')).toEqual({ width: 12, height: 6 })
    const tga = Buffer.alloc(18)
    tga.writeUInt16LE(5, 12)
    tga.writeUInt16LE(7, 14)
    expect(imagePixels(tga, 'skin.TGA')).toEqual({ width: 5, height: 7 })
    expect(imagePixels(Buffer.from('not an image'), 'a.png')).toBeUndefined()
  })
})

describe('model costs', () => {
  it('count a glTF model\'s buffers and images, and its images decoded', async () => {
    await writeFile(join(root, 'models', 'tree.bin'), Buffer.alloc(100))
    await writeFile(join(root, 'models', 'textures', 'bark.png'), png(10, 10))
    await writeFile(join(root, 'models', 'tree.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'tree.bin' }], images: [{ uri: 'textures/bark.png' }, { uri: 'textures/bark.png' }] }))
    expect(await costOf('models/tree.gltf', 'gltf')).toEqual({ named: 2, namedBytes: 100 + 29, memory: 10 * 10 * 4 })
  })

  it('count an OBJ file\'s first material library and its textures, decoded', async () => {
    const library = 'newmtl skin\nmap_Kd ../textures/skin.png\nmap_Ks spec.tga\n'
    await mkdir(join(root, 'models', 'mat'), { recursive: true })
    await writeFile(join(root, 'models', 'mat', 'hero.mtl'), library)
    await writeFile(join(root, 'models', 'textures', 'skin.png'), png(8, 8))
    const tga = Buffer.alloc(18)
    tga.writeUInt16LE(4, 12)
    tga.writeUInt16LE(4, 14)
    await writeFile(join(root, 'models', 'mat', 'spec.tga'), tga)
    // The library line may lie past the first chunk the search reads.
    await writeFile(join(root, 'models', 'hero.obj'), `${'v 0 0 0\n'.repeat(200_000)}mtllib mat/hero.mtl\nmtllib other.mtl\n`)
    expect(await costOf('models/hero.obj', 'obj')).toEqual({ named: 3, namedBytes: library.length + 29 + 18, memory: 8 * 8 * 4 + 4 * 4 * 12 })
  })

  it('count a Collada file\'s images, as their names read', async () => {
    await writeFile(join(root, 'models', 'textures', 'a & b.png'), png(2, 2))
    await writeFile(join(root, 'models', 'hero.dae'), [
      '<COLLADA><library_images>',
      '<image id="a"><init_from>textures/a &amp; b.png</init_from></image>',
      '<image id="b"><init_from><ref>textures/gone.png</ref></init_from></image>',
      '</library_images><library_effects/></COLLADA>',
    ].join('\n'))
    expect(await costOf('models/hero.dae', 'dae')).toEqual({ named: 2, namedBytes: 29, memory: 2 * 2 * 4 })
  })

  it('count an FBX file\'s nodes and arrays, its embedded images decoded, and its images in files of their own', async () => {
    await writeFile(join(root, 'models', 'skin.png'), png(4, 4))
    const file = fbxFile([{
      name: 'Objects',
      children: [
        { name: 'Geometry', properties: [property.long(1)], children: [{ name: 'Vertices', properties: [property.doubles(1000, Buffer.alloc(8000))] }] },
        { name: 'Video', properties: [property.long(2)], children: [{ name: 'RelativeFilename', properties: [property.string('embedded.png')] }, { name: 'Content', properties: [property.raw(png(16, 16))] }] },
        { name: 'Video', properties: [property.long(3)], children: [{ name: 'RelativeFilename', properties: [property.string('C:\\art\\skin.png')] }] },
      ],
    }])
    await writeFile(join(root, 'models', 'hero.fbx'), file)
    const cost = await costOf('models/hero.fbx', 'fbx')
    expect([cost.named, cost.namedBytes]).toEqual([1, 29])
    // Eight nodes, the array inflated and as numbers, the raw image, the strings, and both images decoded.
    expect(cost.memory).toBeGreaterThan(8 * 200 + 8000 + 8000 + 16 * 16 * 4 + 4 * 4 * 4)
    // A text FBX file names its images in files of their own by their lines.
    await writeFile(join(root, 'models', 'text.fbx'), 'Objects:  {\n\tVideo: 2, "Video::skin", "Clip" {\n\t\tProperties70:  {\n\t\t}\n\t\tRelativeFilename: "skin.png"\n\t}\n}\n')
    expect(await costOf('models/text.fbx', 'fbx')).toMatchObject({ named: 1, namedBytes: 29 })
  })

  it('count a VOX file\'s meshes, and nothing for one the window refuses as larger than MagicaVoxel makes', async () => {
    await writeFile(join(root, 'models', 'pair.vox'), voxFile([2, 2, 2], [[0, 0, 0, 1], [1, 0, 0, 1]]))
    expect(await costOf('models/pair.vox', 'vox')).toEqual({ named: 0, namedBytes: 0, memory: 8 + 10 * 384 })
    await writeFile(join(root, 'models', 'huge.vox'), voxFile([1024, 1024, 1024], []))
    expect(await costOf('models/huge.vox', 'vox')).toEqual({ named: 0, namedBytes: 0, memory: 0 })
  })

  it('count nothing named outside the folder the window reads, by real path, nor a file larger than it reads', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'dsh-game-assets-cost-outside-'))
    try {
      await writeFile(join(outside, 'secret.bin'), Buffer.alloc(500))
      await symlink(join(outside, 'secret.bin'), join(root, 'models', 'linked.bin'))
      await writeFile(join(root, 'models', 'big.bin'), Buffer.alloc(17 * 1024 * 1024))
      await writeFile(join(root, 'models', 'tree.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'linked.bin' }, { uri: 'big.bin' }] }))
      expect(await costOf('models/tree.gltf', 'gltf')).toEqual({ named: 2, namedBytes: 0, memory: 0 })
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('count at most MAX_NAMED_FILES of a model\'s files, and report how many it names', async () => {
    await writeFile(join(root, 'models', 't0.png'), Buffer.alloc(7))
    const images = Array.from({ length: MAX_NAMED_FILES + 5 }, (_, index) => ({ uri: `t${String(index)}.png` }))
    await writeFile(join(root, 'models', 'many.gltf'), JSON.stringify({ asset: { version: '2.0' }, images }))
    expect(await costOf('models/many.gltf', 'gltf')).toEqual({ named: MAX_NAMED_FILES + 5, namedBytes: 7, memory: 0 })
  })

  it('keep a model file\'s findings by its size and modification time, reading the files it names on every call', async () => {
    const costs = new ModelCosts({ entries: 8, parses: 2 })
    const model = join(root, 'models', 'tree.gltf')
    const description = (uri: string): string => JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri }] })
    await writeFile(join(root, 'models', 'a.bin'), Buffer.alloc(100))
    await writeFile(join(root, 'models', 'b.bin'), Buffer.alloc(200))
    await writeFile(model, description('a.bin'))
    const mtime = new Date(1_700_000_000_000)
    await utimes(model, mtime, mtime)
    expect((await costOf('models/tree.gltf', 'gltf', costs)).namedBytes).toBe(100)
    // Rewritten to the same size and time, the model keeps its findings; the file it names is read again.
    await writeFile(model, description('b.bin'))
    await utimes(model, mtime, mtime)
    await writeFile(join(root, 'models', 'a.bin'), Buffer.alloc(150))
    expect((await costOf('models/tree.gltf', 'gltf', costs)).namedBytes).toBe(150)
    // A new modification time reads the model again.
    await utimes(model, mtime, new Date(mtime.getTime() + 5000))
    expect((await costOf('models/tree.gltf', 'gltf', costs)).namedBytes).toBe(200)
  })

  it.skipIf(process.platform === 'win32')('read at most the configured number of model files at once', async () => {
    // A named pipe holds its reader until something writes to it.
    const pipe = join(root, 'models', 'pipe.gltf')
    execFileSync('mkfifo', [pipe])
    await writeFile(join(root, 'models', 'a.bin'), Buffer.alloc(100))
    await writeFile(join(root, 'models', 'tree.gltf'), JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'a.bin' }] }))
    const costs = new ModelCosts({ entries: 8, parses: 1 })
    const held = costs.cost({ path: pipe, decoder: 'gltf', size: 0, mtimeMs: 0, root, maxBytes: 1024 }, new AbortController().signal)
    let settled = false
    const waiting = costOf('models/tree.gltf', 'gltf', costs).then((cost) => {
      settled = true
      return cost
    })
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(settled).toBe(false)
    // A call that ends while it waits stops waiting; the model goes on being read for the call that waits.
    const ended = new AbortController()
    const abandoned = costOf('models/tree.gltf', 'gltf', costs, ended.signal)
    ended.abort(new Error('the call ended'))
    await expect(abandoned).rejects.toThrow('the call ended')
    const writer = await open(pipe, 'w')
    await writer.write('{"asset":{"version":"2.0"}}')
    await writer.close()
    expect(await held).toEqual({ named: 0, namedBytes: 0, memory: 0 })
    expect((await waiting).namedBytes).toBe(100)
  })
})
