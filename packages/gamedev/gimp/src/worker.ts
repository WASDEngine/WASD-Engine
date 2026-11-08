/**
 * GIMP MCP server process entry: serves the GIMP tools over stdio with the options that the Host
 * plugin passed in argv; the GIMP worker starts on the first tool call and stops when the server
 * closes. Wiring only: the modules it connects carry the behavior and their tests.
 */
import { nodeSetupHost, runAppMcpServer } from '@deepseek-ai/dsh-app-mcp'
import { GimpWorkers, parseServerOptions } from './environment.ts'
import { GIMP_INSTRUCTIONS, GIMP_SERVER_NAME } from './instructions.ts'
import { gimpTools } from './tools.ts'

/** Serve the tools until the client closes the server; a server that cannot start reports why on stderr and exits with code 1. */
async function main(): Promise<void> {
  try {
    await runAppMcpServer({
      name: GIMP_SERVER_NAME,
      app: 'GIMP',
      version: '1.0.0',
      instructions: GIMP_INSTRUCTIONS,
      workerScript: new URL('../py/wasd_gimp_worker.py', import.meta.url),
      parseOptions: parseServerOptions,
      workers: (options, dependencies) => new GimpWorkers(options, { ...dependencies, host: nodeSetupHost() }),
      tools: gimpTools,
    }, process.argv)
  } catch (error) {
    process.stderr.write(`${GIMP_SERVER_NAME}: the MCP server could not start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

void main()
