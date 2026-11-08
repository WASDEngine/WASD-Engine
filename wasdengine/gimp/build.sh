#!/usr/bin/env bash
# Build the WASD Engine GIMP runtime for this Mac's architecture from GIMP's
# official macOS application: gimp-console with GIMP's libraries, plug-ins,
# data, and Python, without the GUI program, debug symbols, headers,
# translations, GUI icons, and build tools. The runtime and its runtime.json are
# packed into <out>/gimp-<version>-darwin-<arch>.tar.gz, which
# <out>/manifest.json lists; --install also unpacks the archive into
# <root>/darwin-<arch>/, the layout the GIMP plugin reads from its package's
# runtime folder. Runs on macOS only; BUILD.md describes the layout and why Linux
# and Windows use an installed GIMP.
#
# Usage: wasdengine/gimp/build.sh --out <dir> [options]
#
#   --out <dir>                 output directory (required); the disk image and the stage go under it
#   --dmg <file>                use this GIMP disk image instead of downloading it; it must match the pinned SHA-256
#   --version <version>         runtime version (default 3.2.8-wasd.1)
#   --install <root>            install the archive into <root>/darwin-<arch>/, such as
#                               packages/gamedev/gimp/runtime
#   --repository <owner/name>   GitHub repository whose release gimp-<version> hosts
#                               the archive in manifest.json (default WASDEngine/WASDEngine)
#   -h, --help                  print this help
set -euo pipefail

# GIMP's macOS disk images and their SHA-256, from https://download.gimp.org/gimp/v3.2/macos/SHA256SUMS.
gimp_version=3.2.8
dmg_base_url=https://download.gimp.org/gimp/v3.2/macos
arm64_sha256=06404a375106b7613ba3a14c7d8d9a7cbe18b9b9e2b2050bb72f3162cbcfc395
x86_64_sha256=7746487985d7143b190692500b58d5317b6ce916a60f8139a76df5eea1e920db
# The source release of the same GIMP, from https://download.gimp.org/gimp/v3.2/SHA256SUMS, which SOURCE.txt names.
source_url=https://download.gimp.org/gimp/v3.2/gimp-3.2.8.tar.xz
source_sha256=16a2696cadc9e03a2ef97ccb895e062f654cb2b8211fb57074db85f26646c847

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)

log() { printf 'build.sh: %s\n' "$*" >&2; }
die() {
  printf 'build.sh: error: %s\n' "$*" >&2
  exit 1
}
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"; }

cleanup_paths=()
mounts=()
# shellcheck disable=SC2317 # Invoked by the EXIT trap.
cleanup() {
  local path
  for path in ${mounts[@]+"${mounts[@]}"}; do
    hdiutil detach -quiet "$path" 2>/dev/null || hdiutil detach -force -quiet "$path" 2>/dev/null || true
  done
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
dmg=
version=3.2.8-wasd.1
install_root=
repository=WASDEngine/WASDEngine
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) out_dir=$(option_value "$@") ;;
    --dmg) dmg=$(option_value "$@") ;;
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

[ "$(uname -s)" = Darwin ] || die "the GIMP runtime is built from GIMP's macOS application on macOS; BUILD.md explains why Linux and Windows use an installed GIMP"
case "$(uname -m)" in
  arm64) node_arch=arm64 dmg_arch=arm64 dmg_sha256=$arm64_sha256 ;;
  x86_64) node_arch=x64 dmg_arch=x86_64 dmg_sha256=$x86_64_sha256 ;;
  *) die "unsupported architecture $(uname -m); build on arm64 or x86_64" ;;
esac
key=darwin-$node_arch
dmg_name=gimp-$gimp_version-$dmg_arch.dmg
dmg_url=$dmg_base_url/$dmg_name

# Creates directory $1 when missing and prints its absolute physical path.
absolute_dir() {
  mkdir -p -- "$1" || die "cannot create directory $1"
  (cd -- "$1" && pwd -P)
}

for tool in curl hdiutil ditto codesign otool xattr xargs; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is required: install the Xcode Command Line Tools"
done
command -v python3 >/dev/null 2>&1 || die "Python 3.8 or newer is required"
python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || die "Python 3.8 or newer is required"
runtime_py() { python3 -I "$script_dir/runtime.py" "$@"; }
sha256_of() { python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"; }

out=$(absolute_dir "$out_dir")

if [ -z "$dmg" ]; then
  dmg=$out/$dmg_name
  if [ -f "$dmg" ] && [ "$(sha256_of "$dmg")" = "$dmg_sha256" ]; then
    log "reusing $dmg"
  else
    cleanup_paths+=("$dmg.partial")
    log "downloading $dmg_url"
    curl --fail --location --silent --show-error --output "$dmg.partial" "$dmg_url"
    mv -- "$dmg.partial" "$dmg"
  fi
fi
[ -f "$dmg" ] || die "$dmg is not a file"
actual=$(sha256_of "$dmg")
[ "$actual" = "$dmg_sha256" ] || die "$dmg has SHA-256 $actual, not $dmg_sha256 of $dmg_name"

mount=$out/.mount-$key
stage=$out/.stage-$key
rm -rf -- "$stage"
mkdir -p -- "$mount" "$stage"
cleanup_paths+=("$stage")
log "copying GIMP from $dmg"
hdiutil attach -quiet -nobrowse -readonly -noautoopen -noverify -mountpoint "$mount" "$dmg"
mounts+=("$mount")
apps=("$mount"/*.app)
[ "${#apps[@]}" -eq 1 ] && [ -d "${apps[0]}/Contents/MacOS" ] || die "$dmg does not hold one application bundle"
ditto -- "${apps[0]}/Contents" "$stage/Contents"
hdiutil detach -quiet "$mount"
mounts=()
rmdir -- "$mount"
# A copy keeps the extended attributes of its source; a quarantine attribute would make macOS assess every program on
# its first start and reject the programs once they are signed again.
xattr -cr "$stage"

gimp=$(runtime_py prepare --contents "$stage/Contents")
[ "$gimp" = "$gimp_version" ] || die "$dmg holds GIMP $gimp, not $gimp_version"
console=Contents/MacOS/gimp-console-${gimp%.*}

# Prepare removed the bundle signatures that sealed the removed files; every program and library is signed again ad
# hoc, as macOS requires of arm64 code, and Desktop packaging signs it again with the release identity.
log "signing the Mach-O files ad hoc"
runtime_py macho-files --stage "$stage" | xargs -0 -n 64 -P 8 codesign --force --sign - 2> >(grep -v ': replacing existing signature$' >&2)
runtime_py check-links --contents "$stage/Contents"

cp -- "$script_dir/../../LICENSE" "$stage/COPYING"
cat >"$stage/SOURCE.txt" <<EOF
GIMP $gimp for macOS ($key), repackaged for WASD Engine as runtime $version.

GIMP is free software under the GNU General Public License, version 3 or later; COPYING holds the license. The
libraries it ships are under their own free licenses, mostly the GNU Lesser General Public License, and its Python is
under the Python Software Foundation License.

The programs are GIMP's own macOS build, $dmg_url (SHA-256 $dmg_sha256),
repackaged by wasdengine/gimp/build.sh of https://github.com/$repository, which removes files that the GIMP tools do
not use and signs the programs again without changing them otherwise.

Corresponding source: $source_url (SHA-256 $source_sha256) for GIMP, and the build recipes of
https://gitlab.gnome.org/Infrastructure/gimp-macos-build, which name the source releases of the libraries.
EOF

log "smoke-testing the staged runtime"
python3 -I "$script_dir/smoke.py" --runtime "$stage" --work "$out/.smoke-$key" --console "$console"
cleanup_paths+=("$out/.smoke-$key")

archive=$(runtime_py package --stage "$stage" --out "$out" --version "$version" --gimp "$gimp" \
  --platform darwin --arch "$node_arch" --console "$console" --repository "$repository")

if [ -n "$install_root" ]; then
  installed=$(runtime_py install --archive "$archive" --root "$(absolute_dir "$install_root")" --version "$version")
  log "installed the runtime into $installed"
fi
log "done: $archive"
