#!/usr/bin/env bash
# agentic-git project hook — PreToolUse guard-secrets (architecture.md §5.3.2).
# Copied INTO the target project by `adopt`. Standalone: no plugin lib, jq + coreutils only.
# Denies writes matching profile.secrets_globs (with "!" negations) or anything under .git/.
# Reading is never blocked. Must fail open: always exits 0.
set -uo pipefail

input="$(cat)"

file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

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
project_dir=""
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/.claude/agentic/project-profile.json" ]; then
  profile="$CLAUDE_PROJECT_DIR/.claude/agentic/project-profile.json"
  project_dir="$CLAUDE_PROJECT_DIR"
else
  profile=$(find_profile_up "$PWD" 2>/dev/null)
  [ -n "$profile" ] && project_dir=$(dirname "$(dirname "$(dirname "$profile")")")
fi
[ -n "$project_dir" ] || project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"

DEFAULT_GLOBS_JSON='[".env",".env.*","!.env.example","!.env.sample","!.env.template","*.pem","*.key","**/id_rsa*","secrets.*","credentials.json","*.p12",".npmrc",".pypirc"]'

globs_json="$DEFAULT_GLOBS_JSON"
if [ -n "$profile" ] && [ -f "$profile" ]; then
  g=$(jq -c 'del(.overrides) * (.overrides // {}) | .secrets_globs // empty' "$profile" 2>/dev/null)
  if [ -n "$g" ] && [ "$g" != "null" ] && [ "$g" != "[]" ]; then globs_json="$g"; fi
fi

rel="$file"
case "$file" in
  "$project_dir"/*) rel="${file#"$project_dir"/}" ;;
esac
base=$(basename "$file")

# .git/ is always denied, regardless of secrets_globs or its negations.
under_git=0
case "$rel" in .git/*) under_git=1 ;; esac
case "/$rel/" in */".git/"*) under_git=1 ;; esac

glob_to_regex() {
  printf '%s' "$1" \
    | sed -e 's/[.[\^$()+?{}|]/\\&/g' -e 's/\*\*/@@DOUBLESTAR@@/g' -e 's/\*/[^\/]*/g' -e 's/@@DOUBLESTAR@@/.*/g'
}
matches_any() {
  # matches_any needle glob -> exit 0 if needle matches glob (anchored, basic)
  local needle="$1" g="$2" re
  [ -n "$g" ] || return 1
  re="^$(glob_to_regex "$g")\$"
  printf '%s' "$needle" | grep -qE "$re" 2>/dev/null
}

pos_list="$(printf '%s' "$globs_json" | jq -r '.[] | select(startswith("!")|not)')"
neg_list="$(printf '%s' "$globs_json" | jq -r '.[] | select(startswith("!")) | ltrimstr("!")')"

deny=0
if [ "$under_git" = 1 ]; then
  deny=1
else
  while IFS= read -r g; do
    [ -n "$g" ] || continue
    if matches_any "$rel" "$g" || matches_any "$base" "$g"; then deny=1; break; fi
  done <<< "$pos_list"
  if [ "$deny" = 1 ] && [ -n "$neg_list" ]; then
    while IFS= read -r g; do
      [ -n "$g" ] || continue
      if matches_any "$rel" "$g" || matches_any "$base" "$g"; then deny=0; break; fi
    done <<< "$neg_list"
  fi
fi

if [ "$deny" = 1 ]; then
  if [ "$under_git" = 1 ]; then
    reason="$rel is inside .git/ and is never writable through this workflow."
  else
    reason="$rel holds secrets. Edit it yourself, or add it to secrets_globs exceptions in .claude/agentic/project-profile.json."
  fi
  jq -n --arg r "$reason" \
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":$r}}'
fi
exit 0
