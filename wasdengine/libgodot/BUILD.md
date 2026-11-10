# LibGodot runtime

The Godot plugin (`@deepseek-ai/dsh-godot`) runs and tests games through LibGodot: Godot Engine 4.7.2 built as a shared library and hosted by `godot_runner`, a small C program. A runtime is one runner, one library, and a `runtime.json` that names and hashes both. The plugin loads it from `<dataRoot>/runtime/<version>/`. This directory holds the runner, the Godot patches, and the scripts that build, package, install, and publish runtimes.

| Path | Role |
|---|---|
| [godot_runner.c](godot_runner.c) | Source of the runner. |
| [patches/](patches) | Changes to Godot's source, applied in file-name order. |
| [build.sh](build.sh) | Builds, packages, and optionally installs the runtime of the current platform. |
| [runtime.py](runtime.py) | Packages, installs, merges, and verifies runtime archives for `build.sh` and the release workflow. |
| [test_runtime.py](test_runtime.py) | Tests of `runtime.py`. |
| [test_runner.py](test_runner.py) | Tests of the runner, which run it with [stub_libgodot.c](stub_libgodot.c), a stand-in for LibGodot. |
| [wasd-libgodot.yml](../../.github/workflows/wasd-libgodot.yml) | Builds every platform and publishes the release. |

## The runner

`godot_runner --libgodot <library> [--parent-pid <pid>] -- <Godot arguments>` loads the library and creates the one Godot instance that a process can hold from the arguments after `--`. It then calls `GodotInstance.iteration()` until the game quits, the runner receives SIGINT or SIGTERM (a console control event on Windows), or the process that `--parent-pid` names exits. Godot's output goes to the runner's stdout and stderr. Godot reads its arguments as UTF-8, so on Windows, where the C runtime passes programs their arguments in the ANSI code page, the runner converts its UTF-16 command line to UTF-8 and loads the library by its UTF-16 path.

On macOS and Linux, `--parent-pid` must name the runner's parent process; on Windows it can name any process, because the Host's subprocess service can start the runner through a helper process there. A thread of the runner watches that process. When the process exits, the thread stops the game as SIGTERM does, and terminates the runner when the engine has not shut down 3 seconds later, for example because a script never returns.

The runner exits with 0 after the game quits or a stop request ends it, 2 on a usage error, including a `--parent-pid` that names a running process other than the parent on macOS and Linux, 3 when the library cannot be loaded or is not a LibGodot build, 4 when Godot cannot create an instance from the arguments, 5 when the instance does not start, and 6 when the `--parent-pid` process is not running or cannot be watched, or the engine does not shut down within 3 seconds after it exits. LibGodot does not report the game's own exit code. The header comment of `godot_runner.c` describes the runner in full.

## The patch

Upstream LibGodot on macOS always creates `OS_MacOS_NSApp`, the windowed OS layer: a game opens a window and a Dock icon even with `--headless`, and `--embedded` has no effect. [0001-libgodot-macos-embedded-and-headless.patch](patches/0001-libgodot-macos-embedded-and-headless.patch) makes `libgodot_create_godot_instance` choose `OS_MacOS_Embedded` when the arguments contain `--embedded`, and `OS_MacOS_Headless` for `--headless` or `--display-driver headless`.

The embedded display server draws into a Core Animation layer that it shares through a CAContext for the Godot editor to display, so a game runs without any window. The patch lets that display server run without the editor's debugger connection, and makes it report the mouse position and buttons of injected input events, because no OS cursor is over the game. On OpenGL, the driver of the Compatibility renderer, the window's framebuffers come from the size that the editor sends through the debugger; without the editor, the patch creates them at the window's starting size in the first event pass, after OpenGL's functions load, so the game draws at its window size and VSync paces it. It also publishes the layer's CAContext id as the display server's `wasd_layer_context_id` metadata, which the harness script reports, so that the macOS Desktop app can show the layer in the Game tab, and without the editor it scales the layer with linear filtering, because the Desktop app fits the layer into the tab. Screenshots, and the Game tab outside the macOS Desktop app, read frames through the harness script. The patch changes only macOS files. It applies to Godot 4.7.2-stable; another Godot version needs a rebased patch and a new runtime version.

## Build locally

Prerequisites on every platform: Git, Python 3.8 or newer, and [uv](https://docs.astral.sh/uv/), whose `uvx` runs SCons 4.11.1. Without uv, `build.sh` runs the SCons module of `python3`, which needs SCons 4.4 or newer.

- macOS: Xcode or the Xcode Command Line Tools.
- Linux: GCC, `pkg-config`, and `wayland-scanner` (the `libwayland-bin` package on Debian and Ubuntu).
- Windows: Git Bash, and Visual Studio 2022 with the Desktop development with C++ workload. Without Visual Studio, SCons and the runner use MinGW-w64 gcc.

```sh
# Clone Godot 4.7.2-stable into /tmp/libgodot/godot-4.7.2-stable, patch it, build it, and package it.
wasdengine/libgodot/build.sh --out /tmp/libgodot

# Build an existing Godot checkout and install the result where the Desktop app's Godot plugin finds it.
wasdengine/libgodot/build.sh --source ~/src/godot --out /tmp/libgodot --install ~/.wasdengine/godot
```

`build.sh --help` lists every option. With `--source`, the script builds the checkout as it is: it applies the patches that the checkout lacks, skips those already applied, and never re-clones or resets it. Without `--source`, it clones the `--godot-ref` tag or branch into `<out>/godot-<ref>` once and reuses that clone. SCons rebuilds only what changed, and `--scons-cache <dir>` keeps compiled objects across clones. A first build takes several minutes on a recent Mac and can take over an hour on a four-core CI runner.

The Desktop app's Godot plugin keeps its data in `~/.wasdengine/godot`, or in `$DSH_HOME/godot` when `DSH_HOME` is set. `--install` with that directory puts the runtime where the plugin installs the one it downloads, so the plugin uses the local build instead. The development app that `pnpm run dev:desktop` and `start:desktop` launch sets `DSH_HOME` to `apps/desktop/.desktop-build/development/home` in its checkout unless `DSH_HOME` is already set, so install a local build for it into `apps/desktop/.desktop-build/development/home/godot`; a source checkout ships no runtime.

## Output

`build.sh` writes `<out>/libgodot-<version>-<platform>-<arch>.tar.gz`. Platform and architecture use Node.js names: `darwin`, `linux`, or `win32`, and `arm64` or `x64`. The archive holds three files at its root:

| File | Contents |
|---|---|
| `godot_runner`, or `godot_runner.exe` on Windows | The runner. |
| `libgodot.<Godot platform>.editor.<Godot arch>.<dylib, so, or dll>` | The library, for example `libgodot.macos.editor.arm64.dylib`. SCons names the Windows library `godot.windows.editor.x86_64.dll`, and `build.sh` renames it. |
| `runtime.json` | The runtime description. |

On macOS, `build.sh` signs both binaries ad hoc (`codesign --sign -`); they are not notarized. The runner targets macOS 11.0 on arm64 and macOS 10.13 on x86_64, the deployment targets of Godot's own macOS builds.

```json
{
  "format": 1,
  "version": "4.7.2-wasd.2",
  "godot": "4.7.2-stable",
  "platform": "darwin",
  "arch": "arm64",
  "runner": "godot_runner",
  "library": "libgodot.macos.editor.arm64.dylib",
  "sha256": {
    "godot_runner": "<SHA-256 digest of godot_runner>",
    "libgodot.macos.editor.arm64.dylib": "<SHA-256 digest of the library>"
  }
}
```

In `runtime.json`, `format` is the file format the Godot plugin reads (1), `version` is the runtime version, `godot` is the Godot version from the source's `version.py`, and `platform` and `arch` match the archive name. `runner` and `library` name files in the same directory, and `sha256` maps each of the two names to its digest as 64 lowercase hexadecimal digits.

`--install <dataRoot>` unpacks the archive into a temporary directory in `<dataRoot>/runtime/`, checks both binaries against `runtime.json`, and renames the directory to `<dataRoot>/runtime/<version>/`, which replaces an earlier install of the same version.

`<out>/manifest.json` lists the archives of one runtime version by `<platform>-<arch>`:

```json
{
  "format": 1,
  "version": "4.7.2-wasd.2",
  "godot": "4.7.2-stable",
  "artifacts": {
    "darwin-arm64": {
      "url": "https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-4.7.2-wasd.2/libgodot-4.7.2-wasd.2-darwin-arm64.tar.gz",
      "bytes": 70598887,
      "sha256": "<SHA-256 digest of the archive>",
      "runner": "godot_runner",
      "library": "libgodot.macos.editor.arm64.dylib"
    }
  }
}
```

`url` is the archive's download URL in the GitHub release `libgodot-<version>` of the repository that `--repository` names (default `WASDEngine/WASD-Engine`), `bytes` is the archive size, `sha256` is the archive's digest, and `runner` and `library` name the two binaries at the archive's root. Building another platform into the same output directory adds its entry. `build.sh` stops when the existing manifest lists another runtime or Godot version.

## Test

```sh
python3 -B -m unittest discover --start-directory wasdengine/libgodot --pattern 'test_*.py'
```

`test_runner.py` compiles the runner and `stub_libgodot.c` with `cc`, so its tests run on macOS and Linux and are skipped on Windows.

To try an installed runtime on macOS, import a Godot 4.7 project once, then run it without a window; stop it with Ctrl+C:

```sh
runtime=~/.wasdengine/godot/runtime/4.7.2-wasd.2
"$runtime/godot_runner" --libgodot "$runtime/libgodot.macos.editor.arm64.dylib" -- --headless --path ~/games/my-game --import
"$runtime/godot_runner" --libgodot "$runtime/libgodot.macos.editor.arm64.dylib" -- --path ~/games/my-game --embedded --resolution 640x360
```

## Release

The LibGodot runtime workflow, [wasd-libgodot.yml](../../.github/workflows/wasd-libgodot.yml), runs only when dispatched, from the Actions tab or with `gh workflow run wasd-libgodot.yml -f version=4.7.2-wasd.2 -f godot_ref=4.7.2-stable`. Its `check` job runs `bash -n` and ShellCheck on `build.sh` and the tests in this directory.

Three `build` jobs run `build.sh` on macOS 26 (arm64), Ubuntu 24.04 (x64), and Windows Server 2022 (x64). Each restores and saves an SCons cache keyed by platform and Godot ref, installs the runtime into a directory whose name holds characters outside the Windows runner's ANSI code page, runs a headless SceneTree script from there through it as a smoke test, and uploads the archive with its one-entry `manifest.json` as a workflow artifact that is kept for seven days.

When the workflow runs on the default branch, the `release` job merges the manifests and checks every archive against the merged manifest: URL, size, digest, and the files and platform inside. It then creates the release `libgodot-<version>` as a draft at the run's commit, or moves a draft that an earlier failed run left to that commit, attaches the archives and then `manifest.json`, and publishes the release without marking it as the latest release. The job fails when the release is already published. A run on another branch stops after the builds.

The Godot plugin downloads `manifest.json` from the release of its configured runtime version, and Desktop packaging reads the same manifest to ship the runtime inside the app ([LibGodot in the Desktop app](../FORK.md#libgodot-in-the-desktop-app)); to package with a local build instead, set `WASD_LIBGODOT_DIR` to its `--out` folder. A published runtime version never changes, so publish a new one, such as `4.7.2-wasd.2`, whenever the patches, the runner, or the build options change, and update the plugin's `runtimeVersion` and `runtimeManifestUrl` defaults and `LIBGODOT_MANIFEST_URL` in `apps/desktop/scripts/wasdengine-libgodot.ts` to match.
