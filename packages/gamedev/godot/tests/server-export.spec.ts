/** Dedicated server exports write a temporary Linux preset and an executable; every export carries the multiplayer configuration. */
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  exportServer, GodotExportError, MULTIPLAYER_CONFIG_FILE, SERVER_EXPORT_BINARY, SERVER_EXPORT_PRESET, WEB_EXPORT_PRESET, withDesktopPreset,
  withServerPreset, withWebPreset, type ExportOptions,
} from '../src/export.ts'
import { fakeLog, scratch, subprocessFixture, writeProject, type FakeGodotConfig, type Scratch, type SubprocessFixture } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal

const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
})

async function prepare(config: FakeGodotConfig, before?: (project: string) => Promise<void>, overrides: Partial<ExportOptions> = {}) {
  const dir = await scratch('server-export')
  folders.push(dir)
  const host = await subprocessFixture()
  hosts.push(host)
  const project = await writeProject(join(dir.root, 'game'), config)
  await before?.(project)
  const outputDir = join(project, '.wasdengine', 'server')
  const run = () => exportServer({
    subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project, outputDir,
    template: '/templates/linux "release".x86_64', hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal,
    restoreDir: join(dir.root, 'data', 'export-restore'), ...overrides,
  })
  return { project, outputDir, run }
}

describe('withServerPreset', () => {
  it('exports for Linux x86_64 as a dedicated server with stripped visuals and the pack inside the executable', () => {
    const text = withServerPreset(undefined, '/t/linux "x".x86_64')
    expect(text).toMatch(/^\[preset\.0\]\n\nname="WASD Engine Server"\nplatform="Linux"\nrunnable=false\ndedicated_server=true\n/u)
    expect(text).toContain('export_filter="customized"\ncustomized_files={\n"res://": "strip"\n}\n')
    expect(text).toContain(`include_filter="${MULTIPLAYER_CONFIG_FILE}"`)
    expect(text).toContain('custom_template/debug="/t/linux \\"x\\".x86_64"')
    expect(text).toContain('custom_template/release="/t/linux \\"x\\".x86_64"')
    expect(text).toContain('binary_format/embed_pck=true')
    expect(text).toContain('binary_format/architecture="x86_64"')
  })

  it('replaces an earlier server preset and keeps the project\'s presets in order', () => {
    const original = withWebPreset(withServerPreset('[preset.0]\n\nname="Windows"\n', '/old.x86_64'), '/web.zip')
    const text = withServerPreset(original, '/new.x86_64')
    expect(text).not.toContain('/old.x86_64')
    expect(text.match(/^name=".*"$/gmu)).toEqual(['name="Windows"', `name="${WEB_EXPORT_PRESET}"`, `name="${SERVER_EXPORT_PRESET}"`])
    expect(text.match(/\[preset\.\d+\]/gu)).toEqual(['[preset.0]', '[preset.1]', '[preset.2]'])
  })

  it('has the Web and desktop exports carry the multiplayer configuration too, which Godot leaves out as no resource', () => {
    expect(withWebPreset(undefined, '/t.zip')).toContain(`include_filter="${MULTIPLAYER_CONFIG_FILE}"`)
    for (const platform of ['windows', 'macos'] as const) {
      expect(withDesktopPreset(undefined, platform, '/t.zip', 'Tiny Farm')).toContain(`include_filter="${MULTIPLAYER_CONFIG_FILE}"`)
    }
  })
})

posix('exportServer', () => {
  it('writes the executable with the temporary preset, makes it runnable, and restores the project\'s presets', async () => {
    const original = '[preset.0]\n\nname="Linux"\nplatform="Linux"\n'
    const { project, outputDir, run } = await prepare({ export: { files: { [SERVER_EXPORT_BINARY]: 'ELF server', 'libsteer.linux.template_release.x86_64.so': 'so' }, stderr: 'WARNING: The project uses a deprecated setting.\n' } }, async (dir) => {
      await writeFile(join(dir, 'export_presets.cfg'), original)
    })
    const exported = await run()
    expect(exported).toEqual({
      projectDir: project,
      outputDir,
      binary: SERVER_EXPORT_BINARY,
      bytes: 'ELF server'.length,
      files: [{ path: 'libsteer.linux.template_release.x86_64.so', bytes: 2 }, { path: SERVER_EXPORT_BINARY, bytes: 'ELF server'.length }],
      warnings: ['The project uses a deprecated setting.'],
    })
    expect((await stat(join(outputDir, SERVER_EXPORT_BINARY))).mode & 0o777).toBe(0o755)
    expect(await readFile(join(project, 'export_presets.cfg'), 'utf8')).toBe(original)
    const log = await fakeLog(project)
    const argv = (log[0] as { argv: string[] }).argv
    expect(argv).toEqual(['--headless', '--path', project, '--export-release', SERVER_EXPORT_PRESET, join(outputDir, SERVER_EXPORT_BINARY)])
    const seen = log.find(entry => entry.preset !== undefined) as { preset: string; presets: string }
    expect(seen.preset).toBe(SERVER_EXPORT_PRESET)
    expect(seen.presets).toContain('name="Linux"')
    expect(seen.presets).toContain('dedicated_server=true')
  })

  it('reports Godot\'s errors when the export writes no executable', async () => {
    const { run } = await prepare({ export: { files: {}, stderr: 'ERROR: Cannot export project with preset "WASD Engine Server": template missing.\n' } })
    const failure = run()
    await expect(failure).rejects.toBeInstanceOf(GodotExportError)
    await expect(failure).rejects.toThrow(/dedicated server export ended .* without writing server\.x86_64[\s\S]*template missing/u)
  })
})
