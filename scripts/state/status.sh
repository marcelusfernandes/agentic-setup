#!/usr/bin/env bash
# status.sh [<slug> | next | blocked | streams | prs]  (default: overview) — read-only dashboard.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
HERE="$(dirname "${BASH_SOURCE[0]}")"
. "$HERE/_lib.sh"

usage() { printf 'Usage: status.sh [<epic-slug> | next | blocked | streams | prs]\n'; }

mode="${1:-}"
[ "$mode" = "--help" ] || [ "$mode" = "-h" ] && { usage; exit 0; }

if [ ! -d "$(state_dir)" ]; then
  printf 'agentic-git is not initialized here; run /agentic-git:init\n'
  exit 0
fi

print_epic_row() {
  local d="$1" epic="$d/epic.md" slug title milestone issue closed total
  [ -f "$epic" ] || return 0
  slug="$(basename "$d")"
  title="$(fm_get "$epic" title)"
  milestone="$(fm_get "$epic" milestone)"
  issue="$(fm_get "$epic" issue)"
  total=0; closed=0
  for f in "$d"/tasks/*.md; do
    [ -f "$f" ] || continue
    total=$((total+1))
    [ "$(fm_get "$f" status)" = "closed" ] && closed=$((closed+1))
  done
  local pct=0; [ "$total" -gt 0 ] && pct=$((closed*100/total))
  printf '%-22s %-30s milestone:%-8s issue:#%-6s %s/%s tasks (%s%%)\n' \
    "$slug" "$title" "${milestone:-none}" "${issue:-?}" "$closed" "$total" "$pct"
}

overview() {
  printf 'Epics:\n'
  local any=0
  for d in "$(epics_dir)"/*; do
    [ -d "$d" ] || continue
    print_epic_row "$d"; any=1
  done
  [ "$any" -eq 0 ] && printf '  (none — run /agentic-git:plan "<goal>")\n'

  printf '\nWorktrees:\n'
  local wt_dir base wtany=0
  wt_dir="$(config_get .worktree_dir ".worktrees")"
  base="$(project_root)/$wt_dir"
  if have_cmd git && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local path="" br=""
    while IFS= read -r line; do
      case "$line" in
        "worktree "*) path="${line#worktree }" ;;
        "branch "*) br="${line#branch refs/heads/}";
          case "$path" in "$base"/*) printf '  %-40s %s\n' "$path" "$br"; wtany=1 ;; esac ;;
        "") path="" ;;
      esac
    done < <(git worktree list --porcelain 2>/dev/null)
  fi
  [ "$wtany" -eq 0 ] && printf '  (none)\n'

  printf '\nRunning streams:\n'
  local sany=0
  for f in "$(runtime_dir)"/streams/*/*.json; do
    [ -f "$f" ] || continue
    st="$(json_get "$f" .status)"
    [ "$st" = "running" ] || continue
    printf '  issue #%-6s stream %-3s %-16s age:%s\n' \
      "$(json_get "$f" .issue)" "$(json_get "$f" .stream)" "$(json_get "$f" .name)" "$(age_human "$(json_get "$f" .started_at)")"
    sany=1
  done
  [ "$sany" -eq 0 ] && printf '  (none)\n'
}

epic_detail() {
  local slug="$1" d epic
  d="$(epic_dir "$slug")"
  epic="$d/epic.md"
  [ -f "$epic" ] || die "no such epic: $slug"
  printf 'Epic: %s (#%s) — %s\n' "$(fm_get "$epic" title)" "$(fm_get "$epic" issue)" "$(fm_get "$epic" status)"
  printf '%-6s %-28s %-12s %-14s %-8s %-24s %-24s %s\n' issue title status deps parallel branch worktree pr
  for f in "$d"/tasks/*.md; do
    [ -f "$f" ] || continue
    printf '%-6s %-28s %-12s %-14s %-8s %-24s %-24s %s\n' \
      "$(fm_get "$f" issue)" "$(fm_get "$f" name)" "$(fm_get "$f" status)" \
      "$(fm_get "$f" depends_on)" "$(fm_get "$f" parallel)" "$(fm_get "$f" branch)" \
      "$(fm_get "$f" worktree)" "$(fm_get "$f" pr)"
  done
}

streams_mode() {
  local any=0
  for f in "$(runtime_dir)"/streams/*/*.json; do
    [ -f "$f" ] || continue
    printf '#%-6s %-3s %-16s %-9s age:%-6s files:%s\n' \
      "$(json_get "$f" .issue)" "$(json_get "$f" .stream)" "$(json_get "$f" .name)" \
      "$(json_get "$f" .status)" "$(age_human "$(json_get "$f" .started_at)")" \
      "$(jq -c '.files_touched' "$f" 2>/dev/null)"
    any=1
  done
  [ "$any" -eq 0 ] && printf '(no streams recorded)\n'
}

prs_mode() {
  if ! have_cmd gh; then
    printf 'gh not installed — cannot list PRs. Install gh to use this mode.\n'
    return 0
  fi
  if ! gh auth status >/dev/null 2>&1; then
    printf 'gh is not authenticated — run `gh auth login`.\n'
    return 0
  fi
  gh pr list --label agentic --json number,title,headRefName,state,isDraft,reviewDecision 2>/dev/null \
    | jq -r '.[] | "#\(.number)\t\(.title)\t\(.headRefName)\t\(.state)\tdraft:\(.isDraft)\treview:\(.reviewDecision // "PENDING")"' \
    | { grep . || printf '(no open agentic PRs)\n'; }
}

case "$mode" in
  ""|overview) overview ;;
  next) shift || true; bash "$HERE/next.sh" "$@" ;;
  blocked) shift || true; bash "$HERE/blocked.sh" "$@" ;;
  streams) streams_mode ;;
  prs) prs_mode ;;
  *)
    [ -d "$(epic_dir "$mode")" ] || { usage; die "unknown mode or epic: $mode"; }
    epic_detail "$mode"
    ;;
esac
