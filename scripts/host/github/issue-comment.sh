#!/usr/bin/env bash
# scripts/host/github/issue-comment.sh (extra verb)
# Verb contract: host.sh issue-comment <n> --body-file f | --body "..."
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: issue-comment.sh <n> (--body-file f | --body "...")
Output (stdout, JSON): {"id":"<comment id or null>","url":"..."}
EOF
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
n="${1:-}"
[ -n "$n" ] || { usage >&2; exit 2; }
shift

body=""; body_file=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --body) body="$2"; shift 2 ;;
    --body-file) body_file="$2"; shift 2 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

require_cmd gh

if [ -n "$body_file" ]; then
  url=$(gh issue comment "$n" --body-file "$body_file") || { printf 'ERROR: gh issue comment failed\n' >&2; exit 1; }
elif [ -n "$body" ]; then
  url=$(gh issue comment "$n" --body "$body") || { printf 'ERROR: gh issue comment failed\n' >&2; exit 1; }
else
  printf 'ERROR: --body or --body-file is required\n' >&2; exit 2
fi

cid=$(printf '%s' "$url" | sed -n 's/.*issuecomment-//p')

if [ -n "$cid" ]; then
  jq -n --arg id "$cid" --arg url "$url" '{id:$id, url:$url}'
else
  jq -n --arg url "$url" '{id:null, url:$url}'
fi
