/**
 * A project's credits: the models and game tools that worked on it, kept in `.wasdengine/credits.json`, and its
 * add-ons from the add-on record, as a release collects them.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CREDITS_FILE, creditNames, CreditsLedger, isGameWork, MAX_ADDON_CREDITS, MAX_MODEL_CREDITS, modelName, namesProject,
  providerToolCredit, readAddonCredits, readCredits, sessionToolCredit,
} from '../src/credits.ts'
import { STATE_DIR } from '../src/state.ts'

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-credits-'))
  folders.push(dir)
  return dir
}

async function file(dir: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(join(dir, STATE_DIR, CREDITS_FILE), 'utf8'))
  return parsed
}

describe('tool names', () => {
  it('credits the game tools by their Session and MCP names, and only those', () => {
    expect(['godot_run', 'mcp__wasd_blender__execute_python', 'mcp__wasd_gimp__run', 'mcp__wasd_supercollider__render', 'elevenlabs_speech', 'image_generate', 'polyhaven_download']
      .map(sessionToolCredit)).toEqual(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'polyhaven'])
    expect(['read', 'mcp__blender__execute', 'browser_open', 'wasd_release_game', 'audio_review'].map(sessionToolCredit)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(['godot_check', 'wasd_release_game', 'mcp__wasd_gimp__run'].map(isGameWork)).toEqual([true, true, true])
    expect(['read', 'edit', 'browser_open', 'asset_search'].map(isGameWork)).toEqual([false, false, false, false])
    expect(['godot_run', 'wasd_export_web', 'blender_execute_python', 'polyhaven_download'].map(namesProject)).toEqual([true, true, false, false])
    expect(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'image', 'polyhaven', 'wasd', 'asset', 'audio', 'nano-banana'].map(providerToolCredit))
      .toEqual(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'polyhaven', undefined, undefined, undefined, 'nano-banana'])
  })

  it('cleans model names and names every credit', () => {
    expect(modelName('  Claude\nOpus\t\t5.5  ')).toBe('Claude Opus 5.5')
    expect(modelName(' \u0000 ')).toBeUndefined()
    expect(modelName('😀'.repeat(70))).toBe('😀'.repeat(60))
    expect(creditNames({ models: [{ builtin: true }, { name: 'GPT-5.5' }], tools: ['godot', 'supercollider', 'polyhaven'], addons: [{ id: 'mpfb', title: 'MPFB (MakeHuman)' }] }))
      .toEqual(['WASD Engine\'s built-in AI', 'GPT-5.5', 'Godot', 'SuperCollider', 'Poly Haven', 'MPFB (MakeHuman)'])
    expect(creditNames({
      models: [],
      tools: ['godot', 'blender'],
      addons: [
        { id: 'phantom-camera', title: 'Phantom Camera', host: 'godot' },
        { id: 'mpfb', title: 'MPFB (MakeHuman)', host: 'blender' },
        { id: 'beehave', title: 'Beehave', host: 'godot' },
      ],
    })).toEqual(['Godot with Phantom Camera, Beehave', 'Blender with MPFB (MakeHuman)'])
  })
})

describe('CreditsLedger', () => {
  it('adds models and tools to the project\'s file once each, earliest model first, tools in their order', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    await ledger.add(dir, [{ name: 'Claude Opus 5.5' }], ['blender'])
    await ledger.add(dir, [{ builtin: true }, { name: 'claude opus 5.5' }], ['godot', 'blender'])
    expect(await file(dir)).toEqual({ format: 1, models: [{ name: 'Claude Opus 5.5' }, { builtin: true }], tools: ['godot', 'blender'] })
    const written = (await stat(join(dir, STATE_DIR, CREDITS_FILE))).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 20))
    await ledger.add(dir, [{ builtin: true }], ['godot'])
    expect((await stat(join(dir, STATE_DIR, CREDITS_FILE))).mtimeMs).toBe(written)
  })

  it('keeps the latest models past the limit, and loses no credit to concurrent changes', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    await Promise.all(Array.from({ length: MAX_MODEL_CREDITS + 2 }, (_, index) => ledger.add(dir, [{ name: `Model ${index}` }], [])))
    await Promise.all(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'polyhaven'].map(tool => ledger.add(dir, [], [tool as 'godot'])))
    const credits = await readCredits(dir)
    expect(credits.models).toEqual(Array.from({ length: MAX_MODEL_CREDITS }, (_, index) => ({ name: `Model ${index + 2}` })))
    expect(credits.tools).toEqual(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'polyhaven'])
  })

  it('credits a connected agent\'s tools to the project it names, else to its latest project, else once it names one', async () => {
    const [first, second] = [await project(), await project()]
    const ledger = new CreditsLedger()
    await ledger.connected('claude-code', undefined, 'blender')
    await ledger.connected('codex', undefined, 'gimp')
    expect(await readCredits(first)).toEqual({ models: [], tools: [] })
    await ledger.connected('claude-code', first, 'godot')
    expect(await readCredits(first)).toEqual({ models: [], tools: ['godot', 'blender'] })
    await ledger.connected('claude-code', undefined, 'elevenlabs')
    expect((await readCredits(first)).tools).toContain('elevenlabs')
    await ledger.claim('codex', second)
    await ledger.connected('codex', undefined, 'polyhaven')
    expect(await readCredits(second)).toEqual({ models: [], tools: ['gimp', 'polyhaven'] })
    expect((await readCredits(first)).tools).not.toContain('gimp')
  })

  it('collects a release\'s credits: its model, Godot, and the project\'s add-ons', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    await ledger.add(dir, [{ builtin: true }], ['blender'])
    await mkdir(join(dir, STATE_DIR), { recursive: true })
    await writeFile(join(dir, STATE_DIR, 'addons.json'), JSON.stringify({
      format: 1,
      addons: [
        { id: 'mpfb', title: 'MPFB (MakeHuman)', host: 'blender' },
        { id: 'mpfb', title: 'Again', host: 'blender' },
        { id: 'Bad Id', title: 'Bad', host: 'godot' },
        { id: 'dialogue-manager', title: '  Dialogue\nManager ', host: 'godot' },
        { id: 'unity-thing', title: 'Unity Thing', host: 'unity' },
      ],
    }))
    expect(await ledger.release(dir, { name: 'Claude Opus 5.5' })).toEqual({
      models: [{ builtin: true }, { name: 'Claude Opus 5.5' }],
      tools: ['godot', 'blender'],
      addons: [
        { id: 'mpfb', title: 'MPFB (MakeHuman)', host: 'blender' },
        { id: 'dialogue-manager', title: 'Dialogue Manager', host: 'godot' },
        { id: 'unity-thing', title: 'Unity Thing' },
      ],
    })
    expect(await ledger.release(dir, undefined)).toMatchObject({ models: [{ builtin: true }, { name: 'Claude Opus 5.5' }] })
  })

  it('credits the tool an add-on extends, which the project\'s calls did not credit', async () => {
    const dir = await project()
    await mkdir(join(dir, STATE_DIR), { recursive: true })
    await writeFile(join(dir, STATE_DIR, 'addons.json'), JSON.stringify({ format: 1, addons: [{ id: 'rigify', title: 'Rigify', host: 'blender' }] }))
    expect(await new CreditsLedger().release(dir, undefined)).toEqual({ models: [], tools: ['godot', 'blender'], addons: [{ id: 'rigify', title: 'Rigify', host: 'blender' }] })
    expect(await readCredits(dir)).toEqual({ models: [], tools: ['godot', 'blender'] })
  })

  it('reads a missing, broken, or newer file as crediting nothing it does not know', async () => {
    const dir = await project()
    expect(await readCredits(dir)).toEqual({ models: [], tools: [] })
    expect(await readAddonCredits(dir)).toEqual([])
    await mkdir(join(dir, STATE_DIR), { recursive: true })
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), '{ not json')
    expect(await readCredits(dir)).toEqual({ models: [], tools: [] })
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), JSON.stringify({ format: 1, models: [{ name: 'Kimi K3' }, { name: '' }, { vendor: 'x' }, 'GPT'], tools: ['gimp', 'unity', 'godot'] }))
    expect(await readCredits(dir)).toEqual({ models: [{ name: 'Kimi K3' }], tools: ['godot', 'gimp'] })
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), JSON.stringify({ format: 2, models: [{ name: 'Kimi K3' }], tools: ['gimp'] }))
    expect(await readCredits(dir)).toEqual({ models: [], tools: [] })
    await writeFile(join(dir, STATE_DIR, 'addons.json'), JSON.stringify({
      addons: Array.from({ length: MAX_ADDON_CREDITS + 3 }, (_, index) => ({ id: `addon-${index}`, title: `Add-on ${index}` })),
    }))
    expect(await readAddonCredits(dir)).toHaveLength(MAX_ADDON_CREDITS)
  })
})
