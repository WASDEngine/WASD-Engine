/**
 * Host plugin: configuration validation, MCP server registration, removal on disposal, and the
 * registered command line, which serves the GIMP tools from this source checkout.
 */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { decodeServerOptions } from '@deepseek-ai/dsh-app-mcp'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect, it, onTestFinished } from 'vitest'
import { parseServerOptions } from '../src/environment.ts'
import * as Gimp from '../src/index.ts'

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

it('registers the wasd_gimp stdio server with its options and removes it when the plugin is disposed', async () => {
  const ctx = new Context()
  try {
    const manager = fakeManager()
    ctx.provide('mcpManager', manager)
    const fiber = ctx.plugin(Gimp, { dataRoot: '/data/gimp', gimpConsolePath: '/opt/gimp/bin/gimp-console-3.2', requestTimeoutMs: 120_000 })
    await fiber
    expect([...manager.registered.keys()]).toEqual(['wasd_gimp'])
    const entry = manager.registered.get('wasd_gimp')
    expect(entry).toMatchObject({
      transport: 'stdio', command: process.execPath, toolCallTimeoutMs: 900_000, startupTimeoutMs: 30_000,
      env: { ELECTRON_RUN_AS_NODE: '1', PYTHONPATH: '', PYTHONHOME: '', VIRTUAL_ENV: '' },
    })
    // Tests load src/index.ts, so the entry is the TypeScript server, which runs through tsx.
    const [importFlag, loader, script = '', encoded = ''] = entry?.args ?? []
    expect([importFlag, loader, script]).toEqual(['--import', import.meta.resolve('tsx/esm'), WORKER_ENTRY])
    expect(parseServerOptions(decodeServerOptions([process.execPath, script, encoded]))).toEqual({
      dataRoot: '/data/gimp', gimpConsolePath: '/opt/gimp/bin/gimp-console-3.2', readyTimeoutMs: 120_000, requestTimeoutMs: 120_000,
      toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536, maxWorkers: 4, workerMemoryBytes: 8 * 1024 ** 3, workerCores: 4,
      minAvailableMemoryBytes: 1024 ** 3, workerIdleTimeoutMs: 600_000,
    })
    await fiber.dispose()
    expect(manager.registered.size).toBe(0)
    await ctx.plugin(Gimp, { dataRoot: '/data/gimp' })
    expect(manager.registered.has('wasd_gimp')).toBe(true)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('serves the GIMP tools from the registered command line without starting GIMP', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const manager = fakeManager()
  ctx.provide('mcpManager', manager)
  // A data root that does not exist: listing the tools must not touch it.
  await ctx.plugin(Gimp, { dataRoot: '/nonexistent/wasd-gimp-plugin-spec' })
  const entry = manager.registered.get('wasd_gimp')!
  const transport = new StdioClientTransport({ command: entry.command!, args: entry.args!, env: entry.env!, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  onTestFinished(() => client.close())
  await client.connect(transport).catch((error: unknown) => { throw new Error(`the GIMP server did not start: ${stderr}`, { cause: error }) })
  expect(client.getServerVersion()).toMatchObject({ name: 'wasd_gimp' })
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual([
    'list_images', 'open_image', 'new_image', 'image_info', 'snapshot', 'export_image', 'save_xcf', 'close_image', 'layer',
    'select', 'transform', 'draw', 'filters', 'filter_info', 'apply_filter', 'pdb_search', 'pdb_describe', 'pdb_run',
    'execute_python', 'make_sprite_sheet', 'make_seamless',
  ])
}, 60_000)

it('refuses relative paths before registering', () => {
  const ctx = new Context()
  for (const field of ['dataRoot', 'gimpConsolePath'] as const) {
    const config = Gimp.Config({ dataRoot: '/data/gimp', [field]: 'relative/path' })
    expect(() => { Gimp.apply(ctx, config) }).toThrow(`GIMP plugin: ${field} must be an absolute path, got "relative/path"`)
  }
})

it('validates paths and budgets', () => {
  expect(Gimp.Config({ dataRoot: '/d' })).toEqual({
    dataRoot: '/d', gimpConsolePath: '', toolCallTimeoutMs: 900_000, startupTimeoutMs: 30_000, readyTimeoutMs: 120_000,
    requestTimeoutMs: 600_000, graceMs: 3000, maxLogBytes: 65_536, maxWorkers: 4, workerMemoryBytes: 8 * 1024 ** 3, workerCores: 4,
    minAvailableMemoryBytes: 1024 ** 3, workerIdleTimeoutMs: 600_000,
  })
  for (const invalid of [{}, { dataRoot: '' }, { dataRoot: '/d', readyTimeoutMs: 0 }, { dataRoot: '/d', requestTimeoutMs: 1.5 },
    { dataRoot: '/d', toolCallTimeoutMs: 2_147_483_648 }, { dataRoot: '/d', startupTimeoutMs: 0 }, { dataRoot: '/d', graceMs: 0 }, { dataRoot: '/d', maxLogBytes: 0 }]) {
    expect(() => Gimp.Config(invalid as never)).toThrow()
  }
})
