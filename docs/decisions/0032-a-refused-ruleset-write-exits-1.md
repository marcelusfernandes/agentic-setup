# 0032. A refused ruleset write exits 1; a failed read still exits 0

Status: proposed
Date: 2026-09-19

Landed with #373 (PR #375), which implements the rule below in the same diff. It is
written here rather than left in that pull request's body because it changes what a
**flag** of `scripts/init.mts` does — both what `--rules` sends and what the run exits
with — and [`README.md`](README.md) ("What becomes a numbered decision") makes a flag and
what it changes a numbered item in the pull request that makes it. The precedent is exact
and on this same flag of this same script: PR #317 shipped `scripts/init.mts`,
`skills/init/SKILL.md` and [item 0023](0023-a-ruleset-name-that-matches-nothing-refuses.md)
in one diff.

This item lands `proposed`, like every dated item since 0021. The grant of scope that let
it be written is not an acceptance: [`README.md`](README.md) ("Silence never accepts")
reserves `accepted` to an explicit written OK from the person running the loop, and no
such OK exists for this item.

Every command quoted below is pinned to `f7041b2`, the merge commit this branch carried
before the item was written, so the tree it reads cannot be this file.

## Decision

**A ruleset write GitHub refuses makes the run a failure: `node scripts/init.mts --rules`
exits 1 when the POST or the PUT it made came back refused. Every failed *read* on that
path still exits 0**, which is [item 0023](0023-a-ruleset-name-that-matches-nothing-refuses.md)'s
rule, unchanged. And **the `pull_request` rule the installer sends carries all five
parameters the API documents as required on it**, so the create is accepted at all.

What is in force, as `scripts/init.mts` implements it:

- **One flag, set in one place, read once at the very end.** `rulesetWriteRefused` is
  declared false, assigned true by `reportRefusedWrite` alone, and turned into an exit code
  on the last line of the file:

  ```
  $ git grep -n "rulesetWriteRefused" f7041b2 -- scripts
  f7041b2:scripts/init.mts:149:let rulesetWriteRefused = false;
  f7041b2:scripts/init.mts:673:        rulesetWriteRefused = true;
  f7041b2:scripts/init.mts:777:if (rulesetWriteRefused) process.exitCode = 1;
  ```

- **Both write arms reach that one call site.** The POST and the PUT differ only in
  `method` and `endpoint`; there is one `run` of `gh api` and one branch on its result, so
  the two arms cannot answer differently:

  ```
  $ git grep -n -B4 "else reportRefusedWrite(r);" f7041b2 -- scripts
  f7041b2:scripts/init.mts-734-            for (const line of payload.split('\n')) say(`    ${line}`);
  f7041b2:scripts/init.mts-735-          } else {
  f7041b2:scripts/init.mts-736-            const r = run('gh', ['api', endpoint, '-X', method, '--input', '-'], root, payload);
  f7041b2:scripts/init.mts-737-            if (r.ok) say(outcome);
  f7041b2:scripts/init.mts:738:            else reportRefusedWrite(r);
  ```

- **The report is complete before the exit code exists.** `process.exitCode`, not
  `process.exit(1)`: the assignment is the last statement, after both `console.log` calls,
  so the report and the by-hand list drain. A refused write never hides the filesystem work
  the run already did and reported, and `exit` would not wait for those writes to drain.
- **A refused write keeps every line `gh` printed**; a failed read keeps `gh`'s first line
  alone. `reportRefusedWrite` sits beside `reportGhCallFailure` and differs from it in
  exactly that and in the flag.
- **The `pull_request` rule carries five parameters, not three.**
  `required_approving_review_count`, `dismiss_stale_reviews_on_push` and
  `require_last_push_approval` are what `--require-review` owns;
  `require_code_owner_review` and `required_review_thread_resolution` are sent beside them
  through the same `fetchedFlag` helper — `false` on a create, the fetched value on an
  update — and are **not** part of that opt-in. Without them GitHub refuses the create with
  `Invalid property /rules/0: data matches no possible input. (HTTP 422)`; the update path
  never showed it because the spread carried both over from the ruleset that was fetched.
- **The docs that carry it.** `skills/init/SKILL.md` step 8 states the exits-1 contract
  beside the reads that still exit 0, names those two parameters in its review-gate
  paragraph, and says which side of the line a `403` falls on; the "Crash policy on this
  path" paragraph in `scripts/init.mts`'s own header states the departure.

## Reason

**An installer that exits 0 says the repository is set up.** Before this change, a `--rules`
run whose POST GitHub refused printed one report line and exited 0 — and the repository it
reported on had no ruleset over its default branch: no pull request required, squash not the
only merge method, none of the checks the merge model depends on required, force-push and
deletion unblocked. The operator's next step on that card is to open the bootstrap pull
request, against a branch nothing protects. That is the state #373 was opened over, and it
was reachable on every fresh repository, because the create was refused every time: the
`pull_request` rule was short two parameters the API requires, and only the update path
survived, by carrying them over from the ruleset it had fetched.

**A refused write and a failed read are not the same event, and item 0023 argued the
difference without needing it.** Its reason for exit 0 is that "the run is not
all-or-nothing" — the ruleset step is the last of six, the filesystem work is done and
reported, the refusal is a named line in a report the operator is already reading, and the
remedy is in the line. All of that still holds for a read: nothing was attempted, so
nothing is in an unexpected state, and the line says which read failed. None of it holds
for a write GitHub refused. The call was made, the protection was not created, and there is
no remedy in the line to reach for — the operator has to be told that the run did not
achieve what it was run for. Exit 0 there is not a lenient report, it is a false one.

**The first line alone was the wrong line.** GitHub answers a ruleset write it will not
accept with `gh: Invalid request.` and names the property on the next line. Reporting
`gh`'s first line — right for a GET, which has one thing to say — turned a message naming
`/rules/0` into a message that reads like a malformed command, and sent the reader looking
at the invocation rather than at the field. So the write path joins every line into the one
report line; the read path is untouched.

**Fail-closed is the discipline this repository already runs by.** `scripts/land.mts`
refuses when `gh` cannot answer, and invariant 3 of `CLAUDE.md` names that as its stated
crash policy. A write path that cannot tell whether the protection exists behaves the same
way: it reports a failure rather than choosing to believe the branch is governed.

## Cost accepted

Three, and the first two are wider than #373's own wording asked for.

**1. A `gh` failure for a non-refusal reason exits 1 too.** No network, an expired token, a
rate limit, `gh` not installed on the PATH — every one of them reaches `reportRefusedWrite`,
because the branch is on `r.ok` and nothing downstream of it asks *why* the call failed. The
run exits 1 and the report line carries `gh`'s own text, so nothing is mislabelled — the
word "refused" never appears in operator-facing output for these. It is still a widening:
#373 asked for an exit 1 when GitHub **refuses** the write, and what landed is an exit 1
when the write did not demonstrably succeed. That is the right direction for a path whose
failure mode is a silently unprotected branch, and it is a cost, because a transient network
failure on the last call of a six-step installer now fails a run whose filesystem work was
complete and correct. The remedy is the one the report already gives: rerun `--rules`, which
is safe at any time.

**2. An `HTTP 403` on a write exits 1 where it exited 0, and no test case covers that
path.** The flag is set before the 403 is diagnosed, so the plan message and the failure
travel together:

```
$ git grep -n -A4 "const reportRefusedWrite" f7041b2 -- scripts
f7041b2:scripts/init.mts:672:      const reportRefusedWrite = (r: { err: string }): void => {
f7041b2:scripts/init.mts-673-        rulesetWriteRefused = true;
f7041b2:scripts/init.mts-674-        if (/\bHTTP 403\b/.test(r.err)) say('  ! ruleset: not available on this plan for a private repository');
f7041b2:scripts/init.mts-675-        else refuseRuleset(r.err.split('\n').map((l) => l.trim()).filter(Boolean).join(' ') || 'gh gave no reason');
f7041b2:scripts/init.mts-676-      };
```

It is effectively unreachable, which is also why nothing covers it: the rulesets list GET is
made before any write, and on a plan without rulesets that GET is what answers 403 —
reported by `reportGhCallFailure`, exit 0, exactly as before. The shared `gh` stub the tests
drive cannot reach the other case either, because its 403 fixture is tested before both
write arms:

```
$ git grep -n -A11 "repos/{owner}/{repo}/rulesets\"\*)" f7041b2 -- tests/lib/init-gh.mts
f7041b2:tests/lib/init-gh.mts:71:  "api repos/{owner}/{repo}/rulesets"*)
f7041b2:tests/lib/init-gh.mts-72-    if [ -f "$state/rulesets-403" ]; then
f7041b2:tests/lib/init-gh.mts-73-      echo "gh: HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature (https://docs.github.com)" >&2
f7041b2:tests/lib/init-gh.mts-74-      exit 1
f7041b2:tests/lib/init-gh.mts-75-    fi
f7041b2:tests/lib/init-gh.mts-76-    if [ "\${3:-}" = "-X" ] && [ "\${4:-}" = "POST" ]; then
f7041b2:tests/lib/init-gh.mts-77-      [ -f "$state/ruleset-write-fail" ] && refuse_write post
f7041b2:tests/lib/init-gh.mts-78-      cat > "$state/ruleset-post-body.json"
f7041b2:tests/lib/init-gh.mts-79-      echo '{"id":101,"name":"agentic-setup"}'
f7041b2:tests/lib/init-gh.mts-80-    elif [ "\${3:-}" = "-X" ] && [ "\${4:-}" = "PUT" ]; then
f7041b2:tests/lib/init-gh.mts-81-      [ -f "$state/ruleset-write-fail" ] && refuse_write put
f7041b2:tests/lib/init-gh.mts-82-      cat > "$state/ruleset-put-body.json"
```

So this is reasoned about and not measured, and it is written down here rather than left to
be rediscovered. What would make it reachable is a state where the list GET succeeds and the
write 403s — a token with read but not write on rulesets is the obvious candidate — and
whether GitHub actually answers that way is not something this item establishes.

**3. The run now fails for a condition that, on some plans, no operator can clear.** If the
case above is reachable, the operator on a plan without rulesets for private repositories
gets exit 1 from an installer whose every other step succeeded, and no edit to the
repository fixes it: the remedies are to drop `--rules` and make the checks required by
hand — which is what the card already tells that operator to do — or to change plan. Both
are outside the repository, and neither is something a script that wraps the installer can
do. A failure nobody can clear is a worse thing to hand an operator than a report line, and
it is accepted here because the alternative is to keep exiting 0 for a branch that was left
ungoverned, which is the defect this item exists to close.

**What this does not cost, today.** Nothing in this repository reads the installer's exit
code, so no caller changes behaviour on the day this lands. `scripts/adopt.mts` and
`scripts/lib/adopt/` name `init.mts` only in the plan text they write; the child processes
they spawn are `gh` and `git`:

```
$ git grep -n "spawnSync(" f7041b2 -- scripts/adopt.mts scripts/lib/adopt
f7041b2:scripts/adopt.mts:215:  const r = spawnSync('gh', args, { encoding: 'utf8' });
f7041b2:scripts/adopt.mts:252:const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
f7041b2:scripts/lib/adopt/git.mts:67:  const r = spawnSync('git', args, {
```

And the install card runs the installer as two bare lines, chained to nothing, so a
non-zero exit stops no sequence there either:

```
$ git grep -h "node \"\$INIT\"" -- skills
node "$INIT" --dry-run --milestone "M1 <name>"
node "$INIT" --milestone "M1 <name>"
```

A caller that starts checking the exit code is the point of the change: what it will see is
a first install that left the default branch unprotected.

## Supersedes

`nothing`. [Item 0023](0023-a-ruleset-name-that-matches-nothing-refuses.md) is untouched and
is not edited by this pull request: its rule is about the **reads** on this path, every one
of them still refuses with a named line and still exits 0, and its stated reason for that
exit 0 is the reason a write is treated differently here. This item is the one departure
from the exit 0 that item describes, for the one event it does not cover — a POST or PUT
GitHub answered. Item 9(a) of [`../decisions.md`](../decisions.md) (the checks the merge
model depends on) is untouched in substance: the checks the ruleset requires are unchanged,
and what changed is that a repository where writing them failed is no longer reported as a
success.

## Updates

*(none yet)*
