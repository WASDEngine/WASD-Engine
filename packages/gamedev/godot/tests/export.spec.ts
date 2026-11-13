/** Exports write a temporary preset, restore the project's presets, and report the build or why there is none. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleIdentifier, customBootSplash, DESKTOP_EXPORT_PRESETS, desktopFileName, exportDesktop, exportWeb, GodotExportError, HIDE_SPLASH_HEAD,
  textureImports, WEB_EXPORT_PRESET, webNotes, withDesktopPreset, withTextureImports, withWebPreset, type WebExportOptions,
} from '../src/export.ts'
import type { GodotDesktopPlatform } from '../src/types.ts'
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
    const text = withWebPreset(original, 'C:\\templates\\web "a".zip', true)
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
    const text = withWebPreset(original, '/new.zip', true)
    expect(text).not.toContain('/old.zip')
    expect(text).toContain('[preset.0]\n\nname="Linux"')
    expect(text).toContain('[preset.0.options]\n\na=1')
    expect(text).toContain(`[preset.1]\n\nname="${WEB_EXPORT_PRESET}"`)
    expect(text.match(/\[preset\.\d+\]/gu)).toEqual(['[preset.0]', '[preset.1]'])
  })

  it('writes the preset alone for a project without presets', () => {
    expect(withWebPreset(undefined, '/t.zip', true)).toMatch(/^\[preset\.0\]\n\nname="WASD Engine Web"/u)
  })

  it('hides the loading screen\'s splash image through the page head only when asked', () => {
    expect(withWebPreset(undefined, '/t.zip', true)).toContain(`html/head_include="${HIDE_SPLASH_HEAD}"`)
    expect(withWebPreset(undefined, '/t.zip', false)).toContain('html/head_include=""')
  })
})

describe('customBootSplash', () => {
  it('finds a boot splash image path in the application section, feature overrides included', () => {
    expect(customBootSplash('[application]\n\nconfig/name="x"\nboot_splash/image="res://splash.png"\n')).toBe(true)
    expect(customBootSplash('[application]\r\nboot_splash/image.web="uid://b4k2"\r\n')).toBe(true)
  })

  it('ignores an empty path, other sections, and other splash settings', () => {
    expect(customBootSplash('[application]\nboot_splash/image=""\nboot_splash/bg_color=Color(0, 0, 0, 1)\n')).toBe(false)
    expect(customBootSplash('[display]\nboot_splash/image="res://splash.png"\n')).toBe(false)
    expect(customBootSplash('[application]\nconfig/name="x"\n')).toBe(false)
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

  it('hides Godot\'s splash image on the loading screen unless the project names its own', async () => {
    const plain = await prepare({ export: { files: BUILD } })
    await plain.run()
    const plainPresets = (await fakeLog(plain.project)).find(entry => entry.preset !== undefined) as { presets: string }
    expect(plainPresets.presets).toContain(`html/head_include="${HIDE_SPLASH_HEAD}"`)
    const branded = await prepare({ export: { files: BUILD } }, async (dir) => {
      const text = await readFile(join(dir, 'project.godot'), 'utf8')
      await writeFile(join(dir, 'project.godot'), text.replace('[application]\n', '[application]\n\nboot_splash/image="res://studio.png"\n'))
    })
    await branded.run()
    const brandedPresets = (await fakeLog(branded.project)).find(entry => entry.preset !== undefined) as { presets: string }
    expect(brandedPresets.presets).toContain('html/head_include=""')
  })

  it('turns off the Blender importer of a project that holds a .blend file and says so first', async () => {
    const { project, run } = await prepare({ export: { files: BUILD } }, async (dir) => { await writeFile(join(dir, 'ship.blend'), 'blend') })
    const exported = await run()
    expect(exported.warnings[0]).toContain('because of res://ship.blend')
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toContain('import/blender/enabled=false')
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

describe('withDesktopPreset', () => {
  it('builds one self-contained 64-bit Windows executable from the template', () => {
    const text = withDesktopPreset('[preset.0]\n\nname="Web"\nplatform="Web"\n', 'windows', '/t/win "x".exe', 'Tiny Farm')
    expect(text).toContain('[preset.0]\n\nname="Web"')
    expect(text).toContain(`[preset.1]\n\nname="${DESKTOP_EXPORT_PRESETS.windows}"\nplatform="Windows Desktop"`)
    expect(text).toContain('custom_template/release="/t/win \\"x\\".exe"')
    expect(text).toContain('custom_template/debug="/t/win \\"x\\".exe"')
    expect(text).toContain('binary_format/embed_pck=true')
    expect(text).toContain('binary_format/architecture="x86_64"')
    expect(text).toContain('codesign/enable=false')
  })

  it('builds a universal Mac app signed ad hoc, with a bundle identifier from the game\'s name', () => {
    const text = withDesktopPreset(undefined, 'macos', '/t/macos.zip', 'Tiny Farm')
    expect(text).toMatch(/^\[preset\.0\]\n\nname="WASD Engine macOS"\nplatform="macOS"/u)
    expect(text).toContain('binary_format/architecture="universal"')
    expect(text).toContain('application/bundle_identifier="com.wasdengine.game.tiny-farm"')
    expect(text).toContain('codesign/codesign=1')
    expect(text).toContain('notarization/notarization=0')
  })

  it('replaces an earlier preset of its own name only', () => {
    const first = withDesktopPreset(undefined, 'windows', '/old.exe', 'A')
    const both = withDesktopPreset(first, 'macos', '/m.zip', 'A')
    const again = withDesktopPreset(both, 'windows', '/new.exe', 'A')
    expect(again).not.toContain('/old.exe')
    expect(again.match(/name="[^"]+"/gu)).toEqual([`name="${DESKTOP_EXPORT_PRESETS.macos}"`, `name="${DESKTOP_EXPORT_PRESETS.windows}"`])
  })
})

describe('bundleIdentifier and desktopFileName', () => {
  it('makes a bundle identifier macOS takes from any name', () => {
    expect(bundleIdentifier('Tiny Farm')).toBe('com.wasdengine.game.tiny-farm')
    expect(bundleIdentifier('Café Über Ünïcode!')).toBe('com.wasdengine.game.cafe-uber-unicode')
    expect(bundleIdentifier('3D Racer')).toBe('com.wasdengine.game.game-3d-racer')
    expect(bundleIdentifier('游戏')).toBe('com.wasdengine.game.game')
    expect(bundleIdentifier('x'.repeat(100))).toBe(`com.wasdengine.game.${'x'.repeat(60)}`)
  })

  it('names the build after the game without the characters file systems refuse', () => {
    expect(desktopFileName('Tiny Farm')).toBe('Tiny Farm')
    expect(desktopFileName('Who: Are/You? <3> "quoted" | a\\b')).toBe('Who Are You 3 quoted a b')
    expect(desktopFileName('..hidden')).toBe('hidden')
    expect(desktopFileName('  \u0007 ')).toBe('Game')
    expect(desktopFileName(undefined)).toBe('Game')
    expect(desktopFileName('游戏 '.repeat(40))).toHaveLength(64)
  })
})

describe('textureImports and withTextureImports', () => {
  const project = '[application]\n\nconfig/name="x"\n\n[rendering]\n\nrenderer/rendering_method="forward_plus"\ntextures/vram_compression/import_etc2_astc=false\n\n[physics]\n\ncommon/max_physics_steps_per_frame=8\n'

  it('reads the settings of the rendering section only', () => {
    expect(textureImports(project)).toEqual({ etc2_astc: 'false' })
    expect(textureImports('[display]\ntextures/vram_compression/import_s3tc_bptc=true\n')).toEqual({})
  })

  it('changes and adds settings inside the rendering section, and removes the ones set to undefined', () => {
    const on = withTextureImports(project, { s3tc_bptc: 'true', etc2_astc: 'true' })
    expect(textureImports(on)).toEqual({ s3tc_bptc: 'true', etc2_astc: 'true' })
    expect(on).toContain('textures/vram_compression/import_etc2_astc=true\ntextures/vram_compression/import_s3tc_bptc=true\n\n[physics]')
    expect(withTextureImports(on, { s3tc_bptc: undefined, etc2_astc: 'false' })).toBe(project)
  })

  it('adds a rendering section to a project without one, keeping its line endings', () => {
    const text = withTextureImports('[application]\r\n\r\nconfig/name="x"\r\n', { etc2_astc: 'true' })
    expect(text).toBe('[application]\r\n\r\nconfig/name="x"\r\n\r\n[rendering]\r\n\r\ntextures/vram_compression/import_etc2_astc=true\r\n')
    expect(withTextureImports(text, { etc2_astc: undefined })).toBe('[application]\r\n\r\nconfig/name="x"\r\n\r\n[rendering]\r\n\r\n')
  })
})

posix('exportDesktop', () => {
  async function prepareDesktop(platform: GodotDesktopPlatform, config: FakeGodotConfig, before?: (project: string) => Promise<void>) {
    const dir = await scratch('export-desktop')
    folders.push(dir)
    const host = await subprocessFixture()
    hosts.push(host)
    const project = await writeProject(join(dir.root, 'game'), config)
    await before?.(project)
    const outputDir = join(project, '.wasdengine', 'desktop', platform)
    const run = () => exportDesktop({
      subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project, outputDir,
      platform, template: `/templates/${platform}`, hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal,
    })
    return { project, outputDir, run }
  }

  it('exports a macOS ZIP named after the game with both texture formats imported, then restores the project', async () => {
    const original = '[preset.0]\n\nname="Linux"\nplatform="Linux"\n'
    const { project, outputDir, run } = await prepareDesktop('macos', { export: { files: { 'Fake game.zip': 'zip!' }, stderr: 'WARNING: Code signing: Using ad-hoc signature.\n' } }, async (dir) => {
      await writeFile(join(dir, 'export_presets.cfg'), original)
    })
    const settings = await readFile(join(project, 'project.godot'), 'utf8')
    const exported = await run()
    expect(exported).toEqual({
      projectDir: project, platform: 'macos', outputDir, entry: 'Fake game.zip', bytes: 4, warnings: ['Code signing: Using ad-hoc signature.'],
    })
    const log = await fakeLog(project)
    const exportEntry = log.find(entry => entry.preset !== undefined) as { preset: string; presets: string; project: string }
    expect(exportEntry.preset).toBe(DESKTOP_EXPORT_PRESETS.macos)
    expect(exportEntry.presets).toContain('name="Linux"')
    expect(exportEntry.presets).toContain('application/bundle_identifier="com.wasdengine.game.fake-game"')
    expect(textureImports(exportEntry.project)).toEqual({ s3tc_bptc: 'true', etc2_astc: 'true' })
    const argv = (log[0] as { argv: string[] }).argv
    expect(argv.slice(0, 5)).toEqual(['--headless', '--path', project, '--export-release', DESKTOP_EXPORT_PRESETS.macos])
    expect(argv[5]).toBe(join(outputDir, 'Fake game.zip'))
    expect(await readFile(join(project, 'export_presets.cfg'), 'utf8')).toBe(original)
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(settings)
  })

  it('keeps a change to project.godot made during the export and still restores the import settings', async () => {
    const { project, run } = await prepareDesktop('windows', { export: { files: { 'Fake game.zip': 'zip' }, appendProject: '\n[display]\n\nwindow/size/viewport_width=640\n' } }, async (dir) => {
      const text = await readFile(join(dir, 'project.godot'), 'utf8')
      await writeFile(join(dir, 'project.godot'), `${text}\n[rendering]\n\ntextures/vram_compression/import_s3tc_bptc=false\n`)
    })
    await run()
    const after = await readFile(join(project, 'project.godot'), 'utf8')
    expect(after).toContain('window/size/viewport_width=640')
    expect(textureImports(after)).toEqual({ s3tc_bptc: 'false' })
    const exportEntry = (await fakeLog(project)).find(entry => entry.preset !== undefined) as { project: string }
    expect(textureImports(exportEntry.project)).toEqual({ s3tc_bptc: 'true' })
  })

  it('leaves project.godot untouched when it already imports what the platform needs', async () => {
    const { project, run } = await prepareDesktop('windows', { export: { files: { 'Fake game.zip': 'zip' } } }, async (dir) => {
      const text = await readFile(join(dir, 'project.godot'), 'utf8')
      await writeFile(join(dir, 'project.godot'), `${text}\n[rendering]\n\ntextures/vram_compression/import_s3tc_bptc=true\n`)
    })
    const settings = await readFile(join(project, 'project.godot'), 'utf8')
    await run()
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(settings)
  })

  it('reports Godot\'s errors when the export writes no ZIP file, and empties the folder of an earlier build', async () => {
    const { outputDir, run } = await prepareDesktop('macos', { export: { files: {}, stderr: 'ERROR: Cannot export for universal or arm64 if ETC2 ASTC texture format is disabled.\n' } })
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, 'Old.zip'), 'old')
    const failure = run()
    await expect(failure).rejects.toBeInstanceOf(GodotExportError)
    await expect(failure).rejects.toThrow(/The Godot macOS export ended \(.*\) without writing Fake game\.zip\.[\s\S]*ETC2 ASTC/u)
    expect(await readdir(outputDir)).toEqual([])
  })
})
