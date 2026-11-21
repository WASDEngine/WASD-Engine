/**
 * Model-visible text of WASD Engine's own tools: the export, preview, and release tool declarations that a Session's
 * agent and agents connected through WASD Engine's MCP server read, and the provider's instructions to connected agents.
 */
import { expect, it } from 'vitest'
import { wasdMcpProvider, wasdToolDefinitions, type WasdToolAudience, type WasdToolHost } from '../src/tools.ts'

// The preview lengths of the default Config (index.ts), which the recording tool's description names.
const LENGTHS = { seconds: 4, maxSeconds: 10 }

// Declaring the tools calls nothing on the host; only a tool call would.
const HOST: WasdToolHost = new Proxy({} as WasdToolHost, {
  get: () => () => Promise.reject(new Error('no tool runs in this spec')),
})

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
