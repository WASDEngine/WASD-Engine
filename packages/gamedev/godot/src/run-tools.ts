/**
 * The Godot tools that start and stop the Session's game: `godot_run` and `godot_stop`.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { parseWindowSize } from './input.ts'
import { GODOT_ENGINE_OPTIONS } from './launch.ts'
import { isErrorEntry } from './logs.ts'
import { screenshotAfter } from './screenshot-capture.ts'
import {
  BOOLEAN, DIGEST_SCHEMA, ENTRY_SCHEMA, INTEGER, invoke, NUMBER, SCREENSHOT_SCHEMA, STARTUP_ENTRIES, STARTUP_LOG_WINDOW_MS, STRING,
  WEB_RUN_DESCRIPTION,
} from './tool-parts.ts'
import {
  describeOutcome, describeStartWait, formatDigest, formatLogEntry, screenshotBlocks, textResult, toolLogEntry, type StartWait,
} from './tool-text.ts'
import type { GodotToolHost, GodotToolSurface } from './tools.ts'

/**
 * The tools that start and stop the Session's game.
 * @param host - plugin operations the tools call.
 * @param surface - how the callers receive screenshots and pictures, and the tools' wording.
 * @returns the definitions, in catalog order.
 */
export function runTools(host: GodotToolHost, surface: GodotToolSurface): ToolDefinition[] {
  const { wording } = surface
  return [
    defineTool({
      name: 'godot_run',
      description: wording.run
        + 'Reports the window size, the renderer, and the errors and warnings logged while importing and starting. Pass screenshot to '
        + 'see the game in the same call, after wait seconds of game time when it needs them to settle; then play with godot_input.',
      parameters: {
        project: { type: 'string', description: 'Folder containing project.godot, relative to the working directory. Default: the nearest project.godot.' },
        scene: { type: 'string', description: 'res:// path of a scene to run instead of the main scene.' },
        width: { type: 'integer', description: 'Game window width in pixels; give height too.' },
        height: { type: 'integer', description: 'Game window height in pixels; give width too.' },
        muted: { type: 'boolean', description: `Run without audio. Default: ${String(host.agentRunsMuted)}.` },
        web: { type: 'boolean', description: WEB_RUN_DESCRIPTION },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Launch options for the game itself: arguments it reads with OS.get_cmdline_user_args(), such as a test or capture mode the game offers. Default: none.',
        },
        engine_args: {
          type: 'array',
          items: { type: 'string' },
          description: `Godot command-line options, each followed by its value: ${Object.keys(GODOT_ENGINE_OPTIONS).join(', ')}. `
            + '["--fixed-fps", "30"] makes every frame advance 1/30 s of game time however fast or slow it draws, so godot_record keeps every '
            + 'frame; --max-fps does not slow such a game. --time-scale speeds the game up or slows it down. Default: none.',
        },
        wait: { type: 'number', description: 'Seconds of game time to let pass once the game runs, before the screenshot, such as for an intro or a camera move. Default: none.' },
        screenshot: { type: 'boolean', description: 'Capture a screenshot once the game runs, after wait.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            runId: STRING,
            phase: STRING,
            projectDir: STRING,
            projectName: { type: 'string' },
            scene: { type: 'string' },
            width: INTEGER,
            height: INTEGER,
            renderer: STRING,
            godot: STRING,
            windowless: BOOLEAN,
            muted: BOOLEAN,
            web: { type: 'boolean' },
            scale: { type: 'integer', description: 'The whole factor by which the window grew from the project\'s small window size.' },
            args: { type: 'array', items: { type: 'string' } },
            engineArgs: { type: 'array', items: { type: 'string' } },
            issues: { type: 'array', items: ENTRY_SCHEMA, required: true },
            moreIssues: INTEGER,
            waited: {
              type: 'object',
              additionalProperties: false,
              properties: { frames: INTEGER, seconds: NUMBER, timedOut: BOOLEAN, paused: BOOLEAN },
              description: 'The wait after the start; paused when the game was paused, so no game time passed.',
            },
            screenshot: SCREENSHOT_SCHEMA,
            screenshotError: { type: 'string' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => {
          const window = value.scale === undefined
            ? `window ${value.width}x${value.height}`
            : `window ${value.width}x${value.height} (the project's ${value.width / value.scale}x${value.height / value.scale} grown ${value.scale}x; pass width and height for another size)`
          const facts = [
            ...value.scene === undefined ? [] : [`scene ${value.scene}`],
            window,
            `renderer ${value.renderer}${value.web === true ? ' as on the Web' : ''}`,
            `Godot ${value.godot}`,
            ...value.windowless ? ['windowless'] : [],
            ...value.muted ? ['muted'] : [],
            ...value.engineArgs === undefined ? [] : [`Godot options ${value.engineArgs.join(' ')}`],
            ...value.args === undefined ? [] : [`game arguments ${JSON.stringify(value.args)}`],
          ].join(', ')
          const name = value.projectName === undefined ? value.projectDir : `${value.projectName} (${value.projectDir})`
          const issues = value.issues.length === 0
            ? 'No errors or warnings were logged while importing and starting.'
            : `Errors and warnings logged while importing and starting:\n${value.issues.map(formatLogEntry).join('\n')}${value.moreIssues > 0 ? `\n… and ${value.moreIssues} more; read them with godot_logs.` : ''}`
          return [
            ...textResult(`The game is ${value.phase}: ${name}; ${facts}.`, issues, describeStartWait(value.waited), describeOutcome(value, 'the start'), formatDigest(value)),
            ...value.screenshot === undefined ? [] : screenshotBlocks(value.screenshot),
          ]
        },
      },
      async execute(args, exec) {
        const size = parseWindowSize(args.width, args.height)
        if (args.wait !== undefined && !(args.wait > 0)) throw new Error('wait must be positive.')
        return invoke(host, exec, async (agent, session) => {
          // A caller that cannot receive the screenshot fails before the game starts.
          const target = args.screenshot === true ? await surface.screenshots(exec, agent) : undefined
          const run = await host.run(agent, {
            ...args.project === undefined ? {} : { project: args.project },
            ...args.scene === undefined ? {} : { scene: args.scene },
            ...size,
            muted: args.muted ?? host.agentRunsMuted,
            ...args.web === true ? { web: true } : {},
            ...args.args === undefined ? {} : { args: args.args },
            ...args.engine_args === undefined ? {} : { engineArgs: args.engine_args },
          }, exec.signal)
          let timer: NodeJS.Timeout | undefined
          await Promise.race([run.whenEnded(), new Promise<void>((resolve) => { timer = setTimeout(resolve, STARTUP_LOG_WINDOW_MS) })])
          clearTimeout(timer)
          exec.signal.throwIfAborted()
          const view = run.view()
          const issues = run.logs.filter(entry => isErrorEntry(entry) || entry.level === 'warning').map(toolLogEntry)
          session.digestCursor = Math.max(session.digestCursor, run.logs.lastSeq)
          // The failure of a run that has ended, read afresh each time, since the game can end during the wait.
          const ended = (): Error | undefined => {
            if (!run.terminal) return undefined
            const now = run.view()
            const listed = run.logs.filter(entry => isErrorEntry(entry) || entry.level === 'warning').map(toolLogEntry)
              .slice(0, STARTUP_ENTRIES).map(formatLogEntry).join('\n')
            return new Error(`The game did not keep running (${now.phase}).${now.message === undefined ? '' : `\n${now.message}`}${listed === '' ? '' : `\nErrors and warnings:\n${listed}`}`)
          }
          const failure = ended()
          if (failure !== undefined) throw failure
          let waited: StartWait | undefined
          if (args.wait !== undefined) {
            if (view.phase === 'paused') {
              waited = { frames: 0, seconds: 0, timedOut: false, paused: true }
            } else {
              try {
                const reply = await run.wait({ seconds: args.wait }, exec.signal)
                waited = { frames: reply.frames, seconds: reply.seconds, timedOut: reply.timedOut, paused: false }
              } catch (error) {
                exec.signal.throwIfAborted()
                throw ended() ?? error
              }
            }
          }
          // A started run that has not ended connected once, so the game reported its window, renderer, and version.
          return {
            runId: view.runId,
            phase: view.phase,
            projectDir: view.projectDir,
            ...view.projectName === undefined ? {} : { projectName: view.projectName },
            ...view.scene === undefined ? {} : { scene: view.scene },
            width: view.width as number,
            height: view.height as number,
            renderer: view.renderer as string,
            godot: run.godotVersion as string,
            windowless: view.windowless,
            muted: view.muted,
            ...view.launch.web === true ? { web: true } : {},
            ...view.launch.scale === undefined ? {} : { scale: view.launch.scale },
            ...view.launch.args === undefined ? {} : { args: [...view.launch.args] },
            ...view.launch.engineArgs === undefined ? {} : { engineArgs: [...view.launch.engineArgs] },
            issues: issues.slice(0, STARTUP_ENTRIES),
            moreIssues: Math.max(0, issues.length - STARTUP_ENTRIES),
            ...waited === undefined ? {} : { waited },
            ...target === undefined ? {} : await screenshotAfter(target, session, run, exec.signal),
          }
        })
      },
    }),
    defineTool({
      name: 'godot_stop',
      description: 'Stop the running game.',
      parameters: {},
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { stopped: BOOLEAN, ...DIGEST_SCHEMA } },
        render: (_args, value) => textResult(value.stopped ? 'Stopped the game.' : 'No game was running.', formatDigest(value)),
      },
      async execute(_args, exec) {
        return invoke(host, exec, async (_agent, session) => {
          const running = session.run !== undefined && !session.run.terminal
          await host.sessions.stop(session)
          return { stopped: running }
        })
      },
    }),
  ]
}
