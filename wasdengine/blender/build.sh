#!/usr/bin/env bash
# Build a WASD Engine Blender runtime: CPython from python-build-standalone
# with Blender's bpy module and the packages bpy requires installed from the
# wheels that requirements-<target>.txt pins, without pip, Tk, IDLE, headers,
# scripts, and bytecode caches. The runtime and its runtime.json are packed into
# <out>/blender-<version>-<target>.tar.gz, which <out>/manifest.json lists;
# --install also unpacks the archive into <root>/<target>/, the layout the
# Blender plugin reads from its package's runtime folder. The darwin-arm64
# runtime builds on macOS on Apple silicon only; the win32-x64 runtime builds on
# any computer, and smoke.py tests it only where it runs, on Windows. BUILD.md
# describes the layouts and why other platforms use uv or an installed Blender.
#
# Usage: wasdengine/blender/build.sh --out <dir> [options]
#
#   --out <dir>                 output directory (required); the Python archive, the wheels, and the stage go under it
#   --target <target>           darwin-arm64 (default) or win32-x64
#   --version <version>         runtime version (default 5.2.3-wasd.1)
#   --install <root>            install the archive into <root>/<target>/, such as
#                               packages/gamedev/blender/runtime
#   --repository <owner/name>   GitHub repository whose release blender-<version> hosts
#                               the archive in manifest.json (default WASDEngine/WASD-Engine)
#   -h, --help                  print this help
set -euo pipefail

# CPython from python-build-standalone and the SHA-256 digests of its archives from the release's asset digests,
# https://github.com/astral-sh/python-build-standalone/releases/tag/20261026.
python_version=3.13.18
python_release=20261026
python_url_base=https://github.com/astral-sh/python-build-standalone/releases/download/$python_release
darwin_arm64_python_sha256=8392b6ea51d94391befb2c31ebe75463f045d0b69dfcf5e1bb3234e1f5fa3405
win32_x64_python_sha256=7369f7a35f261222a6ac8b3a87c1c88eeebee8af945d85346202591a64038dd3
# The bpy version that the requirements files pin, and the tag and commit of the same Blender in Blender's source
# repository, which SOURCE.txt names.
bpy_version=5.2.3
blender_commit=e13b728c6880d3084d9d57c30031ed5df8b39dee
# The oldest macOS that the Desktop app supports (its LSMinimumSystemVersion); every program and library must run on it.
minimum_macos=13.0

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
key=darwin-arm64
version=5.2.3-wasd.1
install_root=
repository=WASDEngine/WASD-Engine
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out_dir=$(option_value "$@") ;;
    --target) key=$(option_value "$@") ;;
    --version) version=$(option_value "$@") ;;
    --install) install_root=$(option_value "$@") ;;
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
repository_pattern='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
[ -n "$out_dir" ] || die "--out <dir> is required; run with --help for usage"
if ! [[ $version =~ $version_pattern ]] || [[ $version == *..* ]]; then
  die "invalid --version '$version': use letters, digits, '.', '_', '+', and '-', starting with a letter or digit"
fi
[[ $repository =~ $repository_pattern ]] || die "invalid --repository '$repository': use owner/name"

# Each target's Python archive, program, and folders. native says whether this computer runs the target's Python, which
# pip check and the smoke test need.
host=$(uname -s)-$(uname -m)
case "$key" in
  darwin-arm64)
    [ "$host" = Darwin-arm64 ] || die "the darwin-arm64 runtime is built on macOS on Apple silicon, which checks its Mach-O files"
    platform=darwin arch=arm64 triple=aarch64-apple-darwin python_sha256=$darwin_arm64_python_sha256
    executable=python/bin/python${python_version%.*}
    library=python/lib/python${python_version%.*}
    native=1
    ;;
  win32-x64)
    platform=win32 arch=x64 triple=x86_64-pc-windows-msvc python_sha256=$win32_x64_python_sha256
    executable=python/python.exe
    library=python/Lib
    case "$host" in
      MINGW*-x86_64 | MSYS*-x86_64 | CYGWIN*-x86_64) native=1 ;;
      *) native=0 ;;
    esac
    ;;
  *) die "unknown --target '$key': use darwin-arm64 or win32-x64" ;;
esac
python_name=cpython-$python_version+$python_release-$triple-install_only_stripped.tar.gz
python_url=$python_url_base/cpython-$python_version%2B$python_release-$triple-install_only_stripped.tar.gz

# Creates directory $1 when missing and prints its absolute physical path.
absolute_dir() {
  mkdir -p -- "$1" || die "cannot create directory $1"
  (cd -- "$1" && pwd -P)
}

tools=(curl tar)
if [ "$platform" = darwin ]; then
  tools+=(codesign otool xargs)
fi
for tool in "${tools[@]}"; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required; on macOS, install the Xcode Command Line Tools"
done
command -v python3 >/dev/null 2>&1 || die "Python 3.8 or newer is required"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || die "Python 3.8 or newer is required"
runtime_py() { python3 -I "$script_dir/runtime.py" "$@"; }
sha256_of() { python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; }

out=$(absolute_dir "$out_dir")

archive=$out/$python_name
if [ -f "$archive" ] && [ "$(sha256_of "$archive")" = "$python_sha256" ]; then
  log "reusing $archive"
else
  cleanup_paths+=("$archive.partial")
  log "downloading $python_url"
  curl --fail --location --silent --show-error --output "$archive.partial" "$python_url"
  mv -- "$archive.partial" "$archive"
fi
actual=$(sha256_of "$archive")
[ "$actual" = "$python_sha256" ] || die "$archive has SHA-256 $actual, not $python_sha256 of $python_name"

stage=$out/.stage-$key
rm -rf -- "$stage"
mkdir -p -- "$stage"
cleanup_paths+=("$stage")
log "unpacking Python $python_version for $key"
tar -xzf "$archive" -C "$stage"
[ -f "$stage/$executable" ] || die "$archive holds no $executable"
# Archives record the program's mode; Windows ignores it, but the runtime archive marks the program executable.
chmod 755 "$stage/$executable"
if [ "$native" = 1 ]; then
  reported=$("$stage/$executable" -I -B -c 'import platform; print(platform.python_version())')
  [ "$reported" = "$python_version" ] || die "$archive holds Python $reported, not $python_version"
fi

log "installing bpy $bpy_version and the packages it requires"
runtime_py install-wheels --requirements "$script_dir/requirements-$key.txt" --cache "$out/wheels" --site-packages "$stage/$library/site-packages"
if [ "$native" = 1 ]; then
  # pip, which the Python archive brings and prepare removes, confirms that the wheels satisfy each other's requirements.
  "$stage/$executable" -I -B -m pip check --isolated --disable-pip-version-check
fi

bpy=$(runtime_py prepare --installation "$stage/python")
[ "$bpy" = "$bpy_version" ] || die "requirements-$key.txt installed bpy $bpy, not $bpy_version"

if [ "$platform" = darwin ]; then
  # The wheels and the Python archive carry ad hoc signatures, which prepare leaves alone; macOS refuses arm64 code
  # without a valid one, and Desktop packaging signs every Mach-O file again with the release identity.
  log "checking the signatures and libraries of the Mach-O files"
  runtime_py macho-files --stage "$stage" | xargs -0 -n 64 codesign --verify --strict
  runtime_py check-binaries --runtime "$stage" --minimum-macos "$minimum_macos"
fi

cp -- "$script_dir/../../LICENSE" "$stage/COPYING"
# python-build-standalone keeps the license beside the standard library on macOS and beside python.exe on Windows.
python_license=$library/LICENSE.txt
if [ "$platform" = win32 ]; then
  python_license=python/LICENSE.txt
fi
cat >"$stage/SOURCE.txt" <<EOF
Blender $bpy_version as the bpy Python module for $key, with Python $python_version, packaged for WASD Engine as runtime
$version.

Blender is free software under the GNU General Public License, version 3 or later; COPYING holds the license. The
libraries that the bpy module ships are under their own free licenses. Python is under the Python Software Foundation
License, which $python_license holds, and the other Python packages carry their licenses in their .dist-info
folders under $library/site-packages.

The runtime is CPython $python_version as python-build-standalone builds it, $python_url
(SHA-256 $python_sha256), with the wheels of PyPI that wasdengine/blender/requirements-$key.txt of
https://github.com/$repository pins by SHA-256 installed into it. wasdengine/blender/build.sh of the same repository
removes files that the Blender tools do not use and changes no other file.

Corresponding source: Blender $bpy_version, the tag v$bpy_version (commit $blender_commit) of
https://projects.blender.org/blender/blender, also published as https://download.blender.org/source/blender-$bpy_version.tar.xz;
Python $python_version, https://www.python.org/ftp/python/$python_version/Python-$python_version.tar.xz, built by the
recipes of https://github.com/astral-sh/python-build-standalone/tree/$python_release; and the source distributions that
PyPI publishes beside each pinned wheel, at https://pypi.org/project/<name>/<version>/#files.
EOF

if [ "$native" = 1 ]; then
  log "smoke-testing the staged runtime"
  python3 -I "$script_dir/smoke.py" --runtime "$stage" --work "$out/.smoke-$key" --executable "$executable" --bpy "$bpy"
  cleanup_paths+=("$out/.smoke-$key")
else
  log "not smoke-testing the $key runtime, which this computer cannot run; smoke.py tests it on $platform"
fi

archive=$(runtime_py package --stage "$stage" --out "$out" --version "$version" --bpy "$bpy" --python "$python_version" \
  --platform "$platform" --arch "$arch" --executable "$executable" --repository "$repository")

if [ -n "$install_root" ]; then
  installed=$(runtime_py install --archive "$archive" --root "$(absolute_dir "$install_root")" --version "$version")
  log "installed the runtime into $installed"
fi
log "done: $archive"
