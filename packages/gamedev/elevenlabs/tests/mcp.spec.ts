/**
 * Agents connected through WASD Engine's MCP server use the ElevenLabs tools: the whole chain from the official MCP
 * client over HTTP, through the game MCP server and the ElevenLabs provider, to a fake WASD Engine API, with files
 * written to the absolute path the agent names and the audio charged to the account the app is signed in to.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import GameMcpServer, { SIGNED_OUT_MESSAGE, type GameMcpView } from '@deepseek-ai/dsh-game-mcp'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSENT_STATEMENT } from '../src/consent.ts'
import { MCP_INSTRUCTIONS } from '../src/mcp.ts'
import { compose, TOKEN, type Composition } from './composition.ts'
import { CLONE_ID, MP3, WAV } from './fixtures.ts'

const TIMEOUT = 60_000

let composition: Composition | undefined

afterEach(async () => {
  await composition?.cleanup()
  composition = undefined
})

/** The composition with the game MCP server and an official MCP client connected to it. */
async function connected() {
  const current = composition = await compose()
  const { ctx, work } = current
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(GameMcpServer, GameMcpServer.Config({ dataRoot: join(work, '.game-mcp'), port: 0 }))
  const server = ctx.get('gameMcp') as GameMcpServer
  const views: GameMcpView[] = []
  const stop = new AbortController()
  void (async () => {
    for await (const view of server.watch(stop.signal)) views.push(view)
  })()
  ctx.effect(() => () => { stop.abort() })
  await vi.waitFor(() => { expect(views.at(-1)?.state).toBe('listening') }, { timeout: TIMEOUT })
  const token = (await readFile(join(work, '.game-mcp', 'token'), 'utf8')).trim()
  const client = new Client({ name: 'claude-code', version: '2.1.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(views.at(-1)?.url as string), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  ctx.effect(() => () => client.close())
  return { ...current, client }
}

type CallResult = Awaited<ReturnType<Client['callTool']>>

function text(result: CallResult): string {
  return (result.content as Array<{ type: string; text?: string }>).flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('the ElevenLabs tools over WASD Engine\'s MCP server', () => {
  it('lists the six tools, the voice search marked read-only, files named by absolute path, and a clone needing consent', async () => {
    const { client } = await connected()
    expect(client.getInstructions()).toContain(`## ElevenLabs\n\n${MCP_INSTRUCTIONS}`)
    expect(MCP_INSTRUCTIONS).toContain(CONSENT_STATEMENT)
    const tools = (await client.listTools()).tools.filter(tool => tool.name.startsWith('elevenlabs_'))
    expect(tools.map(tool => [tool.name, tool.annotations?.readOnlyHint ?? false])).toEqual([
      ['elevenlabs_voices', true], ['elevenlabs_speech', false], ['elevenlabs_sound_effect', false], ['elevenlabs_music', false],
      ['elevenlabs_clone_voice', false], ['elevenlabs_delete_voice', false],
    ])
    for (const tool of tools.slice(1, 4)) expect(JSON.stringify(tool.inputSchema.properties?.path), tool.name).toContain('Absolute path of the file to write')
    const clone = tools[4]
    expect(clone?.inputSchema.required).toEqual(['name', 'samples', 'consent'])
    expect(JSON.stringify(clone?.inputSchema.properties?.samples)).toContain('each an absolute path')
    expect(JSON.stringify(clone?.inputSchema.properties?.consent)).toContain(CONSENT_STATEMENT)
    expect(clone?.description).toContain('show your user the consent statement and pass consent: true only if they confirm it')
    expect(text(await client.callTool({ name: 'search_game_tools', arguments: { plugin: 'elevenlabs' } }))).toContain('- ElevenLabs (elevenlabs_*, ready, 6 tools)')
  }, TIMEOUT)

  it('clones only with consent and absolute recordings, recording that the agent\'s user confirmed it', async () => {
    const { client, api, work, approval } = await connected()
    const sample = join(work, 'recordings', 'rhea.wav')
    await mkdir(join(work, 'recordings'), { recursive: true })
    await writeFile(sample, WAV)
    const without = await client.callTool({ name: 'elevenlabs_clone_voice', arguments: { name: 'Rhea', samples: [sample], consent: false } })
    expect(text(without)).toContain('Pass consent: true only after your user confirmed the consent statement; nothing was cloned.')
    const relative = await client.callTool({ name: 'elevenlabs_clone_voice', arguments: { name: 'Rhea', samples: ['recordings/rhea.wav'], consent: true } })
    expect(text(relative)).toContain('samples must be absolute paths.')
    expect(api.requests).toEqual([])
    const cloned = await client.callTool({ name: 'elevenlabs_clone_voice', arguments: { name: 'Rhea', samples: [sample], consent: true } })
    expect(cloned.isError).toBeFalsy()
    expect(text(cloned)).toContain(`Cloned the voice "Rhea" as voice ${CLONE_ID} from 1 recording (${sample}).`)
    expect(api.requests.map(request => [request.path, request.body.consent_channel, request.body.consent_statement])).toEqual([['/v1/audio/voices/clone', 'mcp', '2026-11-11']])
    // WASD Engine's own approval prompt does not reach connected agents.
    expect(approval.asked).toEqual([])
  }, TIMEOUT)

  it('searches voices without a Session, and saves speech at the absolute path with the app\'s account', async () => {
    const { client, api, work } = await connected()
    const voices = await client.callTool({ name: 'elevenlabs_voices', arguments: { query: 'wizard' } })
    expect(voices.isError).toBeFalsy()
    expect(text(voices)).toContain('- LvmvHEBEmMJBJw9UuhwO: Eldrin - Wise Ancient Wizard (male, old, british, en, characters_animation).')
    const path = join(work, 'game', 'audio', 'wizard_hello.mp3')
    const speech = await client.callTool({ name: 'call_game_tool', arguments: { name: 'elevenlabs_speech', arguments: { text: 'Greetings.', voice_id: 'LvmvHEBEmMJBJw9UuhwO', path } } })
    expect(speech.isError).toBeFalsy()
    expect(text(speech)).toBe(`Saved 1.7 s of speech in voice LvmvHEBEmMJBJw9UuhwO (Eleven v4 Turbo, 10 characters) to ${path} (1 KB).`)
    expect(await readFile(path)).toEqual(MP3)
    expect(api.requests.map(request => [request.path, request.token])).toEqual([['/v1/audio/voices', TOKEN], ['/v1/audio/speech', TOKEN]])
  }, TIMEOUT)

  it('refuses a relative path, and every call while WASD Engine is signed out', async () => {
    const { client, api, account } = await connected()
    const relative = await client.callTool({ name: 'elevenlabs_sound_effect', arguments: { prompt: 'boom', path: 'boom.wav' } })
    expect(relative.isError).toBe(true)
    expect(text(relative)).toContain('path must be an absolute path.')
    account.signedIn = false
    const signedOut = await client.callTool({ name: 'elevenlabs_voices', arguments: {} })
    expect(signedOut.isError).toBe(true)
    expect(text(signedOut)).toContain(SIGNED_OUT_MESSAGE)
    expect(api.requests).toEqual([])
  }, TIMEOUT)
})
