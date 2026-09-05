#!/usr/bin/env bash
# agentic-git — git-host dispatcher.
# Skills/agents never call `gh` (or any host CLI) directly; they call this:
#   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" <verb> [args...]
# host.sh reads config.host (default "github") and execs scripts/host/<host>/<verb>.sh "$@".
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

HOST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/host" && pwd -P)"

usage() {
  local host; host=$(config_get '.host' 'github')
  cat <<EOF
Usage: host.sh <verb> [args...]

Dispatches to scripts/host/<host>/<verb>.sh where <host> is config.json's
".host" (currently: $host). Adding a new host means adding scripts/host/<host>/
with these same verbs and stdout shapes; nothing here changes.

Verbs (the contract every host implementation provides):
  caps           feature-probe gh, cache runtime/host-caps.json
                   -> {native_parent,native_blocked_by,native_sub_issue_edit,sub_issues_api,probed_at}
  repo-info      owner/name/default_branch/host parsed from the origin remote
                   -> {host,owner,name,default_branch,remote}
  milestone      list | ensure <title> [due_on] | close <title> | due <title> <due_on>
                   -> {number,title,state,open_issues,closed_issues} (list: a JSON array)
  issue-create   --title --body-file --labels a,b [--milestone] [--parent N] [--blocked-by n,n] [--assignee]
                   -> {number,url}
  issue-find     --marker "<m>" [--marker "<m2>" ...] [--label agentic] [--limit 100]
                   -> [{marker,number,url,title,state}]
  issue-link     --parent N --children n,n | --blocked N --by n,n
                   -> {mode:"native|rest|checklist",applied:[...]}
  issue-close    <n> [--reason completed|not-planned|duplicate] [--comment "..."]
                   -> {number,state}
  issue-label    <n> --add a,b --remove c,d          (idempotent; extra verb)
                   -> {number,labels:[...]}
  issue-comment  <n> --body-file f | --body "..."    (extra verb)
                   -> {id,url}
  pr-create      --base --head --title --body-file [--labels] [--milestone] [--draft] [--reviewers a,b]
                   -> {number,url}  (idempotent: returns the existing PR for --head if one is open)
  pr-state       <n>
                   -> {number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,
                       checks:[{name,status,conclusion}],headRefName,baseRefName,headRefOid,
                       closingIssues:[n],url}
  pr-merge       <n> --strategy squash|merge|rebase [--delete-branch] [--match-head <sha>] [--auto]
                   -> {merged:bool,sha}

See references/github.md for the exact gh/api commands each verb runs.
EOF
}

case "${1:-}" in
  -h|--help|"") usage; exit 0 ;;
esac

verb="$1"; shift
host="$(config_get '.host' 'github')"

[ -d "$HOST_DIR/$host" ] || { printf 'ERROR: unknown host: %s (config.host)\n' "$host" >&2; exit 2; }

target="$HOST_DIR/$host/$verb.sh"
[ -f "$target" ] || { printf 'ERROR: unknown verb for host "%s": %s\n' "$host" "$verb" >&2; exit 2; }

exec bash "$target" "$@"
