/**
 * Builds a project exports for the user to share or upload anywhere, beside the desktop builds of `release.ts`: the
 * Web build packed into one ZIP file for game sites such as itch.io (`.wasdengine/web-zip/`), and the mobile builds
 * (`.wasdengine/mobile/<platform>/`), an Android APK and an iOS Xcode project.
 * @module @deepseek-ai/dsh-wasd-plugins/src/exports
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { GodotMobilePlatform, GodotWebExport } from '@deepseek-ai/dsh-godot'
import { STATE_DIR } from './release.ts'
import type { WasdWebZip } from './types.ts'
import { writeZip } from './zip.ts'

/** The mobile builds' folder inside {@link STATE_DIR}, which holds one folder per platform. */
export const MOBILE_BUILD_DIR = 'mobile'

/** The folder inside {@link STATE_DIR} of the Web build's ZIP file. */
export const WEB_ZIP_DIR = 'web-zip'

/** The mobile platforms an export builds for, in the order they build. */
export const MOBILE_PLATFORMS: readonly GodotMobilePlatform[] = ['android', 'ios']

/** The mobile platforms' names as results write them. */
export const MOBILE_PLATFORM_NAMES: Readonly<Record<GodotMobilePlatform, string>> = { android: 'Android', ios: 'iOS' }

/**
 * Pack a Web build into one ZIP file named after the game, with `index.html` at its root, as game sites take an HTML5
 * game: `.wasdengine/web-zip/<game>.zip`, which replaces the folder's earlier archive.
 * @param exported - the Web export.
 * @param signal - cancellation; a cancelled archive is deleted.
 * @returns the archive.
 */
export async function zipWebBuild(exported: GodotWebExport, signal: AbortSignal): Promise<WasdWebZip> {
  const folder = join(exported.projectDir, STATE_DIR, WEB_ZIP_DIR)
  await rm(folder, { recursive: true, force: true })
  await mkdir(folder, { recursive: true })
  const file = join(folder, `${exported.fileName}.zip`)
  try {
    return { file, bytes: await writeZip(exported.outputDir, exported.files.map(entry => entry.path), file, signal) }
  } catch (error) {
    await rm(file, { force: true })
    throw error
  }
}
