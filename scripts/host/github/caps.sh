#!/usr/bin/env bash
# scripts/host/github/caps.sh — feature-probe the installed `gh`, not a version compare.
# Verb contract: host.sh caps [--no-cache|--cached]
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: caps.sh [--no-cache] [--cached]

Probes `gh` for native sub-issue / dependency-link support by grepping its own
--help text (never a version compare, since these flags shipped independently
of gh's version number).

  --no-cache   probe fresh; never read or write runtime/host-caps.json
  --cached     return runtime/host-caps.json as-is when younger than 7 days;
               otherwise probe fresh and (re)write it (default behaviour anyway)

Output (stdout, JSON):
  {"native_parent":bool,"native_blocked_by":bool,"native_sub_issue_edit":bool,
   "sub_issues_api":null,"probed_at":"<UTC ISO8601>"}

sub_issues_api is always null here — it is probed lazily on first REST use
(issue-link.sh), because that probe costs a live API call.
EOF
}

no_cache=0
use_cached=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --no-cache) no_cache=1 ;;
    --cached) use_cached=1 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

cache_file="$(runtime_dir)/host-caps.json"

is_fresh() {
  [ -f "$cache_file" ] || return 1
  local probed_epoch now
  probed_epoch=$(json_get "$cache_file" '.probed_at_epoch' '')
  [ -n "$probed_epoch" ] || return 1
  now=$(date -u +%s)
  [ $(( now - probed_epoch )) -lt $(( 7 * 24 * 3600 )) ]
}

probe() {
  local native_parent=false native_blocked_by=false native_sub_issue_edit=false
  if have_cmd gh; then
    gh issue create --help 2>/dev/null | grep -q -- '--parent'        && native_parent=true
    gh issue create --help 2>/dev/null | grep -q -- '--blocked-by'    && native_blocked_by=true
    gh issue edit   --help 2>/dev/null | grep -q -- '--add-sub-issue' && native_sub_issue_edit=true
  fi
  local now_iso now_epoch
  now_iso=$(date_utc)
  now_epoch=$(date -u +%s)
  jq -n \
    --argjson native_parent "$native_parent" \
    --argjson native_blocked_by "$native_blocked_by" \
    --argjson native_sub_issue_edit "$native_sub_issue_edit" \
    --arg probed_at "$now_iso" \
    --argjson probed_at_epoch "$now_epoch" \
    '{native_parent:$native_parent, native_blocked_by:$native_blocked_by,
      native_sub_issue_edit:$native_sub_issue_edit, sub_issues_api:null,
      probed_at:$probed_at, probed_at_epoch:$probed_at_epoch}'
}

if [ "$use_cached" = 1 ] && is_fresh; then
  cat "$cache_file"
  exit 0
fi

out=$(probe)

if [ "$no_cache" != 1 ]; then
  mkdir -p "$(runtime_dir)"
  tmp=$(mktemp)
  printf '%s\n' "$out" > "$tmp" && mv "$tmp" "$cache_file"
fi

printf '%s\n' "$out"
