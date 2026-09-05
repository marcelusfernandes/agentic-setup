#!/usr/bin/env bash
# smoke test for the git-host layer (scripts/host.sh + scripts/host/github/*.sh).
# NO network: a fake `gh` on PATH logs argv and returns canned JSON.
. "$(dirname "$0")/../lib.sh"

FAKE_BIN="$TMP_BASE/fakebin"
mkdir -p "$FAKE_BIN"
GH_LOG="$TMP_BASE/gh.log"
: > "$GH_LOG"
export GH_FAKE_LOG="$GH_LOG"

cat > "$FAKE_BIN/gh" <<'SHIM'
#!/usr/bin/env bash
# Fake gh CLI for tests/smoke.d/60-host.sh. Logs full argv; returns canned JSON.
set -u
: "${GH_FAKE_LOG:?GH_FAKE_LOG must be set}"
printf '%s\n' "$*" >> "$GH_FAKE_LOG"

has_flag() {
  local want="$1"; shift
  local a
  for a in "$@"; do [ "$a" = "$want" ] && return 0; done
  return 1
}
arg_after() {
  local want="$1"; shift
  local prev=""
  local a
  for a in "$@"; do
    [ "$prev" = "$want" ] && { printf '%s' "$a"; return 0; }
    prev="$a"
  done
  return 1
}

cmd="${1:-}"; sub="${2:-}"

if [ "$cmd" = "api" ]; then
  endpoint="${2:-}"
  case "$endpoint" in
    rate_limit)
      echo '{"rate":{"remaining":5000,"reset":0}}'; exit 0 ;;
    repos/*/milestones/*)
      echo '{"number":4,"title":"v1.0","state":"closed","open_issues":0,"closed_issues":0}'; exit 0 ;;
    repos/*/milestones*)
      if has_flag "-f" "$@"; then
        echo '{"number":4,"title":"v1.0","state":"open","open_issues":0,"closed_issues":0}'
      else
        echo '[]'
      fi
      exit 0 ;;
    repos/*/issues*page=1*)
      echo '[{"number":201,"html_url":"https://github.com/o/r/issues/201","title":"Epic: demo","state":"open","body":"intro\n<!-- agentic-git:epic=demo-epic id=001 -->\n"}]'
      exit 0 ;;
    repos/*/issues*page=2*)
      echo '[]'; exit 0 ;;
    repos/*/issues/*)
      echo '{"id":987654321,"number":42,"body":"hello"}'; exit 0 ;;
    *)
      echo '{}'; exit 0 ;;
  esac
fi

case "$cmd $sub" in
  "issue create")
    if has_flag "--help" "$@"; then
      cat <<'EOF'
Usage: gh issue create [flags]
  -t, --title string
  -F, --body-file string
  -l, --label stringArray
  -m, --milestone string
      --parent int
      --blocked-by ints
EOF
      exit 0
    fi
    echo "https://github.com/o/r/issues/123"; exit 0 ;;
  "issue edit")
    if has_flag "--help" "$@"; then
      cat <<'EOF'
Usage: gh issue edit [flags]
      --add-sub-issue ints
      --add-blocked-by ints
EOF
      exit 0
    fi
    exit 0 ;;
  "issue view")
    echo '{"number":42,"state":"OPEN","labels":[{"name":"agentic"},{"name":"status:ready"}]}'; exit 0 ;;
  "issue close")
    exit 0 ;;
  "issue comment")
    echo "https://github.com/o/r/issues/42#issuecomment-999"; exit 0 ;;
  "pr view")
    echo '{"number":7,"state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":[{"name":"build","status":"COMPLETED","conclusion":"SUCCESS"}],"headRefName":"feat/7-x","baseRefName":"main","headRefOid":"abc123","closingIssuesReferences":[{"number":42}],"url":"https://github.com/o/r/pull/7","mergeCommit":{"oid":"deadbeef"}}'
    exit 0 ;;
  "pr list")
    head_val=$(arg_after "--head" "$@") || head_val=""
    if [ "$head_val" = "existing/branch" ]; then
      echo '[{"number":99,"url":"https://github.com/o/r/pull/99"}]'
    else
      echo '[]'
    fi
    exit 0 ;;
  "pr create")
    echo "https://github.com/o/r/pull/7"; exit 0 ;;
  "pr merge")
    exit 0 ;;
  *)
    echo "fake-gh: unhandled invocation: $*" >&2
    exit 1 ;;
esac
SHIM
chmod +x "$FAKE_BIN/gh"
export PATH="$FAKE_BIN:$PATH"
export AGENTIC_NO_SLEEP=1

REPO=$(make_repo)
cd "$REPO"
HOST_SH="$PLUGIN_ROOT/scripts/host/github"

# Give default_branch() a local answer so it never falls through to a network
# `git remote show origin` call against the fake/nonexistent remotes below.
mkdir -p .git/refs/remotes/origin
git symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main

# ---------------------------------------------------------------- repo-info
t_begin "repo-info parses an ssh remote (git@host:owner/name.git)"
git remote add origin git@github.com:o/r.git
out=$(bash "$HOST_SH/repo-info.sh") ; rc=$?
if [ "$rc" = "0" ]; then
  owner=$(printf '%s' "$out" | jq -r .owner); name=$(printf '%s' "$out" | jq -r .name); db=$(printf '%s' "$out" | jq -r .default_branch)
  if [ "$owner" = "o" ] && [ "$name" = "r" ] && [ "$db" = "main" ]; then t_ok; else t_fail "got: $out"; fi
else
  t_fail "exit $rc: $out"
fi

t_begin "repo-info parses an https remote"
git remote set-url origin https://github.com/acme/widgets.git
out=$(bash "$HOST_SH/repo-info.sh")
owner=$(printf '%s' "$out" | jq -r .owner); name=$(printf '%s' "$out" | jq -r .name)
assert_eq "acme widgets" "$owner $name"

t_begin "repo-info exits 2 for a non-github.com origin"
git remote set-url origin git@gitlab.com:o/r.git
assert_exit 2 bash "$HOST_SH/repo-info.sh"

t_begin "repo-info exits 3 for the plugin's own repo"
git remote set-url origin git@github.com:marcelusfernandes/agentic-setup.git
assert_exit 3 bash "$HOST_SH/repo-info.sh"

t_begin "repo-info --allow-self bypasses the self-repo guard"
assert_exit 0 bash "$HOST_SH/repo-info.sh" --allow-self

git remote set-url origin git@github.com:o/r.git

# ---------------------------------------------------------------- caps
t_begin "caps.sh detects native flags via --help grep"
out=$(bash "$HOST_SH/caps.sh" --no-cache)
np=$(printf '%s' "$out" | jq -r .native_parent)
nb=$(printf '%s' "$out" | jq -r .native_blocked_by)
ns=$(printf '%s' "$out" | jq -r .native_sub_issue_edit)
if [ "$np" = "true" ] && [ "$nb" = "true" ] && [ "$ns" = "true" ]; then t_ok; else t_fail "got: $out"; fi

# ---------------------------------------------------------------- issue-find
t_begin "issue-find returns the marker match (bounded pagination)"
out=$(bash "$HOST_SH/issue-find.sh" --marker "agentic-git:epic=demo-epic id=001")
num=$(printf '%s' "$out" | jq -r '.[0].number')
assert_eq "201" "$num"

# ---------------------------------------------------------------- issue-create
t_begin "issue-create passes --parent when caps report native support"
: > "$GH_LOG"
out=$(bash "$HOST_SH/issue-create.sh" --title "Sub task" --body-file /dev/null --labels task,agentic --parent 100)
num=$(printf '%s' "$out" | jq -r .number)
if [ "$num" = "123" ] && grep -q -- '--parent 100' "$GH_LOG"; then t_ok; else t_fail "num=$num log: $(cat "$GH_LOG")"; fi

# ---------------------------------------------------------------- issue-link
t_begin "issue-link uses native mode when caps allow it"
: > "$GH_LOG"
out=$(bash "$HOST_SH/issue-link.sh" --parent 100 --children 101,102)
mode=$(printf '%s' "$out" | jq -r .mode)
assert_eq "native" "$mode"

t_begin "issue-link native mode calls --add-sub-issue, not the REST fallback"
assert_contains "$(cat "$GH_LOG")" '--add-sub-issue 101,102'

# ---------------------------------------------------------------- pr-create
echo "PR body" > "$TMP_BASE/pr-body.md"

t_begin "pr-create creates a PR when none exists for --head"
: > "$GH_LOG"
out=$(bash "$HOST_SH/pr-create.sh" --base main --head feat/7-x --title "feat: x" --body-file "$TMP_BASE/pr-body.md")
num=$(printf '%s' "$out" | jq -r .number)
assert_eq "7" "$num"

t_begin "pr-create is idempotent: returns the existing PR instead of creating another"
: > "$GH_LOG"
out=$(bash "$HOST_SH/pr-create.sh" --base main --head existing/branch --title "x" --body-file "$TMP_BASE/pr-body.md")
num=$(printf '%s' "$out" | jq -r .number)
if [ "$num" = "99" ] && ! grep -q "^pr create" "$GH_LOG"; then t_ok; else t_fail "num=$num log: $(cat "$GH_LOG")"; fi

# ---------------------------------------------------------------- pr-state / pr-merge
t_begin "pr-state reshapes gh pr view into the contract shape"
out=$(bash "$HOST_SH/pr-state.sh" 7)
assert_eq "CLEAN" "$(printf '%s' "$out" | jq -r .mergeStateStatus)"
assert_eq "42" "$(printf '%s' "$out" | jq -r '.closingIssues[0]')"
assert_eq "SUCCESS" "$(printf '%s' "$out" | jq -r '.checks[0].conclusion')"

t_begin "pr-merge never emits --admin"
: > "$GH_LOG"
out=$(bash "$HOST_SH/pr-merge.sh" 7 --strategy squash --delete-branch --match-head abc123)
merged=$(printf '%s' "$out" | jq -r .merged)
if [ "$merged" = "true" ] && ! grep -q -- '--admin' "$GH_LOG"; then t_ok; else t_fail "merged=$merged log: $(cat "$GH_LOG")"; fi

# ---------------------------------------------------------------- milestone
t_begin "milestone ensure creates a new milestone when none matches by title"
out=$(bash "$HOST_SH/milestone.sh" ensure "v1.0")
num=$(printf '%s' "$out" | jq -r .number)
assert_eq "4" "$num"

t_begin "milestone list returns a JSON array"
out=$(bash "$HOST_SH/milestone.sh" list)
assert_eq "array" "$(printf '%s' "$out" | jq -r 'type')"

# ---------------------------------------------------------------- issue-close / issue-label / issue-comment
t_begin "issue-close closes and reports state"
out=$(bash "$HOST_SH/issue-close.sh" 42 --reason completed)
assert_eq "42" "$(printf '%s' "$out" | jq -r .number)"

t_begin "issue-label is idempotent (only calls gh issue edit when something changes)"
: > "$GH_LOG"
out=$(bash "$HOST_SH/issue-label.sh" 42 --add agentic --remove missing-label)
if ! grep -q "^issue edit" "$GH_LOG"; then t_ok; else t_fail "expected no edit call, log: $(cat "$GH_LOG")"; fi

t_begin "issue-comment returns id and url"
out=$(bash "$HOST_SH/issue-comment.sh" 42 --body "hi")
assert_eq "999" "$(printf '%s' "$out" | jq -r .id)"

# ---------------------------------------------------------------- host.sh dispatcher
t_begin "host.sh dispatches a verb to the github implementation"
out=$(bash "$PLUGIN_ROOT/scripts/host.sh" caps --no-cache)
assert_contains "$out" '"native_parent"'

t_begin "host.sh --help lists verbs"
out=$(bash "$PLUGIN_ROOT/scripts/host.sh" --help)
assert_contains "$out" "issue-create"

t_begin "host.sh rejects an unknown verb with exit 2"
assert_exit 2 bash "$PLUGIN_ROOT/scripts/host.sh" nonsense-verb

t_begin "host.sh rejects an unknown host with exit 2"
mkdir -p .claude/agentic
printf '{"host":"bitbucket"}\n' > .claude/agentic/config.json
assert_exit 2 bash "$PLUGIN_ROOT/scripts/host.sh" caps
rm -rf .claude/agentic

cd "$PLUGIN_ROOT"
t_summary "60-host"
