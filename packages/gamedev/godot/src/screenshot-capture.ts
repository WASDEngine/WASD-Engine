/**
 * Screenshots and pictures of a running game for the Godot tools: the taker that the Session's own agent and connected
 * agents use, one capture with the input it waits for and the step it shows, an unseen capture that the next call
 * shows, and the save of a capture as a `.png` file of the project.
 */
import { Buffer } from 'node:buffer'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { holdCaptureFile, newScreenshotFile, type CaptureFile } from './captures.ts'
import { resolveResFile } from './project.ts'
import type { GodotRun, ScreenshotRegion } from './run.ts'
import type { GodotSession } from './runs.ts'
import type { ScreenshotOutcome } from './tool-text.ts'
import type { GodotToolHost, GodotToolSurface } from './tools.ts'
import type { CapturedScreenshot, ImageValue, ScreenshotValue } from './tool-parts.ts'
import type { GodotInputEvent } from './types.ts'

/** Default `max_width` of `godot_screenshot`, and the largest width of the screenshot `godot_input` and `godot_wait` take. */
export const SCREENSHOT_WIDTH = 1280

/** An image the game or a window made for a tool call, which the surface stores for its callers. */
export interface MadeImage {
  /** PNG or JPEG bytes. */
  readonly data: Buffer
  readonly mediaType: 'image/png' | 'image/jpeg'
  /** Size in pixels. */
  readonly width: number
  readonly height: number
  /** File name the stored image takes. */
  readonly name: string
}

/** Captures and stores the images of one tool call for the callers of a {@link GodotToolSurface}. */
export interface ScreenshotTaker {
  /**
   * Capture the running game's window, or a region of it, and store the image where the surface's callers receive it.
   * @param run - running game.
   * @param maxWidth - largest image width the call asked for.
   * @param signal - cancellation.
   * @param region - part of the window to capture, in window pixels.
   * @param save - receives the captured PNG bytes before the image is stored, as `godot_screenshot` saves them to the
   * file it holds.
   * @returns the screenshot as a result value holds it; input coordinates in screenshot pixels refer to its
   * `width` and `height`.
   */
  capture(
    run: GodotRun, maxWidth: number, signal: AbortSignal, region?: ScreenshotRegion, save?: (png: Buffer) => Promise<void>,
  ): Promise<ScreenshotValue>
  /**
   * Store an image where the surface's callers receive it.
   * @param image - the image.
   * @param signal - cancellation.
   * @returns the stored image as a result value holds it.
   */
  store(image: MadeImage, signal: AbortSignal): Promise<ImageValue>
  /**
   * Fit a size that the call asks the game to draw within the images the surface's callers receive unresized.
   * @param width - asked width in pixels.
   * @param height - asked height in pixels.
   * @returns the size to draw, with the same aspect ratio.
   */
  fit(width: number, height: number): { readonly width: number; readonly height: number }
}

/**
 * Store an image of a tool call as an attachment of the Session.
 * @param attachments - the Session's attachment store.
 * @param made - the image.
 * @param signal - cancellation.
 * @returns the attachment reference.
 */
async function storeImage(attachments: AttachmentStore, made: MadeImage, signal: AbortSignal): Promise<ImageValue> {
  const [image] = await attachments.saveImages([{ data: made.data, mediaType: made.mediaType, name: made.name }]) as [ImageAttachmentRef]
  signal.throwIfAborted()
  return image
}

/**
 * The screenshot taker of the Session's own tools, whose images become attachments that the Session's model receives,
 * measured as that model sees them, or why the Session's model cannot receive images.
 * @param ctx - plugin context with the optional attachment and model services.
 * @param exec - the tool call.
 * @param agent - calling Session.
 * @returns the taker, or the failure message of a call that needs the model to see its images.
 */
async function sessionTaker(ctx: Context, exec: ToolRunContext, agent: Agent): Promise<ScreenshotTaker | string> {
  const attachments = ctx.get('attachments')
  const llm = ctx.get('llm')
  const route = agent.model.current()
  if (attachments === undefined || llm === undefined || route === undefined) {
    return 'Screenshots need an attachment store and a resolved model route, and this Session has neither.'
  }
  const info = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
  if (info.inputModalities?.includes('image') !== true) {
    return `The model "${route.model}" does not accept images, so it cannot see screenshots; switch to an image-capable model.`
  }
  return {
    async capture(run, maxWidth, signal, region, save) {
      const shot = await run.screenshot(maxWidth, signal, undefined, region)
      await save?.(shot.image)
      const [image] = await attachments.saveImages([{ data: shot.image, mediaType: 'image/png', name: `godot-frame-${shot.meta.frame}.png` }]) as [ImageAttachmentRef]
      signal.throwIfAborted()
      const seen = await attachments.readImageRequest(image, llm.imageRequestTarget(route.provider, route.model, image), signal)
      return {
        width: seen.width,
        height: seen.height,
        windowWidth: shot.meta.windowWidth,
        windowHeight: shot.meta.windowHeight,
        ...regionFields(shot.meta),
        frame: shot.meta.frame,
        paused: shot.meta.paused,
        image,
      }
    },
    store: (made, signal) => storeImage(attachments, made, signal),
    fit: (width, height) => ({ width, height }),
  }
}

/**
 * The screenshots of the Session's own tools: each image becomes an attachment that the Session's model receives,
 * measured as that model sees it.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the screenshot resolution of {@link GodotToolSurface}, which fails for a Session whose model cannot receive
 *   images.
 */
export function sessionScreenshots(ctx: Context): GodotToolSurface['screenshots'] {
  return async (exec, agent) => {
    const taker = await sessionTaker(ctx, exec, agent)
    if (typeof taker === 'string') throw new Error(taker)
    return taker
  }
}

/**
 * The region fields of a screenshot's metadata.
 * @param meta - what the game reported.
 * @returns the region in window pixels, or nothing for a screenshot of the whole window.
 */
export function regionFields(meta: {
  readonly x?: number | undefined
  readonly y?: number | undefined
  readonly regionWidth?: number | undefined
  readonly regionHeight?: number | undefined
}): {
  x?: number
  y?: number
  regionWidth?: number
  regionHeight?: number
} {
  if (meta.x === undefined || meta.y === undefined || meta.regionWidth === undefined || meta.regionHeight === undefined) return {}
  return { x: meta.x, y: meta.y, regionWidth: meta.regionWidth, regionHeight: meta.regionHeight }
}

/**
 * The pictures of the Session's own tools, such as an audio capture's waveform or the image of a capture that the call
 * saves to a file: each becomes an attachment that the Session's model receives. A Session whose model does not accept
 * images keeps none, so its results keep to text.
 * @param ctx - plugin context with the optional attachment and model services.
 * @returns the picture resolution of {@link GodotToolSurface}.
 */
export function sessionPictures(ctx: Context): GodotToolSurface['pictures'] {
  return async (exec, agent) => {
    const taker = await sessionTaker(ctx, exec, agent)
    return typeof taker === 'string' ? undefined : taker
  }
}

/**
 * Remember a screenshot's size and region, which later input coordinates in screenshot pixels refer to.
 * @param session - the calling Session's Godot state.
 * @param run - running game.
 * @param shot - the screenshot as a result value holds it.
 */
function rememberScreenshot(session: GodotSession, run: GodotRun, shot: CapturedScreenshot): void {
  const { width, height, windowWidth, windowHeight } = shot
  session.screenshot = { runId: run.id, width, height, windowWidth, windowHeight, ...regionFields(shot) }
}

/**
 * Capture a screenshot; afterwards input coordinates in screenshot pixels refer to it.
 * @param taker - the call's screenshot taker.
 * @param session - the calling Session's Godot state.
 * @param run - running game.
 * @param maxWidth - largest captured width.
 * @param signal - cancellation.
 * @param region - the part of the game window to capture at its own pixels; the whole window when left out.
 * @param save - saves the captured PNG, as `godot_screenshot`'s `path` and `save` ask.
 * @returns the screenshot as a result value holds it.
 */
export async function captureScreenshot(
  taker: ScreenshotTaker,
  session: GodotSession,
  run: GodotRun,
  maxWidth: number,
  signal: AbortSignal,
  region?: ScreenshotRegion,
  save?: (png: Buffer) => Promise<void>,
): Promise<ScreenshotValue> {
  const shot = await taker.capture(run, maxWidth, signal, region, save)
  rememberScreenshot(session, run, shot)
  return shot
}

/**
 * Capture a screenshot that a call saves to a file while its callers receive no images; afterwards input coordinates
 * in screenshot pixels refer to the saved image.
 * @param session - the calling Session's Godot state.
 * @param run - running game.
 * @param maxWidth - largest captured width.
 * @param signal - cancellation.
 * @param region - part of the window to capture, in window pixels.
 * @param save - receives the captured PNG bytes.
 * @returns the screenshot without an image.
 */
export async function captureUnseen(
  session: GodotSession,
  run: GodotRun,
  maxWidth: number,
  signal: AbortSignal,
  region: ScreenshotRegion | undefined,
  save: (png: Buffer) => Promise<void>,
): Promise<CapturedScreenshot> {
  const { meta, image } = await run.screenshot(maxWidth, signal, undefined, region)
  await save(image)
  const shot = {
    width: meta.width,
    height: meta.height,
    windowWidth: meta.windowWidth,
    windowHeight: meta.windowHeight,
    ...regionFields(meta),
    frame: meta.frame,
    paused: meta.paused,
  }
  rememberScreenshot(session, run, shot)
  return shot
}

/**
 * Take the screenshot that ends an action on the game. The action already happened, so a failed capture becomes
 * part of the result instead of failing the call; cancellation still fails it.
 * @param taker - the call's screenshot taker, resolved before the action.
 * @param session - the calling Session's Godot state.
 * @param run - running game.
 * @param signal - cancellation.
 * @returns the screenshot, or why it failed.
 */
export async function screenshotAfter(
  taker: ScreenshotTaker,
  session: GodotSession,
  run: GodotRun,
  signal: AbortSignal,
): Promise<ScreenshotOutcome> {
  try {
    return { screenshot: await captureScreenshot(taker, session, run, SCREENSHOT_WIDTH, signal) }
  } catch (error) {
    signal.throwIfAborted()
    return { screenshotError: (error as Error).message }
  }
}

/** The arguments that name the file a call saves its capture to: `path` and `replace`, or `save`. */
interface SaveArgs {
  readonly path?: string | undefined
  readonly replace?: boolean | undefined
  readonly save?: boolean | undefined
}

/**
 * Check the arguments that name the file a call saves its capture to.
 * @param args - the call's arguments.
 * @param extension - the extension that a path must end in, such as `.png`.
 * @throws Error for both `path` and `save`, or a path with another extension.
 */
export function checkSaveArgs(args: SaveArgs, extension: string): void {
  if (args.path !== undefined && args.save === true) throw new Error('Give path or save, not both.')
  if (args.path !== undefined && extname(args.path).toLowerCase() !== extension) throw new Error(`path must end in ${extension}.`)
}

/**
 * Hold the file that a call saves its capture to, before the capture: with `save`, a new file in the project's
 * screenshots folder; with `path`, that path, where a `res://` path names a file in the running game's project.
 * @param host - plugin operations, which resolve other paths.
 * @param agent - calling Session.
 * @param run - running game.
 * @param args - the call's checked arguments.
 * @param extension - the file's extension, such as `.png`.
 * @param signal - cancellation.
 * @returns the held file, or undefined for a call that saves nothing.
 * @throws Error when the path is a folder, a file that the call may not replace, or a `res://` path that leads out of
 *   the project.
 */
export async function holdSaveFile(
  host: GodotToolHost, agent: Agent, run: GodotRun, args: SaveArgs, extension: string, signal: AbortSignal,
): Promise<CaptureFile | undefined> {
  if (args.save === true) return await newScreenshotFile(run.project, new Date())
  if (args.path === undefined) return undefined
  const path = args.path.startsWith('res://') ? resolveResFile(run.project.dir, args.path) : await host.resolvePath(agent, args.path, signal)
  return await holdCaptureFile(path, args.replace === true, extension)
}

/**
 * Run a capture that saves to a held file, and give the file up when the capture fails.
 * @param file - the held file, or undefined for a call that saves nothing.
 * @param capture - the capture, which writes the file.
 * @returns the capture's value.
 */
export async function savingTo<T>(file: CaptureFile | undefined, capture: () => Promise<T>): Promise<T> {
  try {
    return await capture()
  } catch (error) {
    await file?.release()
    throw error
  }
}

/**
 * Capture the game's audio while an input sequence plays from the capture's start; input still running when the
 * capture ends is cancelled, and the game releases what it held.
 * @param run - running game.
 * @param seconds - seconds of audio.
 * @param events - input in window pixels.
 * @param signal - cancellation of the call.
 * @returns the capture.
 * @throws the input sequence's failure, other than the cancellation that ends it with the capture.
 */
export async function captureWithInput(
  run: GodotRun, seconds: number, events: readonly GodotInputEvent[] | undefined, signal: AbortSignal,
): ReturnType<GodotRun['audio']> {
  const capture = run.audio(seconds, signal)
  if (events === undefined || events.length === 0) return await capture
  const input = new AbortController()
  const cancelInput = (): void => { input.abort(signal.reason) }
  signal.addEventListener('abort', cancelInput, { once: true })
  let failure: { readonly error: unknown } | undefined
  const played = run.input(events, input.signal).then(() => {}, (error: unknown) => {
    // The capture cancels the input it outlasts; any other failure fails the call.
    if (!input.signal.aborted) failure = { error }
  })
  try {
    const captured = await capture
    if (failure !== undefined) throw failure.error
    return captured
  } finally {
    signal.removeEventListener('abort', cancelInput)
    input.abort(new Error('The audio capture ended.'))
    await played
  }
}
