/** Exports write a temporary preset, restore the project's presets, and report the build or why there is none. */
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  androidVersionCode, bundleIdentifier, customBootSplash, DESKTOP_EXPORT_PRESETS, desktopFileName, EXPORT_SPLASH_PATH, exportDesktop,
  exportMobile, exportWeb, GodotExportError, LARGE_PACK_BYTES, MOBILE_EXPORT_PRESETS, packNotes, pendingExportRestores, replayExportRestore,
  textureImports, WASD_SPLASH_IMAGES, wasdSplash, WEB_EXPORT_PRESET, WEB_RENDERER_NOTE, WEB_SPLASH_FILE, webNotes, withDesktopPreset,
  withExportSplash, withMobilePreset, withoutPreset, withTextureImports, withWebPreset, type WebExportOptions,
} from '../src/export.ts'
import { IOS_SPLASH_SETTING_WARNING, UNSET_TEAM_ID } from '../src/ios.ts'
import type { GodotDesktopPlatform } from '../src/types.ts'
import { compose } from './composition.ts'
import {
  configureFake, fakeLog, scratch, subprocessFixture, until, writeProject, type FakeGodotConfig, type Scratch, type SubprocessFixture,
} from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal

const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
})

const BUILD = { 'index.html': '<html>', 'index.js': 'js', 'index.wasm': 'wasm', 'index.pck': 'pck', 'index.png': 'png' }
/** WASD Engine's boot splash images as the plugin ships them. */
const SPLASH = { dark: readFileSync(fileURLToPath(WASD_SPLASH_IMAGES.dark)), light: readFileSync(fileURLToPath(WASD_SPLASH_IMAGES.light)) }
/** The real path of {@link EXPORT_SPLASH_PATH} in a project. */
const splashFile = (project: string): string => join(project, '.godot', 'wasd_engine_splash.png')
const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

/** What the fake recorded as an export started: the preset, the presets and `project.godot` it saw, and the boot splash's size. */
type ExportEntry = {
  readonly preset: string
  readonly presets: string
  readonly project: string
  readonly splashBytes: number | null
}

/** Set lines of a project's `[application]` section, as a project's own settings. */
async function setApplication(project: string, lines: string): Promise<void> {
  const text = await readFile(join(project, 'project.godot'), 'utf8')
  await writeFile(join(project, 'project.godot'), text.replace('[application]\n', `[application]\n\n${lines}\n`))
}

async function prepare(config: FakeGodotConfig, before?: (project: string) => Promise<void>, overrides: Partial<WebExportOptions> = {}) {
  const dir = await scratch('export')
  folders.push(dir)
  const host = await subprocessFixture()
  hosts.push(host)
  const project = await writeProject(join(dir.root, 'game'), config)
  await before?.(project)
  const outputDir = join(project, '.wasdengine', 'web')
  const restoreDir = join(dir.root, 'data', 'export-restore')
  const exportBuild = () => exportWeb({
    subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project, outputDir,
    template: '/templates/web "release".zip', hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, restoreDir,
    ...overrides,
  })
  return { project, outputDir, restoreDir, run: exportBuild }
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

  it('writes the preset alone for a project without presets, with nothing added to the page head', () => {
    expect(withWebPreset(undefined, '/t.zip')).toMatch(/^\[preset\.0\]\n\nname="WASD Engine Web"/u)
    expect(withWebPreset(undefined, '/t.zip')).toContain('html/head_include=""')
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

describe('wasdSplash', () => {
  it('shows the light wordmark on Godot\'s default splash color and on other dark ones', () => {
    expect(wasdSplash('[application]\n\nconfig/name="x"\n')).toBe('dark')
    expect(wasdSplash('[application]\nboot_splash/bg_color=Color(0.2, 0.25, 0.3, 1)\n')).toBe('dark')
    expect(wasdSplash('[application]\nboot_splash/bg_color=Color(0, 0, 0, 1)\n')).toBe('dark')
    // Neither an unreadable color nor another section's setting replaces Godot's default.
    expect(wasdSplash('[application]\nboot_splash/bg_color=Color(a, b, c, 1)\n')).toBe('dark')
    expect(wasdSplash('[display]\nboot_splash/bg_color=Color(1, 1, 1, 1)\n')).toBe('dark')
  })

  it('shows the dark wordmark on a light splash color, overbright ones included', () => {
    expect(wasdSplash('[application]\r\nboot_splash/bg_color=Color(0.95, 0.93, 0.88, 1)\r\n')).toBe('light')
    expect(wasdSplash('[application]\nboot_splash/bg_color=Color(0.6, 0.6, 0.6, 1)\n')).toBe('light')
    expect(wasdSplash('[application]\nboot_splash/bg_color=Color(2, 3, 2.5, 1)\n')).toBe('light')
  })

  it('shows none for a project with a boot splash image of its own or with the image turned off', () => {
    expect(wasdSplash('[application]\nboot_splash/image="res://studio.png"\n')).toBeUndefined()
    expect(wasdSplash('[application]\nboot_splash/show_image=false\n')).toBeUndefined()
    expect(wasdSplash('[application]\nboot_splash/image=""\nboot_splash/show_image=true\n')).toBe('dark')
  })
})

describe('withExportSplash', () => {
  const project = 'config_version=5\n\n[application]\n\nconfig/name="x"\nboot_splash/image=""\n\n[rendering]\n\nrenderer/rendering_method="forward_plus"\n'

  it('names the export\'s image after the section\'s own lines, so Godot reads it last, and removes it again', () => {
    const named = withExportSplash(project, true)
    expect(named).toBe(project.replace('boot_splash/image=""\n', `boot_splash/image=""\nboot_splash/image="${EXPORT_SPLASH_PATH}"\n`))
    expect(withExportSplash(named, true)).toBe(named)
    expect(withExportSplash(named, false)).toBe(project)
    expect(withExportSplash(project, false)).toBe(project)
  })

  it('adds an application section to a project without one, keeping its line endings', () => {
    const text = withExportSplash('config_version=5\r\n\r\n[rendering]\r\n\r\nx=1\r\n', true)
    expect(text).toBe(`config_version=5\r\n\r\n[rendering]\r\n\r\nx=1\r\n\r\n[application]\r\n\r\nboot_splash/image="${EXPORT_SPLASH_PATH}"\r\n`)
    // The export's own image is no image of the project's: a line an interrupted export left still gets the splash.
    expect(customBootSplash(text)).toBe(false)
    expect(wasdSplash(text)).toBe('dark')
  })
})

describe('webNotes', () => {
  it('names the Compatibility renderer for every project that does not render with it', () => {
    expect(webNotes('[rendering]\nrenderer/rendering_method="forward_plus"\n')).toEqual([WEB_RENDERER_NOTE])
    expect(webNotes('[rendering]\nrenderer/rendering_method="mobile"\n')).toEqual([WEB_RENDERER_NOTE])
    // Without a rendering method, the project renders with Forward+, Godot 4's default.
    expect(webNotes('[application]\nconfig/name="x"\n')).toEqual([WEB_RENDERER_NOTE])
    expect(webNotes('[rendering]\nrenderer/rendering_method="gl_compatibility"\n')).toEqual([])
  })
})

describe('packNotes', () => {
  it('notes a pack larger than 100 MB', () => {
    expect(packNotes([{ path: 'index.pck', bytes: LARGE_PACK_BYTES }, { path: 'index.wasm', bytes: 1 }])).toEqual([])
    expect(packNotes([{ path: 'index.wasm', bytes: 2 * LARGE_PACK_BYTES }])).toEqual([])
    expect(packNotes([{ path: 'index.pck', bytes: 373 * 1024 * 1024 }])).toEqual([
      'The game\'s pack is 373 MB, and players download all of it before the game starts. Textures are most of most packs: lower the size limit of large ones (process/size_limit in their .import files), reuse textures, and keep sounds compressed.',
    ])
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
    // The splash image Godot wrote became WASD Engine's.
    expect(exported.files.find(file => file.path === WEB_SPLASH_FILE)?.bytes).toBe(SPLASH.dark.length)
    expect(exported.totalBytes).toBe(Object.values(BUILD).join('').length - BUILD['index.png'].length + SPLASH.dark.length)
    // The fixture project sets no rendering method, so it renders with Forward+ on desktop.
    expect(exported.warnings).toEqual([WEB_RENDERER_NOTE, 'Screen-space AA is only available when using the Forward+ or Mobile renderer.'])
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

  it('replaces Godot\'s splash image with WASD Engine\'s for the project\'s splash color unless the project names its own', async () => {
    const plain = await prepare({ export: { files: BUILD } })
    await plain.run()
    expect(await readFile(join(plain.outputDir, WEB_SPLASH_FILE))).toEqual(SPLASH.dark)
    const light = await prepare({ export: { files: BUILD } }, dir => setApplication(dir, 'boot_splash/bg_color=Color(0.95, 0.93, 0.88, 1)'))
    await light.run()
    expect(await readFile(join(light.outputDir, WEB_SPLASH_FILE))).toEqual(SPLASH.light)
    const branded = await prepare({ export: { files: BUILD } }, dir => setApplication(dir, 'boot_splash/image="res://studio.png"'))
    await branded.run()
    expect(await readFile(join(branded.outputDir, WEB_SPLASH_FILE), 'utf8')).toBe('png')
    const hidden = await prepare({ export: { files: BUILD } }, dir => setApplication(dir, 'boot_splash/show_image=false'))
    await hidden.run()
    expect(await readFile(join(hidden.outputDir, WEB_SPLASH_FILE), 'utf8')).toBe('png')
    // The page carries nothing of its own about the splash, and the Web export leaves the project's files alone.
    const presets = (await fakeLog(plain.project)).find(entry => entry.preset !== undefined) as ExportEntry
    expect(presets.presets).toContain('html/head_include=""')
    expect(presets.splashBytes).toBeNull()
    expect(await exists(splashFile(plain.project))).toBe(false)
  })

  it('writes no splash image when Godot wrote none', async () => {
    const { outputDir, run } = await prepare({ export: { files: { 'index.html': '<html>' } } })
    await expect(run()).rejects.toBeInstanceOf(GodotExportError)
    expect(await readdir(outputDir)).toEqual(['index.html'])
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

describe('withoutPreset', () => {
  it('removes one preset by name and renumbers the rest, and leaves a text without it alone', () => {
    const text = withDesktopPreset(withWebPreset('[preset.0]\n\nname="Linux"\nplatform="Linux"\n', '/t.zip'), 'windows', '/w.exe', 'Game')
    const kept = withoutPreset(text, WEB_EXPORT_PRESET)
    expect(kept).toMatch(/^\[preset\.0\]\n\nname="Linux"[\s\S]*\[preset\.1\]\n\nname="WASD Engine Windows"/u)
    expect(kept).not.toContain(WEB_EXPORT_PRESET)
    expect(withoutPreset(kept, WEB_EXPORT_PRESET)).toBe(kept)
    expect(withoutPreset(withWebPreset(undefined, '/t.zip'), WEB_EXPORT_PRESET)).toBe('')
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
    const restoreDir = join(dir.root, 'data', 'export-restore')
    const run = () => exportDesktop({
      subprocess: host.subprocess, runtime: { kind: 'libgodot', runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project, outputDir,
      platform, template: `/templates/${platform}`, hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, restoreDir,
    })
    return { project, outputDir, restoreDir, run }
  }

  /**
   * Run an export, and keep the project's files, the boot splash image, and the restore record as they were while it
   * ran, as an app that quit then leaves them.
   */
  async function interrupt(
    project: string, restoreDir: string, run: () => Promise<unknown>,
  ): Promise<{ readonly presets: string; readonly project: string; readonly splash: Buffer | undefined }> {
    const exporting = run()
    let name: string
    let record: string
    let during: { readonly presets: string; readonly project: string; readonly splash: Buffer | undefined }
    try {
      // Godot starts once the export changed the project's files, and the record came before those changes.
      await until(async () => (await fakeLog(project).catch(() => [])).some(entry => entry.preset !== undefined))
      name = (await readdir(restoreDir)).filter(entry => entry.endsWith('.json'))[0] as string
      record = await readFile(join(restoreDir, name), 'utf8')
      during = {
        presets: await readFile(join(project, 'export_presets.cfg'), 'utf8'),
        project: await readFile(join(project, 'project.godot'), 'utf8'),
        splash: await readFile(splashFile(project)).catch(() => undefined),
      }
    } finally {
      await exporting
    }
    expect(await readdir(restoreDir)).toEqual([])
    expect(await exists(splashFile(project))).toBe(false)
    await writeFile(join(project, 'export_presets.cfg'), during.presets)
    await writeFile(join(project, 'project.godot'), during.project)
    if (during.splash !== undefined) await writeFile(splashFile(project), during.splash)
    await writeFile(join(restoreDir, name), record)
    return during
  }

  it('returns the files of an export that the app quit during from its restore record, which it then deletes', async () => {
    const original = '[preset.0]\n\nname="Linux"\nplatform="Linux"\n'
    const { project, restoreDir, run } = await prepareDesktop('macos', { export: { files: { 'Fake game.zip': 'zip' }, delayMs: 300 } }, async (dir) => {
      await writeFile(join(dir, 'export_presets.cfg'), original)
    })
    const settings = await readFile(join(project, 'project.godot'), 'utf8')
    const during = await interrupt(project, restoreDir, run)
    expect(during.presets).toContain(DESKTOP_EXPORT_PRESETS.macos)
    expect(textureImports(during.project)).toEqual({ s3tc_bptc: 'true', etc2_astc: 'true' })
    expect(during.project).toContain(`boot_splash/image="${EXPORT_SPLASH_PATH}"`)
    expect(during.splash).toEqual(SPLASH.dark)
    expect(await pendingExportRestores(restoreDir)).toEqual([project])
    expect(await replayExportRestore(restoreDir, project)).toBe(true)
    expect(await readFile(join(project, 'export_presets.cfg'), 'utf8')).toBe(original)
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(settings)
    expect(await exists(splashFile(project))).toBe(false)
    expect(await readdir(restoreDir)).toEqual([])
    expect(await replayExportRestore(restoreDir, project)).toBe(false)
  })

  it('returns the files of an interrupted export when the plugin starts', async () => {
    const original = '[preset.0]\n\nname="Linux"\nplatform="Linux"\n'
    const { project, restoreDir, run } = await prepareDesktop('macos', { export: { files: { 'Fake game.zip': 'zip' }, delayMs: 300 } }, async (dir) => {
      await writeFile(join(dir, 'export_presets.cfg'), original)
    })
    const settings = await readFile(join(project, 'project.godot'), 'utf8')
    await interrupt(project, restoreDir, run)
    const plugin = await compose({ config: { dataRoot: join(restoreDir, '..') } })
    try {
      await until(async () => (await readdir(restoreDir)).length === 0)
      expect(await readFile(join(project, 'export_presets.cfg'), 'utf8')).toBe(original)
      expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(settings)
    } finally {
      await plugin.cleanup()
    }
  })

  it('keeps the changes made since the interrupted export, and the next export replays its record first', async () => {
    const { project, restoreDir, run } = await prepareDesktop('windows', { export: { files: { 'Fake game.zip': 'zip' }, delayMs: 300 } })
    const settings = await readFile(join(project, 'project.godot'), 'utf8')
    const during = await interrupt(project, restoreDir, run)
    // The user added a preset and a setting after the app quit.
    const own = '[preset.1]\n\nname="Web"\nplatform="Web"'
    await writeFile(join(project, 'export_presets.cfg'), `${during.presets}\n${own}\n`)
    await writeFile(join(project, 'project.godot'), `${during.project}\n[display]\n\nwindow/size/viewport_width=640\n`)
    await configureFake(project, { export: { files: { 'Fake game.zip': 'zip' } } })
    await run()
    const exportEntry = (await fakeLog(project)).filter(entry => entry.preset !== undefined).at(-1) as { presets: string; project: string }
    // The second export saw the project as the user left it, without the first export's changes.
    expect(exportEntry.presets.match(/name="WASD Engine Windows"/gu)).toHaveLength(1)
    expect(exportEntry.presets).toContain('[preset.0]\n\nname="Web"')
    expect(exportEntry.project.match(/boot_splash\/image=/gu)).toHaveLength(1)
    expect(await readFile(join(project, 'export_presets.cfg'), 'utf8')).toBe('[preset.0]\n\nname="Web"\nplatform="Web"\n')
    const after = await readFile(join(project, 'project.godot'), 'utf8')
    expect(after).toContain('window/size/viewport_width=640')
    expect(after).not.toContain(EXPORT_SPLASH_PATH)
    expect(textureImports(after)).toEqual(textureImports(settings))
    expect(await exists(splashFile(project))).toBe(false)
    expect(await readdir(restoreDir)).toEqual([])
  })

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
    const exportEntry = log.find(entry => entry.preset !== undefined) as ExportEntry
    expect(exportEntry.preset).toBe(DESKTOP_EXPORT_PRESETS.macos)
    expect(exportEntry.presets).toContain('name="Linux"')
    expect(exportEntry.presets).toContain('application/bundle_identifier="com.wasdengine.game.fake-game"')
    expect(textureImports(exportEntry.project)).toEqual({ s3tc_bptc: 'true', etc2_astc: 'true' })
    // Godot packed WASD Engine's boot splash, which the export then took out of the project again.
    expect(wasdSplash(settings)).toBe('dark')
    expect(exportEntry.project).toContain(`boot_splash/image="${EXPORT_SPLASH_PATH}"`)
    expect(exportEntry.splashBytes).toBe(SPLASH.dark.length)
    expect(await exists(splashFile(project))).toBe(false)
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
    expect(after).not.toContain(EXPORT_SPLASH_PATH)
    expect(textureImports(after)).toEqual({ s3tc_bptc: 'false' })
    const exportEntry = (await fakeLog(project)).find(entry => entry.preset !== undefined) as { project: string }
    expect(textureImports(exportEntry.project)).toEqual({ s3tc_bptc: 'true' })
    expect(exportEntry.project).toContain(`boot_splash/image="${EXPORT_SPLASH_PATH}"`)
  })

  it('leaves project.godot untouched when it already imports what the platform needs and names its own boot splash', async () => {
    const { project, run } = await prepareDesktop('windows', { export: { files: { 'Fake game.zip': 'zip' } } }, async (dir) => {
      await setApplication(dir, 'boot_splash/image="res://studio.png"')
      const text = await readFile(join(dir, 'project.godot'), 'utf8')
      await writeFile(join(dir, 'project.godot'), `${text}\n[rendering]\n\ntextures/vram_compression/import_s3tc_bptc=true\n`)
      await writeFile(join(dir, 'studio.png'), 'studio')
    })
    const settings = await readFile(join(project, 'project.godot'), 'utf8')
    await run()
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(settings)
    const exportEntry = (await fakeLog(project)).find(entry => entry.preset !== undefined) as ExportEntry
    expect(exportEntry.project).toBe(settings)
    expect(exportEntry.splashBytes).toBe('studio'.length)
  })

  it('names WASD Engine\'s boot splash for a light splash color and none for a project that turns the image off', async () => {
    const light = await prepareDesktop('windows', { export: { files: { 'Fake game.zip': 'zip' } } }, dir => setApplication(dir, 'boot_splash/bg_color=Color(1, 1, 1, 1)'))
    await light.run()
    const lightEntry = (await fakeLog(light.project)).find(entry => entry.preset !== undefined) as { splashBytes: number | null }
    expect(lightEntry.splashBytes).toBe(SPLASH.light.length)
    const hidden = await prepareDesktop('windows', { export: { files: { 'Fake game.zip': 'zip' } } }, dir => setApplication(dir, 'boot_splash/show_image=false'))
    await hidden.run()
    const hiddenEntry = (await fakeLog(hidden.project)).find(entry => entry.preset !== undefined) as ExportEntry
    expect(hiddenEntry.project).not.toContain('boot_splash/image')
    expect(hiddenEntry.splashBytes).toBeNull()
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

describe('withMobilePreset', () => {
  it('packs the Android template for 64-bit ARM without Gradle, signed, with the package, version code, and internet', () => {
    const text = withMobilePreset(undefined, '/templates/android "release".apk', { platform: 'android', packageName: 'com.wasdengine.game.tiny_farm', versionCode: 29_914_733 })
    expect(text).toContain(`name="${MOBILE_EXPORT_PRESETS.android}"\nplatform="Android"`)
    for (const line of [
      'custom_template/debug="/templates/android \\"release\\".apk"', 'custom_template/release="/templates/android \\"release\\".apk"',
      'gradle_build/use_gradle_build=false', 'architectures/arm64-v8a=true', 'architectures/armeabi-v7a=false', 'architectures/x86_64=false',
      'version/code=29914733', 'package/unique_name="com.wasdengine.game.tiny_farm"', 'package/signed=true', 'permissions/internet=true',
    ]) expect(text.split('\n')).toContain(line)
    // The key reaches Godot through the environment, never through the presets file.
    expect(text).not.toMatch(/keystore/u)
  })

  it('writes the iOS Xcode project only, with the team and the bundle identifier', () => {
    const text = withMobilePreset('[preset.0]\n\nname="Web"\nplatform="Web"\n', '/templates/ios.zip', { platform: 'ios', bundleIdentifier: 'com.wasdengine.game.tiny-farm', teamId: 'ABCDE12345' })
    expect(text).toContain(`[preset.1]\n\nname="${MOBILE_EXPORT_PRESETS.ios}"\nplatform="iOS"`)
    for (const line of [
      'custom_template/release="/templates/ios.zip"', 'architectures/arm64=true', 'application/app_store_team_id="ABCDE12345"',
      'application/bundle_identifier="com.wasdengine.game.tiny-farm"', 'application/export_project_only=true',
    ]) expect(text.split('\n')).toContain(line)
  })

  it('counts Android version codes in minutes, so each build is newer than the last', () => {
    expect(androidVersionCode(new Date('2026-11-16T00:00:00Z'))).toBe(29_913_120)
    expect(androidVersionCode(new Date('2026-11-16T00:01:00Z'))).toBe(29_913_121)
  })
})

posix('exportMobile', () => {
  const ANDROID_ENV = {
    JAVA_HOME: '/jdk', ANDROID_HOME: '/sdk', GODOT_ANDROID_KEYSTORE_RELEASE_PATH: '/keys/release.keystore',
    GODOT_ANDROID_KEYSTORE_RELEASE_USER: 'release', GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD: 'secret',
  }

  async function prepareMobile(config: FakeGodotConfig, name = 'Fake game') {
    const dir = await scratch('export-mobile')
    folders.push(dir)
    const host = await subprocessFixture()
    hosts.push(host)
    const project = await writeProject(join(dir.root, 'game'), config, { name })
    const common = {
      subprocess: host.subprocess, runtime: { kind: 'libgodot' as const, runner: dir.fakeGodot, library: dir.fakeLibrary }, projectDir: project,
      hostPid: process.pid, timeoutMs: 5000, graceMs: 500, outputBytes: 64 * 1024, signal, restoreDir: join(dir.root, 'data', 'export-restore'),
    }
    return { project, common }
  }

  it('exports a signed APK named after the game with the environment it is given, then restores the project', async () => {
    const { project, common } = await prepareMobile({ export: { files: { 'Fake game.apk': 'apk!' } } })
    const settings = await readFile(join(project, 'project.godot'), 'utf8')
    const outputDir = join(project, '.wasdengine', 'mobile', 'android')
    const exported = await exportMobile({
      ...common, outputDir, platform: 'android', template: '/templates/android.apk', env: ANDROID_ENV,
      keystore: '/keys/release.keystore', keystoreCreated: true, now: new Date('2026-11-16T00:00:00Z'),
    })
    expect(exported).toEqual({
      projectDir: project, platform: 'android', outputDir, entry: 'Fake game.apk', bytes: 4, identifier: 'com.wasdengine.game.fake_game',
      signing: { keystore: '/keys/release.keystore', created: true }, warnings: [],
    })
    const log = await fakeLog(project)
    const exportEntry = log.find(entry => entry.preset !== undefined) as ExportEntry & { env: Record<string, string> }
    expect(exportEntry.preset).toBe(MOBILE_EXPORT_PRESETS.android)
    expect(exportEntry.env).toMatchObject(ANDROID_ENV)
    expect(exportEntry.presets).toContain('package/unique_name="com.wasdengine.game.fake_game"')
    expect(exportEntry.presets).toContain('version/code=29913120')
    // Godot exports for Android only with ETC2/ASTC imported, and the build shows WASD Engine's boot splash.
    expect(textureImports(exportEntry.project)).toEqual({ etc2_astc: 'true' })
    expect(exportEntry.splashBytes).toBe(SPLASH.dark.length)
    expect((log[0] as { argv: string[] }).argv.slice(3, 6)).toEqual(['--export-release', MOBILE_EXPORT_PRESETS.android, join(outputDir, 'Fake game.apk')])
    expect(await readFile(join(project, 'project.godot'), 'utf8')).toBe(settings)
    expect(await exists(join(project, 'export_presets.cfg'))).toBe(false)
  })

  it('exports an Xcode project that asks for the team when it has none, without Godot\'s stray splash warning', async () => {
    const pbxproj = ['\t\t\t\t\t\tDevelopmentTeam = WASDNOTEAM;', '\t\t\t\tDEVELOPMENT_TEAM = WASDNOTEAM;', '\t\t\t\tPRODUCT_NAME = Fakegame;', ''].join('\n')
    const plist = '<dict>\n    <key>method</key>\n    <string>app-store</string>\n\n    <key>teamID</key>\n    <string>WASDNOTEAM</string>\n</dict>\n'
    const { project, common } = await prepareMobile({
      export: {
        files: { 'Fakegame.xcodeproj/project.pbxproj': pbxproj, 'Fakegame/export_options.plist': plist, 'Fakegame.pck': 'pck' },
        stderr: `WARNING: ${IOS_SPLASH_SETTING_WARNING}\nWARNING: Icon is small.\n`,
      },
    })
    const outputDir = join(project, '.wasdengine', 'mobile', 'ios')
    const exported = await exportMobile({ ...common, outputDir, platform: 'ios', template: '/templates/ios.zip', appleTeamId: undefined })
    const pbxprojAfter = '\t\t\t\tPRODUCT_NAME = Fakegame;\n'
    const options = '<dict>\n    <key>method</key>\n    <string>app-store</string>\n</dict>\n'
    expect(await readFile(join(outputDir, 'Fakegame.xcodeproj', 'project.pbxproj'), 'utf8')).toBe(pbxprojAfter)
    expect(await readFile(join(outputDir, 'Fakegame', 'export_options.plist'), 'utf8')).toBe(options)
    // The size counts every file of the project, as the team's removal left them.
    expect(exported).toEqual({
      projectDir: project, platform: 'ios', outputDir, entry: 'Fakegame.xcodeproj', bytes: pbxprojAfter.length + options.length + 'pck'.length,
      identifier: 'com.wasdengine.game.fake-game', warnings: ['Icon is small.'],
    })
    const exportEntry = (await fakeLog(project)).find(entry => entry.preset !== undefined) as ExportEntry
    expect(exportEntry.presets).toContain(`application/app_store_team_id="${UNSET_TEAM_ID}"`)
    expect(textureImports(exportEntry.project)).toEqual({ etc2_astc: 'true' })
  })

  it('signs the Xcode project for the team it is given', async () => {
    const pbxproj = '\t\t\t\tDEVELOPMENT_TEAM = ABCDE12345;\n'
    const { project, common } = await prepareMobile({ export: { files: { 'Fakegame.xcodeproj/project.pbxproj': pbxproj } } })
    const outputDir = join(project, '.wasdengine', 'mobile', 'ios')
    const exported = await exportMobile({ ...common, outputDir, platform: 'ios', template: '/templates/ios.zip', appleTeamId: 'ABCDE12345' })
    expect(exported.appleTeamId).toBe('ABCDE12345')
    const exportEntry = (await fakeLog(project)).find(entry => entry.preset !== undefined) as ExportEntry
    expect(exportEntry.presets).toContain('application/app_store_team_id="ABCDE12345"')
    expect(await readFile(join(outputDir, 'Fakegame.xcodeproj', 'project.pbxproj'), 'utf8')).toBe(pbxproj)
  })

  it('reports Godot\'s errors when the export writes no APK file', async () => {
    const stderr = [
      'ERROR: Cannot export project with preset "WASD Engine Android" due to configuration errors:',
      'A valid Java SDK path is required in Editor Settings.', '', '   at: _fs_changed (editor/editor_node.cpp:1234)', 'WARNING: Unrelated.', '',
    ].join('\n')
    const { project, common } = await prepareMobile({ export: { files: {}, stderr } })
    const failure = exportMobile({
      ...common, outputDir: join(project, '.wasdengine', 'mobile', 'android'), platform: 'android', template: '/templates/android.apk', env: ANDROID_ENV,
      keystore: '/keys/release.keystore', keystoreCreated: false, now: new Date(),
    })
    await expect(failure).rejects.toBeInstanceOf(GodotExportError)
    const message = (await failure.catch((error: unknown) => error) as Error).message
    expect(message).toMatch(/^The Godot Android export ended \(.*\) without writing Fake game\.apk\.\nLast output:\n/u)
    // Godot's reasons follow its error line, which the message keeps with them, and nothing after the message's end.
    expect(message.split('\nLast output:\n')[1]).toBe(stderr.split('\n').slice(0, 2).join('\n'))
  })
})
