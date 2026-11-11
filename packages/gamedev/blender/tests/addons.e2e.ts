/**
 * The worker's `wasd_addons` module against a real bpy: it enables an extension from the game add-on store and an add-on
 * that ships inside Blender, runs an add-on's setup script with its asset folder, names what it enabled, enables them
 * and runs the setup again after `new_scene` or executed code loaded factory settings, keeps Blender's user resources in
 * the folder the Host names, and explains an add-on it cannot enable. Runs with uv's cached bpy 5.2.3 and skips without
 * it.
 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JsonLineWorker } from '@deepseek-ai/dsh-app-mcp'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { ADDON_STORE_VARIABLE, childEnvironment, findUv, nodeBlenderSetupHost } from '../src/environment.ts'

const WORKER = fileURLToPath(new URL('../py/wasd_blender_worker.py', import.meta.url))
const uv = await findUv({ uvPath: '' }, nodeBlenderSetupHost(64 * 1024))
const uvRun = (uvPath: string): string[] => [uvPath, 'run', '--offline', '--python', '3.13', '--no-project', '--with', 'bpy==5.2.3', 'python', '-I']
const bpyCached = uv !== undefined && spawnSync(uv, [...uvRun(uv).slice(1), '-c', 'import bpy'], { stdio: 'ignore', timeout: 300_000 }).status === 0

const MANIFEST = 'schema_version = "1.0.0"\nid = "probe_ext"\nversion = "1.0.0"\nname = "Probe"\ntagline = "Probe extension"\nmaintainer = "Test"\ntype = "add-on"\nblender_version_min = "4.2.0"\nlicense = ["SPDX:GPL-3.0-or-later"]\n'
const INIT = [
  'import bpy',
  'class PROBE_OT_mark(bpy.types.Operator):',
  '    bl_idname = "probe.mark"',
  '    bl_label = "Mark"',
  '    def execute(self, context):',
  '        context.scene["probe"] = 42',
  '        return {"FINISHED"}',
  'def register():',
  '    bpy.utils.register_class(PROBE_OT_mark)',
  'def unregister():',
  '    bpy.utils.unregister_class(PROBE_OT_mark)',
  '',
].join('\n')

describe.skipIf(!bpyCached)('wasd_addons in the Blender worker', () => {
  let root = ''
  let store = ''
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-blender-addons-'))
    store = join(root, 'store')
    await mkdir(join(store, 'probe_ext'), { recursive: true })
    await writeFile(join(store, 'probe_ext', 'blender_manifest.toml'), MANIFEST)
    await writeFile(join(store, 'probe_ext', '__init__.py'), INIT)
    await mkdir(join(store, 'missing_ext'), { recursive: true })
    await mkdir(join(root, 'assets', 'probe-ext'), { recursive: true })
    await writeFile(join(root, 'assets', 'probe-ext', '.wasd-addon.json'), '{}\n')
    await writeFile(join(root, 'setup.py'), [
      'import os',
      'def setup(module, assets):',
      '    with open(os.path.join(os.path.dirname(assets), "calls.txt"), "a", encoding="utf-8") as calls:',
      '        calls.write(module + " " + assets + "\\n")',
      '',
    ].join('\n'))
    const setup = join(root, 'setup.py')
    await writeFile(join(store, 'catalog.json'), JSON.stringify({
      format: 1,
      addons: {
        'probe-ext': { module: 'probe_ext', kind: 'extension', version: '1.0.0', setup, assets: join(root, 'assets', 'probe-ext') },
        'rigify': { module: 'rigify', kind: 'core', version: '5.2.3' },
        'missing-ext': { module: 'missing_ext', kind: 'extension', version: '1.0.0' },
        'lost-assets': { module: 'rigify', kind: 'core', version: '5.2.3', setup, assets: join(root, 'assets', 'nowhere') },
      },
    }))
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  it('enables store extensions and core add-ons by id, and again after factory settings', async () => {
    const userResources = join(root, 'blender-user')
    await mkdir(userResources, { recursive: true })
    const worker = await JsonLineWorker.start({
      argv: [...uvRun(uv as string), WORKER],
      cwd: root,
      env: { ...childEnvironment(process.env), [ADDON_STORE_VARIABLE]: store, BLENDER_USER_RESOURCES: userResources },
      readyTimeoutMs: 120_000,
      logTailBytes: 64 * 1024,
    })
    const python = async (code: string): Promise<JsonValue> => await worker.request('execute_python', { code }, { timeoutMs: 120_000 })
    try {
      await expect(python('import wasd_addons\nresult = [wasd_addons.enable("probe-ext"), wasd_addons.enable("rigify"), wasd_addons.enable("probe_ext")]'))
        .resolves.toMatchObject({ result: ['bl_ext.wasd.probe_ext', 'rigify', 'bl_ext.wasd.probe_ext'] })
      await expect(python('bpy.ops.probe.mark()\nresult = [bpy.context.scene["probe"], hasattr(bpy.ops.pose, "rigify_generate"), wasd_addons.enabled()]'))
        .resolves.toMatchObject({ result: [42, true, ['probe-ext', 'rigify']] })
      const assets = join(root, 'assets', 'probe-ext')
      await expect(python('result = wasd_addons.assets("probe-ext")')).resolves.toMatchObject({ result: assets })
      const calls = async (): Promise<string[]> => (await readFile(join(root, 'assets', 'calls.txt'), 'utf8')).trim().split('\n')
      expect(await calls()).toEqual([`bl_ext.wasd.probe_ext ${assets}`])
      await worker.request('new_scene', { empty: true }, { timeoutMs: 120_000 })
      await expect(python('bpy.ops.probe.mark()\nresult = [bpy.context.scene["probe"], "rigify" in bpy.context.preferences.addons, wasd_addons.enabled()]'))
        .resolves.toMatchObject({ result: [42, true, ['probe-ext', 'rigify']] })
      expect(await calls()).toHaveLength(2)
      await python('bpy.ops.wm.read_factory_settings(use_empty=True)')
      expect(await calls()).toHaveLength(3)
      await expect(python('bpy.ops.probe.mark()\nresult = [bpy.context.scene["probe"], "rigify" in bpy.context.preferences.addons, wasd_addons.enabled()]'))
        .resolves.toMatchObject({ result: [42, true, ['probe-ext', 'rigify']] })
      await expect(python('result = bpy.utils.resource_path("USER")')).resolves.toMatchObject({ result: userResources })
      await expect(python('wasd_addons.enable("missing-ext")')).resolves.toMatchObject({ error: { type: 'AddonError', message: expect.stringContaining('missing-ext is not downloaded yet') as string } })
      await expect(python('wasd_addons.enable("nope")'))
        .resolves.toMatchObject({ error: { type: 'AddonError', message: expect.stringContaining('the catalog has lost-assets, missing-ext, probe-ext, rigify') as string } })
      await expect(python('wasd_addons.enable("lost-assets")'))
        .resolves.toMatchObject({ error: { type: 'AddonError', message: expect.stringContaining('The asset pack of lost-assets is not downloaded yet') as string } })
      await expect(python('wasd_addons.assets("rigify")')).resolves.toMatchObject({ error: { type: 'AddonError', message: 'rigify has no asset pack.' } })
    } finally {
      await worker.close(3000)
    }
  }, 300_000)

  it('explains that a worker without a store has no add-ons', async () => {
    const worker = await JsonLineWorker.start({
      argv: [...uvRun(uv as string), WORKER],
      cwd: root,
      env: childEnvironment(process.env),
      readyTimeoutMs: 120_000,
      logTailBytes: 64 * 1024,
    })
    try {
      await expect(worker.request('execute_python', { code: 'import wasd_addons\nwasd_addons.enable("rigify")' }, { timeoutMs: 120_000 }))
        .resolves.toMatchObject({ error: { type: 'AddonError', message: expect.stringContaining('no game add-on store') as string } })
    } finally {
      await worker.close(3000)
    }
  }, 300_000)
})
