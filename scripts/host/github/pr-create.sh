#!/usr/bin/env bash
# scripts/host/github/pr-create.sh
# Verb contract: host.sh pr-create --base --head --title --body-file [--labels] [--milestone] [--draft] [--reviewers a,b]
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: pr-create.sh --base B --head H --title T --body-file F
                     [--labels a,b] [--milestone T] [--draft] [--reviewers a,b]

Idempotent: if an open PR for --head already exists (gh pr list --head),
that PR is returned as-is instead of erroring or creating a duplicate.

Output (stdout, JSON): {"number":N,"url":"..."}
EOF
}

base=""; head=""; title=""; body_file=""; labels=""; milestone=""; draft=0; reviewers=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --base) base="$2"; shift 2 ;;
    --head) head="$2"; shift 2 ;;
    --title) title="$2"; shift 2 ;;
    --body-file) body_file="$2"; shift 2 ;;
    --labels) labels="$2"; shift 2 ;;
    --milestone) milestone="$2"; shift 2 ;;
    --draft) draft=1; shift ;;
    --reviewers) reviewers="$2"; shift 2 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -n "$base" ] && [ -n "$head" ] && [ -n "$title" ] && [ -n "$body_file" ] || { usage >&2; exit 2; }

require_cmd gh

existing_raw=$(gh pr list --head "$head" --state all --json number,url 2>/dev/null) || existing_raw='[]'
existing=$(printf '%s' "$existing_raw" | jq -c '.[0] // empty')
if [ -n "$existing" ]; then
  printf '%s' "$existing" | jq -c '{number, url}'
  exit 0
fi

args=(pr create --base "$base" --head "$head" --title "$title" --body-file "$body_file")
if [ -n "$labels" ]; then
  old_ifs=$IFS; IFS=','
  for l in $labels; do [ -n "$l" ] && args+=(--label "$l"); done
  IFS=$old_ifs
fi
[ -n "$milestone" ] && args+=(--milestone "$milestone")
[ "$draft" = 1 ] && args+=(--draft)
[ -n "$reviewers" ] && args+=(--reviewer "$reviewers")

url=$(gh "${args[@]}") || { printf 'ERROR: gh pr create failed\n' >&2; exit 1; }
number=$(printf '%s' "$url" | sed -n 's#.*/pull/##p')
[ -n "$number" ] || { printf 'ERROR: could not parse PR number from: %s\n' "$url" >&2; exit 1; }

jq -n --argjson number "$number" --arg url "$url" '{number:$number, url:$url}'
