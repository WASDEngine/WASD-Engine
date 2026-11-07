/** Model-visible text of the Blender MCP server: its name, which qualifies every tool name, instructions, and tool declarations. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL_CALL_RESERVE_MS } from '@deepseek-ai/dsh-app-mcp'
import { BLENDER_INSTRUCTIONS, BLENDER_SERVER_NAME } from '../src/instructions.ts'
import { blenderTools } from '../src/tools.ts'

// The budgets of the default Config, as the server passes them: a worker request may use the tool-call budget less the reserve.
const tools = blenderTools({
  call: async () => null, takeNotes: () => [], dataRoot: '/data/blender', requestTimeoutMs: 600_000, maxTimeoutMs: 900_000 - TOOL_CALL_RESERVE_MS,
})

it('names the server wasd_blender, so the model calls mcp__wasd_blender__<tool>', () => {
  expect(BLENDER_SERVER_NAME).toBe('wasd_blender')
})

it('keeps the instructions within 6000 characters and names only tools the server provides', () => {
  expect(BLENDER_INSTRUCTIONS.length).toBeLessThanOrEqual(6000)
  const names = new Set(tools.map(tool => tool.name))
  const mentioned = ['scene_info', 'object_info', 'execute_python', 'render_preview', 'render', 'python_api', 'new_scene', 'open_blend', 'save_blend', 'export_gltf', 'checkpoint', 'undo']
  for (const name of mentioned) {
    expect(BLENDER_INSTRUCTIONS).toContain(name)
    expect(names.has(name)).toBe(true)
  }
  expect(BLENDER_INSTRUCTIONS).toMatchSnapshot('instructions')
})

it('pins the tool declarations', () => {
  const declarations = tools.map(tool => ({
    name: tool.name, title: tool.title, description: tool.description, input: z.toJSONSchema(z.object(tool.input)),
  }))
  expect(declarations).toMatchSnapshot('tool declarations')
})
