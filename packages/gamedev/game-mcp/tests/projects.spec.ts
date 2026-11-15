/**
 * A connected agent's `create_game_project` creates a game project through the Workspace controller's game project
 * controller, as the Create game project dialog does: in the location it names or in WASD Engine's folder for game
 * projects, without a Session, and with a result or an error that tells the agent what happened.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { GameProjectController } from '@deepseek-ai/dsh-api-workspace-controller'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpCallResult } from '../src/catalog.ts'
import { createGameProject } from '../src/projects.ts'

const CREATED_AT = '2026-11-14T00:00:00.000Z'

let root: string
let ctx: Context
/** Registrations of the fake Workspace registry, by canonical path. */
let registered: string[]
const signal = new AbortController().signal

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-game-mcp-projects-')))
  registered = []
  ctx = new Context()
  ctx.provide('workspaceRegistry', {
    create: async (path: string) => {
      const canonical = await realpath(path)
      registered.push(canonical)
      return { id: `w${registered.length}`, path: canonical, title: basename(canonical), sessionIds: [], createdAt: CREATED_AT, updatedAt: CREATED_AT }
    },
  } as never)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

/**
 * Mount the game project controller with the test's Documents folder.
 * @param git - the Git commands' runner; by default every command succeeds.
 * @returns the Git commands it ran, with their folders.
 */
function mountProjects(git: (args: readonly string[]) => Promise<string> = () => Promise.resolve('')): Array<{ args: readonly string[]; cwd: string }> {
  const commands: Array<{ args: readonly string[]; cwd: string }> = []
  new GameProjectController(ctx, { documentsDirectory: join(root, 'Documents'), documentsLookupTimeoutMs: 10_000, required: false }, (args, cwd) => {
    commands.push({ args, cwd })
    return git(args)
  })
  return commands
}

function text(result: McpCallResult): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

describe('create_game_project', () => {
  it('creates the folder in WASD Engine\'s folder for game projects with a repository, registers it, and names it', async () => {
    const commands = mountProjects()
    const result = await createGameProject(ctx, { name: '  Space Frogs  ' }, signal)

    const path = join(root, 'Documents', 'WASD Engine', 'Space Frogs')
    expect(result.isError).toBeUndefined()
    expect(text(result)).toBe(`Created the game project "Space Frogs" in ${path}, which WASD Engine lists among the user's game projects. `
      + 'The folder holds a Git repository with one empty commit and nothing else. Make the game in this folder, and pass its path as project to the game tools.')
    expect(existsSync(path)).toBe(true)
    expect(registered).toEqual([path])
    expect(commands.map(command => [command.args.find(arg => arg === 'init' || arg === 'commit'), command.cwd])).toEqual([['init', path], ['commit', path]])
  })

  it('creates the folder in the location the call names, with the folders above it', async () => {
    mountProjects()
    const location = join(root, 'games', 'jams')
    const result = await createGameProject(ctx, { name: 'Moon Miner', location }, signal)

    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain(`in ${join(location, 'Moon Miner')}, which WASD Engine lists`)
    expect(registered).toEqual([join(location, 'Moon Miner')])
    expect(existsSync(join(root, 'Documents'))).toBe(false)
  })

  it('says when the folder holds no repository because Git is missing', async () => {
    mountProjects(() => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })))
    const result = await createGameProject(ctx, { name: 'No Git', location: root }, signal)

    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('The folder is empty, without a Git repository. Make the game in this folder')
    expect(registered).toEqual([join(root, 'No Git')])
  })

  it('refuses arguments, names, locations, and paths it cannot use, and registers nothing', async () => {
    mountProjects()
    await mkdir(join(root, 'Taken'))
    await writeFile(join(root, 'file'), '')
    const cases: Array<[Record<string, string | number>, string]> = [
      [{}, 'Pass name, the name of the game project.'],
      [{ name: 7 }, 'Pass name, the name of the game project.'],
      [{ name: 'Game', location: 7 }, 'location must be a string: the absolute path of the folder to create the project in.'],
      [{ name: 'a/b', location: root }, '"a/b" is not a folder name that every computer accepts. Pass a name without / \\ : * ? " < > |, control characters, or a trailing period, of at most 255 bytes.'],
      [{ name: 'Game', location: 'games' }, 'location must be the absolute path of a folder, got "games".'],
      [{ name: 'Taken', location: root }, `${join(root, 'Taken')} already exists; pass another name or location.`],
    ]
    for (const [args, message] of cases) {
      const result = await createGameProject(ctx, args, signal)
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toBe(message)
    }
    const blocked = await createGameProject(ctx, { name: 'Game', location: join(root, 'file', 'child') }, signal)
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toMatch(/^WASD Engine could not create the game project: cannot create ".*file\/child": /u)
    expect(registered).toEqual([])
  })

  it('asks for a location when WASD Engine cannot find the Documents folder', async () => {
    const create = vi.fn()
    ctx.provide('gameProjectController', { defaults: () => Promise.resolve({ directory: null, required: false }), create } as never)
    const result = await createGameProject(ctx, { name: 'Game' }, signal)

    expect(result.isError).toBe(true)
    expect(text(result)).toBe('WASD Engine cannot find the user\'s Documents folder, where it keeps game projects; pass location, the absolute path of the folder to create the project in.')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses when WASD Engine keeps no game projects', async () => {
    const result = await createGameProject(ctx, { name: 'Game', location: root }, signal)
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('This WASD Engine keeps no game projects, so it cannot create one.')
  })
})
