/**
 * Host-side registration against a real Cordis context with a recording MCP
 * manager: the registered stdio entry for a built and a TypeScript server
 * entry, the TypeScript entry started from its registered command line, and
 * the entry's removal when the plugin is disposed.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { decodeServerOptions } from '../src/options.ts'
import { registerAppMcpServer, type AppMcpServerRegistration } from '../src/register.ts'
import { temporaryDirectory, textOf } from './harness.ts'

const REGISTRATION: AppMcpServerRegistration = {
  serverName: 'wasd_blender',
  entry: pathToFileURL('/opt/WASD Engine/node_modules/@deepseek-ai/dsh-blender/lib/worker.js'),
  options: { dataRoot: '/Users/a/.wasd/blender', backend: 'auto', note: '${not a template}' },
  toolCallTimeoutMs: 900_000,
  startupTimeoutMs: 30_000,
}

/** The TypeScript server fixture, which runs only through tsx with the repository configuration. */
const SOURCE_SERVER = new URL('./fixtures/source-server.ts', import.meta.url)

const SOURCE_TIMEOUT = 60_000

function mountManager() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const unregister = vi.fn()
  const register = vi.fn((_name: string, _entry: McpServerRegistration) => unregister)
  ctx.provide('mcpManager', { register })
  return { ctx, register, unregister }
}

async function registeredEntry(registration: AppMcpServerRegistration): Promise<McpServerRegistration> {
  const { ctx, register } = mountManager()
  await ctx.plugin({ name: 'app', inject: ['mcpManager'], apply(child: Context) { registerAppMcpServer(child, registration) } }).await()
  expect(register).toHaveBeenCalledOnce()
  const [name, entry] = register.mock.calls[0]!
  expect(name).toBe(registration.serverName)
  return entry
}

describe('registerAppMcpServer', () => {
  it('registers a stdio server that runs a built entry under the Host executable', async () => {
    const entry = await registeredEntry(REGISTRATION)
    expect(entry).toEqual({
      transport: 'stdio',
      command: process.execPath,
      args: ['/opt/WASD Engine/node_modules/@deepseek-ai/dsh-blender/lib/worker.js', expect.stringMatching(/^[A-Za-z0-9_-]+$/u)],
      env: { ELECTRON_RUN_AS_NODE: '1', PYTHONPATH: '', PYTHONHOME: '', VIRTUAL_ENV: '' },
      cwd: '',
      toolCallTimeoutMs: 900_000,
      startupTimeoutMs: 30_000,
      closeTimeoutMs: 15_000,
      reconnect: { enabled: true, initialDelayMs: 1_000, maxDelayMs: 30_000, maxAttempts: 5 },
    })
    expect(decodeServerOptions([process.execPath, ...entry.args ?? []])).toEqual(REGISTRATION.options)
    for (const value of [entry.command, ...entry.args ?? [], ...Object.values(entry.env ?? {})]) expect(value).not.toContain('${')
  })

  it('runs a TypeScript entry through tsx with the repository configuration', async () => {
    const entry = await registeredEntry({ ...REGISTRATION, entry: SOURCE_SERVER })
    const tsconfig = fileURLToPath(new URL('../../../../tsconfig.base.json', import.meta.url))
    expect(entry).toMatchObject({
      command: process.execPath,
      args: ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(SOURCE_SERVER), expect.stringMatching(/^[A-Za-z0-9_-]+$/u)],
      env: { ELECTRON_RUN_AS_NODE: '1', PYTHONPATH: '', PYTHONHOME: '', VIRTUAL_ENV: '', TSX_TSCONFIG_PATH: tsconfig },
    })
    expect(existsSync(tsconfig)).toBe(true)
    // Node drops its own flags from process.argv, so the server still finds its options at argv[2].
    expect(decodeServerOptions([process.execPath, ...entry.args!.slice(2)])).toEqual(REGISTRATION.options)
  })

  it('starts a TypeScript entry from its registered command line in any working directory', async () => {
    const entry = await registeredEntry({ ...REGISTRATION, entry: SOURCE_SERVER, options: { greeting: 'hello from source' } })
    // The MCP client adds the scrubbed Host environment; the SDK's safe default variables stand in for it.
    const transport = new StdioClientTransport({
      command: entry.command!, args: entry.args!, env: entry.env!, cwd: await temporaryDirectory('dsh-app-mcp-source-'), stderr: 'pipe',
    })
    let stderr = ''
    transport.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const client = new Client({ name: 'spec', version: '1.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    onTestFinished(() => client.close())
    await client.connect(transport).catch((error: unknown) => { throw new Error(`the source server did not start: ${stderr}`, { cause: error }) })
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['greet'])
    expect(textOf(await client.callTool({ name: 'greet', arguments: {} }))).toBe('hello from source')
  }, SOURCE_TIMEOUT)

  it('removes the registration when the plugin is disposed', async () => {
    const { ctx, unregister } = mountManager()
    const plugin = ctx.plugin({ name: 'gimp', inject: ['mcpManager'], apply(child: Context) { registerAppMcpServer(child, { ...REGISTRATION, serverName: 'wasd_gimp' }) } })
    await plugin.await()
    expect(unregister).not.toHaveBeenCalled()
    await plugin.dispose()
    expect(unregister).toHaveBeenCalled()
  })

  it('fails the plugin when the entry is not a file URL', async () => {
    const { ctx, register } = mountManager()
    const plugin = ctx.plugin({
      name: 'broken',
      inject: ['mcpManager'],
      apply(child: Context) { registerAppMcpServer(child, { ...REGISTRATION, entry: new URL('https://example.com/mcp-server.js') }) },
    })
    await expect(plugin.await()).rejects.toThrow(TypeError)
    expect(register).not.toHaveBeenCalled()
  })
})
