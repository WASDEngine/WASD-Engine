/**
 * WASDEngine fork drift spec for the overview that opens the instructions of WASD Engine's MCP server: every plugin that
 * a shipped profile template mounts and whose source registers a game MCP provider gets its real provider here, from
 * its factory or its own `apply`, and with all of them the overview fits in the 4,096 characters that Claude Code passes
 * to its model, its first paragraph in the 512 that Codex reads on their own, and what an agent must do comes before the
 * plugin list, whose end a harness that cuts the instructions short loses first. A mounted provider plugin that this
 * spec does not build fails it. `wasdengine/FORK.md` (repository root) lists this spec.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { feedbackMcpProvider } from '@deepseek-ai/dsh-agent-feedback/src/mcp.ts'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { referenceMcpProvider } from '@deepseek-ai/dsh-art-references/src/mcp.ts'
import * as Blender from '@deepseek-ai/dsh-blender'
import { elevenLabsMcpProvider } from '@deepseek-ai/dsh-elevenlabs/src/mcp.ts'
import { loadCatalog } from '@deepseek-ai/dsh-game-addons/src/catalog.ts'
import { gameAddonMcpProvider } from '@deepseek-ai/dsh-game-addons/src/mcp.ts'
import { assetMcpProvider } from '@deepseek-ai/dsh-game-assets/src/mcp.ts'
import { audioMcpProvider } from '@deepseek-ai/dsh-game-audio/src/mcp.ts'
import type { GameMcpProvider } from '@deepseek-ai/dsh-game-mcp'
import { GameToolCatalog, OVERVIEW_LIMIT } from '@deepseek-ai/dsh-game-mcp/src/catalog.ts'
import * as Gimp from '@deepseek-ai/dsh-gimp'
import GodotController from '@deepseek-ai/dsh-godot'
import { godotMcpProvider } from '@deepseek-ai/dsh-godot/src/mcp.ts'
import { graphicsReviewMcpProvider } from '@deepseek-ai/dsh-graphics-review/src/mcp.ts'
import { imageMcpProvider } from '@deepseek-ai/dsh-image-generation/src/mcp.ts'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'
import { polyHavenMcpProvider } from '@deepseek-ai/dsh-polyhaven/src/mcp.ts'
import * as SuperCollider from '@deepseek-ai/dsh-supercollider'
import { tripoMcpProvider } from '@deepseek-ai/dsh-tripo/src/mcp.ts'
import { MCP_SURFACE, MULTIPLAYER_MCP_INSTRUCTIONS, multiplayerMcpTools, multiplayerToolDefinitions } from '@deepseek-ai/dsh-wasd-plugins/src/multiplayer-tools.ts'
import { wasdMcpProvider } from '@deepseek-ai/dsh-wasd-plugins/src/tools.ts'
import { expect, it, onTestFinished } from 'vitest'

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)), '../../..')

/** Absolute folder that the plugins' configurations require; nothing is written there. */
const DATA = join(fileURLToPath(new URL('.', import.meta.url)), 'never-written')

/** The add-on catalog that the `game-addons` row of the game tools overlay reads. */
const ADDONS = fileURLToPath(new URL('../wasdengine/addons', import.meta.url))

/** The fields of a workspace package manifest that this spec reads. */
interface Manifest {
  readonly name: string
  readonly dsh?: { readonly bundle?: { readonly patch: string | readonly string[] } }
}

function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

/** Folder of every workspace package under `packages/<group>/<package>`, by package name. */
const packageDirs = new Map(readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })
  .filter(group => group.isDirectory())
  .flatMap(group => readdirSync(join(repoRoot, 'packages', group.name)).map(name => join(repoRoot, 'packages', group.name, name)))
  .filter(dir => existsSync(join(dir, 'package.json')))
  .map(dir => [manifestOf(dir).name, dir] as const))

/** The rows of a profile template, composed from its bundles' patch files in their order, as a Host composes them. */
function profileRows(bundles: readonly string[]): unknown[] {
  const layers = bundles.map((bundle) => {
    const dir = packageDirs.get(bundle)
    if (dir === undefined) throw new Error(`the profile bundle ${bundle} is no workspace package`)
    const patch = manifestOf(dir).dsh?.bundle?.patch ?? []
    return bundlePatchPaths(dir, { patch: typeof patch === 'string' ? [patch] : [...patch] })
      .flatMap(file => loadOverlayPatches('wasdengine-game-mcp-overview', file))
  })
  return composeEntries(layers, () => {})
}

/** The packages that rows mount, with the rows of groups and of agent presets' plugins, but not the disabled ones. */
function mountedPackages(rows: readonly unknown[]): string[] {
  return rows.flatMap((row) => {
    if (typeof row !== 'object' || row === null) return []
    const { name, disabled, config } = row as { readonly name?: unknown; readonly disabled?: unknown; readonly config?: unknown }
    if (disabled === true) return []
    const plugins = typeof config === 'object' && config !== null ? (config as { readonly plugins?: unknown }).plugins : undefined
    const nested = Array.isArray(config) ? config : Array.isArray(plugins) ? plugins : []
    return [...typeof name === 'string' ? [name] : [], ...mountedPackages(nested)]
  })
}

/**
 * Whether a package's source registers a game MCP provider: a `gameMcp.provide()` call, as the native tool plugins make,
 * or the `gameMcp` identity that an app plugin passes to `@deepseek-ai/dsh-app-mcp`. Comments that name either do not count.
 */
function registersProvider(dir: string): boolean {
  const src = join(dir, 'src')
  if (!existsSync(src)) return false
  return readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.tsx?$/u.test(file) && !file.endsWith('.d.ts'))
    .some((file) => {
      const code = readFileSync(join(src, file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:\\])\/\/.*$/gmu, '$1')
      return /\.gameMcp\.provide\(|\bgameMcp: \{/u.test(code)
    })
}

/** The provider that an app plugin registers from its own `apply`, with the MCP manager and the tool registry faked. */
async function appProvider(mount: (ctx: Context) => PromiseLike<unknown>): Promise<GameMcpProvider> {
  const provided: GameMcpProvider[] = []
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide('mcpManager', { register: () => () => {}, list: () => [] })
  ctx.provide('tools', { definitions: () => [] })
  ctx.provide('gameMcp', { provide: (provider: GameMcpProvider) => { provided.push(provider); return () => {} } })
  await mount(ctx)
  const [provider, ...more] = provided
  if (provider === undefined || more.length > 0) throw new Error(`the plugin registered ${String(provided.length)} game MCP providers`)
  return provider
}

/** The Godot release that the shipped Godot runtime runs, which the Godot provider's description names. */
function godotRelease(): string | undefined {
  const config = GodotController.Config({ dataRoot: join(DATA, 'godot') })
  return config.libgodotPath === '' ? /^(\d+\.\d+)(?=[.+-]|$)/u.exec(config.runtimeVersion)?.[1] : undefined
}

/** The real provider of each package whose plugin offers game MCP tools, by package name, in the order the app registers them. */
async function shippedProviders(): Promise<ReadonlyMap<string, GameMcpProvider>> {
  // The hosts serve tool calls, which this spec makes none of; the providers' descriptions are what the overview lists.
  const host = {} as never
  const catalog = await loadCatalog(ADDONS)
  return new Map<string, GameMcpProvider>([
    ['@deepseek-ai/dsh-agent-feedback', feedbackMcpProvider(host)],
    ['@deepseek-ai/dsh-art-references', referenceMcpProvider(host)],
    ['@deepseek-ai/dsh-graphics-review', graphicsReviewMcpProvider(host)],
    ['@deepseek-ai/dsh-elevenlabs', elevenLabsMcpProvider(host)],
    ['@deepseek-ai/dsh-image-generation', imageMcpProvider(host)],
    ['@deepseek-ai/dsh-tripo', tripoMcpProvider(host)],
    ['@deepseek-ai/dsh-polyhaven', polyHavenMcpProvider(host)],
    ['@deepseek-ai/dsh-game-audio', audioMcpProvider(host)],
    ['@deepseek-ai/dsh-godot', godotMcpProvider(host, () => Promise.reject(new Error('no runtime in this spec')), godotRelease())],
    ['@deepseek-ai/dsh-game-assets', assetMcpProvider(host)],
    // The Web and Desktop profiles offer the multiplayer tools, which choose the provider's longer description.
    ['@deepseek-ai/dsh-wasd-plugins', wasdMcpProvider([], { claim: () => Promise.resolve() },
      multiplayerMcpTools(multiplayerToolDefinitions(host, MCP_SURFACE)), MULTIPLAYER_MCP_INSTRUCTIONS)],
    ['@deepseek-ai/dsh-blender', await appProvider(ctx => ctx.plugin(Blender, Blender.Config({ dataRoot: join(DATA, 'blender') })))],
    ['@deepseek-ai/dsh-gimp', await appProvider(ctx => ctx.plugin(Gimp, Gimp.Config({ dataRoot: join(DATA, 'gimp') })))],
    ['@deepseek-ai/dsh-supercollider', await appProvider(ctx => ctx.plugin(SuperCollider, SuperCollider.Config({ dataRoot: join(DATA, 'supercollider') })))],
    ['@deepseek-ai/dsh-game-addons', gameAddonMcpProvider({ manager: { catalog }, project: () => Promise.reject(new Error('no project in this spec')) } as never)],
  ])
}

it('builds the provider of every plugin that a shipped profile mounts and whose source registers one', async () => {
  const mounted = new Set(Object.values(PROFILE_TEMPLATES).flatMap(({ bundles }) => mountedPackages(profileRows(bundles))))
  const offering = [...mounted].filter((name) => {
    const dir = packageDirs.get(name)
    return dir !== undefined && registersProvider(dir)
  })
  // The scan finds the providers of the game tool rows, so a plugin that offers tools and that this spec misses fails it.
  expect(offering).toContain('@deepseek-ai/dsh-godot')
  expect(offering).toContain('@deepseek-ai/dsh-blender')
  expect(offering.toSorted(), 'every mounted plugin that registers a game MCP provider, which shippedProviders() must build')
    .toEqual([...(await shippedProviders()).keys()].toSorted())
})

it('fits the overview of the shipped providers in what Claude Code passes to its model, the plugin list last', async () => {
  const providers = [...(await shippedProviders()).values()]
  const overview = new GameToolCatalog(() => providers, () => {}).overview()
  const paragraphs = overview.split('\n\n')
  expect(paragraphs[0]?.length).toBeLessThanOrEqual(512)
  // What to do and what to tell the user come before the plugin list.
  expect(paragraphs[1]).toMatch(/^For a new game, create its project with create_game_project/u)
  expect(paragraphs[2]).toMatch(/are not reasons\.$/u)
  const lines = providers.map(provider => `- ${provider.title} (${provider.id}_*): ${provider.description}`)
  expect(paragraphs[3]?.split('\n')).toEqual(['What each plugin adds:', ...lines])
  expect(overview.length, `the overview has ${String(overview.length)} characters`).toBeLessThanOrEqual(OVERVIEW_LIMIT)
})
