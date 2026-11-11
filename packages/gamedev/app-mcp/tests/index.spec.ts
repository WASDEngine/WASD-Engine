/** The package's runtime exports: a library with no plugin protocol slots. */
import { expect, it } from 'vitest'
import * as AppMcp from '../src/index.ts'

it('exports the library runtime and no plugin', () => {
  expect(Object.keys(AppMcp).toSorted()).toEqual([
    'AGENT_IMAGE_MAX_BYTES',
    'AGENT_IMAGE_MAX_EDGE',
    'AppMcpConfig',
    'AppServerOptionFields',
    'JsonLineWorker',
    'SESSION_SCOPE_CAPABILITY',
    'SESSION_SCOPE_META_KEY',
    'SHARED_SCOPE',
    'ShippedRuntimeFields',
    'ShippedRuntimePath',
    'TOOL_CALL_RESERVE_MS',
    'WorkerError',
    'WorkerPool',
    'WorkerReplyError',
    'WorkerSupervisor',
    'decodeServerOptions',
    'defineAppTool',
    'encodeServerOptions',
    'executePythonTool',
    'findOnPath',
    'findTar',
    'firstExecutable',
    'formatBytes',
    'lowMemoryMessage',
    'materializePayload',
    'memoryShortage',
    'moveIntoPlace',
    'newestFirst',
    'nodeMachine',
    'nodeRuntimeUnpackHost',
    'nodeSetupHost',
    'nodeShippedRuntimeHost',
    'parseAppServerOptions',
    'processLimit',
    'readPackedRuntime',
    'readShippedRuntime',
    'registerAppMcpPlugin',
    'registerAppMcpServer',
    'replyParser',
    'runAppMcpServer',
    'runCommand',
    'serveAppMcp',
    'sessionOf',
    'shippedRuntimeRoot',
    'unpackPackedRuntime',
    'unpackedRuntimeDirectory',
    'withSetupNotes',
    'workerParams',
  ])
  expect('default' in AppMcp).toBe(false)
  expect('apply' in AppMcp).toBe(false)
  expect('Config' in AppMcp).toBe(false)
})

it('keeps 30 s of each tool call for a worker start and the result', () => {
  expect(AppMcp.TOOL_CALL_RESERVE_MS).toBe(30_000)
})

it('sizes agent images to fit one image of a tool result', () => {
  expect(AppMcp.AGENT_IMAGE_MAX_EDGE).toBe(1568)
  expect(AppMcp.AGENT_IMAGE_MAX_BYTES).toBe(3 * 1024 * 1024)
  expect(4 * Math.ceil(AppMcp.AGENT_IMAGE_MAX_BYTES / 3)).toBe(4 * 1024 * 1024)
})
