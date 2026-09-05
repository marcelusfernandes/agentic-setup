#!/usr/bin/env bash
# agentic-git test helpers. Sourced by tests/smoke.d/*.sh (bash 3.2 compatible).
# API:
#   t_begin "name"            start a test case
#   t_ok / t_fail "msg"       record result for the current case
#   assert_eq expected actual [msg]
#   assert_contains haystack needle [msg]
#   assert_exit code cmd...   run cmd, assert its exit code
#   make_repo                 create a temp git repo with one commit; prints its path; cd into it yourself
#   seed_state <repo>         create a minimal .claude/agentic tree (config + profile + one epic with 5 tasks)
#   run_hook <script> <fixture-json> [repo]  pipe fixture (with __REPO__ substituted) into a hook script; stdout captured in $HOOK_OUT, exit in $HOOK_RC
set -u
T_TOTAL=0; T_FAILED=0; T_CUR=""
PLUGIN_ROOT="${PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)}"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
TMP_BASE="${TMP_BASE:-$PLUGIN_ROOT/tests/tmp}"
mkdir -p "$TMP_BASE"

t_begin() { T_CUR="$1"; T_TOTAL=$((T_TOTAL+1)); }
t_ok()    { printf '  ok   - %s\n' "$T_CUR"; }
t_fail()  { T_FAILED=$((T_FAILED+1)); printf '  FAIL - %s: %s\n' "$T_CUR" "${1:-}"; }
assert_eq() { if [ "$1" = "$2" ]; then t_ok; else t_fail "${3:-expected [$1] got [$2]}"; fi; }
assert_contains() { case "$1" in *"$2"*) t_ok ;; *) t_fail "${3:-missing [$2] in [$1]}" ;; esac; }
assert_exit() { local want="$1"; shift; local rc=0; "$@" >/dev/null 2>&1 || rc=$?; if [ "$rc" = "$want" ]; then t_ok; else t_fail "exit $rc != $want: $*"; fi; }

make_repo() {
  local d; d=$(mktemp -d "$TMP_BASE/repo.XXXXXX")
  ( cd "$d" && git init -q -b main . 2>/dev/null || { git init -q . && git checkout -q -b main; }
    git config user.email t@t.t && git config user.name t && git config commit.gpgsign false
    printf 'hello\n' > README.md && git add README.md && git commit -qm "init" ) >/dev/null 2>&1
  printf '%s\n' "$d"
}

seed_state() {
  local r="$1" s="$1/.claude/agentic"
  mkdir -p "$s/epics/demo-epic/tasks" "$s/runtime/streams" "$s/runtime/locks" "$s/archive"
  cat > "$s/config.json" <<'JSON'
{"schema_version":1,"host":"github","base_branch":"main","protected_branches":["main","master","develop","release/*"],
 "protected_paths":["**/migrations/**",".github/workflows/**"],"branch_template":"{type}/{issue}-{slug}",
 "epic_branch_template":"epic/{slug}","worktree_dir":".worktrees","worktree_link":[".env",".env.local",".envrc"],
 "commit_template":"{type}({scope}): {subject} (#{issue})","labels":{"marker":"agentic","epic":"epic","task":"task","status_prefix":"status:"},
 "merge_strategy":"squash","delete_branch_on_merge":true,"require_review":true,"require_ci":true,"default_reviewers":[],
 "max_tasks_per_epic":10,"max_parallel_streams":4,"worktree_mode":"auto",
 "conflict_autonomy":{"max_files":10,"max_hunks":20,"max_rebase_commits":20},"test_gate_hook":false}
JSON
  cp "$PLUGIN_ROOT/tests/fixtures/profile-node.json" "$s/project-profile.json"
  cat > "$s/epics/demo-epic/epic.md" <<'MD'
---
name: demo-epic
title: Demo epic
status: in-progress
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
progress: 0%
milestone: v1.0
github: https://github.com/o/r/issues/100
issue: 100
worktree_mode: shared
epic_branch: epic/demo-epic
shared_files: []
tasks: ["101", "102", "103", "104", "105"]
---

## Goal
Demo.
MD
  local i deps st
  for i in 101 102 103 104 105; do
    case $i in 101) deps='[]'; st=closed;; 102) deps='[]'; st=in-progress;; 103) deps='["101"]'; st=open;; 104) deps='["102"]'; st=open;; 105) deps='["103", "104"]'; st=open;; esac
    cat > "$s/epics/demo-epic/tasks/$i.md" <<MD
---
name: Task $i
type: feat
status: $st
created: 2026-01-01T00:00:00Z
updated: 2026-01-01T00:00:00Z
epic: demo-epic
local_id: "$((i-100))"
issue: $i
github: https://github.com/o/r/issues/$i
parent: 100
depends_on: $deps
conflicts_with: []
parallel: true
files:
  - src/f$i.ts
estimate: S
branch: null
worktree: null
pr: null
---

## Description
Task $i.
MD
  done
  cat > "$s/epics/demo-epic/mapping.json" <<'JSON'
{"epic_slug":"demo-epic","epic_issue":100,"epic_url":"https://github.com/o/r/issues/100","milestone":{"title":"v1.0","number":1},
 "link_mode":"native","worktree_mode":"shared","epic_branch":"epic/demo-epic",
 "tasks":{"1":{"issue":101,"state":"closed"},"2":{"issue":102,"state":"open","branch":"feat/102-task","worktree":".worktrees/102-task"},"3":{"issue":103,"state":"open"},"4":{"issue":104,"state":"open"},"5":{"issue":105,"state":"open"}},
 "updated":"2026-01-01T00:00:00Z"}
JSON
  printf '# Ruling ledger — demo-epic\n\n| when | who | scope | ruling | why | cost if wrong | reversible |\n|---|---|---|---|---|---|---|\n' > "$s/epics/demo-epic/ledger.md"
}

run_hook() {
  local script="$1" fixture="$2" repo="${3:-$PWD}" input
  input=$(sed "s|__REPO__|$repo|g" "$fixture")
  HOOK_RC=0
  HOOK_OUT=$(cd "$repo" && printf '%s' "$input" | bash "$script" 2>/dev/null) || HOOK_RC=$?
}

t_summary() {
  printf '%s: %d tests, %d failed\n' "${1:-suite}" "$T_TOTAL" "$T_FAILED"
  [ "$T_FAILED" -eq 0 ]
}
