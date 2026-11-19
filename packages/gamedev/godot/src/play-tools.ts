/**
 * The Godot tools that see and play the running game: `godot_screenshot`, `godot_input`, `godot_wait`, `godot_view`,
 * `godot_record`, and `godot_control`.
 */
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { parseInputEvents } from './input.ts'
import { fixedFps } from './launch.ts'
import { formatVector } from './run-text.ts'
import { MAX_INPUT_EVENTS, type ViewParams } from './run.ts'
import {
  captureScreenshot, captureUnseen, checkSaveArgs, holdSaveFile, savingTo, SCREENSHOT_WIDTH, screenshotAfter,
} from './screenshot-capture.ts'
import {
  BOOLEAN, boundedInteger, DIGEST_SCHEMA, EVENT_SCHEMA, IMAGE_LEFT_OUT, IMAGE_OBJECT, imageFileProperties, INTEGER, invoke, NUMBER,
  REGION_MIN_WIDTH, requireRunning, SCREENSHOT_PROPERTIES, SCREENSHOT_SCHEMA, SHEET_LEFT_OUT, STRING, VIEW_SIZE, windowEvents,
  windowRegion,
} from './tool-parts.ts'
import {
  describeInput, describeOutcome, describeScreenshot, describeStep, formatDigest, imageBlocks, numberText, point, screenshotBlocks,
  sizeText, textResult,
} from './tool-text.ts'
import type { GodotToolHost, GodotToolSurface } from './tools.ts'
import { MAX_VIDEO_SECONDS } from './video.ts'

/**
 * The tools that see and play the running game: screenshots, input, waits, views, recordings, and game controls.
 * @param host - plugin operations the tools call.
 * @param surface - how the callers receive screenshots and pictures, and the tools' wording.
 * @returns the definitions, in catalog order.
 */
export function playTools(host: GodotToolHost, surface: GodotToolSurface): ToolDefinition[] {
  const { wording } = surface
  return [
    defineTool({
      name: 'godot_screenshot',
      description: 'Capture the running game\'s window as an image, or a region of it at the window\'s own pixels, to see small detail such as faces or text. '
        + 'Mouse coordinates for godot_input refer to the pixels of the latest screenshot. To see the game larger than its window, or from another camera, use godot_view.',
      parameters: {
        max_width: { type: 'integer', description: `Largest image width in pixels. Default: ${SCREENSHOT_WIDTH}.` },
        region: {
          type: 'object',
          additionalProperties: false,
          properties: { x: INTEGER, y: INTEGER, width: INTEGER, height: INTEGER },
          description: `Capture only this rectangle: x and y of its top left corner, width, and height. A region narrower than ${REGION_MIN_WIDTH} px grows by a whole factor, each window pixel a square.`,
        },
        coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of region: pixels of the latest screenshot, or of the game window. Default: screenshot.' },
        ...imageFileProperties(wording),
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ...SCREENSHOT_PROPERTIES, image: IMAGE_OBJECT, savedPath: { type: 'string' }, ...DIGEST_SCHEMA },
        },
        render: (_args, value) => [
          ...textResult(
            describeScreenshot(value),
            value.savedPath === undefined ? '' : `Saved the image to ${value.savedPath}.`,
            value.image === undefined ? IMAGE_LEFT_OUT : '',
            formatDigest(value),
          ),
          ...value.image === undefined ? [] : imageBlocks(value.image),
        ],
      },
      async execute(args, exec) {
        const maxWidth = boundedInteger(args.max_width, 'max_width', SCREENSHOT_WIDTH, 64, 4096)
        checkSaveArgs(args, '.png')
        return invoke(host, exec, async (agent, session) => {
          const run = requireRunning(session)
          const region = args.region === undefined ? undefined : windowRegion(args.region, args.coordinate_space ?? 'screenshot', session, run, maxWidth)
          // The file is held before the capture, so a refused path wastes no capture.
          const file = await holdSaveFile(host, agent, run, args, '.png', exec.signal)
          return await savingTo(file, async () => {
            if (file === undefined) {
              return await captureScreenshot(await surface.screenshots(exec, agent), session, run, maxWidth, exec.signal, region)
            }
            // A call that saves the image saves it also for callers that receive no images.
            const taker = await surface.pictures(exec, agent)
            const shot = taker === undefined
              ? await captureUnseen(session, run, maxWidth, exec.signal, region, file.write)
              : await captureScreenshot(taker, session, run, maxWidth, exec.signal, region, file.write)
            return { ...shot, savedPath: file.path }
          })
        })
      },
    }),
    defineTool({
      name: 'godot_input',
      description: 'Send input events to the running game, in order: keys, typed text, mouse buttons and motion, input map actions, and joypad events. '
        + 'An event { "wait": seconds } pauses the sequence. A press stays down until its release event or until its hold time ends. '
        + 'Mouse coordinates are pixels of the latest godot_screenshot unless coordinate_space is "window".',
      parameters: {
        events: { type: 'array', required: true, items: EVENT_SCHEMA, description: `Events in order, at most ${MAX_INPUT_EVENTS}.` },
        screenshot: { type: 'boolean', description: 'Capture a screenshot after the events.' },
        coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of x, y, dx, dy. Default: screenshot.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            events: INTEGER,
            frames: INTEGER,
            seconds: NUMBER,
            frame: INTEGER,
            timedOut: BOOLEAN,
            screenshot: SCREENSHOT_SCHEMA,
            screenshotError: { type: 'string' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => [
          ...textResult(describeInput(value), describeOutcome(value, 'the events'), formatDigest(value)),
          ...value.screenshot === undefined ? [] : screenshotBlocks(value.screenshot),
        ],
      },
      async execute(args, exec) {
        const events = parseInputEvents(args.events, MAX_INPUT_EVENTS)
        return invoke(host, exec, async (agent, session) => {
          const run = requireRunning(session)
          const delivered = windowEvents(session, run, events, args.coordinate_space)
          const target = args.screenshot === true ? await surface.screenshots(exec, agent) : undefined
          const reply = await run.input(delivered, exec.signal)
          return {
            events: reply.events,
            frames: reply.frames,
            seconds: reply.seconds,
            frame: reply.frame,
            timedOut: reply.timedOut,
            ...target === undefined ? {} : await screenshotAfter(target, session, run, exec.signal),
          }
        })
      },
    }),
    defineTool({
      name: 'godot_wait',
      description: 'Let the running game advance: seconds of unpaused game time, or a number of frames. Optionally capture a screenshot afterwards.',
      parameters: {
        seconds: { type: 'number', description: 'Seconds of game time.' },
        frames: { type: 'integer', description: 'Frames, instead of seconds.' },
        screenshot: { type: 'boolean', description: 'Capture a screenshot afterwards.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            frames: INTEGER,
            seconds: NUMBER,
            frame: INTEGER,
            paused: BOOLEAN,
            timedOut: BOOLEAN,
            screenshot: SCREENSHOT_SCHEMA,
            screenshotError: { type: 'string' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => {
          const state = `the game is at frame ${value.frame}${value.paused ? ' and paused' : ''}`
          const summary = value.timedOut
            ? `The wait ended at its real-time limit after ${value.seconds.toFixed(2)} s of game time (${value.frames} frames); ${state}. Game time passes only while the game runs unpaused.`
            : `Waited ${value.frames} frames (${value.seconds.toFixed(2)} s of game time); ${state}.`
          return [
            ...textResult(summary, describeOutcome(value, 'the wait'), formatDigest(value)),
            ...value.screenshot === undefined ? [] : screenshotBlocks(value.screenshot),
          ]
        },
      },
      async execute(args, exec) {
        if ((args.seconds === undefined) === (args.frames === undefined)) throw new Error('Give either seconds or frames.')
        if (args.seconds !== undefined && !(args.seconds > 0)) throw new Error('seconds must be positive.')
        const frames = args.frames === undefined ? undefined : boundedInteger(args.frames, 'frames', 1, 1, 100_000)
        return invoke(host, exec, async (agent, session) => {
          const run = requireRunning(session)
          if (frames === undefined && run.view().phase === 'paused') {
            throw new Error('The game is paused, so game time does not advance; resume it with godot_control, or wait frames instead.')
          }
          const target = args.screenshot === true ? await surface.screenshots(exec, agent) : undefined
          const reply = await run.wait(frames === undefined ? { seconds: args.seconds as number } : { frames }, exec.signal)
          return {
            frames: reply.frames,
            seconds: reply.seconds,
            frame: reply.frame,
            paused: reply.paused,
            timedOut: reply.timedOut,
            ...target === undefined ? {} : await screenshotAfter(target, session, run, exec.signal),
          }
        })
      },
    }),
    defineTool({
      name: 'godot_view',
      description: 'Draw the running game\'s 3D world from your own camera at any size, without changing its window or camera, to judge faces, materials, '
        + 'and animation up close as the game draws them: its shaders, lights, and current pose. Frame a node (or one of its bones, such as Head) from an angle, '
        + 'place the camera yourself, or omit both for the game camera\'s view at the size you ask. asset draws a scene or model alone as the game imports '
        + 'it, its scripts running, optionally posed in an animation.',
      parameters: {
        node: { type: 'string', description: 'Node path of a 3D node to frame, such as /root/Main/Zombie.' },
        asset: { type: 'string', description: 'res:// path of a scene or model (.tscn, .glb, .fbx, .blend, …) to draw alone, instead of node.' },
        bone: { type: 'string', description: 'Frame this Skeleton3D bone of the subject, such as Head.' },
        yaw: { type: 'number', description: 'Degrees around the subject\'s heading: 0 looks at its +Z side (the front of most imported models), 180 at its back. Default: 30.' },
        pitch: { type: 'number', description: 'Degrees above the subject. Default: 10.' },
        distance: { type: 'number', description: 'Multiplier of the distance that fits the subject: below 1 is closer. Default: 1.' },
        radius: { type: 'number', description: 'Meters around the subject\'s center to fit. Default: its bounds, or 0.25 around a bone.' },
        camera: {
          type: 'object',
          additionalProperties: false,
          properties: {
            position: { type: 'array', items: { type: 'number' }, required: true, description: '[x, y, z] of the camera in world coordinates.' },
            target: { type: 'array', items: { type: 'number' }, required: true, description: '[x, y, z] the camera looks at.' },
          },
          description: 'Place the camera yourself.',
        },
        fov: { type: 'number', description: 'Vertical field of view in degrees. Default: the game camera\'s, or 35 for an asset.' },
        isolate: { type: 'boolean', description: 'node: draw it alone, lit as the game lights it.' },
        lighting: { type: 'string', enum: ['studio', 'game'], description: 'asset: a neutral studio, or the game\'s sky and sun. Default: studio.' },
        animation: { type: 'string', description: 'asset: an AnimationPlayer animation to pose it in.' },
        time: { type: 'number', description: 'asset: seconds into the animation. Default: 0.' },
        width: { type: 'integer', description: `Image width in pixels, up to ${VIEW_SIZE.max}. Default: ${VIEW_SIZE.width}.` },
        height: { type: 'integer', description: `Image height in pixels, up to ${VIEW_SIZE.max}. Default: ${VIEW_SIZE.height}.` },
        ...imageFileProperties(wording),
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            width: INTEGER,
            height: INTEGER,
            frame: INTEGER,
            paused: BOOLEAN,
            camera: { type: 'json', required: true, description: 'The camera that drew the view: position, direction, and vertical fov.' },
            subject: { type: 'json', description: 'The framed center, radius in meters, and the camera\'s distance from the center.' },
            image: IMAGE_OBJECT,
            savedPath: { type: 'string' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (args, value) => {
          const what = args.asset ?? args.node ?? 'the game camera\'s view'
          const camera = value.camera as { position?: JsonValue; direction?: JsonValue; fov?: JsonValue }
          const lines = [`View of ${what} at frame ${value.frame}${value.paused ? ' (paused)' : ''}: ${value.width}x${value.height} px; camera at ${formatVector(camera.position) ?? '?'} looking along ${formatVector(camera.direction) ?? '?'}, fov ${typeof camera.fov === 'number' ? camera.fov.toFixed(1) : '?'}°.`]
          const subject = value.subject as { center?: JsonValue; radius?: JsonValue; distance?: JsonValue } | undefined
          if (subject !== undefined && typeof subject.radius === 'number' && typeof subject.distance === 'number') {
            lines.push(`Framed ${subject.radius.toFixed(3)} m around ${formatVector(subject.center) ?? '?'} from ${subject.distance.toFixed(3)} m.`)
          }
          return [
            ...textResult(
              lines.join(' '),
              value.savedPath === undefined ? '' : `Saved the image to ${value.savedPath}.`,
              value.image === undefined ? IMAGE_LEFT_OUT : '',
              formatDigest(value),
            ),
            ...value.image === undefined ? [] : imageBlocks(value.image),
          ]
        },
      },
      async execute(args, exec) {
        const width = boundedInteger(args.width, 'width', VIEW_SIZE.width, 16, VIEW_SIZE.max)
        const height = boundedInteger(args.height, 'height', VIEW_SIZE.height, 16, VIEW_SIZE.max)
        if (args.asset !== undefined && args.node !== undefined) throw new Error('Give node or asset, not both.')
        const framing = [args.bone, args.yaw, args.pitch, args.distance, args.radius].some(value => value !== undefined)
        if (args.camera !== undefined && framing) {
          throw new Error('camera places the camera itself; leave out bone, yaw, pitch, distance, and radius.')
        }
        const camera = args.camera === undefined ? undefined : { position: point(args.camera.position, 'camera.position'), target: point(args.camera.target, 'camera.target') }
        if (args.isolate === true && args.node === undefined) throw new Error('isolate draws a node alone; name the node.')
        if ((args.animation !== undefined || args.time !== undefined || args.lighting !== undefined) && args.asset === undefined) {
          throw new Error('animation, time, and lighting apply to an asset; name the asset.')
        }
        checkSaveArgs(args, '.png')
        return invoke(host, exec, async (agent, session) => {
          const run = requireRunning(session)
          // The file is held before the view is drawn, so a refused path wastes no drawing.
          const file = await holdSaveFile(host, agent, run, args, '.png', exec.signal)
          return await savingTo(file, async () => {
            // A call that saves the image saves it also for callers that receive no images.
            const taker = file === undefined ? await surface.screenshots(exec, agent) : await surface.pictures(exec, agent)
            const size = taker === undefined ? { width, height } : taker.fit(width, height)
            const params: ViewParams = {
              width: size.width,
              height: size.height,
              ...args.node === undefined ? {} : { node: args.node },
              ...args.asset === undefined ? {} : { asset: args.asset },
              ...args.bone === undefined ? {} : { bone: args.bone },
              ...args.yaw === undefined ? {} : { yaw: args.yaw },
              ...args.pitch === undefined ? {} : { pitch: args.pitch },
              ...args.distance === undefined ? {} : { distance: args.distance },
              ...args.radius === undefined ? {} : { radius: args.radius },
              ...camera === undefined ? {} : { camera },
              ...args.fov === undefined ? {} : { fov: args.fov },
              ...args.isolate === true ? { isolate: true } : {},
              ...args.lighting === undefined ? {} : { lighting: args.lighting },
              ...args.animation === undefined ? {} : { animation: args.animation },
              ...args.time === undefined ? {} : { time: args.time },
            }
            const drawn = await run.drawView(params, exec.signal)
            await file?.write(drawn.image)
            const image = taker === undefined
              ? undefined
              : await taker.store({ data: drawn.image, mediaType: 'image/png', width: drawn.meta.width, height: drawn.meta.height, name: `godot-view-${drawn.meta.frame}.png` }, exec.signal)
            return {
              width: drawn.meta.width,
              height: drawn.meta.height,
              frame: drawn.meta.frame,
              paused: drawn.meta.paused,
              camera: drawn.meta.camera,
              ...drawn.meta.subject === undefined ? {} : { subject: drawn.meta.subject },
              ...image === undefined ? {} : { image },
              ...file === undefined ? {} : { savedPath: file.path },
            }
          })
        })
      },
    }),
    defineTool({
      name: 'godot_record',
      description: 'Record the running game to an MP4 video (H.264) while it plays, optionally sending input events, and see a sheet of frames from '
        + 'across it to judge motion. The WASD Engine window encodes the video. For films without dropped frames, start the game with engine_args '
        + '["--fixed-fps", "30"]: the recording then captures every frame, each advancing the game by the same time, and seconds counts seconds of video.',
      parameters: {
        seconds: { type: 'number', required: true, description: `Seconds to record, from 0.5 to ${MAX_VIDEO_SECONDS}: real seconds, or seconds of video in a run with --fixed-fps.` },
        fps: { type: 'integer', description: 'Frames per second, 1 to 60. Default: 30, or the run\'s --fixed-fps rate.' },
        max_width: { type: 'integer', description: 'Largest frame width in pixels, 64 to 3840. Default: 1920.' },
        path: { type: 'string', description: '.mp4 file to save, inside the working directory or the project. Default: a new file in the project\'s recordings folder.' },
        replace: { type: 'boolean', description: 'Replace an existing file at path.' },
        events: { type: 'array', items: { type: 'object', additionalProperties: true }, description: `Input events to send from the recording's start, as godot_input's events, at most ${MAX_INPUT_EVENTS}.` },
        coordinate_space: { type: 'string', enum: ['screenshot', 'window'], description: 'Unit of the events\' mouse coordinates. Default: screenshot.' },
        sheet_frames: { type: 'integer', description: 'Frames in the returned sheet, spread from start to end, 0 to 24. Default: 12.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: STRING,
            bytes: INTEGER,
            codec: STRING,
            frames: INTEGER,
            skipped: INTEGER,
            seconds: NUMBER,
            fps: NUMBER,
            width: INTEGER,
            height: INTEGER,
            fixedFps: BOOLEAN,
            inputError: { type: 'string' },
            sheetTimes: { type: 'array', items: { type: 'number' } },
            sheet: IMAGE_OBJECT,
            sheetLeftOut: { type: 'boolean', description: 'Whether the result has no sheet because the Session receives no images.' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => {
          const pacing = value.fixedFps ? 'every frame advancing the game by the same time' : 'at real time'
          const skipped = value.skipped > 0 ? ` The game skipped ${value.skipped} frames because capturing fell behind; start it with --fixed-fps to keep every frame.` : ''
          const lines = [`Recorded ${value.seconds.toFixed(2)} s at ${numberText(value.fps)} fps, ${pacing}: ${value.frames} frames of ${value.width}x${value.height} px in ${value.codec}, saved to ${value.path} (${sizeText(value.bytes)}).${skipped}`]
          if (value.inputError !== undefined) lines.push(`The input events stopped at an error: ${value.inputError}`)
          if (value.sheetTimes !== undefined && value.sheetTimes.length > 0) {
            lines.push(`The sheet shows ${value.sheetTimes.length} frames left to right, top to bottom, at ${value.sheetTimes.map(time => `${time.toFixed(2)} s`).join(', ')}.`)
          }
          if (value.sheetLeftOut === true) lines.push(SHEET_LEFT_OUT)
          return [...textResult(lines.join('\n'), formatDigest(value)), ...value.sheet === undefined ? [] : imageBlocks(value.sheet)]
        },
      },
      timeoutMs: (MAX_VIDEO_SECONDS * 3 + 120) * 1000,
      async execute(args, exec) {
        if (!(args.seconds >= 0.5 && args.seconds <= MAX_VIDEO_SECONDS)) throw new Error(`seconds must be from 0.5 to ${MAX_VIDEO_SECONDS}.`)
        const maxWidth = boundedInteger(args.max_width, 'max_width', 1920, 64, 3840)
        const sheetFrames = boundedInteger(args.sheet_frames, 'sheet_frames', 12, 0, 24)
        if (args.fps !== undefined) boundedInteger(args.fps, 'fps', 30, 1, 60)
        const events = args.events === undefined ? undefined : parseInputEvents(args.events, MAX_INPUT_EVENTS)
        return invoke(host, exec, async (agent, session) => {
          const run = requireRunning(session)
          const delivered = windowEvents(session, run, events, args.coordinate_space)
          // The video needs no images, so a Session that receives none records it and goes without the sheet.
          const pictures = sheetFrames > 0 ? await surface.pictures(exec, agent) : undefined
          const sheetLeftOut = sheetFrames > 0 && pictures === undefined
          const fixed = fixedFps(run.view().launch.engineArgs ?? [])
          const fps = args.fps ?? (fixed === undefined ? 30 : fixed / Math.ceil(fixed / 60))
          const video = await host.record(agent, run, {
            seconds: args.seconds,
            fps,
            maxWidth,
            sheetFrames: pictures === undefined ? 0 : sheetFrames,
            replace: args.replace === true,
            ...args.path === undefined ? {} : { path: args.path },
            ...delivered === undefined ? {} : { events: delivered },
          }, exec.signal)
          const sheet = pictures === undefined || video.sheet === undefined
            ? undefined
            : await pictures.store({ data: video.sheet.data, mediaType: 'image/jpeg', width: video.sheet.width, height: video.sheet.height, name: 'godot-recording-sheet.jpg' }, exec.signal)
          return {
            path: video.path,
            bytes: video.bytes,
            codec: video.codec,
            frames: video.frames,
            skipped: video.skipped,
            seconds: video.seconds,
            fps: video.fps,
            width: video.width,
            height: video.height,
            fixedFps: video.fixedFps,
            ...video.inputError === undefined ? {} : { inputError: video.inputError },
            ...video.sheet === undefined ? {} : { sheetTimes: [...video.sheet.times] },
            ...sheet === undefined ? {} : { sheet },
            ...sheetLeftOut ? { sheetLeftOut: true } : {},
          }
        })
      },
    }),
    defineTool({
      name: 'godot_control',
      description: 'Pause or resume the running game, or step it: step runs a number of frames and pauses again.',
      parameters: {
        action: { type: 'string', enum: ['pause', 'resume', 'step'], required: true },
        frames: { type: 'integer', description: 'step: frames to run. Default: 1.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            paused: BOOLEAN,
            frame: INTEGER,
            frames: { type: 'integer' },
            endedEarly: { type: 'boolean' },
            timedOut: { type: 'boolean' },
            ...DIGEST_SCHEMA,
          },
        },
        render: (_args, value) => textResult(
          `${describeStep(value)}The game is ${value.paused ? 'paused' : 'running'} at frame ${value.frame}.`,
          formatDigest(value),
        ),
      },
      async execute(args, exec) {
        const frames = boundedInteger(args.frames, 'frames', 1, 1, 100_000)
        return invoke(host, exec, async (_agent, session) => {
          const run = requireRunning(session)
          if (args.action === 'step') {
            const reply = await run.step(frames, exec.signal)
            return { paused: reply.paused, frame: reply.frame, frames: reply.frames, endedEarly: reply.cancelled, timedOut: reply.timedOut }
          }
          return run.setPaused(args.action === 'pause', exec.signal)
        })
      },
    }),
  ]
}
