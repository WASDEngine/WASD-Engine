/**
 * What an Android export needs on this computer besides Godot: a Java runtime and the Android SDK, and the key that
 * signs the build. Godot packs an Android build from its release template APK, signs it with `apksigner` from the SDK's
 * build-tools, which runs on Java, and refuses to export until the SDK's platform-tools and a JDK are where its editor
 * settings say. The plugin takes the JDK and the SDK its configuration names, else finds them where Android Studio and
 * common installers put them ({@link findAndroidToolchain}), and runs the export with a home folder of its own
 * ({@link androidExportEnvironment}), whose new editor settings Godot fills from `JAVA_HOME` and `ANDROID_HOME`, so the
 * user's own Godot editor settings neither apply nor change.
 *
 * One key signs every Android build of this computer's games, since an installed app updates only to a build signed
 * with the same key. The first Android export generates it with the JDK's `keytool` into the plugin's data folder
 * ({@link ensureAndroidKeystore}); the release key variables Godot reads (`GODOT_ANDROID_KEYSTORE_RELEASE_PATH`,
 * `..._USER`, and `..._PASSWORD`) replace it when the Host's environment sets all three.
 * @module @deepseek-ai/dsh-godot/src/android
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { runGodotCommand } from './command.ts'
import { describeExit, lastLines } from './output.ts'
import { ownUserDataEnvironment } from './script.ts'

/** Folder, in the plugin's data folder, that holds the key Android builds are signed with. */
export const ANDROID_KEY_FOLDER = 'android'

/** The keystore file in {@link ANDROID_KEY_FOLDER}. */
export const ANDROID_KEYSTORE_FILE = 'release.keystore'

/** The file beside {@link ANDROID_KEYSTORE_FILE} that holds its key's alias and password. */
export const ANDROID_KEY_FILE = 'release-key.json'

/** The release key variables of Godot's Android export, which name a keystore, its key's alias, and its password. */
export const ANDROID_KEY_VARIABLES = {
  path: 'GODOT_ANDROID_KEYSTORE_RELEASE_PATH',
  user: 'GODOT_ANDROID_KEYSTORE_RELEASE_USER',
  password: 'GODOT_ANDROID_KEYSTORE_RELEASE_PASSWORD',
} as const

/** Where Android Studio is downloaded, which installs both the JDK and the SDK an Android export needs. */
const ANDROID_STUDIO_URL = 'https://developer.android.com/studio'

/** The alias of the key {@link ensureAndroidKeystore} generates. */
const GENERATED_ALIAS = 'release'

/** Days the generated key stays valid: about 27 years, past the 2033 minimum that Google Play asks of a signing key. */
const GENERATED_VALIDITY_DAYS = 10_000

/** The environment variable through which `keytool` reads the generated key's password, which never reaches its command line. */
const PASSWORD_VARIABLE = 'WASD_ANDROID_KEY_PASSWORD'

/** An Android toolchain that is missing or unusable, with what to install or configure. */
export class GodotAndroidToolchainError extends Error {
  override name = 'GodotAndroidToolchainError'
}

/** The JDK and Android SDK an Android export runs with. */
export interface AndroidToolchain {
  /** Absolute JDK folder, which holds `bin/java` and `bin/keytool`. */
  readonly java: string
  /** Absolute Android SDK folder, which holds `platform-tools/adb` and `build-tools/<version>/apksigner`. */
  readonly sdk: string
}

/** Where {@link findAndroidToolchain} looks. */
export interface AndroidToolchainRequest {
  /** Configured JDK folder; empty finds one. */
  readonly javaPath: string
  /** Configured Android SDK folder; empty finds one. */
  readonly sdkPath: string
  /** The Host's environment, for `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and the Windows program folders. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The Host's operating system. */
  readonly platform: NodeJS.Platform
  /** The user's home folder. */
  readonly home: string
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    // A missing or unreadable path is not the tool.
    return false
  }
}

/**
 * The subfolders of a folder, newest version first: names sort in reverse with their numbers compared as numbers.
 * @param folder - absolute folder.
 * @returns absolute subfolder paths; none when the folder is missing.
 */
async function versionFolders(folder: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(folder, { withFileTypes: true })
  } catch {
    // A missing folder holds no installation.
    return []
  }
  return entries
    .filter(entry => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
    .map(name => join(folder, name))
}

/**
 * The JDK folders to try, in order: `JAVA_HOME`, Android Studio's bundled JDK, then the JDKs that the system's and
 * Homebrew's installers, or the usual Windows and Linux packages, put in their standard folders.
 * @param request - the Host's environment, operating system, and home folder.
 * @returns absolute folders, which may not exist.
 */
export async function javaCandidates(request: Omit<AndroidToolchainRequest, 'javaPath' | 'sdkPath'>): Promise<string[]> {
  const { env, home } = request
  const fromEnv = env.JAVA_HOME ? [env.JAVA_HOME] : []
  switch (request.platform) {
    case 'darwin': {
      const homebrew = async (prefix: string) => (await versionFolders(prefix))
        .filter(folder => /\/openjdk(@\d+)?$/u.test(folder))
        .map(folder => join(folder, 'libexec', 'openjdk.jdk', 'Contents', 'Home'))
      const virtualMachines = async (folder: string) => (await versionFolders(folder)).map(jdk => join(jdk, 'Contents', 'Home'))
      return [
        ...fromEnv,
        '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
        join(home, 'Applications', 'Android Studio.app', 'Contents', 'jbr', 'Contents', 'Home'),
        ...await virtualMachines('/Library/Java/JavaVirtualMachines'),
        ...await virtualMachines(join(home, 'Library', 'Java', 'JavaVirtualMachines')),
        ...await homebrew('/opt/homebrew/opt'),
        ...await homebrew('/usr/local/opt'),
      ]
    }
    case 'win32': {
      const programs = env.ProgramFiles ?? 'C:\\Program Files'
      const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
      return [
        ...fromEnv,
        join(programs, 'Android', 'Android Studio', 'jbr'),
        join(local, 'Programs', 'Android Studio', 'jbr'),
        ...await versionFolders(join(programs, 'Eclipse Adoptium')),
        ...await versionFolders(join(programs, 'Microsoft')),
        ...await versionFolders(join(programs, 'Java')),
      ]
    }
    default:
      return [
        ...fromEnv,
        '/opt/android-studio/jbr',
        join(home, 'android-studio', 'jbr'),
        '/snap/android-studio/current/jbr',
        ...await versionFolders('/usr/lib/jvm'),
      ]
  }
}

/**
 * The Android SDK folders to try, in order: `ANDROID_HOME`, `ANDROID_SDK_ROOT`, then where Android Studio installs it.
 * @param request - the Host's environment, operating system, and home folder.
 * @returns absolute folders, which may not exist.
 */
export function sdkCandidates(request: Omit<AndroidToolchainRequest, 'javaPath' | 'sdkPath'>): string[] {
  const { env, home } = request
  const studio = request.platform === 'darwin' ? join(home, 'Library', 'Android', 'sdk')
    : request.platform === 'win32' ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Android', 'Sdk')
      : join(home, 'Android', 'Sdk')
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, studio].filter((folder): folder is string => folder !== undefined && folder !== '')
}

/**
 * Whether a folder is a JDK Godot's Android export can use: it holds `bin/java` and `bin/keytool`.
 * @param folder - absolute folder.
 * @param platform - the Host's operating system.
 * @returns whether both programs are there.
 */
async function isJdk(folder: string, platform: NodeJS.Platform): Promise<boolean> {
  const suffix = platform === 'win32' ? '.exe' : ''
  return await isFile(join(folder, 'bin', `java${suffix}`)) && await isFile(join(folder, 'bin', `keytool${suffix}`))
}

/**
 * Whether a folder is an Android SDK Godot's Android export can use: it holds `platform-tools/adb` and `apksigner` in
 * one of its `build-tools` versions.
 * @param folder - absolute folder.
 * @param platform - the Host's operating system.
 * @returns whether both tools are there.
 */
async function isSdk(folder: string, platform: NodeJS.Platform): Promise<boolean> {
  if (!await isFile(join(folder, 'platform-tools', platform === 'win32' ? 'adb.exe' : 'adb'))) return false
  for (const version of await versionFolders(join(folder, 'build-tools'))) {
    if (await isFile(join(version, platform === 'win32' ? 'apksigner.bat' : 'apksigner'))) return true
  }
  return false
}

/**
 * Find the JDK and the Android SDK of an Android export: the configured folders, else the first usable one of
 * {@link javaCandidates} and {@link sdkCandidates}.
 * @param request - the configured folders and the Host's environment.
 * @returns the folders.
 * @throws {GodotAndroidToolchainError} when a configured folder is unusable, or no usable JDK or SDK is found.
 */
export async function findAndroidToolchain(request: AndroidToolchainRequest): Promise<AndroidToolchain> {
  const problems: string[] = []
  let java: string | undefined
  if (request.javaPath !== '') {
    if (await isJdk(request.javaPath, request.platform)) java = request.javaPath
    else problems.push(`The configured JDK ${request.javaPath} has no bin/java and bin/keytool; fix androidJavaPath in the Godot plugin configuration.`)
  } else {
    for (const folder of await javaCandidates(request)) {
      if (await isJdk(folder, request.platform)) {
        java = folder
        break
      }
    }
    if (java === undefined) problems.push('No Java runtime (JDK 17 or newer) was found, neither in JAVA_HOME nor where Android Studio and the usual JDK installers put it.')
  }
  let sdk: string | undefined
  if (request.sdkPath !== '') {
    if (await isSdk(request.sdkPath, request.platform)) sdk = request.sdkPath
    else problems.push(`The configured Android SDK ${request.sdkPath} has no platform-tools/adb or no build-tools with apksigner; fix androidSdkPath in the Godot plugin configuration.`)
  } else {
    for (const folder of sdkCandidates(request)) {
      if (await isSdk(folder, request.platform)) {
        sdk = folder
        break
      }
    }
    if (sdk === undefined) problems.push('No Android SDK with platform-tools and build-tools was found, neither in ANDROID_HOME nor where Android Studio installs it.')
  }
  if (java === undefined || sdk === undefined) {
    throw new GodotAndroidToolchainError(`An Android export needs a Java runtime and the Android SDK on this computer. ${problems.join(' ')} Android Studio (${ANDROID_STUDIO_URL}) installs both: ask the user to install it and open it once so that it downloads the SDK, then export again; do not install them yourself. JAVA_HOME and ANDROID_HOME can also name a JDK and an SDK installed elsewhere.`)
  }
  return { java, sdk }
}

/** The key an Android build is signed with. */
export interface AndroidKeystore {
  /** Absolute keystore path. */
  readonly path: string
  /** The key's alias in the keystore. */
  readonly alias: string
  /** The password of the keystore and of its key. */
  readonly password: string
  /** Whether this call generated the keystore. */
  readonly created: boolean
}

/** Parameters of {@link ensureAndroidKeystore}. */
export interface AndroidKeystoreOptions {
  /** Host subprocess service, which runs `keytool`. */
  readonly subprocess: SubprocessRuntime
  /** Absolute folder of the generated key, {@link ANDROID_KEY_FOLDER} in the plugin's data folder. */
  readonly folder: string
  /** The JDK whose `keytool` generates the key. */
  readonly java: string
  /** The Host's operating system. */
  readonly platform: NodeJS.Platform
  /** The Host's environment; its release key variables, when all three are set, name the key instead. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** Deadline of `keytool`. */
  readonly timeoutMs: number
  /** Subprocess termination grace. */
  readonly graceMs: number
  /** Collected bytes kept per output stream. */
  readonly outputBytes: number
  /** Cancellation. */
  readonly signal: AbortSignal
}

const KeyRecord = z.strictObject({ alias: z.string().min(1), password: z.string().min(6) })

/**
 * The key Android builds are signed with: the one the Host's release key variables name when all three are set, else
 * the plugin's own, which the first call generates with `keytool` as a PKCS #12 keystore holding a 2048-bit RSA key. Its
 * alias and password live beside it in {@link ANDROID_KEY_FILE}; both files are readable by the user alone, and calls
 * across Hosts generate one key between them.
 * @param options - the folder, the JDK, the environment, and the limits of `keytool`.
 * @returns the key.
 * @throws {GodotAndroidToolchainError} when the keystore exists without a readable password file, or `keytool` fails.
 */
export async function ensureAndroidKeystore(options: AndroidKeystoreOptions): Promise<AndroidKeystore> {
  const { path: ownPath, user, password: ownPassword } = ANDROID_KEY_VARIABLES
  const named = { path: options.env[ownPath], alias: options.env[user], password: options.env[ownPassword] }
  if (named.path && named.alias && named.password) return { path: named.path, alias: named.alias, password: named.password, created: false }
  const path = join(options.folder, ANDROID_KEYSTORE_FILE)
  const existing = async (): Promise<AndroidKeystore | undefined> => {
    if (!await isFile(path)) return undefined
    let record
    try {
      record = KeyRecord.parse(JSON.parse(await readFile(join(options.folder, ANDROID_KEY_FILE), 'utf8')))
    } catch (error) {
      throw new GodotAndroidToolchainError(`The Android signing key ${path} cannot be used: its alias and password in ${join(options.folder, ANDROID_KEY_FILE)} are missing or unreadable (${(error as Error).message}). Restore that file from a backup to keep signing with this key.`, { cause: error })
    }
    return { path, ...record, created: false }
  }
  const found = await existing()
  if (found !== undefined) return found
  await mkdir(options.folder, { recursive: true, mode: 0o700 })
  return await withFileLock(path, async () => {
    const raced = await existing()
    if (raced !== undefined) return raced
    const record = { alias: GENERATED_ALIAS, password: randomBytes(18).toString('base64url') }
    const staging = join(options.folder, `.${randomUUID()}.keystore`)
    try {
      const keytool = join(options.java, 'bin', options.platform === 'win32' ? 'keytool.exe' : 'keytool')
      const outcome = await runGodotCommand({
        subprocess: options.subprocess,
        argv: [
          keytool, '-genkeypair', '-noprompt', '-keystore', staging, '-storetype', 'PKCS12',
          '-storepass:env', PASSWORD_VARIABLE, '-keypass:env', PASSWORD_VARIABLE, '-alias', record.alias,
          '-keyalg', 'RSA', '-keysize', '2048', '-validity', String(GENERATED_VALIDITY_DAYS), '-dname', 'CN=Android Developer',
        ],
        cwd: options.folder,
        env: { [PASSWORD_VARIABLE]: record.password },
        timeoutMs: options.timeoutMs,
        graceMs: options.graceMs,
        outputBytes: options.outputBytes,
        signal: options.signal,
      })
      options.signal.throwIfAborted()
      if (outcome.exit.exitCode !== 0 || !await isFile(staging)) {
        const output = lastLines(outcome.stderr, 10) || lastLines(outcome.stdout, 10)
        throw new GodotAndroidToolchainError(`keytool could not generate the Android signing key: it ${outcome.timedOut ? 'did not finish in time' : `ended (${describeExit(outcome.exit)})`}.${output === '' ? '' : `\n${output}`}`)
      }
      await chmod(staging, 0o600)
      await writeFileAtomic(join(options.folder, ANDROID_KEY_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600, dirMode: 0o700 })
      await rename(staging, path)
      return { path, ...record, created: true }
    } finally {
      await rm(staging, { force: true })
    }
  }, { signal: options.signal, waitMs: options.timeoutMs })
}

/**
 * The environment of an Android export's Godot process: `home` as its home folder, so that Godot reads and writes
 * editor settings of its own there, the JDK and the SDK for those settings and for `apksigner`, and the key.
 * @param toolchain - the JDK and the SDK.
 * @param keystore - the key.
 * @param home - absolute empty folder the export owns.
 * @param hostEnv - the Host's environment, whose search path the JDK's programs go in front of.
 * @returns the environment entries.
 */
export function androidExportEnvironment(
  toolchain: AndroidToolchain, keystore: AndroidKeystore, home: string, hostEnv: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  // Windows names the search path Path, and the child process would get two entries if this one differed.
  const pathKey = Object.keys(hostEnv).find(key => key.toUpperCase() === 'PATH') ?? 'PATH'
  const searchPath = hostEnv[pathKey]
  return {
    ...ownUserDataEnvironment(home),
    JAVA_HOME: toolchain.java,
    ANDROID_HOME: toolchain.sdk,
    ANDROID_SDK_ROOT: toolchain.sdk,
    [pathKey]: searchPath ? `${join(toolchain.java, 'bin')}${delimiter}${searchPath}` : join(toolchain.java, 'bin'),
    [ANDROID_KEY_VARIABLES.path]: keystore.path,
    [ANDROID_KEY_VARIABLES.user]: keystore.alias,
    [ANDROID_KEY_VARIABLES.password]: keystore.password,
  }
}

/**
 * The Android package name of a game: `com.wasdengine.game.` and the game's name in lowercase ASCII letters, digits,
 * and underscores, as Android takes a package segment.
 * @param name - the game's name.
 * @returns the package name; `com.wasdengine.game.game` for a name without such characters.
 */
export function androidPackageName(name: string): string {
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/gu, '').toLowerCase()
  const words = ascii.replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 60).replace(/_+$/u, '')
  return `com.wasdengine.game.${words === '' ? 'game' : /^[a-z]/u.test(words) ? words : `game_${words}`}`
}
