/**
 * WASDEngine fork guard: every plugin row of the agent presets that the Web and Desktop apps ship loads from its built
 * package under plain Node, resolved from this bundle, which declares the presets. The preset registry imports a
 * preset's rows only when a Session selects the preset, so no startup check loads them, and a row whose built file
 * does not load fails every Session of that preset with `agent-preset/invalid`. Specs resolve workspace packages to
 * `src`, so only the built files show such a failure, for example a package bundled into another package's `lib/`
 * from its source because the manifest lists it only in `devDependencies`. The spec skips until the packages are
 * built; `wasdengine/FORK.md` and the fork's checks run it after the build.
 */

import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { PROFILE_TEMPLATES } from '@deepseek-ai/dsh-official-bundles'

const webAppDir = fileURLToPath(new URL('..', import.meta.url))
const bundleRoot = resolve(webAppDir, '..')

/** The package whose rows declare an agent preset. */
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'

/** Longest time the subprocess may take to import every row's package. */
const IMPORT_TIMEOUT_MS = 60_000

interface BundleManifest {
  name: string
  dsh?: { bundle?: { patch: string | string[] } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rowsOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}

/** Workspace directory of each bundle package under `packages/bundle`, by package name. */
const bundleDirs = new Map(readdirSync(bundleRoot, { withFileTypes: true }).flatMap((entry) => {
  if (!entry.isDirectory()) return []
  try {
    const manifest = JSON.parse(readFileSync(join(bundleRoot, entry.name, 'package.json'), 'utf8')) as BundleManifest
    return [[manifest.name, join(bundleRoot, entry.name)] as const]
  } catch (error) {
    // A directory without a manifest, such as a stale build folder, is no bundle.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}))

/** The rows a shipped profile template composes from its bundles' patch files. */
function profileRows(name: string): EntryOptions[] {
  const template = PROFILE_TEMPLATES[name]
  if (template === undefined) throw new Error(`no shipped profile template ${name}`)
  const layers = template.bundles.map((bundle) => {
    const dir = bundleDirs.get(bundle)
    if (dir === undefined) throw new Error(`profile bundle ${bundle} is not a package under packages/bundle`)
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as BundleManifest
    const patch = manifest.dsh?.bundle?.patch ?? []
    return bundlePatchPaths(dir, { patch: typeof patch === 'string' ? [patch] : patch })
      .flatMap(file => loadOverlayPatches('wasdengine-preset-rows', file))
  })
  return composeEntries(layers, () => {})
}

/** The enabled rows of one preset's plugin list, including rows nested in groups, as `preset/row` ids with packages. */
function presetPackages(preset: EntryOptions): { row: string; name: string }[] {
  const config: unknown = preset.config
  if (!isRecord(config)) return []
  const walk = (rows: Record<string, unknown>[], path: string): { row: string; name: string }[] => rows.flatMap((row) => {
    if (row.disabled === true) return []
    const id = `${path}/${String(row.id)}`
    if (row.group === true) return walk(rowsOf(row.config), id)
    const name = String(row.name)
    // A `cordis:` row names a Loader builtin, which no package supplies.
    return name.startsWith('cordis:') ? [] : [{ row: id, name }]
  })
  return walk(rowsOf(config.plugins), String(config.id))
}

const presets = profileRows('web').filter(row => row.name === PRESET_PLUGIN)
const rows = presets.flatMap(presetPackages)
const packages = [...new Set(rows.map(row => row.name))].sort()

const requireFromBundle = createRequire(join(webAppDir, 'package.json'))

/**
 * Whether a package resolves from this bundle to a file that exists, as it does once it is built. Only the skip
 * decision reads it, so any resolution failure counts as unbuilt; the import below reports the failure itself.
 */
function isBuilt(name: string): boolean {
  try {
    requireFromBundle.resolve(name)
    return true
  } catch {
    // An unbuilt package's entry file is missing, and an import-only export map refuses `require` resolution.
    return false
  }
}

/** Imports each named package in turn, by name, and prints the failures as a JSON list. */
const IMPORT_SCRIPT = `
const failures = []
for (const name of JSON.parse(process.env.WASD_PRESET_PACKAGES)) {
  try {
    await import(name)
  } catch (error) {
    failures.push(name + ': ' + (error instanceof Error ? error.name + ': ' + error.message.split('\\n')[0] : String(error)))
  }
}
process.stdout.write(JSON.stringify(failures))
`

describe('shipped agent preset rows', () => {
  it('come from the gamedev and cordis presets, rows nested in groups included', () => {
    const ids = presets.map((preset) => {
      const config: unknown = preset.config
      return isRecord(config) ? config.id : undefined
    }).sort()
    expect(ids).toEqual(['cordis', 'gamedev'])
    expect(rows.map(row => row.row)).toEqual(expect.arrayContaining([
      'gamedev/todo-continuation', 'gamedev/compaction/compaction-basic', 'gamedev/planning/plan-mode',
    ]))
    expect(packages).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-todo-continuation', '@deepseek-ai/dsh-plan-mode']))
  })

  it.skipIf(!packages.some(isBuilt))('load from their built packages under plain Node, resolved from this bundle', async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--eval', IMPORT_SCRIPT], {
      cwd: webAppDir,
      // No inherited import hooks: the subprocess loads each package's built entry file, as the apps do.
      env: { ...process.env, NODE_OPTIONS: '', WASD_PRESET_PACKAGES: JSON.stringify(packages) },
      timeout: IMPORT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    })
    expect(JSON.parse(stdout) as string[]).toEqual([])
  }, IMPORT_TIMEOUT_MS + 10_000)
})
