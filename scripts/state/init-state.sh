#!/usr/bin/env bash
# init-state.sh — create the .claude/agentic state tree and config.json defaults.
# Idempotent: safe to run any number of times. Never overwrites existing config values;
# only fills in missing keys (existing wins). See references/conventions.md.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"

usage() {
  cat <<'EOF'
Usage: init-state.sh [--json]

Creates, only where absent:
  .claude/agentic/{epics,archive,runtime/streams,runtime/locks}
  .claude/agentic/.gitkeep (+ one in epics/ and archive/, so git can track them empty)
  .claude/agentic/config.json   (defaults per architecture §6.3; base_branch from the repo's default branch)

Existing config.json is never overwritten — missing keys are merged in, existing keys win.

  --base <branch>  base branch to record in config.json (default: the repo's default branch)
  --json   print a machine-readable summary of what changed instead of text lines
  --help   show this help
EOF
}

as_json=0; base_override=""
while [ $# -gt 0 ]; do
  a="$1"; shift
  case "$a" in
    --json) as_json=1 ;;
    --base) base_override="$1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $a" ;;
  esac
done

sdir="$(state_dir)"
actions=()          # human-readable log lines
note() { actions+=("$1"); }

mkdir_new() {
  if [ -d "$1" ]; then note "dir exists: $1"; else mkdir -p "$1"; note "created dir: $1"; fi
}

mkdir_new "$sdir"
mkdir_new "$sdir/epics"
mkdir_new "$sdir/archive"
mkdir_new "$sdir/runtime/streams"
mkdir_new "$sdir/runtime/locks"

touch_new() {
  if [ -f "$1" ]; then note "file exists: $1"; else : > "$1"; note "created file: $1"; fi
}
touch_new "$sdir/.gitkeep"
touch_new "$sdir/epics/.gitkeep"
touch_new "$sdir/archive/.gitkeep"

cfg="$sdir/config.json"
base="${base_override:-$(default_branch)}"
defaults_tmp="$(mktemp)"
trap 'rm -f "$defaults_tmp"' EXIT

jq -n --arg base "$base" '{
  schema_version: 1,
  host: "github",
  base_branch: $base,
  protected_branches: ["main", "master", "develop", "release/*"],
  protected_paths: ["**/migrations/**", ".github/workflows/**", "**/auth/**", "**/security/**"],
  branch_template: "{type}/{issue}-{slug}",
  epic_branch_template: "epic/{slug}",
  worktree_dir: ".worktrees",
  worktree_link: [".env", ".env.local", ".envrc"],
  commit_template: "{type}({scope}): {subject} (#{issue})",
  labels: { marker: "agentic", epic: "epic", task: "task", status_prefix: "status:" },
  merge_strategy: "squash",
  delete_branch_on_merge: true,
  require_review: true,
  require_ci: true,
  default_reviewers: [],
  max_tasks_per_epic: 10,
  max_parallel_streams: 4,
  worktree_mode: "auto",
  conflict_autonomy: { max_files: 10, max_hunks: 20, max_rebase_commits: 20 },
  test_gate_hook: false
}' > "$defaults_tmp"

if [ -f "$cfg" ]; then
  before="$(cat "$cfg")"
  json_merge_defaults "$cfg" "$defaults_tmp"
  after="$(cat "$cfg")"
  if [ "$before" = "$after" ]; then note "config.json unchanged (already complete)"
  else note "config.json: merged in missing default keys"; fi
else
  json_merge_defaults "$cfg" "$defaults_tmp"
  note "created config.json with defaults (base_branch=$base)"
fi

if [ "$as_json" -eq 1 ]; then
  printf '%s\n' "${actions[@]}" | jq -R . | jq -sc '{ok:true, state_dir:"'"$sdir"'", actions:.}'
else
  printf '%s\n' "${actions[@]}"
fi
