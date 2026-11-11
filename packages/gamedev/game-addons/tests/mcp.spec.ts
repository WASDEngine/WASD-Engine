/** The add-on tool for agents connected through WASD Engine's MCP server. */
import { describe, expect, it, vi } from 'vitest'
import { gameAddonMcpProvider, MCP_PROVIDER_ID } from '../src/mcp.ts'
import { TOOL_NAME, type GameAddonToolHost } from '../src/tools.ts'

const host: GameAddonToolHost = {
  manager: {} as GameAddonToolHost['manager'],
  project: requested => Promise.resolve(requested ?? '/none'),
}

describe('gameAddonMcpProvider', () => {
  it('offers game_addons under the game prefix, requires absolute projects, and needs one for changes', async () => {
    const provider = gameAddonMcpProvider(host)
    expect(provider.id).toBe(MCP_PROVIDER_ID)
    const [tool] = provider.tools()
    expect(tool?.name).toBe(TOOL_NAME)
    expect(tool?.name.startsWith(`${provider.id}_`)).toBe(true)
    expect(tool?.readOnly).toBe(false)
    const parameters = tool?.definition.parameters as { properties: { project: { description: string } } }
    expect(parameters.properties.project.description).toMatch(/^Absolute path/u)
    const call = { client: { id: 'claude-code', title: 'Claude Code' }, signal: new AbortController().signal, session: vi.fn(), reveal: vi.fn() }
    await expect(tool!.prepare!({ action: 'search', project: 'relative' }, call)).rejects.toThrow(/project must be an absolute path/u)
    await expect(tool!.prepare!({ action: 'install', id: 'x' }, call)).rejects.toThrow(/action install needs project/u)
    expect(await tool!.prepare!({ action: 'search', query: 'camera' }, call)).toEqual({ args: { action: 'search', query: 'camera' } })
    expect(await tool!.prepare!({ action: 'remove', id: 'x', project: '/games/a' }, call)).toEqual({ args: { action: 'remove', id: 'x', project: '/games/a' } })
    expect(call.session).not.toHaveBeenCalled()
    expect(provider.instructions).toContain('wasd_addons.enable')
    expect(await provider.status(new AbortController().signal)).toEqual({ state: 'ready' })
  })
})
