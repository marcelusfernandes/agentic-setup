#!/usr/bin/env bash
# scripts/host/github/issue-label.sh — idempotent status-label transitions (extra verb).
# Verb contract: host.sh issue-label <n> --add a,b --remove c,d
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: issue-label.sh <n> [--add a,b] [--remove c,d]
       issue-label.sh set <n> [--add a,b] [--remove c,d]   (alias)
       issue-label.sh ensure     create/update the 7 workflow labels (idempotent)

Reads the issue's current labels first and only issues gh issue edit when a
label actually needs to change (idempotent — safe to call every time a
status transition is computed, even if nothing changed).

Output (stdout, JSON): {"number":N,"labels":["a","b",...]}
EOF
}

ensure_labels() {
  # issue-label ensure  -> create/update the workflow label set (idempotent via --force)
  require_cmd gh
  local created=0 failed=0 out
  while IFS='|' read -r name color desc; do
    [ -n "$name" ] || continue
    if gh label create "$name" --color "$color" --description "$desc" --force >/dev/null 2>&1; then
      created=$((created+1)); printf 'ok      %s\n' "$name" >&2
    else
      failed=$((failed+1)); printf 'failed  %s (needs write access?)\n' "$name" >&2
    fi
  done <<'LABELS'
agentic|5319e7|Managed by agentic-git
epic|0e8a16|Epic (parent issue)
task|1d76db|Task (sub-issue)
status:ready|c2e0c6|Unblocked, not started
status:in-progress|fbca04|Being worked
status:in-review|d4c5f9|PR open
status:blocked|b60205|Blocked by another issue
LABELS
  out=$(jq -nc --argjson c "$created" --argjson f "$failed" '{ensured:$c,failed:$f}')
  printf '%s\n' "$out"
  [ "$failed" -eq 0 ]
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  ensure) ensure_labels; exit $? ;;
  set) shift ;;
esac
n="${1:-}"
[ -n "$n" ] || { usage >&2; exit 2; }
shift

add=""; remove=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --add) add="$2"; shift 2 ;;
    --remove) remove="$2"; shift 2 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

require_cmd gh

current=$(gh issue view "$n" --json labels 2>/dev/null | jq -c '[.labels[].name]') || current='[]'

has_label() { printf '%s' "$current" | jq -e --arg l "$1" 'index($l) != null' >/dev/null 2>&1; }

to_add=""
if [ -n "$add" ]; then
  old_ifs=$IFS; IFS=','
  for l in $add; do
    [ -n "$l" ] || continue
    has_label "$l" || to_add="${to_add:+$to_add,}$l"
  done
  IFS=$old_ifs
fi

to_remove=""
if [ -n "$remove" ]; then
  old_ifs=$IFS; IFS=','
  for l in $remove; do
    [ -n "$l" ] || continue
    has_label "$l" && to_remove="${to_remove:+$to_remove,}$l"
  done
  IFS=$old_ifs
fi

if [ -n "$to_add" ] || [ -n "$to_remove" ]; then
  args=(issue edit "$n")
  [ -n "$to_add" ] && args+=(--add-label "$to_add")
  [ -n "$to_remove" ] && args+=(--remove-label "$to_remove")
  gh "${args[@]}" >/dev/null || { printf 'ERROR: gh issue edit (labels) failed for #%s\n' "$n" >&2; exit 1; }
fi

gh issue view "$n" --json number,labels 2>/dev/null | jq -c '{number:.number, labels:[.labels[].name]}'
