/** The release tools, as the Session's agent and connected agents call them. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { wasdMcpProvider, wasdToolDefinitions, type RecordedPreview, type WasdToolHost } from '../src/tools.ts'

const LENGTHS = { seconds: 4, maxSeconds: 10 }

function host(preview: Partial<RecordedPreview> = {}): WasdToolHost & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    project: requested => Promise.resolve(requested === undefined ? '/work/game' : `/work/${requested}`),
    file: requested => Promise.resolve(requested.startsWith('/') ? requested : `/work/${requested}`),
    exportWeb: (projectDir) => {
      calls.push(['export', projectDir])
      return Promise.resolve({ projectDir, outputDir: `${projectDir}/.wasdengine/web`, entry: 'index.html', files: [{ path: 'index.html', bytes: 2 * 1024 * 1024 }], totalBytes: 2 * 1024 * 1024, warnings: [] })
    },
    recordPreview: (request) => {
      calls.push(['record', request])
      return Promise.resolve({
        gif: `${request.projectDir}/.wasdengine/preview/preview.gif`,
        image: `${request.projectDir}/.wasdengine/preview/preview.png`,
        frames: 50, seconds: 4, width: 480, height: 270, gifBytes: 2 * 1024 * 1024,
        imageWidth: 1280, imageHeight: 720, imageBytes: 300 * 1024,
        started: false, paused: false, ...preview,
      })
    },
    release: (request) => {
      calls.push(['release', request])
      return Promise.resolve({
        title: 'Neon Drift', version: 3, url: 'https://site.test/games/neon?v=3', gameUrl: 'https://site.test/games/neon', playUrl: 'https://games.test/x/index.html',
        totalBytes: 50 * 1024 * 1024, warnings: ['Note one.'],
      })
    },
  }
}

const exec = { signal: new AbortController().signal } as ToolRunContext

function textOf(blocks: readonly { type: string; text?: string }[]): string {
  return blocks.map(block => block.type === 'text' ? block.text : '').join('')
}

const folders: string[] = []
afterEach(async () => {
  await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true })))
})

describe('wasdToolDefinitions', () => {
  it('releases with notes, title, and preview files relative to the working directory, and renders the links', async () => {
    const stub = host()
    const release = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_release_game')!
    const value = await release.execute({ project: 'neon', notes: 'Boss fight', title: 'Neon Drift', preview_image: 'shots/cover.png', preview_gif: '/clips/run.gif' }, exec) as JsonValue
    expect(stub.calls).toEqual([['release', {
      projectDir: '/work/neon', notes: 'Boss fight', title: 'Neon Drift', previewImage: '/work/shots/cover.png', previewGif: '/clips/run.gif',
    }]])
    const text = textOf(release.output.render({}, value))
    expect(text).toContain('Released Neon Drift version 3 (50.0 MB).')
    expect(text).toContain('Share link: https://site.test/games/neon')
    expect(text).not.toMatch(/GIF link|Image link/u)
    expect(text).toContain('the share link shows the game\'s GIF (its picture while it has none); opened in a browser, it plays the game.')
    expect(text).toContain('- Note one.')
  })

  it('passes the choice between the project\'s game and a new game on to the release', async () => {
    const stub = host()
    const release = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_release_game')!
    expect(release.parameters).toMatchObject({ properties: { new_game: { type: 'boolean' } } })
    await release.execute({ new_game: true }, exec)
    await release.execute({ new_game: false }, exec)
    await release.execute({}, exec)
    expect(stub.calls).toEqual([
      ['release', { projectDir: '/work/game', newGame: true }],
      ['release', { projectDir: '/work/game', newGame: false }],
      ['release', { projectDir: '/work/game' }],
    ])
  })

  it('exports the nearest project and names the folder to serve', async () => {
    const stub = host()
    const exporter = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_export_web')!
    const value = await exporter.execute({}, exec) as JsonValue
    expect(stub.calls).toEqual([['export', '/work/game']])
    const text = textOf(exporter.output.render({}, value))
    expect(text).toContain('Exported /work/game for the Web into /work/game/.wasdengine/web: index.html (2.0 MB).')
  })

  it('records the preview with its input, within the configured lengths, and shows the still the model receives', async () => {
    const image = { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1280, height: 720, name: 'preview.png' } as ImageAttachmentRef
    const stub = host({ started: true, view: { width: 1280, height: 720, image } })
    const recorder = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_record_preview')!
    const events = [{ kind: 'key', key: 'Right', pressed: true, hold: 2 }]
    const value = await recorder.execute({ seconds: 5, still_at: 3, events, coordinate_space: 'window' }, exec) as JsonValue
    expect(stub.calls).toEqual([['record', { projectDir: '/work/game', seconds: 5, stillAt: 3, events, coordinateSpace: 'window' }]])
    const blocks = recorder.output.render({}, value)
    expect(textOf(blocks)).toContain('Recorded the game\'s preview: /work/game/.wasdengine/preview/preview.gif (50 frames, 4.0 s, 480x270, 2.0 MB) and the still /work/game/.wasdengine/preview/preview.png (1280x720, 300 KB).')
    expect(textOf(blocks)).toContain('The recording started the game, which keeps running.')
    expect(blocks.at(-1)).toMatchObject({ type: 'image', attachment: { attachmentId: 'a1' } })
    await recorder.execute({}, exec)
    expect(stub.calls.at(-1)).toEqual(['record', { projectDir: '/work/game', seconds: 4 }])
    await expect(recorder.execute({ seconds: 11 }, exec)).rejects.toThrow('seconds must be from 1 to 10.')
    await expect(recorder.execute({ seconds: 2, still_at: 3 }, exec)).rejects.toThrow('still_at must be from 0 to 2.')
  })

  it('says when the game was paused throughout and omits the image the model cannot see', () => {
    const recorder = wasdToolDefinitions(host(), LENGTHS).find(definition => definition.name === 'wasd_record_preview')!
    const blocks = recorder.output.render({}, {
      gif: '/g/p.gif', image: '/g/p.jpg', frames: 2, seconds: 1, width: 64, height: 36, gifBytes: 10, imageWidth: 64, imageHeight: 36, imageBytes: 10, started: false, paused: true,
    })
    expect(blocks).toHaveLength(1)
    expect(textOf(blocks)).toContain('The game was paused throughout')
  })
})

describe('wasdMcpProvider', () => {
  it('offers the tools under the wasd prefix and requires absolute paths from connected agents', async () => {
    const provider = wasdMcpProvider(wasdToolDefinitions(host(), LENGTHS))
    expect(provider.id).toBe('wasd')
    const tools = provider.tools()
    expect(tools.map(tool => tool.name)).toEqual(['wasd_export_web', 'wasd_record_preview', 'wasd_release_game'])
    const [exporter, recorder, release] = tools as [typeof tools[number], typeof tools[number], typeof tools[number]]
    expect(release.inputSchema?.required).toEqual(['project'])
    const agent = { id: 'session' }
    const call = { client: { id: 'claude-code', title: 'Claude Code' }, signal: new AbortController().signal, session: vi.fn(() => Promise.resolve(agent)), reveal: vi.fn() }
    await expect(release.prepare!({ project: 'relative' }, call as never)).rejects.toThrow(/project must be an absolute path/u)
    await expect(release.prepare!({ project: '/game', preview_image: 'cover.png' }, call as never)).rejects.toThrow(/preview_image must be an absolute path/u)
    await expect(release.prepare!({ project: '/game', preview_gif: 'clip.gif' }, call as never)).rejects.toThrow(/preview_gif must be an absolute path/u)
    expect(await exporter.prepare!({ project: '/game' }, call as never)).toEqual({ args: { project: '/game' } })
    expect(call.session).not.toHaveBeenCalled()
    expect(await release.prepare!({ project: '/game', notes: 'n' }, call as never)).toEqual({ args: { project: '/game', notes: 'n' }, agent })
    expect(release.inputSchema?.properties).toMatchObject({ new_game: { type: 'boolean' } })
    expect(await release.prepare!({ project: '/game', new_game: true }, call as never)).toEqual({ args: { project: '/game', new_game: true }, agent })
    expect(await recorder.prepare!({ project: '/game', seconds: 3 }, call as never)).toEqual({ args: { project: '/game', seconds: 3 }, agent })
    expect(call.session.mock.calls).toEqual([['/game'], ['/game'], ['/game']])
    const refusing = { ...call, session: vi.fn(() => Promise.reject(new Error('The Host cannot create the Session.'))) }
    expect(await release.prepare!({ project: '/game' }, refusing as never)).toEqual({ args: { project: '/game' } })
    await expect(recorder.prepare!({ project: '/game' }, refusing as never)).rejects.toThrow('cannot create the Session')
    expect(await provider.status(new AbortController().signal)).toEqual({ state: 'ready' })
  })

  it('returns the recorded still to connected agents from its file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-tools-'))
    folders.push(dir)
    await writeFile(join(dir, 'preview.jpg'), 'JPEG')
    const recorder = wasdMcpProvider(wasdToolDefinitions(host(), LENGTHS)).tools()[1]!
    const content = await recorder.content!({
      gif: join(dir, 'preview.gif'), image: join(dir, 'preview.jpg'), frames: 2, seconds: 1, width: 64, height: 36, gifBytes: 10, imageWidth: 64, imageHeight: 36, imageBytes: 4, started: false, paused: false,
    }, {}, exec)
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Recorded the game\'s preview') as string })
    expect(content[1]).toEqual({ type: 'image', data: Buffer.from('JPEG').toString('base64'), mimeType: 'image/jpeg' })
  })
})
