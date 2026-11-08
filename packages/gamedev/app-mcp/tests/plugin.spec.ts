/**
 * The shared plugin Config fields and registerAppMcpPlugin against a real
 * Cordis context with a recording MCP manager: path checks, the server
 * options taken from the Config, the entry beside the plugin module, and
 * removal on disposal.
 */
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { AppMcpConfig } from '../src/index.ts'
import { decodeServerOptions } from '../src/options.ts'
import { registerAppMcpPlugin } from '../src/plugin.ts'

interface PaintConfig extends AppMcpConfig {
  dataRoot: string
  paintPath: string
  brushes: number
  startupTimeoutMs: number
}

const PaintConfig: z<Partial<PaintConfig>, PaintConfig> = z.object({
  dataRoot: z.string().min(1).required(),
  paintPath: z.string().default(''),
  brushes: z.natural().default(3),
  startupTimeoutMs: z.natural().min(1).default(30_000),
  ...AppMcpConfig.dict as { [Key in keyof AppMcpConfig]: z<unknown, AppMcpConfig[Key]> },
})

const PLUGIN = { app: 'Paint', serverName: 'wasd_paint', paths: ['paintPath'], options: ['paintPath', 'brushes'] } as const

function mountManager() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const unregister = vi.fn()
  const register = vi.fn((_name: string, _entry: McpServerRegistration) => unregister)
  ctx.provide('mcpManager', { register })
  return { ctx, register, unregister }
}

function registered(register: ReturnType<typeof mountManager>['register']): McpServerRegistration {
  expect(register).toHaveBeenCalledOnce()
  return register.mock.calls[0]![1]
}

describe('AppMcpConfig', () => {
  it('defaults the shared budgets and bounds them', () => {
    expect(AppMcpConfig({})).toEqual({
      toolCallTimeoutMs: 900_000, requestTimeoutMs: 600_000, graceMs: 3000, maxLogBytes: 65_536,
      maxWorkers: 4, workerIdleTimeoutMs: 600_000,
    })
    expect(PaintConfig({ dataRoot: '/data/paint' })).toEqual({
      dataRoot: '/data/paint', paintPath: '', brushes: 3, startupTimeoutMs: 30_000,
      toolCallTimeoutMs: 900_000, requestTimeoutMs: 600_000, graceMs: 3000, maxLogBytes: 65_536,
      maxWorkers: 4, workerIdleTimeoutMs: 600_000,
    })
    for (const invalid of [
      { requestTimeoutMs: 0 }, { toolCallTimeoutMs: 2_147_483_648 }, { graceMs: 1.5 }, { maxLogBytes: 0 },
      { maxWorkers: 0 }, { maxWorkers: 17 }, { workerIdleTimeoutMs: 0 },
    ]) {
      expect(() => AppMcpConfig(invalid)).toThrow()
      expect(() => PaintConfig({ dataRoot: '/d', ...invalid })).toThrow()
    }
  })
})

describe('registerAppMcpPlugin', () => {
  it('passes the shared fields and the named Config fields to the server entry beside a built module', async () => {
    const { ctx, register, unregister } = mountManager()
    const config = PaintConfig({ dataRoot: '/data/paint', paintPath: '/opt/paint/bin/paint', requestTimeoutMs: 120_000, startupTimeoutMs: 45_000 })
    const plugin = ctx.plugin({
      name: 'paint',
      inject: ['mcpManager'],
      apply(child: Context) { registerAppMcpPlugin(child, config, { ...PLUGIN, module: 'file:///opt/WASD%20Engine/paint/lib/index.js' }) },
    })
    await plugin.await()
    const entry = registered(register)
    expect(register.mock.calls[0]![0]).toBe('wasd_paint')
    expect(entry).toMatchObject({ command: process.execPath, toolCallTimeoutMs: 900_000, startupTimeoutMs: 45_000 })
    const [script = '', encoded = ''] = entry.args ?? []
    expect(script).toBe('/opt/WASD Engine/paint/lib/worker.js')
    expect(decodeServerOptions([process.execPath, script, encoded])).toEqual({
      dataRoot: '/data/paint', requestTimeoutMs: 120_000, toolCallTimeoutMs: 900_000, graceMs: 3000, maxLogBytes: 65_536,
      maxWorkers: 4, workerIdleTimeoutMs: 600_000, paintPath: '/opt/paint/bin/paint', brushes: 3,
    })
    await plugin.dispose()
    expect(unregister).toHaveBeenCalled()
  })

  it('registers the TypeScript entry beside a source module', async () => {
    const { ctx, register } = mountManager()
    const module = new URL('../src/index.ts', import.meta.url).href
    await ctx.plugin({
      name: 'paint',
      inject: ['mcpManager'],
      apply(child: Context) { registerAppMcpPlugin(child, PaintConfig({ dataRoot: '/data/paint' }), { ...PLUGIN, module }) },
    }).await()
    expect(registered(register).args).toContain(fileURLToPath(new URL('../src/worker.ts', import.meta.url)))
  })

  it.each([
    ['dataRoot', { dataRoot: 'data/paint' }, 'data/paint'],
    ['paintPath', { dataRoot: '/data/paint', paintPath: 'bin/paint' }, 'bin/paint'],
  ])('refuses a relative %s before registering', (field, values, value) => {
    const { ctx, register } = mountManager()
    expect(() => { registerAppMcpPlugin(ctx, PaintConfig(values), { ...PLUGIN, module: 'file:///opt/paint/lib/index.js' }) })
      .toThrow(`Paint plugin: ${field} must be an absolute path, got ${JSON.stringify(value)}`)
    expect(register).not.toHaveBeenCalled()
  })

  it('keeps 30 s of the tool-call budget out of the request budget', async () => {
    const { ctx, register } = mountManager()
    const module = 'file:///opt/paint/lib/index.js'
    expect(() => { registerAppMcpPlugin(ctx, PaintConfig({ dataRoot: '/data/paint', requestTimeoutMs: 870_001 }), { ...PLUGIN, module }) })
      .toThrow('Paint plugin: requestTimeoutMs (870001) must be at least 30000 less than toolCallTimeoutMs (900000), which keeps that time for a worker start and the result')
    expect(register).not.toHaveBeenCalled()
    await ctx.plugin({
      name: 'paint',
      inject: ['mcpManager'],
      apply(child: Context) { registerAppMcpPlugin(child, PaintConfig({ dataRoot: '/data/paint', requestTimeoutMs: 870_000 }), { ...PLUGIN, module }) },
    }).await()
    expect(registered(register)).toMatchObject({ toolCallTimeoutMs: 900_000 })
  })
})
