/** A performance sample becomes the statistics and the text that `godot_performance` returns. */
import { describe, expect, it } from 'vitest'
import { formatPerformance, PerformanceReply, summarizePerformance } from '../src/performance.ts'

const MIB = 1024 * 1024
const NO_SERIES = {
  frame: [], physics: [], harness: [], process: [], draw: [], gpu: [], renderCpu: [], objects: [], primitives: [], drawCalls: [],
}

function reply(overrides: Partial<PerformanceReply> = {}): PerformanceReply {
  return {
    seconds: 2.004,
    frames: 4,
    droppedFrames: 0,
    pausedFrames: 0,
    physicsSteps: 5,
    streamedFrames: 60,
    series: {
      frame: [16, 16, 17, 40],
      physics: [1, 1, 1, 2],
      harness: [0.5, 0.5, 0.5, 9],
      process: [2, 2, 3, 20],
      draw: [3, 3, 3, 5],
      gpu: [0, 5, 6, 7],
      renderCpu: [0, 1, 1, 2],
      objects: [10, 10, 12, 12],
      primitives: [1000, 1000, 1200, 1200],
      drawCalls: [5, 5, 6, 6],
    },
    monitorsStart: {
      OBJECT_COUNT: 100, OBJECT_RESOURCE_COUNT: 10, OBJECT_NODE_COUNT: 20, OBJECT_ORPHAN_NODE_COUNT: 0,
      PIPELINE_COMPILATIONS_MESH: 3, PIPELINE_COMPILATIONS_SURFACE: 1,
    },
    monitorsEnd: {
      OBJECT_COUNT: 1150, OBJECT_RESOURCE_COUNT: 10, OBJECT_NODE_COUNT: 30, OBJECT_ORPHAN_NODE_COUNT: 2,
      PIPELINE_COMPILATIONS_MESH: 5, PIPELINE_COMPILATIONS_SURFACE: 2,
      MEMORY_STATIC: 50 * MIB, MEMORY_STATIC_MAX: 60 * MIB,
      RENDER_VIDEO_MEM_USED: 100 * MIB, RENDER_TEXTURE_MEM_USED: 60 * MIB, RENDER_BUFFER_MEM_USED: 20.5 * MIB,
      PHYSICS_3D_ACTIVE_OBJECTS: 12, PHYSICS_3D_COLLISION_PAIRS: 30, PHYSICS_3D_ISLAND_COUNT: 4,
      NAVIGATION_ACTIVE_MAPS: 1, NAVIGATION_2D_ACTIVE_MAPS: 0, NAVIGATION_3D_ACTIVE_MAPS: 1, NAVIGATION_3D_AGENT_COUNT: 7,
      AUDIO_OUTPUT_LATENCY: 0.015,
    },
    custom: { 'game/enemies': 12, 'game/load': 0.5, 'game/budget_ms': 12345.678 },
    nodes: {
      total: 1234,
      processing: 300,
      physicsProcessing: 40,
      truncated: false,
      classes: [['MeshInstance3D', 400], ['Node3D', 200]],
      scripts: [['res://enemy.gd', 120, 120, 0], ['res://bullet.gd', 60, 60, 60]],
    },
    context: {
      paused: false, timeScale: 1, maxFps: 0, physicsTicksPerSecond: 60, vsyncMode: 1, lowProcessorMode: false,
      renderingMethod: 'forward_plus', renderingDriver: 'vulkan', adapter: 'Example GPU', adapterVendor: 'Example',
      width: 1280, height: 720, streamFps: 30,
    },
    timedOut: false,
    cancelled: false,
    ...overrides,
  }
}

describe('performance summary', () => {
  it('computes frame time percentiles, phase means, GPU times of the measured frames, and monitor changes', () => {
    const summary = summarizePerformance(reply(), false)
    expect(summary).toMatchObject({
      seconds: 2,
      frames: 4,
      fps: 44.9,
      frameMs: { mean: 22.25, median: 16, p95: 40, p99: 40, max: 40 },
      spikes: 1,
      phasesMs: {
        physics: { mean: 1.25, max: 2 },
        process: { mean: 6.75, max: 20 },
        draw: { mean: 3.5, max: 5 },
        other: { mean: 8.13, max: 9.5 },
        harness: { mean: 2.63, max: 9 },
      },
      gpuMs: { mean: 6, median: 6, p95: 7, p99: 7, max: 7 },
      renderCpuMs: { mean: 1.33, max: 2 },
      drawn: { drawCalls: { mean: 5.5, max: 6 } },
      objects: { objects: { start: 100, end: 1150 }, orphanNodes: { start: 0, end: 2 } },
      pipelineCompilations: { canvas: 0, mesh: 2, surface: 1, draw: 0, specialization: 0 },
      navigation: [{ name: 'NAVIGATION_3D_ACTIVE_MAPS', value: 1 }, { name: 'NAVIGATION_3D_AGENT_COUNT', value: 7 }],
      audioLatencyMs: 15,
      sceneTree: { nodes: 1234, classes: [{ name: 'MeshInstance3D', nodes: 400 }, { name: 'Node3D', nodes: 200 }] },
      custom: [{ name: 'game/enemies', value: 12 }, { name: 'game/load', value: 0.5 }, { name: 'game/budget_ms', value: 12345.678 }],
    })
  })

  it('describes the run, its frames, its resources, and the scene tree', () => {
    expect(formatPerformance(summarizePerformance(reply(), false))).toBe([
      'Measured 2.00 s of real time: 4 frames at 44.9 FPS; the forward_plus renderer on vulkan (Example GPU) draws a 1280x720 window.',
      'Frame rate limits: VSync enabled, no max_fps limit, 60 physics ticks per second, time scale 1.',
      '',
      'Frame time (ms): mean 22.25, median 16.00, p95 40.00, p99 40.00, max 40.00; 1 frame took more than twice the median.',
      'Per frame (ms, mean / max): physics 1.25 / 2.00, scripts and nodes 6.75 / 20.00, drawing 3.50 / 5.00, other 8.13 / 9.50, '
      + 'WASD Engine harness 2.63 / 9.00.',
      'Physics is the physics steps with _physics_process; scripts and nodes is _process, deferred calls, and transform updates; '
      + 'drawing is the render server submitting the frame; other is waiting for the frame limit and engine work between these phases.',
      'GPU time per frame (ms): mean 6.00, median 6.00, p95 7.00, p99 7.00, max 7.00.',
      'Root viewport render CPU time per frame (ms): mean 1.33, max 2.00.',
      'Drawn per frame (mean / max): 11 / 12 objects, 1,100 / 1,200 primitives, 5.5 / 6 draw calls.',
      '',
      'Memory: static 50.0 MiB (peak 60.0 MiB); video 100.0 MiB, of which textures 60.0 MiB and buffers 20.5 MiB.',
      'Objects at the end, with the change during the sample: 1,150 objects (+1,050), 10 resources (+0), 30 nodes (+10), 2 orphan nodes (+2).',
      'Physics: 5 steps; 3D 12 active bodies, 30 collision pairs, 4 islands.',
      'Pipeline compilations during the sample: 3 (mesh 2, surface 1); each one can stall a frame.',
      'Navigation: 3D active maps 1, 3D agent count 7.',
      'Audio output latency: 15.0 ms.',
      '',
      'Scene tree: 1,234 nodes, 300 processing each frame, 40 physics processing.',
      'Most common classes: MeshInstance3D 400, Node3D 200.',
      'Scripts with the most nodes (nodes, processing, physics processing): res://enemy.gd 120, 120, 0; res://bullet.gd 60, 60, 60.',
      'Custom monitors: game/enemies 12, game/load 0.5, game/budget_ms 12,345.7.',
      'The Game tab streamed 60 frames during the sample; the WASD Engine harness time includes reading each one back from the GPU and encoding it.',
    ].join('\n'))
  })

  it('says when no frame finished, and that a windowless run is not limited by VSync', () => {
    const text = formatPerformance(summarizePerformance(reply({
      frames: 0, physicsSteps: 0, streamedFrames: 0, series: NO_SERIES, monitorsStart: {}, monitorsEnd: {}, custom: {},
    }), true))
    expect(text).toContain('Measured 2.00 s of real time: 0 frames at 0.0 FPS;')
    expect(text).toContain('The game renders without a window, so VSync does not limit its frame rate.')
    expect(text).toContain('No frame finished during the sample, so the game may be stalled; godot_logs shows its errors.')
    expect(text).toContain('Frame time (ms): mean 0.00, median 0.00, p95 0.00, p99 0.00, max 0.00; 0 frames took more than twice the median.')
    expect(text).toContain('GPU time: this renderer reports none.')
    expect(text).toContain('Physics: 0 steps; no active bodies.')
    expect(text).toContain('Pipeline compilations during the sample: none.')
    expect(text).not.toContain('Root viewport render CPU time')
    expect(text).not.toContain('Navigation:')
    expect(text).not.toContain('Audio output latency')
    expect(text).not.toContain('The Game tab streamed')
  })

  it('reports paused, unrecorded, and limited frames, a cut census, and older navigation monitors', () => {
    const text = formatPerformance(summarizePerformance(reply({
      frames: 5,
      pausedFrames: 3,
      droppedFrames: 1,
      timedOut: true,
      streamedFrames: 0,
      monitorsEnd: { NAVIGATION_AGENT_COUNT: 3, NAVIGATION_MAP_COUNT: 0, PHYSICS_2D_ACTIVE_OBJECTS: 2 },
      custom: {},
      nodes: { total: 1234, processing: 300, physicsProcessing: 40, truncated: true, classes: [], scripts: [] },
      context: {
        ...reply().context, adapter: '', maxFps: 30, vsyncMode: 7, lowProcessorMode: true, timeScale: 0.5,
      },
    }), true))
    expect(text).toContain('Measured 2.00 s of real time: 5 frames at 44.9 FPS, ended by its real-time limit; the forward_plus renderer on vulkan draws')
    expect(text).toContain('Frame rate limits: VSync mode 7, max_fps 30, 60 physics ticks per second, time scale 0.5, low processor usage mode.')
    expect(text).toContain('The game was paused for 3 of the frames, which ran no node processing or physics.')
    expect(text).toContain('The frame statistics cover the first 4 frames.')
    expect(text).toContain('Physics: 5 steps; 2D 2 active bodies, 0 collision pairs, 0 islands.')
    expect(text).toContain('Navigation: agent count 3.')
    expect(text).toContain('Scene tree: 1,234 nodes counted before the census stopped, 300 processing each frame, 40 physics processing.')
    expect(text).not.toContain('Most common classes')
    expect(text).not.toContain('Scripts with the most nodes')
    expect(text).not.toContain('Custom monitors')
    const disabled = formatPerformance(summarizePerformance(reply({ context: { ...reply().context, vsyncMode: 0 } }), true))
    expect(disabled).toContain('Frame rate limits: VSync disabled,')
    expect(disabled).not.toContain('VSync does not limit')
  })

  it('rejects a harness answer without its series', () => {
    const { series: _series, ...rest } = reply()
    expect(() => PerformanceReply.parse(rest)).toThrow()
  })
})
