/** Model-visible text of the SuperCollider MCP server: its name, which qualifies every tool name, instructions, and tool declarations. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL_CALL_RESERVE_MS } from '@deepseek-ai/dsh-app-mcp'
import { SUPERCOLLIDER_INSTRUCTIONS, SUPERCOLLIDER_SERVER_NAME } from '../src/instructions.ts'
import { superColliderTools } from '../src/tools.ts'

// The budgets of the default Config, as the server passes them: a worker request may use the tool-call budget less the reserve.
const tools = superColliderTools({
  call: async () => null, takeNotes: () => [], dataRoot: '/data/supercollider', requestTimeoutMs: 600_000, maxTimeoutMs: 900_000 - TOOL_CALL_RESERVE_MS,
})

it('names the server wasd_supercollider, so the model calls mcp__wasd_supercollider__<tool>', () => {
  expect(SUPERCOLLIDER_SERVER_NAME).toBe('wasd_supercollider')
})

it('keeps the instructions within 6000 characters and names only tools the server provides', () => {
  expect(SUPERCOLLIDER_INSTRUCTIONS.length).toBeLessThanOrEqual(6000)
  const names = new Set(tools.map(tool => tool.name))
  for (const name of ['render_audio', 'analyze_audio', 'execute_sclang', 'class_info']) {
    expect(SUPERCOLLIDER_INSTRUCTIONS).toContain(name)
    expect(names.has(name)).toBe(true)
  }
  expect(names.size).toBe(4)
  expect(SUPERCOLLIDER_INSTRUCTIONS).toMatchSnapshot('instructions')
})

it('pins the tool declarations', () => {
  const declarations = tools.map(tool => ({
    name: tool.name, title: tool.title, description: tool.description, input: z.toJSONSchema(z.object(tool.input)),
  }))
  expect(declarations).toMatchSnapshot('tool declarations')
})
