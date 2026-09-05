#!/usr/bin/env bash
# worktree-add.sh <name> <branch> [--base <ref>] [--link a,b]
# Creates <worktree_dir>/<name> (new branch off origin/<base> | existing local | existing remote-only branch),
# links untracked config from config.worktree_link (+ .worktreeinclude) into it, and prints
# {"path":...,"branch":...,"created":bool} on success.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  printf 'Usage: worktree-add.sh <name> <branch> [--base <ref>] [--link a,b]\n'
  printf '       worktree-add.sh --branch <branch> --path <dir-or-name> [--base <ref>] [--link a,b]\n'
}

[ $# -ge 1 ] || { usage; exit 1; }
name=""; branch=""; base=""; extra_link=""
case "$1" in
  --*) ;;
  *) [ $# -ge 2 ] || { usage; exit 1; }; name="$1"; branch="$2"; shift 2 ;;
esac
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --link) extra_link="$2"; shift 2 ;;
    --branch) branch="$2"; shift 2 ;;
    --path) name="$2"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
[ -n "$name" ] && [ -n "$branch" ] || { usage; exit 1; }
# --path may be "<worktree_dir>/<name>" or an absolute path; reduce it to the leaf name when it lives in worktree_dir
case "$name" in
  */*) name="$(basename "$name")" ;;
esac

wt_dir="$(config_get .worktree_dir ".worktrees")"
root="$(project_root)"
path="$root/$wt_dir/$name"

[ -e "$path" ] && { printf 'STOP: worktree path already exists: %s (see /agentic-git:cleanup)\n' "$path" >&2; exit 3; }

base="${base:-$(config_get .base_branch "$(default_branch)")}"
base="${base#origin/}"   # accept either "main" or "origin/main"
mkdir -p "$(dirname "$path")"

created=false
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git worktree add "$path" "$branch" >/dev/null
elif git show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git worktree add -b "$branch" "$path" "origin/$branch" >/dev/null
  created=true
else
  git worktree add -b "$branch" "$path" "origin/$base" >/dev/null
  created=true
fi

# ---- link untracked config so the worktree actually runs ----
common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
link_targets="$(mktemp)"
trap 'rm -f "$link_targets"' EXIT

jq -r '.worktree_link[]? // empty' "$(config_file)" >> "$link_targets" 2>/dev/null || true
if [ ! -s "$link_targets" ]; then printf '%s\n' ".env" ".env.local" ".envrc" >> "$link_targets"; fi
if [ -f "$root/.worktreeinclude" ]; then
  sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$root/.worktreeinclude" >> "$link_targets"
fi
if [ -n "$extra_link" ]; then printf '%s\n' "$extra_link" | tr ',' '\n' >> "$link_targets"; fi

sort -u -o "$link_targets" "$link_targets"
while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  [ -e "$root/$rel" ] || continue
  [ -e "$path/$rel" ] && continue
  mkdir -p "$(dirname "$path/$rel")"
  ln -s "$common_dir/../$rel" "$path/$rel" 2>/dev/null || true
done < "$link_targets"

jq -nc --arg path "$path" --arg branch "$branch" --argjson created "$created" '{path:$path, branch:$branch, created:$created}'
