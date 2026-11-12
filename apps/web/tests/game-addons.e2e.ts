/**
 * Keyless assembled-Web evidence for the game add-ons: the shipped composition mounts the `game-addons` row, whose
 * system prompt section lists the catalog, and a scripted model searches the catalog, installs an add-on without a
 * question to the user, and loads its guide through the `skill` tool. The model's skill catalog lists the guide only
 * once the add-on is in the project, while the tool declarations, apart from those of MCP servers that finish
 * connecting during the turn, stay the same in every request. The overlay points the row at a one-entry test catalog
 * whose archive the test serves in place of its pinned URL.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync } from 'fflate'
import { afterEach, expect, it, vi } from 'vitest'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-user-approval'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const PROVIDER = 'game-addons-web-test'
const MODEL = 'scripted'
const ARCHIVE_URL = 'https://addons.example.test/test-camera-1.2.0.zip'
const ARCHIVE = zipSync({
  'test-camera-1.2.0/LICENSE': new TextEncoder().encode('MIT License\n\nCopyright (c) 2026 Test Author\n'),
  'test-camera-1.2.0/addons/test_camera/plugin.cfg': new TextEncoder().encode('[plugin]\n\nname="Test Camera"\nversion="1.2.0"\nscript="plugin.gd"\n'),
  'test-camera-1.2.0/addons/test_camera/plugin.gd': new TextEncoder().encode('@tool\nextends EditorPlugin\n'),
  'test-camera-1.2.0/addons/test_camera/manager.gd': new TextEncoder().encode('extends Node\n'),
})
const GUIDE = '---\nname: test-camera\ndescription: Test Camera 1.2.0 is installed in this project. Load before adding or changing cameras.\n---\n\n# Test Camera\n\nAdd a TestRig node and set its target.\n'
const DONE = 'GAME_ADDONS_SCRIPT_DONE'

/** The scripted turn: search, install, load the guide, then answer. */
const SCRIPT = [
  { name: 'game_addons', args: { action: 'search', query: 'camera' } },
  { name: 'game_addons', args: { action: 'install', id: 'test-camera' } },
  { name: 'skill', args: { name: 'test-camera' } },
] as const

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async listModels(provider: string) { return [{ provider, id: MODEL, name: MODEL }] }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, contextWindow: 128_000 })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const step = SCRIPT[options.messages.filter(message => message.role === 'tool').length]
    if (step === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: DONE }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: DONE } }
      yield { type: 'usage', usage: { inputTokens: 16, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const id = ToolCallId(`game-addons-${this.requests.length}`)
    const args = JSON.stringify(step.args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name: step.name, argumentsDelta: args }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: step.name, arguments: args } }
    yield { type: 'usage', usage: { inputTokens: 32, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

/** POST one generated Remote unary through the authenticated Web carrier. */
async function remote<T>(target: WebScaffold, endpoint: string, args: Readonly<Record<string, unknown>>): Promise<T> {
  const response = await target.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `game-addons-${endpoint}-${randomUUID()}`, method: endpoint, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${endpoint} failed over HTTP ${response.status}: ${await response.text()}`)
  const result = (await response.json() as { result: RpcResult<T> }).result
  if (!result.ok) throw new Error(`${endpoint} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}

/** The texts of a request's skill catalog messages. */
function catalogs(options: GenerateOptions): string[] {
  return options.messages.flatMap(message => message.content)
    .flatMap(block => block.type === 'text' && block.text.includes('<available_skills>') ? [block.text] : [])
}

/** The text of a request's system prompt, which its leading system-role message carries. */
function systemPrompt(options: GenerateOptions): string {
  return options.messages.filter(message => message.role === 'system').flatMap(message => message.content)
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

let scaffold: WebScaffold | undefined
let root: string | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await scaffold?.close()
  scaffold = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

it('tells the model the catalog and lists an add-on guide only after an installation that asked nobody, with the same tools in every request', async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-web-game-addons-'))
  const catalogDir = join(root, 'catalog')
  await mkdir(join(catalogDir, 'test-camera'), { recursive: true })
  await writeFile(join(catalogDir, 'test-camera', 'SKILL.md'), GUIDE)
  await writeFile(join(catalogDir, 'test-camera', 'addon.json'), JSON.stringify({
    id: 'test-camera', title: 'Test Camera', host: 'godot', version: '1.2.0',
    summary: 'Virtual cameras that follow and frame targets.', useWhen: 'The camera must follow a moving target.',
    tags: ['camera'], stages: ['prototype'], license: 'MIT', copyright: 'Copyright (c) 2026 Test Author',
    homepage: 'https://addons.example.test/camera',
    archive: { url: ARCHIVE_URL, sha256: createHash('sha256').update(ARCHIVE).digest('hex'), bytes: ARCHIVE.byteLength, root: 'test-camera-1.2.0/addons/test_camera', license: 'test-camera-1.2.0/LICENSE' },
    godot: { addonDir: 'test_camera', plugin: 'plugin.cfg', autoloads: [{ name: 'TestCameraManager', path: 'res://addons/test_camera/manager.gd' }] },
    verified: { godot: '4.7.2', date: '2026-11-11' },
  }))
  const overlay = join(root, 'game-addons.patch.yml')
  await writeFile(overlay, [
    '- id: game-addons',
    '  config:',
    `    catalogDir: ${JSON.stringify(catalogDir)}`,
    `    dataRoot: ${JSON.stringify(join(root, 'data'))}`,
    `    blenderStore: ${JSON.stringify(join(root, 'data', 'blender'))}`,
    '',
  ].join('\n'))
  const realFetch = globalThis.fetch
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url) === ARCHIVE_URL
    ? Promise.resolve(new Response(ARCHIVE.slice()))
    : realFetch(input, init))

  scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  const ctx = scaffold.ctx
  const adapter = new ScriptedAdapter()
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'game add-ons scripted model')
  const questions: Array<string | undefined> = []
  ctx.effect(() => ctx.on('approval/request', (request) => {
    questions.push(request.reason)
    return Promise.resolve('rejected' as const)
  }, { prepend: true }), 'game add-ons user who answers no')
  await writeFile(join(scaffold.workspaceCwd, 'project.godot'), 'config_version=5\n\n[application]\n\nconfig/name="Web e2e"\n')

  const created = await remote<{ sessionId: string }>(scaffold, 'session/create', { request: { cwd: scaffold.workspaceCwd } })
  const sessionId = SessionId(created.sessionId)
  await remote(scaffold, 'session/selectModel', { request: { sessionId, provider: PROVIDER, model: MODEL } })
  const settled = scaffold.whenTurnSettled()
  await remote(scaffold, 'session/prompt', {
    request: { requestId: randomUUID(), sessionId, mode: 'queue', content: [{ type: 'text', text: 'Give the game a smooth follow camera.' }] },
  })
  expect(await settled).toBe(sessionId)
  await ctx.agents.get(sessionId)?.whenIdle()

  expect(adapter.requests).toHaveLength(4)
  // MCP servers may finish connecting during the turn; every other declaration stays as it was.
  const toolNames = adapter.requests.map(request => (request.tools ?? []).map(tool => tool.name).filter(name => !name.startsWith('mcp__')).sort())
  expect(toolNames[0]).toContain('game_addons')
  for (const names of toolNames) expect(names).toEqual(toolNames[0])
  // Before the installation no catalog names the guide; the step after it receives a replacement catalog that does.
  for (const request of adapter.requests.slice(0, 2)) for (const text of catalogs(request)) expect(text).not.toContain('test-camera')
  expect(catalogs(adapter.requests[2] as GenerateOptions).at(-1)).toContain('test-camera')
  // The system prompt lists the catalog from the first request on, and the installation asked the user nothing.
  const prompt = systemPrompt(adapter.requests[0] as GenerateOptions)
  expect(prompt).toContain('# Game add-ons\n\ngame_addons installs tested third-party add-ons into the game project')
  expect(prompt).toContain('\n- test-camera (Godot; prototype): The camera must follow a moving target.')
  expect(questions).toEqual([])
  const skillResult = (adapter.requests[3] as GenerateOptions).messages.filter(message => message.role === 'tool').at(-1)?.content
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(skillResult).toContain('<skill_content name="test-camera">')
  expect(skillResult).toContain('Add a TestRig node and set its target.')
  expect(await readFile(join(scaffold.workspaceCwd, 'addons', 'test_camera', 'plugin.cfg'), 'utf8')).toContain('Test Camera')
  expect(await readFile(join(scaffold.workspaceCwd, 'project.godot'), 'utf8')).toContain('TestCameraManager="*res://addons/test_camera/manager.gd"')
  expect((JSON.parse(await readFile(join(scaffold.workspaceCwd, '.wasdengine', 'addons.json'), 'utf8')) as { addons: Array<{ id: string }> }).addons.map(addon => addon.id)).toEqual(['test-camera'])
  expect(await readFile(join(scaffold.workspaceCwd, 'THIRD_PARTY_NOTICES.md'), 'utf8')).toContain('Copyright (c) 2026 Test Author')
}, 180_000)
