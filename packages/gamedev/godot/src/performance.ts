/**
 * Performance samples of a running game: the harness's answer to a `performance` request, the summary that
 * `godot_performance` returns, and the summary's text.
 * @module @deepseek-ai/dsh-godot/src/performance
 */
import type { InferValue } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

const Series = z.array(z.number())
const Count = z.number().int()

/**
 * The harness's answer to a `performance` request; `runtime/wasd_harness.gd` documents its fields. Series hold
 * one value per recorded frame, in milliseconds or counts.
 */
export const PerformanceReply = z.object({
  seconds: z.number(),
  frames: Count,
  droppedFrames: Count,
  pausedFrames: Count,
  physicsSteps: Count,
  streamedFrames: Count,
  series: z.object({
    frame: Series,
    physics: Series,
    harness: Series,
    process: Series,
    draw: Series,
    gpu: Series,
    renderCpu: Series,
    objects: Series,
    primitives: Series,
    drawCalls: Series,
  }),
  monitorsStart: z.record(z.string(), z.number()),
  monitorsEnd: z.record(z.string(), z.number()),
  custom: z.record(z.string(), z.number()),
  nodes: z.object({
    total: Count,
    processing: Count,
    physicsProcessing: Count,
    truncated: z.boolean(),
    classes: z.array(z.tuple([z.string(), Count])),
    scripts: z.array(z.tuple([z.string(), Count, Count, Count])),
  }),
  context: z.object({
    paused: z.boolean(),
    timeScale: z.number(),
    maxFps: Count,
    physicsTicksPerSecond: Count,
    vsyncMode: Count,
    lowProcessorMode: z.boolean(),
    renderingMethod: z.string(),
    renderingDriver: z.string(),
    adapter: z.string(),
    adapterVendor: z.string(),
    width: Count,
    height: Count,
    streamFps: z.number(),
  }),
  timedOut: z.boolean(),
  cancelled: z.boolean(),
})

/** A performance sample as the harness reports it. */
export type PerformanceReply = z.infer<typeof PerformanceReply>

const NUMBER = { type: 'number', required: true } as const
const INTEGER = { type: 'integer', required: true } as const
const BOOLEAN = { type: 'boolean', required: true } as const
const STRING = { type: 'string', required: true } as const

const SPREAD_PROPERTIES = { mean: NUMBER, median: NUMBER, p95: NUMBER, p99: NUMBER, max: NUMBER } as const
const MEAN_MAX_PROPERTIES = { mean: NUMBER, max: NUMBER } as const
const SPREAD = { type: 'object', additionalProperties: false, required: true, properties: SPREAD_PROPERTIES } as const
const MEAN_MAX = { type: 'object', additionalProperties: false, required: true, properties: MEAN_MAX_PROPERTIES } as const
const CHANGE = { type: 'object', additionalProperties: false, required: true, properties: { start: NUMBER, end: NUMBER } } as const
const NAMED_VALUES = {
  type: 'array',
  required: true,
  items: { type: 'object', additionalProperties: false, properties: { name: STRING, value: NUMBER } },
} as const

/** Result fields of `godot_performance`, before the new-error report that every Godot tool adds. */
export const PERFORMANCE_PROPERTIES = {
  seconds: NUMBER,
  frames: INTEGER,
  fps: NUMBER,
  timedOut: BOOLEAN,
  windowless: BOOLEAN,
  droppedFrames: INTEGER,
  pausedFrames: INTEGER,
  physicsSteps: INTEGER,
  streamedFrames: INTEGER,
  frameMs: SPREAD,
  spikes: INTEGER,
  phasesMs: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: { physics: MEAN_MAX, process: MEAN_MAX, draw: MEAN_MAX, other: MEAN_MAX, harness: MEAN_MAX },
  },
  gpuMs: { type: 'object', additionalProperties: false, properties: SPREAD_PROPERTIES },
  renderCpuMs: { type: 'object', additionalProperties: false, properties: MEAN_MAX_PROPERTIES },
  drawn: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: { objects: MEAN_MAX, primitives: MEAN_MAX, drawCalls: MEAN_MAX },
  },
  memory: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: { staticBytes: NUMBER, staticPeakBytes: NUMBER, videoBytes: NUMBER, textureBytes: NUMBER, bufferBytes: NUMBER },
  },
  objects: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: { objects: CHANGE, resources: CHANGE, nodes: CHANGE, orphanNodes: CHANGE },
  },
  physics: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: { bodies2d: NUMBER, pairs2d: NUMBER, islands2d: NUMBER, bodies3d: NUMBER, pairs3d: NUMBER, islands3d: NUMBER },
  },
  pipelineCompilations: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: { canvas: NUMBER, mesh: NUMBER, surface: NUMBER, draw: NUMBER, specialization: NUMBER },
  },
  navigation: NAMED_VALUES,
  audioLatencyMs: NUMBER,
  sceneTree: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: {
      nodes: INTEGER,
      processing: INTEGER,
      physicsProcessing: INTEGER,
      truncated: BOOLEAN,
      classes: {
        type: 'array',
        required: true,
        items: { type: 'object', additionalProperties: false, properties: { name: STRING, nodes: INTEGER } },
      },
      scripts: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { path: STRING, nodes: INTEGER, processing: INTEGER, physicsProcessing: INTEGER },
        },
      },
    },
  },
  custom: NAMED_VALUES,
  context: {
    type: 'object',
    additionalProperties: false,
    required: true,
    properties: {
      paused: BOOLEAN,
      timeScale: NUMBER,
      maxFps: INTEGER,
      physicsTicksPerSecond: INTEGER,
      vsyncMode: INTEGER,
      lowProcessorMode: BOOLEAN,
      renderingMethod: STRING,
      renderingDriver: STRING,
      adapter: STRING,
      adapterVendor: STRING,
      width: INTEGER,
      height: INTEGER,
      streamFps: NUMBER,
    },
  },
} as const

const SUMMARY_SCHEMA = { type: 'object', additionalProperties: false, properties: PERFORMANCE_PROPERTIES } as const

/** A performance sample as `godot_performance` returns it: milliseconds, counts, and bytes. */
export type PerformanceSummary = InferValue<typeof SUMMARY_SCHEMA>

type Spread = PerformanceSummary['frameMs']
type MeanMax = PerformanceSummary['phasesMs']['physics']
type NamedValue = PerformanceSummary['custom'][number]

/** Frames longer than this multiple of the median frame time count as spikes. */
const SPIKE_FACTOR = 2

const VSYNC_MODES: Readonly<Record<number, string>> = { 0: 'disabled', 1: 'enabled', 2: 'adaptive', 3: 'mailbox' }

function round(value: number, digits = 2): number {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0)
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : sum(values) / values.length
}

function largest(values: readonly number[]): number {
  return values.reduce((most, value) => Math.max(most, value), 0)
}

/** Mean and nearest-rank percentiles; all 0 for no values. */
function spreadOf(values: readonly number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (quantile: number): number => round(sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] ?? 0)
  return { mean: round(mean(values)), median: rank(0.5), p95: rank(0.95), p99: rank(0.99), max: round(largest(values)) }
}

function meanMax(values: readonly number[], digits = 2): MeanMax {
  return { mean: round(mean(values), digits), max: round(largest(values), digits) }
}

/** A monitor by its constant name; a Godot version without it reports 0. */
function monitor(values: Readonly<Record<string, number>>, name: string): number {
  return values[name] ?? 0
}

/** The navigation monitors that are not 0: the 2D and 3D ones where the Godot version splits them. */
function navigationValues(values: Readonly<Record<string, number>>): NamedValue[] {
  const names = Object.keys(values).filter(name => name.startsWith('NAVIGATION_'))
  const split = names.filter(name => /^NAVIGATION_[23]D_/u.test(name))
  return (split.length > 0 ? split : names)
    .map(name => ({ name, value: monitor(values, name) }))
    .filter(entry => entry.value !== 0)
}

/**
 * Summarize a performance sample: frame time percentiles over the recorded frames, the mean and largest time of
 * each phase, GPU and render CPU times over the frames that measured them, and the monitors, scene census, and
 * conditions the harness reported.
 * @param reply - validated harness answer.
 * @param windowless - whether the game renders without a window, so VSync does not limit it.
 * @returns the summary.
 */
export function summarizePerformance(reply: PerformanceReply, windowless: boolean): PerformanceSummary {
  const { series, monitorsStart: start, monitorsEnd: end, nodes } = reply
  const frameMs = spreadOf(series.frame)
  const frameTotal = sum(series.frame)
  const other = series.frame.map((frame, index) => Math.max(0, frame
    - (series.physics[index] ?? 0) - (series.harness[index] ?? 0) - (series.process[index] ?? 0) - (series.draw[index] ?? 0)))
  const gpu = series.gpu.filter(value => value > 0)
  const renderCpu = series.renderCpu.filter(value => value > 0)
  const change = (name: string): { start: number; end: number } => ({ start: monitor(start, name), end: monitor(end, name) })
  const added = (name: string): number => Math.max(0, monitor(end, name) - monitor(start, name))
  return {
    seconds: round(reply.seconds),
    frames: reply.frames,
    fps: frameTotal > 0 ? round(series.frame.length * 1000 / frameTotal, 1) : 0,
    timedOut: reply.timedOut,
    windowless,
    droppedFrames: reply.droppedFrames,
    pausedFrames: reply.pausedFrames,
    physicsSteps: reply.physicsSteps,
    streamedFrames: reply.streamedFrames,
    frameMs,
    spikes: frameMs.median > 0 ? series.frame.filter(value => value > SPIKE_FACTOR * frameMs.median).length : 0,
    phasesMs: {
      physics: meanMax(series.physics),
      process: meanMax(series.process),
      draw: meanMax(series.draw),
      other: meanMax(other),
      harness: meanMax(series.harness),
    },
    ...gpu.length === 0 ? {} : { gpuMs: spreadOf(gpu) },
    ...renderCpu.length === 0 ? {} : { renderCpuMs: meanMax(renderCpu) },
    drawn: { objects: meanMax(series.objects, 1), primitives: meanMax(series.primitives, 1), drawCalls: meanMax(series.drawCalls, 1) },
    memory: {
      staticBytes: monitor(end, 'MEMORY_STATIC'),
      staticPeakBytes: monitor(end, 'MEMORY_STATIC_MAX'),
      videoBytes: monitor(end, 'RENDER_VIDEO_MEM_USED'),
      textureBytes: monitor(end, 'RENDER_TEXTURE_MEM_USED'),
      bufferBytes: monitor(end, 'RENDER_BUFFER_MEM_USED'),
    },
    objects: {
      objects: change('OBJECT_COUNT'),
      resources: change('OBJECT_RESOURCE_COUNT'),
      nodes: change('OBJECT_NODE_COUNT'),
      orphanNodes: change('OBJECT_ORPHAN_NODE_COUNT'),
    },
    physics: {
      bodies2d: monitor(end, 'PHYSICS_2D_ACTIVE_OBJECTS'),
      pairs2d: monitor(end, 'PHYSICS_2D_COLLISION_PAIRS'),
      islands2d: monitor(end, 'PHYSICS_2D_ISLAND_COUNT'),
      bodies3d: monitor(end, 'PHYSICS_3D_ACTIVE_OBJECTS'),
      pairs3d: monitor(end, 'PHYSICS_3D_COLLISION_PAIRS'),
      islands3d: monitor(end, 'PHYSICS_3D_ISLAND_COUNT'),
    },
    pipelineCompilations: {
      canvas: added('PIPELINE_COMPILATIONS_CANVAS'),
      mesh: added('PIPELINE_COMPILATIONS_MESH'),
      surface: added('PIPELINE_COMPILATIONS_SURFACE'),
      draw: added('PIPELINE_COMPILATIONS_DRAW'),
      specialization: added('PIPELINE_COMPILATIONS_SPECIALIZATION'),
    },
    navigation: navigationValues(end),
    audioLatencyMs: round(monitor(end, 'AUDIO_OUTPUT_LATENCY') * 1000, 1),
    sceneTree: {
      nodes: nodes.total,
      processing: nodes.processing,
      physicsProcessing: nodes.physicsProcessing,
      truncated: nodes.truncated,
      classes: nodes.classes.map(([name, count]) => ({ name, nodes: count })),
      scripts: nodes.scripts.map(([path, count, processing, physicsProcessing]) => ({ path, nodes: count, processing, physicsProcessing })),
    },
    custom: Object.entries(reply.custom).map(([name, value]) => ({ name, value })),
    context: { ...reply.context },
  }
}

/** Counts and means with thousands separators and at most one decimal, in one locale whatever the Host's is. */
const COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })
const CHANGE_COUNT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, signDisplay: 'always' })
/** Custom monitor values, which a game may keep in any unit. */
const MONITOR_VALUE = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 6 })

function count(value: number): string {
  return COUNT.format(value)
}

function signed(value: number): string {
  return CHANGE_COUNT.format(value)
}

function mebibytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function spreadText(spread: Spread): string {
  const { mean: average, median, p95, p99, max } = spread
  return `mean ${average.toFixed(2)}, median ${median.toFixed(2)}, p95 ${p95.toFixed(2)}, p99 ${p99.toFixed(2)}, max ${max.toFixed(2)}`
}

/** A phase's mean and largest milliseconds, after its label. */
function phaseText(label: string, value: MeanMax): string {
  return `${label} ${value.mean.toFixed(2)} / ${value.max.toFixed(2)}`
}

/** A per-frame count's mean and largest value, before its label. */
function drawnText(label: string, value: MeanMax): string {
  return `${count(value.mean)} / ${count(value.max)} ${label}`
}

/** A navigation monitor name as text: NAVIGATION_3D_AGENT_COUNT reads 3D agent count. */
function navigationLabel(name: string): string {
  return name.slice('NAVIGATION_'.length).toLowerCase().replaceAll('_', ' ').replace(/^([23])d /u, '$1D ')
}

function describeRun(summary: PerformanceSummary): string[] {
  const { context } = summary
  const adapter = context.adapter === '' ? '' : ` (${context.adapter})`
  const limits = [
    `VSync ${VSYNC_MODES[context.vsyncMode] ?? `mode ${context.vsyncMode}`}`,
    context.maxFps > 0 ? `max_fps ${context.maxFps}` : 'no max_fps limit',
    `${context.physicsTicksPerSecond} physics ticks per second`,
    `time scale ${context.timeScale}`,
    ...context.lowProcessorMode ? ['low processor usage mode'] : [],
  ]
  return [
    `Measured ${summary.seconds.toFixed(2)} s of real time: ${count(summary.frames)} frames at ${summary.fps.toFixed(1)} FPS`
      + `${summary.timedOut ? ', ended by its real-time limit' : ''}; the ${context.renderingMethod} renderer on ${context.renderingDriver}${adapter}`
      + ` draws a ${context.width}x${context.height} window.`,
    `Frame rate limits: ${limits.join(', ')}.`,
    ...summary.windowless && context.vsyncMode !== 0 ? ['The game renders without a window, so VSync does not limit its frame rate.'] : [],
    ...summary.frames === 0 ? ['No frame finished during the sample, so the game may be stalled; godot_logs shows its errors.'] : [],
    ...summary.pausedFrames > 0 ? [`The game was paused for ${count(summary.pausedFrames)} of the frames, which ran no node processing or physics.`] : [],
    ...summary.droppedFrames > 0 ? [`The frame statistics cover the first ${count(summary.frames - summary.droppedFrames)} frames.`] : [],
  ]
}

function describeRendering(summary: PerformanceSummary): string[] {
  const cpu = summary.renderCpuMs
  return [
    summary.gpuMs === undefined ? 'GPU time: this renderer reports none.' : `GPU time per frame (ms): ${spreadText(summary.gpuMs)}.`,
    ...cpu === undefined ? [] : [`Root viewport render CPU time per frame (ms): mean ${cpu.mean.toFixed(2)}, max ${cpu.max.toFixed(2)}.`],
  ]
}

function describeFrames(summary: PerformanceSummary): string[] {
  const { phasesMs: phases, drawn } = summary
  const spikes = summary.spikes === 1 ? '1 frame took' : `${count(summary.spikes)} frames took`
  return [
    `Frame time (ms): ${spreadText(summary.frameMs)}; ${spikes} more than twice the median.`,
    `Per frame (ms, mean / max): ${[
      phaseText('physics', phases.physics),
      phaseText('scripts and nodes', phases.process),
      phaseText('drawing', phases.draw),
      phaseText('other', phases.other),
      phaseText('WASD Engine harness', phases.harness),
    ].join(', ')}.`,
    'Physics is the physics steps with _physics_process; scripts and nodes is _process, deferred calls, and transform updates; '
      + 'drawing is the render server submitting the frame; other is waiting for the frame limit and engine work between these phases.',
    ...describeRendering(summary),
    `Drawn per frame (mean / max): ${[
      drawnText('objects', drawn.objects),
      drawnText('primitives', drawn.primitives),
      drawnText('draw calls', drawn.drawCalls),
    ].join(', ')}.`,
  ]
}

function describeResources(summary: PerformanceSummary): string[] {
  const { memory, objects, physics, pipelineCompilations: compiled } = summary
  const compilations = Object.entries(compiled).filter(([, value]) => value > 0)
  const compiledTotal = sum(compilations.map(([, value]) => value))
  const changed = (label: string, value: { start: number; end: number }): string => `${count(value.end)} ${label} (${signed(value.end - value.start)})`
  return [
    `Memory: static ${mebibytes(memory.staticBytes)} (peak ${mebibytes(memory.staticPeakBytes)}); video ${mebibytes(memory.videoBytes)}, `
      + `of which textures ${mebibytes(memory.textureBytes)} and buffers ${mebibytes(memory.bufferBytes)}.`,
    `Objects at the end, with the change during the sample: ${[
      changed('objects', objects.objects),
      changed('resources', objects.resources),
      changed('nodes', objects.nodes),
      changed('orphan nodes', objects.orphanNodes),
    ].join(', ')}.`,
    `Physics: ${count(summary.physicsSteps)} steps; ${describeBodies(physics)}.`,
    compilations.length === 0
      ? 'Pipeline compilations during the sample: none.'
      : `Pipeline compilations during the sample: ${count(compiledTotal)} (${compilations.map(([name, value]) => `${name} ${count(value)}`).join(', ')}); each one can stall a frame.`,
    ...summary.navigation.length === 0 ? [] : [`Navigation: ${summary.navigation.map(entry => `${navigationLabel(entry.name)} ${count(entry.value)}`).join(', ')}.`],
    // A muted run's Dummy audio driver reports no latency.
    ...summary.audioLatencyMs === 0 ? [] : [`Audio output latency: ${summary.audioLatencyMs.toFixed(1)} ms.`],
  ]
}

/** The active bodies, collision pairs, and islands of each physics dimension that has any. */
function describeBodies(physics: PerformanceSummary['physics']): string {
  const dimensions = [
    ['2D', physics.bodies2d, physics.pairs2d, physics.islands2d],
    ['3D', physics.bodies3d, physics.pairs3d, physics.islands3d],
  ] as const
  const active = dimensions.filter(([, bodies, pairs, islands]) => bodies + pairs + islands > 0)
  if (active.length === 0) return 'no active bodies'
  return active.map(([name, bodies, pairs, islands]) => `${name} ${count(bodies)} active bodies, ${count(pairs)} collision pairs, ${count(islands)} islands`)
    .join('; ')
}

function describeTree(summary: PerformanceSummary): string[] {
  const tree = summary.sceneTree
  return [
    `Scene tree: ${count(tree.nodes)} nodes${tree.truncated ? ' counted before the census stopped' : ''}, ${count(tree.processing)} processing each frame, `
      + `${count(tree.physicsProcessing)} physics processing.`,
    ...tree.classes.length === 0 ? [] : [`Most common classes: ${tree.classes.map(entry => `${entry.name} ${count(entry.nodes)}`).join(', ')}.`],
    ...tree.scripts.length === 0 ? [] : [`Scripts with the most nodes (nodes, processing, physics processing): ${tree.scripts
      .map(entry => `${entry.path} ${count(entry.nodes)}, ${count(entry.processing)}, ${count(entry.physicsProcessing)}`).join('; ')}.`],
    ...summary.custom.length === 0 ? [] : [`Custom monitors: ${summary.custom.map(entry => `${entry.name} ${MONITOR_VALUE.format(entry.value)}`).join(', ')}.`],
    ...summary.streamedFrames === 0 ? [] : [`The Game tab streamed ${count(summary.streamedFrames)} frames during the sample; `
      + 'the WASD Engine harness time includes reading each one back from the GPU and encoding it.'],
  ]
}

/**
 * Describe a performance summary for the model.
 * @param summary - summary from {@link summarizePerformance}.
 * @returns paragraphs: the run and its limits, frame times, resources, and the scene tree.
 */
export function formatPerformance(summary: PerformanceSummary): string {
  return [describeRun(summary), describeFrames(summary), describeResources(summary), describeTree(summary)]
    .map(lines => lines.join('\n'))
    .join('\n\n')
}
