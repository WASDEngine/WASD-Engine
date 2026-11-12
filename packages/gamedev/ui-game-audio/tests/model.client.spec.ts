/**
 * The Audio tab's state outside React: the walk for sounds, the list rows, one Session's source with its header
 * probes, the waveform shape, and how times and levels read.
 */
import { audioFormatOf } from '@deepseek-ai/dsh-game-audio/audio'
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { describe, expect, it, vi } from 'vitest'
import { clockText, decibelText, kilohertzText, lengthValue } from '../src/client/format.ts'
import { waveformPath, waveformPeaks } from '../src/client/peaks.ts'
import { listRows, shownSounds, soundItems, stepSound } from '../src/client/rows.ts'
import { scanSounds, type SoundEntry, type SoundScan } from '../src/client/scan.ts'
import { AudioSource, FRESH_SCAN_MS } from '../src/client/source.ts'
import { FakeAudioBuffer } from './webaudio.client.ts'

/** The project: folders by workspace path; a trailing `/` marks a folder. */
const PROJECT: Readonly<Record<string, readonly string[]>> = {
  '': ['audio/', '.godot/', 'node_modules/', 'project.godot', 'title.ogg'],
  audio: ['sfx/', 'voice/', 'theme.mp3', 'theme.mp3.import'],
  'audio/sfx': ['jump.wav', 'coin.wav'],
  'audio/voice': ['hello.wav'],
  '.godot': ['cache.wav'],
  node_modules: ['ignored.wav'],
}

function listing(path: string): RemoteResult<WorkspaceDirectoryListing> {
  const key = path === '.' ? '' : path
  const names = PROJECT[key]
  if (names === undefined) return { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path }) }
  const entries = names.map(name => name.endsWith('/') ? { name: name.slice(0, -1), type: 'directory' as const } : { name, type: 'file' as const, size: 10 })
  return { ok: true, value: { path: key, entries, truncated: false } }
}

function entry(path: string, bytes?: number): SoundEntry {
  const slash = path.lastIndexOf('/')
  const format = audioFormatOf(path)
  if (format === undefined) throw new Error(`no format for ${path}`)
  return { path, name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash), format, ...bytes === undefined ? {} : { bytes } }
}

describe('scanSounds', () => {
  it('walks folder level by folder level for sounds, skipping hidden folders and node_modules', async () => {
    const list = vi.fn(async (path: string) => listing(path))
    const result = await scanSounds(list, { maxFolders: 100, maxSounds: 100 }, new AbortController().signal)
    expect(result.ok && result.value.sounds.map(sound => sound.path)).toEqual(['title.ogg', 'audio/theme.mp3', 'audio/sfx/coin.wav', 'audio/sfx/jump.wav', 'audio/voice/hello.wav'])
    expect(result.ok && result.value).toMatchObject({ truncated: false, unreadable: 0 })
    expect(list.mock.calls.map(call => call[0]).sort()).toEqual(['.', 'audio', 'audio/sfx', 'audio/voice'])
  })

  it('stops at the folder and sound caps, counts unreadable folders, and fails with the project folder', async () => {
    const capped = await scanSounds(async path => listing(path), { maxFolders: 2, maxSounds: 100 }, new AbortController().signal)
    expect(capped.ok && capped.value).toMatchObject({ truncated: true })
    expect(capped.ok && capped.value.sounds.map(sound => sound.path)).toEqual(['title.ogg', 'audio/theme.mp3'])
    const few = await scanSounds(async path => listing(path), { maxFolders: 100, maxSounds: 2 }, new AbortController().signal)
    expect(few.ok && few.value.sounds).toHaveLength(2)
    const denied = await scanSounds(async path => path === 'audio/voice'
      ? { ok: false, error: new RemoteError('workspace-file/permission-denied' as never, 'denied', {} as never) }
      : listing(path), { maxFolders: 100, maxSounds: 100 }, new AbortController().signal)
    expect(denied.ok && denied.value.unreadable).toBe(1)
    const missing = await scanSounds(async () => ({ ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: '.' }) }), { maxFolders: 1, maxSounds: 1 }, new AbortController().signal)
    expect(missing.ok).toBe(false)
  })
})

describe('the list rows', () => {
  const scan: SoundScan = {
    sounds: [entry('title.ogg', 10), entry('audio/theme.mp3', 10), entry('audio/sfx/coin.wav', 10), entry('audio/sfx/jump.wav', 10), entry('audio/voice/hello.wav', 10)],
    truncated: false,
    unreadable: 0,
  }

  it('gives each sound its kind, from its path or, once its headers were read, its length', () => {
    const before = soundItems(scan, new Map())
    expect(before.map(item => item.kind)).toEqual(['effect', 'effect', 'effect', 'effect', 'dialogue'])
    const probes = new Map([['title.ogg', { bytes: 10, probe: { format: 'Ogg Vorbis', seconds: 95 } }], ['audio/theme.mp3', { bytes: 99, probe: { format: 'MP3', seconds: 120 } }]])
    // A probe of another size is stale and left out.
    expect(soundItems(scan, probes).map(item => [item.kind, item.probe?.seconds])).toEqual([['music', 95], ['effect', undefined], ['effect', undefined], ['effect', undefined], ['dialogue', undefined]])
  })

  it('groups the shown sounds under their folders, folds a folder shut, and ranks a search', () => {
    const items = soundItems(scan, new Map())
    const all = shownSounds(items, { query: '', filter: 'all' })
    expect(listRows(all, { query: '', closed: ['audio/sfx'] }).map(row => row.type === 'folder' ? `[${row.folder}:${String(row.count)}:${String(row.open)}]` : row.item.entry.name)).toEqual([
      '[:1:true]', 'title.ogg', '[audio:1:true]', 'theme.mp3', '[audio/sfx:2:false]', '[audio/voice:1:true]', 'hello.wav',
    ])
    expect(shownSounds(items, { query: '', filter: 'dialogue' }).map(item => item.entry.name)).toEqual(['hello.wav'])
    const found = shownSounds(items, { query: 'jum', filter: 'all' })
    expect(found.map(item => item.entry.name)).toEqual(['jump.wav'])
    expect(listRows(found, { query: 'jum', closed: [] })).toEqual([{ type: 'sound', item: found[0], withFolder: true }])
  })

  it('steps through the shown sounds from the selection, from either end without one', () => {
    const rows = listRows(shownSounds(soundItems(scan, new Map()), { query: '', filter: 'all' }), { query: '', closed: [] })
    expect(stepSound(rows, undefined, 1)?.entry.path).toBe('title.ogg')
    expect(stepSound(rows, undefined, -1)?.entry.path).toBe('audio/voice/hello.wav')
    expect(stepSound(rows, 'audio/sfx/coin.wav', 1)?.entry.path).toBe('audio/sfx/jump.wav')
    expect(stepSound(rows, 'title.ogg', -1)).toBeUndefined()
  })
})

describe('AudioSource', () => {
  it('walks once while fresh, reads the headers of new and changed sounds, and drops gone ones', async () => {
    let clock = 1000
    let sizes: Record<string, number> = { 'a.wav': 10, 'b.wav': 20 }
    const list = vi.fn(async (): Promise<RemoteResult<WorkspaceDirectoryListing>> => ({
      ok: true, value: { path: '', entries: Object.entries(sizes).map(([name, size]) => ({ name, type: 'file' as const, size })), truncated: false },
    }))
    const probe = vi.fn(async (sound: SoundEntry) => ({ format: 'WAV', seconds: (sound.bytes ?? 0) / 10 }))
    const source = new AudioSource(list, probe, { maxFolders: 10, maxSounds: 10 }, () => clock, () => {})
    source.refresh()
    await vi.waitFor(() => { expect(source.probes.getSnapshot().size).toBe(2) })
    expect(source.probes.getSnapshot().get('b.wav')).toEqual({ bytes: 20, probe: { format: 'WAV', seconds: 2 } })
    source.refresh()
    expect(list).toHaveBeenCalledTimes(1)
    clock += FRESH_SCAN_MS
    sizes = { 'a.wav': 10, 'c.wav': 30, 'b.wav': 25 }
    source.refresh()
    await vi.waitFor(() => { expect(source.probes.getSnapshot().get('b.wav')?.bytes).toBe(25) })
    expect([...source.probes.getSnapshot().keys()].sort()).toEqual(['a.wav', 'b.wav', 'c.wav'])
    // a.wav kept its size, so its headers were not read again.
    expect(probe.mock.calls.map(call => call[0].path).sort()).toEqual(['a.wav', 'b.wav', 'b.wav', 'c.wav'])
    sizes = { 'c.wav': 30 }
    source.rescan()
    await vi.waitFor(() => { expect([...source.probes.getSnapshot().keys()]).toEqual(['c.wav']) })
    source.close()
  })

  it('keeps the last walk after a failure, holds the listener\'s choices, and takes each navigation once', async () => {
    let fail = false
    const source = new AudioSource(async () => fail
      ? { ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: '.' }) }
      : { ok: true, value: { path: '', entries: [], truncated: false } }, async () => undefined, { maxFolders: 1, maxSounds: 1 }, () => 0, () => {})
    source.rescan()
    await vi.waitFor(() => { expect(source.scanState.getSnapshot().status).toBe('ready') })
    fail = true
    source.rescan()
    await vi.waitFor(() => { expect(source.scanState.getSnapshot().status).toBe('failed') })
    expect(source.scanState.getSnapshot().scan?.sounds).toEqual([])
    source.select('a.wav')
    source.setQuery('boom')
    source.setFilter('music')
    source.toggleFolder('sfx')
    source.toggleFolder('voice')
    source.toggleFolder('sfx')
    expect(source.view.getSnapshot()).toEqual({ selected: 'a.wav', query: 'boom', filter: 'music', closed: ['voice'] })
    expect(source.takeNavigation('tab', 0)).toBe(false)
    expect(source.takeNavigation('tab', 3)).toBe(true)
    expect(source.takeNavigation('tab', 3)).toBe(false)
    expect(source.takeNavigation('other', 3)).toBe(true)
    source.close()
    source.rescan()
    expect(source.scanState.getSnapshot().status).toBe('failed')
  })
})

describe('the waveform', () => {
  it('finds each column\'s lowest and highest sample over every channel', () => {
    const buffer = new FakeAudioBuffer({ length: 4, numberOfChannels: 2, sampleRate: 4 })
    buffer.getChannelData(0).set([0.5, -0.25, 0, 0])
    buffer.getChannelData(1).set([0, 0.75, 0, -1])
    expect(Array.from(waveformPeaks(buffer, 2))).toEqual([-0.25, 0.75, -1, 0])
  })

  it('draws the shape through the column centers and a hairline for silence', () => {
    expect(waveformPath(new Float32Array(0))).toBe('')
    expect(waveformPath(Float32Array.from([-0.5, 0.5, 0, 0]))).toBe('M0.0,-0.5000L0.5,-0.5000L1.5,-0.0060L2.0,-0.0060L2.0,0.0060L1.5,0.0060L0.5,0.5000L0.0,0.5000Z')
  })
})

describe('the tab\'s numbers', () => {
  it('writes clock times, lengths, levels, and rates', () => {
    expect(clockText(0)).toBe('0:00.0')
    expect(clockText(61.25)).toBe('1:01.2')
    expect(clockText(3723.4)).toBe('1:02:03.4')
    expect(lengthValue(0.62)).toEqual(['0.62', true])
    expect(lengthValue(12.345)).toEqual(['12.3', true])
    expect(lengthValue(151.4)).toEqual(['2:31.4', false])
    expect(decibelText(0.5)).toBe('−6.0')
    expect(decibelText(0)).toBe('−∞')
    expect(kilohertzText(44_100)).toBe('44.1')
    expect(kilohertzText(48_000)).toBe('48')
    expect(kilohertzText(22_050)).toBe('22.05')
  })
})
