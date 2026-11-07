/**
 * SuperCollider MCP server process entry: serves the SuperCollider tools over stdio with the options that the Host
 * plugin passed in argv; the sclang worker starts on the first tool call and stops when the server closes. The worker
 * is this entry again, run with the bridge plan in argv[2] and `--sclang-bridge` in argv[3], which runs sclang behind
 * the worker protocol. Wiring only: the modules it connects carry the behavior and their tests.
 */
import { writeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runAppMcpServer } from '@deepseek-ai/dsh-app-mcp'
import { bundledRuntimeRoot, nodeSuperColliderSetupHost, parseServerOptions, SCLANG_BRIDGE_ARGUMENT, SuperColliderWorkers } from './environment.ts'
import { SUPERCOLLIDER_INSTRUCTIONS, SUPERCOLLIDER_SERVER_NAME } from './instructions.ts'
import { runSclangBridge } from './sclang-bridge.ts'
import { superColliderTools } from './tools.ts'

/** Serve the tools until the client closes the server; a server that cannot start reports why on stderr and exits with code 1. */
async function main(): Promise<void> {
  try {
    await runAppMcpServer({
      name: SUPERCOLLIDER_SERVER_NAME,
      version: '1.0.0',
      instructions: SUPERCOLLIDER_INSTRUCTIONS,
      workerScript: new URL('../sc/WasdWorker.sc', import.meta.url),
      parseOptions: parseServerOptions,
      workers: (options, dependencies) => new SuperColliderWorkers(options, {
        ...dependencies,
        host: nodeSuperColliderSetupHost(),
        bundledRoot: bundledRuntimeRoot(fileURLToPath(new URL('..', import.meta.url))),
        // The server's own loader flags, such as tsx's in a source launch, run this entry again as the bridge.
        bridge: [process.execPath, ...process.execArgv, fileURLToPath(import.meta.url)],
      }),
      tools: superColliderTools,
    }, process.argv)
  } catch (error) {
    process.stderr.write(`${SUPERCOLLIDER_SERVER_NAME}: the MCP server could not start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

/** File descriptor of the worker protocol's ready line and replies. */
const REPLIES_FD = 3

if (process.argv[3] === SCLANG_BRIDGE_ARGUMENT) {
  runSclangBridge({
    argv: process.argv,
    env: process.env,
    stdin: process.stdin,
    log: (text) => { process.stderr.write(text) },
    reply: (line) => { writeSync(REPLIES_FD, line) },
    exit: (code) => { process.exit(code) },
  })
} else void main()
