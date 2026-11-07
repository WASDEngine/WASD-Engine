/**
 * The tool helpers: reply validation, typed declarations, request parameters,
 * setup notes, file sizes, and the shared `execute_python` tool's schema,
 * worker request, and result text.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  WorkerReplyError, defineAppTool, executePythonTool, formatBytes, replyParser, withSetupNotes, workerParams, type AppToolDependencies,
} from '../src/tools.ts'
import type { JsonObject, JsonValue } from '../src/types.ts'

const signal = new AbortController().signal

interface Call { method: string; params: JsonObject; options: { readonly signal: AbortSignal; readonly timeoutMs?: number } }

function dependencies(
  reply: JsonValue, notes: string[] = [], budgets: Partial<AppToolDependencies> = {},
): AppToolDependencies & { calls: Call[] } {
  const calls: Call[] = []
  return {
    calls,
    async call(method, params, options) {
      calls.push({ method, params, options })
      return reply
    },
    takeNotes: () => notes.splice(0),
    dataRoot: '/data/app',
    requestTimeoutMs: 600_000,
    maxTimeoutMs: 900_000,
    ...budgets,
  }
}

const TEXT = { app: 'Paint', title: 'Run Paint Python', description: 'Run Python in the Paint session.' }

describe('replyParser', () => {
  it('returns the typed reply and names the application, method, and mismatch otherwise', () => {
    const parse = replyParser('Paint')
    const Reply = z.object({ id: z.int() })
    expect(parse(Reply, 'new_image', { id: 3 })).toEqual({ id: 3 })
    let caught: unknown
    try {
      parse(Reply, 'new_image', { id: 'three' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(WorkerReplyError)
    expect(caught).toMatchObject({ name: 'WorkerReplyError', message: expect.stringMatching(/^The Paint worker sent an unexpected new_image reply: [\s\S]*id/) as string })
  })
})

describe('defineAppTool and workerParams', () => {
  it('keeps the declaration and passes only the given arguments', async () => {
    const declared = { name: 'echo', description: 'Echo the text.', input: { text: z.string() }, run: async (args: { text: string }) => ({ text: args.text }) }
    const tool = defineAppTool(declared)
    expect(tool).toBe(declared)
    await expect(tool.run({ text: 'hi' }, signal)).resolves.toEqual({ text: 'hi' })
    expect(workerParams({ image: 1, layer: undefined, name: 'tile', list: [1, 'a'], none: null })).toEqual({ image: 1, name: 'tile', list: [1, 'a'], none: null })
    expect(workerParams({})).toEqual({})
  })
})

describe('withSetupNotes', () => {
  it('puts pending notes before the text once and leaves results without notes unchanged', () => {
    const notes = ['Paint 1.0 started.', 'Installed brushes.']
    const result = { text: 'Done.', isError: true }
    expect(withSetupNotes({ takeNotes: () => notes.splice(0) }, result)).toEqual({ text: 'Paint 1.0 started.\n\nInstalled brushes.\n\nDone.', isError: true })
    expect(withSetupNotes({ takeNotes: () => notes.splice(0) }, result)).toBe(result)
  })
})

describe('formatBytes', () => {
  it('uses bytes below 1 KiB, then KiB, then MiB, with one decimal', () => {
    expect(formatBytes(0)).toBe('0 bytes')
    expect(formatBytes(1023)).toBe('1023 bytes')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(6292)).toBe('6.1 KiB')
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KiB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MiB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MiB')
  })
})

describe('executePythonTool', () => {
  it('declares the code and timeout arguments from the request budgets', () => {
    const tool = executePythonTool(dependencies(null), TEXT)
    expect(tool).toMatchObject({ name: 'execute_python', title: 'Run Paint Python', description: 'Run Python in the Paint session.' })
    const schema = z.object(tool.input)
    expect(z.toJSONSchema(schema)).toMatchObject({
      properties: {
        code: { type: 'string', minLength: 1, maxLength: 200_000, description: 'Python source to run.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 900, description: 'Seconds before Paint is stopped and restarted (default 600).' },
      },
      required: ['code'],
    })
    expect(schema.safeParse({ code: '' }).success).toBe(false)
    expect(schema.safeParse({ code: 'x'.repeat(200_001) }).success).toBe(false)
    expect(schema.safeParse({ code: 'x = 1', timeout_seconds: 900 }).success).toBe(true)
    expect(schema.safeParse({ code: 'x = 1', timeout_seconds: 901 }).success).toBe(false)
    expect(schema.safeParse({ code: 'x = 1', timeout_seconds: 1.5 }).success).toBe(false)
    expect(schema.safeParse({ code: 'x = 1', timeout_seconds: 0 }).success).toBe(false)
    const shortBudgets = executePythonTool(dependencies(null, [], { requestTimeoutMs: 1499, maxTimeoutMs: 999 }), TEXT)
    expect(z.toJSONSchema(z.object(shortBudgets.input))).toMatchObject({ properties: { timeout_seconds: { maximum: 1, description: 'Seconds before Paint is stopped and restarted (default 1).' } } })
  })

  it('sends the code with the default or requested budget and reports result and output after pending notes', async () => {
    const deps = dependencies({ result: { layers: 2 }, output: 'hello\n', seconds: 0.01 }, ['Paint 1.0 started.'])
    const tool = executePythonTool(deps, TEXT)
    await expect(tool.run({ code: 'print("hello")' }, signal))
      .resolves.toEqual({ text: 'Paint 1.0 started.\n\nresult: {"layers":2}\n\noutput:\nhello\n', isError: false })
    await tool.run({ code: 'x = 1', timeout_seconds: 5 }, signal)
    expect(deps.calls).toEqual([
      { method: 'execute_python', params: { code: 'print("hello")' }, options: { signal } },
      { method: 'execute_python', params: { code: 'x = 1' }, options: { signal, timeoutMs: 5000 } },
    ])
  })

  it('fails with the traceback first, or the exception type and message without one', async () => {
    const traceback = 'Traceback (most recent call last):\n  File "<execute_python>", line 1\nValueError: boom\n'
    const error = { type: 'ValueError', message: 'boom', traceback }
    const raised = executePythonTool(dependencies({ result: null, output: 'partial\n', seconds: 0, error }), TEXT)
    await expect(raised.run({ code: 'raise ValueError("boom")' }, signal)).resolves.toEqual({ text: `${traceback.trim()}\n\noutput:\npartial\n`, isError: true })
    const bare = executePythonTool(dependencies({ result: null, output: '', seconds: null, error: { type: 'SystemExit', message: '3', traceback: '  ' } }), TEXT)
    await expect(bare.run({ code: 'raise SystemExit(3)' }, signal)).resolves.toEqual({ text: 'SystemExit: 3', isError: true })
  })

  it('says when the code returned nothing and rejects a malformed reply', async () => {
    await expect(executePythonTool(dependencies({ result: null, output: '', seconds: 0 }), TEXT).run({ code: 'pass' }, signal))
      .resolves.toEqual({ text: 'Done. The code assigned no result and printed nothing.', isError: false })
    const broken = executePythonTool(dependencies({ output: 3 }), TEXT).run({ code: 'pass' }, signal)
    await expect(broken).rejects.toBeInstanceOf(WorkerReplyError)
    await expect(broken).rejects.toThrow(/^The Paint worker sent an unexpected execute_python reply: [\s\S]*output/)
  })
})
