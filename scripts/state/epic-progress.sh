#!/usr/bin/env bash
# epic-progress.sh <slug> — recompute an epic's progress percentage and status from its task files.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() { printf 'Usage: epic-progress.sh <epic-slug>\nPrints "<closed>/<total>" and updates epic.md progress/status frontmatter.\n'; }

[ $# -ge 1 ] || { usage; exit 1; }
[ "$1" = "--help" ] || [ "$1" = "-h" ] && { usage; exit 0; }
slug="$1"

dir="$(epic_dir "$slug")"
epic="$dir/epic.md"
[ -f "$epic" ] || die "no such epic: $slug ($epic not found)"

total=0
closed=0
for f in "$dir"/tasks/*.md; do
  [ -f "$f" ] || continue
  total=$((total+1))
  st="$(fm_get "$f" status)"
  [ "$st" = "closed" ] && closed=$((closed+1))
done

pct=0
if [ "$total" -gt 0 ]; then
  pct=$(( closed * 100 / total ))
fi

status="backlog"
if [ "$total" -gt 0 ] && [ "$closed" -eq "$total" ]; then
  status="completed"
elif [ "$closed" -gt 0 ] || [ "$total" -eq 0 ]; then
  status="in-progress"
else
  # any task in-progress/in-review also counts as in-progress
  for f in "$dir"/tasks/*.md; do
    [ -f "$f" ] || continue
    st="$(fm_get "$f" status)"
    case "$st" in in-progress|in-review) status="in-progress"; break ;; esac
  done
fi

fm_set "$epic" progress "${pct}%"
fm_set "$epic" status "$status"
fm_set "$epic" updated "$(date_utc)"

printf '%s/%s\n' "$closed" "$total"
