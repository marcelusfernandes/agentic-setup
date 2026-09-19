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
   is a runtime red. Commit as `test(red): …` — `negative-control` reads the PR's diff,
   not any commit, and copies the changed test files onto the base to prove they fail
   there. Unless the branch declares its proof: when `proof/<slug>.json` exists in the
   head commit it **replaces** the diff's test files — the overlay is exactly the files
   it names, and its `command` replaces the detected test command — and a declaration
   the check cannot read, or that names a path the head does not have or a path outside
   the checkout, is `cannot-run`, never a quiet fall back to the diff. It reads the commits for one thing only, and this is the case where the
   convention becomes mechanical: when the red on the base is *structural* (a missing
   module or export, a syntax error) the check requires a `test(red):` commit in
   `base..head` touching one of those overlaid test files — that commit is the vouch for
   a structural red. Without one the check fails as `structural`, and the fix is either
   the stub above (turn the red into a runtime red) or the missing `test(red):` commit.
   A red is not enough on its own either: the check reads *which file* failed, and a
   run whose failures name no overlaid file is `unattributed`, not a pass — something
   else was already broken, and the fix is that, not this branch (#354). Which is the
   other reason to write the throwing stub: a thrown error prints the file in its
   stack, so the red says whose it is.
8. **Check with the exact gate command**, not a partial one. A type-check on one package
   gives a false green; so does running a single test file when the gate runs the suite.
   Run it yourself before opening or updating the PR. The `SubagentStop` gate
   (`hooks/stop-gate.mts`) runs the detected check and test commands when you try to stop
   and blocks the stop while either is red, but it is a backstop, not your turn: it caps
   at three consecutive blocks, exempts a `test(red):` last commit, and lets the stop
   through when it cannot judge — a command that times out or cannot be spawned, a counter
   it cannot write. A command that *ran* and proved nothing is not in that list: an exit
   127 (the runner is not installed) or more output than the gate can hold (ENOBUFS)
   blocks like any other red, and counts towards the cap. A block arrives as
   `[agentic-setup/stop-gate] the test command … is red`, with the last lines of the
   failing output — fix that, do not work around the gate.
   **A silent green is not proof the gate ran.** It judges the directory the stop event
   carries as its `cwd`: your worktree when you were spawned with `isolation: "worktree"`
   or when the session's own cwd is the worktree, but the *session's* checkout when an
   agent merely `cd`s into a worktree — and a session on `main` is never gated at all
   (measured, three headless runs: #137, comment 5715271545). That is the case where
   nothing at all ran, so §B8's first sentence stands: run the exact gate command
   yourself.
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
