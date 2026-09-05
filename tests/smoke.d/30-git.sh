#!/usr/bin/env bash
# smoke: scripts/git/*.sh — architecture.md §10.3 items 11-12, plus preflight/clean-gone/conflict-classify.
. "$(dirname "$0")/../lib.sh"

G="$PLUGIN_ROOT/scripts/git"

gv=$(git --version | awk '{print $3}')
maj=${gv%%.*}; rest=${gv#*.}; min=${rest%%.*}
git_new_enough=1
if [ "$maj" -lt 2 ] || { [ "$maj" -eq 2 ] && [ "$min" -lt 38 ]; }; then git_new_enough=0; fi

# ---------- preflight.sh on a clean repo (no origin -> use --no-fetch) ----------
t_begin "preflight.sh: clean repo with --no-fetch --base main succeeds"
REPO=$(make_repo)
assert_exit 0 bash -c "cd '$REPO' && bash '$G/preflight.sh' --base main --no-fetch"

t_begin "preflight.sh: dirty tree -> exit 3 with a STOP message"
echo dirty > "$REPO/dirty.txt"
out=$( cd "$REPO" && bash "$G/preflight.sh" --base main --no-fetch 2>&1 )
rc=0; ( cd "$REPO" && bash "$G/preflight.sh" --base main --no-fetch >/dev/null 2>&1 ) || rc=$?
if [ "$rc" = 3 ] && printf '%s' "$out" | grep -q '^STOP:'; then t_ok; else t_fail "rc=$rc out=[$out]"; fi
rm -f "$REPO/dirty.txt"

# ---------- 11. mergecheck.sh: clean vs conflicting ----------
if [ "$git_new_enough" -eq 1 ]; then
  t_begin "mergecheck.sh: two non-overlapping branches merge cleanly (exit 0)"
  R=$(make_repo)
  ( cd "$R" \
    && printf 'a\n' > a.txt && git add a.txt && git commit -qm a \
    && git checkout -qb feat/a \
    && printf 'a2\n' >> a.txt && git add a.txt && git commit -qm a2 \
    && git checkout -q main \
    && git checkout -qb feat/b \
    && printf 'b\n' > b.txt && git add b.txt && git commit -qm b )
  assert_exit 0 bash -c "cd '$R' && bash '$G/mergecheck.sh' feat/a feat/b"

  t_begin "mergecheck.sh: two branches editing the same line conflict (exit 1, path listed)"
  R2=$(make_repo)
  ( cd "$R2" \
    && printf 'line1\nline2\n' > f.txt && git add f.txt && git commit -qm base \
    && git checkout -qb feat/x \
    && printf 'line1\nCHANGED-X\n' > f.txt && git add f.txt && git commit -qm x \
    && git checkout -q main \
    && git checkout -qb feat/y \
    && printf 'line1\nCHANGED-Y\n' > f.txt && git add f.txt && git commit -qm y )
  mcout=$( cd "$R2" && bash "$G/mergecheck.sh" feat/x feat/y; )
  mcrc=0; ( cd "$R2" && bash "$G/mergecheck.sh" feat/x feat/y >/dev/null 2>&1 ) || mcrc=$?
  if [ "$mcrc" = 1 ] && printf '%s' "$mcout" | grep -q 'f.txt'; then t_ok; else t_fail "rc=$mcrc out=[$mcout]"; fi
else
  t_begin "mergecheck.sh tests skipped: git $gv < 2.38"
  t_fail "SKIPPED (git too old for merge-tree --write-tree): $gv"
fi

# ---------- 12. worktree-remove.sh refuses on untracked file, never --force ----------
t_begin "worktree-add.sh: creates a new worktree on a new branch"
R3=$(make_repo)
# no real remote in this throwaway repo — fake an origin/main ref pointing at HEAD so
# worktree-add.sh's "branch off origin/<base>" path has something to resolve.
( cd "$R3" && git update-ref refs/remotes/origin/main refs/heads/main )
addout=$( cd "$R3" && bash "$G/worktree-add.sh" wt1 feat/wt1 --base main )
wtpath=$(printf '%s' "$addout" | jq -r '.path')
assert_contains "$addout" '"created":true'

t_begin "worktree-remove.sh: refuses when an untracked file is present, and never passes --force"
: > "$wtpath/untracked.txt"
rc=0; rmout=$( cd "$R3" && bash "$G/worktree-remove.sh" "$wtpath" 2>&1 ) || rc=$?
still_there=0; [ -d "$wtpath" ] && still_there=1
if [ "$rc" = 3 ] && [ "$still_there" = 1 ]; then t_ok
else t_fail "rc=$rc still_there=$still_there out=[$rmout]"; fi

t_begin "worktree-remove.sh: --confirm-token discard removes it despite the untracked file"
rmout2=$( cd "$R3" && bash "$G/worktree-remove.sh" "$wtpath" --confirm-token discard )
assert_eq 0 "$( [ -d "$wtpath" ] && echo 1 || echo 0 )"

# ---------- clean-gone.sh --dry-run ----------
t_begin "clean-gone.sh: --dry-run changes nothing and does not error"
R4=$(make_repo)
( cd "$R4" && git branch feat/stale )
assert_exit 0 bash -c "cd '$R4' && bash '$G/clean-gone.sh' --dry-run"
t_begin "clean-gone.sh: a plain local branch (no upstream) is not reported as gone"
cgout=$( cd "$R4" && bash "$G/clean-gone.sh" --dry-run )
if printf '%s' "$cgout" | grep -q 'feat/stale'; then t_fail "should not touch a branch with no upstream: $cgout"; else t_ok; fi

# ---------- conflict-classify.sh: one trivial-identical conflict, one semantic conflict ----------
t_begin "conflict-classify.sh: identical-after-whitespace conflict classified trivial"
R5=$(make_repo)
( cd "$R5" \
    && printf 'one\ntwo\nthree\n' > shared.txt && printf 'orig\n' > sem.txt \
    && git add shared.txt sem.txt && git commit -qm base \
    && git checkout -qb feat/left \
    && printf 'one\ntwo \nthree\n' > shared.txt \
    && printf 'left-version\n' > sem.txt \
    && git add shared.txt sem.txt && git commit -qm left \
    && git checkout -q main \
    && git checkout -qb feat/right \
    && printf 'one\ntwo\t\nthree\n' > shared.txt \
    && printf 'right-version\n' > sem.txt \
    && git add shared.txt sem.txt && git commit -qm right \
    && git checkout -q main )
( cd "$R5" && git merge feat/left >/dev/null 2>&1 ) || true
( cd "$R5" && git merge feat/right >/dev/null 2>&1 ) || true
ccout=$( cd "$R5" && bash "$G/conflict-classify.sh" --json )
shared_class=$(printf '%s' "$ccout" | jq -r '.[] | select(.path=="shared.txt") | .class')
sem_class=$(printf '%s' "$ccout" | jq -r '.[] | select(.path=="sem.txt") | .class')
assert_eq "trivial" "$shared_class"

t_begin "conflict-classify.sh: a real content conflict classified semantic"
assert_eq "semantic" "$sem_class"

t_summary "30-git"
