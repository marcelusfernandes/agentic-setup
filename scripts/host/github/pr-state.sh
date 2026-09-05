#!/usr/bin/env bash
# scripts/host/github/pr-state.sh — the one JSON blob merge/pr need for gating.
# Verb contract: host.sh pr-state <n>
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: pr-state.sh <n>
Output (stdout, JSON):
  {"number":N,"state":"OPEN|CLOSED|MERGED","isDraft":bool,"mergeable":"...",
   "mergeStateStatus":"BEHIND|BLOCKED|CLEAN|DIRTY|DRAFT|HAS_HOOKS|UNKNOWN|UNSTABLE",
   "reviewDecision":"APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|\"\"",
   "checks":[{"name":"...","status":"...","conclusion":"..."}],
   "headRefName":"...","baseRefName":"...","headRefOid":"...",
   "closingIssues":[N,...],"url":"..."}
EOF
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
n="${1:-}"
[ -n "$n" ] || { usage >&2; exit 2; }

require_cmd gh

raw=$(gh pr view "$n" --json number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName,baseRefName,headRefOid,closingIssuesReferences,url 2>/dev/null) \
  || { printf 'ERROR: gh pr view failed for #%s\n' "$n" >&2; exit 1; }

printf '%s' "$raw" | jq -c '{
  number, state, isDraft, mergeable, mergeStateStatus, reviewDecision,
  checks: [ (.statusCheckRollup // [])[] | {
    name: (.name // .context // ""),
    status: (.status // ""),
    conclusion: (.conclusion // .state // "")
  } ],
  headRefName, baseRefName, headRefOid,
  closingIssues: [ (.closingIssuesReferences // [])[].number ],
  url
}'
