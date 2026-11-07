/**
 * Host plugin: configuration validation, MCP server registration, removal on disposal, and the registered command
 * line, which serves the SuperCollider tools from this source checkout.
 */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { decodeServerOptions } from '@deepseek-ai/dsh-app-mcp'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { expect, it, onTestFinished } from 'vitest'
import { parseServerOptions } from '../src/environment.ts'
import * as SuperCollider from '../src/index.ts'

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

it('registers the wasd_supercollider stdio server with its options and removes it when the plugin is disposed', async () => {
  const ctx = new Context()
  try {
    const manager = fakeManager()
    ctx.provide('mcpManager', manager)
    const fiber = ctx.plugin(SuperCollider, { dataRoot: '/data/supercollider', sclangPath: '/opt/sc/sclang', requestTimeoutMs: 120_000 })
    await fiber
    expect([...manager.registered.keys()]).toEqual(['wasd_supercollider'])
    const entry = manager.registered.get('wasd_supercollider')
    expect(entry).toMatchObject({
      transport: 'stdio', command: process.execPath, toolCallTimeoutMs: 900_000, startupTimeoutMs: 30_000,
      env: { ELECTRON_RUN_AS_NODE: '1', PYTHONPATH: '', PYTHONHOME: '', VIRTUAL_ENV: '' },
    })
    // Tests load src/index.ts, so the entry is the TypeScript server, which runs through tsx.
    const [importFlag, loader, script = '', encoded = ''] = entry?.args ?? []
    expect([importFlag, loader, script]).toEqual(['--import', import.meta.resolve('tsx/esm'), WORKER_ENTRY])
    expect(parseServerOptions(decodeServerOptions([process.execPath, script, encoded]))).toEqual({
      dataRoot: '/data/supercollider', sclangPath: '/opt/sc/sclang', scsynthPath: '', readyTimeoutMs: 60_000, requestTimeoutMs: 120_000,
      toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536,
    })
    await fiber.dispose()
    expect(manager.registered.size).toBe(0)
    await ctx.plugin(SuperCollider, { dataRoot: '/data/supercollider' })
    expect(manager.registered.has('wasd_supercollider')).toBe(true)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('serves the SuperCollider tools from the registered command line without starting SuperCollider', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const manager = fakeManager()
  ctx.provide('mcpManager', manager)
  // A data root that does not exist: listing the tools must not touch it.
  await ctx.plugin(SuperCollider, { dataRoot: '/nonexistent/wasd-supercollider-plugin-spec' })
  const entry = manager.registered.get('wasd_supercollider')
  if (entry?.command === undefined || entry.args === undefined) throw new Error('the plugin registered no stdio command')
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env ?? {}, stderr: 'pipe' })
  let stderr = ''
  transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
  onTestFinished(() => client.close())
  await client.connect(transport).catch((error: unknown) => { throw new Error(`the SuperCollider server did not start: ${stderr}`, { cause: error }) })
  expect(client.getServerVersion()).toMatchObject({ name: 'wasd_supercollider' })
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['render_audio', 'analyze_audio', 'execute_sclang', 'class_info'])
}, 60_000)

it('refuses relative paths before registering', () => {
  const ctx = new Context()
  for (const field of ['dataRoot', 'sclangPath', 'scsynthPath'] as const) {
    const config = SuperCollider.Config({ dataRoot: '/data/supercollider', [field]: 'relative/path' })
    expect(() => { SuperCollider.apply(ctx, config) }).toThrow(`SuperCollider plugin: ${field} must be an absolute path, got "relative/path"`)
  }
})

it('validates paths and budgets', () => {
  expect(SuperCollider.Config({ dataRoot: '/d' })).toEqual({
    dataRoot: '/d', sclangPath: '', scsynthPath: '', toolCallTimeoutMs: 900_000, startupTimeoutMs: 30_000, readyTimeoutMs: 60_000,
    requestTimeoutMs: 600_000, graceMs: 3000, maxLogBytes: 65_536,
  })
  for (const invalid of [{}, { dataRoot: '' }, { dataRoot: '/d', readyTimeoutMs: 0 }, { dataRoot: '/d', requestTimeoutMs: 1.5 },
    { dataRoot: '/d', toolCallTimeoutMs: 2_147_483_648 }, { dataRoot: '/d', startupTimeoutMs: 0 }, { dataRoot: '/d', graceMs: 0 }, { dataRoot: '/d', maxLogBytes: 0 }]) {
    expect(() => SuperCollider.Config(invalid as never)).toThrow()
  }
})
