#!/usr/bin/env bash
# agentic-git project hook — Stop test-gate, opt-in (architecture.md §5.3.3).
# Copied INTO the target project by `adopt --enable-test-gate` only. Standalone: no plugin
# lib, jq + coreutils only. Runs profile.commands.test; blocks the Stop with the failure on
# non-zero exit. Guards against infinite loops via stop_hook_active. Always exits 0.
set -uo pipefail

input="$(cat)"

stop_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)
[ "$stop_active" = "true" ] && exit 0

find_profile_up() {
  local dir="$1" candidate
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    candidate="$dir/.claude/agentic/project-profile.json"
    if [ -f "$candidate" ]; then printf '%s\n' "$candidate"; return 0; fi
    dir=$(dirname "$dir")
  done
  return 1
}

profile=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/.claude/agentic/project-profile.json" ]; then
  profile="$CLAUDE_PROJECT_DIR/.claude/agentic/project-profile.json"
else
  profile=$(find_profile_up "$PWD" 2>/dev/null)
fi
[ -n "$profile" ] && [ -f "$profile" ] || exit 0

merged() { jq 'del(.overrides) * (.overrides // {})' "$profile" 2>/dev/null; }

cmd=$(merged | jq -r '.commands.test // empty' 2>/dev/null)
[ -n "$cmd" ] || exit 0

project_dir=$(dirname "$(dirname "$(dirname "$profile")")")
cwd=$(merged | jq -r '.command_cwd // "."' 2>/dev/null)
[ -n "$cwd" ] || cwd="."
run_dir="$project_dir/$cwd"
[ -d "$run_dir" ] || run_dir="$project_dir"

out=$(cd "$run_dir" && eval "$cmd" 2>&1)
rc=$?
if [ "$rc" -ne 0 ]; then
  first20=$(printf '%s\n' "$out" | head -20)
  printf '%s' "$first20" | jq -Rs '{"decision":"block","reason":("tests are failing: " + .)}'
fi
exit 0
