/**
 * Every add-on of the shipped catalog, end to end: the manager downloads its pinned archive, installs it into a fresh
 * Godot project and imports the project with the LibGodot runtime, or unpacks it into the Blender add-on store; every
 * script of a Godot add-on passes `godot_check`'s script loader in the order that a whole-project check uses and in the
 * reverse one; then the add-on's smoke test runs on Godot 4.7.2 (headless, or rendering without a window, after its
 * prepare script between two imports of its files when it has one) or in a real
 * Blender worker after `wasd_addons.enable`, and a removal takes the add-on's plugin, autoloads, and settings out of
 * `project.godot` again (Godot rewrites the file when an editor plugin saves project settings during the import, so its
 * bytes may differ).
 * Godot add-ons need `WASD_LIBGODOT_DIR`, an installed runtime folder; Blender add-ons need uv's cached bpy 5.2.3; the
 * archives download from their pinned URLs, into `WASD_ADDON_ARCHIVES` when it is set so that later runs reuse them.
 */
import { spawn, spawnSync } from 'node:child_process'
import { cp, link, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { JsonLineWorker } from '@deepseek-ai/dsh-app-mcp'
import { ADDON_STORE_VARIABLE, childEnvironment, findUv, nodeBlenderSetupHost } from '@deepseek-ai/dsh-blender/src/environment.ts'
import { CHECK_SCRIPT_LIMIT } from '@deepseek-ai/dsh-godot/src/check.ts'
import { parseEngineOutput } from '@deepseek-ai/dsh-godot/src/output.ts'
import { listProjectFiles, toResPath } from '@deepseek-ai/dsh-godot/src/project.ts'
import { parseGodotJson } from '@deepseek-ai/dsh-godot/src/protocol.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { loadCatalog } from '../src/catalog.ts'
import { GameAddonManager, type ImportReport } from '../src/manager.ts'
import { NOTICES_FILE } from '../src/notices.ts'
import { ProjectFile } from '../src/project-file.ts'
import type { GameAddon } from '../src/types.ts'
import { CATALOG_DIR, SMOKE_DIR, SmokeSpec } from './shipped-catalog.ts'

const runtimeDir = process.env.WASD_LIBGODOT_DIR
const library = runtimeDir === undefined ? undefined : join(runtimeDir, `libgodot.macos.editor.${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.dylib`)
const runner = runtimeDir === undefined ? undefined : join(runtimeDir, 'godot_runner')
const godotReady = process.platform === 'darwin' && runner !== undefined && library !== undefined && existsSync(runner) && existsSync(library)

const WORKER = fileURLToPath(new URL('../../blender/py/wasd_blender_worker.py', import.meta.url))
const CHECK_SCRIPT = fileURLToPath(new URL('../../godot/runtime/wasd_check.gd', import.meta.url))
const uv = await findUv({ uvPath: '' }, nodeBlenderSetupHost(64 * 1024))
const uvRun = (uvPath: string): string[] => [uvPath, 'run', '--offline', '--python', '3.13', '--no-project', '--with', 'bpy==5.2.3', 'python', '-I']
const bpyReady = uv !== undefined && spawnSync(uv, [...uvRun(uv).slice(1), '-c', 'import bpy'], { stdio: 'ignore', timeout: 300_000 }).status === 0

const TEMPLATE = 'config_version=5\n\n[application]\n\nconfig/name="Add-on smoke"\nconfig/features=PackedStringArray("4.7")\n'

const catalog = await loadCatalog(CATALOG_DIR)
const root = await mkdtemp(join(tmpdir(), 'dsh-game-addons-e2e-'))
const shared = process.env.WASD_ADDON_ARCHIVES
const archives = join(root, 'archives')
const store = join(root, 'store')
// The manager removes a Blender archive from its cache once the store holds it, so the run reads hard links to the
// shared archives and leaves the shared folder with every archive it downloaded.
await mkdir(archives)
if (shared !== undefined) {
  await mkdir(shared, { recursive: true })
  for (const name of await readdir(shared)) if (name.endsWith('.zip')) await link(join(shared, name), join(archives, name))
}

afterAll(async () => {
  if (shared !== undefined) {
    const known = new Set(await readdir(shared))
    for (const name of await readdir(archives)) if (name.endsWith('.zip') && !known.has(name)) await link(join(archives, name), join(shared, name))
  }
  await rm(root, { recursive: true, force: true })
})

/** The output and exit of one runner process. */
interface Ran {
  readonly code: number | null
  readonly output: string
}

/** Run the LibGodot runner with Godot arguments, ending it after `timeoutMs`. */
function godot(args: readonly string[], cwd: string, timeoutMs: number): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(runner as string, ['--libgodot', library as string, '--parent-pid', String(process.pid), '--', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, output })
    })
  })
}

/** The import step as the Godot plugin runs it, reporting script errors and errors. */
async function importProject(projectDir: string): Promise<ImportReport> {
  const ran = await godot(['--headless', '--path', projectDir, '--import'], projectDir, 180_000)
  const issues = parseEngineOutput(ran.output, 'stdout', false)
    .filter(line => line.level === 'error' || line.level === 'script_error' || line.level === 'shader_error')
    .map(line => `${line.file ?? ''}${line.line === undefined ? '' : `:${line.line}`}: ${line.message}`)
  return { issues }
}

/**
 * Load scripts with `godot_check`'s script loader.
 * @returns each script that logged an error, with its first error.
 */
async function checkErrors(projectDir: string, paths: readonly string[]): Promise<string[]> {
  const ran = await godot(['--headless', '--path', projectDir, '--script', CHECK_SCRIPT, '--', ...paths], projectDir, 300_000)
  const reports = ran.output.split('\n').filter(line => line.startsWith('WASD_CHECK '))
    .map(line => parseGodotJson(line.slice('WASD_CHECK '.length)) as { path: string; errors: { level: string; message: string }[] })
  expect(reports.map(report => report.path), `checked scripts\n${ran.output.slice(-2000)}`).toEqual(paths)
  return reports.flatMap(report => report.errors.filter(error => error.level !== 'warning').slice(0, 1).map(error => `${report.path}: ${error.message}`))
}

function manager(): GameAddonManager {
  return new GameAddonManager({
    catalog,
    downloads: { cacheDir: archives, fetch: (url, signal) => fetch(url, { signal, headers: { 'User-Agent': 'WASD Engine' } }) },
    blenderStore: store,
    assetsDir: join(root, 'assets'),
    importProject: projectDir => importProject(projectDir),
    now: () => new Date(),
    changed: () => {},
  })
}

const signal = new AbortController().signal

/** Whether `project.godot` enables an add-on as its entry says. */
async function enabled(project: string, entry: GameAddon): Promise<{ plugin: boolean; autoloads: boolean[]; settings: boolean[] }> {
  const file = new ProjectFile(await readFile(join(project, 'project.godot'), 'utf8'))
  const godot = entry.godot as NonNullable<GameAddon['godot']>
  return {
    plugin: godot.plugin === undefined ? false : file.editorPlugins().includes(`res://addons/${godot.addonDir}/${godot.plugin}`),
    autoloads: (godot.autoloads ?? []).map(autoload => file.autoload(autoload.name) === autoload.path),
    settings: (godot.settings ?? []).map(setting => file.get(setting.section, setting.key) !== undefined),
  }
}

describe('the shipped catalog on Godot 4.7.2', () => {
  for (const entry of catalog.entries.filter(addon => addon.host === 'godot')) {
    it.skipIf(!godotReady)(`${entry.id} installs, imports, passes its smoke test, and leaves no trace when removed`, async () => {
      const spec = SmokeSpec.parse(JSON.parse(await readFile(join(SMOKE_DIR, entry.id, 'smoke.json'), 'utf8')))
      const project = await mkdtemp(join(root, `${entry.id}-`))
      await writeFile(join(project, 'project.godot'), TEMPLATE)
      const addons = manager()
      const installed = await addons.install(project, entry.id, {}, signal)
      const addonFolder = `res://addons/${entry.godot?.addonDir ?? ''}/`
      expect(installed.importIssues.filter(issue => issue.startsWith(addonFolder)), `${entry.id} import errors in its own files`).toEqual([])
      expect(await enabled(project, entry), `${entry.id} enabled in project.godot`).toEqual({
        plugin: entry.godot?.plugin !== undefined,
        autoloads: (entry.godot?.autoloads ?? []).map(() => true),
        settings: (entry.godot?.settings ?? []).map(() => true),
      })
      const scripts = (await listProjectFiles(project, '.gd', CHECK_SCRIPT_LIMIT, signal)).files.map(file => toResPath(project, file))
      for (const order of [scripts, [...scripts].reverse()]) expect(await checkErrors(project, order), `${entry.id} godot_check errors`).toEqual([])
      await cp(join(SMOKE_DIR, spec.files ?? entry.id, 'files'), project, { recursive: true })
      const timeoutMs = spec.timeoutSeconds * 1000
      if (spec.prepare !== undefined) {
        await importProject(project)
        const prepared = await godot(['--headless', '--path', project, '--script', spec.prepare.path, '--', ...spec.prepare.args], project, timeoutMs)
        expect(prepared.output, `${entry.id} prepare output`).not.toMatch(/SCRIPT ERROR|_FAILED /u)
      }
      const passes = spec.importTwice === true || entry.godot?.importTwice === true ? 2 : 1
      for (let pass = 0; pass < passes; pass += 1) await importProject(project)
      const ran = spec.run === 'script'
        ? await godot(['--headless', '--path', project, '--script', spec.path, ...spec.args === undefined || spec.args.length === 0 ? [] : ['--', ...spec.args]], project, timeoutMs)
        : spec.run === 'render'
          ? await godot(['--path', project, '--embedded', '--resolution', '640x360', spec.path], project, timeoutMs)
          : await godot(['--headless', '--path', project, spec.path], project, timeoutMs)
      for (const marker of spec.expect) expect(ran.output, `${entry.id} output`).toContain(marker)
      expect(ran.output, `${entry.id} output`).not.toContain('SMOKE_FAIL')
      expect(ran.code, `${entry.id} exit code\n${ran.output.slice(-2000)}`).toBe(spec.exitCode ?? 0)
      const removed = await addons.remove(project, entry.id, signal)
      expect(removed.removed).toEqual([`addons/${entry.godot?.addonDir ?? ''}`])
      expect(await enabled(project, entry), `${entry.id} project.godot after removal`).toEqual({
        plugin: false,
        autoloads: (entry.godot?.autoloads ?? []).map(() => false),
        settings: (entry.godot?.settings ?? []).map(() => false),
      })
      expect(existsSync(join(project, NOTICES_FILE)), `${entry.id} notices after removal`).toBe(false)
    }, 600_000)
  }
})

const blenderAddons = catalog.entries.filter(addon => addon.host === 'blender')

describe.runIf(blenderAddons.length > 0)('the shipped catalog on bpy 5.2.3', () => {
  for (const entry of blenderAddons) {
    it.skipIf(!bpyReady)(`${entry.id} installs into the store, enables in a Blender worker, passes its smoke test, and stays enabled after new_scene`, async () => {
      const spec = SmokeSpec.parse(JSON.parse(await readFile(join(SMOKE_DIR, entry.id, 'smoke.json'), 'utf8')))
      const project = await mkdtemp(join(root, `${entry.id}-`))
      await writeFile(join(project, 'project.godot'), TEMPLATE)
      await manager().install(project, entry.id, {}, signal)
      const smoke = await readFile(join(SMOKE_DIR, entry.id, spec.path), 'utf8')
      // As the Host does, the worker keeps Blender's user resources in a folder of its own.
      const userResources = join(project, '.blender-user')
      await mkdir(userResources)
      const worker = await JsonLineWorker.start({
        argv: [...uvRun(uv as string), WORKER],
        cwd: project,
        env: { ...childEnvironment(process.env), [ADDON_STORE_VARIABLE]: store, BLENDER_USER_RESOURCES: userResources },
        readyTimeoutMs: 120_000,
        logTailBytes: 64 * 1024,
      })
      const timeoutMs = spec.timeoutSeconds * 1000
      const python = async (code: string): Promise<{ result?: JsonValue; output?: string; error?: unknown }> =>
        await worker.request('execute_python', { code }, { timeoutMs: timeoutMs + 30_000 }) as never
      try {
        expect(await python(`import wasd_addons\nresult = wasd_addons.enable(${JSON.stringify(entry.id)})`), `${entry.id} enable`).not.toHaveProperty('error')
        const first = await python(smoke)
        expect(first.error, `${entry.id} smoke error`).toBeUndefined()
        for (const marker of spec.expect) expect(first.output ?? '', `${entry.id} smoke output`).toContain(marker)
        await worker.request('new_scene', { empty: true }, { timeoutMs: 120_000 })
        expect(await python('result = wasd_addons.enabled()')).toMatchObject({ result: [entry.id] })
      } finally {
        await worker.close(3000)
      }
    }, 900_000)
  }
})
