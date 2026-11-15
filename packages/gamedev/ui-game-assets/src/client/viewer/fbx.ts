/**
 * The memory three.js's FBXLoader would take to parse an FBX file, counted before it parses it. A binary file's nodes
 * are walked as the loader walks them, counting each node, each array as the JavaScript numbers the loader makes of it,
 * and each raw property it copies. While the count stays within the limit, each zlib-compressed array is inflated in
 * small steps up to the length it states, and one whose data inflates past that is refused, since the loader inflates
 * all of it at once before it reads the length it needs; an array that the limit has no room for is counted by the
 * length it states without inflating it, so the inflating stays within the limit too. A text file's parse is counted at
 * {@link FBX_TEXT_BYTES_PER_BYTE} of its size.
 */
import { Unzlib } from 'three/examples/jsm/libs/fflate.module.js'

/** Bytes the loader's objects take for each node of the file: the node and its property list. */
export const FBX_NODE_BYTES = 200

/** Bytes of a JavaScript array element, as the loader stores each value of an array. */
const ARRAY_ELEMENT_BYTES = 8

/** Memory a text FBX file's parse takes for each of its bytes: its text, its lines, and the numbers it lists. */
export const FBX_TEXT_BYTES_PER_BYTE = 8

/** Compressed bytes inflated at a time, so that one step makes at most about a megabyte. */
const INFLATE_STEP = 1024

/** An FBX array whose compressed data inflates past the length it states. */
export class FbxInflateError extends Error {
  /** @param declared - the bytes the array states. */
  constructor(readonly declared: number) {
    super(`an FBX array's data inflates past the ${String(declared)} bytes it states`)
    this.name = 'FbxInflateError'
  }
}

/** The binary header, `Kaydara FBX Binary  ` and a NUL, as the loader tests it. */
const BINARY_MAGIC = 'Kaydara FBX Binary  \0'

/** Bytes of each element of the array property types. */
const ELEMENT_BYTES: Readonly<Record<string, number>> = { b: 1, c: 1, d: 8, f: 4, i: 4, l: 8 }

/**
 * Whether compressed data inflates to at most a length, inflating it a step at a time.
 * @throws {FbxInflateError} once it passes the length; fflate's own error for data that is not zlib.
 */
function checkInflate(compressed: Uint8Array, declared: number): void {
  let inflated = 0
  const stream = new Unzlib((chunk) => {
    inflated += chunk.length
    if (inflated > declared) throw new FbxInflateError(declared)
  })
  for (let at = 0; at < compressed.length; at += INFLATE_STEP) {
    const end = Math.min(compressed.length, at + INFLATE_STEP)
    stream.push(compressed.subarray(at, end), end === compressed.length)
  }
}

/** A reader over the file that throws where the loader's DataView throws, past the end. */
class Reader {
  private readonly view: DataView
  at = 0

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  u8(): number {
    return this.view.getUint8(this.at++)
  }

  u32(): number {
    const value = this.view.getUint32(this.at, true)
    this.at += 4
    return value
  }

  u64(): number {
    const low = this.u32()
    return this.u32() * 0x1_0000_0000 + low
  }

  skip(bytes: number): void {
    if (this.at + bytes > this.data.byteLength) throw new RangeError('the FBX file ends inside a property')
    this.at += bytes
  }
}

/**
 * Where the loader stops reading top-level nodes: at the footer, 160 bytes and up to 16 of padding before the end.
 */
function endOfContent(reader: Reader): boolean {
  const size = reader.data.byteLength
  return size % 16 === 0 ? ((reader.at + 160 + 16) & ~0xf) >= size : reader.at + 160 + 16 >= size
}

/**
 * Count one property as the loader reads it.
 * @param room - the bytes left within the limit; a compressed array larger than that is not inflated.
 * @returns the bytes the loader keeps of it.
 * @throws {FbxInflateError} for compressed data that inflates past the array's length; {RangeError} past the end of
 * the file and {Error} for an unknown property type, where the loader fails too.
 */
function property(reader: Reader, room: number): number {
  const type = String.fromCharCode(reader.u8())
  switch (type) {
    case 'C':
      reader.skip(1)
      return 0
    case 'Y':
      reader.skip(2)
      return 0
    case 'F':
    case 'I':
      reader.skip(4)
      return 0
    case 'D':
    case 'L':
      reader.skip(8)
      return 0
    case 'R': {
      // The loader copies the bytes, as many as the file holds.
      const length = reader.u32()
      const copied = Math.min(length, reader.data.byteLength - reader.at)
      reader.at += length
      return copied
    }
    case 'S': {
      const length = reader.u32()
      reader.skip(length)
      return length * 2
    }
    default: {
      const element = ELEMENT_BYTES[type]
      if (element === undefined) throw new Error(`an FBX property of the unknown type ${type}`)
      const length = reader.u32()
      const encoding = reader.u32()
      const compressed = reader.u32()
      if (encoding === 0) {
        // The loader reads the elements one by one up to the end of the file.
        const elements = Math.min(length, Math.floor((reader.data.byteLength - reader.at) / element))
        reader.skip(elements * element)
        return elements * ARRAY_ELEMENT_BYTES
      }
      const start = reader.at
      const data = reader.data.subarray(start, Math.min(reader.data.byteLength, start + compressed))
      reader.at += compressed
      const bytes = data.byteLength + length * element + length * ARRAY_ELEMENT_BYTES
      if (bytes <= room) checkInflate(data, length * element)
      return bytes
    }
  }
}

/**
 * Count the memory the loader takes to parse an FBX file.
 * @param data - the file.
 * @param limit - the most memory the caller lets the loader take; arrays past it are counted without inflating them.
 * @returns the bytes counted.
 * @throws {FbxInflateError} for a compressed array within the limit whose data inflates past its stated length;
 * {Error} where the loader fails to read the file.
 */
export function fbxBytes(data: Uint8Array, limit: number): number {
  if (data.byteLength < BINARY_MAGIC.length || String.fromCharCode(...data.subarray(0, BINARY_MAGIC.length)) !== BINARY_MAGIC) {
    return data.byteLength * FBX_TEXT_BYTES_PER_BYTE
  }
  const reader = new Reader(data)
  reader.skip(23)
  const version = reader.u32()
  // The loader refuses older versions before it reads a node.
  if (version < 6400) return 0
  const wide = version >= 7500
  let bytes = 0
  // The end offsets of the nodes whose children are being read, innermost last.
  const open: number[] = []
  for (;;) {
    const parent = open.at(-1)
    if (parent === undefined ? endOfContent(reader) : parent <= reader.at) {
      if (parent === undefined) break
      open.pop()
      continue
    }
    const end = wide ? reader.u64() : reader.u32()
    const properties = wide ? reader.u64() : reader.u32()
    if (wide) reader.u64()
    else reader.u32()
    reader.skip(reader.u8())
    // A node whose end offset is 0 marks the end of a list of nodes, and holds nothing.
    if (end === 0) continue
    bytes += FBX_NODE_BYTES
    for (let index = 0; index < properties; index++) bytes += property(reader, limit - bytes)
    open.push(end)
  }
  return bytes
}
