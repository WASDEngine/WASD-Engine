/** The release tools, as the Session's agent and connected agents call them. */
import { describe, expect, it, vi } from 'vitest'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { wasdMcpProvider, wasdToolDefinitions, type WasdToolHost } from '../src/tools.ts'

function host(): WasdToolHost & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    project: requested => Promise.resolve(requested === undefined ? '/work/game' : `/work/${requested}`),
    file: requested => Promise.resolve(requested.startsWith('/') ? requested : `/work/${requested}`),
    exportWeb: (projectDir) => {
      calls.push(['export', projectDir])
      return Promise.resolve({ projectDir, outputDir: `${projectDir}/.wasdengine/web`, entry: 'index.html', files: [{ path: 'index.html', bytes: 2 * 1024 * 1024 }], totalBytes: 2 * 1024 * 1024, warnings: [] })
    },
    release: (request) => {
      calls.push(['release', request])
      return Promise.resolve({ title: 'Neon Drift', version: 3, url: 'https://site.test/games/neon?v=3', gameUrl: 'https://site.test/games/neon', playUrl: 'https://games.test/x/index.html', totalBytes: 50 * 1024 * 1024, warnings: ['Note one.'] })
    },
  }
}

const exec = { signal: new AbortController().signal } as ToolRunContext

describe('wasdToolDefinitions', () => {
  it('releases with notes, title, and a cover relative to the working directory, and renders the share link', async () => {
    const stub = host()
    const release = wasdToolDefinitions(stub).find(definition => definition.name === 'wasd_release_game')!
    const value = await release.execute({ project: 'neon', notes: 'Boss fight', title: 'Neon Drift', cover_image: 'shots/cover.png' }, exec) as JsonValue
    expect(stub.calls).toEqual([['release', { projectDir: '/work/neon', notes: 'Boss fight', title: 'Neon Drift', coverImage: '/work/shots/cover.png' }]])
    const text = release.output.render({}, value).map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Released Neon Drift version 3 (50.0 MB).')
    expect(text).toContain('Share link: https://site.test/games/neon')
    expect(text).toContain('- Note one.')
  })

  it('exports the nearest project and names the folder to serve', async () => {
    const stub = host()
    const exporter = wasdToolDefinitions(stub).find(definition => definition.name === 'wasd_export_web')!
    const value = await exporter.execute({}, exec) as JsonValue
    expect(stub.calls).toEqual([['export', '/work/game']])
    const text = exporter.output.render({}, value).map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Exported /work/game for the Web into /work/game/.wasdengine/web: index.html (2.0 MB).')
  })
})

describe('wasdMcpProvider', () => {
  it('offers both tools under the wasd prefix and requires absolute paths from connected agents', async () => {
    const provider = wasdMcpProvider(wasdToolDefinitions(host()))
    expect(provider.id).toBe('wasd')
    const tools = provider.tools()
    expect(tools.map(tool => tool.name)).toEqual(['wasd_export_web', 'wasd_release_game'])
    const release = tools[1]!
    expect(release.inputSchema?.required).toEqual(['project'])
    const call = { client: { id: 'claude-code', title: 'Claude Code' }, signal: new AbortController().signal, session: vi.fn(), reveal: vi.fn() }
    await expect(release.prepare!({ project: 'relative' }, call)).rejects.toThrow(/project must be an absolute path/u)
    await expect(release.prepare!({ project: '/game', cover_image: 'cover.png' }, call)).rejects.toThrow(/cover_image must be an absolute path/u)
    expect(await release.prepare!({ project: '/game', notes: 'n' }, call)).toEqual({ args: { project: '/game', notes: 'n' } })
    expect(call.session).not.toHaveBeenCalled()
    expect(await provider.status(new AbortController().signal)).toEqual({ state: 'ready' })
  })
})
