# Conflicts — dry runs, classification, autonomy and the ledger

Normative rules for `resolve-conflicts`, `merge` and the `conflict-resolver` agent.

## 1. Dry run before every merge

```bash
git fetch origin
git merge-tree --write-tree "origin/<base>" "origin/<head>" > /tmp/mt.out 2>&1; rc=$?
```

| rc | Meaning | Action |
|---|---|---|
| 0 | clean | proceed |
| 1 | conflicts | the second output section lists conflicted stages (`mode oid stage path`), the third the `CONFLICT (...)` messages. Parse the path column, route to `resolve-conflicts`. **Never merge.** |
| ≥2 | the merge could not be attempted; output unspecified | STOP and show it raw |

This runs entirely in memory — no working tree, index or HEAD is touched — which is why it is safe to run for every PR of an epic in a loop, and why `merge` never trusts GitHub's `mergeable` field alone (it can be `UNKNOWN` while GitHub recomputes). Requires git ≥ 2.38; `init` and `doctor` enforce it. Wrapped as `scripts/git/mergecheck.sh <base-ref> <head-ref>`.

## 2. Classification

Requires `merge.conflictStyle=zdiff3` — the `||||||| base` section is what makes the trivial/semantic call reliable. `scripts/git/conflict-classify.sh [<file>...]` emits a coarse class (`protected`, `regenerable`, `trivial`, `semantic`) plus a hunk count; the resolver re-derives the fine-grained class below from the conflict text.

| Class | Signals | Resolution |
|---|---|---|
| trivial: identical | both sides identical after normalizing whitespace | take either |
| trivial: additive-list | both sides only add lines to an import block, export barrel, enum, CHANGELOG, route table, i18n catalog; no line deleted from base | union in a deterministic order: base order, then ours' additions, then theirs' |
| trivial: formatting | the two sides are identical after running `commands.format` on both | take either, then reformat |
| trivial: regenerable | path matches `profile.generated_globs` (lockfiles, `dist/**`, generated clients) | discard both sides, run `commands.install`, stage the regenerated file |
| trivial: rerere | `git rerere status` shows a recorded resolution that applied cleanly | accept, then verify the file lints/compiles |
| **semantic** | the same function body, signature, condition, constant or test expectation changed on both sides; any `config.protected_paths` entry; any migration; anything under `**/auth/**`, `**/security/**` or matching `secrets_globs` | **STOP** |
| **unknown** | anything the classifier or the resolver cannot place | treat as semantic |

A resolution you cannot explain in one sentence is not trivial.

## 3. Autonomy ceilings

`config.conflict_autonomy`. Exceeding **any** of these converts the whole run into a STOP, even when every file classified trivial:

- more than `max_files` (default 10) conflicted files
- more than `max_hunks` (default 20) conflict hunks in total
- any file matching `config.protected_paths`
- a rebase spanning more than `max_rebase_commits` (default 20) commits — offer squash-then-rebase instead

Each resolution is verified afterwards by `commands.lint` and `commands.test` before anything is pushed. Red tests ⇒ nothing is pushed.

## 4. Never, under any circumstance

- `git push --force` — only `--force-with-lease`, and only on a branch this workflow created (otherwise the human types `force-push <branch>` first)
- `git rebase --skip`
- `git checkout --ours/--theirs` on a semantic conflict
- resolving by deleting one side's code
- continuing a rebase before the tests pass
- resolving anything under `protected_paths`, a migration, or a secrets path

## 5. The ruling ledger

`epics/<slug>/ledger.md`, append-only, one row per autonomous judgment call, written by `scripts/state/ledger.sh`:

```markdown
# Ruling ledger — oauth-login

| when | who | scope | ruling | why | cost if wrong | reversible |
|---|---|---|---|---|---|---|
| 2026-09-05T14:31:02Z | work | #123 stream B | Split api layer into its own stream | src/api/** disjoint from src/db/** | wasted parallelism if wrong | yes |
| 2026-09-05T15:02:44Z | resolve-conflicts | feat/125 | Resolved src/routes.ts as additive-list | both sides only appended routes, base unchanged | a route registered twice | yes (revert commit) |
| 2026-09-05T15:40:10Z | sync | epic | Fell back to checklist linking | the host CLI lacks --add-sub-issue and the sub_issues API returned 404 | dependencies not enforced by GitHub | yes (re-run sync) |
```

Rulings, not stalls: the orchestrator **decides** rather than blocking the human on every ambiguity — except at the named stop conditions (an irreversible operation, a security-sensitive change, an effect outside the worktree, or an autonomy ceiling exceeded). Every ruling is one row. Every skill that wrote rows prints them in its final summary, and `pr` copies the branch's rows into the PR body so the reviewer sees exactly what was decided without them.

## 6. rerere

`init` sets `rerere.enabled=true` locally. A conflict resolved once is replayed automatically the next time the same two sides meet — the common case in a merge train, where every remaining branch hits the same conflict after the first merge. A rerere-replayed resolution is still verified (lint + tests) and still gets its ledger row, marked as replayed: it was decided earlier, not now.
