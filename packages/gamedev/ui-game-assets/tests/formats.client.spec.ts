/**
 * The Assets tab and the agent's asset tools list the same art: the browser half's copy of the format table and of the
 * Blender export lookup match `@deepseek-ai/dsh-game-assets/formats`, which `asset_search` and `asset_view` read.
 */
import * as host from '@deepseek-ai/dsh-game-assets/formats'
import { describe, expect, it } from 'vitest'
import { exportOf } from '../src/client/AssetViewer.tsx'
import { ASSET_FORMATS, extensionOf, formatOf, isBlendFormat } from '../src/client/formats.ts'
import type { AssetEntry } from '../src/client/scan.ts'

function entry(path: string): AssetEntry {
  const slash = path.lastIndexOf('/')
  const format = formatOf(path)
  if (format === undefined) throw new Error(`not an asset: ${path}`)
  return { path, name: path.slice(slash + 1), folder: slash < 0 ? '' : path.slice(0, slash), format }
}

describe('the format table shared with the asset tools', () => {
  it('matches the asset tools\' table and helpers', () => {
    expect(ASSET_FORMATS).toEqual(host.ASSET_FORMATS)
    for (const name of ['a.PNG', 'b.glb', 'c.blend', 'notes.txt', '.hidden', 'dir/x.tar.gz']) {
      expect(extensionOf(name)).toBe(host.extensionOf(name))
      expect(formatOf(name)).toEqual(host.formatOf(name))
    }
    const blend = formatOf('a.blend')
    const glb = formatOf('a.glb')
    expect(blend !== undefined && isBlendFormat(blend)).toBe(true)
    expect(glb !== undefined && isBlendFormat(glb)).toBe(false)
  })

  it('picks the same Blender export as the asset tools', () => {
    const assets = ['art/hero.blend', 'art/hero.fbx', 'art/models/hero.glb', 'hero.gltf', 'other/hero.glb', 'art/hero.png'].map(entry)
    for (const blend of ['art/hero.blend', 'art/sub/hero.blend', 'hero.blend', 'other/x/hero.blend', 'nothing/villain.blend'].map(entry)) {
      expect(exportOf(blend, assets)?.path).toBe(host.exportOf(blend, assets)?.path)
    }
  })
})
