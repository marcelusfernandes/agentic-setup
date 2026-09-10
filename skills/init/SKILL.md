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
skips labels and milestone (offline, or no `gh` auth); `--force` overwrites files you
edited before (it never overwrites silently).

The script is idempotent. It:

1. copies `templates/.github/**` into `.github/` (issue and PR templates, `guard-main`
   and `agentic-checks` workflows) and `templates/.worktreeinclude` to the root — existing
   files are left alone unless `--force`;
2. copies the plugin's `ci/` into `.github/scripts/agentic/` — always overwritten, that is
   plugin-owned code and updates must reach CI;
3. merges the permission deny list into `.claude/settings.json` (union; your entries stay);
4. installs `hooks/git-pre-push` as `.git/hooks/pre-push` (a foreign pre-push is reported,
   not replaced);
5. turns on the repository's `allow_auto_merge` and `delete_branch_on_merge` settings
   (`gh repo edit`; skipped, reported only, under `--dry-run`) — `land.mts` depends on
   both: the first for `gh pr merge --auto` to have anything to enable, the second so a
   merged branch is deleted for it;
6. seeds the `state:`, `type:`, `review:approved`, `human:pending` and `human:reviewed`
   labels, and the milestone. An existing bare `human` label is left as found.

Then, by hand — the script cannot do these:

- Review `git status` and open the bootstrap PR with these files. Pushing the very first
  commit to `main` needs the message to contain `[allow-push-main]` (`guard-main`'s escape
  hatch, bootstrap only, visible in the history).
- Make `scope`, `negative-control` and your own test workflow **required checks** on
  `main`. Add a ruleset (PR required, no force-push, no deletion) if your plan allows one;
  keep the hooks either way — they are the fallback for a repository with no ruleset yet
  (a private repository on the free plan).
- Add `scope:` labels that match your repository (`web`, `api`, `db`, …).
- In `.github/workflows/agentic-checks.yml`, mirror your test workflow's toolchain setup
  in the `negative-control` job, and set `AGENTIC_TEST_CMD` if detection does not name the
  right command.
- Tell `CLAUDE.md` what the invariants are — the reviewer checks whatever it names.
- **For a review gate the merging identity cannot satisfy itself:** create a machine user
  or a GitHub App installation with pull-request write, and store its token as
  `AGENTIC_REVIEWER_TOKEN` wherever the orchestrator and reviewer run (never in this
  repository — `init` never writes it anywhere). **Order matters:** first set the base
  branch ruleset's `required_approving_review_count` to 1, *then* set the token. GitHub
  only computes a PR's `reviewDecision` on a branch where a review is actually required;
  set the token before that rule exists and `reviewDecision` stays `null` forever, so
  every PR refuses in `land.mts` with no way to satisfy it (`scripts/land.mts`'s header
  names this trap). Without the token, `land.mts` falls back to trusting the
  `review:approved` label — the same identity that runs `land.mts` can write that label
  itself, so this is meant as a bootstrap state, not a destination (`docs/decisions.md`
  item 13).
