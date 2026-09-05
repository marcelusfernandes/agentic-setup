---
name: init
description: Set a repository up for the agent loop — copy the GitHub templates and CI checks, write the permission deny list, install the git pre-push hook, seed labels and a milestone. Invoke as /agentic-setup:init in the repository root.
---

# Init

Run the installer from the repository root:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/init.mjs" --milestone "M1 <name>"
```

Flags: `--milestone "<title>"` creates the first milestone (optional); `--no-gh` skips
labels and milestone (offline, or no `gh` auth); `--force` overwrites files you edited
before (it never overwrites silently). If `${CLAUDE_PLUGIN_ROOT}` is empty in your shell,
the plugin directory is the one `/plugin` lists for `agentic-setup`.

The script is idempotent. It:

1. copies `templates/.github/**` into `.github/` (issue and PR templates, `guard-main`
   and `agentic-checks` workflows) and `templates/.worktreeinclude` to the root — existing
   files are left alone unless `--force`;
2. copies the plugin's `ci/` into `.github/scripts/agentic/` — always overwritten, that is
   plugin-owned code and updates must reach CI;
3. merges the permission deny list into `.claude/settings.json` (union; your entries stay);
4. installs `hooks/git-pre-push` as `.git/hooks/pre-push` (a foreign pre-push is reported,
   not replaced);
5. seeds the `state:`, `type:`, `review:approved` and `human` labels, and the milestone.

Then, by hand — the script cannot do these:

- Review `git status` and open the bootstrap PR with these files. If the repository has
  no PR checks yet, the first merge needs `AGENTIC_ALLOW_MERGE=1` in front of
  `gh pr merge`, and pushing the very first commit to `main` needs the message to contain
  `[allow-push-main]` — both are declared valves, both visible in the history.
- Make `scope`, `negative-control` and your own test workflow **required checks** on
  `main`. Add a ruleset (PR required, no force-push, no deletion) if your plan allows one;
  keep the hooks either way.
- Add `scope:` labels that match your repository (`web`, `api`, `db`, …).
- In `.github/workflows/agentic-checks.yml`, mirror your test workflow's toolchain setup
  in the `negative-control` job, and set `AGENTIC_TEST_CMD` if detection does not name the
  right command.
- Tell `CLAUDE.md` what the invariants are — the reviewer checks whatever it names.
