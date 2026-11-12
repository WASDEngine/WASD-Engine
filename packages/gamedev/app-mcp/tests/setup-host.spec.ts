/** The setup host on the real file system, setup commands, the first-executable search, and newest-first version order. */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstExecutable, newestFirst, nodeSetupHost, runCommand, type SetupHost } from '../src/setup-host.ts'
import { temporaryDirectory } from './harness.ts'

describe('nodeSetupHost', () => {
  it('binds the current process and home directory', () => {
    const host = nodeSetupHost()
    expect(host.platform).toBe(process.platform)
    expect(host.env).toBe(process.env)
    expect(host.homeDirectory).toBe(homedir())
  })

  it.skipIf(process.platform === 'win32')('accepts only regular files the user may execute', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-host-')
    const host = nodeSetupHost()
    const tool = join(root, 'tool')
    const data = join(root, 'data.txt')
    await writeFile(tool, '#!/bin/sh\n')
    await chmod(tool, 0o755)
    await writeFile(data, 'x')
    await chmod(data, 0o644)
    await expect(host.isExecutable(tool)).resolves.toBe(true)
    await expect(host.isExecutable(data)).resolves.toBe(false)
    await expect(host.isExecutable(root)).resolves.toBe(false)
    await expect(host.isExecutable(join(root, 'missing'))).resolves.toBe(false)
    await expect(host.isExecutable(join(data, 'child'))).resolves.toBe(false)
    await expect(host.isExecutable(`${root}/bad\0name`)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })

  it('creates and lists directories, and lists a missing one as empty', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-host-')
    const host = nodeSetupHost()
    const made = join(root, 'a', 'b')
    await host.makeDirectory(made)
    await host.makeDirectory(made)
    await mkdir(join(root, 'a', 'c'))
    await expect(host.listDirectory(join(root, 'a')).then(entries => [...entries].sort())).resolves.toEqual(['b', 'c'])
    await expect(host.listDirectory(join(root, 'nothing'))).resolves.toEqual([])
    await expect(host.listDirectory(`${root}/bad\0name`)).rejects.toMatchObject({ code: 'ERR_INVALID_ARG_VALUE' })
  })
})

describe('runCommand', () => {
  it('runs a command without a shell and keeps the tail of its interleaved output', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-command-')
    const options = { cwd: root, env: process.env, signal: new AbortController().signal }
    const result = await runCommand([process.execPath, '-e', 'process.stdout.write("0123456789"); process.stderr.write("ab"); process.exit(3)'], options, 8)
    expect(result).toEqual({ exitCode: 3, signal: null, output: expect.stringMatching(/^.{8}$/u) as string })
    expect(result.output.endsWith('89') || result.output.endsWith('ab')).toBe(true)
    await expect(runCommand([process.execPath, '-e', 'process.stdout.write(process.cwd())'], options, 4096))
      .resolves.toMatchObject({ exitCode: 0, output: expect.stringContaining('dsh-app-mcp-command-') as string })
    await expect(runCommand([join(root, 'no-such-command')], options, 64)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('gives a command a file as its standard input, and empty standard input without one', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-command-')
    const options = { cwd: root, env: process.env, signal: new AbortController().signal }
    const input = join(root, 'input ü 游戏.bin')
    await writeFile(input, Buffer.from([0, 1, 2, 0xfe, 0xff]))
    const hex = 'let n = 0; process.stdin.on("data", c => { n += c.length; process.stdout.write(c.toString("hex")) }).on("end", () => process.stdout.write(`:${n}`))'
    await expect(runCommand([process.execPath, '-e', hex], { ...options, stdinFile: input }, 64)).resolves.toEqual({ exitCode: 0, signal: null, output: '000102feff:5' })
    await expect(runCommand([process.execPath, '-e', hex], options, 64)).resolves.toEqual({ exitCode: 0, signal: null, output: ':0' })
    await expect(runCommand([process.execPath, '-e', ''], { ...options, stdinFile: join(root, 'missing') }, 64)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('kills a command when its signal aborts', async () => {
    const root = await temporaryDirectory('dsh-app-mcp-command-')
    const controller = new AbortController()
    const running = runCommand([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { cwd: root, env: process.env, signal: controller.signal }, 64)
    controller.abort()
    await expect(running).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('firstExecutable', () => {
  it('returns the first executable candidate in order, or undefined', async () => {
    const executables = new Set(['/b/tool', '/c/tool'])
    const checked: string[] = []
    const host: SetupHost = {
      platform: 'linux', env: {}, homeDirectory: '/home/dev',
      async isExecutable(file) { checked.push(file); return executables.has(file) },
      async listDirectory() { return [] },
      async makeDirectory() {},
    }
    await expect(firstExecutable(['/a/tool', '/b/tool', '/c/tool'], host)).resolves.toBe('/b/tool')
    expect(checked).toEqual(['/a/tool', '/b/tool'])
    await expect(firstExecutable(['/a/tool'], host)).resolves.toBeUndefined()
    await expect(firstExecutable([], host)).resolves.toBeUndefined()
  })
})

describe('newestFirst', () => {
  it('orders names by their numbers, newest first, and keeps names with equal numbers in place', () => {
    const names = ['Blender', 'Blender 4.2', 'Blender 4.10', 'blender 4.10', 'Blender 4.10.1', 'Blender 3', 'Other']
    expect([...names].sort(newestFirst)).toEqual(['Blender 4.10.1', 'Blender 4.10', 'blender 4.10', 'Blender 4.2', 'Blender 3', 'Blender', 'Other'])
    expect(newestFirst('gimp-console-3.2', 'gimp-console-3.0')).toBeLessThan(0)
    expect(newestFirst('gimp-console-3', 'gimp-console-3.0')).toBeGreaterThan(0)
    expect(newestFirst('GIMP 3', 'gimp 3')).toBe(0)
  })
})
