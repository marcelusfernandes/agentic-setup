#!/usr/bin/env bash
# scripts/host/github/issue-close.sh
# Verb contract: host.sh issue-close <n> [--reason completed|not-planned|duplicate] [--comment "..."]
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: issue-close.sh <n> [--reason completed|not-planned|duplicate] [--comment "..."]
Output (stdout, JSON): {"number":N,"state":"CLOSED"}
EOF
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
n="${1:-}"
[ -n "$n" ] || { usage >&2; exit 2; }
shift

reason="completed"
comment=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --reason) reason="$2"; shift 2 ;;
    --comment) comment="$2"; shift 2 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$reason" in
  completed|duplicate) gh_reason="$reason" ;;
  not-planned) gh_reason="not planned" ;;
  *) printf 'ERROR: --reason must be completed|not-planned|duplicate\n' >&2; exit 2 ;;
esac

require_cmd gh

args=(issue close "$n" --reason "$gh_reason")
[ -n "$comment" ] && args+=(--comment "$comment")

gh "${args[@]}" >/dev/null || { printf 'ERROR: gh issue close failed for #%s\n' "$n" >&2; exit 1; }

gh issue view "$n" --json number,state 2>/dev/null | jq -c '{number,state}'
