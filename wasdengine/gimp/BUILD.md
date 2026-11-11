# GIMP runtime

The GIMP plugin (`@deepseek-ai/dsh-gimp`) edits images with GIMP 3's `gimp-console`, which runs without a window. The Desktop apps for macOS on Apple silicon and Windows x64 ship a GIMP runtime inside the plugin package, so their users install nothing: GIMP 3.2.8's official build for the platform without the parts that the tools never use. The macOS app ships the runtime's files; the Windows app ships the runtime's archive, which the plugin unpacks on first use (see [Windows](#windows)). Elsewhere the plugin uses an installed GIMP 3.

| Path | Role |
|---|---|
| [build.sh](build.sh) | Builds, smoke-tests, packages, and optionally installs the runtime of the current Mac or Windows x64 computer. |
| [runtime.py](runtime.py) | Turns GIMP's macOS bundle or Windows install into the runtime layout, checks its libraries, and packages, installs, merges, and verifies runtime archives for `build.sh` and the release workflow; on Windows, it also runs GIMP's installer. |
| [smoke.py](smoke.py) | Saves an image with a runtime, as the plugin runs it, and checks GIMP's output, data folder, and that macOS lists no application for it or that no process of the run shows a window on Windows. |
| [test_runtime.py](test_runtime.py) | Tests of `runtime.py`. |
| [test_smoke.py](test_smoke.py) | Tests of the helpers of `smoke.py`. |
| [wasd-gimp.yml](../../.github/workflows/wasd-gimp.yml) | Builds the runtime and publishes the release. |

## The build

GIMP's own macOS application takes about 600 MB, of which the tools use about half. `build.sh` downloads GIMP's disk image for the Mac's architecture from `download.gimp.org`, checks it against the SHA-256 that the script pins from GIMP's `SHA256SUMS`, copies `GIMP.app/Contents` out of it, and clears the copy's extended attributes, because a quarantine attribute would make macOS assess every program at its first start and reject it once it is signed again. `runtime.py prepare` then removes the debug symbols, the GUI program and GIMP's debug, clipboard-test, and plug-in build tools, the headers, the translations, the GUI icons, the bundle's `Info.plist` and signatures, Python's test suite, IDE, Tk, turtle demos, and installer, and the build and documentation tools in Python's `site-packages`. GIMP's `sitecustomize.py` imports `certifi`, which stays.

The runtime holds no symbolic links, because the Desktop runtime tree accepts none. `prepare` deletes the program and library aliases, which nothing loads by name, moves `Resources` to `share`, where GIMP reads its data through the bundle's `share` link, and keeps an empty `Resources` folder, because GIMP sets up its bundled libraries only when that folder exists. The folder holding these keeps the name `Contents`: GIMP finds its plug-ins, fonts, and libraries relative to the bundle that macOS derives from `<bundle>/Contents/MacOS/<program>`. The folder above it has no `.app` name and no `Info.plist`, so macOS registers no application. GIMP's Python plug-ins run from a nested `Python.app`, whose `share` link pointed back at GIMP's data; the plugin passes the data, translation, and configuration folders as `GIMP3_DATADIR`, `GIMP3_LOCALEDIR`, and `GIMP3_SYSCONFDIR` instead. Every folder that must exist and would be empty, such as `share/locale`, holds `wasd-engine-folder.txt`, because archives hold files only; without `share/locale`, every plug-in reports a missing translation catalog at each start.

`build.sh` signs every Mach-O file ad hoc (`codesign --sign -`), as macOS requires of arm64 code, because `prepare` removed the signatures that sealed the removed files. `runtime.py check-links` then requires every library that a program, library, or plug-in loads to resolve to a file inside `Contents` or to a system library. A signed Desktop build signs every Mach-O file again with its identity, with hardened runtime and without entitlements, in the `sign:dsh-native` step; GIMP's Python needs no JIT or unsigned-memory entitlement, and the release identity's team satisfies library validation. `COPYING` holds the GNU General Public License, version 3, GIMP's license, and `SOURCE.txt` names GIMP's source release and the macOS build recipes that name the sources of the bundled libraries.

<a id="windows"></a>
## Windows

GIMP publishes its Windows build only as an installer, `gimp-3.2.8-setup.exe`, which `build.sh` pins by the SHA-256 that GIMP's `SHA256SUMS` lists. The installer is built with Inno Setup 7, which no extractor unpacks, so `build.sh` builds the Windows runtime on Windows only, in Git Bash. `runtime.py install-setup` runs the installer without a window or a question into the stage folder: per user, without Start menu and desktop entries, and with the components that the macOS runtime also holds, GIMP and its libraries (`gimpX64`, `depsX64`), Python (`pyX64`), Ghostscript (`gsX64`), and the MyPaint brushes (`mypaint`), but not the debug symbols, the development files, or the translations. The registry entries and file associations that the installer adds stay on the computer that builds the runtime; the runtime needs none of them, because GIMP for Windows finds its folders relative to its programs. The install is MSYS2's layout: `bin`, `lib`, `share`, and `etc`.

`runtime.py prepare-windows` then removes the uninstaller, the GUI program `gimp-3.2.exe` and GIMP's debug, clipboard-test, and plug-in build tools, debug symbols, headers and import libraries, translations, the desktop's hicolor icon theme, the TWAIN scanner plug-in, which only opens a scanner's dialog, and the Python folders and site-packages tools that the macOS runtime also leaves out. The installer names the interpreters of GIMP's Script-Fu `.interp` files by the absolute folder it installed into, so `prepare-windows` names every interpreter of the `.interp` files by its file name: GIMP looks such a program up in the folder of the running GIMP program first, the runtime's `bin`, wherever the runtime is unpacked. It fails when any file still names the install folder, and reads the GIMP version from the version resource of `gimp-console-3.2.exe`. `runtime.py check-imports` then reads the import and delay-load tables of every `.exe`, `.dll`, and `.pyd` file and requires each to be x64 code whose libraries lie in `bin`, beside the file, or in Windows itself, which its list of system libraries and the `api-ms-win-` and `ext-ms-win-` API sets name; GIMP's plug-ins find `bin` through the `PATH` that GIMP's `default.env` gives them.

The runtime cannot ship as files below the app's install folder: that folder, `C:\Users\<name>\AppData\Local\Programs\WASD Engine\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\dsh-gimp\runtime\win32-x64\`, takes 130 characters before the user name, and the runtime's deepest files, translations of one of GIMP's bundled extensions, about 115 more, past the 259 characters that Windows allows a path without long path support. Desktop packaging ships the checked archive instead, with an `archive.json` that names it, its size and SHA-256, and the fields of its `runtime.json`, and the plugin unpacks it with Windows' own `tar.exe` into `runtime/<version>/` under its data folder, `%USERPROFILE%\.wasdengine\gimp`, on first use, as the Blender plugin does with its runtime.

Node.js starts `gimp-console` without a console window, and GIMP's plug-ins, which it builds as GUI programs, and its `python.exe` share that hidden console, so no process of the GIMP tools shows a window or a taskbar entry.

## Build locally

Prerequisites: on macOS, the Xcode Command Line Tools (for `codesign` and `otool`); on Windows x64, Git Bash; on both, curl and Python 3.8 or newer. The Windows build runs GIMP's installer, which installs nothing outside the stage folder but registers GIMP and its file types for the current user; build on a computer where that does not matter, such as a CI runner.

```sh
# Download and check GIMP 3.2.8's disk image, prepare and smoke-test the runtime, and package it.
wasdengine/gimp/build.sh --out /tmp/gimp

# Also install it where the GIMP plugin of a source checkout finds it, as the Desktop app ships it.
wasdengine/gimp/build.sh --out /tmp/gimp --install "$PWD/packages/gamedev/gimp/runtime"
```

On Windows, the same commands in Git Bash build `win32-x64`, and `--setup <file>` names an installer that was already downloaded instead of `--dmg`.

`build.sh --help` lists every option. The script reuses a disk image or installer of an earlier run in the same `--out` folder when its SHA-256 matches. A macOS build takes about two minutes after the 186 MB download.

The plugin package's `runtime/` folder is ignored by Git. With a runtime installed there, a source checkout and `dsh web` use it the way the Desktop app uses the one it ships.

## Output

`build.sh` writes `<out>/gimp-<version>-<platform>-<arch>.tar.gz`, where `<platform>` is `darwin` or `win32` and `<arch>` is `arm64` or `x64`. The archive holds only plain files at relative paths, which unpack into this layout on macOS:

| Path | Contents |
|---|---|
| `Contents/MacOS/` | `gimp-console-3.2`, GIMP's `python3`, the Script-Fu interpreter, and the GEGL and Graphviz tools. |
| `Contents/lib/` | GIMP's libraries and their dependencies, its plug-ins, GEGL and babl modules, and `Python.framework`. |
| `Contents/share/` | GIMP's data, such as brushes and fonts, and the data of its libraries. |
| `Contents/etc/` | GIMP's and fontconfig's configuration. |
| `Contents/Resources/` | Empty but for `wasd-engine-folder.txt`. |
| `COPYING`, `SOURCE.txt` | GIMP's license and the corresponding source. |
| `runtime.json` | The runtime description. |

On Windows, the runtime's root holds `bin/` with `gimp-console-3.2.exe`, GIMP's Python, the Script-Fu interpreter, and every library, `lib/` with GIMP's plug-ins and modules, Python's standard library, and the GEGL, babl, and GObject introspection data, `share/` with GIMP's data, `etc/` with GIMP's and fontconfig's configuration, `COPYING`, `SOURCE.txt`, and `runtime.json`, whose `console` is `bin/gimp-console-3.2.exe` and whose folders are `share/gimp/3.0`, `share/locale`, and `etc/gimp/3.0`.

```json
{
  "format": 1,
  "version": "3.2.8-wasd.1",
  "gimp": "3.2.8",
  "platform": "darwin",
  "arch": "arm64",
  "console": "Contents/MacOS/gimp-console-3.2",
  "dataDir": "Contents/share/gimp/3.0",
  "localeDir": "Contents/share/locale",
  "sysconfDir": "Contents/etc/gimp/3.0",
  "sha256": {
    "COPYING": "<SHA-256 digest of COPYING>",
    "Contents/MacOS/gimp-console-3.2": "<SHA-256 digest of gimp-console-3.2>"
  }
}
```

In `runtime.json`, `format` is the file format that the plugin and Desktop packaging read (1), `version` is the runtime version, `gimp` is the GIMP version from the bundle's `Info.plist`, and `platform` and `arch` match the archive name. `console` names the program, and `dataDir`, `localeDir`, and `sysconfDir` the folders that the plugin passes as `GIMP3_DATADIR`, `GIMP3_LOCALEDIR`, and `GIMP3_SYSCONFDIR`. `sha256` maps every file except `runtime.json` to its digest. File names use letters, digits, spaces, and `_ . + @ = , # % ( ) -`, and none starts with a dot.

`--install <root>` unpacks the archive into a temporary directory in `<root>`, checks every file against `runtime.json`, and renames the directory to `<root>/<platform>-<arch>/`, which replaces an earlier install.

`<out>/manifest.json` lists the archives of one runtime version by `<platform>-<arch>`:

```json
{
  "format": 1,
  "version": "3.2.8-wasd.1",
  "gimp": "3.2.8",
  "artifacts": {
    "darwin-arm64": {
      "url": "https://github.com/WASDEngine/WASD-Engine/releases/download/gimp-3.2.8-wasd.1/gimp-3.2.8-wasd.1-darwin-arm64.tar.gz",
      "bytes": 95737486,
      "sha256": "<SHA-256 digest of the archive>"
    }
  }
}
```

`url` is the archive's download URL in the GitHub release `gimp-<version>` of the repository that `--repository` names (default `WASDEngine/WASD-Engine`), `bytes` is the archive size, and `sha256` is the archive's digest. Building the other architecture into the same output directory adds its entry. `build.sh` stops when the existing manifest lists another runtime or GIMP version.

The macOS arm64 runtime holds 4,413 files: about 290 MB unpacked and 96 MB as an archive.

## Test

```sh
python3 -B -m unittest discover --start-directory wasdengine/gimp --pattern 'test_*.py'
```

`build.sh` runs `smoke.py` on the staged runtime before it packs it. `smoke.py` runs `gimp-console` as the plugin does, with a new profile and the three folder variables, and on Windows without a console window, and a Python batch command that saves a PNG and reports GIMP's data folder; it fails when GIMP prints a missing translation catalog, a GLib critical or warning, or does not finish the command, when `lsappinfo` lists an application for the process, and when, on Windows, any process that GIMP started shows a visible window. To smoke-test an installed runtime:

```sh
python3 -I wasdengine/gimp/smoke.py --runtime packages/gamedev/gimp/runtime/darwin-arm64 --work /tmp/gimp-smoke
```

The GIMP plugin's end-to-end suite, `packages/gamedev/gimp/tests/gimp-worker.e2e.ts`, runs against an installed runtime.

## Release

The GIMP runtime workflow, [wasd-gimp.yml](../../.github/workflows/wasd-gimp.yml), runs only when dispatched, from the Actions tab or with `gh workflow run wasd-gimp.yml -f version=3.2.8-wasd.1`. Its `check` job runs `bash -n` and ShellCheck on `build.sh` and the tests in this directory.

The `build` jobs run `build.sh` on macOS 26 (arm64) and on Windows Server 2025 (x64), install each runtime into a directory whose name holds characters outside ASCII, smoke-test the installed runtime, and upload each archive with its one-entry `manifest.json` as a workflow artifact that is kept for seven days. The Windows job also unpacks its archive with Windows' `tar.exe`, as the plugin does, and smoke-tests that copy.

When the workflow runs on the default branch and both runtimes pass, the `release` job merges the manifests and checks every archive against the merged manifest: URL, size, digest, and the files and platform inside. It then creates the release `gimp-<version>` as a draft at the run's commit, or moves a draft that an earlier failed run left to that commit, attaches the archives and then `manifest.json`, and publishes the release as a pre-release, so that it never becomes the repository's latest release, which the Desktop update feed and the front page's Download link reach through `releases/latest`; GitHub makes a full release the latest one while no other full release exists, even one published with `--latest=false`. A published release is never changed; the job fails instead.

Desktop packaging reads the release's `manifest.json` to ship the runtime inside the app; to package with a local build instead, set `WASD_GIMP_DIR` to its `--out` folder, and `WASD_GIMP_BUNDLE=0` packages without GIMP. A published runtime version never changes, so publish a new one, such as `3.2.8-wasd.2`, whenever `prepare`, `prepare-windows`, or the pinned disk images or installer change, and update the `version` default of `build.sh` and `GIMP_MANIFEST_URL` in `apps/desktop/scripts/wasdengine-gimp.ts` to match. To move to a new GIMP release, update `gimp_version`, the disk image and installer URLs and digests, and the source URL and digest in `build.sh` from GIMP's `SHA256SUMS`, check that `prepare` still knows every link in the bundle and that the installer's component names are those that `SETUP_COMPONENTS` in `runtime.py` lists, and run the smoke test and the end-to-end suite.

No Linux runtime is built: GIMP publishes an AppImage for Linux, whose layout and environment `prepare` and the plugin do not handle, and WASD Engine publishes no Linux Desktop app. The workflow builds no macOS x64 runtime either, although `build.sh` supports one. Where no runtime is shipped, the plugin uses an installed GIMP 3. The Windows runtime is smoke-tested only on the workflows' Windows runners, which have no display adapter of their own.
