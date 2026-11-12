/** The Host's reads of one sound: its headers through a file handle, and how Godot imports it. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { mapLimited, probeFile, readGodotImport } from '../src/files.ts'
import { pcmWav } from './signals.ts'

const folders: string[] = []

afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

async function folder(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'dsh-game-audio-files-'))
  folders.push(created)
  return created
}

describe('probeFile', () => {
  it('reads a file\'s headers, and nothing from a missing or unreadable file', async () => {
    const work = await folder()
    const bytes = pcmWav({ sampleRate: 16_000, frames: 1600 })
    await writeFile(join(work, 'blip.wav'), bytes)
    expect(await probeFile(join(work, 'blip.wav'), bytes.length)).toMatchObject({ format: 'WAV', seconds: 0.1 })
    expect(await probeFile(join(work, 'missing.wav'), 100)).toBeUndefined()
    await writeFile(join(work, 'short.wav'), bytes.subarray(0, 6))
    expect(await probeFile(join(work, 'short.wav'), 6)).toBeUndefined()
  })
})

describe('readGodotImport', () => {
  it('reads the loop of a WAV import in sample frames, and of an Ogg or MP3 import in seconds', async () => {
    const work = await folder()
    await writeFile(join(work, 'hum.wav.import'), '[remap]\nimporter="wav"\n[params]\nedit/loop_mode=3\nedit/loop_begin=0\nedit/loop_end=48000\nedit/normalize=true\n')
    expect(await readGodotImport(join(work, 'hum.wav'))).toEqual({ importer: 'wav', loop: 'ping-pong', loopEnd: 48_000, normalize: true })
    await writeFile(join(work, 'theme.ogg.import'), '[remap]\r\nimporter="oggvorbisstr"\r\n[params]\r\nloop=true\r\nloop_offset=2.5\r\nbpm=120\r\n')
    expect(await readGodotImport(join(work, 'theme.ogg'))).toEqual({ importer: 'oggvorbisstr', loop: 'forward', loopStart: 2.5, bpm: 120 })
    await writeFile(join(work, 'boom.mp3.import'), '[remap]\nimporter="mp3"\n[params]\nloop=false\nloop_offset=1\n')
    expect(await readGodotImport(join(work, 'boom.mp3'))).toEqual({ importer: 'mp3', loop: 'off' })
  })

  it('reads a WAV import that follows the file\'s own loop points, and nothing without an import file or importer', async () => {
    const work = await folder()
    await writeFile(join(work, 'detect.wav.import'), '[remap]\nimporter="wav"\n[params]\nedit/loop_mode=0\nedit/loop_begin=10\n')
    expect(await readGodotImport(join(work, 'detect.wav'))).toEqual({ importer: 'wav', loop: 'file' })
    expect(await readGodotImport(join(work, 'none.wav'))).toBeUndefined()
    await writeFile(join(work, 'broken.wav.import'), '; comment\n[params]\nloop=true\n')
    expect(await readGodotImport(join(work, 'broken.wav'))).toBeUndefined()
  })
})

describe('mapLimited', () => {
  it('keeps the input order with a limited number in flight', async () => {
    let running = 0
    let most = 0
    const results = await mapLimited([5, 1, 4, 2, 3], 2, async (value) => {
      running += 1
      most = Math.max(most, running)
      await new Promise(resolve => setTimeout(resolve, value))
      running -= 1
      return value * 10
    })
    expect(results).toEqual([50, 10, 40, 20, 30])
    expect(most).toBe(2)
  })
})
