/**
 * Blender MCP server process entry: serves the Blender tools over stdio with the options that the
 * Host plugin passed in argv; a Session's Blender worker starts on its first tool call, `run_script` runs start
 * Blender processes of their own, and both stop when the server closes. Wiring only: the modules it connects carry
 * the behavior and their tests.
 */
import { fileURLToPath } from 'node:url'
import { nodeMachine, runAppMcpServer, shippedRuntimeRoot, type AppWorkerScope } from '@deepseek-ai/dsh-app-mcp'
import { BlenderWorkers, nodeBlenderSetupHost, parseServerOptions } from './environment.ts'
import { BLENDER_INSTRUCTIONS, BLENDER_SERVER_NAME } from './instructions.ts'
import { BlenderScripts } from './scripts.ts'
import { blenderTools } from './tools.ts'

/** Serve the tools until the client closes the server; a server that cannot start reports why on stderr and exits with code 1. */
async function main(): Promise<void> {
  try {
    await runAppMcpServer({
      name: BLENDER_SERVER_NAME,
      app: 'Blender',
      version: '1.0.0',
      instructions: BLENDER_INSTRUCTIONS,
      workerScript: new URL('../py/wasd_blender_worker.py', import.meta.url),
      parseOptions: parseServerOptions,
      workers: (options, dependencies) => {
        const workers = new BlenderWorkers(options, {
          ...dependencies,
          host: nodeBlenderSetupHost(options.maxLogBytes),
          bundledRoot: shippedRuntimeRoot(fileURLToPath(new URL('..', import.meta.url))),
        })
        const scripts = new BlenderScripts(options, { launch: async signal => await workers.scriptLaunch(signal), machine: nodeMachine() })
        return {
          start: async (signal: AbortSignal, scope: AppWorkerScope) => await workers.start(signal, scope),
          takeNotes: () => workers.takeNotes(),
          close: () => { scripts.close() },
          scripts,
        }
      },
      tools: (dependencies, { scripts }) => blenderTools(dependencies, scripts),
    }, process.argv)
  } catch (error) {
    process.stderr.write(`${BLENDER_SERVER_NAME}: the MCP server could not start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

void main()
