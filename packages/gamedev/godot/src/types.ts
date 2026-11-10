/** Browser-safe Remote types of the Godot plugin: run views, logs, input events, and the follow stream. */

/** Where a run's Godot comes from: the patched LibGodot runner, the only runtime the plugin starts. */
export type GodotRuntimeKind = 'libgodot'

/** Install or download progress of the managed LibGodot runtime. */
export interface GodotRuntimeInstallProgress {
  /** Current step. */
  readonly phase: 'downloading' | 'verifying' | 'extracting'
  /** Bytes received so far while downloading. */
  readonly completedBytes: number
  /** Expected archive size in bytes, from the runtime manifest. */
  readonly totalBytes: number
}

/** Runtime availability as the Game tab shows it. */
export interface GodotRuntimeView {
  /**
   * `ready`: a runtime resolves; `missing`: nothing resolves and the managed runtime can be installed; `installing`: an install
   * runs; `failed`: the last install failed or a configured runtime path is unusable.
   */
  readonly state: 'ready' | 'missing' | 'installing' | 'failed'
  /** Resolved runtime kind while `ready`. */
  readonly kind?: GodotRuntimeKind
  /** Godot version string of the resolved runtime (for example `4.7.2`), when known. */
  readonly version?: string
  /** Whether runs render without a window (macOS LibGodot embedded mode). */
  readonly windowless?: boolean
  /** Install progress while `installing`. */
  readonly progress?: GodotRuntimeInstallProgress
  /** Human-readable reason while `missing` or `failed`. */
  readonly message?: string
}

/** Lifecycle phase of a run. */
export type GodotRunPhase = 'preparing' | 'importing' | 'starting' | 'running' | 'paused' | 'exited' | 'crashed' | 'failed'

/** Who started a run. */
export type GodotRunStarter = 'agent' | 'user'

/** Scene and window size that a run was started with; the Game tab's Restart passes them again. */
export interface GodotRunLaunch {
  /** `res://` or `uid://` scene that the run opened instead of the main scene; absent for the main scene. */
  readonly scene?: string
  /** Requested window width in pixels; absent, with `height`, for the project's window size. */
  readonly width?: number
  /** Requested window height in pixels; absent, with `width`, for the project's window size. */
  readonly height?: number
}

/**
 * The Core Animation layer that a windowless macOS run draws into. A process of the same login session displays it
 * with a CALayerHost whose `contextId` is `context`; the layer is the game window's size divided by `scale`, in points.
 */
export interface GodotRunLayer {
  /** CAContext id of the layer. */
  readonly context: number
  /** Game window pixels per layer point. */
  readonly scale: number
}

/** One run of a Session's game, as tools and the Game tab see it. */
export interface GodotRunView {
  /** Opaque run id, unique within the Host process. */
  readonly runId: string
  /** Current phase. */
  readonly phase: GodotRunPhase
  /** Who started the run. */
  readonly startedBy: GodotRunStarter
  /** Absolute project directory (the folder holding `project.godot`). */
  readonly projectDir: string
  /** Project name from `application/config/name`, when known. */
  readonly projectName?: string
  /** Scene and window size of the start request. */
  readonly launch: GodotRunLaunch
  /** `res://` path of the running scene, when known. */
  readonly scene?: string
  /** Game window width in pixels, once the game reports it. */
  readonly width?: number
  /** Game window height in pixels, once the game reports it. */
  readonly height?: number
  /** Frames per second the game reports. */
  readonly fps?: number
  /** Game frame counter. */
  readonly frame?: number
  /** Godot mouse mode (`Input.MouseMode`): 0 visible, 1 hidden, 2 captured, 3 confined, 4 confined hidden. */
  readonly mouseMode?: number
  /** Rendering driver and method, for example `metal / forward_plus`. */
  readonly renderer?: string
  /** Whether audio is muted (the Dummy audio driver). */
  readonly muted: boolean
  /** Whether the run renders without a window. */
  readonly windowless: boolean
  /** The layer a windowless macOS run draws into, once the game reports it, when the runtime publishes it. */
  readonly layer?: GodotRunLayer
  /** Runtime kind used by this run. */
  readonly runtime: GodotRuntimeKind
  /** Process exit code after `exited` or `crashed`. */
  readonly exitCode?: number | null
  /** Terminating signal after `crashed`. */
  readonly signal?: string | null
  /** Failure or crash explanation after `failed` or `crashed`. */
  readonly message?: string
  /** Number of error-level log entries (errors, script errors, shader errors) in this run. */
  readonly errorCount: number
  /** Number of warnings in this run. */
  readonly warningCount: number
  /** Start time in milliseconds since the epoch. */
  readonly startedAt: number
}

/** Severity or stream of a log entry. */
export type GodotLogLevel = 'stdout' | 'stderr' | 'warning' | 'error' | 'script_error' | 'shader_error'

/** One frame of a script backtrace. */
export interface GodotBacktraceFrame {
  /** Function name. */
  readonly function: string
  /** `res://` file path. */
  readonly file: string
  /** 1-based line. */
  readonly line: number
}

/** One log entry of a run. */
export interface GodotLogEntry {
  /** Monotonic sequence number within the Host process; cursors compare against it. */
  readonly seq: number
  /** Run that logged the entry. */
  readonly runId: string
  /** Where the entry came from: the in-game harness logger, the runner process output, or the import step. */
  readonly source: 'game' | 'process' | 'import' | 'check'
  /** Severity or stream. */
  readonly level: GodotLogLevel
  /** Message text. */
  readonly message: string
  /** Source file (`res://` path) for errors and warnings, when known. */
  readonly file?: string
  /** 1-based source line, when known. */
  readonly line?: number
  /** Function name, when known. */
  readonly function?: string
  /** Script backtrace, most recent call first, when known. */
  readonly backtrace?: readonly GodotBacktraceFrame[]
  /** Host receive time in milliseconds since the epoch. */
  readonly time: number
}

/** Godot mouse button names accepted in input events. */
export type GodotMouseButton = 'left' | 'right' | 'middle' | 'wheel_up' | 'wheel_down' | 'wheel_left' | 'wheel_right'

/** Modifier flags shared by key and mouse events. */
export interface GodotInputModifiers {
  readonly shift?: boolean
  readonly ctrl?: boolean
  readonly alt?: boolean
  readonly meta?: boolean
}

/** One input event for the game; coordinates are game window pixels. */
export type GodotInputEvent =
  | ({ readonly kind: 'key'; readonly key?: string; readonly keycode?: number; readonly pressed: boolean; readonly echo?: boolean; readonly unicode?: number; readonly hold?: number } & GodotInputModifiers)
  | { readonly kind: 'text'; readonly text: string }
  | ({ readonly kind: 'mouse_button'; readonly button: GodotMouseButton; readonly pressed: boolean; readonly x: number; readonly y: number; readonly double?: boolean; readonly factor?: number; readonly hold?: number } & GodotInputModifiers)
  | ({ readonly kind: 'mouse_motion'; readonly x: number; readonly y: number; readonly dx?: number; readonly dy?: number } & GodotInputModifiers)
  | { readonly kind: 'action'; readonly action: string; readonly pressed: boolean; readonly strength?: number; readonly hold?: number }
  | { readonly kind: 'joy_button'; readonly device?: number; readonly button: number; readonly pressed: boolean }
  | { readonly kind: 'joy_axis'; readonly device?: number; readonly axis: number; readonly value: number }
  | { readonly kind: 'focus'; readonly focused: boolean }
  | { readonly wait: number }

/** Request to start or restart the Session's game. */
export interface GodotRunRequest {
  /** Project directory relative to the Session working directory; the nearest `project.godot` when omitted. */
  readonly project?: string
  /** `res://` scene to run instead of the main scene. */
  readonly scene?: string
  /** Game window width in pixels. */
  readonly width?: number
  /** Game window height in pixels. */
  readonly height?: number
  /** Run with the Dummy audio driver. */
  readonly muted?: boolean
}

/** Pause, resume, or step the running game. */
export interface GodotControlRequest {
  /** Requested action. */
  readonly action: 'pause' | 'resume' | 'step'
  /** Frames to advance for `step` (default 1). */
  readonly frames?: number
}

/** Items of the Game tab's follow stream. */
export type GodotFollowItem =
  | { readonly type: 'snapshot'; readonly run: GodotRunView | null; readonly runtime: GodotRuntimeView; readonly logs: readonly GodotLogEntry[]; readonly cursor: number }
  | { readonly type: 'run'; readonly run: GodotRunView | null }
  | { readonly type: 'logs'; readonly entries: readonly GodotLogEntry[]; readonly cursor: number }
  | { readonly type: 'runtime'; readonly runtime: GodotRuntimeView }

/** Where a run's layer shows in the page: a rectangle with the layer's aspect ratio, in CSS pixels of the layout viewport. */
export interface DesktopGameLayerPlacement {
  /** CAContext id of the layer, {@link GodotRunLayer.context}. */
  readonly context: number
  /** Left edge from the viewport's left edge. */
  readonly x: number
  /** Top edge from the viewport's top edge. */
  readonly y: number
  /** Width of the rectangle. */
  readonly width: number
  /** Height of the rectangle. */
  readonly height: number
  /** Width of the layer in points: the game window's width divided by {@link GodotRunLayer.scale}. */
  readonly layerWidth: number
  /** Height of the layer in points. */
  readonly layerHeight: number
}

/**
 * The macOS Desktop shell's display of run layers, at `dshDesktop.gameLayer` of the application page. The shell shows
 * each layer behind the page, which must leave the layer's rectangle transparent, and composites the game at the
 * display's refresh rate with no copy through the page.
 */
export interface DesktopGameLayerBridge {
  /**
   * Show a layer, or move one already shown.
   * @param id - the page's name for the layer, unique within the page, at most 128 characters.
   * @param placement - the layer and its rectangle.
   * @returns whether the shell shows the layer; false when it cannot host layers.
   */
  show(id: string, placement: DesktopGameLayerPlacement): Promise<boolean>
  /**
   * Stop showing a layer; an id the shell does not show is ignored.
   * @param id - the name `show` received.
   */
  hide(id: string): void
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** No `project.godot` was found for the Session. */
    'godot/no-project': { readonly directory: string }
    /** No Godot runtime resolves. */
    'godot/runtime-unavailable': { readonly message: string }
    /** The Session has no run, or its game does not accept requests. */
    'godot/not-running': Record<string, never>
    /** The run id does not name the Session's current run. */
    'godot/stale-run': { readonly runId: string }
    /** The Host already runs the configured maximum number of games. */
    'godot/too-many-runs': { readonly limit: number }
    /** The running game refused a request or did not answer in time. */
    'godot/request-failed': { readonly message: string }
  }
}
