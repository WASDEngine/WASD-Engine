/**
 * Model-visible declarations of `game_addons`: the tool that a Session's agent reads, and the same tool as agents
 * connected through WASD Engine's MCP server read it, with projects named by absolute path and the request to read the
 * catalog's index before a game is planned.
 */
import { expect, it } from 'vitest'
import { GameAddonCatalog } from '../src/catalog.ts'
import { GameAddonManager } from '../src/manager.ts'
import { gameAddonMcpProvider } from '../src/mcp.ts'
import { gameAddonToolDefinition, SESSION_WORDING, type GameAddonToolHost } from '../src/tools.ts'

/** A host whose tool is only declared: nothing is searched, read, installed, or resolved. */
const HOST: GameAddonToolHost = {
  manager: new GameAddonManager({
    catalog: new GameAddonCatalog('/unused/catalog', [], new Map()),
    downloads: { cacheDir: '/unused/archives', fetch: () => Promise.reject(new Error('The model-surface spec downloads nothing.')) },
    blenderStore: '/unused/store',
    assetsDir: '/unused/assets',
    importProject: () => Promise.resolve(undefined),
    now: () => new Date('2026-11-23T12:00:00Z'),
    changed: () => {},
    allowed: () => true,
  }),
  guides: new Map(),
  resultChars: 8192,
  project: () => Promise.reject(new Error('No project.')),
}

it('pins the declaration that a Session\'s agent reads', () => {
  const definition = gameAddonToolDefinition(HOST, SESSION_WORDING)
  expect({ name: definition.name, description: definition.description, parameters: definition.parameters }).toMatchSnapshot('session declaration')
})

it('pins the declaration that connected agents read', () => {
  const [tool] = gameAddonMcpProvider(HOST).tools()
  expect({ name: tool?.name, description: tool?.description, parameters: tool?.definition.parameters }).toMatchSnapshot('connected declaration')
})
