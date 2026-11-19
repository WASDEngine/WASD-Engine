# shellcheck shell=bash
# What the build scripts of WASD Engine's runtimes (wasdengine/<tool>/build.sh) share; each sources it right after it
# sets script_dir. Logging, failing with one "build.sh: error:" line, usage from the script's header comment, the
# paths deleted when the script exits (and the steps a script adds before that, cleanup_hooks), option values,
# absolute folders, and the Godot source patches of a tool that has them.

log() { printf 'build.sh: %s\n' "$*" >&2; }
die() {
  printf 'build.sh: error: %s\n' "$*" >&2
  exit 1
}
# Prints the comment block at the top of the build script that runs.
usage() { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; }

cleanup_paths=()
cleanup_hooks=()
# shellcheck disable=SC2317 # Invoked by the EXIT trap.
cleanup() {
  local hook path
  for hook in ${cleanup_hooks[@]+"${cleanup_hooks[@]}"}; do
    "$hook"
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

# Prints the absolute, symlink-free path of folder $1, made when it is missing.
absolute_dir() {
  mkdir -p -- "$1" || die "cannot create directory $1"
  (cd -- "$1" && pwd -P)
}

# Applies the patches in $script_dir/patches to the source tree that the script's git_in_source runs git in, each
# once: a patch already applied is left; one that applies neither way fails, naming what the patches are for ($1).
# shellcheck disable=SC2154 # script_dir and src are the sourcing script's.
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
      die "patch $name applies neither forward nor in reverse to $src; the patches are written for $1"
    fi
  done
}
