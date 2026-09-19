---
name: issue-and-pr
description: The exact gh commands and the contract for issues, PRs, labels and the branch lock. Use when claiming an issue, opening a PR, or writing sub-issues as the planner.
---

# Issue and PR

Everything that goes to GitHub is in English. The full contract is in the plugin's
`docs/workflow.md`; this is the operating card.

## Claim (orchestrator only)

**The orchestrator creates the branch, not the implementer.** Run `scripts/claim.mts`,
located the way `skills/orchestrate` locates every plugin script — `CLAUDE_PLUGIN_ROOT`
with a `find ~/.claude/plugins` fallback (see that skill's step 0 for the three-line
locator) — and run from the repository root, since it reads the current working
directory's git:

```bash
node "$CLAIM" 42 --slug dashboard-kpis --type feat
```

`<type>` defaults to the title prefix (`feat(scope): …` → `feat`) when `--type` is
omitted, and must be one of `feat|fix|refactor|chore|docs|test|ci|deps` either way; a
title outside that set (e.g. `perf(ci): …`) has no type of its own, so pass `--type` with
a value from the set (whichever fits — `ci` for `perf(ci): …`). The push of a new ref
(`origin/<default>:refs/heads/<type>/<n>-<slug>`) is the lock — `git push --porcelain`,
not a local pre-check, decides a race between two agents of this route.

Two branch shapes lock an issue, one per route: `<type>/<n>-<slug>` here and
`codex/task-<n>` on the Codex route, in namespaces that never collide (both are listed in
`scripts/lib/issues.mts`). So `claim.mts` reads the remote's heads once before it pushes
(`git ls-remote --heads origin`, the remote itself, not local tracking refs) and any
branch it finds that locks the issue — the other route's, or this one's under a different
slug — is `{ held }` with nothing pushed. That read is an early refusal, never the lock:
it cannot see a branch pushed after it ran, which is why the create-only push still
decides the race. It fails closed — a `ls-remote` that cannot answer exits 1 with
`{ error }` naming it rather than assuming the issue is free.

Before that push, `claim.mts` runs `ci/issue-lint.mts` on the issue itself and refuses when
the result is not `ok: true` — a normal failure, or the lint's own `{ error }` when it
could not even run: `{ refused: "issue-lint failed", lint: <the lint JSON> }`, exit 1,
nothing pushed or relabelled. `issue-lint` checks the contract only — sections, globs,
the `authorised:` grants of `## Files`, `Blocked by:` numbers — and has nothing else to
pass through: the entry-point-reference
warning it used to run, and its opt-in strict flag, were both removed in #62 (see "Write
sub-issues" below); `--no-lint` skips the check entirely, and the success JSON then
reports `"lint": "skipped"` instead of `"lint": { "ok": true }`.

Exit 0 → `{ issue, branch, base, lint }`: pushed, assigned `@me`, relabelled
`state:in-progress` and labelled `type:` from the branch type (`feat` → `type:feature`,
`fix` → `type:bug`; `chore`, `test` and `ci` all → `type:infra`; `refactor`, `docs` and
`deps` keep their name — the mapping is `TYPE_LABELS` in `scripts/lib/issues.mts`).
Exit 2 → `{ held: "<branch>" }`: a branch that locks the issue already exists, so another
agent has it — possibly on the other route, under a branch this script would never have
pushed; skip, no retry, and never work that branch yourself. Exit 1 → `{ refused }`
(closed, missing `state:ready`, an open
`Blocked by:` issue, no `## Files` bullet, or a failing `issue-lint` — nothing pushed,
nothing relabelled) or `{ error }` (a usage problem — no type determinable and none given,
or an invalid `--type` — or a `gh`/`git` failure, the pre-push `ls-remote` read included). The implementer is born in a worktree on
that branch and **never creates or renames one**.

## Open the PR (implementer)

```bash
gh pr create --base main --head "$type/$n-$slug" --title "$type($scope): <imperative>" \
  --body-file pr.md --label state:in-review
```

That is the whole of it: the implementer never touches the issue. `gh issue edit` is
denied from inside a worktree by `hooks/protect-main.mts` (#237) — the issue body carries
the `## Files` globs and any `authorised:` line that widens them, so a session editing the
issue it is implementing could grant itself scope. The **orchestrator** moves the issue to
`state:in-review` at its step 4, beside the `type:`/`scope:` copy below and for the same
reason (`skills/orchestrate/SKILL.md`).

`pr.md` follows `.github/pull_request_template.md`: `Closes #N` in plain text (no bold, no
link) as the first line — `Fixes #N` and `Resolves #N` (and their close/closed, fix/fixed,
resolve/resolved forms) are also accepted, and a PR may link several issues this way, in
which case `scope` checks the diff against the union of every linked issue's globs. A
keyword inside backticks or a fenced code block is ignored, so never quote one as a
formatted example. Then the test summary, the globs touched, risks. The implementer sets
`state:in-review` and nothing else: **the orchestrator** copies the issue's `type:` and
`scope:` labels onto the PR at step 4, because an agent that labels its own work could
buy its own exemptions. `negative-control` no longer reads `type:` to decide a skip — it
skips by path class, and reads the label only to print a `note:`. `land` does read the
PR's labels, never the issue's: `type:docs` (`scripts/land.mts:230`, the exemption from
the *review*, never from the checks) and `review:approved` (`:255`, the marker label an
agent review leaves behind in both modes; mode `approved` requires the server's own
`APPROVED` on top and never falls back to the label alone). `scope` reads no label at
all — the PR's **body** for the closing keywords, and the **issues** those keywords link
for the globs and the `authorised:` grants. Never `gh pr merge`.

**The implementer stops here.** It does not wait on CI and does not poll the PR; the
orchestrator launches the reviewer and watches the checks, and the wait for the merge
itself is a script's, not a person's — `scripts/land.mts <pr> --wait` returns only once the
pull request is `MERGED`, or prints `{ queued, gate, mode, timeout }` when its bound
elapses. If CI or the reviewer sends it back, the implementer fixes in the same worktree.

## `## Files` and `authorised:` — the parser's rules

- Issue `## Files`: only **bullet lines** count. One or more globs per bullet, backticked
  (`` `src/**` ``) or bare, comma-separated. Prose on a non-bullet line is ignored; prose
  inside a bullet becomes a bogus glob and fails every real file. Put the reason on its own
  line under the bullet. The one exception is a bullet whose content starts `authorised:`:
  that is a grant, read once by the rule below and never as a glob of the issue (#231).
- Issue `## Files`, `authorised:` lines: a line starting `authorised:` (bullet or bare)
  grants one glob outside those bullets, and **only the orchestrator writes it**. The glob
  stands alone on the line (backticked, or the first token); the justification goes on the
  next line, indented, and it is not a bullet. `issue-lint` holds a grant to the two rules
  it holds the bullet globs to — the glob resolves, and no other issue in flight claims the
  file — and names it as a grant when it fails (#232).
- **One glob per grant line, and `issue-lint` refuses a line that carries two.** Every
  backticked span on a grant line used to be a granted glob, so a justification that quoted
  a path on the same line granted that path too — an over-grant, and an over-grant fails
  **open**: the path enters the audited scope silently and `scope` passes on a file nobody
  meant to grant. Writing it carefully is not a control; six such lines were written in one
  day, by the orchestrator, on the day that defect was being fixed. So a line with more than
  one backticked span is now **refused** — it grants none of them, and `issue-lint` fails the
  issue at dispatch naming the line and every span on it (#316). It is refused rather than
  narrowed to the first span: narrowing would swap a silent over-grant for a silent
  under-grant, and a line with two spans is a line whose author meant something this format
  cannot express. Fixing one is rewriting it, not deleting a backtick at random.
  - One backticked span, and only one, is the grant.
  - A justification on the **same** line is allowed only unbackticked — it adds no span.
  - A justification on a **continuation** line (indented, not a bullet) is read by no
    parser at all, so give it no backticks of its own: the habit is what keeps it off the
    grant line, and a *bulleted* continuation line is a different hazard — bullets are
    globs, so its backticks would become declared scope.
- PR `## Files`: prose. It grants nothing — the implementer writes that body, so a grant
  there would be a self-grant, and since #155 `scope` reports it as ignored and fails on
  the file anyway. An implementer that needs a file outside its globs asks the
  orchestrator for a grant **on the issue** and stops.

```
- authorised: `src/api/admin-create-user.ts`
  (orchestrator: needed for AC3; see the issue comment)
```

## Write sub-issues (planner)

```bash
node scripts/create-subissue.mts <parent> \
  --title "<type>(<scope>): <goal>" --body-file issue.md \
  --label scope:<s> --label type:<t>
```

One script, not the three-line snippet that used to stand here (create, resolve the
issue **id**, POST it to the parent's `sub_issues`) — that snippet is no longer the
contract. It refuses with `{ refused, parent, missing }` and exit 1 **before creating
anything** when the parent does not exist or is closed (`parent:state`), the parent
carries no milestone (`parent:milestone`), the title is not `<type>(<scope>): <goal>`
(`title:format`), or `--body-file` is missing or unreadable (`body:missing`). On success
it prints `{ issue, parent, milestone, linked: true, lint }`: the child inherits the
parent's milestone and is linked by its id.

`issue.md` follows `.github/ISSUE_TEMPLATE/task.md`. An issue is not dispatchable until
`ci/issue-lint.mts <n>` reports `ok: true` — `create-subissue.mts` runs that lint itself
and is the only thing that applies `state:ready` (never pass `--label state:ready`; it is
dropped from the creation). A body that fails the lint leaves the issue created and
linked, without `state:ready`, and the script exits 1 with the lint result, so it never
reaches `reconcile`'s `ready` list. See `skills/orchestrate` step 1 for the standalone
lint invocation. What CI, and `issue-lint`, will hold the issue to:
- **Files** are globs; the `scope` check compares `git diff --name-only` against them. Two
  issues in flight cannot have intersecting globs — `issue-lint` fails a sub-issue over
  this itself, against every other `state:ready`/`state:in-progress`/`state:in-review`
  issue in the same milestone, unless a `Blocked by:` relation orders the two (then it is
  reported as `sequenced`, not a failure). An `authorised:` grant counts on both sides of
  that comparison: a granted file is a file the pull request may touch, so a grant of
  yours against another issue's glob or grant — and the reverse — is the same
  intersection (#232).
- **Proof** names the test command and what it covers; `negative-control` reads the PR's
  diff, not the `test(red):` commit, to decide the red — the changed test files are copied
  onto the base and the suite must fail there. A branch may say otherwise in
  `proof/<slug>.json`, which **replaces** the diff's test files (and the detected command
  when it names one): the overlay is exactly what it names, no test glob is consulted, and
  a declaration the check cannot read — or one naming a path the head does not have, or a
  path outside the checkout — is `cannot-run`, not a fall back to the globs. The commit subject matters in one case: a
  red that is *structural* on the base (a missing module or export, a syntax error) is
  accepted only when a commit in `base..head` starting `test(red):` touches one of those
  test files; otherwise the check fails as `structural`. `issue-lint` accepts `## Validation` (the Codex route's
  name for the same section) in place of `## Proof`; one non-empty heading is enough.
- **Dependencies** as `Blocked by: #N`; the orchestrator does not dispatch a blocked issue.
- **Context** may carry an `Origin: <where this came from>` line. A finding from a dogfood
  report (`docs/dogfood/<date>.md`) is opened **directly as its own `state:ready` issue**
  carrying that line, copied verbatim from the finding's `origin` cell — never parked as a
  bullet in a mother issue, where it becomes a candidate nobody schedules (F12 of #96 came
  back as L21 of #129). The report owes the return half: its `outcome` cell names the `#N`,
  the merged PR or closed issue that already covered it, or a one-line reason it is not
  work, and `tests/dogfood-report.test.mts` fails a report that names none of the three.
  The line adds no lint rule — `## Context` is required and non-empty already. Format:
  `docs/dogfood/README.md`.
- Fits in one PR of roughly ≤ 800 useful lines; larger, split first.
- An issue that adds an entry point to an existing table, menu or list **names that file in
  `## Files` from the start**, not only the new feature's directory — otherwise the
  orchestrator ends up granting `authorised:` after the fact. `issue-lint` cannot catch a
  missing one itself any more: it used to `git grep` every covered path/basename against
  the rest of the tree and warn on a hit, but that fired on any ordinary import, doc or
  workflow mention of a covered path (not only a rename or removal), so it was removed in
  #62 along with its opt-in strict flag — `issue-lint` checks the contract only now
  (sections, globs, the `authorised:` grants, `Blocked by:` numbers). The mechanical form of this gap — a path a PR
  removes or
  renames while another tracked file outside the diff still names it, the shape #3 needed
  — moved to PR time instead, where a diff exists to tell a rename from an in-place edit:
  the `scope` job fails on it unless the referencing file sits inside the linked issue's
  globs or is granted with `authorised:` (#51). Widen `## Files` to cover the referencing
  file up front rather than relying on that check or the grant.
- An acceptance criterion that names a **symbol** — a function, class or constant the change
  must **reuse by import** rather than copy — **names the file holding it in `## Files`**,
  the same way an entry point does. A criterion that asks for the import while the file
  holding the symbol sits outside the globs leaves the implementer choosing between a
  workaround and a grant after the fact, neither of which is the work the criterion asked
  for (`docs/dogfood/2026-09-06.md`, finding F10). The file is named even when the change
  does not edit it: reading a symbol from inside the globs is what makes the import
  reviewable.
- An issue that **renames or re-owns a label, flag or command lists in `## Files` every
  document that names it** — `docs/`, the skill cards, `templates/`, the workflows,
  `labels.json` — so the rename lands in one round. Find them while the issue is written,
  with `git grep -n '<old name>'`, not when a reviewer finds the stale ones: that is a
  measured round-2 cost, where the implementer correctly refused to touch documents outside
  its globs and the orchestrator had to grant `authorised:` lines for them
  (`docs/dogfood/2026-09-10.md`, finding L19). `scope`'s rename check does not save this
  one — it fires on a path the diff deletes or renames, not on prose that has gone stale
  around a name that still exists.

## Labels

`state:` ready → in-progress → in-review; `qa-failed` goes back to the implementer;
`blocked` after two rounds, always with `human:pending`; a person flips that to
`human:decided` when the decision is recorded, and the decided label stays as the audit
trail (bare `human` from before the split reads as pending). There is no `done` value: `Closes #N`
closes the issue when its PR merges, and a closed issue is a done issue — nothing to
relabel. `review:approved` is applied by the orchestrator in both modes, after the reviewer
returns `approved` (the reviewer itself only returns the verdict — see
`skills/orchestrate` step 5); it is never a fallback for a missing token. By default it
is the approval, pinned to the reviewed head by the `<!-- agentic-reviewed-sha: <oid> -->`
marker the orchestrator comments beside it. In the opt-in `approved` mode —
`AGENTIC_REVIEWER_TOKEN` configured for the reviewer's own environment — the reviewer also
casts a real GitHub review as that separate identity, and `scripts/land.mts` gates on that
server-verified review instead (`docs/decisions.md` item 18). `scope:` and `type:` by
whoever writes the issue. A new dependency is a `type:deps` issue for the orchestrator.
