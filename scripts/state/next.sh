#!/usr/bin/env bash
# next.sh [slug] [--json] — unblocked, ready tasks: status open AND every depends_on task closed.
# Detects dependency cycles (Kahn's algorithm) across the scope's whole task graph -> exit 2.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() { printf 'Usage: next.sh [<epic-slug>] [--json]\n'; }

slug=""
as_json=0
for a in "$@"; do
  case "$a" in
    --json) as_json=1 ;;
    --help|-h) usage; exit 0 ;;
    -*) die "unknown flag: $a" ;;
    *) slug="$a" ;;
  esac
done

[ -n "$slug" ] && [ ! -d "$(epic_dir "$slug")" ] && die "no such epic: $slug"

tmpd="$(mktemp -d)"; trap 'rm -rf "$tmpd"' EXIT
nodes="$tmpd/nodes.tsv"; edges="$tmpd/edges.tsv"; unresolved="$tmpd/unresolved.tsv"
build_graph "$slug" "$nodes" "$edges" "$unresolved"

if [ ! -s "$nodes" ]; then
  [ "$as_json" -eq 1 ] && printf '[]\n'
  exit 0
fi

kres="$(kahn_check "$nodes" "$edges")" || {
  printf 'cycle: %s\n' "${kres#CYCLE }" >&2
  exit 2
}

# blocking keys: unresolved deps, or an edge whose dependency isn't closed
blocked_keys="$tmpd/blocked_keys"
awk -F'\t' '{print $1}' "$unresolved" | sort -u > "$blocked_keys"
while IFS=$'\t' read -r depkey taskkey; do
  [ -n "$depkey" ] || continue
  dst="$(awk -F'\t' -v k="$depkey" '$1==k{print $6; exit}' "$nodes")"
  [ "$dst" = "closed" ] || printf '%s\n' "$taskkey" >> "$blocked_keys"
done < "$edges"
sort -u -o "$blocked_keys" "$blocked_keys"

# rank the open+unblocked tasks: fewer direct deps first, then estimate (S<M<L), then issue number
rank="$tmpd/ranked.tsv"
: > "$rank"
while IFS=$'\t' read -r key ed path issue lid st name; do
  [ "$st" = "open" ] || continue
  grep -qxF "$key" "$blocked_keys" && continue
  ndeps=$(awk -F'\t' -v k="$key" '$2==k{c++} END{print c+0}' "$edges")
  w="$(estimate_weight "$(fm_get "$path" estimate)")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ndeps" "$w" "$issue" "$lid" "$name" "$ed" "$path" >> "$rank"
done < "$nodes"
sort -t "$(printf '\t')" -k1,1n -k2,2n -k3,3n -o "$rank" "$rank"

if [ "$as_json" -eq 1 ]; then
  out="["
  first=1
  while IFS=$'\t' read -r _ _ issue lid name ed path; do
    files_json="$(read_block_list "$path" files | jq -R . | jq -sc .)"
    obj="$(jq -nc --arg issue "$issue" --arg lid "$lid" --arg name "$name" --arg epic "$ed" --argjson files "$files_json" \
      '{issue: (if $issue=="" or $issue=="null" then null else ($issue|tonumber) end), local_id: $lid, name: $name, epic: $epic, files: $files}')"
    [ "$first" -eq 1 ] || out="$out,"
    out="$out$obj"
    first=0
  done < "$rank"
  out="$out]"
  printf '%s\n' "$out" | jq -c .
else
  while IFS=$'\t' read -r _ _ issue lid name ed path; do
    disp="$issue"; { [ -z "$disp" ] || [ "$disp" = "null" ]; } && disp="$lid"
    printf '#%s %s [%s]\n' "$disp" "$name" "$ed"
  done < "$rank"
fi
