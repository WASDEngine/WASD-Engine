/**
 * The ElevenLabs tools as a Session's agent calls them: the real tool runtime and executor run each call against a
 * fake WASD Engine API with the account's token, and the audio lands in the Session's working directory.
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import * as ElevenLabs from '../src/index.ts'
import { callTool, compose, text, TOKEN, type Composition } from './composition.ts'
import { CONSENT_STATEMENT } from '../src/consent.ts'
import { CLONE_ID, MP3, WAV } from './fixtures.ts'

const TOOLS = ['elevenlabs_voices', 'elevenlabs_speech', 'elevenlabs_sound_effect', 'elevenlabs_music', 'elevenlabs_clone_voice', 'elevenlabs_delete_voice']

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function composed(config: Parameters<typeof compose>[0] = {}): Promise<Composition> {
  composition = await compose(config)
  return composition
}

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort()
}

describe('elevenlabs_voices', () => {
  it('lists Voice Library voices with their labels, and sends the search with the account token to the API origin', async () => {
    const current = await composed()
    const result = await callTool(current, 'elevenlabs_voices', { query: ' old wizard ', gender: 'male', age: 'old', accent: 'British', use_case: 'characters_animation' })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      'ElevenLabs Voice Library voices for "old wizard" (male, old, british, characters_animation), page 0:',
      '- LvmvHEBEmMJBJw9UuhwO: Eldrin - Wise Ancient Wizard (male, old, british, en, characters_animation). A deep, resonant, and warm voice infused with centuries of wisdom and subtle magic, perfect for fantasy audiobooks, epic RPG questgivers, game cutscenes, and…',
      '- JBFqnCBsd6RMkjVDRZzb: George (male).',
      'More: pass page 1.',
      'Pass a voice_id to elevenlabs_speech. Give each character one voice and keep using it.',
    ].join('\n'))
    expect(current.api.requests).toEqual([{
      method: 'POST', path: '/v1/audio/voices',
      token: TOKEN,
      body: { source: 'library', page: 0, page_size: 10, query: 'old wizard', gender: 'male', age: 'old', accent: 'british', use_case: 'characters_animation' },
    }])
    expect(current.account.resolved).toEqual([`${current.api.origin}/v1/audio/voices`])
  })

  it('lists the default voices and pages, and checks its arguments before any request', async () => {
    const current = await composed()
    expect(await callTool(current, 'elevenlabs_voices', { source: 'default', page: 1, limit: 5 })).toMatchObject({
      isError: false, value: { source: 'default', page: 1, hasMore: false, voices: [] },
    })
    expect(current.api.requests.at(-1)?.body).toEqual({ source: 'default', page: 1, page_size: 5 })
    for (const args of [{ limit: 31 }, { limit: 0 }, { page: -1 }, { language: 'English' }]) {
      const refused = await callTool(current, 'elevenlabs_voices', args)
      expect(refused.isError, JSON.stringify(args)).toBe(true)
    }
    expect(current.api.requests).toHaveLength(1)
  })

  it('asks the user to sign in while WASD Engine is signed out, without a request', async () => {
    const current = await composed()
    current.account.signedIn = false
    const result = await callTool(current, 'elevenlabs_voices', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('WASD Engine is signed out, and ElevenLabs audio is made through the signed-in account. Ask the user to sign in to WASD Engine, then try again.')
    expect(current.api.requests).toEqual([])
  })
})

describe('elevenlabs_speech', () => {
  it('saves speech under the working directory and reports its length', async () => {
    const current = await composed()
    const result = await callTool(current, 'elevenlabs_speech', {
      text: '[shouting] Halt! Who goes there?', voice_id: 'LvmvHEBEmMJBJw9UuhwO', path: 'audio/voices/guard_halt.mp3', speed: 0.9, language: 'EN', seed: 7,
      previous_text: 'You hear footsteps.',
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe('Saved 1.7 s of speech in voice LvmvHEBEmMJBJw9UuhwO (Eleven v4 Turbo, 32 characters) to audio/voices/guard_halt.mp3 (1 KB).')
    expect(result).toMatchObject({ value: { path: join(current.work, 'audio/voices/guard_halt.mp3'), format: 'mp3', durationMs: 1725, bytes: MP3.byteLength, replaced: false, characters: 32 } })
    expect(await readFile(join(current.work, 'audio/voices/guard_halt.mp3'))).toEqual(MP3)
    expect(current.api.requests).toEqual([{
      method: 'POST', path: '/v1/audio/speech',
      token: TOKEN,
      body: { text: '[shouting] Halt! Who goes there?', voice_id: 'LvmvHEBEmMJBJw9UuhwO', language: 'en', speed: 0.9, seed: 7, previous_text: 'You hear footsteps.', format: 'mp3' },
    }])
  })

  it('refuses to overwrite a file before paying for audio, and overwrites it with replace', async () => {
    const current = await composed()
    await mkdir(join(current.work, 'audio'))
    await writeFile(join(current.work, 'audio/line.wav'), 'mine')
    const refused = await callTool(current, 'elevenlabs_speech', { text: 'Hi.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'audio/line.wav' })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain('audio/line.wav already exists. Pass replace: true to overwrite it, or choose another path.')
    expect(current.api.requests).toEqual([])
    const replaced = await callTool(current, 'elevenlabs_speech', { text: 'Hi.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'audio/line.wav', replace: true })
    expect(text(replaced)).toBe('Saved 1.7 s of speech in voice JBFqnCBsd6RMkjVDRZzb (Eleven v4 Turbo, 3 characters) to audio/line.wav (1 KB, replaced).')
    expect(current.api.requests.at(-1)?.body.format).toBe('wav')
    expect(await readFile(join(current.work, 'audio/line.wav'))).toEqual(WAV)
    expect(await files(current.work)).toEqual(['audio/line.wav'])
  })

  it.each([
    [{ text: 'Hi.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'line.ogg' }, 'path must end in .mp3 or .wav; it names the file type.'],
    [{ text: 'Hi.', voice_id: '../user', path: 'line.mp3' }, 'is not an ElevenLabs voice id'],
    [{ text: '   ', voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'line.mp3' }, 'text must not be empty.'],
    [{ text: 'x'.repeat(5001), voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'line.mp3' }, 'text must be at most 5000 characters; it has 5001. Split it into several calls.'],
    [{ text: 'Hi.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'line.mp3', speed: 1.5 }, 'speed must be from 0.7 to 1.2.'],
    [{ text: 'Hi.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'line.mp3', seed: -1 }, 'seed must be an integer from 0 to 4294967295.'],
  ])('refuses %j before any request', async (args, message) => {
    const current = await composed()
    const result = await callTool(current, 'elevenlabs_speech', args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
    expect(current.api.requests).toEqual([])
  })

  it('passes on the API\'s refusals, and reports a refused token so the sign-in can end', async () => {
    const current = await composed()
    const args = { text: 'Hi.', voice_id: 'JBFqnCBsd6RMkjVDRZzb', path: 'line.mp3' }
    const cases: Array<[number, string | undefined, string]> = [
      [402, 'Usage limit reached: the $2.00 of AI usage that the WASD Engine Free plan includes is used up.', 'Usage limit reached: the $2.00 of AI usage that the WASD Engine Free plan includes is used up. Ask the user to upgrade their WASD Engine plan or turn on auto recharge, then try again.'],
      [400, 'The voice Lydia has a custom price that WASD Engine does not offer. Choose another voice.', 'ElevenLabs could not make this audio: The voice Lydia has a custom price that WASD Engine does not offer. Choose another voice.'],
      [403, 'Confirm your email address first.', 'Confirm your email address first.'],
      [429, 'The audio service is busy. Retry shortly.', 'ElevenLabs is busy. Wait a few seconds, then try again.'],
      [503, undefined, 'WASD Engine could not make this audio (HTTP 503). Try again later.'],
      [401, 'Missing, invalid, expired or revoked WASD Engine token. Sign in again.', 'The WASD Engine sign-in has expired. Ask the user to sign in to WASD Engine again, then try again.'],
    ]
    for (const [status, message, said] of cases) {
      current.api.failures.set('/v1/audio/speech', { status, ...message === undefined ? {} : { message } })
      const result = await callTool(current, 'elevenlabs_speech', args)
      expect(result.isError, String(status)).toBe(true)
      expect(text(result), String(status)).toContain(said)
    }
    expect(current.account.rejected).toEqual([TOKEN])
    expect(await files(current.work)).toEqual([])
  })
})

describe('elevenlabs_sound_effect and elevenlabs_music', () => {
  it('saves a looping sound effect as WAV and says how Godot loops it', async () => {
    const current = await composed()
    const result = await callTool(current, 'elevenlabs_sound_effect', { prompt: 'rain on a tin roof', path: 'audio/sfx/rain.wav', duration_seconds: 2, loop: true, prompt_influence: 0.6 })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      'Saved a 2.0 s sound effect (SFX v3, looping) to audio/sfx/rain.wav (1 KB).',
      'To loop it in Godot, set edit/loop_mode=2 under [params] in its .import file once Godot has imported it.',
    ].join('\n'))
    expect(current.api.requests).toEqual([{
      method: 'POST', path: '/v1/audio/sound-effects', token: TOKEN, body: { prompt: 'rain on a tin roof', loop: true, duration_seconds: 2, prompt_influence: 0.6, format: 'wav' },
    }])
    expect(await readFile(join(current.work, 'audio/sfx/rain.wav'))).toEqual(WAV)
    const short = await callTool(current, 'elevenlabs_sound_effect', { prompt: 'blip', path: 'blip.wav', duration_seconds: 0.2 })
    expect(text(short)).toContain('duration_seconds must be from 0.5 to 30.')
  })

  it('saves music as MP3 only', async () => {
    const current = await composed()
    const result = await callTool(current, 'elevenlabs_music', { prompt: 'calm lofi with soft piano', path: 'audio/music/menu.mp3', duration_seconds: 30, instrumental: true })
    expect(text(result)).toBe('Saved 30.0 s of music (Music v2.5, instrumental) to audio/music/menu.mp3 (1 KB). To repeat it in Godot, set loop=true under [params] in its .import file once Godot has imported it.')
    expect(current.api.requests).toEqual([{
      method: 'POST', path: '/v1/audio/music', token: TOKEN, body: { prompt: 'calm lofi with soft piano', instrumental: true, duration_seconds: 30, format: 'mp3' },
    }])
    const wav = await callTool(current, 'elevenlabs_music', { prompt: 'song', path: 'song.wav' })
    expect(text(wav)).toContain('path must end in .mp3; it names the file type.')
    expect(current.api.requests).toHaveLength(1)
  })
})

async function recordings(work: string, names: readonly string[]): Promise<void> {
  await mkdir(join(work, 'recordings'), { recursive: true })
  for (const name of names) await writeFile(join(work, 'recordings', name), name.endsWith('.wav') ? WAV : MP3)
}

describe('elevenlabs_clone_voice and elevenlabs_delete_voice', () => {
  it('clones a voice once the user confirms consent in WASD Engine, and records where they confirmed it', async () => {
    const current = await composed()
    await recordings(current.work, ['rhea-1.wav', 'rhea-2.mp3'])
    const result = await callTool(current, 'elevenlabs_clone_voice', {
      name: ' Captain Rhea ', samples: ['recordings/rhea-1.wav', 'recordings/rhea-2.mp3'], description: 'A ship captain', remove_background_noise: true,
    })
    expect(result.isError).toBe(false)
    expect(text(result)).toBe([
      `Cloned the voice "Captain Rhea" as voice ${CLONE_ID} from 2 recordings (recordings/rhea-1.wav, recordings/rhea-2.mp3). Pass it as voice_id to elevenlabs_speech; only this account can use it.`,
      'Cloned voices in use: 1 of 3; elevenlabs_delete_voice frees one.',
    ].join('\n'))
    expect(current.approval.asked.map(asked => [asked.toolName, asked.reason])).toEqual([[
      'elevenlabs_clone_voice',
      `Clone a voice named "Captain Rhea" from rhea-1.wav, rhea-2.mp3? Approve only if this is true: ${CONSENT_STATEMENT}`,
    ]])
    expect(current.approval.asked[0]?.zh).toContain('克隆名为 "Captain Rhea" 的声音')
    expect(current.api.requests).toEqual([{
      method: 'POST',
      path: '/v1/audio/voices/clone',
      token: TOKEN,
      body: {
        name: 'Captain Rhea',
        description: 'A ship captain',
        remove_background_noise: 'true',
        consent: 'true',
        consent_statement: '2026-11-11',
        consent_channel: 'app',
        files: [{ name: 'rhea-1.wav', type: 'audio/wav', size: WAV.byteLength }, { name: 'rhea-2.mp3', type: 'audio/mpeg', size: MP3.byteLength }],
      },
    }])
  })

  it.each([
    ['rejected', 'The user did not confirm consent to clone this voice, so nothing was cloned. Ask before trying again.'],
    ['cancelled', 'The consent question was cancelled, so nothing was cloned.'],
    ['unavailable', 'WASD Engine cannot ask the user to confirm consent here, so nothing was cloned.'],
  ] as const)('sends nothing when the consent question ends %s', async (outcome, message) => {
    const current = await composed()
    await recordings(current.work, ['rhea.wav'])
    current.approval.outcome = outcome
    const result = await callTool(current, 'elevenlabs_clone_voice', { name: 'Rhea', samples: ['recordings/rhea.wav'] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
    expect(current.api.requests).toEqual([])
  })

  it('cannot clone without an approval prompt to ask the user in', async () => {
    composition = await compose({}, { approval: false })
    await recordings(composition.work, ['rhea.wav'])
    const result = await callTool(composition, 'elevenlabs_clone_voice', { name: 'Rhea', samples: ['recordings/rhea.wav'] })
    expect(text(result)).toContain('WASD Engine cannot ask the user to confirm consent here, so nothing was cloned.')
    expect(composition.api.requests).toEqual([])
  })

  it.each([
    [{ name: 'Rhea', samples: ['recordings/rhea.ogg'] }, 'recordings/rhea.ogg must be a .wav or .mp3 recording.'],
    [{ name: 'Rhea', samples: ['recordings/missing.wav'] }, 'recordings/missing.wav does not exist.'],
    [{ name: 'Rhea', samples: [] }, 'samples must name 1 to 5 recordings.'],
    [{ name: 'Rhea', samples: Array.from({ length: 6 }, () => 'recordings/rhea.wav') }, 'samples must name 1 to 5 recordings.'],
    [{ name: 'x'.repeat(61), samples: ['recordings/rhea.wav'] }, 'name must be 1 to 60 characters.'],
  ])('refuses %j before asking the user', async (args, message) => {
    const current = await composed()
    await recordings(current.work, ['rhea.wav'])
    const result = await callTool(current, 'elevenlabs_clone_voice', args)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(message)
    expect(current.approval.asked).toEqual([])
    expect(current.api.requests).toEqual([])
  })

  it('says how to free a place when the account keeps all the clones it may', async () => {
    const current = await composed()
    await recordings(current.work, ['rhea.wav'])
    current.api.failures.set('/v1/audio/voices/clone', { status: 409, message: 'This account already keeps 3 cloned voices, the most it may. Delete one first.' })
    const result = await callTool(current, 'elevenlabs_clone_voice', { name: 'Rhea', samples: ['recordings/rhea.wav'] })
    expect(text(result)).toContain('ElevenLabs could not clone this voice: This account already keeps 3 cloned voices, the most it may. Delete one first. elevenlabs_voices with source "mine" lists this account\'s cloned voices, and elevenlabs_delete_voice deletes one.')
    current.api.failures.set('/v1/audio/voices/clone', { status: 403, message: 'Cloning a voice needs a WASD Engine Pro or Max plan. Ask the user to upgrade, or use an existing voice.' })
    const free = await callTool(current, 'elevenlabs_clone_voice', { name: 'Rhea', samples: ['recordings/rhea.wav'] })
    expect(text(free)).toContain('Cloning a voice needs a WASD Engine Pro or Max plan. Ask the user to upgrade, or use an existing voice.')
  })

  it('deletes a clone and lists the account\'s own voices', async () => {
    const current = await composed()
    const deleted = await callTool(current, 'elevenlabs_delete_voice', { voice_id: CLONE_ID })
    expect(text(deleted)).toBe(`Deleted the cloned voice "Captain Rhea" (${CLONE_ID}). Cloned voices in use: 0 of 3.`)
    expect(current.api.requests).toEqual([{ method: 'DELETE', path: `/v1/audio/voices/${CLONE_ID}`, token: TOKEN, body: {} }])
    const mine = await callTool(current, 'elevenlabs_voices', { source: 'mine', page: 1 })
    expect(text(mine)).toBe([
      'Voices this account cloned, page 1:',
      'No more voices; pass a smaller page.',
      'Pass a voice_id to elevenlabs_speech. Give each character one voice and keep using it.',
    ].join('\n'))
    expect(current.api.requests.at(-1)?.body).toEqual({ source: 'mine', page: 1, page_size: 10 })
    expect(text(await callTool(current, 'elevenlabs_delete_voice', { voice_id: '../x' }))).toContain('is not an ElevenLabs voice id.')
  })
})

describe('the ElevenLabs plugin', () => {
  it('registers its tools for its lifetime', async () => {
    const current = await composed()
    expect(TOOLS.map(name => current.ctx.tools.get(name) !== undefined)).toEqual([true, true, true, true, true, true])
    await current.unload()
    expect(TOOLS.map(name => current.ctx.tools.get(name))).toEqual([undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it('refuses an API origin with a path or another scheme when it loads', async () => {
    const ctx = new Context()
    expect(() => { ElevenLabs.apply(ctx, ElevenLabs.Config({ apiOrigin: 'https://api.example/v1' })) })
      .toThrow('ElevenLabs plugin: apiOrigin must be an HTTP or HTTPS origin without a path, got "https://api.example/v1".')
    for (const apiOrigin of ['ftp://api.example', 'not a url']) expect(() => ElevenLabs.Config({ apiOrigin }), apiOrigin).toThrow()
    expect(ElevenLabs.Config({})).toEqual({ apiOrigin: 'https://api.wasdengine.com', searchTimeoutMs: 30_000, generationTimeoutMs: 210_000, musicTimeoutMs: 660_000 })
  })
})
