#!/usr/bin/env bash
# Build WASD Engine's Godot Web export template: Godot Engine's single-threaded
# Web release build (platform=web target=template_release threads=no, the
# web_nothreads_release.zip of Godot's own export templates) compiled with the
# Emscripten release that Godot's own build uses and the patches in patches/.
# Writes <out>/web_nothreads_release.zip, the template that a Web export packs
# with a game; <out>/web-template-<version>.tpz, the export templates archive
# that holds it as templates/web_nothreads_release.zip, from which the Godot
# plugin downloads it; and <out>/manifest.json, which names both with their
# SHA-256 digests. Runs on macOS and Linux; BUILD.md lists the prerequisites.
#
# Usage: wasdengine/web-template/build.sh --out <dir> [options]
#
#   --out <dir>                 output directory (required); a Godot clone goes to <out>/godot-<ref>
#                               and Emscripten to <out>/emsdk
#   --godot-ref <ref>           Godot tag or branch to clone (default 4.7.2-stable)
#   --source <dir>              build this Godot checkout instead of cloning; patches
#                               missing from it are applied, and it is never re-cloned or reset
#   --emsdk <dir>               use this emsdk checkout, with Emscripten 4.0.20 installed,
#                               instead of installing one into <out>/emsdk
#   --version <version>         template version (default 4.7.2-wasd.2)
#   --jobs <n>                  parallel SCons jobs (default: Godot's choice from the CPU count)
#   --scons-cache <dir>         SCons cache directory (Godot's cache_path option)
#   --repository <owner/name>   GitHub repository whose release web-template-<version> hosts
#                               the archive in manifest.json (default WASDEngine/WASD-Engine)
#   -h, --help                  print this help
set -euo pipefail

godot_repository_url=https://github.com/godotengine/godot.git
emsdk_repository_url=https://github.com/emscripten-core/emsdk.git
# The Emscripten release of Godot 4.7.2's own Web templates, whose page logs "Emscripten 4.0.20";
# emsdk tags each Emscripten release with its version.
emscripten_version=4.0.20
# The SCons release that uvx runs, under this uv-managed CPython release, so that the data
# that Godot's build scripts compress with zlib come out alike everywhere. The uv release
# picks the build of that CPython it downloads; uv 0.13.8 and CPython 3.13.18 built the
# published templates, and the release workflow pins both.
scons_version=4.11.1
scons_python=3.13.18
uv_version=0.13.8
# The build name in the engine's version string, "4.7.2.stable.wasd", where Godot's own builds say "official".
build_name=wasd

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
emsdk_dir=
version=4.7.2-wasd.2
jobs=
scons_cache=
repository=WASDEngine/WASD-Engine
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out_dir=$(option_value "$@") ;;
    --godot-ref)
      godot_ref=$(option_value "$@")
      godot_ref_given=true
      ;;
    --source) source_dir=$(option_value "$@") ;;
    --emsdk) emsdk_dir=$(option_value "$@") ;;
    --version) version=$(option_value "$@") ;;
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
  Darwin | Linux) ;;
  *) die "unsupported operating system $(uname -s); build on macOS or Linux" ;;
esac

command -v git >/dev/null 2>&1 || die "git is required"
command -v uvx >/dev/null 2>&1 || die "uv is required: install it from https://docs.astral.sh/uv/"
command -v python3 >/dev/null 2>&1 || die "python3 (3.8 or newer) is required"
uv_installed=$(uvx --version 2>/dev/null | awk '{ print $2 }') || uv_installed=unknown
if [ "$uv_installed" != "$uv_version" ]; then
  log "uv $uv_installed is installed, not uv $uv_version, which built the published templates; this template's digest may differ from theirs"
fi

template_py() { python3 -I "$script_dir/template.py" "$@"; }

# Creates directory $1 when missing and prints its absolute physical path.
absolute_dir() {
  mkdir -p -- "$1" || die "cannot create directory $1"
  (cd -- "$1" && pwd -P)
}

# Runs git inside the Godot source without finding a repository above it. In a
# plain source tree that lies inside another repository, git apply would
# otherwise skip every file of the patch and still exit with status 0.
git_in_source() {
  GIT_CEILING_DIRECTORIES=$(dirname "$src") git -C "$src" "$@"
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

# Installs and activates Emscripten $emscripten_version in an emsdk clone at $1.
install_emsdk() {
  local dir=$1 partial
  if [ ! -x "$dir/emsdk" ]; then
    partial=$dir.partial
    rm -rf -- "$partial"
    cleanup_paths+=("$partial")
    log "cloning emsdk $emscripten_version into $dir"
    git -c advice.detachedHead=false clone --quiet --depth 1 --branch "$emscripten_version" -- "$emsdk_repository_url" "$partial"
    mv -- "$partial" "$dir"
  fi
  (cd -- "$dir" && ./emsdk install "$emscripten_version" >&2 && ./emsdk activate "$emscripten_version" >&2)
}

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
godot=$(template_py godot-version --source "$src")

if [ -n "$emsdk_dir" ]; then
  emsdk=$(cd -- "$emsdk_dir" 2>/dev/null && pwd -P) || die "--emsdk $emsdk_dir is not a directory"
  [ -f "$emsdk/emsdk_env.sh" ] || die "$emsdk has no emsdk_env.sh; it is not an emsdk checkout"
else
  emsdk=$out/emsdk
  install_emsdk "$emsdk"
fi
# shellcheck source=/dev/null # emsdk_env.sh comes from the emsdk checkout.
source "$emsdk/emsdk_env.sh" >/dev/null 2>&1 || die "cannot load the Emscripten environment from $emsdk/emsdk_env.sh"
emcc_version=$(emcc --version 2>/dev/null | head -n 1) || die "emcc does not run from $emsdk"
case "$emcc_version" in
  *" $emscripten_version "*) ;;
  *) die "emcc from $emsdk reports '$emcc_version'; the template needs Emscripten $emscripten_version (run: $emsdk/emsdk install $emscripten_version && $emsdk/emsdk activate $emscripten_version)" ;;
esac
log "building the Web template $version from Godot $godot in $src with Emscripten $emscripten_version"

apply_patches

scons_args=(platform=web target=template_release threads=no production=yes)
[ -z "$jobs" ] || scons_args+=("-j$jobs")
[ -z "$scons_cache" ] || scons_args+=("cache_path=$(absolute_dir "$scons_cache")")
log "scons ${scons_args[*]}"
(cd -- "$src" && BUILD_NAME=$build_name uvx --managed-python --python "$scons_python" --from "scons==$scons_version" scons "${scons_args[@]}")

built=$src/bin/godot.web.template_release.wasm32.nothreads.zip
[ -f "$built" ] || die "SCons finished, but $built is missing"
archive=$(template_py package --zip "$built" --out "$out" --version "$version" --godot "$godot" \
  --emscripten "$emscripten_version" --repository "$repository")
log "done: $archive"
