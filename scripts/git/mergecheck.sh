#!/usr/bin/env bash
# mergecheck.sh <base-ref> <head-ref> [--json]
# In-memory merge dry run via `git merge-tree --write-tree` (git >= 2.38). Touches nothing:
# no working tree, index, or HEAD change. Exit 0 clean, 1 conflicts, >=2 error (raw output shown).
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() { printf 'Usage: mergecheck.sh <base-ref> <head-ref> [--json]\n'; }

as_json=0
args=()
for a in "$@"; do
  case "$a" in
    --json) as_json=1 ;;
    --help|-h) usage; exit 0 ;;
    *) args+=("$a") ;;
  esac
done
[ "${#args[@]}" -eq 2 ] || { usage; exit 1; }
base="${args[0]}"; head="${args[1]}"

gv="$(git_version)"
if [ -z "$gv" ] || ! version_ge "$gv" "2.38"; then
  printf 'ERROR: git %s is older than 2.38 — merge-tree --write-tree is unavailable.\n' "${gv:-unknown}" >&2
  exit 4
fi

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
out="$(git merge-tree --write-tree "$base" "$head" 2>"$tmp/stderr")" && rc=0 || rc=$?

if [ "$rc" -ge 2 ]; then
  printf 'ERROR: git merge-tree could not be attempted (exit %s):\n' "$rc" >&2
  printf '%s\n' "$out" >&2
  cat "$tmp/stderr" >&2
  if [ "$as_json" -eq 1 ]; then
    jq -nc --arg out "$out" --arg err "$(cat "$tmp/stderr")" '{clean:false, tree:null, conflicts:[], messages:[$out,$err] | map(select(length>0))}'
  fi
  exit "$rc"
fi

: > "$tmp/tree.txt"; : > "$tmp/conf.txt"; : > "$tmp/msg.txt"
awk -v treef="$tmp/tree.txt" -v conf="$tmp/conf.txt" -v msgf="$tmp/msg.txt" '
  BEGIN { state = 0 }
  {
    if ($0 == "") { state++; next }
    if (state == 0) print $0 > treef
    else if (state == 1) print $0 > conf
    else print $0 > msgf
  }
' <<EOF
$out
EOF

tree="$(head -n1 "$tmp/tree.txt" 2>/dev/null || true)"
conflicts="$(awk -F'\t' 'NF>1{print $2; next} {print $NF}' "$tmp/conf.txt" 2>/dev/null | sed '/^$/d' | sort -u)"

if [ "$rc" -eq 0 ]; then
  if [ "$as_json" -eq 1 ]; then
    jq -nc --arg tree "$tree" '{clean:true, tree:$tree, conflicts:[], messages:[]}'
  else
    printf 'clean: %s merges into %s (tree %s)\n' "$head" "$base" "$tree"
  fi
  exit 0
fi

# rc == 1: conflicts
if [ "$as_json" -eq 1 ]; then
  conf_json="$(printf '%s\n' "$conflicts" | sed '/^$/d' | jq -R . | jq -sc .)"
  msg_json="$(jq -R . "$tmp/msg.txt" 2>/dev/null | jq -sc .)"
  jq -nc --arg tree "$tree" --argjson conflicts "$conf_json" --argjson messages "$msg_json" \
    '{clean:false, tree:$tree, conflicts:$conflicts, messages:$messages}'
else
  printf 'CONFLICT: %s does not merge cleanly into %s\n' "$head" "$base"
  printf '%s\n' "$conflicts" | sed '/^$/d' | sed 's/^/  /'
fi
exit 1
