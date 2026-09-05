---
name: review
description: Review a pull request with parallel specialist agents — correctness and security, conventions and simplicity, and test coverage — then aggregate their findings into one prioritized report, post it as a single PR review, and optionally fix everything in one batched pass.
argument-hint: "<pr-number> [--angles correctness,conventions,tests] [--fix] [--post]"
user-invocable: true
model: opus
---

# review

Run specialist reviewers over one pre-fetched diff, aggregate, and post a single review.

Arguments: `$ARGUMENTS`.

Ground rules:

- Every script accepts `--help`; adapt from its help if an invocation is rejected. Never call `gh` — use `scripts/host.sh <verb>`.
- `--post` defaults **on** when a human invoked this skill and **off** when the model invoked it.
- Reviewers never run the test suite and never edit anything; the `pr` gate already ran the suite.

## Procedure

1. **Fetch the context once and share it** — never let three agents re-fetch the same diff.
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" pr-state <pr>     # number, state, refs, checks, closingIssues
   git fetch origin "<baseRefName>" "<headRefName>"
   git diff "origin/<baseRefName>...origin/<headRefName>" > .claude/agentic/runtime/review/<pr>.diff
   git diff --stat "origin/<baseRefName>...origin/<headRefName>"
   ```
   PR closed or not found ⇒ STOP. Diff over ~1500 changed lines ⇒ split it by top-level directory and give each reviewer its slice **plus the full file list**. Over 10k lines even after splitting ⇒ STOP and recommend splitting the PR.

2. **Choose the angles** (default: the first three).
   | Angle | When | Focus |
   |---|---|---|
   | correctness | always | logic errors, edge cases, error handling, silent failures, security-sensitive paths |
   | conventions | always | this repo's patterns from `CLAUDE.md` and neighbouring code, naming, layering, unnecessary complexity, duplication |
   | tests | test files changed or `commands.test != null` | coverage of the acceptance criteria, missing negative cases, flakiness |
   | migrations | the diff touches `**/migrations/**` | reversibility, ordering, data loss |
   `--angles a,b` replaces the set.

3. **Dispatch every chosen reviewer as a separate Agent tool call in ONE assistant message** (that is what makes them run in parallel). Each `reviewer` prompt contains: its single angle, the **path to the pre-fetched diff** (with "do not re-fetch, do not run the test suite, do not edit anything"), the closing issues' acceptance criteria, the profile's conventions and `CLAUDE.md`, and the required output shape:
   ```json
   [{"severity":"critical|important|nit","confidence":0-100,"file":"…","line":0,"finding":"…","suggestion":"…"}]
   ```
   plus a `strengths` array of at most three items. **Only findings with confidence ≥ 80 are reported** — quality over quantity; anything vaguer than "when `input` is empty, line 42 dereferences `undefined`" is dropped or demoted to a nit.

4. **Aggregate.** Drop everything below confidence 80, dedupe findings naming the same file+line (keep the highest severity), and bucket into **Critical / Important / Suggestions / Strengths**. Cap the posted list at 20 findings, keeping every critical. A reviewer returning malformed JSON is retried once, then its prose goes under "unstructured findings".

5. **Post — one review, never N comments** (when `--post`):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-comment <pr> --body-file .claude/agentic/runtime/review/<pr>.md
   ```
   The host layer has no `pr-comment` verb; on GitHub a PR shares the issue number namespace, so `issue-comment <pr>` posts to the pull request. Never approve and never request changes autonomously — approval is a human act (and GitHub rejects self-approval). If the human wants an approval, print the exact command for them to run.

6. **`--fix` — ONE batched dispatch.** Dispatch a single `implementer` with the entire findings list (criticals and importants), the absolute worktree path, and the union of the affected files as its scope. Never one fixer per finding: per-finding fixers cost more than the original work. Then re-run `commands.lint` and `commands.test`, commit (`fix(<scope>): address review findings (#<issue>)`) and `git push` — plain push, never `--force`. Re-run **only** the angles that had criticals, once. **Cap: 2 fix rounds.** At the cap, adjudicate every remaining finding as `contestable`, `non-blocking`, or `carry-forward-as-issue`, and record each as a ledger ruling.

7. **Follow-ups.** For each `carry-forward-as-issue` finding, offer (do not run silently):
   ```bash
   bash "${CLAUDE_PLUGIN_ROOT}/scripts/host.sh" issue-create --title "<finding>" --body-file <file> --labels "agentic" --parent <epic-issue>
   ```
   so nothing is silently dropped.

8. **Report** the four buckets, what was fixed, what was carried forward, and the ledger rows written. Next command: `/agentic-git:merge <pr>`.

## Outputs

The aggregated report in chat, one PR review comment, an optional fix commit, ledger rows, optional follow-up issues.

## Stop conditions

| Condition | Action |
|---|---|
| PR not found or closed | STOP |
| Diff > 10k lines after splitting | STOP — recommend splitting the PR |
| A reviewer fails twice | Continue with the others; say which angle is missing |
| A fix round would touch `config.protected_paths` | STOP — that change is the human's |
| 2 fix rounds exhausted | STOP after adjudicating and recording the remainder |
