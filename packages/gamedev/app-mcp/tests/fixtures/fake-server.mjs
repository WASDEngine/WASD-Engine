/**
 * App MCP server fixture: a plain-Node entry, started like a package's built
 * lib/mcp-server.js, that serves fake tools through the package source. It
 * registers tsx first, so the TypeScript sources and their workspace imports
 * resolve as they do in the specs. argv[2] carries the server options:
 * `events`, a file that receives one "<event> <pid>" line per lifecycle
 * event, and `worker`, the argv of the fake worker the tools call.
 */
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { register } from 'tsx/esm/api'

register({ tsconfig: fileURLToPath(new URL('../../../../../tsconfig.json', import.meta.url)) })
const { decodeServerOptions, JsonLineWorker, serveAppMcp, WorkerSupervisor } = await import('../../src/index.ts')
const { z } = await import('zod')

const options = decodeServerOptions(process.argv)
const record = (event) => { appendFileSync(options.events, `${event} ${process.pid}\n`) }
record('start')

const supervisor = new WorkerSupervisor((signal) => JsonLineWorker.start({
  argv: options.worker, cwd: process.cwd(), env: { ...process.env }, readyTimeoutMs: 15_000, logTailBytes: 4096,
}, signal), { requestTimeoutMs: 15_000, closeGraceMs: 1_000 })

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const worker = (method) => async (args, signal) => ({ text: JSON.stringify(await supervisor.call(method, args, { signal })) })

await serveAppMcp({
  name: 'fake-app',
  version: '1.0.0',
  instructions: 'Fake application tools for the specs.',
  tools: [
    { name: 'echo', description: 'Return the text.', input: { text: z.string() }, run: async ({ text }) => ({ text }) },
    { name: 'image', description: 'Return a one-pixel PNG.', input: {}, run: async () => ({ text: 'pixel', images: [{ data: PIXEL, mimeType: 'image/png' }] }) },
    {
      name: 'oversize', description: 'Return an image above the size limit.', input: {},
      run: async () => ({ text: 'big', images: [{ data: new Uint8Array(3 * 1024 * 1024 + 1), mimeType: 'image/png' }] }),
    },
    { name: 'fail', description: 'Throw.', input: {}, run: async () => { throw new Error('the tool failed') } },
    {
      name: 'noisy', description: 'Write to the console.', input: {},
      run: async () => {
        console.log('log noise')
        console.info('info noise')
        console.debug('debug noise')
        console.warn('warn noise')
        return { text: 'quiet' }
      },
    },
    { name: 'worker_echo', description: 'Echo through the worker.', input: { text: z.string() }, run: worker('echo') },
    { name: 'worker_pid', description: 'Report the worker pid.', input: {}, run: worker('pid') },
    { name: 'worker_crash', description: 'Crash the worker.', input: {}, run: worker('crash') },
  ],
  onClose: async () => {
    await supervisor.close()
    record('closed')
  },
})
record('serving')
