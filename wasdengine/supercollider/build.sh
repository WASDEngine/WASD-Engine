#!/usr/bin/env bash
# Build the WASD Engine SuperCollider runtime for this machine's platform and
# architecture: sclang without Qt, scsynth, and the UGen plugins of
# SuperCollider 3.14.1, statically linked against libsndfile with its FLAC,
# Ogg Vorbis, and Opus codecs (and on Linux FFTW), plus the class library and
# the class help files. The runtime and its runtime.json are packed into
# <out>/supercollider-<version>-<platform>-<arch>.tar.gz, which
# <out>/manifest.json lists; --install also unpacks the archive into
# <root>/<platform>-<arch>/, the layout the SuperCollider plugin reads from its
# package's runtime folder. Platform and architecture use Node.js names
# (darwin, linux; arm64, x64). Runs on macOS and Linux; BUILD.md lists the
# prerequisites.
#
# Usage: wasdengine/supercollider/build.sh --out <dir> [options]
#
#   --out <dir>                 output directory (required); the source, vcpkg, and build trees go under it
#   --source <dir>              build this SuperCollider source tree instead of the verified 3.14.1 release tarball
#   --version <version>         runtime version (default 3.14.1-wasd.1)
#   --install <root>            install the archive into <root>/<platform>-<arch>/, such as
#                               packages/gamedev/supercollider/runtime
#   --jobs <n>                  parallel compile jobs (default: the CPU count)
#   --vcpkg <dir>               use this vcpkg checkout instead of cloning the pinned commit into <out>/vcpkg
#   --repository <owner/name>   GitHub repository whose release supercollider-<version> hosts
#                               the archive in manifest.json (default WASDEngine/WASD-Engine)
#   -h, --help                  print this help
set -euo pipefail

# SuperCollider's release tarball and its SHA-256, which the build checks before it extracts anything.
source_url=https://github.com/supercollider/supercollider/releases/download/Version-3.14.1/SuperCollider-3.14.1-Source.tar.bz2
source_sha256=ee640c68777ae697682066ce5c4a8b7e56c5b223e76c79c13b5be5387ee55bb2
# The vcpkg commit whose ports build libsndfile 1.2.2, its codecs, and FFTW 3.3.11.
vcpkg_repository_url=https://github.com/microsoft/vcpkg.git
vcpkg_commit=65886d79ccce671dc24ffbf9a348836beacb7f6f
# macOS release the binaries run on; the deployment target of SuperCollider's own arm64 builds.
macos_minimum=11.0

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
source_dir=
version=3.14.1-wasd.1
install_root=
jobs=
vcpkg_dir=
repository=WASDEngine/WASD-Engine
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out_dir=$(option_value "$@") ;;
    --source) source_dir=$(option_value "$@") ;;
    --version) version=$(option_value "$@") ;;
    --install) install_root=$(option_value "$@") ;;
    --jobs) jobs=$(option_value "$@") ;;
    --vcpkg) vcpkg_dir=$(option_value "$@") ;;
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
jobs_pattern='^[1-9][0-9]*$'
[ -n "$out_dir" ] || die "--out <dir> is required; run with --help for usage"
if ! [[ $version =~ $version_pattern ]] || [[ $version == *..* ]]; then
  die "invalid --version '$version': use letters, digits, '.', '_', '+', and '-', starting with a letter or digit"
fi
[[ $repository =~ $repository_pattern ]] || die "invalid --repository '$repository': use owner/name"
if [ -n "$jobs" ] && ! [[ $jobs =~ $jobs_pattern ]]; then
  die "invalid --jobs '$jobs': use a positive integer"
fi

case "$(uname -s)" in
  Darwin) node_platform=darwin vcpkg_system=osx plugin_suffix=scx static_notice= ;;
  Linux) node_platform=linux vcpkg_system=linux plugin_suffix=so static_notice=', and FFTW (GPL-2.0-or-later)' ;;
  *) die "unsupported operating system $(uname -s); build on macOS or Linux (BUILD.md explains why Windows is not built yet)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) node_arch=arm64 ;;
  x86_64 | amd64) node_arch=x64 ;;
  *) die "unsupported architecture $(uname -m); build on arm64 or x86_64" ;;
esac
key=$node_platform-$node_arch
triplet=wasd-$node_arch-$vcpkg_system

# Creates directory $1 when missing and prints its absolute physical path.
absolute_dir() {
  mkdir -p -- "$1" || die "cannot create directory $1"
  (cd -- "$1" && pwd -P)
}

command -v git >/dev/null 2>&1 || die "git is required"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v python3 >/dev/null 2>&1 || die "Python 3.8 or newer is required"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || die "Python 3.8 or newer is required"
case $node_platform in
  darwin) command -v clang++ >/dev/null 2>&1 || die "clang++ is required: install the Xcode Command Line Tools" ;;
  linux) command -v g++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1 || die "a C++ compiler is required: install g++" ;;
esac
runtime_py() { python3 -I "$script_dir/runtime.py" "$@"; }

out=$(absolute_dir "$out_dir")

# CMake, Ninja, and pkg-config come from PATH, or from a virtual environment in
# <out>/.tools that uv fills from PyPI; vcpkg also needs pkg-config for its ports.
tools=$out/.tools/bin
if ! command -v cmake >/dev/null 2>&1 || ! command -v ninja >/dev/null 2>&1 || ! command -v pkg-config >/dev/null 2>&1; then
  if [ ! -x "$tools/cmake" ] || [ ! -x "$tools/ninja" ] || [ ! -x "$tools/pkg-config" ]; then
    command -v uv >/dev/null 2>&1 || die "CMake, Ninja, and pkg-config are required: install them, or install uv (https://docs.astral.sh/uv/)"
    log "installing CMake, Ninja, and pkgconf into $out/.tools"
    uv venv --quiet --allow-existing "$out/.tools"
    uv pip install --quiet --python "$tools/python" 'cmake>=3.25,<5' 'ninja>=1.11' 'pkgconf>=2'
  fi
  export PATH="$tools:$PATH"
fi
PKG_CONFIG=$(command -v pkg-config)
export PKG_CONFIG

if [ -n "$source_dir" ]; then
  src=$(cd -- "$source_dir" 2>/dev/null && pwd -P) || die "--source $source_dir is not a directory"
else
  src=$out/SuperCollider-3.14.1-Source
  if [ -d "$src" ]; then
    log "reusing the SuperCollider source in $src"
  else
    tarball=$out/SuperCollider-3.14.1-Source.tar.bz2
    partial=$out/.source.partial
    rm -rf -- "$partial"
    cleanup_paths+=("$partial" "$tarball.partial")
    log "downloading $source_url"
    curl --fail --location --silent --show-error --output "$tarball.partial" "$source_url"
    actual=$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$tarball.partial")
    [ "$actual" = "$source_sha256" ] || die "$source_url has SHA-256 $actual, not $source_sha256"
    mv -- "$tarball.partial" "$tarball"
    mkdir -p -- "$partial"
    tar -xjf "$tarball" -C "$partial"
    mv -- "$partial/SuperCollider-3.14.1-Source" "$src"
  fi
fi
[ -f "$src/SCVersion.txt" ] && [ -d "$src/SCClassLibrary" ] || die "$src is not a SuperCollider source tree"
# scsynth cuts each folder of its plugin path (-U and SC_PLUGIN_PATH) at SC_MAX_TOKEN_LENGTH - 1 bytes, 255 in
# SuperCollider 3.14.1, which loses every UGen of a runtime inside a deeply nested folder; the plugin passes -U.
string_parser=$src/common/SC_StringParser.h
if grep -q '^#define SC_MAX_TOKEN_LENGTH 256$' "$string_parser"; then
  sed -i.orig 's/^#define SC_MAX_TOKEN_LENGTH 256$/#define SC_MAX_TOKEN_LENGTH 4096/' "$string_parser"
  rm -f -- "$string_parser.orig"
  log "raised SC_MAX_TOKEN_LENGTH in $string_parser to 4096"
elif ! grep -q '^#define SC_MAX_TOKEN_LENGTH 4096$' "$string_parser"; then
  die "$string_parser defines no SC_MAX_TOKEN_LENGTH of 256 or 4096; the build expects SuperCollider 3.14.1"
fi
supercollider=$(runtime_py supercollider-version --source "$src")
log "building the $key runtime $version from SuperCollider $supercollider in $src"

if [ -z "$vcpkg_dir" ]; then
  vcpkg_dir=$out/vcpkg
  if [ ! -x "$vcpkg_dir/vcpkg" ]; then
    rm -rf -- "$vcpkg_dir"
    log "cloning vcpkg $vcpkg_commit into $vcpkg_dir"
    git init --quiet "$vcpkg_dir"
    git -C "$vcpkg_dir" fetch --quiet --depth 1 "$vcpkg_repository_url" "$vcpkg_commit"
    git -C "$vcpkg_dir" -c advice.detachedHead=false checkout --quiet FETCH_HEAD
    "$vcpkg_dir/bootstrap-vcpkg.sh" -disableMetrics >&2
  fi
fi
vcpkg_dir=$(cd -- "$vcpkg_dir" && pwd -P)
[ -x "$vcpkg_dir/vcpkg" ] || die "$vcpkg_dir has no bootstrapped vcpkg"
ports=('libsndfile[core,external-libs]')
[ "$node_platform" = linux ] && ports+=('fftw3')
mkdir -p -- "$out/vcpkg-cache"
log "vcpkg install ${ports[*]} --triplet $triplet"
VCPKG_DEFAULT_BINARY_CACHE=$out/vcpkg-cache "$vcpkg_dir/vcpkg" install "${ports[@]}" --triplet "$triplet" \
  --overlay-triplets "$script_dir/triplets" --x-install-root "$out/vcpkg-installed" --disable-metrics >&2
deps=$out/vcpkg-installed/$triplet
# Static archives in dependency order, which the GNU linker needs.
sndfile_libraries="$deps/lib/libsndfile.a;$deps/lib/libvorbisenc.a;$deps/lib/libvorbisfile.a;$deps/lib/libvorbis.a"
sndfile_libraries+=";$deps/lib/libFLAC.a;$deps/lib/libopus.a;$deps/lib/libogg.a"

build=$out/build-$key
cmake_args=(
  -S "$src" -B "$build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$build/install"
  -DSC_QT=OFF -DSC_IDE=OFF -DSUPERNOVA=OFF -DSC_EL=OFF -DSC_VIM=OFF -DSC_HIDAPI=OFF -DSC_ABLETON_LINK=OFF
  -DNO_AVAHI=ON -DNO_X11=ON -DINSTALL_HELP=OFF -DENABLE_TESTSUITE=OFF -DSC_DOC_RENDER=OFF -DLIBSCSYNTH=OFF
  -DUSE_CCACHE=OFF -DCMAKE_DISABLE_FIND_PACKAGE_Readline=ON
  -DSNDFILE_INCLUDE_DIR="$deps/include" -DSNDFILE_LIBRARY="$sndfile_libraries"
)
case $node_platform in
  darwin)
    cmake_args+=(-DCMAKE_OSX_ARCHITECTURES="$(uname -m)" -DCMAKE_OSX_DEPLOYMENT_TARGET="$macos_minimum")
    ;;
  linux)
    # PortAudio from SuperCollider's own source tree, over ALSA, keeps JACK out of the runtime's
    # dependencies; offline renders use no audio device. libstdc++ and libgcc link statically, so the
    # runtime needs only the C library and ALSA of the machine that runs it.
    cmake_args+=(
      -DAUDIOAPI=portaudio -DSYSTEM_PORTAUDIO=OFF
      -DFFTW3F_INCLUDE_DIR="$deps/include" -DFFTW3F_LIBRARY="$deps/lib/libfftw3f.a"
      -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc"
      -DCMAKE_MODULE_LINKER_FLAGS="-static-libstdc++ -static-libgcc"
      -DCMAKE_SHARED_LINKER_FLAGS="-static-libstdc++ -static-libgcc"
    )
    ;;
esac
log "cmake ${cmake_args[*]}"
cmake "${cmake_args[@]}" >&2
build_args=(--build "$build")
[ -z "$jobs" ] || build_args+=(--parallel "$jobs")
cmake "${build_args[@]}" >&2

stage=$out/.stage-$key
rm -rf -- "$stage"
mkdir -p -- "$stage/plugins" "$stage/HelpSource/Classes"
cleanup_paths+=("$stage")
cp -- "$build/lang/sclang" "$build/server/scsynth/scsynth" "$stage/"
cp -- "$build"/server/plugins/*."$plugin_suffix" "$stage/plugins/"
# The class library without its Qt GUI folders and without Ableton Link, which this build leaves
# out, as SuperCollider's own install rules leave them out of builds without Qt or Link.
(cd -- "$src" && find SCClassLibrary \( -type d \( -name GUI -o -name Ableton \) -prune \) -o \
  \( -type f ! -name '*~' ! -name '*#' ! -name '.*' -print \)) >"$out/.class-library-files"
cleanup_paths+=("$out/.class-library-files")
(cd -- "$src" && tar -cf - -T "$out/.class-library-files") | tar -xf - -C "$stage"
cp -- "$src"/HelpSource/Classes/*.schelp "$stage/HelpSource/Classes/"
cp -- "$src/COPYING" "$stage/COPYING"
cat >"$stage/SOURCE.txt" <<EOF
SuperCollider $supercollider, built without Qt for WASD Engine as runtime $version ($key).

SuperCollider is free software under the GNU General Public License, version 3 or later; COPYING holds the license.
The programs statically include libsndfile (LGPL-2.1-or-later), FLAC, Ogg, Vorbis, and Opus (BSD-3-Clause)$static_notice.

Corresponding source: $source_url (SHA-256 $source_sha256),
built by wasdengine/supercollider/build.sh of https://github.com/$repository with the vcpkg ports of
https://github.com/microsoft/vcpkg/tree/$vcpkg_commit.

WASD Engine modified the source on 2026-11-06: build.sh sets SC_MAX_TOKEN_LENGTH in common/SC_StringParser.h to 4096
instead of 256, so scsynth reads plugin folders whose paths are longer than 255 bytes.
EOF

case $node_platform in
  darwin)
    strip -x "$stage/sclang" "$stage/scsynth" "$stage"/plugins/*.scx
    # Every load command must name a system library: nothing from Homebrew, vcpkg, or the build tree.
    for binary in "$stage/sclang" "$stage/scsynth" "$stage"/plugins/*.scx; do
      foreign=$(otool -L "$binary" | tail -n +2 | awk '{ print $1 }' | grep -Ev '^(/usr/lib/|/System/Library/)' || true)
      [ -z "$foreign" ] || die "$binary links libraries outside the system: $foreign"
      if otool -l "$binary" | grep -q LC_RPATH; then die "$binary has an rpath"; fi
    done
    codesign --force --sign - "$stage/sclang" "$stage/scsynth" "$stage"/plugins/*.scx
    log "stripped and signed sclang, scsynth, and $(find "$stage/plugins" -name '*.scx' | wc -l | tr -d ' ') plugins ad hoc"
    ;;
  linux)
    strip --strip-unneeded "$stage/sclang" "$stage/scsynth" "$stage"/plugins/*.so
    # NEEDED entries may name only the C library family and ALSA, which every desktop Linux has.
    for binary in "$stage/sclang" "$stage/scsynth" "$stage"/plugins/*.so; do
      foreign=$(readelf -d "$binary" | awk '/\(NEEDED\)/ { gsub(/[][]/, "", $5); print $5 }' \
        | grep -Ev '^(libc|libm|libmvec|libpthread|libdl|librt|libasound)\.so\.[0-9]+$|^ld-linux[-a-z0-9_.]*\.so\.[0-9]+$' || true)
      [ -z "$foreign" ] || die "$binary needs libraries outside the allowed system set: $foreign"
      if readelf -d "$binary" | grep -Eq '\((RPATH|RUNPATH)\)'; then die "$binary has an rpath"; fi
    done
    log "stripped sclang, scsynth, and $(find "$stage/plugins" -name '*.so' | wc -l | tr -d ' ') plugins"
    ;;
esac

log "smoke-testing the staged runtime"
python3 -I "$script_dir/smoke.py" --runtime "$stage" --work "$out/.smoke-$key"

archive=$(runtime_py package --stage "$stage" --out "$out" --version "$version" --supercollider "$supercollider" \
  --platform "$node_platform" --arch "$node_arch" --sclang sclang --scsynth scsynth --repository "$repository")

if [ -n "$install_root" ]; then
  installed=$(runtime_py install --archive "$archive" --root "$(absolute_dir "$install_root")" --version "$version")
  log "installed the runtime into $installed"
fi
log "done: $archive"
