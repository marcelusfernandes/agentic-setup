#!/usr/bin/env bash
# doctor.sh [--prereqs-only] [--fix] [--json]
# Runs the full agentic-git health check table and prints OK|WARN|FAIL per check with a fix line.
set -euo pipefail
LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd -P)"
HERE="$(dirname "${BASH_SOURCE[0]}")"
. "$LIB/common.sh"

usage() { printf 'Usage: doctor.sh [--prereqs-only] [--fix] [--json]\n'; }

prereqs_only=0; do_fix=0; as_json=0
for a in "$@"; do
  case "$a" in
    --prereqs-only) prereqs_only=1 ;;
    --fix) do_fix=1 ;;
    --json) as_json=1 ;;
    --help|-h) usage; exit 0 ;;
    *) die "unknown argument: $a" ;;
  esac
done

if ! have_cmd jq; then
  if [ "$as_json" -eq 1 ]; then
    printf '{"checks":[{"id":"jq_present","group":"prereq","status":"FAIL","message":"jq is not installed","fix":"macOS: brew install jq | Debian/Ubuntu: sudo apt-get install jq | Fedora: sudo dnf install jq"}],"summary":{"ok":0,"warn":0,"fail":1}}\n'
  else
    printf 'FAIL prereq jq_present: jq is not installed\n  fix: macOS: brew install jq | Debian/Ubuntu: sudo apt-get install jq | Fedora: sudo dnf install jq\n'
  fi
  exit 1
fi
. "$LIB/json.sh"; . "$LIB/state.sh"

CHECK_ID=(); CHECK_GROUP=(); CHECK_STATUS=(); CHECK_MSG=(); CHECK_FIX=()
check() { CHECK_ID+=("$1"); CHECK_GROUP+=("$2"); CHECK_STATUS+=("$3"); CHECK_MSG+=("$4"); CHECK_FIX+=("${5:-}"); }

# ---------------- prereq ----------------
gv="$(git_version)"
if [ -n "$gv" ] && version_ge "$gv" "2.38"; then
  check git_version prereq OK "git $gv"
else
  check git_version prereq FAIL "git ${gv:-not found} is older than the required 2.38" "install git >= 2.38 (macOS: brew upgrade git | Debian/Ubuntu: sudo apt-get install --only-upgrade git)"
fi

if have_cmd gh; then
  check gh_present prereq OK "gh is installed"
  if gh auth status >/dev/null 2>&1; then
    check gh_authed prereq OK "gh is authenticated"
  else
    check gh_authed prereq FAIL "gh is not authenticated" "gh auth login"
  fi
else
  check gh_present prereq FAIL "gh (GitHub CLI) is not installed" "https://cli.github.com"
  check gh_authed prereq FAIL "gh is not installed" "https://cli.github.com"
fi
check jq_present prereq OK "jq is installed"

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  rerere="$(git config --local --get rerere.enabled 2>/dev/null || printf false)"
  rerere_au="$(git config --local --get rerere.autoupdate 2>/dev/null || printf false)"
  style="$(git config --local --get merge.conflictStyle 2>/dev/null || printf "(unset)")"

  if [ "$rerere" = "true" ]; then check rerere_enabled prereq OK "rerere.enabled=true"
  else
    [ "$do_fix" -eq 1 ] && git config --local rerere.enabled true && rerere=true
    [ "$rerere" = "true" ] && check rerere_enabled prereq OK "rerere.enabled=true (fixed)" \
      || check rerere_enabled prereq WARN "rerere.enabled is not true" "/agentic-git:init"
  fi
  if [ "$rerere_au" = "true" ]; then check rerere_autoupdate prereq OK "rerere.autoupdate=true"
  else
    [ "$do_fix" -eq 1 ] && git config --local rerere.autoupdate true && rerere_au=true
    [ "$rerere_au" = "true" ] && check rerere_autoupdate prereq OK "rerere.autoupdate=true (fixed)" \
      || check rerere_autoupdate prereq WARN "rerere.autoupdate is not true" "/agentic-git:init"
  fi
  if [ "$style" = "zdiff3" ]; then check conflict_style prereq OK "merge.conflictStyle=zdiff3"
  else
    [ "$do_fix" -eq 1 ] && git config --local merge.conflictStyle zdiff3 && style=zdiff3
    [ "$style" = "zdiff3" ] && check conflict_style prereq OK "merge.conflictStyle=zdiff3 (fixed)" \
      || check conflict_style prereq WARN "merge.conflictStyle is '$style', expected zdiff3" "/agentic-git:init"
  fi
else
  check rerere_enabled prereq FAIL "not inside a git work tree" "cd into the project repo"
  check rerere_autoupdate prereq FAIL "not inside a git work tree" "cd into the project repo"
  check conflict_style prereq FAIL "not inside a git work tree" "cd into the project repo"
fi

emit() {
  if [ "$as_json" -eq 1 ]; then
    out="["
    first=1
    local i n=${#CHECK_ID[@]}
    for ((i=0; i<n; i++)); do
      obj="$(jq -nc --arg id "${CHECK_ID[$i]}" --arg group "${CHECK_GROUP[$i]}" --arg status "${CHECK_STATUS[$i]}" \
        --arg message "${CHECK_MSG[$i]}" --arg fix "${CHECK_FIX[$i]}" '{id:$id,group:$group,status:$status,message:$message,fix:$fix}')"
      [ "$first" -eq 1 ] || out="$out,"
      out="$out$obj"; first=0
    done
    out="$out]"
    local ok=0 warn=0 fail=0
    for s in "${CHECK_STATUS[@]}"; do case "$s" in OK) ok=$((ok+1));; WARN) warn=$((warn+1));; FAIL) fail=$((fail+1));; esac; done
    jq -nc --argjson checks "$out" --argjson ok "$ok" --argjson warn "$warn" --argjson fail "$fail" \
      '{checks:$checks, summary:{ok:$ok, warn:$warn, fail:$fail}}'
  else
    local i n=${#CHECK_ID[@]} lastgroup=""
    for ((i=0; i<n; i++)); do
      if [ "${CHECK_GROUP[$i]}" != "$lastgroup" ]; then printf '\n[%s]\n' "${CHECK_GROUP[$i]}"; lastgroup="${CHECK_GROUP[$i]}"; fi
      printf '%-4s %-24s %s\n' "${CHECK_STATUS[$i]}" "${CHECK_ID[$i]}" "${CHECK_MSG[$i]}"
      [ -n "${CHECK_FIX[$i]}" ] && [ "${CHECK_STATUS[$i]}" != "OK" ] && printf '     fix: %s\n' "${CHECK_FIX[$i]}"
    done
  fi
}

any_fail() { local s; for s in "${CHECK_STATUS[@]}"; do [ "$s" = "FAIL" ] && return 0; done; return 1; }

if [ "$prereqs_only" -eq 1 ]; then
  emit
  any_fail && exit 1 || exit 0
fi

# ---------------- repo ----------------
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  check repo_inside_work_tree repo OK "inside a git work tree"
else
  check repo_inside_work_tree repo FAIL "not inside a git work tree" "cd into the project repo"
fi
if in_worktree; then
  check repo_not_linked_worktree repo FAIL "this checkout is a linked worktree" "run from the main checkout"
else
  check repo_not_linked_worktree repo OK "main checkout"
fi
origin_url="$(git config --get remote.origin.url 2>/dev/null || true)"
case "$origin_url" in
  *github.com*) check repo_origin_github repo OK "origin is GitHub" ;;
  "") check repo_origin_github repo WARN "no 'origin' remote configured" "git remote add origin <url>" ;;
  *) check repo_origin_github repo FAIL "origin is not a GitHub URL: $origin_url" "point origin at a GitHub repo" ;;
esac
case "$origin_url" in
  *marcelusfernandes/agentic-setup*) check repo_origin_not_plugin repo FAIL "origin is the plugin's own repo" "point origin at your project, not agentic-git itself" ;;
  *) check repo_origin_not_plugin repo OK "origin is not the plugin's own repo" ;;
esac

# ---------------- host ----------------
if have_cmd gh && gh auth status >/dev/null 2>&1; then
  auth_status_out="$(gh auth status 2>&1 || true)"
  if printf '%s' "$auth_status_out" | grep -qi "'repo'"; then
    check host_scopes host OK "gh auth scopes include repo"
  else
    check host_scopes host WARN "could not confirm 'repo' scope" "gh auth refresh -s repo"
  fi
  caps="$(runtime_dir)/host-caps.json"
  if [ -f "$caps" ]; then
    age_s=0
    if have_cmd stat; then
      mtime="$(stat -c %Y "$caps" 2>/dev/null || stat -f %m "$caps" 2>/dev/null || printf 0)"
      now=$(date -u +%s); age_s=$((now - mtime))
    fi
    if [ "$age_s" -lt $((7*86400)) ]; then check host_caps_fresh host OK "host-caps.json is fresh"
    else
      [ "$do_fix" -eq 1 ] && bash "$HERE/../../scripts/host.sh" caps >/dev/null 2>&1 || true
      check host_caps_fresh host WARN "host-caps.json is older than 7 days" "/agentic-git:init (re-probes host capabilities)"
    fi
  else
    check host_caps_fresh host WARN "host-caps.json missing" "/agentic-git:init"
  fi
else
  check host_scopes host WARN "gh not available/authenticated — skipping host checks" "gh auth login"
  check host_caps_fresh host WARN "gh not available/authenticated — skipping host checks" "gh auth login"
fi

# ---------------- state ----------------
sdir="$(state_dir)"
if [ -d "$sdir" ]; then
  check state_dir_exists state OK ".claude/agentic exists"
else
  check state_dir_exists state FAIL ".claude/agentic does not exist" "/agentic-git:init"
fi

cfg="$(config_file)"
if [ -f "$cfg" ] && jq_valid "$cfg"; then
  check state_config_parses state OK "config.json parses"
  sv="$(json_get "$cfg" .schema_version)"
  [ "$sv" = "1" ] && check state_schema_version state OK "config.json schema_version=1" \
    || check state_schema_version state WARN "config.json schema_version is '$sv' (expected 1)" "/agentic-git:init"
else
  check state_config_parses state FAIL "config.json missing or invalid" "/agentic-git:init"
  check state_schema_version state FAIL "cannot read schema_version" "/agentic-git:init"
fi

pf="$(profile_file)"
if [ -f "$pf" ] && jq_valid "$pf"; then
  check state_profile_parses state OK "project-profile.json parses"
else
  check state_profile_parses state FAIL "project-profile.json missing or invalid" "/agentic-git:scan"
fi

if [ -d "$sdir/epics" ] && [ -n "$(ls -A "$sdir/epics" 2>/dev/null)" ]; then
  lint_out="$(bash "$HERE/state-lint.sh" --json 2>/dev/null || true)"
  if [ -n "$lint_out" ] && jq -e '.ok' >/dev/null 2>&1 <<<"$lint_out"; then
    check state_frontmatter state OK "all epic/task frontmatter has required keys"
  else
    n="$(jq '.issues | length' <<<"$lint_out" 2>/dev/null || printf '?')"
    first_issue="$(jq -r '.issues[0] | "\(.file): \(.message)"' <<<"$lint_out" 2>/dev/null || printf 'see state-lint.sh --json')"
    check state_frontmatter state FAIL "$n frontmatter/dependency problem(s); e.g. $first_issue" "bash scripts/validate/state-lint.sh"
  fi
  # cycle check is folded into state-lint above; surface it as its own row for clarity
  if printf '%s' "$lint_out" | jq -e '.issues[]? | select(.message | startswith("dependency cycle"))' >/dev/null 2>&1; then
    cyc_msg="$(jq -r '.issues[] | select(.message | startswith("dependency cycle")) | .message' <<<"$lint_out" | head -1)"
    check state_no_cycles state FAIL "$cyc_msg" "fix the offending task's depends_on"
  else
    check state_no_cycles state OK "no dependency cycles"
  fi

  if have_cmd gh && gh auth status >/dev/null 2>&1; then
    mismatch=0
    for m in "$sdir"/epics/*/mapping.json; do
      [ -f "$m" ] || continue
      ei="$(json_get "$m" .epic_issue)"
      [ -n "$ei" ] || continue
      gh issue view "$ei" --json state >/dev/null 2>&1 || mismatch=$((mismatch+1))
    done
    [ "$mismatch" -eq 0 ] && check state_mapping_current state OK "mapping.json issue numbers resolve on GitHub" \
      || check state_mapping_current state WARN "$mismatch epic(s) reference an issue that no longer resolves" "/agentic-git:sync"
  else
    check state_mapping_current state WARN "gh not available — skipped GitHub reconciliation" "gh auth login"
  fi
else
  check state_frontmatter state OK "no epics yet"
  check state_no_cycles state OK "no epics yet"
  check state_mapping_current state OK "no epics yet"
fi

# ---------------- git ----------------
wt_dir="$(config_get .worktree_dir ".worktrees")"
wt_base="$(project_root)/$wt_dir"
bad_wt=0
if [ -d "$wt_base" ]; then
  while IFS= read -r line; do
    case "$line" in
      "worktree "*"$wt_dir"*) p="${line#worktree }"; [ -d "$p" ] || bad_wt=$((bad_wt+1)) ;;
    esac
  done < <(git worktree list --porcelain 2>/dev/null)
fi
[ "$bad_wt" -eq 0 ] && check git_worktrees_live git OK "all recorded worktrees exist on disk" \
  || check git_worktrees_live git WARN "$bad_wt worktree(s) recorded but missing on disk" "/agentic-git:cleanup"

gi_ok=1
if [ -f "$(project_root)/.gitignore" ]; then
  grep -qxF "$wt_dir/" "$(project_root)/.gitignore" 2>/dev/null || gi_ok=0
  grep -qxF ".claude/agentic/runtime/" "$(project_root)/.gitignore" 2>/dev/null || gi_ok=0
else
  gi_ok=0
fi
if [ "$gi_ok" -eq 1 ]; then
  check git_ignored git OK "$wt_dir/ and .claude/agentic/runtime/ are git-ignored"
else
  if [ "$do_fix" -eq 1 ]; then
    gif="$(project_root)/.gitignore"; : >> "$gif"
    grep -qxF "$wt_dir/" "$gif" 2>/dev/null || printf '%s/\n' "$wt_dir" >> "$gif"
    grep -qxF ".claude/agentic/runtime/" "$gif" 2>/dev/null || printf '.claude/agentic/runtime/\n' >> "$gif"
    check git_ignored git OK "$wt_dir/ and .claude/agentic/runtime/ are git-ignored (fixed)"
  else
    check git_ignored git WARN "$wt_dir/ and/or .claude/agentic/runtime/ are not git-ignored" "/agentic-git:init"
  fi
fi

# ---------------- config ----------------
settings="$(project_root)/.claude/settings.json"
if [ -f "$settings" ]; then
  if jq_valid "$settings"; then check config_settings_parses config OK ".claude/settings.json parses"
  else check config_settings_parses config FAIL ".claude/settings.json does not parse" "/agentic-git:adopt --only hooks"; fi
else
  check config_settings_parses config WARN ".claude/settings.json not found" "/agentic-git:adopt"
fi

nonexec=0
for h in "$sdir"/hooks/*.sh; do
  [ -f "$h" ] || continue
  [ -x "$h" ] || { [ "$do_fix" -eq 1 ] && chmod +x "$h" || nonexec=$((nonexec+1)); }
done
[ "$nonexec" -eq 0 ] && check config_hooks_executable config OK "hook scripts are executable" \
  || check config_hooks_executable config WARN "$nonexec hook script(s) not executable" "chmod +x .claude/agentic/hooks/*.sh (or doctor --fix)"

manifest="$(runtime_dir)/adopt-manifest.json"
if [ -f "$manifest" ]; then
  check config_sentinels config OK "adopt-manifest.json present (sentinel tracking active)"
else
  check config_sentinels config WARN "no adopt-manifest.json — CLAUDE.md/agent sentinels not tracked yet" "/agentic-git:adopt"
fi

# ---------------- profile ----------------
if [ -f "$pf" ] && jq_valid "$pf"; then
  tcmd="$(profile_get .commands.test)"
  if [ -n "$tcmd" ]; then check profile_test_command profile OK "commands.test: $tcmd"
  else check profile_test_command profile WARN "no test command resolved" "/agentic-git:scan --refresh"; fi
else
  check profile_test_command profile FAIL "no profile to read" "/agentic-git:scan"
fi

if [ "$do_fix" -eq 1 ]; then
  git worktree prune >/dev/null 2>&1 || true
  for d in "$sdir"/epics/*; do
    [ -d "$d/tasks" ] || continue
    bash "$HERE/../state/epic-progress.sh" "$(basename "$d")" >/dev/null 2>&1 || true
  done
fi

emit
any_fail && exit 1 || exit 0
