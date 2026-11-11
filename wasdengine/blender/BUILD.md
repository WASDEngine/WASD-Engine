# Blender runtime

The Blender plugin (`@deepseek-ai/dsh-blender`) runs Blender without a window as the `bpy` Python module. The Desktop apps for macOS on Apple silicon and Windows x64 ship a Blender runtime inside the plugin package, so their users install nothing: CPython 3.13 from python-build-standalone with Blender 5.2.3's `bpy` module and the packages that `bpy` requires. The macOS app ships the runtime's files; the Windows app ships the runtime's archive, which the plugin unpacks on first use (see [Windows](#windows)). Elsewhere the plugin installs `bpy` with uv on first use or runs an installed Blender.

| Path | Role |
|---|---|
| [build.sh](build.sh) | Builds, packages, and optionally installs the runtime of one target, and smoke-tests it where it runs. |
| [requirements-darwin-arm64.txt](requirements-darwin-arm64.txt), [requirements-win32-x64.txt](requirements-win32-x64.txt) | The wheels that each runtime installs, each pinned to one PyPI file and its SHA-256. |
| [runtime.py](runtime.py) | Installs the pinned wheels, turns the Python installation into the runtime layout, checks its Mach-O files, and packages, installs, merges, and verifies runtime archives for `build.sh` and the release workflow. |
| [smoke.py](smoke.py) | Renders, exports, and saves a scene with a runtime, as the plugin runs it, and checks that macOS shows no application for it and that the runtime stays unchanged. |
| [test_runtime.py](test_runtime.py) | Tests of `runtime.py`. |
| [test_smoke.py](test_smoke.py) | Tests of the helpers of `smoke.py`. |
| [wasd-blender.yml](../../.github/workflows/wasd-blender.yml) | Builds the runtime and publishes the release. |

## The build

`build.sh --target <target>` builds `darwin-arm64`, the default, or `win32-x64`. It downloads python-build-standalone's `install_only_stripped` CPython 3.13.18 for `aarch64-apple-darwin` or `x86_64-pc-windows-msvc` and checks it against the SHA-256 that the script pins from the release's asset digests. That Python is relocatable: it finds its library and standard library relative to its program, so the runtime runs from any folder, including one whose path holds characters outside ASCII. `runtime.py install-wheels` then installs exactly the wheels that `requirements-<target>.txt` lists: it downloads each into `<out>/wheels/`, or reuses one there, checks its SHA-256, and unpacks it into site-packages as the wheel format lays it out, without its console scripts, recording `wasd-engine` as the installer. Installing without the target's pip lets the build make the Windows runtime on macOS or Linux. Where the build runs the target's Python, on macOS for `darwin-arm64`, the pip that the Python archive brings checks that the wheels satisfy each other's requirements before `prepare` removes it.

The wheels are bpy 5.2.3 and the packages that it requires: attrs, cattrs, certifi, charset-normalizer, Cython, idna, numpy, requests, typing-extensions, urllib3, and zstandard, at the same versions for both targets. numpy's macOS wheel is the `macosx_11_0_arm64` one, which brings OpenBLAS in `numpy/.dylibs`, because the `macosx_14_0_arm64` wheel links Apple's Accelerate and needs macOS 14, newer than the Desktop app's minimum of macOS 13. Cython and charset-normalizer come as their pure-Python wheels, which add no native code. To update a package, pick its wheel for `cp313` and `macosx_*_arm64` no newer than macOS 13 or `win_amd64`, or its `py3-none-any` wheel, and copy the URL and SHA-256 from its PyPI page into both files.

`runtime.py prepare` then removes what the tools never use: on macOS the program aliases and scripts in `bin` except `python3.13`, the manual pages, and the pkg-config files; on Windows the pip launchers of `Scripts`, the import libraries of `libs`, and the windowless `pythonw.exe`; and on both the headers, Tcl and Tk with `tkinter` and `turtle`, IDLE, `ensurepip` and pip, numpy's test suites, and every bytecode cache. A runtime without Tk can open no window. The runtime holds no symbolic links, because the Desktop runtime tree accepts none; the links of the macOS installation are the program aliases, manual pages, and pkg-config files, which `prepare` drops.

The runtime ships no bytecode: the plugin runs the macOS runtime's Python with `-B`, so it never writes `__pycache__` folders into the signed application. Python compiles the modules that a worker imports when the worker starts, which takes about 0.7 s; precompiled files would add 52 MB. The runtime that the Windows plugin unpacks under its data folder writes its bytecode caches there.

The macOS wheels and Python archive carry ad hoc signatures, which `prepare` leaves alone; `build.sh` verifies each with `codesign --verify --strict`, because macOS refuses arm64 code without a valid one. `runtime.py check-binaries` then requires every library that a program, library, or module loads to resolve to a file inside the runtime or to a system library, and every Mach-O file to run on macOS 13. An `@rpath` name resolves through the file's own rpath folders, the rpath folders of the runtime's other files, or the install name of another file: Blender's glTF add-on loads `libdraco.dylib` that `bpy` loaded before, and MaterialX's modules load the core module that its package imports first. A signed Desktop build signs every Mach-O file again with its identity, with hardened runtime and without entitlements, in the `sign:dsh-native` step; `bpy` needs no JIT or unsigned-memory entitlement for the tools, and the release identity's team satisfies library validation. Cycles' Open Shading Language backend compiles shaders with LLVM at render time and stays off, as it is by default.

`COPYING` holds the GNU General Public License, version 3, Blender's license, and `SOURCE.txt` names the corresponding source: Blender's tag `v5.2.3`, CPython's source release with python-build-standalone's recipes, and the source distributions beside the pinned wheels on PyPI. Python's license stays in `python/lib/python3.13/LICENSE.txt` and each package's license in its `.dist-info` folder.

<a id="windows"></a>
## Windows

The Windows runtime is the same Python and the same packages for `win32-x64`. It cannot ship as files below the app's install folder: that folder, `C:\Users\<name>\AppData\Local\Programs\WASD Engine\resources\app.asar.unpacked\dsh\node_modules\@deepseek-ai\dsh-blender\runtime\win32-x64\`, takes 133 characters before the user name, and the runtime's deepest file, a MaterialX shader library of `bpy`, 130 more, past the 259 characters that Windows allows a path without long path support. Desktop packaging ships the checked archive instead, with an `archive.json` that names it, its size and SHA-256, and the fields of its `runtime.json`. On first use the plugin unpacks it with Windows' own `tar.exe` into `runtime/<version>/` under its data folder, `%USERPROFILE%\.wasdengine\blender`, where the deepest path stays under 210 characters for a 20-character user name. The Windows runtime holds 4,372 files: about 1 GB unpacked and 361 MB as an archive.

`build.sh --target win32-x64` builds the runtime on any computer with curl, tar, and Python 3.8 or newer, because it runs no Windows program; it smoke-tests the runtime only on Windows, and the release workflow smoke-tests it on a Windows runner. `smoke.py` renders with EEVEE only on macOS, because EEVEE needs a GPU, which the Windows runners lack.

## Build locally

Prerequisites: for `darwin-arm64`, macOS on Apple silicon with the Xcode Command Line Tools (for `codesign` and `otool`); for both, curl, tar, and Python 3.8 or newer.

```sh
# Download and check Python, install the pinned wheels, prepare and smoke-test the runtime, and package it.
wasdengine/blender/build.sh --out /tmp/blender

# Also install it where the Blender plugin of a source checkout finds it, as the Desktop app ships it.
wasdengine/blender/build.sh --out /tmp/blender --install "$PWD/packages/gamedev/blender/runtime"

# Build the Windows runtime into the same folder, which adds it to manifest.json.
wasdengine/blender/build.sh --out /tmp/blender --target win32-x64
```

`build.sh --help` lists every option. The script reuses a Python archive of an earlier run in the same `--out` folder when its SHA-256 matches, and the wheels in its `wheels/` folder. A macOS build takes about two minutes after the 280 MB of downloads, most of it compressing the archive.

The plugin package's `runtime/` folder is ignored by Git. With a runtime installed there, a source checkout and `dsh web` use it the way the Desktop app uses the one it ships.

## Output

`build.sh` writes `<out>/blender-<version>-<target>.tar.gz`. The archive holds only plain files at relative paths, which unpack into this layout, shown for macOS with the Windows paths after the slash:

| Path | Contents |
|---|---|
| `python/bin/python3.13` / `python/python.exe` | The Python program, which the plugin starts as the worker. |
| `python/lib/libpython3.13.dylib` / `python/python313.dll` | Python's library. |
| `python/lib/python3.13/` / `python/Lib/` | The standard library, with its extension modules in `lib-dynload` / `python/DLLs/`. |
| `python/lib/python3.13/site-packages/` / `python/Lib/site-packages/` | `bpy` with Blender's libraries, scripts, and data, numpy, and the other packages. |
| `COPYING`, `SOURCE.txt` | Blender's license and the corresponding source. |
| `runtime.json` | The runtime description. |

```json
{
  "format": 1,
  "version": "5.2.3-wasd.1",
  "bpy": "5.2.3",
  "python": "3.13.18",
  "platform": "darwin",
  "arch": "arm64",
  "executable": "python/bin/python3.13",
  "sha256": {
    "COPYING": "<SHA-256 digest of COPYING>",
    "python/bin/python3.13": "<SHA-256 digest of python3.13>"
  }
}
```

In `runtime.json`, `format` is the file format that the plugin and Desktop packaging read (1), `version` is the runtime version, `bpy` is the version of the `bpy` package, which is the Blender version, `python` is the Python version, and `platform` and `arch` match the archive name. `executable` names the Python program. `sha256` maps every file except `runtime.json` to its digest. File names use letters, digits, spaces, and `_ . + @ = , # % ( ) & -`, and none starts with a dot except numpy's `.dylibs` folder.

`--install <root>` unpacks the archive into a temporary directory in `<root>`, checks every file against `runtime.json`, and renames the directory to `<root>/darwin-arm64/`, which replaces an earlier install.

`<out>/manifest.json` lists the archives of one runtime version by `<platform>-<arch>`:

```json
{
  "format": 1,
  "version": "5.2.3-wasd.1",
  "bpy": "5.2.3",
  "artifacts": {
    "darwin-arm64": {
      "url": "https://github.com/WASDEngine/WASD-Engine/releases/download/blender-5.2.3-wasd.1/blender-5.2.3-wasd.1-darwin-arm64.tar.gz",
      "bytes": 273874822,
      "sha256": "<SHA-256 digest of the archive>"
    }
  }
}
```

`url` is the archive's download URL in the GitHub release `blender-<version>` of the repository that `--repository` names (default `WASDEngine/WASD-Engine`), `bytes` is the archive size, and `sha256` is the archive's digest. Building the other target into the same output directory adds its entry. `build.sh` stops when the existing manifest in the output directory lists another runtime or bpy version.

The macOS arm64 runtime holds 4,248 files: about 770 MB unpacked and 274 MB as an archive.

## Test

```sh
python3 -B -m unittest discover --start-directory wasdengine/blender --pattern 'test_*.py'
```

`build.sh` runs `smoke.py` on the staged runtime before it packs it, where it can run the runtime. `smoke.py` starts the runtime's Python as the plugin does, with `-I -X utf8 -B` and without Python redirection in its environment, and runs a script that imports `bpy` and numpy, renders a scene with Cycles on the CPU and, on macOS, with EEVEE, exports it as glTF, and saves it as a `.blend` file. EEVEE renders on the GPU through Metal, which connects the process to the window server, so macOS registers it with LaunchServices; the test accepts no entry or a `BackgroundOnly` one, which has no Dock icon, no menu bar, and no place in the application switcher, and fails for any other type or a process in `lsappinfo visibleProcessList`. It also fails when the run added, removed, or changed any file or folder of the runtime. To smoke-test an installed runtime:

```sh
python3 -I wasdengine/blender/smoke.py --runtime packages/gamedev/blender/runtime/darwin-arm64 --work /tmp/blender-smoke
```

The Blender plugin's end-to-end suite, `packages/gamedev/blender/tests/blender-worker.e2e.ts`, runs the worker and the tools against an installed runtime.

## Release

The Blender runtime workflow, [wasd-blender.yml](../../.github/workflows/wasd-blender.yml), runs only when dispatched, from the Actions tab or with `gh workflow run wasd-blender.yml -f version=5.2.3-wasd.1`. Its `check` job runs `bash -n` and ShellCheck on `build.sh` and the tests in this directory.

The `build` job runs `build.sh` for `darwin-arm64` on macOS 26 (arm64) and for `win32-x64` on Ubuntu, installs each runtime into a directory whose name holds characters outside ASCII, smoke-tests the macOS one there, and uploads each archive with its one-entry `manifest.json` as a workflow artifact that is kept for seven days. The `smoke-windows` job installs the Windows archive on Windows Server 2025 and runs `smoke.py` on it.

When the workflow runs on the default branch and both runtimes pass, the `release` job merges the manifests and checks every archive against the merged manifest: URL, size, digest, and the files and platform inside. It then creates the release `blender-<version>` as a draft at the run's commit, or moves a draft that an earlier failed run left to that commit, attaches the archives and then `manifest.json`, and publishes the release as a pre-release, so that it never becomes the repository's latest release, which the Desktop update feed and the front page's Download link reach through `releases/latest`. A published release is never changed; the job fails instead.

Desktop packaging reads the release's `manifest.json` to ship the runtime inside the app; to package with a local build instead, set `WASD_BLENDER_DIR` to its `--out` folder, and `WASD_BLENDER_BUNDLE=0` packages without the runtime. A published runtime version never changes, so publish a new one, such as `5.2.3-wasd.2`, whenever `prepare`, the Python archives, or the pinned wheels change, and update the `version` default of `build.sh` and `BLENDER_MANIFEST_URL` in `apps/desktop/scripts/wasdengine-blender.ts` to match. To move to a new Blender release, update the bpy wheels in both requirements files, `bpy_version` and `blender_commit` in `build.sh`, the plugin's `bpyVersion` default in `packages/gamedev/blender/src/index.ts`, whose value the plugin runs the shipped runtime for, and the runtime version, then run the smoke test and the end-to-end suite.

No Linux or macOS x64 runtime is built: bpy 5.2.3 publishes no macOS x64 wheel, and WASD Engine publishes no Linux Desktop app. Where no runtime is shipped, the plugin installs `bpy` with uv or runs an installed Blender. The Windows runtime is smoke-tested only on the release workflow's Windows runner, without a GPU, so EEVEE renders on Windows are untested there.
