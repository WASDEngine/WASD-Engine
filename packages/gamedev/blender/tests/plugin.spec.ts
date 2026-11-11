/**
 * Host plugin: configuration validation, MCP server registration, removal on disposal, and the
 * registered command line, which serves the Blender tools from this source checkout.
 */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { decodeServerOptions } from '@deepseek-ai/dsh-app-mcp'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect, it, onTestFinished } from 'vitest'
import { parseServerOptions } from '../src/environment.ts'
import * as Blender from '../src/index.ts'

interface FakeManager {
  readonly registered: Map<string, McpServerRegistration>
  register(name: string, entry: McpServerRegistration): () => void
}

function fakeManager(): FakeManager {
  const registered = new Map<string, McpServerRegistration>()
  return {
    registered,
    register(name, entry) {
      if (registered.has(name)) throw new Error(`mcp-manager: server "${name}" is already configured or registered`)
      registered.set(name, entry)
      return () => { registered.delete(name) }
    },
  }
}

const WORKER_ENTRY = fileURLToPath(new URL('../src/worker.ts', import.meta.url))

it('registers the wasd_blender stdio server with its options and removes it when the plugin is disposed', async () => {
  const ctx = new Context()
  try {
    const manager = fakeManager()
    ctx.provide('mcpManager', manager)
    const fiber = ctx.plugin(Blender, { dataRoot: '/data/blender', backend: 'app', blenderPath: '/opt/blender/blender', requestTimeoutMs: 120_000 })
    await fiber
    expect([...manager.registered.keys()]).toEqual(['wasd_blender'])
    const entry = manager.registered.get('wasd_blender')
    expect(entry).toMatchObject({
      transport: 'stdio', command: process.execPath, toolCallTimeoutMs: 900_000, startupTimeoutMs: 30_000,
      env: { ELECTRON_RUN_AS_NODE: '1', PYTHONPATH: '', PYTHONHOME: '', VIRTUAL_ENV: '' },
    })
    // Tests load src/index.ts, so the entry is the TypeScript server, which runs through tsx.
    const [importFlag, loader, script = '', encoded = ''] = entry?.args ?? []
    expect([importFlag, loader, script]).toEqual(['--import', import.meta.resolve('tsx/esm'), WORKER_ENTRY])
    expect(parseServerOptions(decodeServerOptions([process.execPath, script, encoded]))).toEqual({
      dataRoot: '/data/blender', backend: 'app', bpyVersion: '5.2.3', pythonVersion: '3.13', uvPath: '', blenderPath: '/opt/blender/blender',
      startupTimeoutMs: 30_000, requestTimeoutMs: 120_000, toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536,
      maxWorkers: 4, workerIdleTimeoutMs: 600_000, addonStore: '',
    })
    await fiber.dispose()
    expect(manager.registered.size).toBe(0)
    await ctx.plugin(Blender, { dataRoot: '/data/blender' })
    expect(manager.registered.has('wasd_blender')).toBe(true)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('serves the Blender tools from the registered command line without starting Blender', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const manager = fakeManager()
  ctx.provide('mcpManager', manager)
  // A data root that does not exist: listing the tools must not touch it.
  await ctx.plugin(Blender, { dataRoot: '/nonexistent/wasd-blender-plugin-spec' })
  const entry = manager.registered.get('wasd_blender')!
  const transport = new StdioClientTransport({ command: entry.command!, args: entry.args!, env: entry.env!, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  onTestFinished(() => client.close())
  await client.connect(transport).catch((error: unknown) => { throw new Error(`the Blender server did not start: ${stderr}`, { cause: error }) })
  expect(client.getServerVersion()).toMatchObject({ name: 'wasd_blender' })
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
    'scene_info', 'object_info', 'execute_python', 'new_scene', 'open_blend', 'save_blend', 'import_file', 'export_gltf',
    'export_file', 'render_preview', 'render', 'python_api', 'checkpoint', 'undo',
  ])
}, 60_000)

it('refuses relative paths before registering', () => {
  const ctx = new Context()
  for (const field of ['dataRoot', 'uvPath', 'blenderPath'] as const) {
    const config = Blender.Config({ dataRoot: '/data/blender', [field]: 'relative/path' })
    expect(() => { Blender.apply(ctx, config) }).toThrow(`Blender plugin: ${field} must be an absolute path, got "relative/path"`)
  }
})

it('validates versions, backends, and budgets', () => {
  expect(Blender.Config({ dataRoot: '/d' })).toEqual({
    dataRoot: '/d', backend: 'auto', bpyVersion: '5.2.3', pythonVersion: '3.13', uvPath: '', blenderPath: '', startupTimeoutMs: 30_000,
    toolCallTimeoutMs: 900_000, requestTimeoutMs: 600_000, graceMs: 3000, maxLogBytes: 65_536, maxWorkers: 4, workerIdleTimeoutMs: 600_000,
    addonStore: '',
  })
  for (const invalid of [{}, { dataRoot: '/d', backend: 'gpu' }, { dataRoot: '/d', bpyVersion: '5.2' }, { dataRoot: '/d', pythonVersion: '2.7' },
    { dataRoot: '/d', requestTimeoutMs: 0 }, { dataRoot: '/d', toolCallTimeoutMs: 2_147_483_648 }, { dataRoot: '/d', startupTimeoutMs: 0 }, { dataRoot: '/d', maxLogBytes: 0 }]) {
    expect(() => Blender.Config(invalid as never)).toThrow()
  }
})
