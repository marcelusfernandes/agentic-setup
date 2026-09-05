#!/usr/bin/env bash
# agentic-git PreToolUse(Bash) guard hook.
# Contract (architecture.md §5.1.2): stdin {tool_name, tool_input.command, cwd}.
# On block:  {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny|ask","permissionDecisionReason":"..."}}
# On pass:   no output at all (never "allow" — that would short-circuit the user's own rules).
# Exit 0 always; the decision travels in the JSON, never the exit code. Fails open on
# any internal error: a broken guard must never block a user's terminal.
#
# The script is a text-pattern matcher, not a shell parser (by design — see the
# architecture doc). Globbing is disabled for the whole script (`set -f`) since every
# loop below tokenizes command text, not filesystem paths.
set -uo pipefail
set -f
trap 'exit 0' ERR

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)" || exit 0
. "$LIB/common.sh" || exit 0

DECISION=""
REASON=""

trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# has_word haystack word -> 0 if `word` appears as a whole token (bounded by anything
# that isn't [A-Za-z0-9_.-]) inside haystack. No \b / \< \> — those are GNU-only and
# this must run under BSD grep too.
has_word() {
  printf '%s' "$1" | grep -Eq "(^|[^A-Za-z0-9_.-])$2([^A-Za-z0-9_.-]|\$)"
}

is_git() {
  case "$1" in *git*) return 0 ;; *) return 1 ;; esac
}

normalize_cmd() {
  local s
  # join backslash-newline continuations
  s=$(printf '%s' "$1" | awk '{ if (sub(/\\[ \t]*$/, "")) { printf "%s ", $0 } else { printf "%s\n", $0 } }')
  s=$(printf '%s' "$s" | tr '\n' ' ')
  s=$(printf '%s' "$s" | tr -s '[:space:]' ' ')
  trim "$s"
}

# split on ; && || (pure bash substitution — no sed \n portability trap)
split_segments() {
  local s="$1"
  s="${s//&&/$'\n'}"
  s="${s//||/$'\n'}"
  s="${s//;/$'\n'}"
  printf '%s' "$s"
}

# protected_branches_ere <config-file> -> "main|master|develop|release/.*"
protected_branches_ere() {
  local cfg="$1" list b out="" oldifs
  list=""
  if [ -f "$cfg" ] && have_cmd jq; then
    list=$(jq -r '.protected_branches[]? // empty' "$cfg" 2>/dev/null)
  fi
  if [ -z "$list" ]; then
    list="main
master
develop
release/*"
  fi
  oldifs="$IFS"; IFS=$'\n'; set -- $list; IFS="$oldifs"
  for b in "$@"; do
    [ -n "$b" ] || continue
    b=$(printf '%s' "$b" | sed -e 's/[.[\^$()+{}|]/\\&/g' -e 's/\*/.*/g')
    out="${out}${out:+|}$b"
  done
  printf '%s' "$out"
}

# push_target_protected seg pbre -> 0 if any destination-ref-looking token resolves to
# a protected branch name.
push_target_protected() {
  local seg="$1" pbre="$2" tok cand
  for tok in $seg; do
    case "$tok" in
      git|push|origin|upstream) continue ;;
      -*) continue ;;
      *:*) cand="${tok##*:}" ;;
      *) cand="$tok" ;;
    esac
    cand="${cand#refs/heads/}"
    [ -n "$cand" ] || continue
    if printf '%s' "$cand" | grep -Eq "^(${pbre})\$"; then
      return 0
    fi
  done
  return 1
}

# check_push seg pbre -> 0 and sets DECISION/REASON when this is a push that must be
# blocked: any force-form push, or any push whose destination (via a `HEAD:branch` /
# `local:remote` refspec) is a protected branch. Never flags --force-with-lease alone.
check_push() {
  local seg="$1" pbre="$2" force=0 colon=0 tok
  has_word "$seg" "push" || return 1
  is_git "$seg" || return 1

  has_word "$seg" "--force" && force=1
  has_word "$seg" "-f" && force=1

  for tok in $seg; do
    case "$tok" in *:*) colon=1 ;; esac
  done

  if [ "$force" = 1 ] || [ "$colon" = 1 ]; then
    if push_target_protected "$seg" "$pbre"; then
      DECISION=deny
      REASON="Protected branch. Land changes through a PR: /agentic-git:pr."
      return 0
    fi
  fi

  if [ "$force" = 1 ]; then
    DECISION=deny
    REASON="Use --force-with-lease; /agentic-git:resolve-conflicts does this safely."
    return 0
  fi

  return 1
}

worktree_remove_force() {
  local seg="$1"
  is_git "$seg" || return 1
  has_word "$seg" "worktree" || return 1
  has_word "$seg" "remove" || return 1
  has_word "$seg" "--force" || has_word "$seg" "-f"
}

branch_delete_force() {
  local seg="$1"
  is_git "$seg" || return 1
  has_word "$seg" "branch" || return 1
  has_word "$seg" "-D" && return 0
  has_word "$seg" "--delete" && has_word "$seg" "--force" && return 0
  return 1
}

# rm_targets_protected seg cwd -> 0 if `rm -rf ...` (any spelling of recursive+force)
# names a target that resolves under .worktrees/, .claude/agentic/, or .git/.
rm_targets_protected() {
  local seg="$1" cwd="$2"
  has_word "$seg" "rm" || return 1
  local has_r=0 has_f=0 tok targets=""
  for tok in $seg; do
    case "$tok" in
      rm) continue ;;
      --recursive) has_r=1 ;;
      --force) has_f=1 ;;
      -[a-zA-Z]*)
        case "$tok" in *r*|*R*) has_r=1 ;; esac
        case "$tok" in *f*) has_f=1 ;; esac
        ;;
      *) targets="${targets}${targets:+ }$tok" ;;
    esac
  done
  { [ "$has_r" = 1 ] && [ "$has_f" = 1 ]; } || return 1
  local t norm
  for t in $targets; do
    case "$t" in
      /*) norm="$t" ;;
      *) norm="$cwd/$t" ;;
    esac
    case "$norm" in
      "$cwd/.worktrees"|"$cwd/.worktrees"/*) return 0 ;;
      "$cwd/.claude/agentic"|"$cwd/.claude/agentic"/*) return 0 ;;
      "$cwd/.git"|"$cwd/.git"/*) return 0 ;;
    esac
  done
  return 1
}

reset_hard_risky() {
  local seg="$1"
  is_git "$seg" || return 1
  has_word "$seg" "reset" || return 1
  has_word "$seg" "--hard" || return 1
  in_worktree || return 1
  [ -n "$(git status --porcelain 2>/dev/null)" ]
}

# writes_common_gitdir seg -> 0 if, from inside a worktree, the command references the
# main checkout's .git directory (escaping the worktree's own gitlink).
writes_common_gitdir() {
  local seg="$1" common
  in_worktree || return 1
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$common" ] || return 1
  case "$seg" in *"$common"*) return 0 ;; esac
  if printf '%s' "$seg" | grep -Eq '(>|>>)[[:space:]]*[^[:space:]]*/\.git(/|[[:space:]]|$)'; then
    return 0
  fi
  if has_word "$seg" "rm" || has_word "$seg" "mv" || has_word "$seg" "cp"; then
    if printf '%s' "$seg" | grep -Eq '(^|[[:space:]])[^[:space:]]*/\.git(/[^[:space:]]*)?([[:space:]]|$)'; then
      return 0
    fi
  fi
  return 1
}

git_clean_xf() {
  local seg="$1" has_x=0 has_f=0 tok
  is_git "$seg" || return 1
  has_word "$seg" "clean" || return 1
  for tok in $seg; do
    case "$tok" in
      --force) has_f=1 ;;
      -[a-zA-Z]*)
        case "$tok" in *x*|*X*) has_x=1 ;; esac
        case "$tok" in *f*) has_f=1 ;; esac
        ;;
    esac
  done
  [ "$has_x" = 1 ] && [ "$has_f" = 1 ]
}

gh_destructive() {
  local seg="$1"
  has_word "$seg" "gh" || return 1
  has_word "$seg" "repo" || return 1
  has_word "$seg" "delete" || has_word "$seg" "archive"
}

# push_delete_protected seg pbre -> 0 if `git push origin --delete <branch>` or the
# `:branch` colon-shorthand deletes a protected branch on the remote.
push_delete_protected() {
  local seg="$1" pbre="$2" tok cand deleting=0
  is_git "$seg" || return 1
  has_word "$seg" "push" || return 1
  for tok in $seg; do
    case "$tok" in
      --delete|-d) deleting=1 ;;
      :*)
        cand="${tok#:}"
        [ -n "$cand" ] && printf '%s' "$cand" | grep -Eq "^(${pbre})\$" && return 0
        ;;
    esac
  done
  [ "$deleting" = 1 ] || return 1
  for tok in $seg; do
    case "$tok" in
      -*|git|push|origin|upstream) continue ;;
      *) printf '%s' "$tok" | grep -Eq "^(${pbre})\$" && return 0 ;;
    esac
  done
  return 1
}

# evaluate_segment seg pbre cwd -> 0 and sets DECISION/REASON on the first matching rule.
evaluate_segment() {
  local seg="$1" pbre="$2" cwd="$3"

  check_push "$seg" "$pbre" && return 0

  if worktree_remove_force "$seg"; then
    DECISION=ask; REASON="This discards uncommitted work in that worktree."; return 0
  fi
  if branch_delete_force "$seg"; then
    DECISION=ask; REASON="Unmerged commits would be lost; git branch -d refuses safely."; return 0
  fi
  if rm_targets_protected "$seg" "$cwd"; then
    DECISION=deny; REASON="Use /agentic-git:cleanup, which removes worktrees through git."; return 0
  fi
  if reset_hard_risky "$seg"; then
    DECISION=ask; REASON="Uncommitted changes in this worktree would be lost."; return 0
  fi
  if writes_common_gitdir "$seg"; then
    DECISION=deny; REASON="Never write to the main checkout's git directory from a worktree."; return 0
  fi
  if git_clean_xf "$seg"; then
    DECISION=ask; REASON="This deletes ignored files, including .env symlinks in worktrees."; return 0
  fi
  if gh_destructive "$seg"; then
    DECISION=deny; REASON="Irreversible repository operation."; return 0
  fi
  if push_delete_protected "$seg" "$pbre"; then
    DECISION=deny; REASON="Irreversible repository operation."; return 0
  fi
  return 1
}

emit() {
  local decision="$1" reason="$2" esc
  esc=$(escape_for_json "$reason")
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"%s","permissionDecisionReason":"%s"}}\n' "$decision" "$esc"
}

main() {
  have_cmd jq || return 0

  local input tool cmd cwd
  input=$(cat 2>/dev/null) || return 0
  [ -n "$input" ] || return 0

  tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || return 0
  [ "$tool" = "Bash" ] || return 0

  cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null) || return 0
  [ -n "$cmd" ] || return 0

  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || cwd=""
  [ -n "$cwd" ] || cwd="$PWD"
  [ -d "$cwd" ] && cd "$cwd" 2>/dev/null

  local pbre; pbre=$(protected_branches_ere "$cwd/.claude/agentic/config.json")

  local norm segs oldifs seg
  norm=$(normalize_cmd "$cmd")
  segs=$(split_segments "$norm")

  oldifs="$IFS"; IFS=$'\n'; set -- $segs; IFS="$oldifs"
  for seg in "$@"; do
    seg=$(trim "$seg")
    [ -n "$seg" ] || continue
    if evaluate_segment "$seg" "$pbre" "$cwd"; then
      emit "$DECISION" "$REASON"
      return 0
    fi
  done
  return 0
}

main
exit 0
