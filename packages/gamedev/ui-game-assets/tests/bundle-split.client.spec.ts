/**
 * The Assets tab's browser artifacts: the startup bundle loads the viewer chunk on demand, and the two share no chunk,
 * since the Client module loader cannot require a chunk that neither loaded on demand.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const lib = join(resolve(import.meta.dirname, '..'), 'lib')
const entryPath = join(lib, 'client.js')
const viewerPath = join(lib, 'client.viewer.js')

/** The package chunks a bundle requires at once, which the loader has only when another load materialized them. */
function chunksRequired(code: string): string[] {
  return [...code.matchAll(/\brequire\((["'`])(\.\/client[^"'`/]*\.js)\1\)/gu)].map(match => match[2] ?? '')
}

describe('Assets tab client artifacts', () => {
  it.skipIf(!existsSync(entryPath))('loads the viewer chunk on demand and shares no other chunk with it', () => {
    const entry = readFileSync(entryPath, 'utf8')
    const loaded = [...entry.matchAll(/\brequire\.async\((["'`])(\.\/client[^"'`/]*\.js)\1\)/gu)].map(match => match[2])
    expect([...new Set(loaded)]).toEqual(['./client.viewer.js'])
    expect(chunksRequired(entry)).toEqual([])
    expect(chunksRequired(readFileSync(viewerPath, 'utf8'))).toEqual([])
  })
})
