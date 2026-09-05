---
name: merge
description: Merge a reviewed pull request safely — preflight with a merge-tree dry run against the base, CI status and review decision, then merge with the configured strategy, close the issues, remove the worktree and branch, and update epic progress.
argument-hint: "<pr-number> | epic <epic-slug> [--strategy squash|merge|rebase] [--auto] [--no-cleanup]"
disable-model-invocation: true
user-invocable: true
model: sonnet
---

# merge

Land one PR — or a whole epic's PRs as a train — behind gates that are re-checked after every merge.

Arguments: `$ARGUMENTS`.

Ground rules:

- Every script accepts `--help`; adapt from its help if an invocation is rejected. Never call `gh` — use `scripts/host.sh <verb>`.
- Strategy = `--strategy` or `config.merge_strategy` (default `squash`). `--admin` is never emitted. `git branch -D`, `git worktree remove --force` and `git push --force` are never emitted.
- Never type a stack command literally; gates here are host-side, not stack-side.

## Procedure — a single PR

1. **Read the PR state.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" pr-state <pr>
   ```
   ⇒ `{number,state,isDraft,mergeable,mergeStateStatus,reviewDecision,checks[],headRefName,baseRefName,headRefOid,closingIssues[]}`.

2. **Gate table — every FAIL is a STOP**, reported with the reason and the exact command that fixes it:
   | Gate | Pass condition | Config key |
   |---|---|---|
   | state | `OPEN` and `isDraft == false` | — |
   | conflicts | `mergeStateStatus != "DIRTY"` | — |
   | CI | every check is `SUCCESS`, `NEUTRAL` or `SKIPPED` | `require_ci` |
   | review | `reviewDecision == "APPROVED"` | `require_review` |
   | branch protection | `mergeStateStatus != "BLOCKED"` | — |
   | issue links | at least one `closingIssues` entry, or `--allow-unlinked` | — |
   `mergeStateStatus == "BEHIND"` is **not** a failure: offer to update the branch (or rebase via `/agentic-git:resolve-conflicts`) and re-read the state. `mergeable == "UNKNOWN"` is not trusted either way — step 3 decides.

3. **Independent dry run** — GitHub's `mergeable` can be stale, so verify locally:
   ```bash
   git fetch origin "<baseRefName>" "<headRefName>"
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/mergecheck.sh" "origin/<baseRefName>" "origin/<headRefName>"
   ```
   Exit 0 ⇒ clean, proceed. Exit 1 ⇒ print the conflicted paths and route to `/agentic-git:resolve-conflicts <pr>`; **do not merge**. Exit ≥2 ⇒ STOP and show the output raw — the merge could not even be attempted.

4. **Merge.**
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" pr-merge <pr> \
     --strategy "<squash|merge|rebase>" --delete-branch --match-head "<headRefOid>"
   ```
   `--match-head` is mandatory: it makes the merge refuse if anyone pushed since the preflight, which is what turns the gate sequence into something atomic. A mismatch is not an error to retry blindly — re-run steps 1–3.
   `--auto` instead requests auto-merge, records `pending-auto` in `mapping.json`, and **exits without cleanup** (auto-merge is fire-and-forget).

5. **Post-merge** (unless `--no-cleanup`):
   ```bash
   git fetch origin --prune
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/git/worktree-remove.sh" "<worktree>"   # plain remove; on refusal, report and stop cleaning
   git branch -d "<branch>"                                                   # safe delete only
   git worktree prune -v
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/state/epic-progress.sh" "<slug>"
   ```
   - **Issue closing:** GitHub closes the issues named by `Closes #N` when the PR merges. Only close the leftovers — issues in `closingIssues[]` or the task mapping that are still open:
     ```bash
     bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-close <n> --reason completed --comment "Merged in #<pr>"
     ```
     Never close an issue that is not in that set.
   - **Labels:** `issue-label <n> --remove "status:in-review,status:in-progress"` for each closed issue.
   - **State:** `mapping.json` (`worktree: null`, `pr`, `state: merged`), task frontmatter `status: closed`, `updated`.
   - `epic-progress.sh` rewrites `progress:` in `epic.md`; when every task is closed, **offer** (do not run) closing the epic issue and its milestone via `/agentic-git:cleanup --archive`.
   - Append one ledger row: what merged, with which strategy, and which gates were waived.

6. **Report** what merged, what closed, what was cleaned, what was skipped and why, and the epic's new progress.

## Procedure — `epic <slug>` (merge train)

1. Collect the epic's open PRs from `mapping.json` (+ `pr-state` per PR). Dispatch the `integration-manager` agent with that set to compute the order; it returns an ordered list with a verdict and a reason per PR. It never merges anything.
2. **Order** (`references/parallelism.md` §4): topological by task `depends_on`; within a level, ascending total changed lines (`git diff --shortstat origin/<base>...origin/<head>`) — small PRs land clean and the large one absorbs the rebase cost once; ties by ascending PR number so a re-run is deterministic.
3. For each PR in order, run the single-PR procedure above. **After every successful merge**, `git fetch origin` and re-run `mergecheck.sh` for **all** remaining PRs — a merge invalidates every earlier dry run. Anything now conflicting moves to the end of the train and is flagged.
4. The first hard failure stops the train; the remaining PRs are untouched and reported. `--continue-on-conflict` skips the conflicting PR and continues.
5. `rerere` (enabled by `init`) replays a conflict resolved once earlier in the train — say so when it fires.

## Outputs

Merged PR(s), closed issues, removed worktrees and branches, recomputed epic progress, ledger rows.

## Stop conditions

| Condition | Action |
|---|---|
| Any gate FAIL | STOP with the failing gate and its fix command |
| `mergecheck.sh` exit 1 | STOP — `/agentic-git:resolve-conflicts <pr>` |
| `mergecheck.sh` exit ≥2 | STOP — raw output |
| `--match-head` mismatch | STOP — someone pushed; re-run the preflight |
| Worktree removal refused | Report the refusal verbatim and skip; never `--force` |
| Protected-branch rejection | STOP — the human merges or adjusts protection |
