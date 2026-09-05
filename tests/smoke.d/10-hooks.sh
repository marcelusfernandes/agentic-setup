#!/usr/bin/env bash
# smoke: hooks/hooks.json wiring + scripts/hooks/{session-start,guard-bash}.sh + manifest version match.
# Covers architecture.md §10.3 items 1-6 and 13, plus the extra guard-bash cases the
# builder brief calls out explicitly.
. "$(dirname "$0")/../lib.sh"

HOOKS_DIR="$PLUGIN_ROOT/scripts/hooks"
FIX="$PLUGIN_ROOT/tests/fixtures"

# check_cmd <command-text> <repo> -> runs guard-bash.sh with a synthetic PreToolUse
# fixture for <command-text>; sets HOOK_OUT/HOOK_RC like run_hook does.
check_cmd() {
  local cmd="$1" repo="$2" esc json
  esc=$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')
  json=$(printf '{"session_id":"t","transcript_path":"/dev/null","cwd":"%s","permission_mode":"default","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"%s"},"tool_use_id":"t"}' "$repo" "$esc")
  HOOK_RC=0
  HOOK_OUT=$(cd "$repo" && printf '%s' "$json" | bash "$HOOKS_DIR/guard-bash.sh" 2>/dev/null) || HOOK_RC=$?
}

decision_of() {
  # decision_of <json> -> .hookSpecificOutput.permissionDecision, or "" on parse failure
  printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // empty' 2>/dev/null
}

# ---------- 1. session-start: no .claude/agentic -> silent, exit 0 ----------
t_begin "session-start: no state tree -> silent"
REPO1=$(make_repo)
run_hook "$HOOKS_DIR/session-start.sh" "$FIX/hook-sessionstart.json" "$REPO1"
if [ "$HOOK_RC" = 0 ] && [ -z "$HOOK_OUT" ]; then t_ok; else t_fail "rc=$HOOK_RC out=[$HOOK_OUT]"; fi

# ---------- 2. session-start: seeded state -> valid JSON w/ non-empty, <=1200-char,
#              epic-slug-bearing additionalContext ----------
t_begin "session-start: seeded state -> additionalContext"
REPO2=$(make_repo)
seed_state "$REPO2"
run_hook "$HOOKS_DIR/session-start.sh" "$FIX/hook-sessionstart.json" "$REPO2"
ok=false; ctx=""; len=0
if [ "$HOOK_RC" = 0 ] && printf '%s' "$HOOK_OUT" | jq -e . >/dev/null 2>&1; then
  ctx=$(printf '%s' "$HOOK_OUT" | jq -r '.hookSpecificOutput.additionalContext // empty')
  len=${#ctx}
  if [ -n "$ctx" ] && [ "$len" -le 1200 ]; then
    case "$ctx" in *demo-epic*) ok=true ;; esac
  fi
fi
if [ "$ok" = true ]; then t_ok; else t_fail "rc=$HOOK_RC len=$len ctx=[$ctx]"; fi

# ---------- 3. guard-bash: git push --force origin main -> deny ----------
t_begin "guard-bash: git push --force origin main -> deny"
REPO3=$(make_repo)
run_hook "$HOOKS_DIR/guard-bash.sh" "$FIX/hook-pretooluse-forcepush.json" "$REPO3"
dec=""
[ "$HOOK_RC" = 0 ] && dec=$(decision_of "$HOOK_OUT")
assert_eq "deny" "$dec"

# ---------- 4. guard-bash: git status -> silent ----------
t_begin "guard-bash: git status -> silent"
run_hook "$HOOKS_DIR/guard-bash.sh" "$FIX/hook-pretooluse-safe.json" "$REPO3"
if [ "$HOOK_RC" = 0 ] && [ -z "$HOOK_OUT" ]; then t_ok; else t_fail "rc=$HOOK_RC out=[$HOOK_OUT]"; fi

# ---------- 5. guard-bash: git worktree remove --force -> ask ----------
t_begin "guard-bash: git worktree remove --force -> ask"
check_cmd "git worktree remove --force .worktrees/123-x" "$REPO3"
dec=""
[ "$HOOK_RC" = 0 ] && dec=$(decision_of "$HOOK_OUT")
assert_eq "ask" "$dec"

# ---------- 6. guard-bash: malformed stdin -> exit 0, no output (fail open) ----------
t_begin "guard-bash: malformed stdin -> silent, exit 0"
HOOK_RC=0
HOOK_OUT=$(cd "$REPO3" && printf 'not json' | bash "$HOOKS_DIR/guard-bash.sh" 2>/dev/null) || HOOK_RC=$?
if [ "$HOOK_RC" = 0 ] && [ -z "$HOOK_OUT" ]; then t_ok; else t_fail "rc=$HOOK_RC out=[$HOOK_OUT]"; fi

t_begin "session-start: malformed stdin -> silent, exit 0"
HOOK_RC=0
HOOK_OUT=$(cd "$REPO3" && printf 'not json' | bash "$HOOKS_DIR/session-start.sh" 2>/dev/null) || HOOK_RC=$?
if [ "$HOOK_RC" = 0 ] && [ -z "$HOOK_OUT" ]; then t_ok; else t_fail "rc=$HOOK_RC out=[$HOOK_OUT]"; fi

# ---------- extra: --force-with-lease is never denied ----------
t_begin "guard-bash: git push --force-with-lease origin feat/x -> silent"
check_cmd "git push --force-with-lease origin feat/x" "$REPO3"
if [ "$HOOK_RC" = 0 ] && [ -z "$HOOK_OUT" ]; then t_ok; else t_fail "rc=$HOOK_RC out=[$HOOK_OUT]"; fi

# ---------- extra: git push origin HEAD:main -> deny (protected branch, HEAD: shorthand,
#            regardless of --force — per architecture.md §5.1.2 row 2) ----------
t_begin "guard-bash: git push origin HEAD:main -> deny"
check_cmd "git push origin HEAD:main" "$REPO3"
dec=""
[ "$HOOK_RC" = 0 ] && dec=$(decision_of "$HOOK_OUT")
assert_eq "deny" "$dec"

# ---------- extra: rm -rf .worktrees/123 -> deny ----------
t_begin "guard-bash: rm -rf .worktrees/123 -> deny"
check_cmd "rm -rf .worktrees/123" "$REPO3"
dec=""
[ "$HOOK_RC" = 0 ] && dec=$(decision_of "$HOOK_OUT")
assert_eq "deny" "$dec"

# ---------- extra: git branch -D x -> ask ----------
t_begin "guard-bash: git branch -D x -> ask"
check_cmd "git branch -D x" "$REPO3"
dec=""
[ "$HOOK_RC" = 0 ] && dec=$(decision_of "$HOOK_OUT")
assert_eq "ask" "$dec"

# ---------- extra: plain non-force push to a protected branch is not our concern ----------
t_begin "guard-bash: git push origin main (no force) -> silent"
check_cmd "git push origin main" "$REPO3"
if [ "$HOOK_RC" = 0 ] && [ -z "$HOOK_OUT" ]; then t_ok; else t_fail "rc=$HOOK_RC out=[$HOOK_OUT]"; fi

# ---------- 13. plugin.json / marketplace.json parse and versions match ----------
t_begin "plugin.json parses"
assert_exit 0 jq -e . "$PLUGIN_ROOT/.claude-plugin/plugin.json"

t_begin "marketplace.json parses"
assert_exit 0 jq -e . "$PLUGIN_ROOT/.claude-plugin/marketplace.json"

t_begin "plugin.json version == marketplace.json plugins[0].version"
pv=$(jq -r '.version' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null)
mv=$(jq -r '.plugins[0].version' "$PLUGIN_ROOT/.claude-plugin/marketplace.json" 2>/dev/null)
assert_eq "$pv" "$mv"

t_summary "10-hooks"
