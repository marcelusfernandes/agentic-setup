#!/usr/bin/env bash
# blocked.sh [slug] [--json] — open tasks with at least one unresolved blocker, and what blocks them.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() { printf 'Usage: blocked.sh [<epic-slug>] [--json]\n'; }

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
[ -s "$nodes" ] || { [ "$as_json" -eq 1 ] && printf '[]\n'; exit 0; }

disp_of() { # disp_of key -> issue if numeric else the key (epic:local_id form)
  awk -F'\t' -v k="$1" '$1==k{ i=$4; l=$5; print (i!="" && i!="null") ? i : l; exit }' "$nodes"
}

as_json_out="["
first=1
text_out=""

while IFS=$'\t' read -r key ed path issue lid st name; do
  [ "$st" = "open" ] || continue
  blockers="$tmpd/blockers_$$.tsv"; : > "$blockers"
  while IFS=$'\t' read -r depkey taskkey; do
    [ "$taskkey" = "$key" ] || continue
    dst="$(awk -F'\t' -v k="$depkey" '$1==k{print $6; exit}' "$nodes")"
    [ "$dst" = "closed" ] && continue
    dname="$(awk -F'\t' -v k="$depkey" '$1==k{print $7; exit}' "$nodes")"
    printf '%s\t%s\t%s\n' "$(disp_of "$depkey")" "$dname" "${dst:-unknown}" >> "$blockers"
  done < "$edges"
  while IFS=$'\t' read -r tkey dep; do
    [ "$tkey" = "$key" ] || continue
    printf '%s\t%s\t%s\n' "$dep" "(external)" "unknown" >> "$blockers"
  done < "$unresolved"
  [ -s "$blockers" ] || { rm -f "$blockers"; continue; }

  disp="$(disp_of "$key")"
  if [ "$as_json" -eq 1 ]; then
    bl_json="["
    bfirst=1
    while IFS=$'\t' read -r bissue bname bst; do
      bobj="$(jq -nc --arg issue "$bissue" --arg name "$bname" --arg status "$bst" \
        '{issue: (if ($issue|test("^[0-9]+$")) then ($issue|tonumber) else $issue end), name: $name, status: $status}')"
      [ "$bfirst" -eq 1 ] || bl_json="$bl_json,"
      bl_json="$bl_json$bobj"; bfirst=0
    done < "$blockers"
    bl_json="$bl_json]"
    obj="$(jq -nc --arg issue "$disp" --arg lid "$lid" --arg name "$name" --arg epic "$ed" --argjson blockers "$bl_json" \
      '{issue: (if ($issue|test("^[0-9]+$")) then ($issue|tonumber) else null), local_id: $lid, name: $name, epic: $epic, blockers: $blockers}')"
    [ "$first" -eq 1 ] || as_json_out="$as_json_out,"
    as_json_out="$as_json_out$obj"; first=0
  else
    text_out="$text_out#$disp $name [$ed] blocked by:\n"
    while IFS=$'\t' read -r bissue bname bst; do
      text_out="$text_out  - #$bissue $bname ($bst)\n"
    done < "$blockers"
  fi
  rm -f "$blockers"
done < "$nodes"

if [ "$as_json" -eq 1 ]; then
  printf '%s]\n' "$as_json_out" | jq -c .
else
  printf '%b' "$text_out"
fi
