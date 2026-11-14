/**
 * `godot_script` runs and projects that treat GDScript warnings as errors, against the real LibGodot runner: several runs
 * of one script at a fixed frame rate, each with its arguments, its `WASD_OUTPUT_DIR` folder, and a `user://` folder of
 * its own; then a project that sets every warning of the runtime's Godot to error, in which `godot_check` reports the
 * project's own warnings as errors and `godot_run` starts the game, because the harness and the check script compile
 * there too.
 *
 * Set WASD_LIBGODOT_DIR to a folder holding `godot_runner` and the LibGodot library under the name that
 * `wasdengine/libgodot/build.sh` installs: `libgodot.<macos|linuxbsd|windows>.editor.<arm64|x86_64>.<dylib|so|dll>`.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { callTool, compose, text, type Composition } from './composition.ts'

const GODOT_PLATFORMS: Partial<Record<NodeJS.Platform, { readonly name: string; readonly suffix: string }>> = {
  darwin: { name: 'macos', suffix: 'dylib' },
  linux: { name: 'linuxbsd', suffix: 'so' },
  win32: { name: 'windows', suffix: 'dll' },
}
const GODOT_ARCHES: Partial<Record<string, string>> = { arm64: 'arm64', x64: 'x86_64' }

const runtimeDir = process.env.WASD_LIBGODOT_DIR
const platform = GODOT_PLATFORMS[process.platform]
const arch = GODOT_ARCHES[process.arch]
const library = runtimeDir === undefined || platform === undefined || arch === undefined
  ? undefined
  : join(runtimeDir, `libgodot.${platform.name}.editor.${arch}.${platform.suffix}`)
const runner = runtimeDir === undefined ? undefined : join(runtimeDir, process.platform === 'win32' ? 'godot_runner.exe' : 'godot_runner')

const PROJECT_HEAD = 'config_version=5\n\n[application]\n\nconfig/name="ScriptsTest"\nrun/main_scene="res://main.tscn"\nconfig/features=PackedStringArray("4.7")\n'

// Every file compiles with every GDScript warning treated as an error.
const FILES = {
  'main.tscn': '[gd_scene format=3]\n\n[ext_resource type="Script" path="res://main.gd" id="1"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1")\n',
  'main.gd': 'extends Node2D\n\n\nfunc _ready() -> void:\n\tprint("strict main ready")\n',
  'tests/probe.gd': [
    'extends SceneTree', '', 'var _frames: int = 0', 'var _deltas: Array[float] = []', '',
    'func _process(delta: float) -> bool:', '\t_frames += 1', '\t_deltas.append(delta)', '\tif _frames >= 30:',
    '\t\tvar folder: String = OS.get_environment("WASD_OUTPUT_DIR")',
    '\t\tvar file: FileAccess = FileAccess.open(folder.path_join("result.json"), FileAccess.WRITE)',
    '\t\tvar _stored: bool = file.store_string(JSON.stringify({"args": OS.get_cmdline_user_args(), "deltas": _deltas, "user": OS.get_user_data_dir()}))',
    '\t\tfile.close()', '\t\tquit()', '\treturn false', '',
  ].join('\n'),
  'tests/warnings.gd': [
    'extends SceneTree', '', 'func _initialize() -> void:', '\tvar names: PackedStringArray = []',
    '\tfor property: Dictionary in ProjectSettings.get_property_list():', '\t\tvar setting: String = property["name"]',
    '\t\tif setting.begins_with("debug/gdscript/warnings/") and ProjectSettings.get_setting(setting) is int:',
    '\t\t\tvar _added: bool = names.append(setting.trim_prefix("debug/gdscript/warnings/"))',
    '\tvar folder: String = OS.get_environment("WASD_OUTPUT_DIR")',
    '\tvar file: FileAccess = FileAccess.open(folder.path_join("warnings.json"), FileAccess.WRITE)',
    '\tvar _stored: bool = file.store_string(JSON.stringify(names))', '\tfile.close()', '\tquit()', '',
  ].join('\n'),
  'loose.gd': 'extends Node\n\nfunc total():\n\tvar unused = 3\n\treturn 1\n',
}

/** What the probe script writes to its `WASD_OUTPUT_DIR`. */
type ProbeResult = {
  readonly args: string[]
  readonly deltas: number[]
  readonly user: string
}

type RunValue = {
  readonly name: string
  readonly folder: string
  readonly status: string
  readonly files: string[]
}

describe.skipIf(runner === undefined || library === undefined || !existsSync(runner) || !existsSync(library))('godot_script and strict warnings on the real LibGodot runner', () => {
  let c: Composition

  beforeAll(async () => {
    c = await compose({
      game: {},
      config: {
        runnerPath: runner as string, libgodotPath: library as string, importBeforeRun: true,
        startTimeoutMs: 60_000, requestTimeoutMs: 5000, stopGraceMs: 3000, maxScripts: 3,
      },
    })
    await writeFile(join(c.project, 'project.godot'), PROJECT_HEAD)
    await mkdir(join(c.project, 'tests'), { recursive: true })
    for (const [name, content] of Object.entries(FILES)) await writeFile(join(c.project, name), content)
  }, 60_000)

  afterAll(async () => { await c?.cleanup() }, 30_000)

  it('runs a script several times at once at a fixed frame rate, each with its own arguments, files, and user:// folder', async () => {
    const result = await callTool(c, 'godot_script', {
      script: 'res://tests/probe.gd', fixed_fps: 60, args: ['--suite'], runs: [{ name: 'a', args: ['--body=a'] }, { name: 'b', args: ['--body=b'] }, { name: 'c', args: ['--body=c'] }],
    })
    expect(result.isError, text(result)).toBe(false)
    const runs = (result.value as { runs: RunValue[] }).runs
    expect(runs.map(run => [run.status, run.files])).toEqual([['finished', ['result.json']], ['finished', ['result.json']], ['finished', ['result.json']]])
    const results = await Promise.all(runs.map(async run => JSON.parse(await readFile(join(run.folder, 'files', 'result.json'), 'utf8')) as ProbeResult))
    expect(results.map(entry => entry.args)).toEqual([['--suite', '--body=a'], ['--suite', '--body=b'], ['--suite', '--body=c']])
    for (const entry of results) for (const delta of entry.deltas) expect(delta).toBeCloseTo(1 / 60, 9)
    results.forEach((entry, index) => { expect(entry.user.startsWith(join(runs[index]?.folder ?? '', 'home'))).toBe(true) })
  }, 240_000)

  it('checks and runs a project that treats every GDScript warning of the runtime as an error', async () => {
    const listed = await callTool(c, 'godot_script', { script: 'res://tests/warnings.gd' })
    expect(listed.isError, text(listed)).toBe(false)
    const names = JSON.parse(await readFile(join((listed.value as { folder: string }).folder, 'files', 'warnings.json'), 'utf8')) as string[]
    expect(names.length).toBeGreaterThan(40)
    await writeFile(join(c.project, 'project.godot'), `${PROJECT_HEAD}\n[debug]\n\n${names.map(name => `gdscript/warnings/${name}=2`).join('\n')}\n`)

    const check = await callTool(c, 'godot_check', {})
    expect(check.isError, text(check)).toBe(false)
    const files = (check.value as { files: Array<{ path: string; issues: Array<{ message: string }> }> }).files
    expect(files.map(file => file.path)).toEqual(['res://loose.gd'])
    expect(files[0]?.issues.map(issue => issue.message).join('\n')).toContain('(Warning treated as error.)')

    const run = await callTool(c, 'godot_run', {})
    expect(run.isError, text(run)).toBe(false)
    expect(text(run)).toMatch(/^The game is running/u)
    await callTool(c, 'godot_stop', {})
  }, 240_000)
})
