#!/usr/bin/env bash
# scripts/host/github/issue-create.sh
# Verb contract: host.sh issue-create --title --body-file --labels a,b [--milestone] [--parent N] [--blocked-by n,n] [--assignee]
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  cat <<'EOF'
Usage: issue-create.sh --title T --body-file F [--labels a,b] [--milestone T]
                        [--parent N] [--blocked-by n,n] [--assignee a]

--parent / --blocked-by are only sent as native gh flags when runtime/host-caps.json
(refreshed here via caps.sh --cached) says the installed gh supports them; otherwise
they are silently omitted and the caller is expected to link via issue-link.sh
(the 3-tier fallback ladder) after creation.

Checks `gh api rate_limit` first and sleeps until reset when remaining < 10
(set AGENTIC_NO_SLEEP=1 to skip the sleep, e.g. in tests).

Output (stdout, JSON): {"number":N,"url":"..."}
EOF
}

title=""; body_file=""; labels=""; milestone=""; parent=""; blocked_by=""; assignee=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --title) title="$2"; shift 2 ;;
    --body-file) body_file="$2"; shift 2 ;;
    --labels) labels="$2"; shift 2 ;;
    --milestone) milestone="$2"; shift 2 ;;
    --parent) parent="$2"; shift 2 ;;
    --blocked-by) blocked_by="$2"; shift 2 ;;
    --assignee) assignee="$2"; shift 2 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$title" ] || { printf 'ERROR: --title is required\n' >&2; exit 2; }
[ -n "$body_file" ] || { printf 'ERROR: --body-file is required\n' >&2; exit 2; }

require_cmd gh

check_rate_limit() {
  local raw remaining reset now sleep_s
  raw=$(gh api rate_limit 2>/dev/null) || raw='{"rate":{"remaining":9999,"reset":0}}'
  remaining=$(printf '%s' "$raw" | jq -r '.rate.remaining // 9999')
  case "$remaining" in *[!0-9]*|'') remaining=9999 ;; esac
  if [ "$remaining" -lt 10 ]; then
    reset=$(printf '%s' "$raw" | jq -r '.rate.reset // 0')
    case "$reset" in *[!0-9]*|'') reset=0 ;; esac
    now=$(date -u +%s)
    sleep_s=$(( reset - now )); [ "$sleep_s" -lt 0 ] && sleep_s=0
    if [ "${AGENTIC_NO_SLEEP:-0}" = "1" ]; then
      warn "rate limit low ($remaining remaining) — AGENTIC_NO_SLEEP=1, not sleeping"
    else
      warn "rate limit low ($remaining remaining) — sleeping ${sleep_s}s until reset"
      sleep "$sleep_s"
    fi
  fi
}

caps_json=$(bash "$SELF_DIR/caps.sh" --cached)
native_parent=$(printf '%s' "$caps_json" | jq -r '.native_parent')
native_blocked_by=$(printf '%s' "$caps_json" | jq -r '.native_blocked_by')

args=(issue create --title "$title" --body-file "$body_file")

if [ -n "$labels" ]; then
  old_ifs=$IFS; IFS=','
  for l in $labels; do [ -n "$l" ] && args+=(--label "$l"); done
  IFS=$old_ifs
fi
[ -n "$milestone" ] && args+=(--milestone "$milestone")
[ -n "$assignee" ] && args+=(--assignee "$assignee")
if [ -n "$parent" ] && [ "$native_parent" = "true" ]; then
  args+=(--parent "$parent")
fi
if [ -n "$blocked_by" ] && [ "$native_blocked_by" = "true" ]; then
  args+=(--blocked-by "$blocked_by")
fi

check_rate_limit

url=$(gh "${args[@]}") || { printf 'ERROR: gh issue create failed\n' >&2; exit 1; }
number=$(printf '%s' "$url" | sed -n 's#.*/issues/##p')
[ -n "$number" ] || { printf 'ERROR: could not parse issue number from: %s\n' "$url" >&2; exit 1; }

jq -n --argjson number "$number" --arg url "$url" '{number:$number, url:$url}'
