#!/usr/bin/env bash
# scripts/host/github/repo-info.sh — parse the origin remote, no network required.
# Verb contract: host.sh repo-info -> {host,owner,name,default_branch,remote}
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: repo-info.sh [--allow-self]

Parses `git config --get remote.origin.url` (ssh, ssh://, or https form, with
or without a trailing .git) into {host,owner,name,default_branch,remote}.
No network call is made for the parse itself; default_branch falls back
through scripts/lib/common.sh's default_branch (local refs first).

Exit 2  with a CAUTION message when origin is not a github.com remote.
Exit 3  when the target is the agentic-git plugin's own repo
        (marcelusfernandes/agentic-setup) — refuses to create issues/PRs there.
  --allow-self   skip the exit-3 self-repo guard (tests only).
EOF
}

allow_self=0
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --allow-self) allow_self=1 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

remote=$(git config --get remote.origin.url 2>/dev/null) || remote=""
[ -n "$remote" ] || { printf 'ERROR: no "origin" remote configured in this repo\n' >&2; exit 1; }

host=""
path=""
case "$remote" in
  git@*:*)
    rest=${remote#git@}
    host=${rest%%:*}
    path=${rest#*:}
    ;;
  ssh://git@*)
    rest=${remote#ssh://git@}
    host=${rest%%/*}
    path=${rest#*/}
    ;;
  https://*|http://*)
    rest=${remote#*://}
    host=${rest%%/*}
    path=${rest#*/}
    ;;
  *)
    printf 'CAUTION: could not parse origin remote as ssh/https: %s\n' "$remote" >&2
    exit 2
    ;;
esac

path=${path%.git}
owner=${path%%/*}
name=${path#*/}

if [ "$(lower "$host")" != "github.com" ]; then
  printf 'CAUTION: origin remote is not github.com (host: %s) — agentic-git only supports GitHub today.\n' "$host" >&2
  exit 2
fi

if [ "$allow_self" != 1 ] && [ "$(lower "$owner")" = "marcelusfernandes" ] && [ "$(lower "$name")" = "agentic-setup" ]; then
  printf 'CAUTION: refusing to operate on the agentic-git plugin'\''s own repo (marcelusfernandes/agentic-setup).\n' >&2
  printf 'If this is intentional (plugin development), pass --allow-self.\n' >&2
  exit 3
fi

db=$(default_branch)

jq -n --arg host "github" --arg owner "$owner" --arg name "$name" \
      --arg default_branch "$db" --arg remote "$remote" \
      '{host:$host, owner:$owner, name:$name, default_branch:$default_branch, remote:$remote}'
