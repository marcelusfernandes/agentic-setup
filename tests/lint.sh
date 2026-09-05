#!/usr/bin/env bash
# agentic-git — tests/lint.sh (architecture.md §10.2)
#
#   1. shellcheck -x -s bash over scripts/**/*.sh and assets/project-hooks/*.sh (if installed)
#   2. bash-3.2 bashism denylist grep over the same file set
#   3. hardcoded stack-command denylist grep over skills/ agents/ scripts/
#      (excluding scripts/detect, assets/, tests/ — the design's named exceptions)
#   4. `gh` usage outside scripts/host/github/, scripts/state/status.sh, scripts/validate/doctor.sh
#   5. plugin.json version == marketplace.json plugins[0].version
#   6. every scripts/**/*.sh is executable
#
# Exit non-zero on any finding; each finding is printed as "file:line: message".
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/.." && pwd -P)"
cd "$ROOT" || exit 1

findings=0
report() { printf '%s:%s: %s\n' "$1" "${2:-0}" "$3"; findings=$((findings + 1)); }

sh_files() {
  local d
  for d in scripts assets/project-hooks; do
    [ -d "$d" ] || continue
    find "$d" -type f -name '*.sh' 2>/dev/null
  done
}
ALL_SH_FILES=$(sh_files)

# ---------- 1. shellcheck ----------
if command -v shellcheck >/dev/null 2>&1; then
  if [ -n "$ALL_SH_FILES" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      out=$(shellcheck -x -s bash -f gcc "$f" 2>&1) || true
      if [ -n "$out" ]; then
        while IFS= read -r scl; do
          [ -n "$scl" ] || continue
          printf '%s\n' "$scl"
          findings=$((findings + 1))
        done <<SC
$out
SC
      fi
    done <<FILES
$ALL_SH_FILES
FILES
  fi
else
  printf 'lint: shellcheck not installed — skipping shellcheck pass\n' >&2
fi

# ---------- 2. bashism denylist ----------
# check_bashism <ERE> <message> [skip-glob-pattern]
# ERE avoids \b / \< \> (GNU-only) — every boundary is spelled out as a character class
# so this also runs correctly under BSD grep (macOS).
is_comment_line() {
  # 0 (true) when the line, once leading whitespace is stripped, starts with '#'.
  local trimmed
  trimmed=$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//')
  case "$trimmed" in '#'*) return 0 ;; esac
  return 1
}

check_bashism() {
  local pat="$1" msg="$2" skip="${3:-}" f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ -n "$skip" ]; then
      case "$f" in $skip) continue ;; esac
    fi
    while IFS=: read -r line content; do
      [ -n "$line" ] || continue
      is_comment_line "$content" && continue
      report "$f" "$line" "$msg"
    done <<GREP
$(grep -nE "$pat" "$f" 2>/dev/null)
GREP
  done <<FILES
$ALL_SH_FILES
FILES
}

check_bashism 'declare[[:space:]]+-A' \
  "bashism: declare -A (associative array) — use parallel arrays or a jq temp file"
check_bashism '\$\{[A-Za-z_][A-Za-z0-9_]*(\^\^|,,)\}' \
  "bashism: \${var^^}/\${var,,} — use tr '[:lower:]' '[:upper:]'"
check_bashism '(^|[^A-Za-z0-9_])(mapfile|readarray)([^A-Za-z0-9_]|$)' \
  "bashism: mapfile/readarray — use: while IFS= read -r line; do ...; done < file"
check_bashism 'shopt[[:space:]]+-s[[:space:]]+globstar|\*\*/' \
  "bashism: globstar (**) — use find or git ls-files"
check_bashism '(^|[^A-Za-z0-9_])echo[[:space:]]+-[en]([[:space:]]|$)' \
  "bashism: echo -e/-n — use printf"
check_bashism '(^|[^A-Za-z0-9_])sed[[:space:]]+-i([[:space:]]|$)' \
  "bashism: bare sed -i — use sed_inplace or sed -i.bak ... && rm -f *.bak"
check_bashism '(^|[^A-Za-z0-9_])readlink[[:space:]]+-f([^A-Za-z0-9_]|$)' \
  "bashism: readlink -f — use realpath_portable()"
check_bashism '(^|[^A-Za-z0-9_])date[[:space:]]+-d([^A-Za-z0-9_]|$)|date[[:space:]]+\+%s%N' \
  "bashism: date -d / date +%s%N — use date_utc() only"
check_bashism '(^|[^A-Za-z0-9_])grep[[:space:]]+-P([^A-Za-z0-9_]|$)' \
  "bashism: grep -P — use grep -E"
check_bashism '(^|[^A-Za-z0-9_])sha1sum([^A-Za-z0-9_]|$)' \
  "bashism: sha1sum direct — use sha1_portable()" 'scripts/lib/common.sh'
check_bashism '(^|[^A-Za-z0-9_])timeout([^A-Za-z0-9_]|$)' \
  "bashism: timeout — not available on stock macOS; never use in hook scripts"
check_bashism '(^|[^A-Za-z0-9_])local[[:space:]]+-n([^A-Za-z0-9_]|$)' \
  "bashism: local -n (nameref) — not portable to bash 3.2"

# ---------- 3. hardcoded stack-command denylist ----------
# Allowed only in references/stack-matrix.md, scripts/detect/*, assets/project-hooks/*, tests/.
STACK_TERMS='npm[[:space:]]+test
npm[[:space:]]+run
pnpm[[:space:]]+test
yarn[[:space:]]+test
pytest
cargo[[:space:]]+test
cargo[[:space:]]+build
go[[:space:]]+test
mvn
gradle
bundle[[:space:]]+exec
mix[[:space:]]+test'

scan_stack_commands() {
  local d f term pat
  for d in skills agents scripts; do
    [ -d "$d" ] || continue
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      case "$f" in
        scripts/detect/*) continue ;;
        assets/*) continue ;;
        tests/*) continue ;;
      esac
      while IFS= read -r term; do
        [ -n "$term" ] || continue
        pat="(^|[^A-Za-z0-9_-])${term}([^A-Za-z0-9_-]|\$)"
        while IFS=: read -r line _rest; do
          [ -n "$line" ] || continue
          report "$f" "$line" "hardcoded stack command '$term' — read profile_cmd/profile_get instead"
        done <<GREP
$(grep -nE "$pat" "$f" 2>/dev/null)
GREP
      done <<TERMS
$STACK_TERMS
TERMS
    done <<FILES
$(find "$d" -type f 2>/dev/null)
FILES
  done
}
scan_stack_commands

# ---------- 4. `gh` usage outside the allowed callers ----------
scan_gh_usage() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      scripts/host/github/*) continue ;;
      scripts/host.sh) continue ;;
      scripts/state/status.sh) continue ;;
      scripts/validate/doctor.sh) continue ;;
    esac
    while IFS=: read -r line content; do
      [ -n "$line" ] || continue
      case "$content" in
        [[:space:]]\#*|\#*) continue ;;
      esac
      report "$f" "$line" "gh invoked outside scripts/host/github/ — call scripts/host.sh <verb> instead"
    done <<GREP
$(grep -nE '(^|[^A-Za-z0-9_])gh[[:space:]]' "$f" 2>/dev/null)
GREP
  done <<FILES
$(find scripts -type f -name '*.sh' 2>/dev/null)
FILES
}
scan_gh_usage

# ---------- 5. plugin.json / marketplace.json version match ----------
check_versions() {
  if [ ! -f .claude-plugin/plugin.json ]; then
    report ".claude-plugin/plugin.json" 0 "missing"
    return
  fi
  if [ ! -f .claude-plugin/marketplace.json ]; then
    report ".claude-plugin/marketplace.json" 0 "missing"
    return
  fi
  if ! command -v jq >/dev/null 2>&1; then
    report ".claude-plugin" 0 "jq not installed — cannot verify plugin.json/marketplace.json version match"
    return
  fi
  local pv mv
  pv=$(jq -r '.version' .claude-plugin/plugin.json 2>/dev/null)
  mv=$(jq -r '.plugins[0].version' .claude-plugin/marketplace.json 2>/dev/null)
  [ "$pv" = "$mv" ] || report ".claude-plugin/marketplace.json" 0 "version mismatch: plugin.json=$pv marketplace.json=$mv"
}
check_versions

# ---------- 6. every scripts/**/*.sh is executable ----------
check_executable() {
  local f
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -x "$f" ] || report "$f" 0 "not executable — chmod +x"
  done <<FILES
$(find scripts -type f -name '*.sh' 2>/dev/null)
FILES
}
check_executable

if [ "$findings" -gt 0 ]; then
  printf '\nlint: %d finding(s)\n' "$findings"
  exit 1
fi
printf 'lint: clean\n'
exit 0
