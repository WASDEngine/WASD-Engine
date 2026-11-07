/** The setup host on the real file system, the first-executable search, and newest-first version order. */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { firstExecutable, newestFirst, nodeSetupHost, type SetupHost } from '../src/setup-host.ts'
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
