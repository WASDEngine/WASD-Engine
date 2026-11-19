/**
 * The Add-ons dialog's switches through a profile that the Loader boots with the real Settings service and configuration
 * editor: `setAllowed` saves the switch in the profile patch without remounting the plugin, the prompt section, the
 * catalog that other plugins name, the dialog's view, and the Blender workers' index follow it, and a restart keeps it.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, vi } from 'vitest'
import GameAddons, { STORE_INDEX } from '../src/index.ts'
import { PROMPT_SECTION } from '../src/prompt.ts'
import { writeCatalog, writeProject } from './fixtures.ts'

/** The Session working directory the plugin's tool would start from; this spec calls no tool. */
class FixedWorkingDirectory extends Service {
  constructor(ctx: Context) { super(ctx, 'workingDirectory') }
  ensure(): Promise<string> { return Promise.resolve(tmpdir()) }
}

it('saves a switch without remounting the plugin, applies it at once, and keeps it after a restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-game-addons-switches-')))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const catalogDir = await writeCatalog(home)
    const project = await writeProject(join(home, 'work', 'game'))
    const dataRoot = join(home, 'data')
    const store = join(dataRoot, 'blender')
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), [
      '- insert:',
      ...['config-editor:editor', 'settings:settings', 'system-prompt:prompt', 'tools:tools', 'tool-executor:executor', 'skills:skills', 'typert:typert', 'working-directory:workdir']
        .flatMap((row) => { const [id, name] = row.split(':'); return [`    - id: ${id}`, `      name: cordis:${name}`] }),
      '    - id: game-addons',
      '      name: cordis:addons',
      '      config:',
      `        catalogDir: ${JSON.stringify(catalogDir)}`,
      `        dataRoot: ${JSON.stringify(dataRoot)}`,
      `        blenderStore: ${JSON.stringify(store)}`,
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, {
        editor: ConfigEditor, settings: Settings, prompt: SystemPrompt, tools: ToolRuntime, executor: NativeToolExecutor,
        skills: SkillRegistry, typert: TypertRegistry, workdir: FixedWorkingDirectory, addons: GameAddons,
      })
    })
    const section = async (context: Context): Promise<string | undefined> =>
      (await context.systemPrompt.assemble()).sections.find(item => item.name === PROMPT_SECTION)?.text
    const indexed = async (): Promise<unknown> => (JSON.parse(await readFile(join(store, STORE_INDEX), 'utf8')) as { addons: Record<string, unknown> }).addons['test-rig']

    ctx = await start()
    const addons = ctx.get('gameAddons')!
    expect(addons.allowedEntries().map(entry => entry.id)).toEqual(['other-camera', 'test-camera', 'test-rig', 'test-trees'])
    expect(await section(ctx)).toContain('- test-camera (Godot;')
    const entry = ctx.configEditor.entries().find(row => row.options.id === 'game-addons')!
    const fiber = entry.fiber

    await addons.setAllowed('test-camera', false)
    await addons.setAllowed('test-rig', false)
    expect(entry.fiber === fiber).toBe(true)
    expect(addons.allowedEntries().map(item => item.id)).toEqual(['other-camera', 'test-trees'])
    expect(await section(ctx)).not.toContain('test-camera')
    expect((await addons.project(project, new AbortController().signal)).addons.map(addon => [addon.id, addon.allowed])).toEqual([
      ['other-camera', true], ['test-camera', false], ['test-rig', false], ['test-trees', true],
    ])
    await vi.waitFor(async () => { expect(await indexed()).toMatchObject({ allowed: false }) })
    expect(readFileSync(profile.patchPath, 'utf8')).toMatch(/allowed:\n\s+test-camera: false\n\s+test-rig: false\n/u)

    await addons.setAllowed('test-rig', true)
    expect(addons.allowedEntries().map(item => item.id)).toEqual(['other-camera', 'test-rig', 'test-trees'])
    await vi.waitFor(async () => { expect(await indexed()).not.toHaveProperty('allowed') })

    await ctx.fiber.dispose()
    ctx = await start()
    expect(ctx.get('gameAddons')!.allowedEntries().map(item => item.id)).toEqual(['other-camera', 'test-rig', 'test-trees'])
    expect(await section(ctx)).not.toContain('test-camera')
  } finally {
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
})
