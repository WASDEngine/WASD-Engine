/** The add-on guides as skills: listed only for projects that have the add-on, and refreshed when that changes. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { SkillCandidate, SkillProviderObservation } from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { GameAddonManager } from '../src/manager.ts'
import { updateRecord } from '../src/record.ts'
import { ADDON_SKILL_RANK, gameAddonSkillProvider, SKILL_PROVIDER_NAME } from '../src/skills.ts'
import { fakeDownloads, scratch, writeCatalog, writeProject, type Scratch } from './fixtures.ts'

let dir: Scratch | undefined
const controllers: AbortController[] = []

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort()
  await dir?.cleanup()
  dir = undefined
})

const signal = new AbortController().signal

/** The candidates of a provider's answer, whether it is the plain array or an observation. */
function candidatesOf(listed: readonly SkillCandidate[] | SkillProviderObservation): readonly SkillCandidate[] {
  return 'candidates' in listed ? listed.candidates : listed
}

async function setup() {
  dir = await scratch('skills')
  const catalog = await loadCatalog(await writeCatalog(dir.root))
  const project = await writeProject(join(dir.root, 'game'))
  const manager = new GameAddonManager({
    catalog,
    downloads: { cacheDir: join(dir.root, 'archives'), fetch: fakeDownloads().fetch },
    blenderStore: join(dir.root, 'store'),
    assetsDir: join(dir.root, 'assets'),
    importProject: () => Promise.resolve({ issues: [] }),
    now: () => new Date('2026-11-11T12:00:00Z'),
    changed: () => {},
  })
  const controller = new AbortController()
  controllers.push(controller)
  const invalidate = vi.fn()
  const root = dir.root
  const findProject = (cwd: string) => Promise.resolve(relative(project, cwd).startsWith('..') && cwd !== root ? undefined : project)
  const { provider } = gameAddonSkillProvider(manager, findProject, { signal: controller.signal, invalidate })
  return { manager, project, provider, invalidate, controller }
}

describe('gameAddonSkillProvider', () => {
  it('lists no guide for a project without add-ons, and each installed or found add-on\'s guide after that', async () => {
    const { manager, project, provider } = await setup()
    expect(provider.name).toBe(SKILL_PROVIDER_NAME)
    expect(await provider.list({ cwd: project })).toEqual([])
    expect(await provider.list({})).toEqual([])
    expect(await provider.list({ cwd: '/elsewhere' })).toEqual([])
    await manager.install(project, 'test-camera', {}, signal)
    await mkdir(join(project, 'addons', 'other_camera'), { recursive: true })
    await writeFile(join(project, 'addons', 'other_camera', 'plugin.cfg'), '[plugin]\nversion="0.0.9"\n')
    const listed = await provider.list({ cwd: join(project, 'scenes') })
    expect(candidatesOf(listed).map(skill => [skill.name, skill.description, skill.rank, skill.source])).toEqual([
      ['other-camera', 'other-camera is installed in this project. Load before using it. This project\'s own copy is version 0.0.9, not 0.1; check names against its source.', ADDON_SKILL_RANK, 'game-addon'],
      ['test-camera', 'test-camera is installed in this project. Load before using it.', ADDON_SKILL_RANK, 'game-addon'],
    ])
    const camera = candidatesOf(listed).find(skill => skill.name === 'test-camera')!
    expect(camera.resourceBase).toEqual({ kind: 'directory', path: manager.catalog.folder('test-camera') })
    expect(camera.invocation).toEqual({ modelInvocable: true, userInvocable: true })
    const loaded = await provider.get(camera, { cwd: project })
    expect(loaded).toMatchObject({ name: 'test-camera', provider: SKILL_PROVIDER_NAME, content: '\n# test-camera\n\nUse it like this.\n' })
  })

  it('asks for a refresh when the project\'s record or addons folder changes outside the tools', async () => {
    const { project, provider, invalidate } = await setup()
    await provider.list({ cwd: project })
    expect(invalidate).not.toHaveBeenCalled()
    await updateRecord(project, () => [{ id: 'test-rig', title: 'Test Rig', host: 'blender', version: '5.2.3', license: 'GPL-2.0-or-later', paths: [], installedAt: 'now' }], signal)
    await vi.waitFor(() => { expect(invalidate).toHaveBeenCalled() }, { timeout: 5000 })
    invalidate.mockClear()
    await mkdir(join(project, 'addons', 'test_camera'), { recursive: true })
    await vi.waitFor(() => { expect(invalidate).toHaveBeenCalled() }, { timeout: 5000 })
    const relisted = await provider.list({ cwd: project })
    expect(candidatesOf(relisted).map(skill => skill.name)).toEqual(['test-camera', 'test-rig'])
  })
})
