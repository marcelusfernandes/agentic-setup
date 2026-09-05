#!/usr/bin/env bash
# state-lint.sh [--json] — validate every epic.md and task file has required frontmatter keys,
# every depends_on reference resolves, there are no dependency cycles, and each epic's
# mapping.json parses and roughly matches its task files.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
. "$(dirname "${BASH_SOURCE[0]}")/../state/_lib.sh"

usage() { printf 'Usage: state-lint.sh [--json]\n'; }

as_json=0
for a in "$@"; do
  case "$a" in
    --json) as_json=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $a" ;;
  esac
done

EPIC_KEYS="name title status created updated progress tasks"
TASK_KEYS="name type status created updated epic local_id depends_on conflicts_with parallel files estimate"

problems="$(mktemp)"; trap 'rm -f "$problems"' EXIT
add_problem() { printf '%s\t%s\n' "$1" "$2" >> "$problems"; }   # file \t message

# fm_key_present <file> <key> -- true if "<key>:" is a line in the frontmatter, regardless of
# whether its value is inline (scalar/flow-list) or on the following block-style lines (like
# `files:`, which fm_has/fm_get treat as empty because there's nothing after the colon).
fm_key_present() {
  awk -v k="$2" '
    NR==1 { if ($0!="---") exit; next }
    $0=="---" { exit }
    index($0, k ":")==1 { found=1; exit }
    END { exit !found }
  ' "$1"
}
has_key() { case "$2" in files) fm_key_present "$1" "$2" ;; *) fm_has "$1" "$2" ;; esac; }

for d in "$(epics_dir)"/*; do
  [ -d "$d" ] || continue
  slug="$(basename "$d")"
  epic="$d/epic.md"
  if [ ! -f "$epic" ]; then add_problem "$d" "missing epic.md"; continue; fi
  for k in $EPIC_KEYS; do
    has_key "$epic" "$k" || add_problem "$epic" "missing required key: $k"
  done

  for f in "$d"/tasks/*.md; do
    [ -f "$f" ] || continue
    for k in $TASK_KEYS; do
      has_key "$f" "$k" || add_problem "$f" "missing required key: $k"
    done
    fm_get "$f" epic | grep -qxF "$slug" || add_problem "$f" "epic: field does not match directory ($slug)"
    for dep in $(fm_list "$f" depends_on); do
      resolve_dep "$slug" "$dep" >/dev/null 2>&1 || add_problem "$f" "depends_on references unresolvable task/issue: $dep"
    done
  done

  m="$d/mapping.json"
  if [ -f "$m" ]; then
    if ! jq_valid "$m"; then
      add_problem "$m" "mapping.json does not parse as JSON"
    else
      for lid in $(jq -r '.tasks | keys[]? // empty' "$m" 2>/dev/null); do
        found=0
        for f in "$d"/tasks/*.md; do
          [ -f "$f" ] || continue
          { [ "$(fm_get "$f" local_id)" = "$lid" ] || [ "$(fm_get "$f" issue)" = "$(jq -r --arg l "$lid" '.tasks[$l].issue // empty' "$m")" ]; } && { found=1; break; }
        done
        [ "$found" -eq 1 ] || add_problem "$m" "mapping.json references task '$lid' with no matching task file"
      done
    fi
  fi
done

# whole-graph cycle check (across all epics)
cyc=""
nodes_f="$(mktemp)"; edges_f="$(mktemp)"; unresolved_f="$(mktemp)"
build_graph "" "$nodes_f" "$edges_f" "$unresolved_f"
if [ -s "$nodes_f" ]; then
  kres="$(kahn_check "$nodes_f" "$edges_f")" || cyc="${kres#CYCLE }"
fi
rm -f "$nodes_f" "$edges_f" "$unresolved_f"
[ -n "$cyc" ] && add_problem "(graph)" "dependency cycle: $cyc"

ok=1; [ -s "$problems" ] && ok=0

if [ "$as_json" -eq 1 ]; then
  out="["
  first=1
  while IFS=$'\t' read -r file msg; do
    [ -n "$file" ] || continue
    obj="$(jq -nc --arg file "$file" --arg message "$msg" '{file:$file, message:$message}')"
    [ "$first" -eq 1 ] || out="$out,"
    out="$out$obj"; first=0
  done < "$problems"
  out="$out]"
  jq -nc --argjson ok "$([ "$ok" -eq 1 ] && printf true || printf false)" --argjson issues "$out" '{ok:$ok, issues:$issues}'
else
  if [ "$ok" -eq 1 ]; then
    printf 'state-lint: OK\n'
  else
    while IFS=$'\t' read -r file msg; do
      [ -n "$file" ] || continue
      printf '%s: %s\n' "$file" "$msg"
    done < "$problems"
  fi
fi

[ "$ok" -eq 1 ]
