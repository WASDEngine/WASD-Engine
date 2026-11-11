# SuperCollider runtime

The SuperCollider plugin (`@deepseek-ai/dsh-supercollider`) designs and renders sound with SuperCollider 3.14.1 running without a window. The Desktop app ships a SuperCollider runtime for its platform inside the plugin package, so users install nothing: sclang, the language interpreter, built without Qt; scsynth, the synthesis server, which the plugin runs only for offline renders; the UGen plugins; the class library; and the class help files. A runtime is that folder and a `runtime.json` that names and hashes every file in it. This directory holds the scripts that build, package, install, smoke-test, and publish runtimes.

| Path | Role |
|---|---|
| [build.sh](build.sh) | Builds, smoke-tests, packages, and optionally installs the runtime of the current platform. |
| [runtime.py](runtime.py) | Packages, installs, merges, and verifies runtime archives for `build.sh` and the release workflow, and on Windows copies the Visual C++ runtime into the runtime and checks its libraries. |
| [smoke.py](smoke.py) | Renders a tone offline with a runtime, as the plugin runs it, and checks the WAV, Ogg Vorbis, and FLAC files, and on Windows that no process of the run shows a window. |
| [test_runtime.py](test_runtime.py) | Tests of `runtime.py`. |
| [test_smoke.py](test_smoke.py) | Tests of the check that `smoke.py` applies to the rendered files. |
| [triplets/](triplets) | vcpkg triplets that build the libraries in release mode: statically for macOS 11.0 and later and for Linux, and for Windows statically except libsndfile and FFTW. |
| [wasd-supercollider.yml](../../.github/workflows/wasd-supercollider.yml) | Builds every platform and publishes the release. |

## The build

SuperCollider's official macOS application links sclang against about 500 MB of Qt frameworks, which a headless runtime does not need. `build.sh` builds SuperCollider from its release tarball, whose SHA-256 the script pins and checks, with `SC_QT=OFF` and without the IDE, supernova, HID, Ableton Link, Avahi, X11, readline, and the help renderer. libsndfile 1.2.2 with its FLAC, Ogg, Vorbis, and Opus codecs comes from vcpkg at a pinned commit and links statically, so the programs depend only on the operating system: system frameworks on macOS, and the C library and ALSA on Linux, where FFTW also links statically, libstdc++ and libgcc link statically, and scsynth's audio API is PortAudio over ALSA instead of JACK. The script refuses a binary that links anything else, or that has an rpath. MP3 support is not built.

Before it compiles, `build.sh` changes one line of SuperCollider's source: `SC_MAX_TOKEN_LENGTH` in `common/SC_StringParser.h` becomes 4096 instead of 256. scsynth splits its plugin path, the `-U` option that the plugin passes and `SC_PLUGIN_PATH`, into folders and cuts each one to `SC_MAX_TOKEN_LENGTH` - 1 bytes, so an unchanged scsynth inside a deeply nested folder, such as a Desktop app packaged under a long build path, loads no UGens and renders silence. The script stops when the header defines neither value, and `SOURCE.txt` records the change.

It also changes three lines of scsynth through `runtime.py patch-source` (`SOURCE_PATCHES`). scsynth hands the UTF-8 folders of its plugin path and the name of its non-real-time score file to Windows through the ANSI code page, so on Windows a runtime or work folder whose path holds characters outside that code page, such as a user folder named in Chinese, loads no UGens or reads no score. The changed lines convert through UTF-16 on Windows and make the same paths as before on macOS and Linux. `patch-source` stops the build when the lines are not SuperCollider 3.14.1's, and `SOURCE.txt` records the change.

The runtime holds the class library without its Qt `GUI` folders and without the Ableton Link classes, which SuperCollider's own install rules leave out of builds without Qt or Link, and only the class reference files of the help, `HelpSource/Classes/*.schelp`, which the plugin's `class_info` tool reads. `COPYING` holds SuperCollider's license, and `SOURCE.txt` names the corresponding source, the build script, and the vcpkg commit, because the runtime distributes GPL-3.0 programs.

<a id="windows"></a>
On Windows, `build.sh` runs in Git Bash and builds with the newest Visual Studio that `vswhere` finds, through CMake's Visual Studio generator, because SuperCollider's documentation names Visual Studio as its only supported Windows toolchain. The triplet `wasd-x64-windows` builds libsndfile, with its codecs inside, and FFTW as DLLs and everything else statically, all against the dynamic Visual C++ runtime, as SuperCollider's own vcpkg triplets do, because SuperCollider's Windows build copies `sndfile.dll` and `fftw3f.dll` beside scsynth. The runtime holds `sclang.exe`, `scsynth.exe`, the two DLLs, the `*.scx` plugins, and the Visual C++ runtime DLLs that `runtime.py vc-runtime` copies from Visual Studio's redistributable folder because a file of the runtime loads them, so the runtime needs no Visual C++ Redistributable on the user's computer. `runtime.py check-imports` then reads the import and delay-load tables of every `.exe`, `.dll`, and `.scx` file and requires each to be x64 code whose libraries lie in the runtime's folder or in Windows itself. The runtime's deepest path is about 60 characters, so the Windows app ships its files below the install folder.

sclang on Windows reads its arguments in the ANSI code page, which cannot hold every character of a user's folder name, so the plugin names its class library configuration relative to sclang's working directory, which holds it. It ignores `XDG_CONFIG_HOME` and `XDG_DATA_HOME` and uses the user's own `%LOCALAPPDATA%\SuperCollider` folder, whose startup file the plugin's worker class skips. It runs `unixCmd` through `cmd.exe`, so the worker class quotes paths with double quotes and runs scsynth without `exec` there. Node.js starts sclang without a console window, and the `cmd.exe` and scsynth processes that sclang starts share that hidden console, so no process of the SuperCollider tools shows a window or a taskbar entry.

On macOS, `build.sh` strips the local symbols of sclang, scsynth, and the plugins and signs them ad hoc (`codesign --sign -`); they are not notarized. A signed Desktop build signs them again with its identity in the `sign:dsh-native` step, which signs every Mach-O file of the packaged tree. They target macOS 11.0, the deployment target of SuperCollider's own arm64 builds.

## Build locally

Prerequisites: Git, curl, Python 3.8 or newer, and a C++ compiler: the Xcode Command Line Tools on macOS, GCC with `libasound2-dev` (Debian and Ubuntu) on Linux, or Visual Studio 2022 or newer with the C++ desktop workload on Windows x64. On macOS and Linux, CMake, Ninja, and pkg-config come from `PATH`; when one is missing, `build.sh` installs all three from PyPI into `<out>/.tools` with [uv](https://docs.astral.sh/uv/), and vcpkg also needs `zip`, `unzip`, and `tar`. On Windows, `build.sh` runs in Git Bash and needs CMake on `PATH`; vcpkg brings its own tools there.

```sh
# Download and check SuperCollider 3.14.1, build it with its libraries, smoke-test it, and package it.
wasdengine/supercollider/build.sh --out /tmp/supercollider

# Also install it where the SuperCollider plugin of a source checkout finds it, as the Desktop app ships it.
wasdengine/supercollider/build.sh --out /tmp/supercollider --install "$PWD/packages/gamedev/supercollider/runtime"
```

`build.sh --help` lists every option. The script reuses the source, the vcpkg checkout, the vcpkg binary cache (`<out>/vcpkg-cache`), and the CMake build folder of an earlier run in the same `--out` folder, so a rebuild compiles only what changed. A first build takes about two minutes on a recent Mac.

The plugin package's `runtime/` folder is ignored by Git. With a runtime installed there, a source checkout and `dsh web` use it the way the Desktop app uses the one it ships.

## Output

`build.sh` writes `<out>/supercollider-<version>-<platform>-<arch>.tar.gz`. Platform and architecture use Node.js names: `darwin`, `linux`, or `win32`, and `arm64` or `x64`. The archive holds only plain files at relative paths, which unpack into this layout, with the Windows names after the slash:

| Path | Contents |
|---|---|
| `sclang` / `sclang.exe` | The language interpreter, without Qt. |
| `scsynth` / `scsynth.exe` | The synthesis server. |
| — / `sndfile.dll`, `fftw3f.dll`, `vcruntime140*.dll`, `msvcp140*.dll` | libsndfile, FFTW, and the Visual C++ runtime, on Windows only. |
| `plugins/` | The UGen plugins: `*.scx` on macOS and Windows, `*.so` on Linux. |
| `SCClassLibrary/` | The class library. |
| `HelpSource/Classes/` | The class reference files. |
| `COPYING`, `SOURCE.txt` | SuperCollider's license and the corresponding source. |
| `runtime.json` | The runtime description. |

```json
{
  "format": 1,
  "version": "3.14.1-wasd.1",
  "supercollider": "3.14.1",
  "platform": "darwin",
  "arch": "arm64",
  "sclang": "sclang",
  "scsynth": "scsynth",
  "plugins": "plugins",
  "classLibrary": "SCClassLibrary",
  "helpSource": "HelpSource",
  "sha256": {
    "COPYING": "<SHA-256 digest of COPYING>",
    "sclang": "<SHA-256 digest of sclang>"
  }
}
```

In `runtime.json`, `format` is the file format that the plugin and Desktop packaging read (1), `version` is the runtime version, `supercollider` is the SuperCollider version from the source's `SCVersion.txt`, and `platform` and `arch` match the archive name. `sclang` and `scsynth` name the programs and `plugins`, `classLibrary`, and `helpSource` the folders, each at the runtime's root. `sha256` maps the `/`-separated path of every file of the runtime except `runtime.json` to its digest as 64 lowercase hexadecimal digits; the archive holds exactly those files.

`--install <root>` unpacks the archive into a temporary directory in `<root>`, checks every file against `runtime.json`, and renames the directory to `<root>/<platform>-<arch>/`, which replaces an earlier install.

`<out>/manifest.json` lists the archives of one runtime version by `<platform>-<arch>`:

```json
{
  "format": 1,
  "version": "3.14.1-wasd.1",
  "supercollider": "3.14.1",
  "artifacts": {
    "darwin-arm64": {
      "url": "https://github.com/WASDEngine/WASD-Engine/releases/download/supercollider-3.14.1-wasd.1/supercollider-3.14.1-wasd.1-darwin-arm64.tar.gz",
      "bytes": 5303349,
      "sha256": "<SHA-256 digest of the archive>"
    }
  }
}
```

`url` is the archive's download URL in the GitHub release `supercollider-<version>` of the repository that `--repository` names (default `WASDEngine/WASD-Engine`), `bytes` is the archive size, and `sha256` is the archive's digest. Building another platform into the same output directory adds its entry. `build.sh` stops when the existing manifest lists another runtime or SuperCollider version.

The macOS arm64 runtime is about 18 MB unpacked and 5.3 MB as an archive; the Linux arm64 runtime, which also holds FFTW, is about 26 MB unpacked and 8.6 MB as an archive.

## Test

```sh
python3 -B -m unittest discover --start-directory wasdengine/supercollider --pattern 'test_*.py'
```

`build.sh` runs `smoke.py` on the staged runtime before it packs it. `smoke.py` starts sclang as the plugin's bridge does, with the class library configuration named relative to its working directory, and on Windows without a console window. It gives scsynth a copy of the plugin folder in a folder whose path, made of characters outside ASCII, is longer than 255 bytes but shorter than Windows' 260-character limit, and checks the tone's peak, so it fails with an scsynth that lacks the source change; on Windows it also fails when any process that sclang started shows a visible window. To smoke-test an installed runtime:

```sh
python3 -I wasdengine/supercollider/smoke.py --runtime packages/gamedev/supercollider/runtime/darwin-arm64 --work /tmp/supercollider-smoke
```

## Release

The SuperCollider runtime workflow, [wasd-supercollider.yml](../../.github/workflows/wasd-supercollider.yml), runs only when dispatched, from the Actions tab or with `gh workflow run wasd-supercollider.yml -f version=3.14.1-wasd.1`. Its `check` job runs `bash -n` and ShellCheck on `build.sh` and the tests in this directory.

Three `build` jobs run `build.sh` on macOS 26 (arm64), Ubuntu 24.04 (x64), and Windows Server 2025 (x64). Each restores and saves the vcpkg binary cache keyed by platform, `build.sh`, and the triplets, installs the runtime into a directory whose name holds characters outside ASCII, smoke-tests the installed runtime, and uploads the archive with its one-entry `manifest.json` as a workflow artifact that is kept for seven days.

When the workflow runs on the default branch, the `release` job merges the manifests and checks every archive against the merged manifest: URL, size, digest, and the files and platform inside. It then creates the release `supercollider-<version>` as a draft at the run's commit, or moves a draft that an earlier failed run left to that commit, attaches the archives and then `manifest.json`, and publishes the release as a pre-release, so that it never becomes the repository's latest release, which the Desktop update feed and the front page's Download link reach through `releases/latest`; GitHub makes a full release the latest one while no other full release exists, even one published with `--latest=false`. The job fails when the release is already published. A run on another branch stops after the builds.

Desktop packaging reads the release's `manifest.json` to ship the runtime inside the app; to package with a local build instead, set `WASD_SUPERCOLLIDER_DIR` to its `--out` folder. A published runtime version never changes, so publish a new one, such as `3.14.1-wasd.2`, whenever the build options, the pinned source, or the vcpkg commit change, and update the `version` default of `build.sh` and `SUPERCOLLIDER_MANIFEST_URL` in `apps/desktop/scripts/wasdengine-supercollider.ts` to match.

The workflow builds no macOS x64 runtime, although `build.sh` and its triplets support one, and WASD Engine publishes no Linux Desktop app. Where no runtime is shipped, the plugin reports the missing runtime, because it starts no installed SuperCollider. The Windows runtime is smoke-tested only on the workflow's Windows runner.
