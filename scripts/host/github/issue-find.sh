#!/usr/bin/env bash
# scripts/host/github/issue-find.sh — dedup lookup by hidden body marker(s), bounded pagination.
# Verb contract: host.sh issue-find --marker "<m>" [--marker "<m2>" ...] [--label agentic] [--limit 100]
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  cat <<'EOF'
Usage: issue-find.sh --marker "<string>" [--marker "<string>" ...] [--label agentic] [--limit 100]

Pages `gh api repos/OWNER/REPO/issues?labels=<label>&state=all&per_page=<limit>&page=N`
(REST, not `gh issue list` — it has no cursor) looking for each --marker as a
literal substring of an issue's body. Stops as soon as a page comes back empty
or every requested marker has been matched — never scans the whole repo.

Output (stdout, JSON): [{"marker":"...","number":N,"url":"...","title":"...","state":"..."}, ...]
Markers with no match are simply absent from the array.
EOF
}

markers=()
label="agentic"
limit=100
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --marker) markers+=("$2"); shift 2 ;;
    --label) label="$2"; shift 2 ;;
    --limit) limit="$2"; shift 2 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ ${#markers[@]} -gt 0 ] || { printf 'ERROR: at least one --marker is required\n' >&2; exit 2; }

require_cmd gh

repo_json=$(bash "$SELF_DIR/repo-info.sh") || exit $?
OWNER=$(printf '%s' "$repo_json" | jq -r .owner)
REPO=$(printf '%s' "$repo_json" | jq -r .name)

found_file=$(mktemp)
remaining_file=$(mktemp)
trap 'rm -f "$found_file" "$remaining_file"' EXIT

printf '[]' > "$found_file"
printf '%s\n' "${markers[@]}" > "$remaining_file"

max_pages="${AGENTIC_ISSUE_FIND_MAX_PAGES:-20}"
page=1
while [ "$page" -le "$max_pages" ]; do
  resp=$(gh api "repos/$OWNER/$REPO/issues?labels=$label&state=all&per_page=$limit&page=$page" 2>/dev/null) || resp="[]"
  cnt=$(printf '%s' "$resp" | jq 'length' 2>/dev/null) || cnt=0
  [ "$cnt" = "0" ] && break

  new_remaining=$(mktemp)
  : > "$new_remaining"
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    hit=$(printf '%s' "$resp" | jq -c --arg mk "$m" '[.[] | select(.body != null and (.body | contains($mk)))][0] // empty')
    if [ -n "$hit" ]; then
      row=$(printf '%s' "$hit" | jq -c --arg mk "$m" '{marker:$mk, number:.number, url:.html_url, title:.title, state:.state}')
      tmp=$(mktemp)
      jq -c --argjson r "$row" '. + [$r]' "$found_file" > "$tmp" && mv "$tmp" "$found_file"
    else
      printf '%s\n' "$m" >> "$new_remaining"
    fi
  done < "$remaining_file"
  mv "$new_remaining" "$remaining_file"

  [ -s "$remaining_file" ] || break
  page=$((page + 1))
done

cat "$found_file"
