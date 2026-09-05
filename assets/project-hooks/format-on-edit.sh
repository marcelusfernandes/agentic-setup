#!/usr/bin/env bash
# agentic-git project hook — PostToolUse format-on-edit (architecture.md §5.3.1).
# Copied INTO the target project by `adopt`. Standalone: no plugin lib, jq + coreutils only.
# Reads the profile at runtime so changing the formatter never requires a settings.json edit.
# Must never block an edit: always exits 0, fails open on any internal error.
set -uo pipefail

input="$(cat)"

file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null)
[ -n "$file" ] || exit 0
[ -f "$file" ] || exit 0

# ---------- locate the profile ----------
# "$CLAUDE_PROJECT_DIR"/.claude/agentic/project-profile.json, falling back to a walk up from cwd
# (useful when CLAUDE_PROJECT_DIR is unset, e.g. this hook run directly for testing).
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
[ -n "$profile" ] || exit 0
[ -f "$profile" ] || exit 0

project_dir=$(dirname "$(dirname "$(dirname "$profile")")")

merged() { jq 'del(.overrides) * (.overrides // {})' "$profile" 2>/dev/null; }

cmd=$(merged | jq -r '.commands.format // empty' 2>/dev/null)
[ -n "$cmd" ] || exit 0

cwd=$(merged | jq -r '.command_cwd // "."' 2>/dev/null)
[ -n "$cwd" ] || cwd="."

# ---------- skip generated/vendored paths ----------
rel="$file"
case "$file" in
  "$project_dir"/*) rel="${file#"$project_dir"/}" ;;
esac

glob_to_regex() {
  # tiny glob->regex: escape metachars, then ** -> .*, * -> [^/]*
  printf '%s' "$1" \
    | sed -e 's/[.[\^$()+?{}|]/\\&/g' -e 's/\*\*/@@DOUBLESTAR@@/g' -e 's/\*/[^\/]*/g' -e 's/@@DOUBLESTAR@@/.*/g'
}

skip=0
globs=$(merged | jq -r '.generated_globs[]?' 2>/dev/null)
if [ -n "$globs" ]; then
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    re="^$(glob_to_regex "$g")\$"
    if printf '%s' "$rel" | grep -qE "$re" 2>/dev/null; then skip=1; break; fi
  done <<< "$globs"
fi
[ "$skip" = 1 ] && exit 0

# ---------- substitute {file} ----------
case "$cmd" in
  *"{file}"*) cmd=${cmd//\{file\}/$file} ;;
  *) cmd="$cmd $file" ;;
esac

# ---------- resolve + run ----------
first_word=$(printf '%s' "$cmd" | awk '{print $1}')
if ! command -v "$first_word" >/dev/null 2>&1; then
  jq -n --arg m "format-on-edit: $first_word not found on PATH" '{"systemMessage":$m}'
  exit 0
fi

run_dir="$project_dir/$cwd"
[ -d "$run_dir" ] || run_dir="$project_dir"
if ! ( cd "$run_dir" && eval "$cmd" ) >/dev/null 2>&1; then
  jq -n --arg m "format-on-edit: $cmd failed" '{"systemMessage":$m}'
fi
exit 0
