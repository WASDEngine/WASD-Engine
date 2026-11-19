/**
 * The pieces of reading model files that the Assets tab's viewer and the asset tools' cost estimate share: the viewer
 * loads models with three.js, and the estimate (`src/model-cost.ts`) reads the same files on the Host first to count
 * what the viewer would allocate, so both read OBJ material libraries, binary FBX and VOX records, and VOX meshes with
 * this code. The module has no Host dependencies; the viewer's chunk inlines it.
 * @module @deepseek-ai/dsh-game-assets/model-files
 */

/** A position in a file's bytes, read little-endian; a read past the end throws a RangeError, as a DataView does. */
export class ByteCursor {
  private readonly view: DataView

  /**
   * @param data - the file.
   * @param at - where reading starts.
   */
  constructor(readonly data: Uint8Array, public at = 0) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  /**
   * Read one byte.
   * @returns the next byte.
   */
  u8(): number {
    return this.view.getUint8(this.at++)
  }

  /**
   * Read a little-endian 32-bit number.
   * @returns the next unsigned 32-bit number.
   */
  u32(): number {
    const value = this.view.getUint32(this.at, true)
    this.at += 4
    return value
  }

  /**
   * Read a little-endian 64-bit number.
   * @returns the next unsigned 64-bit number, exact up to 2^53.
   */
  u64(): number {
    const low = this.u32()
    return this.u32() * 0x1_0000_0000 + low
  }

  /**
   * Move past bytes, back for a negative count, as a reader that steps by a stated size moves.
   * @param bytes - how far.
   * @throws {RangeError} when the move passes the end of the file.
   */
  skip(bytes: number): void {
    if (this.at + bytes > this.data.byteLength) throw new RangeError('the file ends inside a record')
    this.at += bytes
  }
}

/**
 * The name of an OBJ file's first `mtllib` statement: the rest of its line without the spaces and tabs around it, as
 * `/^[ \t]*mtllib[ \t]+(.+?)[ \t]*$/mu` captures it, read a line at a time so that a crafted line costs linear time.
 * @param text - the OBJ file, or a run of its whole lines.
 * @returns the name, or undefined when no line names a library.
 */
export function mtllibOf(text: string): string | undefined {
  for (const line of text.split(/[\n\r\u2028\u2029]/u)) {
    let at = 0
    while (line[at] === ' ' || line[at] === '\t') at++
    if (!line.startsWith('mtllib', at)) continue
    at += 'mtllib'.length
    if (line[at] !== ' ' && line[at] !== '\t') continue
    let end = line.length
    while (end > at && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--
    while (at < end && (line[at] === ' ' || line[at] === '\t')) at++
    if (at < end) return line.slice(at, end)
  }
  return undefined
}

/** One model of a VOX file: the size of its box and its voxels. */
export interface VoxVoxels {
  readonly x: number
  readonly y: number
  readonly z: number
  /** The `XYZI` chunk's voxels, four bytes each: x, y, z, and color index. */
  readonly voxels: Uint8Array
}

/**
 * The faces of a model that border no other voxel of it, as three.js's VOX mesher finds them: its voxels set into its
 * box as the mesher sets them, where a voxel outside the box may land in another cell or nowhere, then the faces of
 * each filled cell toward an empty cell or the box's edge.
 * @param model - the model.
 * @returns the exposed faces.
 */
export function exposedFaces(model: VoxVoxels): number {
  const { x: sx, y: sy, z: sz, voxels } = model
  if (voxels.length < 4) return 0
  const volume = new Uint8Array(sx * sy * sz)
  for (let at = 0; at + 3 < voxels.length; at += 4) {
    const index = (voxels[at] ?? 0) + (voxels[at + 1] ?? 0) * sx + (voxels[at + 2] ?? 0) * sx * sy
    if (index < volume.length) volume[index] = voxels[at + 3] ?? 0
  }
  let faces = 0
  const layer = sx * sy
  for (let z = 0; z < sz; z++) {
    for (let y = 0; y < sy; y++) {
      for (let x = 0, index = z * layer + y * sx; x < sx; x++, index++) {
        if (volume[index] === 0) continue
        if (x === 0 || volume[index - 1] === 0) faces++
        if (x === sx - 1 || volume[index + 1] === 0) faces++
        if (y === 0 || volume[index - sx] === 0) faces++
        if (y === sy - 1 || volume[index + sx] === 0) faces++
        if (z === 0 || volume[index - layer] === 0) faces++
        if (z === sz - 1 || volume[index + layer] === 0) faces++
      }
    }
  }
  return faces
}
