/**
 * Build `lib/wasdengine-game-layer.node`, the Node-API module through which the macOS Desktop main process shows the
 * layer of a windowless game behind the page (`src/wasdengine-game-layer.ts`), from
 * `wasdengine/game-layer/game_layer.mm`. The build runs only on macOS, where it needs Xcode or the Command Line Tools
 * and the Node-API headers of the Node installation that runs it; one file holds the arm64 and x86_64 code, so both
 * macOS targets package the same module. On other platforms the script builds nothing.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GAME_LAYER_MODULE } from '../src/wasdengine-game-layer-names.ts'

/** The oldest macOS release the module runs on, the deployment target of LibGodot's arm64 runner. */
const MACOS_MINIMUM = '11.0'

const desktopRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * The compiler invocation that builds the module.
 * @param source - path of `game_layer.mm`.
 * @param output - path of the module to write.
 * @param headers - directory holding `node_api.h`.
 * @returns the `clang++` arguments.
 */
export function gameLayerCompileArgs(source: string, output: string, headers: string): string[] {
  return [
    '-std=c++17', '-fobjc-arc', '-O2', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
    '-arch', 'arm64', '-arch', 'x86_64', `-mmacosx-version-min=${MACOS_MINIMUM}`,
    // Node-API symbols resolve against the Electron binary that loads the module.
    '-bundle', '-undefined', 'dynamic_lookup', '-DNAPI_VERSION=8', '-I', headers,
    '-framework', 'AppKit', '-framework', 'QuartzCore',
    '-o', output, source,
  ]
}

/**
 * Compile the module into `lib/`, replacing an earlier build only once the new one is complete.
 * @param root - the Desktop application directory.
 * @returns the module path.
 * @throws {Error} When the Node-API headers are missing or the compiler fails.
 */
export function buildGameLayerModule(root = desktopRoot): string {
  const headers = resolve(dirname(process.execPath), '../include/node')
  if (!existsSync(join(headers, 'node_api.h'))) {
    throw new Error(`wasdengine-game-layer: Node-API headers are missing at ${headers}; run the build with a Node installation that has its development headers`)
  }
  const output = join(root, 'lib', GAME_LAYER_MODULE)
  const partial = `${output}.partial`
  mkdirSync(dirname(output), { recursive: true })
  rmSync(partial, { force: true })
  const result = spawnSync('xcrun', ['clang++', ...gameLayerCompileArgs(join(root, 'wasdengine', 'game-layer', 'game_layer.mm'), partial, headers)], { stdio: 'inherit' })
  if (result.error !== undefined) throw new Error(`wasdengine-game-layer: cannot run xcrun clang++ (${result.error.message}); install Xcode or the Command Line Tools`)
  if (result.status !== 0) {
    rmSync(partial, { force: true })
    throw new Error(`wasdengine-game-layer: clang++ exited with ${String(result.status ?? result.signal)}`)
  }
  renameSync(partial, output)
  return output
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.platform === 'darwin') {
  buildGameLayerModule()
}
