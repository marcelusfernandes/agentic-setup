#!/usr/bin/env bash
# streams.sh <issue> [list|get <id>|set <id> <field> <json-value>|init <id> <name> <files-json>]
# Manages .claude/agentic/runtime/streams/<issue>/<id>.json (schema: architecture §6.6).
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: streams.sh <issue> list
       streams.sh <issue> get <stream-id>
       streams.sh <issue> set <stream-id> <field> <json-value>
       streams.sh <issue> init <stream-id> <name> <files-owned-json-array>
       streams.sh <issue> write <stream-id>        # JSON object on stdin, merged into the file
EOF
}

[ $# -ge 1 ] || { usage; exit 1; }
[ "$1" = "--help" ] || [ "$1" = "-h" ] && { usage; exit 0; }

issue="$1"; shift
[ $# -ge 1 ] || { usage; exit 1; }
cmd="$1"; shift

dir="$(runtime_dir)/streams/$issue"
mkdir -p "$dir"

case "$cmd" in
  list)
    for f in "$dir"/*.json; do
      [ -f "$f" ] || continue
      jq -c . "$f"
    done
    ;;
  get)
    id="${1:-}"; [ -n "$id" ] || die "get: stream id required"
    f="$dir/$id.json"
    [ -f "$f" ] || die "no such stream: $issue/$id"
    jq -c . "$f"
    ;;
  set)
    id="${1:-}"; field="${2:-}"; value="${3:-}"
    [ -n "$id" ] && [ -n "$field" ] && [ $# -ge 3 ] || die "set: <stream-id> <field> <json-value> required"
    f="$dir/$id.json"
    [ -f "$f" ] || die "no such stream: $issue/$id"
    tmp="$(mktemp)"
    jq --argjson v "$value" ".$field = \$v" "$f" > "$tmp" 2>/dev/null || {
      rm -f "$tmp"; jq --arg v "$value" ".$field = \$v" "$f" > "$tmp"
    }
    mv "$tmp" "$f"
    ;;
  write)
    # write <stream-id>: JSON object on stdin is merged over the existing file (created if absent)
    id="${1:-}"; [ -n "$id" ] || die "write: stream id required"
    f="$dir/$id.json"
    incoming="$(cat)"
    printf '%s' "$incoming" | jq -e 'type=="object"' >/dev/null 2>&1 || die "write: stdin must be a JSON object"
    tmp="$(mktemp)"
    if [ -f "$f" ]; then
      printf '%s' "$incoming" | jq -s --slurpfile cur "$f" '$cur[0] * .[0]' > "$tmp"
    else
      printf '%s' "$incoming" | jq --argjson issue "$issue" --arg stream "$id" --arg now "$(date_utc)" \
        '{issue:$issue, stream:$stream, status:"running", started_at:$now, ended_at:null, files_owned:[], files_touched:[], commits:[], tests:{command:null,result:null}, summary:"", blocked_on:null} * .' > "$tmp"
    fi
    mv "$tmp" "$f"
    jq -c . "$f"
    ;;
  init)
    id="${1:-}"; name="${2:-}"; files="${3:-[]}"
    [ -n "$id" ] && [ -n "$name" ] || die "init: <stream-id> <name> <files-json> required"
    f="$dir/$id.json"
    jq -n --argjson issue "$issue" --arg stream "$id" --arg name "$name" --argjson files "$files" --arg now "$(date_utc)" '{
      issue: $issue, stream: $stream, name: $name, status: "running",
      started_at: $now, ended_at: null,
      files_owned: $files, files_touched: [],
      commits: [], tests: {command: null, result: null},
      summary: "", blocked_on: null
    }' > "$f"
    printf '%s\n' "$f"
    ;;
  --help|-h) usage ;;
  *) usage; die "unknown subcommand: $cmd" ;;
esac
