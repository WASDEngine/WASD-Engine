#!/usr/bin/env bash
# Merge deepseek-ai/deepseek-harness into this fork's main branch, delete the
# upstream paths listed in wasdengine/upstream-prune.txt, record the merged
# version in wasdengine/upstream-version.txt, and commit the merge when no
# other conflict remains. Run it from any directory of the fork; it never
# pushes.
#
# Usage:
#   wasdengine/sync-upstream.sh                          # merge upstream master
#   UPSTREAM_REF=dsh-v0.2.2 wasdengine/sync-upstream.sh  # merge a release tag or other ref
set -euo pipefail

UPSTREAM_URL="https://github.com/deepseek-ai/deepseek-harness.git"
UPSTREAM_REF="${UPSTREAM_REF:-master}"
FORK_BRANCH="${FORK_BRANCH:-main}"
MANIFEST="wasdengine/upstream-prune.txt"
VERSION_FILE="wasdengine/upstream-version.txt"

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

merging() { git rev-parse -q --verify MERGE_HEAD >/dev/null; }

if [ ! -f "$MANIFEST" ]; then
  echo "$MANIFEST is missing; run this script from a WASDEngine fork checkout." >&2
  exit 1
fi
if merging; then
  echo "A merge is already in progress; finish it (git commit) or abort it (git merge --abort)." >&2
  exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "The working tree has uncommitted changes; commit or stash them first." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "$UPSTREAM_URL"
fi
# Pushing to DeepSeek's repository is never intended from this checkout.
git remote set-url --push upstream DISABLED-do-not-push-to-upstream

git fetch --no-tags origin "$FORK_BRANCH"
# Switching to the branch would leave behind commits made on a detached HEAD.
if ! git symbolic-ref -q HEAD >/dev/null \
  && ! git merge-base --is-ancestor HEAD "origin/$FORK_BRANCH" \
  && ! { git rev-parse -q --verify "refs/heads/$FORK_BRANCH" >/dev/null \
    && git merge-base --is-ancestor HEAD "refs/heads/$FORK_BRANCH"; }; then
  echo "HEAD is detached at $(git log -1 --format='%h (%s)'), which neither origin/$FORK_BRANCH nor $FORK_BRANCH contains." >&2
  echo "Put it on a branch first, for example with git switch -c <name>, then rerun." >&2
  exit 1
fi
git checkout "$FORK_BRANCH"
git merge -q --ff-only "origin/$FORK_BRANCH"

# Read the list from the fork's own tip, before the merge touches the tree.
# Each entry is a literal path or directory, and read trims the blanks around
# it, as scripts/verify-md-links.ts reads the list.
prune_specs=()
while read -r line || [ -n "$line" ]; do
  case "$line" in
    '' | '#'*) ;;
    *) prune_specs+=(":(literal)$line") ;;
  esac
done < "$MANIFEST"
if [ "${#prune_specs[@]}" -eq 0 ]; then
  echo "$MANIFEST lists no paths." >&2
  exit 1
fi

# Works for branches and tags alike; FETCH_HEAD is read before any other fetch.
git fetch --no-tags upstream "$UPSTREAM_REF"
target_sha="$(git rev-parse 'FETCH_HEAD^{commit}')"

if git merge-base --is-ancestor "$target_sha" HEAD; then
  echo "$FORK_BRANCH already contains upstream $UPSTREAM_REF (${target_sha:0:10})."
  exit 0
fi

# Upgrade guides follow upstream's version numbers, while the root package.json
# carries WASD Engine's own, so scripts/doc-typecheck.ts reads this version to
# tell which guides are frozen.
upstream_version="$(git show "$target_sha:package.json" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
if ! [[ "$upstream_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]]; then
  echo "The package.json of upstream $UPSTREAM_REF (${target_sha:0:10}) has no version." >&2
  exit 1
fi

merge_message="Merge deepseek-ai/deepseek-harness $UPSTREAM_REF (${target_sha:0:10}) into $FORK_BRANCH"
merge_clean=true
git merge --no-ff --no-commit "$target_sha" || merge_clean=false
# Without MERGE_HEAD git refused to start the merge, for example because an
# untracked file would be overwritten; nothing may be pruned or committed then.
if ! merging; then
  echo "git merge did not start; fix the problem it reports above and rerun." >&2
  exit 1
fi
printf '%s\n' "$upstream_version" > "$VERSION_FILE"
git add -- "$VERSION_FILE"

# An unmerged path appears once per stage, hence sort -u.
pruned=0
while IFS= read -r path; do
  case "$path" in
    .github/workflows/wasd-* | .github/actions/wasd-*) ;;
    *)
      git rm -q -f --ignore-unmatch -- ":(literal)$path"
      pruned=$((pruned + 1))
      ;;
  esac
done < <(git ls-files --cached -- "${prune_specs[@]}" | sort -u)
if [ "$pruned" -gt 0 ]; then
  echo "Removed $pruned upstream path(s) listed in $MANIFEST."
fi

if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
  cat >&2 <<EOF

The merge stopped on conflicts in:
$(git diff --name-only --diff-filter=U | sed 's/^/  /')

Resolve them in $PWD with the tables in wasdengine/FORK.md, run its merge
checklist, then run: git -C "$PWD" commit -m "$merge_message"
EOF
  exit 1
fi

if [ "$merge_clean" = false ]; then
  echo "Every conflict was in a pruned path and was resolved by deleting it."
fi
git commit -q -m "$merge_message"

cat <<EOF

Merged upstream $UPSTREAM_REF (${target_sha:0:10}) into $FORK_BRANCH in $PWD.
Next:
  1. Run the merge checklist in wasdengine/FORK.md (pnpm install, pnpm run build, the drift specs).
  2. Publish the fork: git -C "$PWD" push origin $FORK_BRANCH
EOF
