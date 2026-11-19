/**
 * The kit for game tool plugins (`@deepseek-ai/dsh-game-mcp/kit`): what its module graph imports, so a plugin bundles
 * it without the server, and its path and file helpers.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { pathWithin, replaceableFile, statOf } from '../src/kit.ts'

const SOURCE = resolve(import.meta.dirname, '../src')

/** The value imports and re-exports of one module: `import type` and `export type` bring in no code. */
async function valueImports(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8')
  const statements = /^(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+'([^']+)'/gmu
  return [...text.matchAll(statements)].map(match => match[1] as string)
}

async function temporaryFolder(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'dsh-game-mcp-kit-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  return folder
}

describe('the kit entry', () => {
  it('imports only Node built-ins beside its own modules, so no plugin that bundles it carries the server', async () => {
    const seen = new Set<string>()
    const outside = new Set<string>()
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return
      seen.add(file)
      for (const specifier of await valueImports(file)) {
        if (specifier.startsWith('./')) await visit(resolve(SOURCE, specifier))
        else outside.add(specifier)
      }
    }
    await visit(resolve(SOURCE, 'kit.ts'))
    expect([...seen].map(file => file.slice(SOURCE.length + 1)).sort()).toEqual(['kit.ts', 'plugin-kit.ts', 'project-tools.ts'])
    expect([...outside].filter(specifier => !specifier.startsWith('node:'))).toEqual([])
  })
})

describe('pathWithin', () => {
  it('gives the `/`-separated path inside a folder, empty for the folder itself, and nothing outside it', () => {
    const folder = resolve('/projects/game')
    expect(pathWithin(folder, join(folder, 'art', 'hero.png'))).toBe('art/hero.png')
    expect(pathWithin(folder, folder)).toBe('')
    expect(pathWithin(folder, join(folder, '..x'))).toBe('..x')
    expect(pathWithin(folder, resolve('/projects/game..x'))).toBeUndefined()
    expect(pathWithin(folder, resolve('/projects'))).toBeUndefined()
  })
})

describe('statOf', () => {
  it('reads what is at a path, and nothing where nothing is', async () => {
    const folder = await temporaryFolder()
    await writeFile(join(folder, 'a.txt'), 'abc')
    expect((await statOf(join(folder, 'a.txt')))?.size).toBe(3)
    expect(await statOf(join(folder, 'missing.txt'))).toBeUndefined()
  })
})

describe('replaceableFile', () => {
  it('finds no file at a free path, and a file that the call may replace', async () => {
    const folder = await temporaryFolder()
    await writeFile(join(folder, 'old.wav'), 'x')
    expect(await replaceableFile(join(folder, 'new.wav'), 'new.wav', false)).toBe(false)
    expect(await replaceableFile(join(folder, 'old.wav'), 'old.wav', true)).toBe(true)
  })

  it('refuses a folder, and a file that the call may not replace', async () => {
    const folder = await temporaryFolder()
    await mkdir(join(folder, 'sounds'))
    await writeFile(join(folder, 'old.wav'), 'x')
    await writeFile(join(folder, 'empty.png'), '')
    await expect(replaceableFile(join(folder, 'sounds'), 'sounds', true)).rejects.toThrow('sounds is a folder; pass the path of a file.')
    await expect(replaceableFile(join(folder, 'old.wav'), 'old.wav', false)).rejects.toThrow(
      'old.wav already exists. Pass replace: true to overwrite it, or choose another path.',
    )
    await expect(replaceableFile(join(folder, 'empty.png'), 'empty.png', false)).rejects.toThrow('empty.png already exists. Pass replace')
    await expect(replaceableFile(join(folder, 'empty.png'), 'empty.png', false, 'image_generate')).rejects.toThrow(
      'empty.png already exists as an empty file, which another image_generate call may still be making. Pass replace: true to overwrite it, or choose another path.',
    )
  })
})
