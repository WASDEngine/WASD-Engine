#!/usr/bin/env bash
# Build the WASD Engine LibGodot runtime for this machine's platform and
# architecture: Godot Engine compiled as a shared library (target=editor,
# library_type=shared_library) with the patches in patches/, and godot_runner,
# the executable that hosts it. The two files and their runtime.json are packed
# into <out>/libgodot-<version>-<platform>-<arch>.tar.gz, which
# <out>/manifest.json lists; --install also unpacks the archive into
# <dataRoot>/runtime/<version>/, where the Godot plugin loads it. Platform and
# architecture use Node.js names (darwin, linux, win32; arm64, x64). Runs on
# macOS, Linux, and Git Bash on Windows; BUILD.md lists the prerequisites.
#
# Usage: wasdengine/libgodot/build.sh --out <dir> [options]
#
#   --out <dir>                 output directory (required); a clone goes to <out>/godot-<ref>
#   --godot-ref <ref>           Godot tag or branch to clone (default 4.7.2-stable)
#   --source <dir>              build this Godot checkout instead of cloning; patches
#                               missing from it are applied, and it is never re-cloned or reset
#   --version <version>         runtime version (default 4.7.2-wasd.1)
#   --install <dataRoot>        install the archive into <dataRoot>/runtime/<version>/
#   --jobs <n>                  parallel SCons jobs (default: Godot's choice from the CPU count)
#   --scons-cache <dir>         SCons cache directory (Godot's cache_path option)
#   --repository <owner/name>   GitHub repository whose release libgodot-<version> hosts
#                               the archive in manifest.json (default WASDEngine/WASDEngine)
#   -h, --help                  print this help
set -euo pipefail

godot_repository_url=https://github.com/godotengine/godot.git
# The SCons release that uvx runs; Godot 4.7 needs SCons 4.4 or newer.
scons_version=4.11.1

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

log() { printf 'build.sh: %s\n' "$*" >&2; }
die() {
  printf 'build.sh: error: %s\n' "$*" >&2
  exit 1
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

cleanup_paths=()
# shellcheck disable=SC2317 # Invoked by the EXIT trap.
cleanup() {
  local path
  for path in ${cleanup_paths[@]+"${cleanup_paths[@]}"}; do
    rm -rf -- "$path"
  done
}
trap cleanup EXIT

# Prints the value of option $1 from "$@", or fails when it is missing.
option_value() {
  if [ "$#" -lt 2 ] || [ -z "$2" ]; then
    die "$1 needs a value; run with --help for usage"
  fi
  printf '%s' "$2"
}

out_dir=
godot_ref=4.7.2-stable
godot_ref_given=false
source_dir=
version=4.7.2-wasd.1
install_root=
jobs=
scons_cache=
repository=WASDEngine/WASDEngine
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out_dir=$(option_value "$@") ;;
    --godot-ref)
      godot_ref=$(option_value "$@")
      godot_ref_given=true
      ;;
    --source) source_dir=$(option_value "$@") ;;
    --version) version=$(option_value "$@") ;;
    --install) install_root=$(option_value "$@") ;;
    --jobs) jobs=$(option_value "$@") ;;
    --scons-cache) scons_cache=$(option_value "$@") ;;
    --repository) repository=$(option_value "$@") ;;
    -h | --help)
      usage
      exit 0
      ;;
    *) die "unknown argument '$1'; run with --help for usage" ;;
  esac
  shift 2
done

version_pattern='^[0-9A-Za-z][0-9A-Za-z._+-]*$'
ref_pattern='^[A-Za-z0-9][A-Za-z0-9._/-]*$'
repository_pattern='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
jobs_pattern='^[1-9][0-9]*$'
[ -n "$out_dir" ] || die "--out <dir> is required; run with --help for usage"
if [ -n "$source_dir" ] && [ "$godot_ref_given" = true ]; then
  die "pass --source or --godot-ref, not both: --source builds the checkout at whatever revision it holds"
fi
if ! [[ $version =~ $version_pattern ]] || [[ $version == *..* ]]; then
  die "invalid --version '$version': use letters, digits, '.', '_', '+', and '-', starting with a letter or digit"
fi
[[ $godot_ref =~ $ref_pattern ]] || die "invalid --godot-ref '$godot_ref'"
[[ $repository =~ $repository_pattern ]] || die "invalid --repository '$repository': use owner/name"
if [ -n "$jobs" ] && ! [[ $jobs =~ $jobs_pattern ]]; then
  die "invalid --jobs '$jobs': use a positive integer"
fi

case "$(uname -s)" in
  Darwin)
    node_platform=darwin godot_platform=macos library_suffix=dylib executable_suffix=
    ;;
  Linux)
    node_platform=linux godot_platform=linuxbsd library_suffix=so executable_suffix=
    ;;
  MINGW* | MSYS* | CYGWIN*)
    node_platform=win32 godot_platform=windows library_suffix=dll executable_suffix=.exe
    ;;
  *) die "unsupported operating system $(uname -s); build on macOS, Linux, or Git Bash on Windows" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) node_arch=arm64 godot_arch=arm64 ;;
  x86_64 | amd64) node_arch=x64 godot_arch=x86_64 ;;
  *) die "unsupported architecture $(uname -m); build on arm64 or x86_64" ;;
esac
runner_name=godot_runner$executable_suffix
# Every platform's library gets the libgodot.<platform>.editor.<arch> name; on
# Windows SCons writes godot.windows.editor.<arch>.dll without the lib prefix.
library_name=libgodot.$godot_platform.editor.$godot_arch.$library_suffix

# Prints an absolute path for native Windows programs (C:/...) and leaves POSIX paths unchanged.
native_path() {
  if [ "$node_platform" = win32 ]; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

# Creates directory $1 when missing and prints its absolute physical path.
absolute_dir() {
  mkdir -p -- "$1" || die "cannot create directory $1"
  (cd -- "$1" && pwd -P)
}

python_cmd=()
find_python() {
  local candidate
  for candidate in python3 python; do
    # The probe also rejects Python 2 and the Windows Store stub named python3.
    if command -v "$candidate" >/dev/null 2>&1 \
      && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3, 8))' >/dev/null 2>&1; then
      python_cmd=("$candidate")
      return 0
    fi
  done
  if command -v uv >/dev/null 2>&1; then
    python_cmd=(uv run --no-project --quiet python)
    return 0
  fi
  return 1
}

runtime_py() { "${python_cmd[@]}" -I "$(native_path "$script_dir/runtime.py")" "$@"; }

run_scons() {
  if command -v uvx >/dev/null 2>&1; then
    uvx --from "scons==$scons_version" scons "$@"
  else
    "${python_cmd[@]}" -m SCons "$@"
  fi
}

# Runs git inside the Godot source without finding a repository above it. In a
# plain source tree that lies inside another repository, git apply would
# otherwise skip every file of the patch and still exit with status 0.
git_in_source() {
  GIT_CEILING_DIRECTORIES=$(native_path "$(dirname "$src")") git -C "$src" "$@"
}

apply_patches() {
  local patch name
  for patch in "$script_dir"/patches/*.patch; do
    [ -f "$patch" ] || continue
    name=${patch##*/}
    if git_in_source apply --reverse --check "$patch" >/dev/null 2>&1; then
      log "patch $name is already applied"
    elif git_in_source apply --check "$patch"; then
      git_in_source apply "$patch"
      log "applied patch $name"
    else
      die "patch $name applies neither forward nor in reverse to $src; the patches are written for Godot 4.7.2-stable"
    fi
  done
}

windows_vswhere() {
  local program_files
  program_files=$(printenv 'ProgramFiles(x86)' || true)
  [ -n "$program_files" ] || program_files='C:\Program Files (x86)'
  printf '%s/Microsoft Visual Studio/Installer/vswhere.exe\n' "$(cygpath -u "$program_files")"
}

# Compiles the runner with MSVC through vcvarsall.bat in cmd.exe, whose PATH
# finds MSVC's link.exe before the link program that Git Bash ships, or with
# MinGW-w64 gcc when Visual Studio has no C++ tools. Godot's main thread needs
# an 8 MiB stack, and the runner reads its UTF-16 command line with
# CommandLineToArgvW from shell32.
compile_runner_windows() {
  local output=$1 runner_source=$2 vswhere vs_root='' vcvarsall work msvc_arch msvc_component
  case $godot_arch in
    x86_64) msvc_arch=x64 msvc_component=Microsoft.VisualStudio.Component.VC.Tools.x86.x64 ;;
    arm64) msvc_arch=arm64 msvc_component=Microsoft.VisualStudio.Component.VC.Tools.ARM64 ;;
  esac
  vswhere=$(windows_vswhere)
  if [ -f "$vswhere" ]; then
    vs_root=$("$vswhere" -latest -products '*' -requires "$msvc_component" -property installationPath | tr -d '\r') \
      || log "vswhere failed; looking for gcc instead"
  fi
  if [ -n "$vs_root" ]; then
    vcvarsall="$vs_root\\VC\\Auxiliary\\Build\\vcvarsall.bat"
    [ -f "$(cygpath -u "$vcvarsall")" ] || die "Visual Studio at $vs_root has no $vcvarsall"
    work=$(mktemp -d)
    cleanup_paths+=("$work")
    printf '@echo off\r\ncall "%s" %s >nul || exit /b 1\r\ncd /d "%s" || exit /b 1\r\ncl -nologo -std:c11 -O2 -W3 -Fe"%s" "%s" shell32.lib -link -STACK:8388608 || exit /b 1\r\n' \
      "$vcvarsall" "$msvc_arch" "$(cygpath -w "$work")" "$(cygpath -w "$output")" "$(cygpath -w "$runner_source")" >"$work/build-runner.bat"
    log "compiling $runner_name with MSVC from $vs_root"
    cmd.exe //d //c "$(cygpath -w "$work/build-runner.bat")"
  elif command -v gcc >/dev/null 2>&1; then
    log "compiling $runner_name with $(command -v gcc)"
    gcc -std=c11 -O2 -Wall -Wextra -static -o "$output" "$runner_source" -Wl,--stack,8388608 -lshell32
  else
    die "no C compiler: install Visual Studio 2022 with the Desktop development with C++ workload, or MinGW-w64 gcc"
  fi
}

compile_runner() {
  local output=$1 runner_source=$script_dir/godot_runner.c macos_minimum
  case $node_platform in
    darwin)
      # The deployment targets of Godot's own macOS builds (platform/macos/detect.py).
      # Metal's default shader language version, which Godot adopts as its
      # maximum, follows the host executable's target: macOS 27 raises it to
      # 4.1, past 4.0, the newest version Godot 4.7.2 handles.
      case $godot_arch in
        arm64) macos_minimum=11.0 ;;
        x86_64) macos_minimum=10.13 ;;
      esac
      clang -std=c11 -O2 -Wall -Wextra -arch "$godot_arch" "-mmacosx-version-min=$macos_minimum" \
        -o "$output" "$runner_source" -framework CoreFoundation -lobjc
      ;;
    linux)
      # Under -std=c11 glibc declares POSIX and BSD interfaces only with _DEFAULT_SOURCE;
      # glibc before 2.34 keeps the threads and semaphores of the parent watch in libpthread.
      cc -std=c11 -O2 -Wall -Wextra -D_DEFAULT_SOURCE -pthread -o "$output" "$runner_source" -ldl
      ;;
    win32) compile_runner_windows "$output" "$runner_source" ;;
  esac
}

find_python || die "Python 3.8 or newer is required: install it, or install uv (https://docs.astral.sh/uv/)"
if ! command -v uvx >/dev/null 2>&1 && ! "${python_cmd[@]}" -c 'import SCons' >/dev/null 2>&1; then
  die "SCons is missing: install uv (https://docs.astral.sh/uv/), or run: ${python_cmd[*]} -m pip install 'scons>=4.4'"
fi
command -v git >/dev/null 2>&1 || die "git is required"

out=$(absolute_dir "$out_dir")
if [ -n "$source_dir" ]; then
  src=$(cd -- "$source_dir" 2>/dev/null && pwd -P) || die "--source $source_dir is not a directory"
else
  src=$out/godot-${godot_ref//\//-}
  if [ -d "$src" ]; then
    log "reusing the Godot clone in $src"
  else
    partial=$src.partial
    rm -rf -- "$partial"
    cleanup_paths+=("$partial")
    log "cloning Godot $godot_ref into $src"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$godot_ref" -- "$godot_repository_url" "$partial"
    mv -- "$partial" "$src"
  fi
fi
[ -f "$src/SConstruct" ] || die "$src has no SConstruct; it is not a Godot source tree"
godot=$(runtime_py godot-version --source "$(native_path "$src")")
log "building the $node_platform-$node_arch runtime $version from Godot $godot in $src"

apply_patches

stage=$out/.stage-$node_platform-$node_arch
rm -rf -- "$stage"
mkdir -p -- "$stage"
cleanup_paths+=("$stage")
compile_runner "$stage/$runner_name"
log "compiled $runner_name"

scons_args=(
  "platform=$godot_platform" "arch=$godot_arch" target=editor library_type=shared_library
  accesskit=no debug_symbols=no
)
case $godot_platform in
  macos) scons_args+=(vulkan=no angle=no) ;;
  windows) scons_args+=(d3d12=no) ;;
esac
[ -z "$jobs" ] || scons_args+=("-j$jobs")
[ -z "$scons_cache" ] || scons_args+=("cache_path=$(native_path "$(absolute_dir "$scons_cache")")")
log "scons ${scons_args[*]}"
(cd -- "$src" && run_scons "${scons_args[@]}")

built_library=
for candidate in "libgodot.$godot_platform.editor.$godot_arch.$library_suffix" "godot.$godot_platform.editor.$godot_arch.$library_suffix"; do
  if [ -f "$src/bin/$candidate" ]; then
    built_library=$src/bin/$candidate
    break
  fi
done
[ -n "$built_library" ] || die "SCons finished, but $src/bin holds no $library_name"
cp -- "$built_library" "$stage/$library_name"

if [ "$node_platform" = darwin ]; then
  codesign --force --sign - "$stage/$runner_name" "$stage/$library_name"
  log "signed $runner_name and $library_name ad hoc"
fi

archive=$(runtime_py package --stage "$(native_path "$stage")" --out "$(native_path "$out")" \
  --version "$version" --godot "$godot" --platform "$node_platform" --arch "$node_arch" \
  --runner "$runner_name" --library "$library_name" --repository "$repository")

if [ -n "$install_root" ]; then
  installed=$(runtime_py install --archive "$archive" --data-root "$(native_path "$(absolute_dir "$install_root")")" --version "$version")
  log "installed the runtime into $installed"
fi
log "done: $archive"
