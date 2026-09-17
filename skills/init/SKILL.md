---
name: init
description: Set a repository up for the agent loop — copy the GitHub templates and CI checks, write the permission deny list, install the git pre-push hook, seed labels and a milestone. Invoke as /agentic-setup:init in the repository root.
---

# Init

Run the installer from the repository root. `CLAUDE_PLUGIN_ROOT` is set for hook
processes but not for the Bash tool, so locate the script first:

```bash
INIT="${CLAUDE_PLUGIN_ROOT:+$CLAUDE_PLUGIN_ROOT/scripts/init.mts}"
[ -f "$INIT" ] || INIT="$(find ~/.claude/plugins -path '*agentic-setup*/scripts/init.mts' 2>/dev/null | head -1)"
[ -f "$INIT" ] || { echo "agentic-setup: init.mts not found under ~/.claude/plugins; pass the plugin path by hand"; exit 1; }
node "$INIT" --dry-run --milestone "M1 <name>"
node "$INIT" --milestone "M1 <name>"
```

Run with `--dry-run` first: it prints the exact report a real run would (same `+`/`=`/`!`
lines, headed `dry run — nothing written`) and changes nothing on disk or on GitHub — no
file is written, the pre-push hook is untouched, and labels/milestone are only reported,
never created. Drop the flag to apply once the preview looks right.

Pass the flags the user gave you (`$ARGUMENTS`). Flags: `--dry-run` previews without
writing anything; `--milestone "<title>"` creates the first milestone (optional); `--no-gh`
skips labels, milestone and the ruleset (offline, or no `gh` auth); `--force` overwrites
files you edited before (it never overwrites silently); `--rules` updates (or creates) the
branch ruleset over the default branch (see step 7 below) — omit it to leave rulesets
untouched entirely; `--ruleset-name <name>` picks the ruleset to update by name instead of
by what it governs; `--require-review` raises the ruleset's review gate (only meaningful
together with `--rules`).

`--rules` on its own never turns a review gate on: it resets
`required_approving_review_count` to 0 and carries the fetched stale-approval fields
through, so it is safe to run at any time (a count raised by hand on the matched ruleset is
reset by it — the count is the installer's to own). **`--require-review` is the opt-in that makes one
approving review mandatory: run it only after the second identity of the by-hand block
below exists.** On a repository with a single identity the merging identity cannot approve
its own PR, so every merge is frozen until that identity is there; the report warns about
exactly that whenever `AGENTIC_REVIEWER_TOKEN` is unset in the environment.

The script is idempotent. It:

1. copies `templates/.github/**` into `.github/` (issue and PR templates, `guard-main`
   and `agentic-checks` workflows) and `templates/.worktreeinclude` to the root — existing
   files are left alone unless `--force`;
2. copies the plugin's `ci/` into `.github/scripts/agentic/` — always overwritten, that is
   plugin-owned code and updates must reach CI;
3. merges the permission deny list into `.claude/settings.json` (union, minus the
   installer's own superseded rules, which are replaced by their current wording; your
   entries stay);
4. installs `hooks/git-pre-push` as `.git/hooks/pre-push` (a foreign pre-push is reported,
   not replaced);
5. turns on the repository's `allow_auto_merge` and `delete_branch_on_merge` settings
   (`gh repo edit`; skipped, reported only, under `--dry-run`) — `land.mts` depends on
   both: the first for `gh pr merge --auto` to have anything to enable, the second so a
   merged branch is deleted for it;
6. seeds the `state:`, `type:`, `review:approved`, `human:pending` and `human:decided`
   labels, and the milestone. An existing bare `human` label is left as found;
7. **with `--rules`:** reads `repos/{owner}/{repo}/rulesets` and, for each branch ruleset
   in it, `repos/{owner}/{repo}/rulesets/<id>` — the list endpoint answers with summaries
   only, so conditions, rules and bypass actors come from the per-id fetch. The ruleset it
   updates (PUT) is the one that **governs the default branch**, found by its conditions
   and never by its name: `conditions.ref_name.include` containing `~DEFAULT_BRANCH` or
   `refs/heads/<default branch>`. `--ruleset-name <name>` overrides that choice; when
   several rulesets match, the first is updated and the others are named in the report,
   never created over. Only when nothing matches is a ruleset created (POST), named
   `agentic-setup` (or `--ruleset-name`'s value) on `refs/heads/<default branch>`.

   What it writes: a `pull_request` rule with `allowed_merge_methods: ['squash']`;
   `required_status_checks` for `scope`, `negative-control` and this repository's own test
   workflow's job (the sole job of the sole workflow file this plugin does not own;
   defaults to `test` when that is not unambiguous); and `non_fast_forward` and `deletion`
   to block force-push and deletion.

   What it writes for the review gate: by default it turns nothing on — it resets
   `required_approving_review_count` to 0, with `dismiss_stale_reviews_on_push` and
   `require_last_push_approval` left at the values the fetched ruleset carried (`false`
   when there was no ruleset to fetch), and `require_extra_approval_for_unattributed_changes`
   carried over like any other unmanaged parameter. **With `--require-review`** those three
   become `1`, `true` and `true` — the shape `land.mts` and the Codex route need before they
   will queue an automatic merge, and the shape that freezes every merge on a repository
   with a single identity. `--rules` raises them no other way; there is nothing left for you
   to edit by hand.

   What it keeps: a PUT replaces the whole ruleset, so everything the installer does not
   manage is carried over from the ruleset it found — its name and conditions, its
   `bypass_actors`, every rule of a type outside those four, and every parameter of those
   four the installer does not set itself.

   The reads happen even under `--dry-run` so the report can say `+ ruleset created` vs
   `= ruleset updated` without writing; `--dry-run` additionally prints the exact payload
   it would send and makes no POST or PUT at all. A 403 — rulesets are not available on a
   private repository on the free plan — is reported as exactly that, `! ruleset: not
   available on this plan for a private repository`, instead of `gh`'s raw error.

   When a detail fetch fails or answers with something that is not a ruleset object, the
   run **refuses**: `! ruleset: could not read ruleset #<id>: <gh's first error line>`, no
   POST, no PUT, no payload preview. It cannot carry on: a ruleset whose conditions could
   not be read looks exactly like one that governs nothing, and creating over it is the
   very defect the lookup exists to prevent.

   Without `--rules`, no `rulesets` call is made at all — and `--require-review` on its own,
   or together with `--no-gh`, reports itself as ignored.

Then, by hand — the script cannot do these:

- Review `git status` and open the bootstrap PR with these files. Pushing the very first
  commit to `main` needs the message to contain `[allow-push-main]` (`guard-main`'s escape
  hatch, bootstrap only, visible in the history).

  **That bootstrap pull request comes back with two reds by design, and only the test check
  is expected green on it.** `scope` fails it because a bootstrap pull request links no
  issue: with no `Closes #N` in the body there is no issue whose `## Files` it could read
  the globs from. `negative-control` fails it as `no-tests`, because what the installer
  wrote are not test files and they do not all sit in a skipped path class. The third
  required check is the job of your own test workflow, whatever step 7 found it called
  (`test` when it could not tell), and that one is expected green. Both reds are correct on
  that one pull request: nothing is wrong with the install, so do not debug it over them.
  Cleanest is to omit `--rules` on the bootstrap run, merge this pull request, and run
  `init --rules` after — it is safe at any time. If you have already run it, those two are
  required on the default branch and this pull request cannot merge on its own: add
  yourself to the ruleset's `bypass_actors` (or disable the ruleset) until it is in, then
  re-run `--rules`, which carries `bypass_actors` over. The reds stop at the
  first ordinary issue-linked pull request, the one that carries a `Closes #N` in its body
  and test files in its diff: `scope` then has an issue to read globs from, and
  `negative-control` has tests to overlay on the base.
- If `--rules` reported the free-plan limit (or you skipped it), make `scope`,
  `negative-control` and your own test workflow **required checks** on `main` by hand
  instead; keep the pre-push hook either way — it is the fallback for a repository with no
  ruleset (a private repository on the free plan).
- Add `scope:` labels that match your repository (`web`, `api`, `db`, …).
- In `.github/workflows/agentic-checks.yml`, mirror your test workflow's toolchain setup
  in the `negative-control` job, and set `AGENTIC_TEST_CMD` if detection does not name the
  right command.
- Tell `CLAUDE.md` what the invariants are — the reviewer checks whatever it names.
- **For a review gate the merging identity cannot satisfy itself:** create a machine user
  or a GitHub App installation with pull-request write, and store its token as
  `AGENTIC_REVIEWER_TOKEN` wherever the orchestrator and reviewer run (never in this
  repository — `init` never writes it anywhere). This identity is the one thing `--rules`
  cannot do for you. **Order matters:** run `--rules` (safe at any time, review gate off),
  *then* create the identity, *then* run `--rules --require-review` (it raises the base
  branch ruleset's `required_approving_review_count` to 1, dismisses stale approvals and
  requires the last push approved), *then* set the token. GitHub
  only computes a PR's `reviewDecision` on a branch where a review is actually required;
  set the token before that rule exists and `reviewDecision` stays `null` forever, so
  every PR refuses in `land.mts` with no way to satisfy it (`scripts/land.mts`'s header
  names this trap). **Run `--require-review` only after that second identity exists**: the
  rule is otherwise required and nobody can satisfy it, so every merge is frozen until the
  identity is created. Without the token, `land.mts` falls back to trusting the
  `review:approved` label — the same identity that runs `land.mts` can write that label
  itself, so this is meant as a bootstrap state, not a destination (`docs/decisions.md`
  item 13).
