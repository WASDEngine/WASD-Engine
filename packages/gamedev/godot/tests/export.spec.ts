/** Web exports write a temporary preset, restore the project's presets, and report a playable build or why there is none. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportWeb, GodotExportError, WEB_EXPORT_PRESET, webNotes, withWebPreset, type WebExportOptions } from '../src/export.ts'
import { fakeLog, scratch, subprocessFixture, writeProject, type FakeGodotConfig, type Scratch, type SubprocessFixture } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal

const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
})

const BUILD = { 'index.html': '<html>', 'index.js': 'js', 'index.wasm': 'wasm', 'index.pck': 'pck', 'index.png': 'png' }

async function prepare(config: FakeGodotConfig, before?: (project: string) => Promise<void>, overrides: Partial<WebExportOptions> = {}) {
  const dir = await scratch('export')
  folders.push(dir)
  const host = await subprocessFixture()
  hosts.push(host)
  const project = await writeProject(join(dir.root, 'game'), config)
  await before?.(project)
  const outputDir = join(project, '.wasdengine', 'web')
  const exportBuild = () => exportWeb({
    subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project, outputDir,
    template: '/templates/web "release".zip', hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, ...overrides,
  })
  return { project, outputDir, run: exportBuild }
}

describe('withWebPreset', () => {
  it('adds the preset after the project\'s own presets and quotes the template path', () => {
    const original = '[preset.0]\n\nname="Windows"\nplatform="Windows Desktop"\n\n[preset.0.options]\n\nbinary_format/embed_pck=false\n'
    const text = withWebPreset(original, 'C:\\templates\\web "a".zip')
    expect(text).toContain('[preset.0]\n\nname="Windows"')
    expect(text).toContain('[preset.0.options]\n\nbinary_format/embed_pck=false')
    expect(text).toContain(`[preset.1]\n\nname="${WEB_EXPORT_PRESET}"\nplatform="Web"`)
    expect(text).toContain('custom_template/release="C:\\\\templates\\\\web \\"a\\".zip"')
    expect(text).toContain('variant/thread_support=false')
    expect(text).toContain('variant/extensions_support=false')
  })

  it('replaces an earlier Web export preset and renumbers the presets without gaps', () => {
    const original = [
      '[preset.0]', '', `name="${WEB_EXPORT_PRESET}"`, '', '[preset.0.options]', '', 'custom_template/release="/old.zip"', '',
      '[preset.1]', '', 'name="Linux"', '', '[preset.1.options]', '', 'a=1', '',
    ].join('\r\n')
    const text = withWebPreset(original, '/new.zip')
    expect(text).not.toContain('/old.zip')
    expect(text).toContain('[preset.0]\n\nname="Linux"')
    expect(text).toContain('[preset.0.options]\n\na=1')
    expect(text).toContain(`[preset.1]\n\nname="${WEB_EXPORT_PRESET}"`)
    expect(text.match(/\[preset\.\d+\]/gu)).toEqual(['[preset.0]', '[preset.1]'])
  })

  it('writes the preset alone for a project without presets', () => {
    expect(withWebPreset(undefined, '/t.zip')).toMatch(/^\[preset\.0\]\n\nname="WASD Engine Web"/u)
  })
})

describe('webNotes', () => {
  it('names the Compatibility renderer for Forward+ and Mobile projects only', () => {
    expect(webNotes('[rendering]\nrenderer/rendering_method="forward_plus"\n')[0]).toContain('Compatibility renderer')
    expect(webNotes('[rendering]\nrenderer/rendering_method="mobile"\n')).toHaveLength(1)
    expect(webNotes('[rendering]\nrenderer/rendering_method="gl_compatibility"\n')).toEqual([])
    expect(webNotes('[application]\nconfig/name="x"\n')).toEqual([])
  })
})

posix('exportWeb', () => {
  it('exports with the temporary preset, restores the project\'s presets, and lists the build', async () => {
    const original = '[preset.0]\n\nname="Windows"\nplatform="Windows Desktop"\n'
    const { project, outputDir, run } = await prepare({ export: { files: BUILD, stderr: 'WARNING: Screen-space AA is only available when using the Forward+ or Mobile renderer.\n' } }, async (dir) => {
      await writeFile(join(dir, 'export_presets.cfg'), original)
      await writeFile(join(dir, '.stale'), '')
    })
    const exported = await run()
    expect(exported.entry).toBe('index.html')
    expect(exported.outputDir).toBe(outputDir)
    expect(exported.files.map(file => file.path)).toEqual(['index.html', 'index.js', 'index.pck', 'index.png', 'index.wasm'])
    expect(exported.totalBytes).toBe(Object.values(BUILD).join('').length)
    expect(exported.warnings).toEqual(['Screen-space AA is only available when using the Forward+ or Mobile renderer.'])
    expect(await readFile(join(project, 'export_presets.cfg'), 'utf8')).toBe(original)
    const log = await fakeLog(project)
    const exportEntry = log.find(entry => entry.preset !== undefined) as { preset: string; presets: string }
    expect(exportEntry.preset).toBe(WEB_EXPORT_PRESET)
    expect(exportEntry.presets).toContain('name="Windows"')
    expect(exportEntry.presets).toContain('custom_template/release="/templates/web \\"release\\".zip"')
    const argv = (log[0] as { argv: string[] }).argv
    expect(argv.slice(0, 5)).toEqual(['--headless', '--path', project, '--export-release', WEB_EXPORT_PRESET])
    expect(argv[5]).toBe(join(outputDir, 'index.html'))
  })

  it('removes the presets file it created and empties the output folder of an earlier build', async () => {
    const { project, outputDir, run } = await prepare({ export: { files: BUILD } })
    await run()
    await writeFile(join(outputDir, 'old.js'), 'stale')
    await run()
    expect(await readdir(outputDir)).not.toContain('old.js')
    await expect(readFile(join(project, 'export_presets.cfg'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports Godot\'s errors when the export writes no playable build', async () => {
    const { project, run } = await prepare({ export: { files: { 'index.html': '<html>' }, stderr: 'ERROR: Cannot export project with preset "WASD Engine Web": template missing.\n' } }, async (dir) => {
      await writeFile(join(dir, 'export_presets.cfg'), 'kept')
    })
    const failure = run()
    await expect(failure).rejects.toBeInstanceOf(GodotExportError)
    await expect(failure).rejects.toThrow(/without writing index\.js, index\.wasm, index\.pck[\s\S]*template missing/u)
    expect(await readFile(join(project, 'export_presets.cfg'), 'utf8')).toBe('kept')
  })

  it('stops an export that outlives its deadline', async () => {
    const { run } = await prepare({ export: { files: {}, delayMs: 10_000 } }, undefined, { timeoutMs: 300 })
    await expect(run()).rejects.toThrow(/did not finish within/u)
  })
})
