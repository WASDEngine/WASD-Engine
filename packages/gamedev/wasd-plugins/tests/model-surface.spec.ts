/**
 * Model-visible text of WASD Engine's own tools: the export, preview, release, and multiplayer tool declarations that a
 * Session's agent and agents connected through WASD Engine's MCP server read, the `multiplayer` system prompt section,
 * and the provider's instructions to connected agents.
 */
import { expect, it } from 'vitest'
import {
  MCP_SURFACE, MULTIPLAYER_MCP_INSTRUCTIONS, MULTIPLAYER_PROMPT, multiplayerMcpTools, multiplayerToolDefinitions, SESSION_PROJECT,
  type MultiplayerSurface, type MultiplayerToolHost,
} from '../src/multiplayer-tools.ts'
import { wasdMcpProvider, wasdToolDefinitions, type WasdToolAudience, type WasdToolHost } from '../src/tools.ts'

// The preview lengths of the default Config (index.ts), which the recording tool's description names.
const LENGTHS = { seconds: 4, maxSeconds: 10 }

// Declaring the tools calls nothing on the host; only a tool call would.
const HOST: WasdToolHost = new Proxy({} as WasdToolHost, {
  get: () => () => Promise.reject(new Error('no tool runs in this spec')),
})
const MULTIPLAYER_HOST: MultiplayerToolHost = new Proxy({} as MultiplayerToolHost, {
  get: () => () => Promise.reject(new Error('no tool runs in this spec')),
})

// The Session's surface as index.ts builds it; declaring the tools asks nothing of it.
const SESSION_SURFACE: MultiplayerSurface = {
  channel: 'app',
  projectDescription: SESSION_PROJECT,
  approve: () => Promise.reject(new Error('no tool runs in this spec')),
  openLink: () => Promise.reject(new Error('no tool runs in this spec')),
}

const declarations = (audience: WasdToolAudience) => wasdToolDefinitions(HOST, LENGTHS, audience).map(definition => ({
  name: definition.name, description: definition.description, parameters: definition.parameters,
}))

it('pins the tool declarations a Session\'s agent reads', () => {
  expect(declarations('session')).toMatchSnapshot('session tool declarations')
})

it('pins the tool declarations and instructions connected agents read', () => {
  expect(declarations('connected')).toMatchSnapshot('connected tool declarations')
  const provider = wasdMcpProvider(wasdToolDefinitions(HOST, LENGTHS, 'connected'), { claim: () => Promise.resolve() })
  expect(provider.instructions).toMatchSnapshot('connected instructions')
})

it('pins the multiplayer tool declarations and the multiplayer section a Session\'s agent reads', () => {
  expect(multiplayerToolDefinitions(MULTIPLAYER_HOST, SESSION_SURFACE).map(definition => ({
    name: definition.name, description: definition.description, parameters: definition.parameters,
  }))).toMatchSnapshot('session multiplayer tool declarations')
  expect(MULTIPLAYER_PROMPT).toMatchSnapshot('multiplayer section')
})

it('pins the multiplayer tool declarations and instructions connected agents read', () => {
  const tools = multiplayerMcpTools(multiplayerToolDefinitions(MULTIPLAYER_HOST, MCP_SURFACE))
  // As the MCP server lists them.
  expect(tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? tool.definition.description,
    inputSchema: tool.inputSchema ?? tool.definition.parameters,
  }))).toMatchSnapshot('connected multiplayer tool declarations')
  const connected = wasdToolDefinitions(HOST, LENGTHS, 'connected')
  const provider = wasdMcpProvider(connected, { claim: () => Promise.resolve() }, tools, MULTIPLAYER_MCP_INSTRUCTIONS)
  expect(provider.instructions).toMatchSnapshot('connected instructions with multiplayer')
})
