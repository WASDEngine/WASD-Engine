/** The server names each request's agent from its client information or User-Agent, and lists the agents it saw. */
import { describe, expect, it } from 'vitest'
import { ClientDirectory, UNKNOWN_CLIENT } from '../src/clients.ts'

const CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'

function initialize(name: string, title?: string) {
  return { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1', ...title === undefined ? {} : { title } } } }
}

function modern(name: string) {
  return { jsonrpc: '2.0', id: 2, method: 'tools/list', params: { _meta: { [CLIENT_INFO]: { name, version: '1' } } } }
}

describe('ClientDirectory.identify', () => {
  it('reads the client information of a 2026-07-28 request envelope', () => {
    const clients = new ClientDirectory()
    expect(clients.identify(modern('codex-mcp-client'), 'reqwest/0.12', 1)).toEqual({ id: 'codex-mcp-client', title: 'Codex' })
  })

  it('remembers the client information of an initialize request for later requests with the same User-Agent', () => {
    const clients = new ClientDirectory()
    expect(clients.identify(initialize('claude-code'), 'node', 1)).toEqual({ id: 'claude-code', title: 'Claude Code' })
    expect(clients.identify({ jsonrpc: '2.0', id: 3, method: 'tools/call' }, 'node', 2)).toEqual({ id: 'claude-code', title: 'Claude Code' })
    expect(clients.identify({ jsonrpc: '2.0', id: 3, method: 'tools/call' }, 'other', 3)).toEqual({ id: 'other', title: 'other' })
  })

  it('reads initialize requests inside a batch', () => {
    const clients = new ClientDirectory()
    expect(clients.identify([{ jsonrpc: '2.0', method: 'notifications/initialized' }, initialize('Zed Editor')], 'zed/1', 1))
      .toEqual({ id: 'zed-editor', title: 'Zed Editor' })
  })

  it('uses the title the client gives for a name without a known display name', () => {
    expect(new ClientDirectory().identify(initialize('my-agent', 'My Agent'), '', 1)).toEqual({ id: 'my-agent', title: 'My Agent' })
  })

  it('falls back to the User-Agent product, and to a generic agent for HTTP libraries and missing names', () => {
    const clients = new ClientDirectory()
    expect(clients.identify(undefined, 'claude-code/2.1.0 (cli)', 1)).toEqual({ id: 'claude-code', title: 'Claude Code' })
    expect(clients.identify(undefined, 'codex_cli_rs/0.40.0 (Mac OS 26.0)', 1)).toEqual({ id: 'codex-cli-rs', title: 'Codex' })
    expect(clients.identify(undefined, 'node', 1)).toEqual(UNKNOWN_CLIENT)
    expect(clients.identify(undefined, 'python-httpx/0.28', 1)).toEqual(UNKNOWN_CLIENT)
    expect(clients.identify(undefined, '', 1)).toEqual(UNKNOWN_CLIENT)
    expect(clients.identify(initialize('///'), '', 1)).toEqual(UNKNOWN_CLIENT)
    expect(clients.identify('not a message', '', 1)).toEqual(UNKNOWN_CLIENT)
  })

  it('lists the agents most recent first and keeps the newest eight', () => {
    const clients = new ClientDirectory()
    for (let index = 0; index < 10; index += 1) clients.identify(modern(`agent-${index}`), '', index)
    clients.identify(modern('agent-5'), '', 20)
    const listed = clients.list()
    expect(listed).toHaveLength(8)
    expect(listed[0]).toEqual({ id: 'agent-5', title: 'agent-5', lastSeen: 20 })
    expect(listed.map(client => client.id)).not.toContain('agent-0')
    expect(listed.map(client => client.id)).not.toContain('agent-1')
  })
})
