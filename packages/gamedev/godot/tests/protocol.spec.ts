/** Harness framing decodes partial and batched messages one at a time and rejects malformed ones. */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { encodeJsonMessage, HarnessDecoder, HarnessProtocolError, MAX_MESSAGE_BYTES, type HarnessMessage } from '../src/protocol.ts'

function message(kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(5)
  header.writeUInt32LE(payload.length + 1, 0)
  header[4] = kind
  return Buffer.concat([header, payload])
}

const hello = {
  type: 'hello', protocol: 1, token: 't', pid: 7, godot: '4.7.2', project: 'P', mainScene: 'res://main.tscn',
  displayServer: 'embedded', renderingDriver: 'metal', renderingMethod: 'forward_plus', width: 640, height: 360,
}

/** Push a chunk and decode every message it completes. */
function decode(decoder: HarnessDecoder, chunk: Buffer): HarnessMessage[] {
  decoder.push(chunk)
  const messages: HarnessMessage[] = []
  for (let message = decoder.next(); message !== undefined; message = decoder.next()) messages.push(message)
  return messages
}

function frame(seq: number): Buffer {
  const payload = Buffer.alloc(8 + 3)
  payload.writeUInt32LE(seq, 0)
  payload.writeUInt16LE(640, 4)
  payload.writeUInt16LE(360, 6)
  payload.write('jpg', 8, 'latin1')
  return message(2, payload)
}

describe('HarnessDecoder', () => {
  it('encodes a JSON request with its length and kind', () => {
    const encoded = encodeJsonMessage({ type: 'pause', id: 3 })
    expect(encoded.readUInt32LE(0)).toBe(encoded.length - 4)
    expect(encoded[4]).toBe(1)
    expect(JSON.parse(encoded.subarray(5).toString('utf8'))).toEqual({ type: 'pause', id: 3 })
  })

  it('decodes several messages in one chunk and keeps a trailing partial message', () => {
    const decoder = new HarnessDecoder(MAX_MESSAGE_BYTES)
    const bytes = Buffer.concat([message(1, Buffer.from(JSON.stringify(hello))), frame(9), frame(10)])
    const messages = decode(decoder, bytes.subarray(0, bytes.length - 3))
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ kind: 'json', message: { type: 'hello', token: 't' } })
    expect(messages[1]).toMatchObject({ kind: 'frame', frame: { seq: 9, width: 640, height: 360 } })
    const rest = decode(decoder, bytes.subarray(bytes.length - 3))
    expect(rest).toHaveLength(1)
    expect(rest[0]).toMatchObject({ kind: 'frame', frame: { seq: 10 } })
    expect(rest[0]?.kind === 'frame' && rest[0].frame.jpeg.toString('latin1')).toBe('jpg')
  })

  it('reassembles a message split inside its length prefix and byte by byte', () => {
    const decoder = new HarnessDecoder(MAX_MESSAGE_BYTES)
    const image = Buffer.concat([Buffer.from([5, 0, 0, 0]), Buffer.from('png')])
    const bytes = message(3, image)
    const decoded: HarnessMessage[] = []
    for (const byte of bytes) decoded.push(...decode(decoder, Buffer.from([byte])))
    expect(decoded).toHaveLength(1)
    expect(decoded[0]).toMatchObject({ kind: 'image', id: 5 })
    expect(decoded[0]?.kind === 'image' && decoded[0].data.toString('latin1')).toBe('png')
    expect(decode(decoder, Buffer.alloc(0))).toEqual([])
  })

  it('validates status, logs, and results', () => {
    const decoder = new HarnessDecoder(MAX_MESSAGE_BYTES)
    const status = { type: 'status', frame: 1, fps: 60, paused: false, scene: '', mouseMode: 0, width: 1, height: 1, droppedLogs: 0 }
    const logs = { type: 'logs', entries: [{ level: 'script_error', message: 'm', file: 'res://a.gd', line: 2, function: 'f', backtrace: [{ function: 'f', file: 'res://a.gd', line: 2 }], time_ms: 1 }] }
    const result = { type: 'result', id: 4, ok: true, value: 3 }
    const decoded = decode(decoder, Buffer.concat([status, logs, result].map(value => message(1, Buffer.from(JSON.stringify(value))))))
    expect(decoded.map(entry => entry.kind === 'json' && entry.message.type)).toEqual(['status', 'logs', 'result'])
    expect(decoded[2]).toMatchObject({ message: { value: 3 } })
  })

  it.each([
    ['a zero length', Buffer.from([0, 0, 0, 0])],
    ['a length over the limit', Buffer.from([0xff, 0xff, 0xff, 0x7f])],
    ['an unknown kind', message(9, Buffer.from('x'))],
    ['a short frame header', message(2, Buffer.alloc(4))],
    ['a short image header', message(3, Buffer.alloc(2))],
    ['JSON that does not parse', message(1, Buffer.from('{'))],
    ['an unknown JSON message', message(1, Buffer.from('{"type":"other"}'))],
  ])('rejects %s', (_case, bytes) => {
    expect(() => decode(new HarnessDecoder(MAX_MESSAGE_BYTES), bytes)).toThrow(HarnessProtocolError)
  })

  it('applies a lowered limit to the length prefix', () => {
    const decoder = new HarnessDecoder(8)
    expect(() => decode(decoder, message(1, Buffer.from(JSON.stringify(hello))))).toThrow(/outside 1\.\.8/u)
  })

  it('measures each message against the limit in force when it is read, also within one chunk', () => {
    const decoder = new HarnessDecoder(1024)
    const large = { type: 'logs', entries: [{ level: 'stdout', message: 'x'.repeat(4096) }] }
    decoder.push(Buffer.concat([message(1, Buffer.from(JSON.stringify(hello))), message(1, Buffer.from(JSON.stringify(large)))]))
    expect(decoder.next()).toMatchObject({ kind: 'json', message: { type: 'hello' } })
    decoder.maxMessageBytes = MAX_MESSAGE_BYTES
    expect(decoder.next()).toMatchObject({ kind: 'json', message: { type: 'logs', entries: [{ level: 'stdout' }] } })
    expect(decoder.next()).toBeUndefined()
    const strict = new HarnessDecoder(1024)
    strict.push(Buffer.concat([message(1, Buffer.from(JSON.stringify(hello))), message(1, Buffer.from(JSON.stringify(large)))]))
    expect(strict.next()).toMatchObject({ kind: 'json', message: { type: 'hello' } })
    expect(() => strict.next()).toThrow(/outside 1\.\.1024/u)
  })
})
