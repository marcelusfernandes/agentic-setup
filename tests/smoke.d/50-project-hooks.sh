#!/usr/bin/env bash
# Smoke tests for assets/project-hooks/*.sh (architecture.md §10.3 items 7-8).
# These scripts are standalone (no plugin lib) — invoked exactly as they run in a target
# project: stdin JSON, CLAUDE_PROJECT_DIR set, jq + coreutils only.
. "$(dirname "$0")/../lib.sh"

HOOKS="$PLUGIN_ROOT/assets/project-hooks"

seed_profile() {
  # seed_profile <repo> -- copies the known-good node profile fixture in
  mkdir -p "$1/.claude/agentic"
  cp "$PLUGIN_ROOT/tests/fixtures/profile-node.json" "$1/.claude/agentic/project-profile.json"
}
set_profile_field() {
  # set_profile_field <repo> <jq-filter>
  local tmp
  tmp="$(mktemp "$TMP_BASE/prof.XXXXXX")"
  jq "$2" "$1/.claude/agentic/project-profile.json" > "$tmp" && mv "$tmp" "$1/.claude/agentic/project-profile.json"
}

# ================= item 7: format-on-edit.sh =================
R="$(make_repo)"
seed_profile "$R"
mkdir -p "$R/src"
printf 'export const x = 1;\n' > "$R/src/demo.ts"

BIN="$(mktemp -d "$TMP_BASE/bin.XXXXXX")"
cat > "$BIN/prettier" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$PRETTIER_ARGV_LOG"
exit 0
EOF
chmod +x "$BIN/prettier"

t_begin "format-on-edit: invokes the formatter with the edited file's path"
ARGV_LOG="$R/argv.log"
printf '{"tool_input":{"file_path":"%s/src/demo.ts"}}' "$R" \
  | PATH="$BIN:$PATH" CLAUDE_PROJECT_DIR="$R" PRETTIER_ARGV_LOG="$ARGV_LOG" bash "$HOOKS/format-on-edit.sh" >/dev/null
if [ -f "$ARGV_LOG" ] && grep -qF "$R/src/demo.ts" "$ARGV_LOG"; then t_ok; else t_fail "formatter not invoked with the file path"; fi

t_begin "format-on-edit: commands.format null -> exit 0, no output"
set_profile_field "$R" '.commands.format = null'
OUT="$(printf '{"tool_input":{"file_path":"%s/src/demo.ts"}}' "$R" | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/format-on-edit.sh")"
RC=$?
if [ "$RC" -eq 0 ] && [ -z "$OUT" ]; then t_ok; else t_fail "expected silent exit 0, got rc=$RC out=[$OUT]"; fi

t_begin "format-on-edit: missing formatter binary -> exit 0 + systemMessage"
seed_profile "$R"
set_profile_field "$R" '.commands.format = "prettier-nonexistent-xyz --write {file}"'
OUT="$(printf '{"tool_input":{"file_path":"%s/src/demo.ts"}}' "$R" | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/format-on-edit.sh")"
RC=$?
if [ "$RC" -eq 0 ]; then assert_contains "$OUT" "systemMessage"; else t_fail "exit $RC != 0"; fi

# ================= item 8: guard-secrets.sh =================
seed_profile "$R"

t_begin "guard-secrets: denies a write to .env"
OUT="$(printf '{"tool_input":{"file_path":"%s/.env"}}' "$R" | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/guard-secrets.sh")"
assert_eq "deny" "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // empty')"

t_begin "guard-secrets: allows a write to .env.example (negated glob)"
OUT="$(printf '{"tool_input":{"file_path":"%s/.env.example"}}' "$R" | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/guard-secrets.sh")"
if [ -z "$OUT" ]; then t_ok; else t_fail "expected no output, got: $OUT"; fi

t_begin "guard-secrets: denies anything under .git/"
OUT="$(printf '{"tool_input":{"file_path":"%s/.git/config"}}' "$R" | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/guard-secrets.sh")"
assert_eq "deny" "$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // empty')"

t_begin "guard-secrets: allows an ordinary source file"
OUT="$(printf '{"tool_input":{"file_path":"%s/src/demo.ts"}}' "$R" | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/guard-secrets.sh")"
if [ -z "$OUT" ]; then t_ok; else t_fail "expected no output, got: $OUT"; fi

# ================= test-gate.sh (Stop, opt-in) =================
seed_profile "$R"
set_profile_field "$R" '.commands.test = "false"'

t_begin "test-gate: stop_hook_active true -> no output (loop guard)"
OUT="$(printf '{"stop_hook_active":true}' | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/test-gate.sh")"
if [ -z "$OUT" ]; then t_ok; else t_fail "expected no output, got: $OUT"; fi

t_begin "test-gate: failing test command -> decision block"
OUT="$(printf '{"stop_hook_active":false}' | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/test-gate.sh")"
assert_eq "block" "$(printf '%s' "$OUT" | jq -r '.decision // empty')"

t_begin "test-gate: commands.test null -> no output"
set_profile_field "$R" '.commands.test = null'
OUT="$(printf '{"stop_hook_active":false}' | CLAUDE_PROJECT_DIR="$R" bash "$HOOKS/test-gate.sh")"
if [ -z "$OUT" ]; then t_ok; else t_fail "expected no output, got: $OUT"; fi

t_summary "50-project-hooks"
