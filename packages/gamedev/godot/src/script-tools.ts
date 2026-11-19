/**
 * The Godot tools that run the project outside a game: `godot_check` and `godot_script`.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { MAX_FIXED_FPS } from './launch.ts'
import { describeRunFolder, formatEngineIssue, formatScriptRuns, issueValue, runValue } from './run-text.ts'
import { DEFAULT_SCRIPT_SECONDS, MAX_SCRIPT_CALL_SECONDS, MAX_SCRIPT_RUNS, MAX_SCRIPT_SECONDS, OUTPUT_DIR_VARIABLE } from './script.ts'
import { DIGEST_SCHEMA, INTEGER, invoke, STRING } from './tool-parts.ts'
import { clip, formatDigest, MESSAGE_CHARS, textResult } from './tool-text.ts'
import type { GodotToolHost, GodotToolSurface } from './tools.ts'

/**
 * The tools that run the project outside a game: its checks and its scripts.
 * @param host - plugin operations the tools call.
 * @param surface - how the callers receive screenshots and pictures, and the tools' wording.
 * @returns the definitions, in catalog order.
 */
export function scriptTools(host: GodotToolHost, surface: GodotToolSurface): ToolDefinition[] {
  const { wording } = surface
  return [
    defineTool({
      name: 'godot_check',
      description: `Check GDScript files for parse and load errors without running the game. Checks paths (${wording.checkPaths}), or every .gd file of the project, at most 400.`,
      parameters: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Scripts or folders to check. Default: the whole project.' },
        project: { type: 'string', description: 'Folder containing project.godot, relative to the working directory. Default: the running game\'s project, else the nearest one.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectDir: STRING,
            checked: INTEGER,
            total: INTEGER,
            importWarning: { type: 'string' },
            files: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: STRING,
                  issues: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        level: STRING,
                        file: STRING,
                        line: { type: 'integer' },
                        message: STRING,
                      },
                    },
                  },
                },
              },
            },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => {
          const scope = value.checked < value.total ? `${value.checked} of ${value.total}` : `${value.checked}`
          const problems = value.files.flatMap(file => file.issues.map(issue => `[${issue.level}] ${issue.file}${issue.line === undefined ? '' : `:${issue.line}`}: ${clip(issue.message, MESSAGE_CHARS)}`))
          const summary = value.files.length === 0 ? `Checked ${scope} scripts in ${value.projectDir}: no errors.` : `Checked ${scope} scripts in ${value.projectDir}; ${value.files.length} have problems:`
          return textResult([...value.importWarning === undefined ? [] : [value.importWarning], summary, ...problems].join('\n'), formatDigest(value))
        },
      },
      async execute(args, exec) {
        return invoke(host, exec, async (agent) => {
          const report = await host.check(agent, {
            ...args.project === undefined ? {} : { project: args.project },
            ...args.paths === undefined ? {} : { paths: args.paths },
          }, exec.signal)
          return {
            projectDir: report.projectDir,
            checked: report.scripts.length,
            total: report.total,
            ...report.importWarning === undefined ? {} : { importWarning: report.importWarning },
            files: report.scripts
              .filter(script => script.issues.length > 0)
              .map(script => ({ path: script.path, issues: [...script.issues] })),
          }
        })
      },
    }),
    defineTool({
      name: 'godot_script',
      description: `Run a GDScript that extends SceneTree or MainLoop against the project in a headless Godot, without running the game, and report the end of what it printed: test runners such as GUT's or GdUnit4's, build or generator scripts, and measurements, which runs repeats at once with other arguments and fixed_fps makes repeatable. The script is ${wording.scriptPath}; args reach it after --, where OS.get_cmdline_user_args() reads them. Each run gets a folder with stdout.log, stderr.log, and files/, which the environment variable ${OUTPUT_DIR_VARIABLE} names: write results there, and the report lists them. Runs share the project, so they should write only there; with runs, each also gets its own user:// folder. It imports the project first, as godot_run does. The script must quit itself with quit(); the built-in Godot does not pass on its exit code, so judge the result by what it prints or writes.`,
      parameters: {
        script: { type: 'string', required: true, description: 'The script to run, such as res://addons/gut/gut_cmdln.gd.' },
        args: { type: 'array', items: { type: 'string' }, description: 'User arguments passed after --; with runs, before each run\'s own. Default: none.' },
        runs: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              args: { type: 'array', items: { type: 'string' }, description: 'Arguments of this run, after args.' },
              name: { type: 'string', description: 'Name in the run\'s folder and the report.' },
            },
          },
          description: `One run per entry, 1 to ${MAX_SCRIPT_RUNS}, as many at once as this computer allows, all within ${MAX_SCRIPT_CALL_SECONDS / 60} minutes. Default: one run with args.`,
        },
        fixed_fps: {
          type: 'integer',
          description: `Game time per frame is 1/fixed_fps s however long frames take (Godot's --fixed-fps), so runs repeat exactly and finish as fast as they can; 1 to ${MAX_FIXED_FPS}. Default: real time.`,
        },
        exclusive: {
          type: 'boolean',
          description: 'Run the runs one at a time while no other godot_script run, check, or export runs, for timing measurements. Default: false.',
        },
        timeout_seconds: { type: 'integer', description: `Time limit of each run in seconds, from 1 to ${MAX_SCRIPT_SECONDS}. Default: ${DEFAULT_SCRIPT_SECONDS}.` },
        project: { type: 'string', description: 'Folder containing project.godot, relative to the working directory. Default: the running game\'s project, else the nearest one.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projectDir: STRING,
            script: STRING,
            exitCode: { type: 'integer', description: 'Exit code of the Godot runner: 0 once the script quit, another value when the runner itself failed; absent when a signal or the time limit ended it.' },
            timedOut: { type: 'boolean' },
            durationMs: INTEGER,
            output: { type: 'string' },
            omittedLines: { type: 'integer' },
            issues: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: { level: STRING, file: { type: 'string' }, line: { type: 'integer' }, message: STRING } },
            },
            totalIssues: { type: 'integer' },
            folder: { type: 'string', description: 'Folder of the run, for a call without runs.' },
            files: { type: 'array', items: { type: 'string' } },
            totalFiles: { type: 'integer' },
            resultsDir: { type: 'string', description: 'Folder of a call with runs: summary.json and one folder per run.' },
            fixedFps: { type: 'integer' },
            parallel: { type: 'integer' },
            importIssues: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: { level: STRING, file: { type: 'string' }, line: { type: 'integer' }, message: STRING } },
            },
            runs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  args: { type: 'array', items: { type: 'string' }, required: true },
                  folder: STRING,
                  status: { type: 'string', enum: ['finished', 'timed-out', 'ended', 'not-started'], required: true },
                  exitCode: { type: 'integer' },
                  reason: { type: 'string' },
                  durationMs: INTEGER,
                  files: { type: 'array', items: { type: 'string' }, required: true },
                  totalFiles: INTEGER,
                  issues: {
                    type: 'array',
                    required: true,
                    items: { type: 'object', additionalProperties: false, properties: { level: STRING, file: { type: 'string' }, line: { type: 'integer' }, message: STRING } },
                  },
                  totalIssues: INTEGER,
                  lastLine: { type: 'string' },
                },
              },
            },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => {
          if (value.runs !== undefined) return textResult(formatScriptRuns(value.script, value), formatDigest(value))
          const seconds = (value.durationMs / 1000).toFixed(1)
          const ended = value.timedOut === true
            ? `did not finish within its time limit and was stopped after ${seconds} s.`
            : value.exitCode === undefined
              ? 'was ended by a signal.'
              : value.exitCode === 0
                ? `finished after ${seconds} s. The built-in Godot does not report the script's own exit code; read the result from its output.`
                : `could not run: the Godot runner failed with exit code ${value.exitCode} after ${seconds} s.`
          const lines = [`${value.script} ${ended}`]
          if (value.folder !== undefined) lines.push(describeRunFolder(value.folder, value.files ?? [], value.totalFiles ?? 0))
          const issues = value.issues ?? []
          if (issues.length > 0) lines.push(`Engine errors (${value.totalIssues ?? issues.length}):`, ...issues.map(formatEngineIssue))
          const output = value.output ?? ''
          const omitted = value.omittedLines ?? 0
          lines.push(output === '' ? 'It printed nothing.' : `${omitted > 0 ? `Output (last lines; ${omitted} earlier lines left out):` : 'Output:'}\n${output}`)
          return textResult(lines.join('\n'), formatDigest(value))
        },
      },
      timeoutMs: (MAX_SCRIPT_CALL_SECONDS + 600) * 1000,
      async execute(args, exec) {
        return invoke(host, exec, async (agent) => {
          const report = await host.script(agent, {
            script: args.script,
            ...args.project === undefined ? {} : { project: args.project },
            ...args.args === undefined ? {} : { args: args.args },
            ...args.timeout_seconds === undefined ? {} : { timeoutSeconds: args.timeout_seconds },
            ...args.runs === undefined ? {} : { runs: args.runs },
            ...args.fixed_fps === undefined ? {} : { fixedFps: args.fixed_fps },
            ...args.exclusive === undefined ? {} : { exclusive: args.exclusive },
          }, exec.signal)
          if ('runs' in report) {
            return {
              projectDir: report.projectDir,
              script: report.script,
              durationMs: report.durationMs,
              resultsDir: report.resultsDir,
              ...report.fixedFps === undefined ? {} : { fixedFps: report.fixedFps },
              parallel: report.parallel,
              importIssues: report.importIssues.map(issueValue),
              runs: report.runs.map(runValue),
            }
          }
          return {
            projectDir: report.projectDir,
            script: report.script,
            ...report.exitCode === null ? {} : { exitCode: report.exitCode },
            timedOut: report.timedOut,
            durationMs: report.durationMs,
            output: report.output,
            omittedLines: report.omittedLines,
            issues: report.issues.map(issueValue),
            totalIssues: report.totalIssues,
            folder: report.folder,
            files: [...report.files],
            totalFiles: report.totalFiles,
          }
        })
      },
    }),
  ]
}
