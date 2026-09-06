---
name: safe-worktree
description: How to work in an isolated git worktree without losing work or breaking a shared local service. Use at the start of every implementation in a worktree and whenever the write hook complains.
---

# Safe worktree

Almost all turbulence comes from several writers in one tree; isolating first solves most
of it. What is left is below.

## A. Before the first line

1. **Did the secrets arrive?** A worktree is born with tracked files only;
   `.worktreeinclude` copies the rest. `test -f .env.local || echo "no .env.local"` (or
   whatever your project's untracked essentials are).
2. **Is the base right?** `git fetch origin && git merge-base --is-ancestor origin/main HEAD`
   and, if the issue depends on another, `grep -rn "<symbol the prerequisite delivered>"`
   must find it. A stale worktree does not see what another issue merged.
3. **Can I write?** `printf x > .scratch && rm .scratch`. The write guard complains now, not
   on the third edit.
4. **Will you touch a shared local service** (database, cache, dev server)? Give this
   worktree its own instance — ports and names derived from the worktree path — and stop
   it before the worktree is removed. Two agents on one local database is how one agent's
   reset lands under another's test run.

## B. While working

5. **No destructive git.** `stash`, `reset --hard`, `checkout <file>`, `clean` delete
   uncommitted work. To compare, `git diff <ref>` and `git show <ref>:<path>`. Lost
   something? `git reflog` first.
6. **Checkpoint at every green.** A test that passed, a clean type-check: commit. The only
   copy of uncommitted work is this tree.
7. **A red test compiles.** A test that imports a missing symbol is a compile error and
   jams the gate. Export a stub that throws (`throw new Error('not implemented')`) so the red
   is a runtime red. Commit as `test(red): …`; that is the commit the `negative-control`
   check reads to prove the test fails on the base.
8. **Check with the exact gate command**, not a partial one. A type-check on one package
   gives a false green; so does running a single test file when the gate runs the suite.
   There is no Stop hook to run it for you — CI is the only gate, so run it yourself
   before opening or updating the PR.
9. **Distrust an old error.** A failure from three edits ago is not evidence about now —
   run the check and test commands again before trusting a "fixed" from memory.

## C. Round 2 or later of the same issue

You were born in a new worktree; the previous round's is not yours and the sandbox refuses
git in it. Start from the remote (`git fetch origin && git checkout -b <branch>-rN
origin/<branch>`), work, and finish with `git push origin HEAD:<branch>` — fast-forward,
never force. If the push is not fast-forward, someone touched the branch: `git merge
origin/<branch>` and try again.

## D. Conflict with `main`

**Branch not yet published:** `git fetch origin && git rebase origin/main`.
**Branch already published (PR open):** `git fetch origin && git merge origin/main`, resolve,
merge commit, normal push. A rebase here would need a force-push, which is denied on every
branch; the final squash flattens the history anyway. Afterwards run the test and check
commands again before updating the PR.
