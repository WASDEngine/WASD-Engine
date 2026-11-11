/**
 * The usage guides of a project's add-ons as skills. For a Session's working directory the provider finds the game
 * project as the Godot tools do, and lists the guide of each catalog add-on the project has installed or holds in its
 * `addons` folder; every other guide stays out of the model's skill catalog. A watcher on the project's `addons` and
 * `.wasdengine` folders, plus the manager's own change calls, make the next model step see an add-on that arrived or
 * left.
 * @module @deepseek-ai/dsh-game-addons/src/skills
 */
import { watch, type FSWatcher } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import { GUIDE_FILE, parseGuide } from './catalog.ts'
import type { GameAddonManager } from './manager.ts'
import { STATE_DIR } from './record.ts'

/** Provider name in the skill registry. */
export const SKILL_PROVIDER_NAME = 'game-addons'

/** Rank of an add-on guide: project, custom, and user skills of the same name win; bundled skills lose. */
export const ADDON_SKILL_RANK = 550

/** Skill source of an add-on guide. */
export const ADDON_SKILL_SOURCE = 'game-addon'

/** Most projects whose folders the provider watches at once. */
const WATCHED_PROJECTS = 16

/** Delay that folds a burst of file events into one catalog refresh. */
const SETTLE_MS = 200

/** What the provider stores for one listed guide. */
interface GuideLocator {
  readonly id: string
  readonly projectDir: string
}

/**
 * Watches the folders whose changes change a project's add-ons, and asks for one catalog refresh per burst of events.
 */
export class ProjectWatcher {
  private readonly projects = new Map<string, FSWatcher[]>()
  private timer: NodeJS.Timeout | undefined

  /**
   * @param refresh - called once after events settle.
   */
  constructor(private readonly refresh: () => void) {}

  /**
   * Watch a project, forgetting the least recently listed one beyond {@link WATCHED_PROJECTS}.
   * @param projectDir - absolute project folder.
   */
  watch(projectDir: string): void {
    const existing = this.projects.get(projectDir)
    if (existing !== undefined) {
      this.projects.delete(projectDir)
      this.projects.set(projectDir, existing)
      return
    }
    const watchers: FSWatcher[] = []
    // The project folder itself shows `addons` or `.wasdengine` appearing; each of them shows its own entries.
    for (const folder of [projectDir, join(projectDir, 'addons'), join(projectDir, STATE_DIR)]) {
      try {
        const watcher = watch(folder, { persistent: false }, (_event, name) => {
          if (folder === projectDir && name !== 'addons' && name !== STATE_DIR) return
          if (folder === join(projectDir, STATE_DIR) && name !== 'addons.json') return
          if (folder === projectDir) this.rearm(projectDir)
          this.schedule()
        })
        watcher.on('error', () => { this.forget(projectDir) })
        watchers.push(watcher)
      } catch (error) {
        // A folder that does not exist yet is seen through its parent's events.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    this.projects.set(projectDir, watchers)
    while (this.projects.size > WATCHED_PROJECTS) {
      const oldest = this.projects.keys().next().value as string
      this.forget(oldest)
    }
  }

  /** Stop every watcher. */
  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    for (const projectDir of [...this.projects.keys()]) this.forget(projectDir)
  }

  private rearm(projectDir: string): void {
    this.forget(projectDir)
    this.watch(projectDir)
  }

  private forget(projectDir: string): void {
    for (const watcher of this.projects.get(projectDir) ?? []) watcher.close()
    this.projects.delete(projectDir)
  }

  private schedule(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.refresh()
    }, SETTLE_MS)
    this.timer.unref()
  }
}

/**
 * The skill provider of add-on guides.
 * @param manager - the add-on manager whose catalog and projects it reads.
 * @param findProject - the Godot project of a working directory, as the Godot tools resolve it, or undefined.
 * @param control - the registration's lifetime and invalidation.
 * @returns the provider and the watcher it uses, which the caller disposes with the registration.
 */
export function gameAddonSkillProvider(
  manager: GameAddonManager,
  findProject: (cwd: string, signal: AbortSignal | undefined) => Promise<string | undefined>,
  control: SkillProviderControl,
): { readonly provider: SkillProvider; readonly watcher: ProjectWatcher } {
  const watcher = new ProjectWatcher(() => { control.invalidate() })
  control.signal.addEventListener('abort', () => { watcher.dispose() }, { once: true })
  const provider: SkillProvider = {
    name: SKILL_PROVIDER_NAME,
    async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      if (options.cwd === undefined) return []
      const projectDir = await findProject(options.cwd, options.signal)
      if (projectDir === undefined) return []
      watcher.watch(projectDir)
      const presence = await manager.presence(projectDir)
      const candidates: SkillCandidate[] = []
      for (const addon of manager.catalog.entries) {
        const state = presence.get(addon.id)
        const header = manager.catalog.guide(addon.id)
        if (state === undefined || state.state === 'absent' || header === undefined) continue
        const folder = manager.catalog.folder(addon.id)
        const other = state.state === 'found' && state.version !== undefined && state.version !== addon.version
          ? ` This project's own copy is version ${state.version}, not ${addon.version}; check names against its source.`
          : ''
        const locator: GuideLocator = { id: addon.id, projectDir }
        candidates.push({
          name: addon.id,
          description: `${header.description}${other}`,
          invocation: { modelInvocable: true, userInvocable: true },
          source: ADDON_SKILL_SOURCE,
          provider: SKILL_PROVIDER_NAME,
          rank: ADDON_SKILL_RANK,
          path: join(folder, GUIDE_FILE),
          resourceBase: { kind: 'directory', path: folder },
          locator,
        })
      }
      return candidates
    },
    async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
      const { id } = candidate.locator as GuideLocator
      const header = manager.catalog.guide(id)
      if (header === undefined) return undefined
      const path = join(manager.catalog.folder(id), GUIDE_FILE)
      const guide = parseGuide(await readFile(path, 'utf8'), path)
      return {
        name: candidate.name,
        description: candidate.description,
        invocation: candidate.invocation,
        source: candidate.source,
        provider: candidate.provider,
        ...candidate.path === undefined ? {} : { path: candidate.path },
        ...candidate.resourceBase === undefined ? {} : { resourceBase: candidate.resourceBase },
        content: guide.body,
      }
    },
  }
  return { provider, watcher }
}
