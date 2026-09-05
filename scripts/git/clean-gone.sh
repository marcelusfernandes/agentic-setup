#!/usr/bin/env bash
# clean-gone.sh [--dry-run] [--json]
# Branches whose upstream is [gone]: removes their worktree (only if it lives under
# config.worktree_dir — never a sibling worktree elsewhere), then deletes the branch (-d only).
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
HERE="$(dirname "${BASH_SOURCE[0]}")"

usage() { printf 'Usage: clean-gone.sh [--dry-run] [--json]\n'; }

dry_run=0; as_json=0
for a in "$@"; do
  case "$a" in
    --dry-run) dry_run=1 ;;
    --json) as_json=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $a" ;;
  esac
done

git fetch --prune >/dev/null 2>&1 || warn "git fetch --prune failed (continuing with local info)"

wt_dir="$(config_get .worktree_dir ".worktrees")"
wt_base="$(project_root)/$wt_dir"

# branch -> worktree path, from `git worktree list --porcelain`
wt_map="$(mktemp)"; trap 'rm -f "$wt_map"' EXIT
{
  path=""
  while IFS= read -r line; do
    case "$line" in
      "worktree "*) path="${line#worktree }" ;;
      "branch "*) printf '%s\t%s\n' "${line#branch refs/heads/}" "$path" ;;
      "") path="" ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null)
} > "$wt_map"

gone_branches="$(git branch -vv 2>/dev/null | sed 's/^\* /  /' | awk '/: gone\]/{print $1}')"
protected="$(jq -r '.protected_branches[]? // empty' "$(config_file)" 2>/dev/null || true)"
is_protected() {
  local b="$1" p
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    case "$b" in $p) return 0 ;; esac
  done <<EOF
$protected
EOF
  return 1
}

results="[]"
report=""
while IFS= read -r br; do
  [ -n "$br" ] || continue
  is_protected "$br" && { warn "skipping protected branch: $br"; continue; }
  wt="$(awk -F'\t' -v b="$br" '$1==b{print $2; exit}' "$wt_map")"
  action="branch-only"
  if [ -n "$wt" ]; then
    case "$wt" in
      "$wt_base"/*) action="worktree+branch" ;;
      *) action="branch-only (worktree outside $wt_dir left untouched: $wt)"; wt="" ;;
    esac
  fi
  report="$report$br\t$action\n"
  if [ "$dry_run" -eq 0 ]; then
    if [ -n "$wt" ]; then
      bash "$HERE/worktree-remove.sh" "$wt" || { warn "skipping branch delete for $br: worktree removal refused"; continue; }
    fi
    git branch -d "$br" 2>/dev/null || warn "could not delete branch $br with -d (not fully merged into HEAD?)"
  fi
done <<EOF
$gone_branches
EOF

git worktree prune >/dev/null 2>&1 || true

if [ "$as_json" -eq 1 ]; then
  out="["
  first=1
  while IFS=$'\t' read -r br action; do
    [ -n "$br" ] || continue
    obj="$(jq -nc --arg branch "$br" --arg action "$action" --argjson dry_run "$([ "$dry_run" -eq 1 ] && printf true || printf false)" \
      '{branch:$branch, action:$action, dry_run:$dry_run}')"
    [ "$first" -eq 1 ] || out="$out,"
    out="$out$obj"; first=0
  done <<EOF
$(printf '%b' "$report")
EOF
  printf '%s]\n' "$out" | jq -c .
else
  if [ -z "$report" ]; then
    printf 'nothing to clean\n'
  else
    printf '%b' "$report" | sed '/^$/d'
    [ "$dry_run" -eq 1 ] && printf '(dry run — nothing changed)\n'
  fi
fi
