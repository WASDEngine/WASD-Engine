/**
 * Reading the numbers and text of audio file headers: bytes past the end read as 0, so a short file reads as one that
 * says nothing.
 * @module @deepseek-ai/dsh-game-audio/src/audio/bytes
 */

/**
 * One byte.
 * @param bytes - the file's start.
 * @param index - its offset.
 * @returns the byte, or 0 past the end.
 */
export function byte(bytes: Uint8Array, index: number): number {
  return bytes[index] ?? 0
}

/**
 * Bytes as ASCII text.
 * @param bytes - the file's start.
 * @param offset - where the text starts.
 * @param length - how many bytes it takes.
 * @returns the text.
 */
export function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = ''
  for (let index = offset; index < offset + length; index++) text += String.fromCharCode(byte(bytes, index))
  return text
}

/**
 * A little-endian 16-bit number.
 * @param bytes - the file's start.
 * @param offset - where it starts.
 * @returns the number.
 */
export function u16le(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) | (byte(bytes, offset + 1) << 8)
}

/**
 * A little-endian 32-bit number.
 * @param bytes - the file's start.
 * @param offset - where it starts.
 * @returns the number.
 */
export function u32le(bytes: Uint8Array, offset: number): number {
  return u16le(bytes, offset) + u16le(bytes, offset + 2) * 0x10000
}
