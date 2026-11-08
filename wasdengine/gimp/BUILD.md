# GIMP runtime

The GIMP plugin (`@deepseek-ai/dsh-gimp`) edits images with GIMP 3's `gimp-console`, which runs without a window. The Desktop app for macOS on Apple silicon ships a GIMP runtime inside the plugin package, so its users install nothing: GIMP 3.2.8's official macOS build without the parts that the tools never use. Elsewhere the plugin uses an installed GIMP 3.

| Path | Role |
|---|---|
| [build.sh](build.sh) | Builds, smoke-tests, packages, and optionally installs the runtime of the current Mac. |
| [runtime.py](runtime.py) | Turns GIMP's bundle into the runtime layout, checks its libraries, and packages, installs, merges, and verifies runtime archives for `build.sh` and the release workflow. |
| [smoke.py](smoke.py) | Saves an image with a runtime, as the plugin runs it, and checks GIMP's output, data folder, and that macOS lists no application for it. |
| [test_runtime.py](test_runtime.py) | Tests of `runtime.py`. |
| [test_smoke.py](test_smoke.py) | Tests of the helpers of `smoke.py`. |
| [wasd-gimp.yml](../../.github/workflows/wasd-gimp.yml) | Builds the runtime and publishes the release. |

## The build

GIMP's own macOS application takes about 600 MB, of which the tools use about half. `build.sh` downloads GIMP's disk image for the Mac's architecture from `download.gimp.org`, checks it against the SHA-256 that the script pins from GIMP's `SHA256SUMS`, copies `GIMP.app/Contents` out of it, and clears the copy's extended attributes, because a quarantine attribute would make macOS assess every program at its first start and reject it once it is signed again. `runtime.py prepare` then removes the debug symbols, the GUI program and GIMP's debug, clipboard-test, and plug-in build tools, the headers, the translations, the GUI icons, the bundle's `Info.plist` and signatures, Python's test suite, IDE, Tk, turtle demos, and installer, and the build and documentation tools in Python's `site-packages`. GIMP's `sitecustomize.py` imports `certifi`, which stays.

The runtime holds no symbolic links, because the Desktop runtime tree accepts none. `prepare` deletes the program and library aliases, which nothing loads by name, moves `Resources` to `share`, where GIMP reads its data through the bundle's `share` link, and keeps an empty `Resources` folder, because GIMP sets up its bundled libraries only when that folder exists. The folder holding these keeps the name `Contents`: GIMP finds its plug-ins, fonts, and libraries relative to the bundle that macOS derives from `<bundle>/Contents/MacOS/<program>`. The folder above it has no `.app` name and no `Info.plist`, so macOS registers no application. GIMP's Python plug-ins run from a nested `Python.app`, whose `share` link pointed back at GIMP's data; the plugin passes the data, translation, and configuration folders as `GIMP3_DATADIR`, `GIMP3_LOCALEDIR`, and `GIMP3_SYSCONFDIR` instead. Every folder that must exist and would be empty, such as `share/locale`, holds `wasd-engine-folder.txt`, because archives hold files only; without `share/locale`, every plug-in reports a missing translation catalog at each start.

`build.sh` signs every Mach-O file ad hoc (`codesign --sign -`), as macOS requires of arm64 code, because `prepare` removed the signatures that sealed the removed files. `runtime.py check-links` then requires every library that a program, library, or plug-in loads to resolve to a file inside `Contents` or to a system library. A signed Desktop build signs every Mach-O file again with its identity, with hardened runtime and without entitlements, in the `sign:dsh-native` step; GIMP's Python needs no JIT or unsigned-memory entitlement, and the release identity's team satisfies library validation. `COPYING` holds the GNU General Public License, version 3, GIMP's license, and `SOURCE.txt` names GIMP's source release and the macOS build recipes that name the sources of the bundled libraries.

## Build locally

Prerequisites: macOS with the Xcode Command Line Tools (for `codesign` and `otool`), curl, and Python 3.8 or newer.

```sh
# Download and check GIMP 3.2.8's disk image, prepare and smoke-test the runtime, and package it.
wasdengine/gimp/build.sh --out /tmp/gimp

# Also install it where the GIMP plugin of a source checkout finds it, as the Desktop app ships it.
wasdengine/gimp/build.sh --out /tmp/gimp --install "$PWD/packages/gamedev/gimp/runtime"
```

`build.sh --help` lists every option. The script reuses a disk image of an earlier run in the same `--out` folder when its SHA-256 matches. A build takes about a minute after the 186 MB download.

The plugin package's `runtime/` folder is ignored by Git. With a runtime installed there, a source checkout and `dsh web` use it the way the Desktop app uses the one it ships.

## Output

`build.sh` writes `<out>/gimp-<version>-darwin-<arch>.tar.gz`, where `<arch>` is `arm64` or `x64`. The archive holds only plain files at relative paths, which unpack into this layout:

| Path | Contents |
|---|---|
| `Contents/MacOS/` | `gimp-console-3.2`, GIMP's `python3`, the Script-Fu interpreter, and the GEGL and Graphviz tools. |
| `Contents/lib/` | GIMP's libraries and their dependencies, its plug-ins, GEGL and babl modules, and `Python.framework`. |
| `Contents/share/` | GIMP's data, such as brushes and fonts, and the data of its libraries. |
| `Contents/etc/` | GIMP's and fontconfig's configuration. |
| `Contents/Resources/` | Empty but for `wasd-engine-folder.txt`. |
| `COPYING`, `SOURCE.txt` | GIMP's license and the corresponding source. |
| `runtime.json` | The runtime description. |

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

`--install <root>` unpacks the archive into a temporary directory in `<root>`, checks every file against `runtime.json`, and renames the directory to `<root>/darwin-<arch>/`, which replaces an earlier install.

`<out>/manifest.json` lists the archives of one runtime version by `<platform>-<arch>`:

```json
{
  "format": 1,
  "version": "3.2.8-wasd.1",
  "gimp": "3.2.8",
  "artifacts": {
    "darwin-arm64": {
      "url": "https://github.com/WASDEngine/WASDEngine/releases/download/gimp-3.2.8-wasd.1/gimp-3.2.8-wasd.1-darwin-arm64.tar.gz",
      "bytes": 95737486,
      "sha256": "<SHA-256 digest of the archive>"
    }
  }
}
```

`url` is the archive's download URL in the GitHub release `gimp-<version>` of the repository that `--repository` names (default `WASDEngine/WASDEngine`), `bytes` is the archive size, and `sha256` is the archive's digest. Building the other architecture into the same output directory adds its entry. `build.sh` stops when the existing manifest lists another runtime or GIMP version.

The macOS arm64 runtime holds 4,413 files: about 290 MB unpacked and 96 MB as an archive.

## Test

```sh
python3 -B -m unittest discover --start-directory wasdengine/gimp --pattern 'test_*.py'
```

`build.sh` runs `smoke.py` on the staged runtime before it packs it. `smoke.py` runs `gimp-console` as the plugin does, with a new profile and the three folder variables, and a Python batch command that saves a PNG and reports GIMP's data folder; it fails when GIMP prints a missing translation catalog, a GLib critical or warning, or does not finish the command, and when `lsappinfo` lists an application for the process. To smoke-test an installed runtime:

```sh
python3 -I wasdengine/gimp/smoke.py --runtime packages/gamedev/gimp/runtime/darwin-arm64 --work /tmp/gimp-smoke
```

The GIMP plugin's end-to-end suite, `packages/gamedev/gimp/tests/gimp-worker.e2e.ts`, runs against an installed runtime.

## Release

The GIMP runtime workflow, [wasd-gimp.yml](../../.github/workflows/wasd-gimp.yml), runs only when dispatched, from the Actions tab or with `gh workflow run wasd-gimp.yml -f version=3.2.8-wasd.1`. Its `check` job runs `bash -n` and ShellCheck on `build.sh` and the tests in this directory.

The `build` job runs `build.sh` on macOS 14 (arm64), installs the runtime into a directory whose name holds characters outside ASCII, smoke-tests the installed runtime, and uploads the archive with its one-entry `manifest.json` as a workflow artifact that is kept for seven days.

When the workflow runs on the default branch, the `release` job merges the manifests and checks every archive against the merged manifest: URL, size, digest, and the files and platform inside. It then creates the release `gimp-<version>` as a draft at the run's commit, or moves a draft that an earlier failed run left to that commit, attaches the archives and then `manifest.json`, and publishes the release without marking it the latest. A published release is never changed; the job fails instead.

Desktop packaging reads the release's `manifest.json` to ship the runtime inside the app; to package with a local build instead, set `WASD_GIMP_DIR` to its `--out` folder, and `WASD_GIMP_BUNDLE=0` packages without GIMP. A published runtime version never changes, so publish a new one, such as `3.2.8-wasd.2`, whenever `prepare` or the pinned disk images change, and update the `version` default of `build.sh` and `GIMP_MANIFEST_URL` in `apps/desktop/scripts/wasdengine-gimp.ts` to match. To move to a new GIMP release, update `gimp_version`, the disk image digests, and the source URL and digest in `build.sh` from GIMP's `SHA256SUMS`, check that `prepare` still knows every link in the bundle, and run the smoke test and the end-to-end suite.

No Linux or Windows runtime is built: GIMP publishes an AppImage and an installer for them, whose layouts and environment `prepare` and the plugin do not handle yet. The workflow builds no macOS x64 runtime either, although `build.sh` supports one. The Desktop apps for those platforms ship no runtime, and the plugin there uses an installed GIMP 3.
