/** sclang post output for the bridge: reply lines, the output between them, its bound, and startup lines. */
import { describe, expect, it } from 'vitest'
import { BoundedText, OUTPUT_LIMIT, SclangOutputParser } from '../src/sclang-output.ts'

describe('BoundedText', () => {
  it('keeps short text whole and resets when taken', () => {
    const text = new BoundedText(10)
    text.append('abc')
    text.append('de')
    expect(text.take()).toBe('abcde')
    expect(text.take()).toBe('')
  })

  it('keeps the first and last halves of long text and counts the characters between them', () => {
    const text = new BoundedText(10)
    text.append('0123')
    text.append('456789abcdef')
    text.append('ghij')
    expect(text.take()).toBe('01234\n[10 characters of output omitted]\nfghij')
    text.append('x'.repeat(5))
    text.append('y'.repeat(5))
    expect(text.take()).toBe('xxxxxyyyyy')
  })
})

function parse(token = 'abc') {
  const events: (readonly [string, ...unknown[]])[] = []
  const parser = new SclangOutputParser(token, {
    ready: payload => events.push(['ready', payload]),
    reply: (id, payload, output) => events.push(['reply', id, payload, output]),
    startupLine: line => events.push(['startup', line]),
  })
  return { events, push: (text: string | Buffer) => { parser.push(typeof text === 'string' ? Buffer.from(text) : text) } }
}

describe('SclangOutputParser', () => {
  it('reports startup lines until the ready line, then the output before each reply', () => {
    const { events, push } = parse()
    push('compiling class library...\nWelcome\n\nabc READY {"version":"3.14.1"}\n')
    push('posted\n\nabc END 1 {"ok":true,"result":{}}\n')
    push('no newline')
    push('\nabc END 2 {"ok":true,"result":{}}\n\nabc END 3 {}\n')
    expect(events).toEqual([
      ['startup', 'compiling class library...'],
      ['startup', 'Welcome'],
      ['startup', ''],
      ['ready', '{"version":"3.14.1"}'],
      ['reply', 1, '{"ok":true,"result":{}}', 'posted\n'],
      ['reply', 2, '{"ok":true,"result":{}}', 'no newline'],
      ['reply', 3, '{}', ''],
    ])
  })

  it('joins lines and characters split across chunks, ignores reply lines before boot, and drops Server noise', () => {
    const { events, push } = parse('tok')
    push('tok END 9 {}\n')
    push('tok REA')
    push('DY {}\n')
    const euro = Buffer.from('€\n')
    push(euro.subarray(0, 1))
    push(Buffer.concat([euro.subarray(1), Buffer.from('record : setting clientID to 0.\ntok END x y\nmore\ntok END 4 ok\n')]))
    expect(events).toEqual([
      ['startup', 'tok END 9 {}'],
      ['ready', '{}'],
      ['reply', 4, 'ok', '€\ntok END x y\nmore'],
    ])
  })

  it('bounds the output of one reply', () => {
    const { events, push } = parse()
    push('abc READY {}\n')
    push(`${'a'.repeat(OUTPUT_LIMIT)}\n${'b'.repeat(OUTPUT_LIMIT)}\n\nabc END 1 {}\n`)
    const output = String(events[1]?.[3])
    expect(output.startsWith('a'.repeat(OUTPUT_LIMIT / 2))).toBe(true)
    expect(output).toMatch(/\[\d+ characters of output omitted\]\nb+\n$/u)
    expect(output.length).toBeLessThan(OUTPUT_LIMIT + 100)
  })
})
