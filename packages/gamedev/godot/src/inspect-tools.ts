/**
 * The Godot tools that inspect the running game: `godot_eval`, `godot_scene_tree`, `godot_performance`, `godot_audio`,
 * and `godot_logs`.
 */
import { analyzeAudio, describeAudioImage, drawAudioImage, type AudioSamples } from '@deepseek-ai/dsh-game-audio/audio'
import { encodePng } from '@deepseek-ai/dsh-game-audio/png'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { applyMasterVolume, AUDIO_PROPERTIES, describeAudio, encodeWav, summarizeAudio } from './audio.ts'
import { parseInputEvents } from './input.ts'
import { formatPerformance, PERFORMANCE_PROPERTIES, summarizePerformance } from './performance.ts'
import { formatTree } from './run-text.ts'
import { MAX_INPUT_EVENTS } from './run.ts'
import { captureWithInput, checkSaveArgs, holdSaveFile, savingTo, screenshotAfter } from './screenshot-capture.ts'
import {
  AUDIO_SECONDS, BOOLEAN, boundedInteger, CODE_SECONDS, DIGEST_SCHEMA, ENTRY_SCHEMA, EVENT_SCHEMA, IMAGE_OBJECT, INTEGER, invoke, LEVELS,
  PERFORMANCE_SECONDS, requireRunning, SCREENSHOT_SCHEMA, STRING, windowEvents,
} from './tool-parts.ts'
import {
  describeOutcome, formatDigest, formatLogEntry, imageBlocks, screenshotBlocks, TEXT_BUDGET, textResult, toolLogEntry, type ToolLogEntry,
} from './tool-text.ts'
import type { GodotToolHost, GodotToolSurface } from './tools.ts'
import type { GodotLogLevel } from './types.ts'

/**
 * The tools that inspect the running game: its expressions, scene tree, performance, audio, and logs.
 * @param host - plugin operations the tools call.
 * @param surface - how the callers receive screenshots and pictures, and the tools' wording.
 * @returns the definitions, in catalog order.
 */
export function inspectTools(host: GodotToolHost, surface: GodotToolSurface): ToolDefinition[] {
  const { wording } = surface
  return [
    defineTool({
      name: 'godot_eval',
      description: 'Evaluate a Godot Expression in the running game and return its value, for example scene.get_node("Player").position, '
        + 'or run GDScript code there with code. In an expression, the names scene (the current scene), root, tree, the engine singletons '
        + 'such as Input, OS, and ResourceLoader, and the autoloads are defined; method calls without a base run on node, or on the current scene. '
        + 'code runs as the body of a function, so it may declare variables, loop, use lambdas and await, and set up a capture or test '
        + 'without changing the game\'s files; it returns its value with return, and a single expression returns its value.',
      parameters: {
        expression: { type: 'string', description: 'A Godot Expression. Give expression or code.' },
        code: {
          type: 'string',
          description: 'GDScript statements, indented as a function body; tree, root, scene (the current scene), and node (the object at the node path, else the current scene) are defined, get_tree() works, and await waits for signals such as get_tree().process_frame.',
        },
        node: { type: 'string', description: 'Node path of the base object, for example /root/Main/Player.' },
        timeout_seconds: {
          type: 'number',
          description: `code: real seconds to wait for code that awaits, from ${CODE_SECONDS.min} to ${CODE_SECONDS.max}; the code keeps running after them. Default: ${CODE_SECONDS.default}.`,
        },
        screenshot: { type: 'boolean', description: 'Capture a screenshot after the evaluation, to see what it changed.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            value: { type: 'json', required: true },
            valueType: STRING,
            screenshot: SCREENSHOT_SCHEMA,
            screenshotError: { type: 'string' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => [
          ...textResult(`${value.valueType}: ${JSON.stringify(value.value)}`, describeOutcome(value, 'the evaluation'), formatDigest(value)),
          ...value.screenshot === undefined ? [] : screenshotBlocks(value.screenshot),
        ],
      },
      timeoutMs: (CODE_SECONDS.max + 60) * 1000,
      async execute(args, exec) {
        if ((args.expression === undefined) === (args.code === undefined)) throw new Error('Give either expression or code.')
        const source = (args.expression ?? args.code) as string
        if (source.trim() === '') throw new Error(`${args.code === undefined ? 'expression' : 'code'} must not be empty.`)
        const seconds = args.timeout_seconds ?? CODE_SECONDS.default
        if (!(seconds >= CODE_SECONDS.min && seconds <= CODE_SECONDS.max)) {
          throw new Error(`timeout_seconds must be from ${CODE_SECONDS.min} to ${CODE_SECONDS.max}.`)
        }
        return invoke(host, exec, async (agent, session) => {
          const run = requireRunning(session)
          const target = args.screenshot === true ? await surface.screenshots(exec, agent) : undefined
          const reply = args.code === undefined
            ? await run.evaluate(source, args.node, exec.signal)
            : await run.runCode(source, args.node, seconds * 1000, exec.signal)
          return {
            value: reply.value,
            valueType: reply.valueType,
            ...target === undefined ? {} : await screenshotAfter(target, session, run, exec.signal),
          }
        })
      },
    }),
    defineTool({
      name: 'godot_scene_tree',
      description: 'Describe the running game\'s scene tree: node names, classes, scripts, positions, sizes, visibility, and label text.',
      parameters: {
        node: { type: 'string', description: 'Node path to start from. Default: the current scene.' },
        depth: { type: 'integer', description: 'Levels below the start node. Default: 6.' },
        max_nodes: { type: 'integer', description: 'Most nodes described. Default: 400.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { tree: { type: 'json', required: true }, truncated: BOOLEAN, ...DIGEST_SCHEMA },
        },
        render: (_args, value) => textResult(
          formatTree(value.tree),
          value.truncated ? 'The node limit cut the tree; narrow it with node or depth.' : '',
          formatDigest(value),
        ),
      },
      async execute(args, exec) {
        const depth = boundedInteger(args.depth, 'depth', 6, 0, 64)
        const maxNodes = boundedInteger(args.max_nodes, 'max_nodes', 400, 1, 5000)
        return invoke(host, exec, async (_agent, session) => {
          const reply = await requireRunning(session).tree(args.node, depth, maxNodes, exec.signal)
          return { tree: reply.tree, truncated: reply.truncated }
        })
      },
    }),
    defineTool({
      name: 'godot_performance',
      description: 'Measure the running game\'s performance over seconds of real time: frame rate and frame time percentiles, '
        + 'milliseconds per frame in physics, scripts, and drawing, GPU time, draw calls, memory, object and orphan node counts, '
        + 'physics bodies, pipeline compilations, the most common node classes and scripts, and custom Performance monitors. '
        + 'Then, for as many seconds again, it profiles the game\'s scripts: milliseconds per frame of each script and its costliest '
        + 'functions, and with engine_calls the engine methods they call.',
      parameters: {
        seconds: {
          type: 'number',
          description: `Real seconds to measure, from ${PERFORMANCE_SECONDS.min} to ${PERFORMANCE_SECONDS.max}. Default: ${PERFORMANCE_SECONDS.default}.`,
        },
        scripts: { type: 'boolean', description: 'Profile the scripts after measuring the frames. Default: true.' },
        engine_calls: {
          type: 'boolean',
          description: 'Also time each engine method, such as Node.get_children, that the profiled functions call on the main thread, '
            + 'and list the costliest under each function, to find calls that cost more than the code around them; timing them '
            + 'slows every engine call while the scripts are profiled. Needs scripts. Default: false.',
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ...PERFORMANCE_PROPERTIES, ...DIGEST_SCHEMA } },
        render: (args, value) => textResult(
          formatPerformance(value, args.scripts !== false, args.engine_calls === true),
          formatDigest(value),
        ),
      },
      async execute(args, exec) {
        const seconds = args.seconds ?? PERFORMANCE_SECONDS.default
        if (!(seconds >= PERFORMANCE_SECONDS.min && seconds <= PERFORMANCE_SECONDS.max)) {
          throw new Error(`seconds must be from ${PERFORMANCE_SECONDS.min} to ${PERFORMANCE_SECONDS.max}.`)
        }
        const engineCalls = args.engine_calls === true
        if (engineCalls && args.scripts === false) throw new Error('engine_calls times the engine methods of the profiled scripts, so it needs scripts.')
        return invoke(host, exec, async (_agent, session) => {
          const run = requireRunning(session)
          const sample = await run.performance(seconds, args.scripts === false ? 0 : seconds, engineCalls, exec.signal)
          return summarizePerformance(sample, run.view().windowless)
        })
      },
    }),
    defineTool({
      name: 'godot_audio',
      description: 'Listen to the running game: capture its audio mix, the Master bus as players hear it, for seconds of real time while '
        + 'optional input events play, then report levels, loudness, clipping, silence, spectrum, when sounds start and stop, which '
        + 'audio players played on which buses, and the bus volumes and peaks; picture adds a waveform and spectrogram picture. '
        + 'A muted run mixes its audio as usual, so it can be captured too.',
      parameters: {
        seconds: {
          type: 'number',
          description: `Seconds of audio, from ${AUDIO_SECONDS.min} to ${AUDIO_SECONDS.max}. Default: ${AUDIO_SECONDS.default}.`,
        },
        events: {
          type: 'array',
          items: EVENT_SCHEMA,
          description: `Input events to play from the capture's start, as godot_input takes them, at most ${MAX_INPUT_EVENTS}.`,
        },
        coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of the events\' x, y, dx, dy. Default: screenshot.' },
        path: { type: 'string', description: `Save the capture as a 16-bit .wav file at this path, ${wording.savePath}.` },
        replace: { type: 'boolean', description: 'Overwrite the file at path when it exists. Default: false.' },
        picture: { type: 'boolean', description: 'Add the waveform and spectrogram picture, for when the figures leave a question, such as where a click lies. Default: false.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ...AUDIO_PROPERTIES,
            savedPath: { type: 'string' },
            picture: IMAGE_OBJECT,
            pictureText: { type: 'string' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => [
          ...textResult(
            describeAudio(value).join('\n'),
            value.savedPath === undefined ? '' : `Saved the capture to ${value.savedPath}.`,
            value.pictureText ?? '',
            formatDigest(value),
          ),
          ...value.picture === undefined ? [] : imageBlocks(value.picture),
        ],
      },
      async execute(args, exec) {
        const seconds = args.seconds ?? AUDIO_SECONDS.default
        if (!(seconds >= AUDIO_SECONDS.min && seconds <= AUDIO_SECONDS.max)) {
          throw new Error(`seconds must be from ${AUDIO_SECONDS.min} to ${AUDIO_SECONDS.max}.`)
        }
        checkSaveArgs(args, '.wav')
        const events = args.events === undefined ? undefined : parseInputEvents(args.events, MAX_INPUT_EVENTS)
        return invoke(host, exec, async (agent, session) => {
          const run = requireRunning(session)
          const delivered = windowEvents(session, run, events, args.coordinate_space)
          // The file is held before the capture, so a refused path wastes no capture.
          const file = await holdSaveFile(host, agent, run, args, '.wav', exec.signal)
          return await savingTo(file, async () => {
            const pictures = args.picture === true ? await surface.pictures(exec, agent) : undefined
            const { meta, samples } = await captureWithInput(run, seconds, delivered, exec.signal)
            const audio: AudioSamples = {
              sampleRate: meta.sampleRate, channels: 2, frames: meta.frames,
              samples: applyMasterVolume(samples.subarray(0, meta.frames * 2), meta.masterVolumes),
            }
            const summary = summarizeAudio(meta, audio, analyzeAudio(audio))
            await file?.write(encodeWav(audio))
            const saved = file === undefined ? {} : { savedPath: file.path }
            if (pictures === undefined || audio.frames === 0) return { ...summary, ...saved }
            const { image, layout } = drawAudioImage(audio)
            const picture = await pictures.store({
              data: encodePng(image), mediaType: 'image/png', width: image.width, height: image.height, name: `godot-audio-${String(meta.frame)}.png`,
            }, exec.signal)
            return { ...summary, ...saved, picture, pictureText: describeAudioImage(layout) }
          })
        })
      },
    }),
    defineTool({
      name: 'godot_logs',
      description: 'Read the game\'s log: printed output, errors, and warnings from the game, the engine, and the import step. '
        + wording.logsDefault,
      parameters: {
        since: { type: 'integer', description: 'Return entries after this cursor, the next value of an earlier result. 0 reads from the start.' },
        levels: { type: 'array', items: { type: 'string', enum: LEVELS }, description: 'Only these levels.' },
        limit: { type: 'integer', description: 'Most entries. Default: 200.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            entries: { type: 'array', items: ENTRY_SCHEMA, required: true },
            next: INTEGER,
            missed: BOOLEAN,
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => textResult(
          value.entries.length === 0 ? 'No new log entries.' : value.entries.map(formatLogEntry).join('\n'),
          value.missed ? 'Older entries after the cursor were discarded because the log is full.' : '',
          `Next cursor: ${value.next}.`,
          formatDigest(value),
        ),
      },
      async execute(args, exec) {
        const limit = boundedInteger(args.limit, 'limit', 200, 1, 1000)
        const levels = args.levels === undefined ? undefined : new Set<GodotLogLevel>(args.levels)
        return invoke(host, exec, (_agent, session) => {
          const run = session.run
          if (run === undefined) throw new Error('No game has run in this Session; call godot_run first.')
          const page = run.logs.after(args.since ?? session.logCursor, limit, entry => levels === undefined || levels.has(entry.level))
          // Keep the listed entries within the text budget; the cursor stops at the last one listed.
          const entries: ToolLogEntry[] = []
          let next = page.next
          let length = 0
          for (const entry of page.entries) {
            const reported = toolLogEntry(entry)
            length += formatLogEntry(reported).length + 1
            const last = entries.at(-1)
            if (last !== undefined && length > TEXT_BUDGET - 500) {
              next = last.seq
              break
            }
            entries.push(reported)
          }
          session.logCursor = next
          session.digestCursor = Math.max(session.digestCursor, next)
          return { entries, next, missed: page.missed }
        })
      },
    }),
  ]
}
