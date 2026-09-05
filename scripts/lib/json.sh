#!/usr/bin/env bash
# agentic-git — jq guard + tiny JSON helpers.  Source after common.sh.
require_cmd jq "macOS: brew install jq | Debian/Ubuntu: sudo apt-get install jq | Fedora: sudo dnf install jq"

jq_valid() { jq -e . "$1" >/dev/null 2>&1; }   # jq_valid file -> exit 0 when parseable

json_obj() {
  # json_obj key value [key value ...]  -> {"key":"value",...} with all values as strings
  local args=() k v
  while [ $# -ge 2 ]; do k="$1"; v="$2"; shift 2; args+=(--arg "$k" "$v"); done
  jq -nc "${args[@]}" '$ARGS.named'
}
