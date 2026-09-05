#!/usr/bin/env bash
# scripts/host/github/pr-merge.sh — never emits --admin.
# Verb contract: host.sh pr-merge <n> --strategy squash|merge|rebase [--delete-branch] [--match-head <sha>] [--auto]
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: pr-merge.sh <n> --strategy squash|merge|rebase [--delete-branch] [--match-head <sha>] [--auto]

--match-head is forwarded as `gh pr merge --match-head-commit <sha>`: the merge
refuses if the head moved since preflight, which is what makes the whole gate
sequence upstream (state/CI/review/dry-run) atomic. --auto enables auto-merge
and returns immediately with {"merged":false,"sha":null} — auto-merge is
fire-and-forget; the caller records "pending-auto" and does not clean up.
--admin is never emitted, by design.

Output (stdout, JSON): {"merged":bool,"sha":"<merge commit oid>|null"}
EOF
}

case "${1:-}" in -h|--help) usage; exit 0 ;; esac
n="${1:-}"
[ -n "$n" ] || { usage >&2; exit 2; }
shift

strategy="squash"; delete_branch=0; match_head=""; auto=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --strategy) strategy="$2"; shift 2 ;;
    --delete-branch) delete_branch=1; shift ;;
    --match-head) match_head="$2"; shift 2 ;;
    --auto) auto=1; shift ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$strategy" in
  squash|merge|rebase) ;;
  *) printf 'ERROR: --strategy must be squash|merge|rebase\n' >&2; exit 2 ;;
esac

require_cmd gh

args=(pr merge "$n" "--$strategy")
[ "$delete_branch" = 1 ] && args+=(--delete-branch)
[ -n "$match_head" ] && args+=(--match-head-commit "$match_head")

if [ "$auto" = 1 ]; then
  args+=(--auto)
  gh "${args[@]}" >/dev/null || { printf 'ERROR: gh pr merge --auto failed for #%s\n' "$n" >&2; exit 1; }
  jq -n '{merged:false, sha:null}'
  exit 0
fi

gh "${args[@]}" >/dev/null || { printf 'ERROR: gh pr merge failed for #%s\n' "$n" >&2; exit 1; }

sha=$(gh pr view "$n" --json mergeCommit 2>/dev/null | jq -r '.mergeCommit.oid // empty') || sha=""
if [ -n "$sha" ]; then
  jq -n --arg sha "$sha" '{merged:true, sha:$sha}'
else
  jq -n '{merged:true, sha:null}'
fi
