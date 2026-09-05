#!/usr/bin/env bash
# ledger.sh <slug> <who> <scope> <ruling> <why> <cost-if-wrong> <reversible>
# Appends one row to .claude/agentic/epics/<slug>/ledger.md (creating the header if absent).
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  printf 'Usage: ledger.sh <epic-slug> <who> <scope> <ruling> <why> <cost-if-wrong> <reversible>\n'
  printf '       ledger.sh <epic-slug> --who W --scope S --ruling R --why Y --cost C --reversible yes|no\n'
}

[ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ] && { usage; exit 0; }
[ $# -ge 1 ] || { usage; exit 1; }
slug="$1"; shift
who=""; scope=""; ruling=""; why=""; cost=""; reversible=""
case "${1:-}" in
  --*)
    while [ $# -gt 0 ]; do
      case "$1" in
        --who) who="$2"; shift 2 ;;
        --scope) scope="$2"; shift 2 ;;
        --ruling) ruling="$2"; shift 2 ;;
        --why) why="$2"; shift 2 ;;
        --cost|--cost-if-wrong) cost="$2"; shift 2 ;;
        --reversible) reversible="$2"; shift 2 ;;
        *) die "unknown argument: $1" ;;
      esac
    done
    ;;
  *)
    [ $# -eq 6 ] || { usage; exit 1; }
    who="$1"; scope="$2"; ruling="$3"; why="$4"; cost="$5"; reversible="$6"
    ;;
esac
[ -n "$who" ] && [ -n "$ruling" ] || { usage; exit 1; }

dir="$(epic_dir "$slug")"
[ -d "$dir" ] || die "no such epic: $slug"
f="$dir/ledger.md"

esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/|/\\|/g' | tr '\n' ' '; }

if [ ! -f "$f" ]; then
  {
    printf '# Ruling ledger — %s\n\n' "$slug"
    printf '| when | who | scope | ruling | why | cost if wrong | reversible |\n'
    printf '|---|---|---|---|---|---|---|\n'
  } > "$f"
fi

printf '| %s | %s | %s | %s | %s | %s | %s |\n' \
  "$(date_utc)" "$(esc "$who")" "$(esc "$scope")" "$(esc "$ruling")" "$(esc "$why")" "$(esc "$cost")" "$(esc "$reversible")" >> "$f"
