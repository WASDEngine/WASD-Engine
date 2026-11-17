/** What Android exports need besides Godot: the JDK and SDK they find, the key they sign with, and Godot's environment. */
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ANDROID_KEY_FILE, ANDROID_KEYSTORE_FILE, androidExportEnvironment, androidPackageName, ensureAndroidKeystore, findAndroidToolchain,
  GodotAndroidToolchainError, javaCandidates, sdkCandidates, type AndroidKeystoreOptions,
} from '../src/android.ts'
import { scratch, subprocessFixture, type Scratch, type SubprocessFixture } from './helpers.ts'

const posix = process.platform === 'win32' ? describe.skip : describe
const signal = new AbortController().signal

const folders: Scratch[] = []
const hosts: SubprocessFixture[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.ctx.fiber.dispose()))
  await Promise.all(folders.splice(0).map(folder => folder.cleanup()))
})

async function touch(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '')
}

/** A JDK folder with the Windows program names. */
async function windowsJdk(folder: string): Promise<string> {
  await touch(join(folder, 'bin', 'java.exe'))
  await touch(join(folder, 'bin', 'keytool.exe'))
  return folder
}

/** An Android SDK folder with the Windows tool names, and apksigner in the build-tools versions given. */
async function windowsSdk(folder: string, buildTools: readonly string[] = ['36.0.0']): Promise<string> {
  await touch(join(folder, 'platform-tools', 'adb.exe'))
  for (const version of buildTools) await touch(join(folder, 'build-tools', version, 'apksigner.bat'))
  return folder
}

describe('androidPackageName', () => {
  it('makes a package name Android takes from any game name', () => {
    expect(androidPackageName('Tiny Farm')).toBe('com.wasdengine.game.tiny_farm')
    expect(androidPackageName('  Café -- Crème!  ')).toBe('com.wasdengine.game.cafe_creme')
    expect(androidPackageName('3D Racer')).toBe('com.wasdengine.game.game_3d_racer')
    expect(androidPackageName('🚀 !!')).toBe('com.wasdengine.game.game')
  })

  it('gives games whose names differ only in letters without an ASCII form different package names', () => {
    expect(androidPackageName('游戏')).toBe('com.wasdengine.game.game_847c5f68')
    expect(androidPackageName(' 游戏 ')).toBe('com.wasdengine.game.game_847c5f68')
    expect(androidPackageName('Space 射击')).toBe('com.wasdengine.game.space_5ef2fcce')
    expect(androidPackageName('Space 冒险')).toBe('com.wasdengine.game.space_2b34eb87')
    expect(androidPackageName('Привет мир')).toBe('com.wasdengine.game.game_830d1964')
  })
})

describe('sdkCandidates and javaCandidates', () => {
  it('tries the SDK environment variables first, then where Android Studio installs the SDK', () => {
    const env = { ANDROID_HOME: '/sdk-home', ANDROID_SDK_ROOT: '/sdk-root', LOCALAPPDATA: 'C:/Users/me/AppData/Local' }
    expect(sdkCandidates({ env, platform: 'darwin', home: '/Users/me' })).toEqual(['/sdk-home', '/sdk-root', '/Users/me/Library/Android/sdk'])
    expect(sdkCandidates({ env: {}, platform: 'linux', home: '/home/me' })).toEqual(['/home/me/Android/Sdk'])
    expect(sdkCandidates({ env, platform: 'win32', home: 'C:/Users/me' })).toEqual(['/sdk-home', '/sdk-root', join('C:/Users/me/AppData/Local', 'Android', 'Sdk')])
  })

  it('tries JAVA_HOME first, then Android Studio\'s JDK, then the newest JDK installations', async () => {
    const dir = await scratch('android-java')
    folders.push(dir)
    const programs = join(dir.root, 'Program Files')
    await mkdir(join(programs, 'Eclipse Adoptium', 'jdk-17.0.9+9'), { recursive: true })
    await mkdir(join(programs, 'Eclipse Adoptium', 'jdk-21.0.2+13'), { recursive: true })
    const found = await javaCandidates({ env: { JAVA_HOME: '/jdk', ProgramFiles: programs, LOCALAPPDATA: join(dir.root, 'Local') }, platform: 'win32', home: dir.root })
    expect(found).toEqual([
      '/jdk',
      join(programs, 'Android', 'Android Studio', 'jbr'),
      join(dir.root, 'Local', 'Programs', 'Android Studio', 'jbr'),
      join(programs, 'Eclipse Adoptium', 'jdk-21.0.2+13'),
      join(programs, 'Eclipse Adoptium', 'jdk-17.0.9+9'),
    ])
    const mac = await javaCandidates({ env: {}, platform: 'darwin', home: '/Users/me' })
    expect(mac.slice(0, 2)).toEqual([
      '/Applications/Android Studio.app/Contents/jbr/Contents/Home', '/Users/me/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    ])
  })
})

describe('findAndroidToolchain', () => {
  /** Windows paths under a scratch folder, so no JDK or SDK of this computer is found. */
  async function windows() {
    const dir = await scratch('android-toolchain')
    folders.push(dir)
    const env = { ProgramFiles: join(dir.root, 'Program Files'), LOCALAPPDATA: join(dir.root, 'Local') }
    return { dir, env, request: { javaPath: '', sdkPath: '', env, platform: 'win32' as const, home: dir.root } }
  }

  it('finds Android Studio\'s JDK and SDK where it installs them', async () => {
    const { env, request } = await windows()
    const java = await windowsJdk(join(env.ProgramFiles, 'Android', 'Android Studio', 'jbr'))
    // The newest build-tools without apksigner, as a half-installed version leaves them, does not make the SDK unusable.
    await mkdir(join(env.LOCALAPPDATA, 'Android', 'Sdk', 'build-tools', '37.0.0-rc1'), { recursive: true })
    const sdk = await windowsSdk(join(env.LOCALAPPDATA, 'Android', 'Sdk'))
    expect(await findAndroidToolchain(request)).toEqual({ java, sdk })
  })

  it('takes JAVA_HOME and ANDROID_HOME first, and the configured folders before them', async () => {
    const { dir, request } = await windows()
    const javaHome = await windowsJdk(join(dir.root, 'jdk-home'))
    const sdkHome = await windowsSdk(join(dir.root, 'sdk-home'))
    const env = { ...request.env, JAVA_HOME: javaHome, ANDROID_HOME: sdkHome }
    expect(await findAndroidToolchain({ ...request, env })).toEqual({ java: javaHome, sdk: sdkHome })
    const javaPath = await windowsJdk(join(dir.root, 'jdk-configured'))
    const sdkPath = await windowsSdk(join(dir.root, 'sdk-configured'))
    expect(await findAndroidToolchain({ ...request, env, javaPath, sdkPath })).toEqual({ java: javaPath, sdk: sdkPath })
  })

  it('names what is missing and how to install it', async () => {
    const { dir, request } = await windows()
    // An SDK without build-tools cannot sign builds.
    await touch(join(dir.root, 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'))
    const failure = findAndroidToolchain(request)
    await expect(failure).rejects.toBeInstanceOf(GodotAndroidToolchainError)
    const message = (await failure.catch((error: unknown) => error) as Error).message
    expect(message).toContain('No Java runtime (JDK 17 or newer) was found')
    expect(message).toContain('No Android SDK with platform-tools and build-tools was found')
    expect(message).toContain('Android Studio (https://developer.android.com/studio) installs both: ask the user to install it')
  })

  it('refuses a configured folder that is not a JDK or an SDK, naming its setting', async () => {
    const { dir, request } = await windows()
    await windowsSdk(join(dir.root, 'Local', 'Android', 'Sdk'))
    const failure = findAndroidToolchain({ ...request, javaPath: join(dir.root, 'nothing'), sdkPath: join(dir.root, 'Local', 'Android') })
    const message = (await failure.catch((error: unknown) => error) as Error).message
    expect(message).toMatch(/The configured JDK .*nothing has no bin\/java and bin\/keytool; fix androidJavaPath/u)
    expect(message).toMatch(/The configured Android SDK .* fix androidSdkPath/u)
  })
})

posix('ensureAndroidKeystore', () => {
  /** How the fake keytool ends: its exit code, and seconds it waits first. */
  type KeytoolBehavior = { readonly exitCode?: number; readonly delaySeconds?: number }

  /**
   * A JDK whose `keytool` writes a keystore holding the password it reads from the variable `-storepass:env` names,
   * and appends its arguments to `keytool.log`.
   */
  async function fakeJdk(root: string, behavior: KeytoolBehavior = {}): Promise<string> {
    const java = join(root, 'jdk')
    await touch(join(java, 'bin', 'java'))
    await writeFile(join(java, 'bin', 'keytool'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> '${join(root, 'keytool.log')}'`,
      ...behavior.delaySeconds === undefined ? [] : [`sleep ${String(behavior.delaySeconds)}`],
      ...behavior.exitCode === undefined ? [] : ['echo "keytool error: java.lang.Exception: no space left" >&2', `exit ${String(behavior.exitCode)}`],
      'while [ $# -gt 0 ]; do',
      '  case "$1" in -keystore) out="$2" ;; -storepass:env) variable="$2" ;; esac',
      '  shift',
      'done',
      'eval "password=\\$$variable"',
      'printf "keystore of %s" "$password" > "$out"',
      '',
    ].join('\n'))
    await chmod(join(java, 'bin', 'keytool'), 0o755)
    return java
  }

  async function options(behavior: KeytoolBehavior = {}): Promise<AndroidKeystoreOptions & { readonly root: string }> {
    const dir = await scratch('android-key')
    folders.push(dir)
    const host = await subprocessFixture()
    hosts.push(host)
    return {
      root: dir.root, subprocess: host.subprocess, folder: join(dir.root, 'data', 'android'), java: await fakeJdk(dir.root, behavior),
      platform: process.platform, env: {}, timeoutMs: 10_000, graceMs: 500, outputBytes: 64 * 1024, signal,
    }
  }

  it('generates one key, readable by the user alone, whose password never reaches keytool\'s command line, and keeps it', async () => {
    const request = await options()
    const first = await ensureAndroidKeystore(request)
    expect(first).toMatchObject({ path: join(request.folder, ANDROID_KEYSTORE_FILE), alias: 'release', created: true })
    expect(first.password).toMatch(/^[A-Za-z0-9_-]{24}$/u)
    expect(await readFile(first.path, 'utf8')).toBe(`keystore of ${first.password}`)
    expect(JSON.parse(await readFile(join(request.folder, ANDROID_KEY_FILE), 'utf8'))).toEqual({ alias: 'release', password: first.password })
    for (const file of [ANDROID_KEYSTORE_FILE, ANDROID_KEY_FILE]) expect((await stat(join(request.folder, file))).mode & 0o777).toBe(0o600)
    const log = await readFile(join(request.root, 'keytool.log'), 'utf8')
    expect(log).toContain('-genkeypair -noprompt -keystore')
    expect(log).toContain('-storetype PKCS12 -storepass:env WASD_ANDROID_KEY_PASSWORD -keypass:env WASD_ANDROID_KEY_PASSWORD -alias release -keyalg RSA -keysize 2048 -validity 10000')
    expect(log).not.toContain(first.password)
    expect(await ensureAndroidKeystore(request)).toEqual({ ...first, created: false })
    expect((await readFile(join(request.root, 'keytool.log'), 'utf8')).trim().split('\n')).toHaveLength(1)
  })

  it('generates one key for exports that start together', async () => {
    const request = await options({ delaySeconds: 0.3 })
    const [first, second] = await Promise.all([ensureAndroidKeystore(request), ensureAndroidKeystore(request)])
    expect(first.password).toBe(second.password)
    expect([first.created, second.created].sort()).toEqual([false, true])
  })

  it('signs with the key the release key variables name when all three are set', async () => {
    const request = await options()
    const env = { GODOT_ANDROID_KEYSTORE_RELEASE_PATH: '/keys/own.keystore', GODOT_ANDROID_KEYSTORE_RELEASE_USER: 'upload', GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD: 'own' }
    expect(await ensureAndroidKeystore({ ...request, env })).toEqual({ path: '/keys/own.keystore', alias: 'upload', password: 'own', created: false })
    const partial = { GODOT_ANDROID_KEYSTORE_RELEASE_PATH: '/keys/own.keystore' }
    const own = await ensureAndroidKeystore({ ...request, env: partial })
    expect(own).toMatchObject({ path: join(request.folder, ANDROID_KEYSTORE_FILE), created: true })
  })

  it('refuses a keystore whose password file is gone instead of replacing the key', async () => {
    const request = await options()
    await touch(join(request.folder, ANDROID_KEYSTORE_FILE))
    const message = (await ensureAndroidKeystore(request).catch((error: unknown) => error) as Error).message
    expect(message).toMatch(/^The Android signing key .*release\.keystore cannot be used: its alias and password in .*release-key\.json/u)
    expect(message).toContain('are missing or unreadable')
  })

  it('reports keytool\'s output when it fails, and leaves no key behind', async () => {
    const request = await options({ exitCode: 1 })
    const failure = ensureAndroidKeystore(request)
    await expect(failure).rejects.toBeInstanceOf(GodotAndroidToolchainError)
    const output = 'keytool error: java.lang.Exception: no space left'
    await expect(failure).rejects.toThrow(`keytool could not generate the Android signing key: it ended (exit code 1).\n${output}`)
    await expect(stat(join(request.folder, ANDROID_KEYSTORE_FILE))).rejects.toThrow()
  })
})

describe('androidExportEnvironment', () => {
  const toolchain = { java: '/jdk', sdk: '/sdk' }
  const keystore = { path: '/keys/release.keystore', alias: 'release', password: 'secret', created: false }

  it('gives Godot a home of its own, the JDK first on the search path, the SDK, and the key', () => {
    expect(androidExportEnvironment(toolchain, keystore, '/tmp/home', { PATH: '/usr/bin', HOME: '/Users/me' })).toEqual({
      HOME: '/tmp/home',
      XDG_DATA_HOME: join('/tmp/home', '.local', 'share'),
      XDG_CONFIG_HOME: join('/tmp/home', '.config'),
      XDG_CACHE_HOME: join('/tmp/home', '.cache'),
      APPDATA: join('/tmp/home', 'AppData', 'Roaming'),
      LOCALAPPDATA: join('/tmp/home', 'AppData', 'Local'),
      JAVA_HOME: '/jdk',
      ANDROID_HOME: '/sdk',
      ANDROID_SDK_ROOT: '/sdk',
      PATH: `${join('/jdk', 'bin')}${delimiter}/usr/bin`,
      GODOT_ANDROID_KEYSTORE_RELEASE_PATH: '/keys/release.keystore',
      GODOT_ANDROID_KEYSTORE_RELEASE_USER: 'release',
      GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD: 'secret',
    })
  })

  it('keeps the name of a search path variable that differs in case, as Windows names it', () => {
    const env = androidExportEnvironment(toolchain, keystore, '/tmp/home', { Path: 'C:\\Windows' })
    expect(env.Path).toBe(`${join('/jdk', 'bin')}${delimiter}C:\\Windows`)
    expect(env.PATH).toBeUndefined()
    expect(androidExportEnvironment(toolchain, keystore, '/tmp/home', {}).PATH).toBe(join('/jdk', 'bin'))
  })
})
