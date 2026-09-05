#!/usr/bin/env bash
# preflight.sh [--base <branch>] [--no-fetch] [--json]
# Checks the working tree is safe to start git-workflow operations in.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() { printf 'Usage: preflight.sh [--base <branch>] [--no-fetch] [--json]\n'; }

base=""; no_fetch=0; as_json=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="$2"; shift 2 ;;
    --no-fetch) no_fetch=1; shift ;;
    --json) as_json=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

checks=()   # id|status|message
add() { checks+=("$1|$2|$3"); }

ok=1

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  add inside_work_tree OK "inside a git work tree"
else
  add inside_work_tree FAIL "not inside a git work tree"
  ok=0
fi

if [ "$ok" -eq 1 ]; then
  if in_worktree; then
    add not_linked_worktree FAIL "this checkout is a linked worktree — run from the main checkout"
    ok=0
  else
    add not_linked_worktree OK "main checkout (not a linked worktree)"
  fi
fi

gv="$(git_version)"
if [ -n "$gv" ] && version_ge "$gv" "2.38"; then
  add git_version OK "git $gv (>= 2.38)"
else
  add git_version FAIL "git ${gv:-unknown} is older than the required 2.38 (needed for merge-tree --write-tree)"
  ok=0
fi

if [ "$ok" -eq 1 ]; then
  dirty="$(git status --porcelain 2>/dev/null)"
  if [ -z "$dirty" ]; then
    add clean_tree OK "working tree is clean"
  else
    add clean_tree FAIL "working tree has uncommitted changes"
    ok=0
    printf 'STOP: working tree has uncommitted changes — commit or stash before continuing.\n' >&2
  fi
fi

if [ "$ok" -eq 1 ] && [ "$no_fetch" -eq 0 ]; then
  if git fetch origin --prune >/dev/null 2>&1; then
    add fetch OK "git fetch origin --prune"
  else
    add fetch FAIL "git fetch origin --prune failed"
    ok=0
  fi
elif [ "$no_fetch" -eq 1 ]; then
  add fetch OK "skipped (--no-fetch)"
fi

base="${base:-$(config_get .base_branch "$(default_branch 2>/dev/null || printf main)")}"
if [ "$no_fetch" -eq 1 ]; then
  add base_resolvable OK "skipped (--no-fetch)"
elif [ "$ok" -eq 1 ]; then
  if git rev-parse --verify -q "origin/$base" >/dev/null 2>&1; then
    add base_resolvable OK "origin/$base resolves"
  else
    add base_resolvable FAIL "origin/$base does not resolve"
    ok=0
  fi
fi

rerere="$(git config --local --get rerere.enabled 2>/dev/null || printf false)"
rerere_au="$(git config --local --get rerere.autoupdate 2>/dev/null || printf false)"
style="$(git config --local --get merge.conflictStyle 2>/dev/null || printf "(unset)")"
[ "$rerere" = "true" ] && add rerere OK "rerere.enabled=true" || add rerere WARN "rerere.enabled is not true (run /agentic-git:init)"
[ "$rerere_au" = "true" ] && add rerere_autoupdate OK "rerere.autoupdate=true" || add rerere_autoupdate WARN "rerere.autoupdate is not true"
[ "$style" = "zdiff3" ] && add conflict_style OK "merge.conflictStyle=zdiff3" || add conflict_style WARN "merge.conflictStyle is '$style', expected zdiff3"

if [ "$as_json" -eq 1 ]; then
  out="["
  first=1
  for c in "${checks[@]}"; do
    IFS='|' read -r id status msg <<EOF
$c
EOF
    obj="$(jq -nc --arg id "$id" --arg status "$status" --arg message "$msg" '{id:$id,status:$status,message:$message}')"
    [ "$first" -eq 1 ] || out="$out,"
    out="$out$obj"; first=0
  done
  out="$out]"
  printf '{"ok":%s,"base":"%s","checks":%s}\n' "$( [ "$ok" -eq 1 ] && printf true || printf false)" "$base" "$out" | jq -c .
else
  for c in "${checks[@]}"; do
    IFS='|' read -r id status msg <<EOF
$c
EOF
    printf '%-4s %-24s %s\n' "$status" "$id" "$msg"
  done
fi

[ "$ok" -eq 1 ] || exit 3
exit 0
