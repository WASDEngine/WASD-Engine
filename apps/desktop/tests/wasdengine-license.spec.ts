/**
 * The fork is licensed under the GNU General Public License, version 3 only: `LICENSE` holds its text, and
 * `wasdengine/deepseek-harness-MIT.txt` keeps the MIT License and copyright notice of DeepSeek Harness. The License
 * section of `wasdengine/FORK.md` (repository root) describes the files, and its merge checklist runs this spec.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const ROOT = new URL('../../../', import.meta.url)
/** SHA-256 of https://www.gnu.org/licenses/gpl-3.0.txt. */
const GPL_3_0_SHA256 = '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986'
const GAME_TOOL_PACKAGES = ['app-mcp', 'blender', 'gimp', 'godot', 'supercollider', 'ui-game-tools']

/**
 * Read the `license` field of a package manifest.
 * @param directory - Package directory relative to the repository root, ending in `/`.
 * @returns The field's value.
 */
function manifestLicense(directory: string): string | undefined {
  return (JSON.parse(readFileSync(new URL(`${directory}package.json`, ROOT), 'utf8')) as { license?: string }).license
}

describe('WASD Engine license', () => {
  it('is the GNU General Public License, version 3, in LICENSE', () => {
    expect(createHash('sha256').update(readFileSync(new URL('LICENSE', ROOT))).digest('hex')).toBe(GPL_3_0_SHA256)
  })

  it('keeps the MIT License and copyright notice of DeepSeek Harness', () => {
    expect(readFileSync(new URL('wasdengine/deepseek-harness-MIT.txt', ROOT), 'utf8'))
      .toMatch(/^MIT License\n\nCopyright \(c\) \d{4}(?:-\d{4})? DeepSeek\n\nPermission is hereby granted, free of charge/u)
  })

  it('is the license that the Desktop app and every game tool package declare', () => {
    const gamedev = readdirSync(new URL('packages/gamedev/', ROOT), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(new URL(`packages/gamedev/${entry.name}/package.json`, ROOT)))
      .map(entry => entry.name)
    expect(gamedev).toEqual(expect.arrayContaining(GAME_TOOL_PACKAGES))
    for (const directory of ['apps/desktop/', ...gamedev.map(name => `packages/gamedev/${name}/`)]) {
      expect(manifestLicense(directory), directory).toBe('GPL-3.0-only')
    }
  })
})
