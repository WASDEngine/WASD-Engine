/**
 * WASDEngine fork drift guard for the fork-owned patch files under the `wasdengine/` directories of dsh-base,
 * dsh-sdk-minimal, and dsh-web-app: every shipped profile template must compose the WASDEngine service rows
 * without warnings, every row the files patch must still exist upstream with the same package and config keys,
 * the WASDEngine origins must resolve from trusted environment layers only, the account menu's Feedback item must
 * open the WASDEngine issue tracker, whose new-issue page must offer only the fork's issue forms, first use must
 * show no DeepSeek Harness preview notice and create no default Workspace, so the Create game project dialog asks
 * for one, the game tool rows, the row of their Game tools tabs, the row of the Assets tab, and the rows of the Audio
 * tab and its audio tools must mount from web-app dependencies, each tool package must resolve the title, description,
 * and logo the tabs show, and the `gamedev` preset must be the default
 * and, beside `cordis`, the only shipped preset, named by the built-in copy, with its persona and bundled skill root,
 * whose skills the `skill` tool returns within the tool-result pruner threshold.
 * `wasdengine/FORK.md` (repository root) runs this spec after every upstream merge.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { evaluate, isJsExpr, type EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches, readPluginMeta } from '@deepseek-ai/dsh-app-boot'
import { codePointLength, DEFAULTS as PRUNER_DEFAULTS } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createLaunchEnvironmentSnapshot, type LaunchEnvironmentLayerInput } from '@deepseek-ai/dsh-launch-environment'
import { HIDDEN_BUNDLES, PROFILE_TEMPLATES, PROTECTED_PLUGINS } from '@deepseek-ai/dsh-official-bundles'
import SkillRegistry, { renderSkillContent } from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'

const webAppDir = fileURLToPath(new URL('..', import.meta.url))
const repoRoot = resolve(webAppDir, '../../..')
const bundleRoot = join(repoRoot, 'packages/bundle')

/** The fork's patch files, by bundle package, in the order they close that bundle's `dsh.bundle.patch` list. */
const FORK_PATCHES: Readonly<Record<string, readonly string[]>> = {
  '@deepseek-ai/dsh-base': ['./wasdengine/gateway.cordis.patch.yml'],
  '@deepseek-ai/dsh-sdk-minimal': ['./wasdengine/gateway.cordis.patch.yml'],
  '@deepseek-ai/dsh-web-app': [
    './wasdengine/telemetry.cordis.patch.yml', './wasdengine/gamedev.cordis.patch.yml', './wasdengine/first-run.cordis.patch.yml',
    './wasdengine/game-tools.cordis.patch.yml',
  ],
}

/** The game tool rows the fork inserts into every Web and Desktop profile, by row id, with the package each mounts. */
const GAME_TOOLS: Readonly<Record<string, string>> = {
  blender: '@deepseek-ai/dsh-blender',
  elevenlabs: '@deepseek-ai/dsh-elevenlabs',
  'game-addons': '@deepseek-ai/dsh-game-addons',
  gimp: '@deepseek-ai/dsh-gimp',
  godot: '@deepseek-ai/dsh-godot',
  polyhaven: '@deepseek-ai/dsh-polyhaven',
  supercollider: '@deepseek-ai/dsh-supercollider',
}

/** The game tool row without config: Poly Haven, which keeps no files under the harness home and runs with its defaults. */
const POLY_HAVEN = 'polyhaven'

/** The game tool row whose only config is the WASDEngine API origin: ElevenLabs, whose audio the API makes and charges. */
const ELEVENLABS = 'elevenlabs'

/** The game tool row that reads the shipped add-on catalog and keeps the Blender add-on store, which the `blender` row names too. */
const GAME_ADDONS = 'game-addons'

/** The row the fork inserts after the game tools: the browser half of their Game tools tabs. */
const GAME_TOOLS_UI = { id: 'ui-game-tools', name: '@deepseek-ai/dsh-client-ui-game-tools' } as const

/** The row the fork inserts after the Game tools tabs: the right Sidebar's Assets tab, which shows the project's 2D and 3D art. */
const GAME_ASSETS_UI = { id: 'ui-game-assets', name: '@deepseek-ai/dsh-client-ui-game-assets' } as const

/** The row the fork inserts after the Assets tab: the right Sidebar's Audio tab, which plays the project's sounds. */
const GAME_AUDIO_UI = { id: 'ui-game-audio', name: '@deepseek-ai/dsh-client-ui-game-audio' } as const

/** The row the fork inserts after the Audio tab: the agent's audio tools, whose measurements the Audio tab makes. */
const GAME_AUDIO = { id: 'game-audio', name: '@deepseek-ai/dsh-game-audio' } as const

/** The row the fork inserts after the audio tools: the MCP server through which other agents on the computer use the game tools. */
const GAME_MCP = { id: 'game-mcp', name: '@deepseek-ai/dsh-game-mcp' } as const

/** The row the fork inserts after the MCP server: the browser half of the MCP server, the setup for another agent. */
const GAME_MCP_UI = { id: 'ui-game-mcp', name: '@deepseek-ai/dsh-client-ui-game-mcp' } as const

/** The row the fork inserts last: WASD Engine Plugins, WASD Engine's own always-on features. */
const WASD_PLUGINS = { id: 'wasd-plugins', name: '@deepseek-ai/dsh-wasd-plugins' } as const

/** Bundled skills shipped under `wasdengine/skills`. */
const SKILLS = ['game-design-doc', 'godot-project'] as const

/**
 * The bundled skill root inside the macOS app installed in `/Applications`. A `skill` tool result names the skill's
 * directory, so the length of this path counts toward the result that reaches the model.
 */
const INSTALLED_SKILL_ROOT = '/Applications/WASD Engine.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/wasdengine/skills'

/** Production Platform origin when no trusted environment layer sets WASDENGINE_ORIGIN. */
const PLATFORM_ORIGIN = 'https://app.wasdengine.com'

/** Production API origin when no trusted environment layer sets WASDENGINE_ORIGIN. */
const API_ORIGIN = 'https://api.wasdengine.com'

/** Rows that export to the DeepSeek OpenTelemetry collector; every one a profile mounts stays switched off. */
const COLLECTOR_ROWS = ['session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics'] as const

/** Page the account menu's Feedback item opens, in place of the upstream default, DeepSeek's Feishu form. */
const FEEDBACK_URL = 'https://github.com/WASDEngine/WASD-Engine/issues/new'

/** Directory whose files GitHub's new-issue page reads. */
const ISSUE_TEMPLATE_DIR = join(repoRoot, '.github/ISSUE_TEMPLATE')

/** The fork's two issue forms and the template chooser configuration; upstream's templates are pruned. */
const ISSUE_TEMPLATES = ['bug-report.yml', 'config.yml', 'feature-request.yml'] as const

/** Each row the fork patches: the package upstream mounts there and the sources that declare its config keys. */
const TARGETS: Readonly<Record<string, { name: string; schema: readonly string[] }>> = {
  'deepseek-account': {
    name: '@deepseek-ai/dsh-deepseek-account',
    schema: ['packages/credentials/deepseek-account/src/index.ts'],
  },
  'llm-deepseek-account': {
    name: '@deepseek-ai/dsh-llm-deepseek-account',
    schema: ['packages/llm/llm-deepseek-account/src/config.ts', 'packages/llm/llm-deepseek/src/config.ts'],
  },
  'llm-deepseek': {
    name: '@deepseek-ai/dsh-llm-deepseek-api-key',
    schema: ['packages/llm/llm-deepseek-api-key/src/config.ts', 'packages/llm/llm-deepseek/src/config.ts'],
  },
  'session-log-deepseek': {
    name: '@deepseek-ai/dsh-session-log-deepseek',
    schema: ['packages/session/session-log-deepseek/src/index.ts'],
  },
  'session-telemetry-otel': { name: '@deepseek-ai/dsh-session-telemetry-otel', schema: [] },
  'desktop-product-telemetry': { name: '@deepseek-ai/dsh-host-product-telemetry-otel', schema: [] },
  'product-analytics': { name: '@deepseek-ai/dsh-client-product-analytics', schema: [] },
  'ui-settings-account': {
    name: '@deepseek-ai/dsh-client-ui-settings-account',
    schema: ['packages/client/ui-settings-account/src/index.ts'],
  },
  'agent-preset-registry': {
    name: '@deepseek-ai/dsh-agent-preset-registry',
    schema: ['packages/preset/agent-preset-registry/src/preset.ts'],
  },
  'workspace-controller': {
    name: '@deepseek-ai/dsh-api-workspace-controller',
    schema: ['packages/api/workspace-controller/src/index.ts'],
  },
  'ui-settings-models': {
    name: '@deepseek-ai/dsh-client-ui-settings-models',
    schema: ['packages/client/ui-settings-models/src/onboarding-config.ts'],
  },
  web: { name: '@deepseek-ai/dsh-web', schema: ['packages/web/web/src/index.ts'] },
}

/** Upstream config keys the fork deliberately replaces instead of restating. */
const REPLACED_KEYS: Readonly<Record<string, readonly string[]>> = {
  'agent-preset-registry': ['default'],
  // dsh-sdk-minimal names DEEPSEEK_API_KEY.
  'llm-deepseek': ['apiKeyEnv'],
  // Upstream fetches pages anonymously from the user's computer (http).
  web: ['fetchProvider'],
}

/** Rows of the `gamedev` preset that carry fork config, with the sources declaring the keys it sets. */
const PRESET_OWN_ROWS: Readonly<Record<string, readonly string[]>> = {
  persona: ['packages/preset/persona/src/index.ts'],
  'skill-filesystem': ['packages/skill/skill-filesystem/src/index.ts'],
}

interface BundleManifest {
  name: string
  files: string[]
  dependencies?: Record<string, string>
  dsh: { bundle: { patch: string | string[] } }
}

function manifest(dir: string): BundleManifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as BundleManifest
}

function patchList(dir: string): string[] {
  const { patch } = manifest(dir).dsh.bundle
  return typeof patch === 'string' ? [patch] : patch
}

/** Workspace directory of each bundle package under `packages/bundle`, by package name. */
const bundleDirs = new Map(readdirSync(bundleRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(bundleRoot, entry.name, 'package.json')))
  .map(entry => [manifest(join(bundleRoot, entry.name)).name, join(bundleRoot, entry.name)] as const))

function bundleDir(name: string): string {
  const dir = bundleDirs.get(name)
  if (dir === undefined) throw new Error(`profile bundle ${name} is not a package under packages/bundle`)
  return dir
}

/** One bundle's parsed patches, optionally without the fork's files. */
function bundleLayer(dir: string, omit: readonly string[] = []): PatchOptions[] {
  return bundlePatchPaths(dir, { patch: patchList(dir).filter(file => !omit.includes(file)) })
    .flatMap(file => loadOverlayPatches('wasdengine-overlay', file))
}

/** The parsed patches of the fork's own files in one bundle. */
function forkLayer(name: string): PatchOptions[] {
  return (FORK_PATCHES[name] ?? []).flatMap(file => loadOverlayPatches('wasdengine-overlay', join(bundleDir(name), file)))
}

function compose(layers: PatchOptions[][]): { rows: EntryOptions[]; warnings: string[] } {
  const warnings: string[] = []
  const rows = composeEntries(layers, message => warnings.push(message))
  return { rows, warnings }
}

/** A shipped profile template composed from its bundles, with and without the fork's files, and those files' patches. */
interface ProfileComposition {
  upstream: { rows: EntryOptions[]; warnings: string[] }
  fork: { rows: EntryOptions[]; warnings: string[] }
  patches: PatchOptions[]
}

function composeProfile(bundles: readonly string[]): ProfileComposition {
  return {
    upstream: compose(bundles.map(name => bundleLayer(bundleDir(name), FORK_PATCHES[name] ?? []))),
    fork: compose(bundles.map(name => bundleLayer(bundleDir(name)))),
    patches: bundles.flatMap(forkLayer),
  }
}

const profiles = new Map(Object.entries(PROFILE_TEMPLATES).map(([name, { bundles }]) => [name, composeProfile(bundles)] as const))

function profile(name: string): ProfileComposition {
  const composition = profiles.get(name)
  if (composition === undefined) throw new Error(`no shipped profile template ${name}`)
  return composition
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function configOf(entry: { config?: unknown } | undefined): Record<string, unknown> {
  return isRecord(entry?.config) ? entry.config : {}
}

function expression(value: unknown, label: string): string {
  if (!isJsExpr(value)) throw new Error(`${label} must be a !!js expression`)
  return value.__jsExpr
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** Every row of a composition, including rows nested in groups and agent presets, with its id path. */
function allRows(entries: readonly Record<string, unknown>[], path = ''): { id: string; entry: Record<string, unknown> }[] {
  return entries.flatMap((entry) => {
    const id = `${path}${String(entry.id)}`
    const nested = entry.group === true
      ? rowsOf(entry.config)
      : entry.name === '@deepseek-ai/dsh-agent-preset' ? rowsOf(configOf(entry).plugins) : []
    return [{ id, entry }, ...allRows(nested, `${id}/`)]
  })
}

/** The configuration a row holds itself, without the rows nested in a group or an agent preset. */
function ownConfig(entry: Record<string, unknown>): unknown {
  if (entry.group === true) return null
  if (entry.name === '@deepseek-ai/dsh-agent-preset') return { ...configOf(entry), plugins: undefined }
  return entry.config ?? null
}

/** Whether one of the sources declares `key` as a Config member or schema field. */
function declaresKey(sources: readonly string[], key: string): boolean {
  const field = new RegExp(String.raw`^\s*(?:readonly\s+)?${key}\??\s*:`, 'm')
  return sources.some(source => field.test(readFileSync(join(repoRoot, source), 'utf8')))
}

/** Evaluate a Loader expression the way a mounted row would, against an optional launch environment. */
function evaluateWith(source: string, layers?: readonly LaunchEnvironmentLayerInput[]): unknown {
  const environment = layers === undefined ? undefined : createLaunchEnvironmentSnapshot(layers)
  const ctx = { get: (name: string) => name === 'launchEnvironment' ? environment : undefined }
  const value: unknown = evaluate(ctx, source)
  return value
}

function row(rows: readonly EntryOptions[], id: string): EntryOptions | undefined {
  return rows.find(entry => entry.id === id)
}

function patchConfig(patches: readonly PatchOptions[], id: string): Record<string, unknown> {
  return configOf(patches.find(patch => patch.insert === undefined && patch.id === id))
}

function issueTemplate(file: string): Record<string, unknown> {
  const parsed: unknown = yaml.load(readFileSync(join(ISSUE_TEMPLATE_DIR, file), 'utf8'))
  if (!isRecord(parsed)) throw new Error(`.github/ISSUE_TEMPLATE/${file} must hold a YAML mapping`)
  return parsed
}

const baseGateway = forkLayer('@deepseek-ai/dsh-base')
const minimalGateway = forkLayer('@deepseek-ai/dsh-sdk-minimal')
const allPatches = Object.keys(FORK_PATCHES).flatMap(forkLayer)
const rowPatches = allPatches.filter(patch => patch.insert === undefined)

/** The single definitions of the origin expressions: the dsh-base overlay's anchors and its Anthropic route copy. */
const account = patchConfig(baseGateway, 'deepseek-account')
const platform = expression(account.platformOrigin, 'deepseek-account.platformOrigin')
const api = expression(account.inferenceOrigin, 'deepseek-account.inferenceOrigin')
const anthropic = expression(patchConfig(baseGateway, 'llm-deepseek').baseURL, 'llm-deepseek.baseURL')

describe('WASDEngine overlay', () => {
  it('closes each patched bundle\'s patch list and ships its files', () => {
    for (const [name, patches] of Object.entries(FORK_PATCHES)) {
      const dir = bundleDir(name)
      expect(patchList(dir).slice(-patches.length), name).toEqual([...patches])
      for (const file of patches) expect(manifest(dir).files, name).toContain(file.slice(2))
    }
    expect(manifest(webAppDir).files).toContain('wasdengine/skills')
    expect(manifest(webAppDir).files).toContain('wasdengine/addons')
  })

  it('patches exactly the target rows and inserts only the gamedev preset, the game tools, their tabs, the Assets and Audio tabs, the audio tools, their MCP server, and WASD Engine Plugins', () => {
    expect([...new Set(rowPatches.map(patch => patch.id))].sort()).toEqual(Object.keys(TARGETS).sort())
    expect(allPatches.flatMap(patch => patch.insert ?? []).map(entry => entry.id))
      .toEqual(['preset-gamedev', ...Object.keys(GAME_TOOLS), GAME_TOOLS_UI.id, GAME_ASSETS_UI.id, GAME_AUDIO_UI.id, GAME_AUDIO.id, GAME_MCP.id, GAME_MCP_UI.id, WASD_PLUGINS.id])
  })

  it('mounts WASD Engine Plugins from a web-app dependency without config, and the plugin manager keeps it on', () => {
    const entry = forkLayer('@deepseek-ai/dsh-web-app').flatMap(patch => patch.insert ?? []).find(row => row.id === WASD_PLUGINS.id)
    expect(entry?.name).toBe(WASD_PLUGINS.name)
    expect(entry?.config).toBeUndefined()
    expect(entry?.disabled).toBeUndefined()
    expect(manifest(webAppDir).dependencies?.[WASD_PLUGINS.name]).toBe('workspace:*')
    expect(PROTECTED_PLUGINS.has(WASD_PLUGINS.name)).toBe(true)
    const meta = readPluginMeta(WASD_PLUGINS.name, pathToFileURL(join(webAppDir, 'package.json')).href)
    expect(meta?.error).toBeUndefined()
    const title = meta?.title
    expect(typeof title === 'object' ? title.en : title).toBe('WASD Engine Plugins')
    expect(meta?.icon).toMatch(/^data:image\/svg\+xml;base64,/u)
  })

  it('mounts the game tools\' MCP server from a web-app dependency with its own directory under the harness home', () => {
    const entry = forkLayer('@deepseek-ai/dsh-web-app').flatMap(patch => patch.insert ?? []).find(row => row.id === GAME_MCP.id)
    expect(entry?.name).toBe(GAME_MCP.name)
    expect(entry?.disabled).toBeUndefined()
    expect(Object.keys(configOf(entry))).toEqual(['dataRoot'])
    expect(expression(configOf(entry).dataRoot, 'game-mcp.dataRoot')).toBe(`dshHomePath('${GAME_MCP.id}')`)
    expect(manifest(webAppDir).dependencies?.[GAME_MCP.name]).toBe('workspace:*')
  })

  it('mounts the MCP server\'s setup panel from a web-app dependency by its bare package name, without config', () => {
    const entry = forkLayer('@deepseek-ai/dsh-web-app').flatMap(patch => patch.insert ?? []).find(row => row.id === GAME_MCP_UI.id)
    expect(entry?.name).toBe(GAME_MCP_UI.name)
    expect(entry?.config).toBeUndefined()
    expect(entry?.disabled).toBeUndefined()
    expect(manifest(webAppDir).dependencies?.[GAME_MCP_UI.name]).toBe('workspace:*')
  })

  it('mounts each game tool from a web-app dependency, the application tools with their own directory under the harness home', () => {
    const inserted = forkLayer('@deepseek-ai/dsh-web-app').flatMap(patch => patch.insert ?? [])
      .filter(entry => Object.hasOwn(GAME_TOOLS, entry.id))
    expect(inserted.map(entry => entry.id)).toEqual(Object.keys(GAME_TOOLS))
    const dependencies = manifest(webAppDir).dependencies ?? {}
    for (const entry of inserted) {
      const id = entry.id
      expect(entry.name, `${id} package`).toBe(GAME_TOOLS[id])
      expect(entry.disabled, `${id} is on`).toBeUndefined()
      expect(dependencies[entry.name], `${id} is a web-app dependency`).toBe('workspace:*')
      if (id === POLY_HAVEN) {
        expect(entry.config, `${id} config`).toBeUndefined()
        continue
      }
      if (id === ELEVENLABS) {
        // The account sign-in releases its token only to the inference origin, so the audio goes there.
        expect(Object.keys(configOf(entry)), `${id} config keys`).toEqual(['apiOrigin'])
        expect(expression(configOf(entry).apiOrigin, `${id}.apiOrigin`), `${id}.apiOrigin`).toBe(api)
        continue
      }
      const store = `dshHomePath('${GAME_ADDONS}', 'blender')`
      if (id === GAME_ADDONS) {
        expect(Object.keys(configOf(entry)), `${id} config keys`).toEqual(['catalogDir', 'dataRoot', 'blenderStore'])
        expect(expression(configOf(entry).catalogDir, `${id}.catalogDir`), `${id}.catalogDir`).toMatch(/resolve\('@deepseek-ai\/dsh-web-app\/package\.json'\)\), 'wasdengine', 'addons'\)$/u)
        expect(expression(configOf(entry).blenderStore, `${id}.blenderStore`), `${id}.blenderStore`).toBe(store)
      } else if (id === 'blender') {
        expect(Object.keys(configOf(entry)), `${id} config keys`).toEqual(['dataRoot', 'addonStore'])
        expect(expression(configOf(entry).addonStore, `${id}.addonStore`), `${id}.addonStore`).toBe(store)
      } else {
        expect(Object.keys(configOf(entry)), `${id} config keys`).toEqual(['dataRoot'])
      }
      expect(expression(configOf(entry).dataRoot, `${id}.dataRoot`), `${id}.dataRoot`).toBe(`dshHomePath('${id}')`)
    }
    expect(PROTECTED_PLUGINS.has(GAME_TOOLS[POLY_HAVEN] ?? ''), 'the Plugins page can switch Poly Haven off').toBe(false)
    expect(PROTECTED_PLUGINS.has(GAME_TOOLS[GAME_ADDONS] ?? ''), 'the Plugins page can switch the game add-ons off').toBe(false)
    expect(PROTECTED_PLUGINS.has(GAME_TOOLS[ELEVENLABS] ?? ''), 'the Plugins page can switch ElevenLabs off').toBe(false)
  })

  it('mounts the Game tools tabs from a web-app dependency by its bare package name, without config', () => {
    const entry = forkLayer('@deepseek-ai/dsh-web-app').flatMap(patch => patch.insert ?? []).find(row => row.id === GAME_TOOLS_UI.id)
    expect(entry?.name).toBe(GAME_TOOLS_UI.name)
    expect(entry?.config).toBeUndefined()
    expect(entry?.disabled).toBeUndefined()
    expect(manifest(webAppDir).dependencies?.[GAME_TOOLS_UI.name]).toBe('workspace:*')
  })

  it('mounts the Assets tab from a web-app dependency by its bare package name, with its default caps', () => {
    const entry = forkLayer('@deepseek-ai/dsh-web-app').flatMap(patch => patch.insert ?? []).find(row => row.id === GAME_ASSETS_UI.id)
    expect(entry?.name).toBe(GAME_ASSETS_UI.name)
    expect(entry?.config).toBeUndefined()
    expect(entry?.disabled).toBeUndefined()
    expect(manifest(webAppDir).dependencies?.[GAME_ASSETS_UI.name]).toBe('workspace:*')
    const meta = readPluginMeta(GAME_ASSETS_UI.name, pathToFileURL(join(webAppDir, 'package.json')).href)
    expect(meta?.error).toBeUndefined()
    const title = meta?.title
    expect(typeof title === 'object' ? title.en : title).toBe('Assets tab')
  })

  it('mounts the Audio tab and the audio tools from web-app dependencies by their bare package names, with their default caps', () => {
    const parent = pathToFileURL(join(webAppDir, 'package.json')).href
    for (const [row, title] of [[GAME_AUDIO_UI, 'Audio tab'], [GAME_AUDIO, 'Audio for the agent']] as const) {
      const entry = forkLayer('@deepseek-ai/dsh-web-app').flatMap(patch => patch.insert ?? []).find(candidate => candidate.id === row.id)
      expect(entry?.name).toBe(row.name)
      expect(entry?.config).toBeUndefined()
      expect(entry?.disabled).toBeUndefined()
      expect(manifest(webAppDir).dependencies?.[row.name]).toBe('workspace:*')
      const meta = readPluginMeta(row.name, parent)
      expect(meta?.error).toBeUndefined()
      expect(typeof meta?.title === 'object' ? meta.title.en : meta?.title).toBe(title)
    }
  })

  it('resolves the title, description, and SVG logo the Game tools tabs show for each game tool', () => {
    const parent = pathToFileURL(join(webAppDir, 'package.json')).href
    for (const name of Object.values(GAME_TOOLS)) {
      const meta = readPluginMeta(name, parent)
      expect(meta?.error, `${name} metadata error`).toBeUndefined()
      expect(meta?.title, `${name} title`).toBeDefined()
      expect(meta?.description, `${name} description`).toBeDefined()
      expect(meta?.icon, `${name} icon`).toMatch(/^data:image\/svg\+xml;base64,/u)
    }
  })

  it('lists the game tools in the Game tools tabs in the order the overlay mounts them', async () => {
    // A computed file URL keeps this browser module and its Client Context merges out of the Host type check of this spec.
    const tools = pathToFileURL(join(repoRoot, 'packages/gamedev/ui-game-tools/src/client/tools.ts')).href
    const loaded: unknown = await import(tools)
    expect(isRecord(loaded) ? loaded.GAME_TOOL_MODULES : undefined).toEqual(Object.values(GAME_TOOLS))
  })

  it('sets only config keys that upstream still declares', () => {
    for (const patch of rowPatches) {
      const id = patch.id ?? ''
      for (const key of Object.keys(configOf(patch))) {
        expect(declaresKey(TARGETS[id]?.schema ?? [], key), `${id}.${key} is declared upstream`).toBe(true)
      }
    }
  })

  it('serves the API-key route only the upstream deepseek-flash catalog entry', async () => {
    const models = pathToFileURL(join(repoRoot, 'packages/llm/llm-deepseek/src/models.ts')).href
    const loaded: unknown = await import(models)
    const flash = rowsOf((loaded as { DEFAULT_MODELS?: unknown }).DEFAULT_MODELS).find(model => model.id === 'deepseek-flash')
    expect(flash).toBeDefined()
    for (const gateway of [baseGateway, minimalGateway]) {
      const config = patchConfig(gateway, 'llm-deepseek')
      expect(config.apiKeyEnv).toBe('WASDENGINE_API_KEY')
      expect(config.models).toEqual([flash])
    }
  })

  it('opens a Feedback page that the account settings schema accepts, offers no API key at sign-in, and requires sign-in', async () => {
    const config = patchConfig(forkLayer('@deepseek-ai/dsh-web-app'), 'ui-settings-account')
    expect(config).toEqual({ contactFormUrl: FEEDBACK_URL, apiKeyEntry: false, signInRequired: true })
    // A URL the schema rejects fails the row's config validation, so the account settings plugin would not start.
    const source = pathToFileURL(join(repoRoot, 'packages/client/ui-settings-account/src/contact-config.ts')).href
    const loaded: unknown = await import(source)
    type Contact = { contactFormUrl: string; apiKeyEntry: boolean; signInRequired: boolean }
    const { ContactConfig } = loaded as { ContactConfig: (input: Record<string, unknown>) => Contact }
    expect(ContactConfig(config)).toMatchObject({ contactFormUrl: FEEDBACK_URL, apiKeyEntry: false, signInRequired: true })
  })

  it('shows no DeepSeek Harness preview notice on first use, asks for sign-in in the Desktop main window, and offers no API key entry', () => {
    const expected = { apiKeyEntry: false, nativeCredentialOnboarding: false, welcomeNotice: false }
    expect(patchConfig(forkLayer('@deepseek-ai/dsh-web-app'), 'ui-settings-models')).toEqual(expected)
    expect(configOf(row(profile('web').fork.rows, 'ui-settings-models'))).toEqual(expected)
  })

  it('creates no first-use default Workspace, so the Create game project dialog asks for a game project', () => {
    expect(patchConfig(forkLayer('@deepseek-ai/dsh-web-app'), 'workspace-controller')).toEqual({ defaultWorkspace: false })
    expect(configOf(row(profile('web').fork.rows, 'workspace-controller'))).toEqual({ defaultWorkspace: false })
  })

  it('offers only the fork\'s issue forms and a blank issue on the Feedback page', () => {
    // A template that an upstream merge adds joins the chooser until upstream-prune.txt lists it.
    expect(readdirSync(ISSUE_TEMPLATE_DIR).filter(file => !file.startsWith('.')).sort()).toEqual([...ISSUE_TEMPLATES])
    const config = issueTemplate('config.yml')
    expect(config.blank_issues_enabled).toBe(true)
    for (const link of rowsOf(config.contact_links)) {
      expect(String(link.url)).toMatch(/^https:\/\/github\.com\/WASDEngine\/WASD-Engine(?:[/#?]|$)/u)
    }
  })

  it('requires a bug report to name what ran, the version and OS, the steps, and the expected and actual results', () => {
    const bug = issueTemplate('bug-report.yml')
    // Issue types that the WASDEngine organization defines.
    expect([bug.type, issueTemplate('feature-request.yml').type]).toEqual(['Bug', 'Feature'])
    const fields = rowsOf(bug.body)
    const required = fields.filter(field => isRecord(field.validations) && field.validations.required === true)
    expect(required.map(field => field.id)).toEqual(['surface', 'version', 'os', 'steps', 'expected', 'actual'])
    const surface = fields.find(field => field.id === 'surface')?.attributes
    expect(isRecord(surface) ? surface.options : undefined).toEqual(['Desktop app', 'Web UI (dsh web)', 'Other'])
  })
})

describe.each([...profiles.keys()])('%s profile', (name) => {
  const { upstream, fork, patches } = profile(name)
  const mounts = (id: string): boolean => row(upstream.rows, id) !== undefined

  it('composes the fork\'s files without warnings over rows upstream still mounts', () => {
    expect(upstream.warnings).toEqual([])
    expect(fork.warnings).toEqual([])
    for (const patch of patches.filter(entry => entry.insert === undefined)) {
      const id = patch.id ?? ''
      expect(row(upstream.rows, id)?.name, `upstream row ${id}`).toBe(TARGETS[id]?.name)
    }
    const inserted = patches.flatMap(patch => patch.insert ?? []).map(entry => entry.id)
    expect(fork.rows.map(entry => entry.id)).toEqual([...upstream.rows.map(entry => entry.id), ...inserted])
  })

  it('patches every row that mounts a package the fork configures', () => {
    const patched = new Set(patches.map(patch => patch.id))
    const packages = new Set(Object.values(TARGETS).map(target => target.name))
    for (const { id, entry } of allRows(rowsOf(upstream.rows))) {
      if (typeof entry.name === 'string' && packages.has(entry.name)) expect(patched.has(id), `${id} (${entry.name})`).toBe(true)
    }
  })

  it('restates every upstream config key of a row whose config it replaces', () => {
    for (const patch of patches) {
      if (patch.insert !== undefined || patch.config === undefined) continue
      const id = patch.id ?? ''
      const replaced = REPLACED_KEYS[id] ?? []
      const own = configOf(patch)
      for (const [key, value] of Object.entries(configOf(row(upstream.rows, id)))) {
        if (replaced.includes(key)) continue
        expect(own[key], `${id}.${key} restated`).toEqual(value)
      }
    }
  })

  it('points every DeepSeek provider row it mounts at the WASDEngine origins and credential', () => {
    const llm = configOf(row(fork.rows, 'llm-deepseek'))
    expect(expression(llm.baseURL, 'llm-deepseek.baseURL')).toBe(anthropic)
    expect(llm.apiKeyEnv).toBe('WASDENGINE_API_KEY')
    expect(llm.models).toEqual(patchConfig(baseGateway, 'llm-deepseek').models)
    if (mounts('deepseek-account')) {
      const config = configOf(row(fork.rows, 'deepseek-account'))
      expect(expression(config.platformOrigin, 'deepseek-account.platformOrigin')).toBe(platform)
      expect(expression(config.inferenceOrigin, 'deepseek-account.inferenceOrigin')).toBe(api)
      // Account notifications carry the sign-in token, so they stay on the Platform origin.
      expect(expression(config.harnessOrigin, 'deepseek-account.harnessOrigin')).toBe(platform)
      expect(config.allowLoopbackHttp).toBe(true)
    }
    if (mounts('llm-deepseek-account')) {
      expect(expression(configOf(row(fork.rows, 'llm-deepseek-account')).baseURL, 'llm-deepseek-account.baseURL')).toBe(api)
    }
  })

  it('sends web search and page fetches to the WASDEngine service, which follows the conversation\'s route', () => {
    if (!mounts('web')) return
    expect(configOf(row(fork.rows, 'web'))).toEqual({ searchProvider: 'deepseek-search-api', fetchProvider: 'deepseek-fetch-api' })
    // Without their own base URL or key, the DeepSeek Search and Fetch API providers follow the conversation's
    // DeepSeek route, which the rows above point at the WASDEngine origins.
    expect(configOf(row(fork.rows, 'web-deepseek-api'))).toEqual({})
  })

  it('sends the account menu\'s Feedback item to the WASDEngine issue tracker', () => {
    if (mounts('ui-settings-account')) {
      expect(configOf(row(fork.rows, 'ui-settings-account')).contactFormUrl).toBe(FEEDBACK_URL)
    }
  })

  it('switches off the Session log request field and the DeepSeek collector exports', () => {
    expect(configOf(row(fork.rows, 'session-log-deepseek'))).toEqual({ enabled: false })
    for (const id of COLLECTOR_ROWS.filter(mounts)) expect(row(fork.rows, id)?.disabled, id).toBe(true)
    // Any row whose own configuration names a DeepSeek host must stay switched off.
    for (const { id, entry } of allRows(rowsOf(fork.rows))) {
      if (/deepseek\.com|deepseeksvc\.com/u.test(JSON.stringify(ownConfig(entry)))) {
        expect(entry.disabled, `${id} names a DeepSeek host`).toBe(true)
      }
    }
  })
})

describe('WASDEngine origin', () => {
  it('derives every origin value from the Platform and API expressions', () => {
    expect(patchConfig(baseGateway, 'llm-deepseek-account').baseURL).toEqual(account.inferenceOrigin)
    expect(anthropic).toBe(`new URL('/anthropic', ${api}).href`)
    // A YAML alias cannot reach the sdk-minimal overlay, so it repeats the Anthropic route expression verbatim.
    expect(expression(patchConfig(minimalGateway, 'llm-deepseek').baseURL, 'sdk-minimal llm-deepseek.baseURL')).toBe(anthropic)
    // Each expression names its production origin once, and they differ only there.
    expect(platform.split(PLATFORM_ORIGIN)).toHaveLength(2)
    expect(api.split(API_ORIGIN)).toHaveLength(2)
    expect(platform.replace(PLATFORM_ORIGIN, API_ORIGIN)).toBe(api)
    expect(account.allowLoopbackHttp).toBe(true)
  })

  it.each([
    { layers: undefined, expected: { platform: PLATFORM_ORIGIN, api: API_ORIGIN } },
    { layers: [], expected: { platform: PLATFORM_ORIGIN, api: API_ORIGIN } },
    {
      layers: [{ source: 'process', values: { WASDENGINE_ORIGIN: 'http://127.0.0.1:8000' } }],
      expected: { platform: 'http://127.0.0.1:8000', api: 'http://127.0.0.1:8000' },
    },
    {
      layers: [{ source: 'user-env', path: '/home/.wasdengine/.env', values: { WASDENGINE_ORIGIN: 'https://staging.wasd.example' } }],
      expected: { platform: 'https://staging.wasd.example', api: 'https://staging.wasd.example' },
    },
    // A cloned repository's .env never redirects WASDEngine credentials.
    {
      layers: [{ source: 'project-env', path: '/work/.env', values: { WASDENGINE_ORIGIN: 'https://attacker.example' } }],
      expected: { platform: PLATFORM_ORIGIN, api: API_ORIGIN },
    },
    {
      layers: [
        { source: 'project-env', path: '/work/.env', values: { WASDENGINE_ORIGIN: 'https://attacker.example' } },
        { source: 'process', values: { WASDENGINE_ORIGIN: 'https://wasd.example' } },
      ],
      expected: { platform: 'https://wasd.example', api: 'https://wasd.example' },
    },
  ] satisfies { layers: LaunchEnvironmentLayerInput[] | undefined; expected: { platform: string; api: string } }[])(
    'resolves $expected.platform and $expected.api',
    ({ layers, expected }) => {
      expect(evaluateWith(platform, layers)).toBe(expected.platform)
      expect(evaluateWith(api, layers)).toBe(expected.api)
      expect(evaluateWith(anthropic, layers)).toBe(`${expected.api}/anthropic`)
    },
  )

  it('appends the Anthropic path once when the origin ends with a slash', () => {
    expect(evaluateWith(anthropic, [{ source: 'process', values: { WASDENGINE_ORIGIN: 'https://wasd.example/' } }]))
      .toBe('https://wasd.example/anthropic')
  })
})

describe('gamedev preset', () => {
  const { fork } = profile('web')
  const game = configOf(row(fork.rows, 'preset-gamedev'))
  const cordis = configOf(row(fork.rows, 'preset-cordis'))
  const gameRows = rowsOf(game.plugins)
  const gameRow = (id: string): Record<string, unknown> => gameRows.find(entry => entry.id === id) ?? {}

  it('is the deployment default and, beside cordis, the only shipped preset', () => {
    expect(configOf(row(fork.rows, 'agent-preset-registry'))).toEqual({ default: 'gamedev' })
    expect(fork.rows.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset').map(entry => entry.id).sort())
      .toEqual(['preset-cordis', 'preset-gamedev'])
    expect(game.id).toBe('gamedev')
    expect(game.order).toBeTypeOf('number')
    expect(Number(game.order)).toBeLessThan(Number(cordis.order))
    for (const key of ['id', 'order', 'plugins']) {
      expect(declaresKey(['packages/preset/agent-preset-registry/src/definition.ts'], key), `preset field ${key}`).toBe(true)
    }
  })

  it('leaves computer use hidden on the Plugins page while its tool joins only a preset WASD Engine does not ship', () => {
    const cua = loadOverlayPatches('wasdengine-overlay', join(repoRoot, 'packages/experimental/cua-bundle/cordis.patch.yml'))
    const preset = configOf(cua.flatMap(patch => patch.insert ?? []).find(entry => entry.id === 'cua')).agentPreset
    const shipped = fork.rows.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset').map(entry => configOf(entry).id)
    expect(preset, 'the computer use bundle row').toBe('ptc')
    expect(shipped).not.toContain(preset)
    // Its "Set to PTC" action would make every new Session fail with agent-preset/not-found.
    expect(HIDDEN_BUNDLES.has('@deepseek-ai/dsh-cua-bundle')).toBe(true)
  })

  it('publishes no display fields, so the built-in copy names it, and sets only keys upstream declares', () => {
    expect(Object.keys(game).sort()).toEqual(['id', 'order', 'plugins'])
    const display = readFileSync(join(repoRoot, 'packages/preset/agent-preset-registry/src/display.ts'), 'utf8')
    expect(display).toContain("gamedev: { name: 'presetGamedevName', description: 'presetGamedevDescription' },")
    for (const [id, sources] of Object.entries(PRESET_OWN_ROWS)) {
      const own = configOf(gameRow(id))
      expect(Object.keys(own).length, `${id} carries fork config`).toBeGreaterThan(0)
      expect(Object.keys(own).every(key => declaresKey(sources, key)), `${id} keys are declared upstream`).toBe(true)
    }
  })

  it('writes a persona prefix that uses only supported prompt variables', () => {
    const prefix = configOf(gameRow('persona')).prefix
    expect(prefix).toBeTypeOf('string')
    expect(String(prefix)).toContain('{{model}}')
    expect(String(prefix).replaceAll(/\{\{(?:model|provider)\}\}/gu, '')).not.toMatch(/\{\{|\}\}/u)
  })

  it('resolves its bundled skill root to valid skills inside this package', () => {
    const source = expression(configOf(gameRow('skill-filesystem')).bundledSkillDir, 'skill-filesystem.bundledSkillDir')
    const root: unknown = evaluate({ baseUrl: pathToFileURL(webAppDir).href }, source)
    expect(root).toBe(join(webAppDir, 'wasdengine', 'skills'))
    expect(readdirSync(String(root)).sort()).toEqual([...SKILLS])
    for (const skill of SKILLS) {
      const file = join(String(root), skill, 'SKILL.md')
      expect(existsSync(file), file).toBe(true)
      const text = readFileSync(file, 'utf8')
      expect(text, skill).not.toMatch(/\{\{|\}\}/u)
      const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(text)?.[1] ?? ''
      expect(/^name: (.+)$/mu.exec(frontmatter)?.[1], `${skill} name`).toBe(skill)
      const description = /^description: (.+)$/mu.exec(frontmatter)?.[1] ?? ''
      // The session catalog shows at most 500 description characters; a plain YAML scalar holds no ": " or " #".
      expect(description.length, `${skill} description`).toBeGreaterThan(0)
      expect(description.length, `${skill} description`).toBeLessThanOrEqual(500)
      expect(description, `${skill} description`).not.toMatch(/: | #/u)
    }
  })

  it('returns each bundled skill from the installed macOS app within the tool-result pruner threshold', async (test) => {
    const pruner = configOf(rowsOf(gameRow('compaction').config).find(entry => entry.id === 'tool-result-pruner'))
    const threshold = typeof pruner.thresholdChars === 'number' ? pruner.thresholdChars : PRUNER_DEFAULTS.thresholdChars
    const ctx = new Context()
    test.onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(SkillFileSystem, { includeDefaultRoots: false, watch: false, bundledSkillDir: join(webAppDir, 'wasdengine', 'skills') })
    for (const skill of SKILLS) {
      const loaded = await ctx.skills.get(skill)
      if (loaded === undefined) throw new Error(`${skill} did not load from the bundled skill root`)
      expect(loaded.resourceBase?.kind, skill).toBe('directory')
      const result = renderSkillContent({ ...loaded, resourceBase: { kind: 'directory', path: `${INSTALLED_SKILL_ROOT}/${skill}` } })
      // The pruner trims only a result longer than the threshold.
      expect(codePointLength(result), `${skill} skill tool result`).toBeLessThanOrEqual(threshold)
    }
  })

  it('has godot-project name the built-in Godot before any godot command, which it keeps for sessions without the tools', () => {
    const text = readFileSync(join(webAppDir, 'wasdengine', 'skills', 'godot-project', 'SKILL.md'), 'utf8')
    const builtIn = text.indexOf('When the `godot_*` tools are available, Godot is built in')
    const fallback = 'Without the `godot_*` tools, run `'
    expect(builtIn).toBeGreaterThan(0)
    expect(text.indexOf(fallback)).toBeGreaterThan(builtIn)
    expect(text.indexOf('godot --')).toBe(text.indexOf(fallback) + fallback.length)
  })
})
