#!/usr/bin/env bash
# Smoke tests for scripts/detect/*.sh against tests/projects/* fixtures.
# Fixtures are copied into a fresh, non-git temp dir first: they live inside this repo's own
# git tree as plain files, and `git ls-files` (which the extension census relies on) only sees
# tracked/staged content — copying to a non-git dir also exercises the `find`-based fallback
# that scan.sh/languages.sh must use outside a git repo.
. "$(dirname "$0")/../lib.sh"

DETECT="$PLUGIN_ROOT/scripts/detect"
FIXTURES="$PLUGIN_ROOT/tests/projects"

# Fixtures are copied OUTSIDE this repo's working tree (plain system mktemp, not under
# $TMP_BASE — that lives inside the plugin's own git tree, so `git ls-files` there would see
# the outer repo's index and miss these untracked fixture files entirely).
FX_DIRS=""
copy_fixture() {
  local name="$1" dst
  dst=$(mktemp -d)
  cp -r "$FIXTURES/$name/." "$dst/"
  FX_DIRS="$FX_DIRS $dst"
  printf '%s\n' "$dst"
}
cleanup_fixtures() { local d; for d in $FX_DIRS; do rm -rf "$d"; done; }
trap cleanup_fixtures EXIT

# ---------------- node-pnpm ----------------
NP="$(copy_fixture node-pnpm)"
OUT="$(bash "$DETECT/scan.sh" --root "$NP")"

t_begin "scan.sh node-pnpm: emits valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then t_ok; else t_fail "invalid json: $OUT"; fi

t_begin "scan.sh node-pnpm: package_manager.name == pnpm"
assert_eq "pnpm" "$(printf '%s' "$OUT" | jq -r '.package_manager.name')"

t_begin "scan.sh node-pnpm: commands.test resolves to a vitest invocation"
assert_contains "$(printf '%s' "$OUT" | jq -r '.commands.test')" "vitest run"

t_begin "scan.sh node-pnpm: commands.format contains prettier"
assert_contains "$(printf '%s' "$OUT" | jq -r '.commands.format')" "prettier"

t_begin "scan.sh node-pnpm: commands.typecheck contains tsc"
assert_contains "$(printf '%s' "$OUT" | jq -r '.commands.typecheck')" "tsc"

t_begin "scan.sh node-pnpm: languages[0].name == typescript"
assert_eq "typescript" "$(printf '%s' "$OUT" | jq -r '.languages[0].name')"

# ---------------- python-uv ----------------
PU="$(copy_fixture python-uv)"
OUT="$(bash "$DETECT/scan.sh" --root "$PU")"

t_begin "scan.sh python-uv: emits valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then t_ok; else t_fail "invalid json: $OUT"; fi

t_begin "scan.sh python-uv: package_manager.name == uv"
assert_eq "uv" "$(printf '%s' "$OUT" | jq -r '.package_manager.name')"

t_begin "scan.sh python-uv: commands.test contains pytest"
assert_contains "$(printf '%s' "$OUT" | jq -r '.commands.test')" "pytest"

t_begin "scan.sh python-uv: commands.format contains ruff format"
assert_contains "$(printf '%s' "$OUT" | jq -r '.commands.format')" "ruff format"

# ---------------- go-mod ----------------
GM="$(copy_fixture go-mod)"
OUT="$(bash "$DETECT/scan.sh" --root "$GM")"

t_begin "scan.sh go-mod: emits valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then t_ok; else t_fail "invalid json: $OUT"; fi

t_begin "scan.sh go-mod: package_manager.name == go"
assert_eq "go" "$(printf '%s' "$OUT" | jq -r '.package_manager.name')"

t_begin "scan.sh go-mod: commands.test == go test ./..."
assert_eq "go test ./..." "$(printf '%s' "$OUT" | jq -r '.commands.test')"

t_begin "scan.sh go-mod: commands.lint contains golangci-lint"
assert_contains "$(printf '%s' "$OUT" | jq -r '.commands.lint')" "golangci-lint"

# ---------------- claude-config.sh sentinel detection ----------------
CR="$(mktemp -d)"; FX_DIRS="$FX_DIRS $CR"
cat > "$CR/CLAUDE.md" <<'EOF'
# Demo project

Some notes a human wrote.

<!-- BEGIN agentic-git -->
generated section
<!-- END agentic-git -->
EOF

t_begin "claude-config.sh: has_sentinel true when CLAUDE.md carries the marker"
assert_eq "true" "$(bash "$DETECT/claude-config.sh" --root "$CR" | jq -r '.claude_md.has_sentinel')"

t_begin "claude-config.sh: has_sentinel false / claude_md null when absent"
CR2="$(mktemp -d)"; FX_DIRS="$FX_DIRS $CR2"
assert_eq "null" "$(bash "$DETECT/claude-config.sh" --root "$CR2" | jq -c '.claude_md')"

# ---------------- unrecognized project ----------------
EMPTY="$(mktemp -d)"; FX_DIRS="$FX_DIRS $EMPTY"
touch "$EMPTY/README.md"
OUT="$(bash "$DETECT/scan.sh" --root "$EMPTY")"

t_begin "scan.sh on an unrecognized project: still valid JSON"
if printf '%s' "$OUT" | jq -e . >/dev/null 2>&1; then t_ok; else t_fail "invalid json: $OUT"; fi

t_begin "scan.sh on an unrecognized project: package_manager.name is null"
assert_eq "null" "$(printf '%s' "$OUT" | jq -c '.package_manager.name')"

t_begin "scan.sh on an unrecognized project: commands.test is null (never guessed)"
assert_eq "null" "$(printf '%s' "$OUT" | jq -c '.commands.test')"

t_summary "40-detect"
