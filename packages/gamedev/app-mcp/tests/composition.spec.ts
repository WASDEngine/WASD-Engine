/**
 * The whole chain with real services: a plugin registers the fixture server
 * through registerAppMcpServer, the real MCP manager and MCP client start it
 * from the registered entry, its tools reach the tool registry under
 * `mcp__<serverName>__` names and run through the native executor, and
 * disposing the plugin withdraws the tools and shuts the server and its
 * worker down.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished, vi } from 'vitest'
import { registerAppMcpServer } from '../src/register.ts'
import { FAKE_SERVER, FAKE_WORKER, eventsIn, isAlive, killQuietly, temporaryDirectory } from './harness.ts'

const TIMEOUT = 60_000

function call(ctx: Context, name: string, args: Record<string, unknown>) {
  return executeToolFixture(ctx, { name, arguments: args, callId: ToolCallId(name), signal: new AbortController().signal })
}

it('serves the registered app tools through the MCP manager for the plugin lifetime', async () => {
  const events = join(await temporaryDirectory('dsh-app-mcp-composition-'), 'events')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    for (const { pid } of await eventsIn(events)) killQuietly(pid)
  })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(McpServerManager, {})
  const plugin = ctx.plugin({
    name: 'fake-app',
    inject: ['mcpManager'],
    apply(child: Context) {
      registerAppMcpServer(child, {
        serverName: 'fake',
        entry: pathToFileURL(FAKE_SERVER),
        // A template-looking value proves the options never reach credential expansion.
        options: { events, worker: [process.execPath, FAKE_WORKER], note: '${credential:NOT_A_TEMPLATE}' },
        toolCallTimeoutMs: 30_000,
        startupTimeoutMs: 30_000,
      })
    },
  })
  await plugin.await()
  await vi.waitFor(() => {
    expect(ctx.get('mcpManager')!.list()).toMatchObject([{ name: 'fake', status: { state: 'connected' } }])
  }, { timeout: TIMEOUT })
  expect(ctx.tools.get('mcp__fake__echo')).toBeDefined()
  expect(ctx.tools.get('mcp__fake__worker_pid')).toBeDefined()

  const echoed = await call(ctx, 'mcp__fake__echo', { text: 'through the manager' })
  expect(echoed).toMatchObject({ isError: false, value: { content: [{ type: 'text', text: 'through the manager' }] } })
  const pid = await call(ctx, 'mcp__fake__worker_pid', {})
  expect(pid.isError).toBe(false)
  const worker = Number((pid as { value: { content: Array<{ text: string }> } }).value.content[0]!.text)
  onTestFinished(() => { killQuietly(worker) })
  expect(isAlive(worker)).toBe(true)
  const failed = await call(ctx, 'mcp__fake__fail', {})
  expect(failed.isError).toBe(true)

  await plugin.dispose()
  expect(ctx.tools.get('mcp__fake__echo')).toBeUndefined()
  expect(ctx.get('mcpManager')!.list()).toEqual([])
  await vi.waitFor(async () => {
    const lines = await eventsIn(events)
    const started = lines.filter(line => line.event === 'start').map(line => line.pid)
    expect(started.length).toBeGreaterThan(0)
    expect(lines.filter(line => line.event === 'closed').map(line => line.pid).toSorted()).toEqual(started.toSorted())
    for (const server of [...started, worker]) expect(isAlive(server)).toBe(false)
  }, { timeout: TIMEOUT })
}, TIMEOUT)
