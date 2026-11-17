/** The export and release tools, as the Session's agent and connected agents call them. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { wasdMcpProvider, wasdToolDefinitions, type ConnectedCredits, type RecordedPreview, type WasdToolAudience, type WasdToolHost } from '../src/tools.ts'
import type { WasdDesktopPlatform, WasdDownloadStatus, WasdMobilePlatform } from '../src/types.ts'
import type { GodotWebCheck } from '@deepseek-ai/dsh-godot'

const LENGTHS = { seconds: 4, maxSeconds: 10 }

/** A release without desktop builds. */
const RELEASED = {
  title: 'Neon Drift', version: 3, url: 'https://site.test/games/neon?v=3', gameUrl: 'https://site.test/games/neon', playUrl: 'https://games.test/x/index.html',
  totalBytes: 50 * 1024 * 1024, warnings: ['Note one.'], visibility: 'public', downloads: [],
} as const

/** A Web check that froze and printed errors. */
const WEB_CHECK: GodotWebCheck = {
  seconds: 20, started: true, startSeconds: 3.4, readySeconds: 52.3, longestFreezeSeconds: 30.2, freezes: 4, fps: 30, slowestFrameMs: 917,
  drawCalls: { median: 2915, max: 5193 }, programs: 226,
  messages: [
    { level: 'error', text: 'ERROR: Too many instances using shader instance variables.', count: 72 },
    { level: 'warning', text: 'WARNING: The Compatibility renderer does not support manually emitting particles.', count: 1 },
  ],
  moreMessages: 2,
  findings: ['The page froze for up to 30.2 s at a time.', 'Particles emitted with emit_particle() never appear.'],
}

function host(
  preview: Partial<RecordedPreview> = {}, scans: Partial<Record<WasdDesktopPlatform, WasdDownloadStatus>> = {},
  mobileFailures: Partial<Record<WasdMobilePlatform, string>> = {},
): WasdToolHost & { calls: unknown[]; audiences: WasdToolAudience[] } {
  const calls: unknown[] = []
  const audiences: WasdToolAudience[] = []
  return {
    calls,
    audiences,
    project: requested => Promise.resolve(requested === undefined ? '/work/game' : `/work/${requested}`),
    file: requested => Promise.resolve(requested.startsWith('/') ? requested : `/work/${requested}`),
    exportWeb: (projectDir, zip) => {
      calls.push(zip ? ['export', projectDir, 'zip'] : ['export', projectDir])
      return Promise.resolve({
        projectDir, outputDir: `${projectDir}/.wasdengine/web`, entry: 'index.html', files: [{ path: 'index.html', bytes: 2 * 1024 * 1024 }], totalBytes: 2 * 1024 * 1024, warnings: [],
        ...zip ? { zip: { file: `${projectDir}/.wasdengine/web-zip/Neon Drift.zip`, bytes: 1536 * 1024 } } : {},
      })
    },
    checkWeb: (outputDir) => {
      calls.push(['check', outputDir])
      if (outputDir.startsWith('/work/broken/')) return Promise.reject(new Error('The Web check\'s browser ended (exit code 1) without a result.'))
      return Promise.resolve(WEB_CHECK)
    },
    exportDesktop: (projectDir, platforms) => {
      calls.push(['desktop', projectDir, platforms])
      return Promise.resolve({
        projectDir,
        builds: platforms.map(platform => ({ platform, file: `${projectDir}/.wasdengine/desktop/${platform}/Neon Drift.zip`, bytes: (platform === 'windows' ? 39 : 61) * 1024 * 1024 })),
        warnings: ['Code signing: Using ad-hoc signature.'],
      })
    },
    exportMobile: (projectDir, platforms, appleTeamId) => {
      calls.push(['mobile', projectDir, platforms, appleTeamId])
      const built = platforms.filter(platform => mobileFailures[platform] === undefined)
      if (built.length === 0) return Promise.reject(new Error(platforms.map(platform => mobileFailures[platform]).join('\n')))
      return Promise.resolve({
        projectDir,
        builds: built.map(platform => platform === 'android'
          ? { platform, file: `${projectDir}/.wasdengine/mobile/android/Neon Drift.apk`, bytes: 26 * 1024 * 1024, identifier: 'com.wasdengine.game.neon_drift', keystore: '/home/.wasdengine/godot/android/release.keystore', keystoreCreated: true }
          : { platform, file: `${projectDir}/.wasdengine/mobile/ios/NeonDrift.xcodeproj`, bytes: 367 * 1024 * 1024, identifier: 'com.wasdengine.game.neon-drift', ...appleTeamId === undefined ? {} : { appleTeamId } }),
        failures: platforms.flatMap((platform) => {
          const error = mobileFailures[platform]
          return error === undefined ? [] : [{ platform, error }]
        }),
        warnings: [],
      })
    },
    recordPreview: (request) => {
      calls.push(['record', request])
      return Promise.resolve({
        gif: `${request.projectDir}/.wasdengine/preview/preview.gif`,
        webp: `${request.projectDir}/.wasdengine/preview/preview.webp`,
        image: `${request.projectDir}/.wasdengine/preview/preview.png`,
        frames: 50, seconds: 4, width: 480, height: 270, gifBytes: 2 * 1024 * 1024,
        webpWidth: 960, webpHeight: 540, webpBytes: 3 * 1024 * 1024,
        imageWidth: 1280, imageHeight: 720, imageBytes: 300 * 1024,
        started: false, paused: false, ...preview,
      })
    },
    release: (request, _exec, audience) => {
      calls.push(['release', request])
      audiences.push(audience)
      return Promise.resolve({
        title: 'Neon Drift', version: 3, url: 'https://site.test/games/neon?v=3', gameUrl: 'https://site.test/games/neon', playUrl: 'https://games.test/x/index.html',
        totalBytes: 50 * 1024 * 1024, warnings: ['Note one.'],
        credits: ['WASD Engine\'s built-in AI', 'Godot', 'Blender with MPFB (MakeHuman)'],
        visibility: request.visibility ?? 'public',
        downloads: (request.desktop ?? []).map(platform => ({
          platform, url: `https://site.test/games/neon/download/${platform}?v=3`, bytes: 40 * 1024 * 1024, status: scans[platform] ?? 'clean',
        })),
      })
    },
  }
}

function credits(): ConnectedCredits & { claim: ReturnType<typeof vi.fn> } {
  return { claim: vi.fn(() => Promise.resolve()) }
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
    expect(text).toContain('Made with, as the game\'s page credits it: WASD Engine\'s built-in AI, Godot, Blender with MPFB (MakeHuman).')
    expect(text).toContain('The game is public: Explore lists it.')
    expect(text).not.toContain('download')
    expect(text).toContain('- Note one.')
    expect(stub.audiences).toEqual(['session'])
    expect(release.parameters).not.toHaveProperty('properties.model')
  })

  it('passes check on and renders the release\'s Web check, or why it could not run', async () => {
    const checked = { ...host(), release: () => Promise.resolve({ ...RELEASED, webCheck: WEB_CHECK }) }
    const release = wasdToolDefinitions(checked, LENGTHS).find(definition => definition.name === 'wasd_release_game')!
    const text = textOf(release.output.render({}, await release.execute({}, exec) as JsonValue))
    expect(text).toContain('Share link: https://site.test/games/neon\n')
    expect(text).toContain('\nWeb check: a browser opened the build, Godot started the game after 3.4 s,')
    expect(text).toContain('\n- Particles emitted with emit_particle() never appear.\nNotes:\n- Note one.')
    const failing = { ...host(), release: () => Promise.resolve({ ...RELEASED, webCheckError: 'The Web check runs in the WASD Engine Desktop app.' }) }
    const failed = wasdToolDefinitions(failing, LENGTHS).find(definition => definition.name === 'wasd_release_game')!
    expect(textOf(failed.output.render({}, await failed.execute({}, exec) as JsonValue)))
      .toContain('Web check: it could not run: The Web check runs in the WASD Engine Desktop app.')
    const stub = host()
    const skipping = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_release_game')!
    await skipping.execute({ check: false }, exec)
    expect(stub.calls).toEqual([['release', { projectDir: '/work/game', check: false }]])
  })

  it('offers model to connected agents, and releases as a connected agent, whose model its call credits', async () => {
    const stub = host()
    const release = wasdToolDefinitions(stub, LENGTHS, 'connected').find(definition => definition.name === 'wasd_release_game')!
    expect(release.parameters).toMatchObject({
      properties: {
        model: {
          type: 'string',
          description: 'The name of the AI model you are, as its maker writes it, such as Claude Opus 5.5; at most 60 characters. The game\'s page '
            + 'credits it beside the game tools and add-ons that made the game. Default: the model you named for this project before, else your '
            + 'application\'s name.',
        },
      },
    })
    await release.execute({ project: 'neon', model: 'Claude Opus 5.5' }, exec)
    await release.execute({ project: 'neon' }, exec)
    // The model is the credits' to take from the call, so the release itself is asked for none.
    expect(stub.calls).toEqual([['release', { projectDir: '/work/neon' }], ['release', { projectDir: '/work/neon' }]])
    expect(stub.audiences).toEqual(['connected', 'connected'])
  })

  it('passes visibility and desktop platforms on, each platform once in build order, and renders the downloads', async () => {
    const stub = host()
    const release = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_release_game')!
    expect(release.parameters).toMatchObject({ properties: { visibility: { enum: ['public', 'private'] }, desktop: { type: 'array', items: { enum: ['windows', 'macos'] } } } })
    const value = await release.execute({ visibility: 'private', desktop: ['macos', 'windows', 'macos'] }, exec) as JsonValue
    expect(stub.calls).toEqual([['release', { projectDir: '/work/game', visibility: 'private', desktop: ['windows', 'macos'] }]])
    const text = textOf(release.output.render({}, value))
    expect(text).toContain('The game is private: Explore does not list it, so only people with its link can find it.')
    expect(text).toContain('Windows download: https://site.test/games/neon/download/windows?v=3 (40.0 MB)')
    expect(text).toContain('macOS download: https://site.test/games/neon/download/macos?v=3 (40.0 MB)')
    expect(text).toContain('Players get the downloads through the share page\'s Install with WASD Engine button: the WASD Engine app installs the build for their computer, keeps it up to date, and starts it.')
    // The app installs the builds itself, so the release says nothing of first-run prompts.
    expect(text).not.toContain('SmartScreen')
    await expect(release.execute({ desktop: ['linux'] }, exec)).rejects.toThrow(/invalid arguments: "desktop\[0\]"/u)
  })

  it('says which downloads wait on their malware scan before the share page offers them, and which the scan refused', async () => {
    const released = async (scans: Partial<Record<WasdDesktopPlatform, WasdDownloadStatus>>): Promise<string> => {
      const release = wasdToolDefinitions(host({}, scans), LENGTHS).find(definition => definition.name === 'wasd_release_game')!
      return textOf(release.output.render({}, await release.execute({ desktop: ['windows', 'macos'] }, exec) as JsonValue))
    }
    const waiting = await released({ windows: 'pending' })
    expect(waiting).toContain('Windows download: https://site.test/games/neon/download/windows?v=3 (40.0 MB, being scanned for malware)')
    expect(waiting).toContain('macOS download: https://site.test/games/neon/download/macos?v=3 (40.0 MB)\n')
    expect(waiting).toContain('WASD Engine scans each download for malware before the share page offers it. A download being scanned becomes installable from the share page once the scan passes, usually within a few minutes. Players get the downloads through the share page\'s Install with WASD Engine button: the WASD Engine app installs the build for their computer, keeps it up to date, and starts it.')

    const refused = await released({ windows: 'flagged', macos: 'failed' })
    expect(refused).toContain('Windows download: https://site.test/games/neon/download/windows?v=3 (40.0 MB, flagged as malware: never offered)')
    expect(refused).toContain('macOS download: https://site.test/games/neon/download/macos?v=3 (40.0 MB, not scannable for malware: never offered)')
    expect(refused).toContain('WASD Engine scans each download for malware before the share page offers it. A download the scan flagged or could not scan is never offered.')
    expect(refused).not.toContain('becomes installable')
    expect(refused).not.toContain('SmartScreen')
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

  it('exports the project for desktop computers, both platforms unless the call names some, and says how the builds open', async () => {
    const stub = host()
    const exporter = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_export_desktop')!
    const value = await exporter.execute({}, exec) as JsonValue
    await exporter.execute({ project: 'neon', platforms: ['macos'] }, exec)
    expect(stub.calls).toEqual([['desktop', '/work/game', ['windows', 'macos']], ['desktop', '/work/neon', ['macos']]])
    const text = textOf(exporter.output.render({}, value))
    expect(text).toContain('Exported /work/game for desktop computers:')
    expect(text).toContain('- Windows: /work/game/.wasdengine/desktop/windows/Neon Drift.zip (39.0 MB), a ZIP file with one .exe that holds the whole game, for 64-bit Windows.')
    expect(text).toContain('- macOS: /work/game/.wasdengine/desktop/macos/Neon Drift.zip (61.0 MB), a ZIP file with the game\'s Mac app, for Intel and Apple silicon Macs.')
    expect(text).toContain('Open Anyway in System Settings > Privacy & Security')
    expect(text).toContain('- Code signing: Using ad-hoc signature.')
    await expect(exporter.execute({ platforms: [] }, exec)).rejects.toThrow('platforms must name at least one')
  })

  it('exports the project for phones and tablets, both platforms unless the call names some, and says how each build installs', async () => {
    const stub = host()
    const exporter = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_export_mobile')!
    const value = await exporter.execute({}, exec) as JsonValue
    await exporter.execute({ project: 'neon', platforms: ['ios', 'android', 'ios'], apple_team_id: 'ABCDE12345' }, exec)
    expect(stub.calls).toEqual([['mobile', '/work/game', ['android', 'ios'], undefined], ['mobile', '/work/neon', ['android', 'ios'], 'ABCDE12345']])
    const text = textOf(exporter.output.render({}, value))
    expect(text).toContain('Exported /work/game for phones and tablets:')
    expect(text).toContain('- Android: /work/game/.wasdengine/mobile/android/Neon Drift.apk (26.0 MB), an APK file for Android phones and tablets with 64-bit ARM processors, package com.wasdengine.game.neon_drift. To install it, copy it to the phone or tablet and open it there')
    expect(text).toContain('Google Play takes new apps only as Android App Bundles, which this export does not build.')
    expect(text).toContain('It is signed with a key the export just created for this computer\'s Android builds, /home/.wasdengine/godot/android/release.keystore: keep a copy of that file and of release-key.json beside it')
    expect(text).toContain('- iOS: /work/game/.wasdengine/mobile/ios/NeonDrift.xcodeproj (367.0 MB), an Xcode project for iPhone and iPad, with the files it builds from beside it, bundle identifier com.wasdengine.game.neon-drift. Open it in Xcode on a Mac; Xcode asks for the Apple developer team to sign with')
    expect(text).toContain('Product > Archive builds it for TestFlight and the App Store')
    const team = textOf(exporter.output.render({}, await exporter.execute({ platforms: ['ios'], apple_team_id: 'ABCDE12345' }, exec) as JsonValue))
    expect(team).toContain('it signs with the Apple developer team ABCDE12345, which Signing & Capabilities can change.')
    await expect(exporter.execute({ platforms: [] }, exec)).rejects.toThrow('platforms must name at least one of "android" and "ios".')
    await expect(exporter.execute({ apple_team_id: 'abcde12345' }, exec)).rejects.toThrow('apple_team_id is 10 capital letters and digits, such as ABCDE12345, not "abcde12345".')
    await expect(exporter.execute({ platforms: ['windows'] }, exec)).rejects.toThrow(/invalid arguments: "platforms\[0\]"/u)
  })

  it('builds the other mobile platform when one fails, and says why that one did not build', async () => {
    const missing = 'An Android export needs a Java runtime and the Android SDK on this computer.'
    const exporter = wasdToolDefinitions(host({}, {}, { android: missing }), LENGTHS).find(definition => definition.name === 'wasd_export_mobile')!
    const value = await exporter.execute({}, exec) as JsonValue
    expect(value).toMatchObject({ builds: [{ platform: 'ios' }], failures: [{ platform: 'android', error: missing }] })
    expect(textOf(exporter.output.render({}, value))).toContain(`- Android did not build: ${missing}`)
    await expect(exporter.execute({ platforms: ['android'] }, exec)).rejects.toThrow(missing)
  })

  it('packs the Web build into one ZIP file for game sites when asked', async () => {
    const stub = host()
    const exporter = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_export_web')!
    const value = await exporter.execute({ zip: true, check: false }, exec) as JsonValue
    expect(stub.calls).toEqual([['export', '/work/game', 'zip']])
    expect(value).toMatchObject({ zip: { file: '/work/game/.wasdengine/web-zip/Neon Drift.zip', bytes: 1536 * 1024 } })
    expect(textOf(exporter.output.render({}, value))).toContain('Packed it into /work/game/.wasdengine/web-zip/Neon Drift.zip (1.5 MB), with index.html at its root: upload that file to a game site such as itch.io as an HTML5 game, or unpack it on any static web server.')
  })

  it('exports the nearest project, names the folder to serve, and reports the Web check', async () => {
    const stub = host()
    const exporter = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_export_web')!
    const value = await exporter.execute({}, exec) as JsonValue
    expect(stub.calls).toEqual([['export', '/work/game'], ['check', '/work/game/.wasdengine/web']])
    const text = textOf(exporter.output.render({}, value))
    expect(text).toBe([
      'Exported /work/game for the Web into /work/game/.wasdengine/web: index.html (2.0 MB). Open index.html through a web server, not from the file system.',
      'Web check: a browser opened the build, Godot started the game after 3.4 s, it drew frames steadily from 52.3 s on, and the check watched it run for 20 s without input: longest freeze 30.2 s (4 of a second or more); 30 fps, slowest frame 917 ms; 2915 draw calls per frame (median, up to 5193); 226 shader programs.',
      'Errors and warnings the build printed:',
      '- ERROR: Too many instances using shader instance variables. (72 times)',
      '- WARNING: The Compatibility renderer does not support manually emitting particles.',
      '- … and 2 more.',
      'Findings:',
      '- The page froze for up to 30.2 s at a time.',
      '- Particles emitted with emit_particle() never appear.',
    ].join('\n'))
  })

  it('skips the Web check on request, and reports a check that could not run without failing the export', async () => {
    const stub = host()
    const exporter = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_export_web')!
    const skipped = await exporter.execute({ check: false }, exec) as JsonValue
    expect(stub.calls).toEqual([['export', '/work/game']])
    expect(textOf(exporter.output.render({}, skipped))).not.toContain('Web check')
    const failed = await exporter.execute({ project: 'broken' }, exec) as JsonValue
    expect(failed).toMatchObject({ webCheckError: 'The Web check\'s browser ended (exit code 1) without a result.' })
    expect(textOf(exporter.output.render({}, failed))).toContain('Web check: it could not run: The Web check\'s browser ended (exit code 1) without a result.')
  })

  it('records the preview with its input, within the configured lengths, and shows the still the model receives', async () => {
    const image = { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 1280, height: 720, name: 'preview.png' } as ImageAttachmentRef
    const stub = host({ started: true, view: { width: 1280, height: 720, image } })
    const recorder = wasdToolDefinitions(stub, LENGTHS).find(definition => definition.name === 'wasd_record_preview')!
    const events = [{ kind: 'key', key: 'Right', pressed: true, hold: 2 }]
    const value = await recorder.execute({ seconds: 5, still_at: 3, events, coordinate_space: 'window' }, exec) as JsonValue
    expect(stub.calls).toEqual([['record', { projectDir: '/work/game', seconds: 5, stillAt: 3, events, coordinateSpace: 'window' }]])
    const blocks = recorder.output.render({}, value)
    expect(textOf(blocks)).toContain('Recorded the game\'s preview: the animation /work/game/.wasdengine/preview/preview.webp (960x540, 3.0 MB) that Explore and the game\'s page play, the GIF /work/game/.wasdengine/preview/preview.gif (50 frames, 4.0 s, 480x270, 2.0 MB) that link previews of its share link show, and the still /work/game/.wasdengine/preview/preview.png (1280x720, 300 KB).')
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
    const ledger = credits()
    const provider = wasdMcpProvider(wasdToolDefinitions(host(), LENGTHS, 'connected'), ledger)
    expect(provider.id).toBe('wasd')
    const tools = provider.tools()
    expect(tools.map(tool => tool.name)).toEqual(['wasd_export_web', 'wasd_export_desktop', 'wasd_export_mobile', 'wasd_record_preview', 'wasd_release_game'])
    type Tool = typeof tools[number]
    const [exporter, desktop, mobile, recorder, release] = tools as [Tool, Tool, Tool, Tool, Tool]
    await expect(desktop.prepare!({ project: 'relative' }, { session: vi.fn() } as never)).rejects.toThrow(/project must be an absolute path/u)
    await expect(mobile.prepare!({ project: 'relative' }, { session: vi.fn() } as never)).rejects.toThrow(/project must be an absolute path/u)
    expect(provider.description).toContain('Export the game for the Web, Windows, macOS, Android, and iOS')
    expect(provider.instructions).toContain('wasd_export_mobile builds it for Android and iOS into its .wasdengine/mobile folder')
    expect(release.inputSchema?.required).toEqual(['project'])
    const agent = { id: 'session' }
    const call = { client: { id: 'claude-code', title: 'Claude Code' }, signal: new AbortController().signal, session: vi.fn(() => Promise.resolve(agent)), reveal: vi.fn() }
    await expect(release.prepare!({ project: 'relative' }, call as never)).rejects.toThrow(/project must be an absolute path/u)
    await expect(release.prepare!({ project: '/game', preview_image: 'cover.png' }, call as never)).rejects.toThrow(/preview_image must be an absolute path/u)
    await expect(release.prepare!({ project: '/game', preview_gif: 'clip.gif' }, call as never)).rejects.toThrow(/preview_gif must be an absolute path/u)
    expect(await exporter.prepare!({ project: '/game' }, call as never)).toEqual({ args: { project: '/game' } })
    expect(await desktop.prepare!({ project: '/game', platforms: ['windows'] }, call as never)).toEqual({ args: { project: '/game', platforms: ['windows'] } })
    expect(call.session).not.toHaveBeenCalled()
    // A release names no model for its application: the credits know what the agent named for the project before.
    expect(await release.prepare!({ project: '/game', notes: 'n' }, call as never)).toEqual({ args: { project: '/game', notes: 'n' }, agent })
    expect(release.inputSchema?.properties).toMatchObject({ new_game: { type: 'boolean' }, model: { type: 'string' } })
    expect(await release.prepare!({ project: '/game', new_game: true, model: 'Claude Opus 5.5' }, call as never))
      .toEqual({ args: { project: '/game', new_game: true, model: 'Claude Opus 5.5' }, agent, model: 'Claude Opus 5.5' })
    // The release credits the agent before it runs, with the model the call named.
    expect(ledger.claim.mock.calls).toEqual([[call.client, '/game', undefined, call.signal], [call.client, '/game', 'Claude Opus 5.5', call.signal]])
    expect(await recorder.prepare!({ project: '/game', seconds: 3 }, call as never)).toEqual({ args: { project: '/game', seconds: 3 }, agent })
    expect(call.session.mock.calls).toEqual([['/game'], ['/game'], ['/game']])
    const refusing = { ...call, client: { id: 'agent', title: 'Connected agent' }, session: vi.fn(() => Promise.reject(new Error('The Host cannot create the Session.'))) }
    expect(await release.prepare!({ project: '/game' }, refusing as never)).toEqual({ args: { project: '/game' } })
    expect(await release.prepare!({ project: '/game', model: 'Qwen3' }, refusing as never)).toEqual({ args: { project: '/game', model: 'Qwen3' }, model: 'Qwen3' })
    await expect(release.prepare!({ project: '/game', model: 5 }, call as never)).rejects.toThrow('model must be a string.')
    await expect(recorder.prepare!({ project: '/game' }, refusing as never)).rejects.toThrow('cannot create the Session')
    expect(await provider.status(new AbortController().signal)).toEqual({ state: 'ready' })
  })

  it('returns the recorded still to connected agents from its file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wasd-tools-'))
    folders.push(dir)
    await writeFile(join(dir, 'preview.jpg'), 'JPEG')
    const recorder = wasdMcpProvider(wasdToolDefinitions(host(), LENGTHS, 'connected'), credits()).tools().find(tool => tool.name === 'wasd_record_preview')!
    const content = await recorder.content!({
      gif: join(dir, 'preview.gif'), webp: join(dir, 'preview.webp'), image: join(dir, 'preview.jpg'), frames: 2, seconds: 1, width: 64, height: 36, gifBytes: 10,
      webpWidth: 64, webpHeight: 36, webpBytes: 8, imageWidth: 64, imageHeight: 36, imageBytes: 4, started: false, paused: false,
    }, {}, exec)
    expect(content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Recorded the game\'s preview') as string })
    expect(content[1]).toEqual({ type: 'image', data: Buffer.from('JPEG').toString('base64'), mimeType: 'image/jpeg' })
  })
})
