/** The add-on tool for agents connected through WASD Engine's MCP server. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { gameAddonMcpProvider, MCP_PROVIDER_ID } from '../src/mcp.ts'
import { mcpInstructions } from '../src/prompt.ts'
import { TOOL_NAME, type GameAddonToolHost } from '../src/tools.ts'
import { scratch, writeCatalog, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined

afterEach(async () => {
  await dir?.cleanup()
  dir = undefined
})

async function host(): Promise<{ host: GameAddonToolHost; catalog: Awaited<ReturnType<typeof loadCatalog>> }> {
  dir = await scratch('mcp')
  const catalog = await loadCatalog(await writeCatalog(dir.root))
  // The provider reads only the catalog; the calls below stop in preparation, before the manager would run.
  return { catalog, host: { manager: { catalog } as GameAddonToolHost['manager'], project: requested => Promise.resolve(requested ?? '/none') } }
}

describe('gameAddonMcpProvider', () => {
  it('offers game_addons under the game prefix, requires absolute projects, and needs one for changes', async () => {
    const provider = gameAddonMcpProvider((await host()).host)
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
    expect(await provider.status(new AbortController().signal)).toEqual({ state: 'ready' })
  })

  it('puts the catalog in the server instructions', async () => {
    const { host: toolHost, catalog } = await host()
    const provider = gameAddonMcpProvider(toolHost)
    expect(provider.instructions).toBe(mcpInstructions(catalog.entries))
    expect(provider.instructions).toContain('wasd_addons.enable')
    expect(provider.instructions).toContain('- test-camera (Godot; prototype, polish): The camera must follow a moving target with smoothing.')
  })
})
