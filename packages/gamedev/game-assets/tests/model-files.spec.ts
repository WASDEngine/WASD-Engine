/** The model file readers that the Assets tab's viewer and the asset tools' cost estimate share. */
import { describe, expect, it } from 'vitest'
import { ByteCursor, exposedFaces, mtllibOf } from '../src/model-files.ts'

describe('ByteCursor', () => {
  it('reads little-endian numbers in order and refuses to move past the end', () => {
    const bytes = new Uint8Array([7, 1, 0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 9])
    const read = new ByteCursor(bytes.subarray(0, 13))
    expect(read.u8()).toBe(7)
    expect(read.u32()).toBe(1)
    expect(read.u64()).toBe(2 + 0x1_0000_0000)
    expect(read.at).toBe(13)
    expect(() => { read.skip(1) }).toThrow(RangeError)
    read.skip(-4)
    expect(read.u32()).toBe(1)
    expect(() => read.u8()).toThrow(RangeError)
  })
})

describe('mtllibOf', () => {
  it('reads an OBJ file\'s material library name a line at a time, so a crafted line costs linear time', () => {
    expect(mtllibOf('v 0 0 0\r\n  mtllib\t mat/hero.mtl \t\nmtllib other.mtl\n')).toBe('mat/hero.mtl')
    expect(mtllibOf('mtllib\nmtllibx a.mtl\n')).toBeUndefined()
    const started = performance.now()
    expect(mtllibOf(`mtllib x${' '.repeat(1_000_000)}y\n`)).toBe(`x${' '.repeat(1_000_000)}y`)
    expect(performance.now() - started).toBeLessThan(2000)
  })
})

describe('exposedFaces', () => {
  it('counts the faces of filled cells toward an empty cell or the box edge', () => {
    expect(exposedFaces({ x: 2, y: 2, z: 2, voxels: new Uint8Array([0, 0, 0, 1]) })).toBe(6)
    expect(exposedFaces({ x: 2, y: 1, z: 1, voxels: new Uint8Array([0, 0, 0, 1, 1, 0, 0, 1]) })).toBe(10)
    expect(exposedFaces({ x: 1, y: 1, z: 1, voxels: new Uint8Array(0) })).toBe(0)
  })

  it('sets a voxel outside its box where the mesher sets it, or nowhere', () => {
    // x = 2 in a box 2 wide lands in the next row's first cell; z = 9 lands past the box.
    expect(exposedFaces({ x: 2, y: 2, z: 1, voxels: new Uint8Array([2, 0, 0, 1]) })).toBe(6)
    expect(exposedFaces({ x: 2, y: 2, z: 1, voxels: new Uint8Array([0, 0, 9, 1]) })).toBe(0)
  })
})
