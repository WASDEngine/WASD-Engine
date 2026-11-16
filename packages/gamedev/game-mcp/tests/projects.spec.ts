/**
 * A connected agent's `create_game_project` creates a game project through the Workspace controller's game project
 * controller, as the Create game project dialog does: in the location it names, unless that is in a temporary folder,
 * or in WASD Engine's folder for game projects, without a Session, and with a result or an error that tells the agent
 * what happened. The calls pass no temporary folders unless they test them, because the system's temporary folder holds
 * the test's folder.
 */
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { GameProjectController } from '@deepseek-ai/dsh-api-workspace-controller'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpCallResult } from '../src/catalog.ts'
import { createGameProject } from '../src/projects.ts'
import type { JsonObject } from '../src/provider.ts'

const CREATED_AT = '2026-11-14T00:00:00.000Z'

/** What the agent reads, after the quoted name, about a device name that Windows reserves. */
const DEVICE_TEXT = 'is not a folder name that every computer accepts: Windows reserves CON, PRN, AUX, NUL, COM0 to COM9, COM¹, COM², '
  + 'COM³, LPT0 to LPT9, LPT¹, LPT², and LPT³ for devices, with or without an extension. Pass another name.'

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
    const result = await createGameProject(ctx, { name: '  Space Frogs  ' }, signal, [])

    const path = join(root, 'Documents', 'WASD Engine', 'Space Frogs')
    expect(result.isError).toBeUndefined()
    // The plugins come from search_game_tools, whose list is complete where a cut overview's is not; add-ons install into a
    // project.godot that the empty folder does not have yet; and the Blender, GIMP, and SuperCollider tools refuse project
    // without session.
    expect(text(result)).toBe(`Created the game project "Space Frogs" in ${path}, which WASD Engine lists among the user's game projects. `
      + 'The folder holds a Git repository with one empty commit and nothing else. '
      + 'Before you write code, plan the game around the plugins that search_game_tools lists, and read the guide of each one you will use. '
      + 'Make the game in this folder, and write its project.godot before you install add-ons into it. '
      + 'Where a game tool takes project, pass this folder\'s absolute path; the blender_*, gimp_*, and supercollider_* tools take project '
      + 'only together with session.')
    expect(existsSync(path)).toBe(true)
    expect(registered).toEqual([path])
    expect(commands.map(command => [command.args.find(arg => arg === 'init' || arg === 'commit'), command.cwd])).toEqual([['init', path], ['commit', path]])
  })

  it('creates the folder in the location the call names, with the folders above it', async () => {
    mountProjects()
    const location = join(root, 'games', 'jams')
    const result = await createGameProject(ctx, { name: 'Moon Miner', location }, signal, [])

    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain(`in ${join(location, 'Moon Miner')}, which WASD Engine lists`)
    expect(registered).toEqual([join(location, 'Moon Miner')])
    expect(existsSync(join(root, 'Documents'))).toBe(false)
  })

  it('trims the location as the dialog does, and creates the folder in the default folder for a null, empty, or blank one', async () => {
    mountProjects()
    const location = join(root, 'jams')
    const spaced = await createGameProject(ctx, { name: 'Moon Miner', location: `  ${location} ` }, signal, [])
    expect(spaced.isError).toBeUndefined()
    expect(text(spaced)).toContain(`in ${join(location, 'Moon Miner')}, which WASD Engine lists`)
    expect(existsSync(`${location} `)).toBe(false)
    const omitted: JsonObject[] = [{ name: 'Null', location: null }, { name: 'Empty', location: '' }, { name: 'Blank', location: '   ' }]
    for (const args of omitted) {
      const result = await createGameProject(ctx, args, signal, [])
      expect(result.isError, JSON.stringify(args)).toBeUndefined()
    }
    const documents = join(root, 'Documents', 'WASD Engine')
    expect(registered).toEqual([join(location, 'Moon Miner'), join(documents, 'Null'), join(documents, 'Empty'), join(documents, 'Blank')])
  })

  it('says when the folder holds no repository because Git is missing', async () => {
    mountProjects(() => Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })))
    const result = await createGameProject(ctx, { name: 'No Git', location: root }, signal, [])

    expect(result.isError).toBeUndefined()
    expect(text(result)).toContain('The folder is empty, without a Git repository. Before you write code, plan the game')
    expect(registered).toEqual([join(root, 'No Git')])
  })

  it('refuses arguments, names, locations, and paths it cannot use, and registers nothing', async () => {
    mountProjects()
    await mkdir(join(root, 'Taken'))
    await writeFile(join(root, 'file'), '')
    const cases: Array<[JsonObject, string]> = [
      [{}, 'Pass name, the name of the game project.'],
      [{ name: 7 }, 'Pass name, the name of the game project.'],
      [{ name: 'Game', location: 7 }, 'location must be a string: the absolute path of the folder to create the project in.'],
      [{ name: 'a/b', location: root }, '"a/b" is not a folder name that every computer accepts. Pass a name without / \\ : * ? " < > |, control characters, or a trailing period, of at most 255 bytes.'],
      [{ name: 'con.txt', location: root }, `"con.txt" ${DEVICE_TEXT}`],
      // The text names every device name the Host refuses, the zeros and the superscript digits too.
      [{ name: 'lpt²', location: root }, `"lpt²" ${DEVICE_TEXT}`],
      [{ name: 'COM0.wav', location: root }, `"COM0.wav" ${DEVICE_TEXT}`],
      [{ name: '\u200b', location: root }, 'The name "\u200b" has no visible characters. Pass a name that shows letters, digits, or symbols.'],
      [{ name: '.git', location: root }, '".git" is the name of Git\'s own folder. Pass another name.'],
      [{ name: 'Game', location: 'games' }, 'location must be the absolute path of a folder, got "games".'],
      [{ name: 'Taken', location: root }, `${join(root, 'Taken')} already exists; pass another name or location.`],
    ]
    for (const [args, message] of cases) {
      const result = await createGameProject(ctx, args, signal, [])
      expect(result.isError, JSON.stringify(args)).toBe(true)
      expect(text(result)).toBe(message)
    }
    const blocked = await createGameProject(ctx, { name: 'Game', location: join(root, 'file', 'child') }, signal, [])
    expect(blocked.isError).toBe(true)
    expect(text(blocked)).toMatch(/^WASD Engine could not create the game project: cannot create ".*file\/child": /u)
    expect(registered).toEqual([])
  })

  it('refuses a location in a temporary folder, however it is spelled, and still creates in the folder for game projects', async () => {
    mountProjects()
    const temporary = join(root, 'private', 'tmp')
    await mkdir(join(temporary, 'scratch'), { recursive: true })
    // A junction on Windows, which needs no privilege; other systems ignore the type.
    await symlink(temporary, join(root, 'tmp'), 'junction')
    const locations = [temporary, join(temporary, 'scratch'), join(root, 'tmp', 'scratch'), join(root, 'tmp', 'new', 'folders')]
    for (const location of [...locations, `  ${join(temporary, 'scratch')} `]) {
      const result = await createGameProject(ctx, { name: 'Scratch', location }, signal, [join(root, 'tmp')])
      expect(result.isError, location).toBe(true)
      expect(text(result)).toBe(`${location.trim()} is in a temporary folder, whose files the system may delete, so WASD Engine creates no game project `
        + 'there. Leave location out to create the project in WASD Engine\'s folder for game projects, or pass a folder that lasts. '
        + 'To try something out in a temporary folder, make the folder yourself and pass it as project: the game tools work in it without a game project.')
    }
    expect(existsSync(join(temporary, 'new'))).toBe(false)
    // The folder for game projects is WASD Engine's own choice, so it is used wherever the Documents folder is.
    const kept = await createGameProject(ctx, { name: 'Kept' }, signal, [root])
    expect(kept.isError).toBeUndefined()
    expect(registered).toEqual([join(root, 'Documents', 'WASD Engine', 'Kept')])
  })

  it('asks for a location when WASD Engine cannot find the Documents folder', async () => {
    const create = vi.fn()
    ctx.provide('gameProjectController', { defaults: () => Promise.resolve({ directory: null, required: false }), create } as never)
    const result = await createGameProject(ctx, { name: 'Game' }, signal, [])

    expect(result.isError).toBe(true)
    expect(text(result)).toBe('WASD Engine cannot find the user\'s Documents folder, where it keeps game projects; pass location, the absolute path of the folder to create the project in.')
    expect(create).not.toHaveBeenCalled()
  })

  it('refuses when WASD Engine keeps no game projects', async () => {
    const result = await createGameProject(ctx, { name: 'Game', location: root }, signal, [])
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('This WASD Engine keeps no game projects, so it cannot create one.')
  })
})
