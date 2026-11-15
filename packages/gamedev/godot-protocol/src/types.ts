/**
 * The request a Godot plugin's Host makes of a WASD Engine window: the forwarded `godot/record` event, which a window
 * answers by encoding a recording of a Session's game into an MP4 video and drawing its frame sheet, and the request
 * and answer it carries. The Godot plugin and the Remote event list share these declarations from this package, which
 * depends on neither, so the Client and Host compiles of the Remote list reach them without entering the plugin.
 */
import type {} from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent/types'
import type { Scoped } from '@deepseek-ai/dsh-scope'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * What a WASD Engine window encodes for `godot_record`: the frames of a recording, which it reads from the Host's
 * `GET /api/godot.recording?session=<SessionId>&run=<runId>&recording=<id>` stream while the game records, into an MP4
 * video, which it uploads with `POST /api/godot.video` and the same parameters before it answers.
 */
export interface GodotVideoEncodeRequest {
  /** The Session whose game records. */
  readonly sessionId: SessionId
  /** The run that records. */
  readonly runId: string
  /** The recording, which names its frame stream and its upload. */
  readonly recording: number
  /** Frames per second of the video; a frame shows from its own time until the next frame's. */
  readonly fps: number
  /** Frames of the sheet the window draws from across the video, evenly spread; 0 for no sheet. */
  readonly sheetFrames: number
  /** Largest video the Host accepts, in bytes. */
  readonly maxBytes: number
}

/** The `godot/record` request on the Host: the JSON fields, the calling Agent, and the call's cancellation. */
export interface GodotVideoEncodeEvent extends GodotVideoEncodeRequest {
  /** The Agent whose Session's game records; the scope of the request. */
  agent?: Agent
  /** Ends the request when the call ends. */
  signal?: AbortSignal
}

/** A window's answer to `godot/record`, sent after the video's upload: the video's facts and the frame sheet. */
export interface GodotVideoEncodeResult {
  /** Codec of the uploaded video: `H.264` or `VP9`. */
  readonly codec: string
  /** Frames in the video. */
  readonly frames: number
  /** Seconds the video plays. */
  readonly seconds: number
  /** Frame size in pixels. */
  readonly width: number
  readonly height: number
  /** Bytes of the uploaded video. */
  readonly bytes: number
  /** The sheet as a base64 JPEG file, its size, and the seconds into the video of each frame it shows. */
  readonly sheet?: { readonly data: string; readonly width: number; readonly height: number; readonly times: readonly number[] }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Ask the windows that may read a Session to encode a recording of its game into a video. Return the video's facts
     * after uploading it to claim the request, or call `next()` to delegate. Scope-filtered dispatch
     * (`@deepseek-ai/dsh-scope`): agent-scoped listeners receive only that agent.
     * @param request - the recording, its frame rate and sheet, the size limit, the calling Agent, and the call's cancellation.
     * @mode waterfall
     */
    'godot/record'(
      this: Scoped<Agent>,
      request: GodotVideoEncodeEvent,
      next: () => Promise<GodotVideoEncodeResult>,
    ): Promise<GodotVideoEncodeResult>
  }
}
