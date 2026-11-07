/** Log storage keeps a bounded ring with Host-wide cursors; console parsing extracts engine messages. */
import { describe, expect, it } from 'vitest'
import { isErrorEntry, LogRing, LogSequence } from '../src/logs.ts'
import { consoleLines, crashSummary, describeExit, formatSeconds, lastLines, parseEngineOutput } from '../src/output.ts'
import type { GodotLogEntry } from '../src/types.ts'

function entry(seq: number, level: GodotLogEntry['level'] = 'stdout'): GodotLogEntry {
  return { seq, runId: 'r', source: 'game', level, message: `m${seq}`, time: seq }
}

describe('LogRing', () => {
  it('evicts the oldest entries and reports reads that missed them', () => {
    const ring = new LogRing(3)
    expect(ring.lastSeq).toBe(0)
    for (const seq of [2, 4, 6, 8]) ring.push(entry(seq, seq === 4 ? 'error' : 'stdout'))
    expect(ring.last(10).map(item => item.seq)).toEqual([4, 6, 8])
    expect(ring.last(2).map(item => item.seq)).toEqual([6, 8])
    expect(ring.lastSeq).toBe(8)
    expect(ring.after(0, 10)).toMatchObject({ next: 8, missed: true })
    expect(ring.after(2, 10)).toMatchObject({ missed: false })
    expect(ring.after(4, 1)).toEqual({ entries: [entry(6)], next: 6, missed: false })
    expect(ring.after(8, 5)).toEqual({ entries: [], next: 8, missed: false })
    expect(ring.after(0, 10, isErrorEntry).entries.map(item => item.seq)).toEqual([4])
    expect(ring.filter(item => item.seq > 4).map(item => item.seq)).toEqual([6, 8])
  })

  it('pages filtered reads so the cursor never skips an unread match', () => {
    const ring = new LogRing(10)
    for (const [seq, level] of [[1, 'error'], [2, 'stdout'], [3, 'error'], [4, 'error']] as const) ring.push(entry(seq, level))
    const first = ring.after(0, 2, isErrorEntry)
    expect(first.entries.map(item => item.seq)).toEqual([1, 3])
    expect(first.next).toBe(3)
    expect(ring.after(first.next, 2, isErrorEntry).entries.map(item => item.seq)).toEqual([4])
  })

  it('reads the newest entries after a cursor', () => {
    const ring = new LogRing(5)
    for (const seq of [1, 2, 3, 4]) ring.push(entry(seq))
    expect(ring.newestAfter(1, 2).map(item => item.seq)).toEqual([3, 4])
    expect(ring.newestAfter(2, 10).map(item => item.seq)).toEqual([3, 4])
    expect(ring.newestAfter(4, 10)).toEqual([])
    const empty = new LogRing(1)
    expect(empty.newestAfter(0, 1)).toEqual([])
  })

  it('issues increasing sequence numbers', () => {
    const sequence = new LogSequence()
    expect(sequence.current()).toBe(0)
    expect([sequence.next(), sequence.next()]).toEqual([1, 2])
    expect(sequence.current()).toBe(2)
    expect(isErrorEntry(entry(1, 'shader_error'))).toBe(true)
    expect(isErrorEntry(entry(1, 'warning'))).toBe(false)
  })
})

describe('engine output', () => {
  const output = [
    '\u001b[1mGodot Engine v4.7.2\u001b[0m\r',
    'SCRIPT ERROR: Parse Error: Expected ":".',
    '          at: GDScript::reload (res://broken.gd:4)',
    '          GDScript backtrace (most recent call first):',
    'ERROR: Parameter "singleton" is null.',
    '   at: (editor/editor_node.cpp:6618)',
    'WARNING: ObjectDB instances leaked at exit.',
    'SHADER ERROR: bad shader',
    '   at: bogus line',
    'WARNING: spaced',
    '   at:  (res://y.gd:3)',
    'plain text',
    '   at: stray (res://x.gd:1)',
    '',
  ].join('\n')

  it('extracts prefixed messages with the location that follows them', () => {
    expect(parseEngineOutput(output, 'stderr', false)).toEqual([
      { level: 'script_error', message: 'Parse Error: Expected ":".', file: 'res://broken.gd', line: 4, function: 'GDScript::reload' },
      { level: 'error', message: 'Parameter "singleton" is null.', file: 'editor/editor_node.cpp', line: 6618 },
      { level: 'warning', message: 'ObjectDB instances leaked at exit.' },
      { level: 'shader_error', message: 'bad shader' },
      { level: 'warning', message: 'spaced', file: 'res://y.gd', line: 3 },
    ])
  })

  it('keeps plain lines at the stream level when asked', () => {
    const parsed = parseEngineOutput(output, 'stdout', true)
    expect(parsed[0]).toEqual({ level: 'stdout', message: 'Godot Engine v4.7.2' })
    expect(parsed.map(line => line.message)).toContain('plain text')
    expect(parsed.map(line => line.message)).toContain('   at: bogus line')
  })

  it('summarizes crashes and tails', () => {
    expect(crashSummary('x\nhandle_crash: Program crashed with signal 11\ny')).toBe('Program crashed with signal 11')
    expect(crashSummary('fine')).toBeUndefined()
    expect(lastLines('a\n\nb\nc\n', 2)).toBe('b\nc')
    expect(consoleLines('a\r\nb')).toEqual(['a', 'b'])
    expect(formatSeconds(1500)).toBe('1.5 s')
    expect(formatSeconds(60_000)).toBe('60 s')
    expect(describeExit({ exitCode: 3, signal: null })).toBe('exit code 3')
    expect(describeExit({ exitCode: null, signal: 'SIGKILL' })).toBe('signal SIGKILL')
  })
})
