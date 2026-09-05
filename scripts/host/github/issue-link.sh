#!/usr/bin/env bash
# scripts/host/github/issue-link.sh — the 3-tier parent/sub-issue and blocked-by fallback ladder.
# Verb contract: host.sh issue-link (--parent N --children n,n | --blocked N --by n,n)
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd -P)"
. "$LIB/common.sh"; . "$LIB/json.sh"; . "$LIB/state.sh"
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

usage() {
  cat <<'EOF'
Usage:
  issue-link.sh --parent <N> --children <n,n,...>
  issue-link.sh --blocked <N> --by <n,n,...>        (also accepts --blocked-by <N>)

Tries, first that works, and never fails the caller unless all three do:
  1. native   gh issue edit <parent> --add-sub-issue <children>
              gh issue edit <blocked> --add-blocked-by <by>
  2. rest     gh api .../issues/{n} --jq .id for the numeric DB id (NOT the
              GraphQL node id `gh issue view --json id` returns), then
              POST .../issues/{parent}/sub_issues            -f sub_issue_id=<id>
              POST .../issues/{blocked}/dependencies/blocked_by -f issue_id=<id>
  3. checklist   append "- [ ] #<n>" lines to the parent body, or a
              "Blocked by: #a, #b" line to the child body (idempotent: never
              duplicates a line already present).

A downgrade to rest or checklist prints a WARN to stderr.
Output (stdout, JSON): {"mode":"native|rest|checklist","applied":[n,...]}
EOF
}

op=""; parent=""; children=""; blocked=""; by=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --parent) parent="$2"; op="parent"; shift 2 ;;
    --children) children="$2"; shift 2 ;;
    --blocked|--blocked-by) blocked="$2"; op="blocked"; shift 2 ;;
    --by) by="$2"; shift 2 ;;
    *) printf 'ERROR: unknown arg: %s\n' "$1" >&2; exit 2 ;;
  esac
done

case "$op" in
  parent) [ -n "$parent" ] && [ -n "$children" ] || { printf 'ERROR: --parent requires --children\n' >&2; exit 2; } ;;
  blocked) [ -n "$blocked" ] && [ -n "$by" ] || { printf 'ERROR: --blocked requires --by\n' >&2; exit 2; } ;;
  *) usage >&2; exit 2 ;;
esac

require_cmd gh

OWNER=""; REPO=""
ensure_repo() {
  [ -n "$OWNER" ] && return 0
  local repo_json
  repo_json=$(bash "$SELF_DIR/repo-info.sh") || exit $?
  OWNER=$(printf '%s' "$repo_json" | jq -r .owner)
  REPO=$(printf '%s' "$repo_json" | jq -r .name)
}

caps_json=$(bash "$SELF_DIR/caps.sh" --cached)
native_sub_issue_edit=$(printf '%s' "$caps_json" | jq -r '.native_sub_issue_edit')
native_blocked_by=$(printf '%s' "$caps_json" | jq -r '.native_blocked_by')

try_native() {
  if [ "$op" = "parent" ]; then
    [ "$native_sub_issue_edit" = "true" ] || return 1
    gh issue edit "$parent" --add-sub-issue "$children" >/dev/null 2>&1
  else
    [ "$native_blocked_by" = "true" ] || return 1
    gh issue edit "$blocked" --add-blocked-by "$by" >/dev/null 2>&1
  fi
}

try_rest() {
  ensure_repo
  local n cid pid bid xid
  if [ "$op" = "parent" ]; then
    pid=$(gh api "repos/$OWNER/$REPO/issues/$parent" 2>/dev/null | jq -r '.id') || return 1
    [ -n "$pid" ] && [ "$pid" != "null" ] || return 1
    old_ifs=$IFS; IFS=','
    for n in $children; do
      [ -n "$n" ] || continue
      cid=$(gh api "repos/$OWNER/$REPO/issues/$n" 2>/dev/null | jq -r '.id') || { IFS=$old_ifs; return 1; }
      [ -n "$cid" ] && [ "$cid" != "null" ] || { IFS=$old_ifs; return 1; }
      gh api "repos/$OWNER/$REPO/issues/$parent/sub_issues" -X POST -f sub_issue_id="$cid" >/dev/null 2>&1 || { IFS=$old_ifs; return 1; }
    done
    IFS=$old_ifs
  else
    bid=$(gh api "repos/$OWNER/$REPO/issues/$blocked" 2>/dev/null | jq -r '.id') || return 1
    [ -n "$bid" ] && [ "$bid" != "null" ] || return 1
    old_ifs=$IFS; IFS=','
    for n in $by; do
      [ -n "$n" ] || continue
      xid=$(gh api "repos/$OWNER/$REPO/issues/$n" 2>/dev/null | jq -r '.id') || { IFS=$old_ifs; return 1; }
      [ -n "$xid" ] && [ "$xid" != "null" ] || { IFS=$old_ifs; return 1; }
      gh api "repos/$OWNER/$REPO/issues/$blocked/dependencies/blocked_by" -X POST -f issue_id="$xid" >/dev/null 2>&1 || { IFS=$old_ifs; return 1; }
    done
    IFS=$old_ifs
  fi
  return 0
}

try_checklist() {
  ensure_repo
  local target body tmp line n
  if [ "$op" = "parent" ]; then
    target="$parent"
    body=$(gh api "repos/$OWNER/$REPO/issues/$target" 2>/dev/null | jq -r '.body // ""') || body=""
    tmp=$(mktemp)
    printf '%s\n' "$body" > "$tmp"
    old_ifs=$IFS; IFS=','
    for n in $children; do
      [ -n "$n" ] || continue
      line="- [ ] #$n"
      grep -qxF -- "$line" "$tmp" || printf '%s\n' "$line" >> "$tmp"
    done
    IFS=$old_ifs
  else
    target="$blocked"
    body=$(gh api "repos/$OWNER/$REPO/issues/$target" 2>/dev/null | jq -r '.body // ""') || body=""
    line="Blocked by: $(printf '%s' "$by" | sed 's/^/#/; s/,/, #/g')"
    tmp=$(mktemp)
    if printf '%s\n' "$body" | grep -q '^Blocked by: '; then
      printf '%s\n' "$body" > "$tmp"
      sed_inplace "s/^Blocked by: .*/${line//\//\\/}/" "$tmp"
    else
      printf '%s\n' "$body" > "$tmp"
      printf '%s\n' "$line" >> "$tmp"
    fi
  fi
  gh issue edit "$target" --body-file "$tmp" >/dev/null 2>&1
  local rc=$?
  rm -f "$tmp"
  return $rc
}

mode=""
if try_native; then
  mode="native"
elif ( warn "issue-link: native mode unavailable/failed, falling back to REST" ; try_rest ); then
  mode="rest"
else
  warn "issue-link: REST fallback unavailable/failed, falling back to checklist mode (advisory, not enforced by GitHub)"
  if try_checklist; then
    mode="checklist"
  else
    printf 'ERROR: issue-link failed at all three tiers (native, rest, checklist)\n' >&2
    exit 1
  fi
fi

if [ "$op" = "parent" ]; then
  applied_json=$(printf '%s' "$children" | tr ',' '\n' | sed '/^$/d' | jq -R 'tonumber? // .' | jq -s .)
else
  applied_json=$(printf '%s' "$by" | tr ',' '\n' | sed '/^$/d' | jq -R 'tonumber? // .' | jq -s .)
fi

jq -n --arg mode "$mode" --argjson applied "$applied_json" '{mode:$mode, applied:$applied}'
