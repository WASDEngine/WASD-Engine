/** The listed audio formats and the kinds of game sound, by path words and then by length. */
import { describe, expect, it } from 'vitest'
import { AUDIO_EXTENSIONS, audioCategoryOf, audioFormatOf, MUSIC_MIN_SECONDS, pathWords } from '../src/audio/formats.ts'

describe('audioFormatOf', () => {
  it('lists WAV, MP3, Ogg, Opus, FLAC, and AIFF by extension in any letter case, from a name or a path', () => {
    expect(AUDIO_EXTENSIONS).toEqual(['wav', 'wave', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'aif', 'aiff', 'aifc'])
    expect(audioFormatOf('jump.WAV')).toEqual({ label: 'WAV', mediaType: 'audio/wav', decoder: 'browser' })
    expect(audioFormatOf('audio/music/theme.ogg')?.label).toBe('Ogg')
    expect(audioFormatOf('C:\\game\\boom.Mp3')?.label).toBe('MP3')
    expect(audioFormatOf('sfx/hit.aiff')).toEqual({ label: 'AIFF', mediaType: 'audio/aiff', decoder: 'aiff' })
  })

  it('lists no other file, no extensionless name, and no hidden file named after an extension', () => {
    expect(audioFormatOf('song.m4a')).toBeUndefined()
    expect(audioFormatOf('jump.wav.import')).toBeUndefined()
    expect(audioFormatOf('wav')).toBeUndefined()
    expect(audioFormatOf('.wav')).toBeUndefined()
  })
})

describe('pathWords', () => {
  it('splits at punctuation, spaces, digits, and case changes', () => {
    expect(pathWords('MusicLevel1')).toEqual(['music', 'level'])
    expect(pathWords('music_level-1 final')).toEqual(['music', 'level', 'final'])
    expect(pathWords('UIClick02')).toEqual(['ui', 'click'])
    expect(pathWords('VO_hero')).toEqual(['vo', 'hero'])
  })
})

describe('audioCategoryOf', () => {
  it('takes the kind from the file name first, then from the nearest folder', () => {
    expect(audioCategoryOf('audio/music/sfx_sting.wav')).toEqual({ category: 'effect', source: 'name' })
    expect(audioCategoryOf('audio/music/boss.ogg', 5)).toEqual({ category: 'music', source: 'name' })
    expect(audioCategoryOf('sounds/voice/hero_hello.mp3')).toEqual({ category: 'dialogue', source: 'name' })
    expect(audioCategoryOf('Assets/BGM/Title.ogg')).toEqual({ category: 'music', source: 'name' })
    expect(audioCategoryOf('dialogue/narrator/intro.wav')).toEqual({ category: 'dialogue', source: 'name' })
  })

  it('prefers dialogue, then music, then effects among the words of one name', () => {
    expect(audioCategoryOf('lines/music_voice.wav').category).toBe('dialogue')
    expect(audioCategoryOf('ui_music_sting.wav').category).toBe('music')
  })

  it('falls back to the length, music from 30 seconds, and to a sound effect without one', () => {
    expect(audioCategoryOf('assets/theme.ogg', MUSIC_MIN_SECONDS)).toEqual({ category: 'music', source: 'length' })
    expect(audioCategoryOf('assets/coin.wav', 0.4)).toEqual({ category: 'effect', source: 'length' })
    expect(audioCategoryOf('assets/coin.wav')).toEqual({ category: 'effect', source: 'default' })
  })
})
