/**
 * The text of the Godot tools' script and scene results: a script call's runs with their engine issues, output folders,
 * and files, and a running game's scene tree.
 */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { OUTPUT_DIR_VARIABLE, type EngineIssue, type ScriptRunResult } from './script.ts'
import { clip, MESSAGE_CHARS } from './tool-text.ts'

/** An engine issue as a result value holds it. */
interface IssueValue {
  readonly level: string
  readonly message: string
  readonly file?: string
  readonly line?: number
}

/** A run of a call with runs as a result value holds it. */
interface RunValue {
  readonly name?: string
  readonly args: string[]
  readonly folder: string
  readonly status: ScriptRunResult['status']
  readonly exitCode?: number
  readonly reason?: string
  readonly durationMs: number
  readonly files: string[]
  readonly totalFiles: number
  readonly issues: IssueValue[]
  readonly totalIssues: number
  readonly lastLine?: string
}

/**
 * An engine issue as a result value holds it.
 * @param issue - the issue the engine printed.
 * @returns its level and message, and its file and line when it names them.
 */
export function issueValue(issue: EngineIssue): IssueValue {
  return {
    level: issue.level,
    message: issue.message,
    ...issue.file === undefined ? {} : { file: issue.file },
    ...issue.line === undefined ? {} : { line: issue.line },
  }
}

/**
 * A run of a call with runs as a result value holds it.
 * @param run - the run's result.
 * @returns its fields.
 */
export function runValue(run: ScriptRunResult): RunValue {
  return {
    ...run.name === undefined ? {} : { name: run.name },
    args: [...run.args],
    folder: run.folder,
    status: run.status,
    ...run.exitCode === undefined ? {} : { exitCode: run.exitCode },
    ...run.reason === undefined ? {} : { reason: run.reason },
    durationMs: run.durationMs,
    files: [...run.files],
    totalFiles: run.totalFiles,
    issues: run.issues.map(issueValue),
    totalIssues: run.totalIssues,
    ...run.lastLine === undefined ? {} : { lastLine: run.lastLine },
  }
}

/**
 * One engine issue as a line of a script result.
 * @param issue - the issue.
 * @returns the line.
 */
export function formatEngineIssue(issue: IssueValue): string {
  return `[${issue.level}] ${issue.file === undefined ? '' : `${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}: `}${clip(issue.message, MESSAGE_CHARS)}`
}

/** Most file names that a script result names for one run. */
const NAMED_RUN_FILES = 5

/** The files a run wrote, as a phrase: the first few names, then how many more. */
function describeFiles(files: readonly string[], total: number): string {
  if (total === 0) return 'no files'
  const named = files.slice(0, NAMED_RUN_FILES).join(', ')
  return total > NAMED_RUN_FILES ? `${named}, and ${total - NAMED_RUN_FILES} more` : named
}

/**
 * Describe the folder of a call's only run.
 * @param folder - absolute folder.
 * @param files - files the script wrote to `files/`, relative to it.
 * @param total - files in `files/` in all.
 * @returns one line.
 */
export function describeRunFolder(folder: string, files: readonly string[], total: number): string {
  return `Its folder ${folder} keeps stdout.log and stderr.log; files the script wrote to ${OUTPUT_DIR_VARIABLE} (files/): ${describeFiles(files, total)}.`
}

/** The phrase of a run's end in a call with runs. */
function describeRunEnd(run: Pick<RunValue, 'durationMs' | 'exitCode' | 'reason'> & { readonly status: string }): string {
  const seconds = (run.durationMs / 1000).toFixed(1)
  switch (run.status) {
    case 'finished':
      return `finished in ${seconds} s`
    case 'timed-out':
      return `timed out after ${seconds} s`
    case 'not-started':
      return `did not start: ${run.reason ?? 'unknown reason'}`
    default:
      return run.exitCode === undefined ? `was ended by a signal after ${seconds} s` : `failed: the Godot runner exited with code ${run.exitCode} after ${seconds} s`
  }
}

/**
 * Format the result of a call with runs: a summary line, the call's folder, the import errors, and one line per run.
 * @param script - `res://` path of the script.
 * @param value - the result value.
 * @returns the text.
 */
export function formatScriptRuns(script: string, value: {
  readonly durationMs: number
  readonly resultsDir?: string
  readonly fixedFps?: number
  readonly parallel?: number
  readonly importIssues?: readonly IssueValue[]
  readonly runs?: ReadonlyArray<Omit<RunValue, 'status'> & { readonly status: string }>
}): string {
  const runs = value.runs ?? []
  const counts = new Map<string, number>()
  for (const run of runs) counts.set(run.status, (counts.get(run.status) ?? 0) + 1)
  const tally = [
    ['finished', 'finished'], ['timed-out', 'timed out'], ['ended', 'failed'], ['not-started', 'did not start'],
  ].flatMap(([status, words]) => counts.has(status as string) ? [`${String(counts.get(status as string))} ${words as string}`] : []).join(', ')
  const pace = value.fixedFps === undefined ? '' : ` at a fixed ${value.fixedFps} FPS`
  const lines = [
    `Ran ${script} ${runs.length === 1 ? 'once' : `${runs.length} times, up to ${value.parallel ?? 1} at a time`}${pace}, in ${(value.durationMs / 1000).toFixed(1)} s: ${tally}.`,
    `The call's folder ${value.resultsDir ?? '(unknown)'} holds summary.json, with every run's details, and one folder per run with stdout.log, stderr.log, files/ (its ${OUTPUT_DIR_VARIABLE}), and home/, which holds its user:// folder.`,
  ]
  const importIssues = value.importIssues ?? []
  if (importIssues.length > 0) lines.push('Errors of the import before the runs:', ...importIssues.map(formatEngineIssue))
  runs.forEach((run, index) => {
    const parts = [`${String(index + 1)}${run.name === undefined ? '' : ` ${run.name}`}: ${describeRunEnd(run)}`]
    if (run.status !== 'not-started') parts.push(`files: ${describeFiles(run.files, run.totalFiles)}`)
    const first = run.issues[0]
    if (first !== undefined) parts.push(`${run.totalIssues} engine error${run.totalIssues === 1 ? '' : 's'}, first: ${formatEngineIssue(first)}`)
    if (run.lastLine !== undefined) parts.push(`last line: ${run.lastLine}`)
    lines.push(parts.join('; '))
  })
  return lines.join('\n')
}

/** A scene tree node as the harness describes it. */
interface SceneNode {
  readonly name?: JsonValue
  readonly class?: JsonValue
  readonly script?: JsonValue
  readonly position?: JsonValue
  readonly size?: JsonValue
  readonly visible?: JsonValue
  readonly text?: JsonValue
  readonly processDisabled?: JsonValue
  readonly childCount?: JsonValue
  readonly children?: JsonValue
}

function label(value: JsonValue | undefined): string {
  if (value === undefined) return '?'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function isNode(value: JsonValue): value is { [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A Godot vector of a scene tree node as text.
 * @param value - the node's value: an array of numbers, or anything else.
 * @returns the numbers, rounded to two decimals, in parentheses; undefined for a value that is no vector.
 */
export function formatVector(value: JsonValue | undefined): string | undefined {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'number')) return undefined
  return `(${value.map(item => Number(item.toFixed(2))).join(', ')})`
}

/**
 * Format a scene tree description as an indented outline.
 * @param tree - root node from the harness.
 * @returns one line per node.
 */
export function formatTree(tree: JsonValue): string {
  const lines: string[] = []
  const visit = (value: JsonValue, depth: number): void => {
    if (!isNode(value)) return
    const node: SceneNode = value
    const position = formatVector(node.position)
    const size = formatVector(node.size)
    const parts = [
      `${'  '.repeat(depth)}${label(node.name)} (${label(node.class)})`,
      typeof node.script === 'string' ? node.script : '',
      position === undefined ? '' : `position ${position}`,
      size === undefined ? '' : `size ${size}`,
      node.visible === false ? 'hidden' : '',
      typeof node.text === 'string' ? `text ${JSON.stringify(clip(node.text, 80))}` : '',
      node.processDisabled === true ? 'processing disabled' : '',
      typeof node.childCount === 'number' && !Array.isArray(node.children) ? `${node.childCount} children not listed` : '',
    ]
    lines.push(parts.filter(part => part !== '').join(' '))
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, depth + 1)
  }
  visit(tree, 0)
  return lines.join('\n')
}
