#!/usr/bin/env bash
# lock.sh acquire|release|owner|list <issue> <stream> <path> — single-writer locks for shared files.
# Lock file: runtime/locks/<sha1(path)>.lock = {"path","issue","stream","acquired_at","pid"}
# A lock is stale (reclaimable) when its pid is dead AND it is older than 2 hours.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
. "$(dirname "${BASH_SOURCE[0]}")/_lib.sh"

usage() {
  cat <<'EOF'
Usage: lock.sh acquire <issue> <stream> <path>
       lock.sh release <issue> <stream> <path>
       lock.sh owner   <path>
       lock.sh list    [<issue>]
EOF
}

STALE_SECONDS=$((2*60*60))

lock_dir() { printf '%s/locks\n' "$(runtime_dir)"; }
lock_file_for() { printf '%s/%s.lock\n' "$(lock_dir)" "$(sha1_portable "$1")"; }

pid_alive() { kill -0 "$1" >/dev/null 2>&1; }

is_stale() {
  local f="$1" pid acq now age
  pid="$(json_get "$f" .pid)"
  acq="$(json_get "$f" .acquired_at)"
  pid_alive "$pid" 2>/dev/null && return 1
  now=$(date -u +%s)
  age=$(( now - $(epoch_of "$acq") ))
  [ "$age" -gt "$STALE_SECONDS" ]
}

reclaim_ledger() {
  # reclaim_ledger <path> <old-issue> <old-stream> <new-issue> <new-stream>
  local slug
  slug="$(find_task_by_issue "$2" 2>/dev/null | awk '{print $1}')"
  [ -z "$slug" ] && slug="$(find_task_by_issue "$4" 2>/dev/null | awk '{print $1}')"
  [ -n "$slug" ] || return 0
  bash "$(dirname "${BASH_SOURCE[0]}")/ledger.sh" "$slug" lock "$1" \
    "Reclaimed stale lock from #$2 stream $3 for #$4 stream $5" \
    "owning process is dead and the lock is older than 2h" \
    "the dead stream's uncommitted edit to $1 could be lost" "yes" >/dev/null 2>&1 || true
}

[ $# -ge 1 ] || { usage; exit 1; }
[ "$1" = "--help" ] || [ "$1" = "-h" ] && { usage; exit 0; }
cmd="$1"; shift

mkdir -p "$(lock_dir)"

case "$cmd" in
  acquire)
    [ $# -eq 3 ] || die "acquire: <issue> <stream> <path> required"
    issue="$1"; stream="$2"; path="$3"
    f="$(lock_file_for "$path")"
    if [ -f "$f" ]; then
      cur_issue="$(json_get "$f" .issue)"; cur_stream="$(json_get "$f" .stream)"
      if [ "$cur_issue" = "$issue" ] && [ "$cur_stream" = "$stream" ]; then
        printf 'held (already owned)\n'; exit 0
      fi
      if is_stale "$f"; then
        reclaim_ledger "$path" "$cur_issue" "$cur_stream" "$issue" "$stream"
      else
        die "locked by issue #$cur_issue stream $cur_stream"
      fi
    fi
    jq -n --arg path "$path" --arg issue "$issue" --arg stream "$stream" --arg now "$(date_utc)" --arg pid "$$" \
      '{path:$path, issue:($issue|tonumber? // $issue), stream:$stream, acquired_at:$now, pid:($pid|tonumber)}' > "$f"
    printf 'acquired\n'
    ;;
  release)
    [ $# -eq 3 ] || die "release: <issue> <stream> <path> required"
    issue="$1"; stream="$2"; path="$3"
    f="$(lock_file_for "$path")"
    [ -f "$f" ] || { printf 'not held\n'; exit 0; }
    cur_issue="$(json_get "$f" .issue)"; cur_stream="$(json_get "$f" .stream)"
    if [ "$cur_issue" = "$issue" ] && [ "$cur_stream" = "$stream" ]; then
      rm -f "$f"; printf 'released\n'
    else
      die "not the owner: locked by issue #$cur_issue stream $cur_stream"
    fi
    ;;
  owner)
    [ $# -eq 1 ] || die "owner: <path> required"
    f="$(lock_file_for "$1")"
    [ -f "$f" ] && jq -c . "$f" || printf 'none\n'
    ;;
  list)
    for f in "$(lock_dir)"/*.lock; do
      [ -f "$f" ] || continue
      [ $# -eq 1 ] && [ "$(json_get "$f" .issue)" != "$1" ] && continue
      jq -c . "$f"
    done
    ;;
  *) usage; die "unknown subcommand: $cmd" ;;
esac
