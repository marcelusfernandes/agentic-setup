#!/usr/bin/env bash
# worktree-remove.sh <path> [--confirm-token <tok>] [--delete-branch]
# Refuses (exit 3) to remove a worktree with uncommitted/untracked changes unless the human
# typed the literal confirmation token "discard" in this same invocation. `--force` is passed to
# `git worktree remove` ONLY in that one case (the token IS the authorization for it) — never
# otherwise, and it is never accepted from a caller as a plain flag of its own.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() { printf 'Usage: worktree-remove.sh <path> [--confirm-token discard] [--delete-branch]\n'; }

[ $# -ge 1 ] || { usage; exit 1; }
path="$1"; shift
token=""; delete_branch=0
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm-token) token="$2"; shift 2 ;;
    --delete-branch) delete_branch=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -d "$path" ] || die "no such worktree directory: $path"

dirty="$(git -C "$path" status --porcelain 2>/dev/null || true)"
force=0
if [ -n "$dirty" ]; then
  if [ "$token" != "discard" ]; then
    printf 'STOP: worktree has uncommitted or untracked changes — refusing to remove.\n' >&2
    printf '%s\n' "$dirty" | sed 's/^/  /' >&2
    printf 'To discard them and remove anyway, re-run with --confirm-token discard (only after the human typed it).\n' >&2
    exit 3
  fi
  force=1
fi

branch="$(git -C "$path" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"

if [ "$force" -eq 1 ]; then
  git worktree remove --force "$path"
else
  git worktree remove "$path"
fi
git worktree prune >/dev/null 2>&1 || true

if [ "$delete_branch" -eq 1 ] && [ -n "$branch" ] && [ "$branch" != "HEAD" ]; then
  git branch -d "$branch" || printf 'WARN: could not delete branch %s with -d (not fully merged?)\n' "$branch" >&2
fi

printf 'removed: %s\n' "$path"
