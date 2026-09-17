# 0014. A hand-typed `gh pr merge` is denied, not discouraged

Status: accepted — written OK: issue #154 (the owner's specification of this change), under the standing M11–M16 delegation recorded on #161.
Date: 2026-09-17

"`land.mts` is the only way the orchestrator merges a pull request, never `gh pr merge`
by hand" was written in bold in two contracts (`skills/orchestrate/SKILL.md`, `AGENTS.md`)
and enforced nowhere: `hooks/protect-main.mts` denied a `gh pr merge` segment only when it
also carried `--admin`, and the deny list matched only `Bash(gh pr merge *--admin*)`. A
plain `gh pr merge 42 --squash` typed into a session went straight to the server. Both now
refuse every `gh pr merge` segment, and the hook's refusal names `node scripts/land.mts
<pr>` as the way to merge and says `--admin` is no remedy.

*Why:* 58 merges had gone through this repository and not one of them was a merge the
server verified against the evidence `land.mts` gates on; the prohibition that was supposed
to guarantee it was prose the model reads under load and the agent's own tooling never
checked. A rule stated in bold twice and enforced zero times is a rule the loop does not
have. This costs nothing to enforce, because `scripts/land.mts` spawns `gh` from inside
Node: the hook and the deny list see only the session's Bash command string, which reads
`node scripts/land.mts <pr>` — the one path that stays open.

*Cost accepted:* a genuine manual merge leaves the session. There is no valve and none will
be added — `AGENTIC_ALLOW_PUSH_MAIN=1` covers pushing to `main` for bootstrap and does not
touch this — so an operator who must merge by hand does it in their own terminal or in the
GitHub UI, where the ruleset (the layer that must not be bypassed) still applies. The hook's
crash policy stays ALLOW, per invariant 3: it is a round-trip saver, not the gate.
