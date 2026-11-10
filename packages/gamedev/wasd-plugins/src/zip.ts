/**
 * A ZIP writer for the upload of a Web build: files stream from disk through `node:zlib` into one archive file, so a
 * large build is never held in memory. Each entry records its CRC-32 and sizes in a data descriptor after its data;
 * already compressed formats are stored, everything else deflated. Archives stay under the 4 GiB ZIP32 limits.
 * @module @deepseek-ai/dsh-wasd-plugins/src/zip
 */
import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw, crc32 } from 'node:zlib'

/** Extensions whose data is already compressed; deflating them again only costs time. */
const STORED_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif', '.ogg', '.oga', '.mp3', '.m4a', '.mp4', '.webm', '.zip', '.woff', '.woff2',
])

const ZIP32_LIMIT = 0xffff_ffff
/** 1980-01-01 00:00, the earliest DOS date, so an archive's bytes depend only on its files. */
const DOS_DATE = 0x0021
const DOS_TIME = 0
/** General purpose flags: sizes follow the data (bit 3), names are UTF-8 (bit 11). */
const FLAGS = 0x0808

/** An archive that would pass the ZIP32 limits. */
export class ZipLimitError extends Error {
  override name = 'ZipLimitError'
}

interface WrittenEntry {
  readonly name: Buffer
  readonly method: number
  readonly crc: number
  readonly compressedSize: number
  readonly size: number
  readonly offset: number
}

/**
 * Write the files of a folder into a new ZIP archive.
 * @param root - absolute folder the names are relative to.
 * @param names - forward-slash paths of the files to store, in archive order.
 * @param destination - absolute path of the archive; it must not exist.
 * @param signal - cancellation; a cancelled archive is left incomplete for the caller to delete.
 * @returns the archive's size in bytes.
 * @throws {ZipLimitError} when a file or the archive would reach 4 GiB.
 */
export async function writeZip(root: string, names: readonly string[], destination: string, signal: AbortSignal): Promise<number> {
  const file = await open(destination, 'wx', 0o600)
  let offset = 0
  const written: WrittenEntry[] = []
  const write = async (chunk: Uint8Array): Promise<void> => {
    if (offset + chunk.length > ZIP32_LIMIT) throw new ZipLimitError('The Web build is too large to upload: its archive would reach 4 GiB.')
    await file.write(chunk)
    offset += chunk.length
  }
  try {
    for (const name of names) {
      signal.throwIfAborted()
      const encoded = Buffer.from(name, 'utf8')
      const method = STORED_EXTENSIONS.has(extname(name).toLowerCase()) ? 0 : 8
      const start = offset
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(FLAGS, 6)
      header.writeUInt16LE(method, 8)
      header.writeUInt16LE(DOS_TIME, 10)
      header.writeUInt16LE(DOS_DATE, 12)
      header.writeUInt16LE(encoded.length, 26)
      await write(header)
      await write(encoded)
      let checksum = 0
      let size = 0
      const measure = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          checksum = crc32(chunk, checksum)
          size += chunk.length
          callback(size > ZIP32_LIMIT ? new ZipLimitError(`${name} is too large to upload: it reaches 4 GiB.`) : null, chunk)
        },
      })
      const dataStart = offset
      const sink = async (source: AsyncIterable<Buffer>): Promise<void> => {
        for await (const chunk of source) await write(chunk)
      }
      const input = createReadStream(join(root, ...name.split('/')))
      if (method === 8) await pipeline(input, measure, createDeflateRaw({ level: 6 }), sink, { signal })
      else await pipeline(input, measure, sink, { signal })
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(checksum >>> 0, 4)
      descriptor.writeUInt32LE(offset - dataStart, 8)
      descriptor.writeUInt32LE(size, 12)
      written.push({ name: encoded, method, crc: checksum >>> 0, compressedSize: offset - dataStart, size, offset: start })
      await write(descriptor)
    }
    const directoryStart = offset
    for (const entry of written) {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      // Made by UNIX (3), ZIP 2.0, so the stored permissions below are read as UNIX modes.
      record.writeUInt16LE(0x0314, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(FLAGS, 8)
      record.writeUInt16LE(entry.method, 10)
      record.writeUInt16LE(DOS_TIME, 12)
      record.writeUInt16LE(DOS_DATE, 14)
      record.writeUInt32LE(entry.crc, 16)
      record.writeUInt32LE(entry.compressedSize, 20)
      record.writeUInt32LE(entry.size, 24)
      record.writeUInt16LE(entry.name.length, 28)
      // A regular file, rw-r--r--.
      record.writeUInt32LE((0o100644 << 16) >>> 0, 38)
      record.writeUInt32LE(entry.offset, 42)
      await write(record)
      await write(entry.name)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(written.length, 8)
    end.writeUInt16LE(written.length, 10)
    end.writeUInt32LE(offset - directoryStart, 12)
    end.writeUInt32LE(directoryStart, 16)
    if (written.length > 0xffff) throw new ZipLimitError('The Web build has more than 65535 files.')
    await write(end)
    return offset
  } finally {
    await file.close()
  }
}
