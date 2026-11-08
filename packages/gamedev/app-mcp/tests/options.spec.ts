/** The server options codec, one base64url argv entry carrying a JSON object, and the validation of the shared fields. */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AppServerOptionFields, decodeServerOptions, encodeServerOptions, parseAppServerOptions } from '../src/options.ts'
import type { JsonObject } from '../src/types.ts'

describe('parseAppServerOptions', () => {
  const Options = z.strictObject({ ...AppServerOptionFields, consolePath: z.string() })
  const valid = {
    dataRoot: '/data/paint', requestTimeoutMs: 600_000, toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536,
    maxWorkers: 4, workerIdleTimeoutMs: 600_000, consolePath: '',
  }

  it('returns the shared and the server-specific fields', () => {
    expect(parseAppServerOptions('Paint', Options, { ...valid })).toEqual(valid)
  })

  const { maxLogBytes: _omitted, ...withoutMaxLogBytes } = valid

  it.each<[string, JsonObject, string]>([
    ['an empty dataRoot', { ...valid, dataRoot: '' }, 'dataRoot'],
    ['a zero budget', { ...valid, requestTimeoutMs: 0 }, 'requestTimeoutMs'],
    ['a fractional budget', { ...valid, graceMs: 1.5 }, 'graceMs'],
    ['a missing field', withoutMaxLogBytes, 'maxLogBytes'],
    ['a server-specific field of the wrong type', { ...valid, consolePath: 3 }, 'consolePath'],
    ['an unknown field', { ...valid, extra: true }, 'extra'],
  ])('names %s', (_case, value, field) => {
    expect(() => parseAppServerOptions('Paint', Options, value)).toThrow(new RegExp(`^Paint MCP server options are invalid: [\\s\\S]*${field}`, 'u'))
  })
})

const argv = (options: string): string[] => ['/usr/bin/node', '/app/lib/mcp-server.js', options]

describe('server options', () => {
  it('round-trips nested JSON, including text the MCP manager would read as a template', () => {
    const options: JsonObject = {
      dataRoot: '/Users/a b/Library/WASD Engine/blender',
      template: '${credential:KEY} stays literal',
      nested: { list: [1, 2.5, -3, null, true, 'ü€😀'], empty: {} },
    }
    const encoded = encodeServerOptions(options)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u)
    expect(encoded).not.toContain('${')
    expect(decodeServerOptions(argv(encoded))).toEqual(options)
  })

  it('round-trips an empty object', () => {
    expect(decodeServerOptions(argv(encodeServerOptions({})))).toEqual({})
  })

  it('reads only argv[2]', () => {
    expect(decodeServerOptions([...argv(encodeServerOptions({ a: 1 })), 'ignored'])).toEqual({ a: 1 })
  })

  it.each([
    ['missing options', ['/usr/bin/node', '/app/lib/mcp-server.js'], 'it is missing'],
    ['empty options', argv(''), 'it is not canonical unpadded base64url text'],
    ['standard base64 characters', argv(`${encodeServerOptions({ a: 1 })}+/`), 'it is not canonical unpadded base64url text'],
    ['padding', argv(`${Buffer.from('{}').toString('base64url')}=`), 'it is not canonical unpadded base64url text'],
    ['an impossible length', argv('e30ab'), 'it is not canonical unpadded base64url text'],
    ['non-canonical trailing bits', argv('e31'), 'it is not canonical unpadded base64url text'],
    ['bytes that are not UTF-8', argv(Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url')), 'it does not decode to UTF-8 JSON'],
    ['text that is not JSON', argv(Buffer.from('{dataRoot').toString('base64url')), 'it does not decode to UTF-8 JSON'],
    ['a JSON array', argv(Buffer.from('[1]').toString('base64url')), 'it decodes to JSON that is not an object'],
    ['JSON null', argv(Buffer.from('null').toString('base64url')), 'it decodes to JSON that is not an object'],
  ])('rejects %s with an actionable TypeError', (_case, input, reason) => {
    expect(() => decodeServerOptions(input)).toThrow(TypeError)
    expect(() => decodeServerOptions(input)).toThrow(
      `app MCP server: argv[2] must hold the base64url server options that registerAppMcpServer passes; ${reason}`,
    )
  })

  it('keeps the parse error as the cause', () => {
    let caught: unknown
    try {
      decodeServerOptions(argv(Buffer.from('{').toString('base64url')))
    } catch (error) {
      caught = error
    }
    expect((caught as Error).cause).toBeInstanceOf(SyntaxError)
  })
})
