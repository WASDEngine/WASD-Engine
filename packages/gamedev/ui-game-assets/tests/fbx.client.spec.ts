/**
 * Counting the memory three.js's FBXLoader takes to parse a binary FBX file, before it parses it: its nodes, arrays,
 * strings, and raw bytes; a compressed array inflated only up to the length it states, and one too large for the limit
 * counted without inflating it.
 */
import { describe, expect, it } from 'vitest'
import { FBX_NODE_BYTES, FBX_TEXT_BYTES_PER_BYTE, fbxBytes, FbxInflateError } from '../src/client/viewer/fbx.ts'
import { fbx, fbxFile } from './model-files.client.ts'

const LIMIT = 256 * 1024 * 1024

describe('fbxBytes', () => {
  it('counts each node, each array as JavaScript numbers, each string, and each raw property', () => {
    const file = fbxFile([{
      name: 'Objects',
      children: [{
        name: 'Geometry',
        properties: [fbx.long(1), fbx.string('Geometry::cube'), fbx.string('Mesh')],
        children: [{ name: 'Vertices', properties: [fbx.doubles(3, [0, 1, 2])] }],
      }, {
        name: 'Video',
        properties: [fbx.long(2)],
        children: [{ name: 'Content', properties: [fbx.raw(new Uint8Array(10))] }],
      }],
    }])
    // Five nodes; strings at two bytes a character; three numbers; ten raw bytes.
    expect(fbxBytes(file, LIMIT)).toBe(5 * FBX_NODE_BYTES + 2 * ('Geometry::cube'.length + 'Mesh'.length) + 3 * 8 + 10)
  })

  it('counts a compressed array by the length it states once its data inflates to no more than that', () => {
    const values = new Uint8Array(new Float64Array(1000).buffer)
    const file = fbxFile([{ name: 'Vertices', properties: [fbx.doubles(1000, [], values)] }])
    const compressed = file.byteLength - 27 - 13 - 160 - (13 + 'Vertices'.length + 13)
    expect(fbxBytes(file, LIMIT)).toBe(FBX_NODE_BYTES + compressed + 8000 + 8000)
  })

  it('refuses an array whose compressed data inflates past the length it states, inflating no more than that', () => {
    // 16 MB of zeros, deflated to about 16 KB, in an array that states four values.
    const bomb = fbxFile([{ name: 'Vertices', properties: [fbx.doubles(4, [], new Uint8Array(16 * 1024 * 1024))] }])
    expect(bomb.byteLength).toBeLessThan(64 * 1024)
    const started = performance.now()
    expect(() => fbxBytes(bomb, LIMIT)).toThrow(FbxInflateError)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  it('counts an array too large for the limit by the length it states, without inflating its data', () => {
    // Two billion values, past any limit, whose data is not even zlib, which an inflate would refuse.
    const array = new Uint8Array(20)
    const view = new DataView(array.buffer)
    view.setUint32(0, 2_000_000_000, true)
    view.setUint32(4, 1, true)
    view.setUint32(8, 8, true)
    array.fill(0xab, 12)
    const garbled = fbxFile([{ name: 'Vertices', properties: [{ type: 'd', bytes: array }] }])
    expect(fbxBytes(garbled, LIMIT)).toBe(FBX_NODE_BYTES + 8 + 2_000_000_000 * 16)
  })

  it('counts a text FBX file by its size, and an FBX version the loader refuses as nothing', () => {
    const text = new TextEncoder().encode('; FBX 7.4.0 project file\nObjects: {\n}\n')
    expect(fbxBytes(text, LIMIT)).toBe(text.byteLength * FBX_TEXT_BYTES_PER_BYTE)
    const old = fbxFile([{ name: 'Objects' }])
    new DataView(old.buffer).setUint32(23, 6100, true)
    expect(fbxBytes(old, LIMIT)).toBe(0)
  })

  it('fails where the loader fails: an unknown property type, or a property past the end of the file', () => {
    expect(() => fbxBytes(fbxFile([{ name: 'Odd', properties: [{ type: 'Q', bytes: new Uint8Array(4) }] }]), LIMIT)).toThrow('unknown type Q')
    // A file that ends inside a string, long enough that the loader reads its first node.
    const cut = fbxFile([{ name: 'Name', properties: [fbx.string('x'.repeat(400))] }])
    expect(() => fbxBytes(cut.subarray(0, 300), LIMIT)).toThrow(RangeError)
  })
})
