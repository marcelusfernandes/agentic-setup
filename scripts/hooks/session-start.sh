#!/usr/bin/env bash
# agentic-git SessionStart hook.
# Contract (architecture.md §5.1.1): read stdin JSON (cwd), exit 0 SILENTLY when
# <cwd>/.claude/agentic is missing (after walking up to the git main checkout, since
# a worktree's cwd never has its own state tree). Emits
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"}}
# built from LOCAL files only (no gh, no network, no git fetch). Fails open: exit 0
# always, no matter what goes wrong.
set -uo pipefail
trap 'exit 0' ERR

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)" || exit 0
. "$LIB/common.sh" || exit 0
. "$LIB/state.sh"  || exit 0

MAX_LEN=1200

trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

# build_summary <state-dir> -> the additionalContext body (no trailing newline guaranteed)
build_summary() {
  local sdir="$1" epics_d out=""
  epics_d="$sdir/epics"
  [ -d "$epics_d" ] || { printf ''; return 0; }

  local ed
  for ed in "$epics_d"/*/; do
    [ -d "$ed" ] || continue
    local epic_md="${ed}epic.md" mapping="${ed}mapping.json"
    [ -f "$epic_md" ] || continue

    local slug title issue total closed inprog ready
    slug=$(basename "$ed")
    title=$(fm_get "$epic_md" title); [ -n "$title" ] || title="$slug"
    issue=$(fm_get "$epic_md" issue); [ -n "$issue" ] || issue="?"
    total=0; closed=0; inprog=""; ready=""

    local tf
    for tf in "$ed"tasks/*.md; do
      [ -f "$tf" ] || continue
      total=$((total + 1))
      local st tissue lid
      st=$(fm_get "$tf" status)
      tissue=$(fm_get "$tf" issue)
      lid=$(fm_get "$tf" local_id)

      case "$st" in
        closed)
          closed=$((closed + 1))
          ;;
        in-progress)
          local branch="" wt=""
          if [ -f "$mapping" ] && [ -n "$lid" ] && have_cmd jq; then
            branch=$(jq -r --arg id "$lid" '.tasks[$id].branch // empty' "$mapping" 2>/dev/null)
            wt=$(jq -r --arg id "$lid" '.tasks[$id].worktree // empty' "$mapping" 2>/dev/null)
          fi
          if [ -n "$branch" ] && [ -n "$wt" ]; then
            inprog="${inprog}${inprog:+, }#${tissue} ($branch, $wt)"
          elif [ -n "$branch" ]; then
            inprog="${inprog}${inprog:+, }#${tissue} ($branch)"
          else
            inprog="${inprog}${inprog:+, }#${tissue}"
          fi
          ;;
        open)
          local deps ready_flag=1
          deps=$(fm_list "$tf" depends_on)
          if [ -n "$deps" ]; then
            local oldifs d depf dst
            oldifs="$IFS"; IFS=$'\n'; set -f
            set -- $deps
            set +f; IFS="$oldifs"
            for d in "$@"; do
              [ -n "$d" ] || continue
              depf="${ed}tasks/$d.md"
              [ -f "$depf" ] || continue
              dst=$(fm_get "$depf" status)
              [ "$dst" = "closed" ] || ready_flag=0
            done
          fi
          [ "$ready_flag" = 1 ] && ready="${ready}${ready:+, }#${tissue}"
          ;;
      esac
    done

    out="${out}${out:+$'\n'}agentic-git: epic \"$slug\" (#$issue) — ${closed}/${total} tasks closed."
    [ -n "$inprog" ] && out="${out}"$'\n'"In progress: $inprog"
    [ -n "$ready" ] && out="${out}"$'\n'"Ready to start: $ready   (/agentic-git:status next)"
  done

  [ -n "$out" ] || { printf ''; return 0; }

  local pf pm tr ln fmt tc stack v
  pf="$sdir/project-profile.json"
  if [ -f "$pf" ] && have_cmd jq; then
    pm=$(jq -r '.package_manager.name // empty' "$pf" 2>/dev/null)
    tr=$(jq -r '.tools.test_runner // empty' "$pf" 2>/dev/null)
    ln=$(jq -r '.tools.linter // empty' "$pf" 2>/dev/null)
    fmt=$(jq -r '.tools.formatter // empty' "$pf" 2>/dev/null)
    tc=$(jq -r '.tools.typechecker // empty' "$pf" 2>/dev/null)
    stack=""
    for v in "$pm" "$tr" "$ln" "$fmt" "$tc"; do
      [ -n "$v" ] && stack="${stack}${stack:+ · }$v"
    done
    [ -n "$stack" ] && out="${out}"$'\n'"Stack: $stack"
  fi

  out="${out}"$'\n'"Rules: work happens in .worktrees/; never push --force; conflicts stop for review."
  printf '%s' "$out"
}

main() {
  have_cmd jq || return 0

  local input cwd root sdir
  input=$(cat 2>/dev/null) || return 0
  [ -n "$input" ] || return 0

  cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null) || return 0
  [ -n "$cwd" ] || return 0
  [ -d "$cwd" ] || return 0
  cd "$cwd" 2>/dev/null || return 0

  # Walk up to the git main checkout when cwd is a linked worktree; the state tree
  # (.claude/agentic) lives only at the main checkout, never per-worktree.
  root=$(git_root 2>/dev/null)
  [ -n "$root" ] || root="$cwd"
  sdir="$root/.claude/agentic"
  [ -d "$sdir" ] || return 0

  local body
  body=$(build_summary "$sdir") || return 0
  [ -n "$body" ] || return 0

  body=$(printf '%s' "$body" | cut -c1-"$MAX_LEN")

  local esc
  esc=$(escape_for_json "$body")
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$esc"
}

main
exit 0
