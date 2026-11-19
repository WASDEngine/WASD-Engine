/**
 * A project's credits: the models and game tools that worked on it, kept in `.wasdengine/credits.json`, with the model
 * each connected agent named for it, and its add-ons from the add-on record, as a release collects them.
 */
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  connectedAgent, CREDITS_FILE, creditNames, CreditsLedger, isGameWork, MAX_ADDON_CREDITS, MAX_AGENT_MODELS, MAX_MODEL_CREDITS, modelName,
  namesProject, providerToolCredit, readAddonCredits, readCredits, sessionToolCredit,
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

/** Connected agents as WASD Engine's MCP server identifies their applications. */
const CLAUDE_CODE = connectedAgent({ id: 'claude-code', title: 'Claude Code' })
const CODEX = connectedAgent({ id: 'codex', title: 'Codex' })

describe('tool names', () => {
  it('credits the game tools by their Session and MCP names, and only those', () => {
    expect(['godot_run', 'mcp__wasd_blender__execute_python', 'mcp__wasd_gimp__run', 'mcp__wasd_supercollider__render', 'elevenlabs_speech', 'image_generate', 'tripo_rig', 'polyhaven_download']
      .map(sessionToolCredit)).toEqual(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'tripo', 'polyhaven'])
    expect(['read', 'mcp__blender__execute', 'browser_open', 'wasd_release_game', 'audio_review'].map(sessionToolCredit)).toEqual([undefined, undefined, undefined, undefined, undefined])
    expect(['godot_check', 'wasd_release_game', 'mcp__wasd_gimp__run'].map(isGameWork)).toEqual([true, true, true])
    expect(['read', 'edit', 'browser_open', 'asset_search'].map(isGameWork)).toEqual([false, false, false, false])
    expect(['godot_run', 'wasd_export_web', 'blender_execute_python', 'polyhaven_download'].map(namesProject)).toEqual([true, true, false, false])
    expect(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'image', 'tripo', 'polyhaven', 'wasd', 'asset', 'audio', 'nano-banana'].map(providerToolCredit))
      .toEqual(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'tripo', 'polyhaven', undefined, undefined, undefined, 'nano-banana'])
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

  it('credits a model that a path names by its file\'s name alone, so no folder of the computer reaches the game\'s page', () => {
    expect(modelName('/Users/ada/models/Qwen3-8B-Q4_K_M.gguf')).toBe('Qwen3-8B-Q4_K_M')
    expect(modelName('C:\\Users\\ada\\AppData\\Local\\models\\llama-3.1-8b.Q5_K_M.gguf')).toBe('llama-3.1-8b.Q5_K_M')
    expect(modelName('file:///home/ada/weights/mistral-7b.safetensors')).toBe('mistral-7b')
    expect(modelName('~/models/phi-4/')).toBe('phi-4')
    expect(modelName('meta-llama/Llama-3.1-8B-Instruct')).toBe('Llama-3.1-8B-Instruct')
    expect(modelName('ggml-model-q4_0.gguf.bin')).toBe('ggml-model-q4_0')
    expect(modelName('llama3.1:8b')).toBe('llama3.1:8b')
    for (const nothing of ['/', '/models/..', 'C:\\', 'file:///', ' / ']) expect(modelName(nothing), nothing).toBeUndefined()
    // A cleaned name cleans to itself, as a stored credit must, also when the length limit cuts it at an extension.
    const cut = `${'a'.repeat(55)}.gguf${'b'.repeat(10)}`
    expect(modelName(cut)).toBe('a'.repeat(55))
    expect(modelName('a'.repeat(55))).toBe('a'.repeat(55))
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
    await Promise.all(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'tripo', 'polyhaven'].map(tool => ledger.add(dir, [], [tool as 'godot'])))
    const credits = await readCredits(dir)
    expect(credits.models).toEqual(Array.from({ length: MAX_MODEL_CREDITS }, (_, index) => ({ name: `Model ${index + 2}` })))
    expect(credits.tools).toEqual(['godot', 'blender', 'gimp', 'supercollider', 'elevenlabs', 'nano-banana', 'tripo', 'polyhaven'])
  })

  it('changes one file in turn for two paths of one folder, so neither path loses the other\'s credits', async () => {
    const dir = await project()
    const link = `${dir}-link`
    // A junction on Windows, which needs no privilege; other systems ignore the type.
    await symlink(dir, link, 'junction')
    folders.push(link)
    const ledger = new CreditsLedger()
    await Promise.all([
      ledger.add(dir, [{ name: 'Kimi K3' }], ['godot']),
      ledger.connected(CLAUDE_CODE, link, 'blender', 'Claude Fable 5.2'),
      ledger.add(link, [{ builtin: true }], ['gimp']),
      ledger.claim(CODEX, dir),
    ])
    const credits = await readCredits(dir)
    expect(credits.models).toHaveLength(4)
    expect(credits.models).toEqual(expect.arrayContaining([{ name: 'Kimi K3' }, { name: 'Claude Fable 5.2' }, { builtin: true }, { name: 'Codex' }]))
    expect(credits.tools).toEqual(['godot', 'blender', 'gimp'])
    expect(credits.agents).toEqual([{ id: 'claude-code', model: 'Claude Fable 5.2' }])
    // What one path credited, the other path's later call finds credited.
    const written = (await stat(join(dir, STATE_DIR, CREDITS_FILE))).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 20))
    await ledger.add(link, [{ name: 'Kimi K3' }], ['godot'])
    expect((await stat(join(dir, STATE_DIR, CREDITS_FILE))).mtimeMs).toBe(written)
  })

  it('credits a connected agent\'s tools to the project it names, else to its latest project, else once it names one', async () => {
    const [first, second] = [await project(), await project()]
    const ledger = new CreditsLedger()
    await ledger.connected(CLAUDE_CODE, undefined, 'blender')
    await ledger.connected(CODEX, undefined, 'gimp')
    expect(await readCredits(first)).toEqual({ models: [], tools: [], agents: [] })
    await ledger.connected(CLAUDE_CODE, first, 'godot')
    expect(await readCredits(first)).toEqual({ models: [{ name: 'Claude Code' }], tools: ['godot', 'blender'], agents: [] })
    await ledger.connected(CLAUDE_CODE, undefined, 'elevenlabs')
    expect((await readCredits(first)).tools).toContain('elevenlabs')
    await ledger.claim(CODEX, second)
    await ledger.connected(CODEX, undefined, 'polyhaven')
    expect(await readCredits(second)).toEqual({ models: [{ name: 'Codex' }], tools: ['gimp', 'polyhaven'], agents: [] })
    expect((await readCredits(first)).tools).not.toContain('gimp')
  })

  it('credits a connected agent by its application\'s name until it names its model, which takes the name\'s place', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    await ledger.add(dir, [{ builtin: true }], [])
    await ledger.connected(CLAUDE_CODE, dir, 'godot')
    expect(await readCredits(dir)).toEqual({ models: [{ builtin: true }, { name: 'Claude Code' }], tools: ['godot'], agents: [] })
    await ledger.add(dir, [{ name: 'Kimi K3' }], [])
    await ledger.connected(CLAUDE_CODE, dir, 'godot', '  Claude\tFable 5.2 ')
    const named = { models: [{ builtin: true }, { name: 'Claude Fable 5.2' }, { name: 'Kimi K3' }], tools: ['godot'], agents: [{ id: 'claude-code', model: 'Claude Fable 5.2' }] }
    expect(await readCredits(dir)).toEqual(named)
    expect(await file(dir)).toEqual({ format: 1, ...named })
    // The project keeps the name, so the agent's later calls credit that model, after a restart too.
    const restarted = new CreditsLedger()
    await restarted.connected(CLAUDE_CODE, dir, 'godot')
    await restarted.claim(CLAUDE_CODE, dir)
    expect(await readCredits(dir)).toEqual(named)
  })

  it('credits each model a connected agent names, each once, and each application on its own', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    await ledger.connected(CLAUDE_CODE, dir, undefined, 'Claude Fable 5.2')
    const written = (await stat(join(dir, STATE_DIR, CREDITS_FILE))).mtimeMs
    await new Promise(resolve => setTimeout(resolve, 20))
    // Another spelling names the same model, and a name that cleans to nothing names none.
    await ledger.connected(CLAUDE_CODE, dir, undefined, 'claude fable 5.2')
    await ledger.connected(CLAUDE_CODE, dir, undefined, ' \u0000 ')
    expect((await stat(join(dir, STATE_DIR, CREDITS_FILE))).mtimeMs).toBe(written)
    await ledger.connected(CLAUDE_CODE, dir, undefined, 'Claude Opus 5.5')
    await ledger.connected(CODEX, dir, undefined)
    await ledger.connected(CLAUDE_CODE, dir, undefined)
    expect(await readCredits(dir)).toEqual({
      models: [{ name: 'Claude Fable 5.2' }, { name: 'Claude Opus 5.5' }, { name: 'Codex' }],
      tools: [],
      agents: [{ id: 'claude-code', model: 'Claude Opus 5.5' }],
    })
    await ledger.connected(CODEX, dir, undefined, 'GPT-5.5')
    expect(await readCredits(dir)).toEqual({
      models: [{ name: 'Claude Fable 5.2' }, { name: 'Claude Opus 5.5' }, { name: 'GPT-5.5' }],
      tools: [],
      agents: [{ id: 'claude-code', model: 'Claude Opus 5.5' }, { id: 'codex', model: 'GPT-5.5' }],
    })
  })

  it('drops an application\'s name for a model the project credits already, and credits an agent without an application by its model alone', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    await ledger.add(dir, [{ name: 'Claude Fable 5.2' }], [])
    await ledger.connected(CLAUDE_CODE, dir, undefined)
    expect((await readCredits(dir)).models).toEqual([{ name: 'Claude Fable 5.2' }, { name: 'Claude Code' }])
    await ledger.connected(CLAUDE_CODE, dir, undefined, 'Claude Fable 5.2')
    expect((await readCredits(dir)).models).toEqual([{ name: 'Claude Fable 5.2' }])
    // An agent whose requests name no application has no name that could stand for its model.
    const unnamed = connectedAgent({ id: 'agent', title: 'Connected agent' })
    expect(unnamed).toEqual({ id: 'agent' })
    const other = await project()
    await ledger.connected(unnamed, other, 'godot')
    expect(await readCredits(other)).toEqual({ models: [], tools: ['godot'], agents: [] })
    await ledger.connected(unnamed, other, 'godot', 'Qwen3')
    expect(await readCredits(other)).toEqual({ models: [{ name: 'Qwen3' }], tools: ['godot'], agents: [{ id: 'agent', model: 'Qwen3' }] })
  })

  it('credits a project an agent created with the model the agent named, and with its application only once it works on the game', async () => {
    const [unnamed, empty, named] = [await project(), await project(), await project()]
    const ledger = new CreditsLedger()
    // A tool the agent used before it named a project waits for the project it creates.
    await ledger.connected(CLAUDE_CODE, undefined, 'nano-banana')
    await ledger.created(CLAUDE_CODE, unnamed)
    expect(await readCredits(unnamed)).toEqual({ models: [], tools: ['nano-banana'], agents: [] })
    await ledger.created(CODEX, empty)
    await expect(stat(join(empty, STATE_DIR, CREDITS_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
    await ledger.connected(CODEX, undefined, 'gimp')
    expect(await readCredits(empty)).toEqual({ models: [{ name: 'Codex' }], tools: ['gimp'], agents: [] })
    await ledger.created(CLAUDE_CODE, named, 'Claude Fable 5.2')
    const credited = { models: [{ name: 'Claude Fable 5.2' }], agents: [{ id: 'claude-code', model: 'Claude Fable 5.2' }] }
    expect(await readCredits(named)).toEqual({ ...credited, tools: [] })
    // The created project is the one the agent works on, by the model it named.
    await ledger.connected(CLAUDE_CODE, undefined, 'blender')
    expect(await readCredits(named)).toEqual({ ...credited, tools: ['blender'] })
    expect((await readCredits(unnamed)).tools).toEqual(['nano-banana'])
  })

  it('credits a release by a connected agent with the agent before the release collects the credits', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    await ledger.claim(CLAUDE_CODE, dir)
    expect(await ledger.release(dir, undefined)).toMatchObject({ models: [{ name: 'Claude Code' }], tools: ['godot'] })
    await ledger.claim(CLAUDE_CODE, dir, 'Claude Opus 5.5')
    expect(await ledger.release(dir, undefined)).toMatchObject({ models: [{ name: 'Claude Opus 5.5' }], tools: ['godot'] })
  })

  it('keeps the model of the latest applications past the limit', async () => {
    const dir = await project()
    const ledger = new CreditsLedger()
    for (let index = 0; index < MAX_AGENT_MODELS + 1; index++) {
      await ledger.connected(connectedAgent({ id: `agent-${index}`, title: `Agent ${index}` }), dir, undefined, 'Kimi K3')
    }
    const credits = await readCredits(dir)
    expect(credits.models).toEqual([{ name: 'Kimi K3' }])
    expect(credits.agents).toEqual(Array.from({ length: MAX_AGENT_MODELS }, (_, index) => ({ id: `agent-${index + 1}`, model: 'Kimi K3' })))
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
    expect(await readCredits(dir)).toEqual({ models: [], tools: ['godot', 'blender'], agents: [] })
  })

  it('reads a missing, broken, or newer file as crediting nothing it does not know', async () => {
    const dir = await project()
    expect(await readCredits(dir)).toEqual({ models: [], tools: [], agents: [] })
    expect(await readAddonCredits(dir)).toEqual([])
    await mkdir(join(dir, STATE_DIR), { recursive: true })
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), '{ not json')
    expect(await readCredits(dir)).toEqual({ models: [], tools: [], agents: [] })
    // A model path an earlier version stored credits nothing.
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), JSON.stringify({
      format: 1, models: [{ name: 'Kimi K3' }, { name: '' }, { vendor: 'x' }, 'GPT', { name: '/Users/ada/models/qwen.gguf' }], tools: ['gimp', 'unity', 'godot'],
    }))
    expect(await readCredits(dir)).toEqual({ models: [{ name: 'Kimi K3' }], tools: ['godot', 'gimp'], agents: [] })
    // Of the models that agents named, an entry this version cannot read names none, and neither does a list that is none.
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), JSON.stringify({
      format: 1,
      models: [{ name: 'Kimi K3' }],
      tools: ['godot'],
      agents: [
        { id: 'claude-code', model: 'Claude Fable 5.2' }, { id: 'claude-code', model: 'Again' }, { id: 'Bad Id', model: 'GPT-5.5' },
        { id: 'codex', model: '/Users/ada/models/qwen.gguf' }, { id: 'cursor', model: 'Kimi K3', extra: true }, 'codex', { id: 'codex' },
      ],
    }))
    expect(await readCredits(dir)).toEqual({ models: [{ name: 'Kimi K3' }], tools: ['godot'], agents: [{ id: 'claude-code', model: 'Claude Fable 5.2' }] })
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), JSON.stringify({ format: 1, models: [{ name: 'Kimi K3' }], tools: ['godot'], agents: { 'claude-code': 'Claude Fable 5.2' } }))
    expect(await readCredits(dir)).toEqual({ models: [{ name: 'Kimi K3' }], tools: ['godot'], agents: [] })
    await writeFile(join(dir, STATE_DIR, CREDITS_FILE), JSON.stringify({ format: 2, models: [{ name: 'Kimi K3' }], tools: ['gimp'] }))
    expect(await readCredits(dir)).toEqual({ models: [], tools: [], agents: [] })
    await writeFile(join(dir, STATE_DIR, 'addons.json'), JSON.stringify({
      addons: Array.from({ length: MAX_ADDON_CREDITS + 3 }, (_, index) => ({ id: `addon-${index}`, title: `Add-on ${index}` })),
    }))
    expect(await readAddonCredits(dir)).toHaveLength(MAX_ADDON_CREDITS)
  })
})
