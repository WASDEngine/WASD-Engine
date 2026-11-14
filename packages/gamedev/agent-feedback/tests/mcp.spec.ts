/**
 * Agents connected through WASD Engine's MCP server send feedback: the whole chain from the official MCP client over
 * HTTP, through the game MCP server and the feedback provider, to a fake WASD Engine site, with the agent named by the
 * client the server identified and the feedback sent as the account the app is signed in to.
 */
import { SIGNED_OUT_MESSAGE } from '@deepseek-ai/dsh-game-mcp'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_INSTRUCTIONS } from '../src/mcp.ts'
import { compose, connect, TIMEOUT, TOKEN, type Composition } from './composition.ts'
import { FEEDBACK_PATH } from './fixtures.ts'

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

async function connected(name?: string): Promise<{ current: Composition; client: Client }> {
  const current = composition = await compose({ gameMcp: true, config: { usageReports: false } })
  return { current, client: await connect(current, name) }
}

type CallResult = Awaited<ReturnType<Client['callTool']>>

function text(result: CallResult): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('the feedback tool over WASD Engine\'s MCP server', () => {
  it('lists feedback_send with model and without the parameters the server sets, and the provider\'s instructions', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## Feedback\n\n${MCP_INSTRUCTIONS}`)
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('feedback_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([['feedback_send', false]])
    const [tool] = tools
    expect(Object.keys(tool?.inputSchema.properties ?? {}).sort()).toEqual(['about', 'kind', 'message', 'model'])
    expect(tool?.inputSchema.required).toEqual(['kind', 'message'])
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'feedback' } }))).toContain('- Feedback (feedback_*, ready, 1 tools)')
  }, TIMEOUT)

  it('sends the feedback as the connected agent with the model it names, whatever client it claims in its arguments', async () => {
    const { current, client } = await connected()
    const sent = await client.callTool({
      name: 'feedback_send',
      arguments: { kind: 'confusing', about: 'blender_export_gltf', message: 'The result does not say where the file went.', model: 'Claude Opus 5.5', agent_id: 'wasd-engine' },
    })
    expect(sent.isError).toBeFalsy()
    expect(text(sent)).toBe('Sent your report of something confusing about blender_export_gltf to the WASD Engine team. They read it but do not reply here, so carry on with the user\'s task.')
    expect(current.site.requests.map(request => [request.path, request.token])).toEqual([[FEEDBACK_PATH, TOKEN]])
    expect(current.site.requests[0]?.body).toMatchObject({
      kind: 'confusing',
      about: 'blender_export_gltf',
      connected: true,
      agent: 'claude-code',
      agent_title: 'Claude Code',
      model: 'Claude Opus 5.5',
    })
    const called = await client.callTool({ name: 'call_game_tool', arguments: { name: 'feedback_send', arguments: { kind: 'suggestion', message: 'A tool to list scenes.' } } })
    expect(called.isError).toBeFalsy()
    expect(current.site.requests[1]?.body).toMatchObject({ kind: 'suggestion', agent: 'claude-code', model: '' })
  }, TIMEOUT)

  it('refuses every call while WASD Engine is signed out', async () => {
    const { current, client } = await connected()
    current.account.signedIn = false
    const signedOut = await client.callTool({ name: 'feedback_send', arguments: { kind: 'bug', message: 'Broken.' } })
    expect(signedOut.isError).toBe(true)
    expect(text(signedOut)).toContain(SIGNED_OUT_MESSAGE)
    expect(current.site.requests).toEqual([])
  }, TIMEOUT)

  it('withdraws the provider when the plugin is disposed', async () => {
    const { current } = await connected()
    expect(current.server?.toolOwner('feedback_send')).toEqual({ provider: 'feedback', title: 'Feedback', tool: 'feedback_send' })
    await current.unload()
    expect(current.server?.toolOwner('feedback_send')).toBeUndefined()
  }, TIMEOUT)
})
