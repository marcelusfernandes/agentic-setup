#!/usr/bin/env bash
# scripts/host/github/milestone.sh — gh has no `gh milestone`; drive the REST endpoint directly.
# Verb contract: host.sh milestone list | ensure <title> [due_on] | close <title> | due <title> <due_on>
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  cat <<'EOF'
Usage:
  milestone.sh list                       -> JSON array of {number,title,state,open_issues,closed_issues}
  milestone.sh ensure <title> [due_on]     -> {number,title,state,open_issues,closed_issues}
  milestone.sh close  <title>              -> {number,title,state,open_issues,closed_issues}
  milestone.sh due    <title> <due_on>     -> {number,title,state,open_issues,closed_issues}

due_on is ISO 8601 (e.g. 2026-12-01T00:00:00Z). "ensure" is idempotent: an
existing milestone with the same title is returned, not duplicated.
EOF
}

case "${1:-}" in -h|--help|"") usage; exit $([ "${1:-}" = "" ] && echo 1 || echo 0) ;; esac

require_cmd gh
require_cmd jq

repo_json=$(bash "$SELF_DIR/repo-info.sh") || exit $?
OWNER=$(printf '%s' "$repo_json" | jq -r .owner)
REPO=$(printf '%s' "$repo_json" | jq -r .name)

fmt='{number,title,state,open_issues,closed_issues}'

list_all() {
  gh api "repos/$OWNER/$REPO/milestones?state=all" 2>/dev/null || printf '[]'
}

find_number_by_title() {
  # find_number_by_title <title> -> issue number or "" (first match)
  list_all | jq -r --arg t "$1" '[.[] | select(.title == $t)][0].number // empty'
}

verb="$1"; shift

case "$verb" in
  list)
    list_all | jq -c "[.[] | $fmt]"
    ;;
  ensure)
    title="${1:-}"; due="${2:-}"
    [ -n "$title" ] || { printf 'ERROR: ensure requires <title>\n' >&2; exit 2; }
    num=$(find_number_by_title "$title")
    if [ -n "$num" ]; then
      gh api "repos/$OWNER/$REPO/milestones/$num" 2>/dev/null | jq -c "$fmt"
    else
      if [ -n "$due" ]; then
        raw=$(gh api "repos/$OWNER/$REPO/milestones" -f title="$title" -f due_on="$due")
      else
        raw=$(gh api "repos/$OWNER/$REPO/milestones" -f title="$title")
      fi
      printf '%s' "$raw" | jq -c "$fmt"
    fi
    ;;
  close)
    title="${1:-}"
    [ -n "$title" ] || { printf 'ERROR: close requires <title>\n' >&2; exit 2; }
    num=$(find_number_by_title "$title")
    [ -n "$num" ] || { printf 'ERROR: milestone not found: %s\n' "$title" >&2; exit 1; }
    gh api "repos/$OWNER/$REPO/milestones/$num" -X PATCH -f state="closed" | jq -c "$fmt"
    ;;
  due)
    title="${1:-}"; due_on="${2:-}"
    [ -n "$title" ] && [ -n "$due_on" ] || { printf 'ERROR: due requires <title> <due_on>\n' >&2; exit 2; }
    num=$(find_number_by_title "$title")
    [ -n "$num" ] || { printf 'ERROR: milestone not found: %s\n' "$title" >&2; exit 1; }
    gh api "repos/$OWNER/$REPO/milestones/$num" -X PATCH -f due_on="$due_on" | jq -c "$fmt"
    ;;
  *)
    printf 'ERROR: unknown verb: %s\n' "$verb" >&2
    usage >&2
    exit 2
    ;;
esac
