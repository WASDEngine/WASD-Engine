/** Model-visible text of the GIMP MCP server: its name, which qualifies every tool name, instructions, and tool declarations. */
import { expect, it } from 'vitest'
import { z } from 'zod'
import { TOOL_CALL_RESERVE_MS } from '@deepseek-ai/dsh-app-mcp'
import { GIMP_INSTRUCTIONS, GIMP_SERVER_NAME } from '../src/instructions.ts'
import { gimpTools } from '../src/tools.ts'

// The budgets of the default Config, as the server passes them: a worker request may use the tool-call budget less the reserve.
const tools = gimpTools({
  call: async () => null, takeNotes: () => [], dataRoot: '/data/gimp', requestTimeoutMs: 600_000, maxTimeoutMs: 900_000 - TOOL_CALL_RESERVE_MS,
})

it('names the server wasd_gimp, so the model calls mcp__wasd_gimp__<tool>', () => {
  expect(GIMP_SERVER_NAME).toBe('wasd_gimp')
})

it('keeps the instructions within 6000 characters and names only tools the server provides', () => {
  expect(GIMP_INSTRUCTIONS.length).toBeLessThanOrEqual(6000)
  const names = new Set(tools.map(tool => tool.name))
  const mentioned = [
    'new_image', 'open_image', 'list_images', 'close_image', 'image_info', 'snapshot', 'layer', 'select', 'draw', 'transform',
    'filters', 'filter_info', 'apply_filter', 'pdb_search', 'pdb_describe', 'pdb_run', 'execute_python', 'export_image',
    'save_xcf', 'make_sprite_sheet', 'make_seamless',
  ]
  for (const name of mentioned) {
    expect(GIMP_INSTRUCTIONS).toContain(name)
    expect(names.has(name)).toBe(true)
  }
  expect(GIMP_INSTRUCTIONS).toMatchSnapshot('instructions')
})

it('pins the tool declarations', () => {
  const declarations = tools.map(tool => ({
    name: tool.name, title: tool.title, description: tool.description, input: z.toJSONSchema(z.object(tool.input)),
  }))
  expect(declarations).toMatchSnapshot('tool declarations')
})
