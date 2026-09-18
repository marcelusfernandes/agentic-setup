# 0024. An `authorised:` grant is never written from inside the worktree it would exempt

Status: proposed
Date: 2026-09-18

Landed with #237 (this pull request), which implements the rule below in the same diff. The
rule is written here because it binds the next agent rather than because it explains that
diff: it changes what `hooks/protect-main.mts` denies **and** who may write something — two
of the five categories `README.md` lists — and it takes a command every implementer runs at
its step 7 out of that agent's hands.

The issue body leaves one question open — whether the hook alone is the answer, or whether a
CI-side author check is required before this is closed. The orchestrator's comment on #237
(2026-09-18) rules that the hook alone is the answer for now and defers the CI-side check,
for the reason recorded under **Cost accepted** below. That ruling is recorded here; it is
not acceptance. It was written under the standing M11–M16 delegation on #161 and says in
its own words that the owner may veto it, and `README.md` ("Silence never accepts") reserves
`accepted` to an explicit written OK from the person running the loop. So this item lands
`proposed`, like every dated item since 0021, and the pull request that flips this line will
cite where that OK was written.

## Decision

**An `authorised:` grant is written by the orchestrator, from the main checkout, and by
nobody else. `hooks/protect-main.mts` denies `gh issue edit` outright when the session
that types it is an agent standing in a linked worktree.**

What is in force, as `hooks/protect-main.mts` implements it:

- **The rule, and its two conditions.** `hooks/protect-main.mts:176-179` denies a command
  segment whose head is `gh issue edit` when the payload carries an `agent_id` **and**
  `inLinkedWorktree(cwd)` is true. Both conditions, never one: the orchestrator runs in the
  main checkout and carries no `agent_id`, so its own `gh issue edit` is untouched.
- **The discriminator is the one that already existed.** `inLinkedWorktree`
  (`hooks/protect-main.mts:130-135`) makes the same test as
  `hooks/protect-worktree.mts:46-51` — `git rev-parse --show-toplevel` against
  `--git-common-dir/..`, both sides through `realpathSync`, because `--show-toplevel`
  answers in real paths while `--git-common-dir` answers relative to `cwd` and `/var/…`
  must compare equal to `/private/var/…` or the main checkout reads as a worktree. It is
  the right discriminator because the implementer is born in a worktree and never creates
  or leaves one (`skills/issue-and-pr/SKILL.md:59-60`), while the orchestrator never enters one.
- **Only `edit`, and only as the head of a segment.** `isGhCommand`
  (`hooks/protect-main.mts:99`) is the generalisation of the `gh pr merge` tokeniser #204
  built: `gh` at the head, the recognised global flags skipped, then `<group> <verb>`. So
  `gh -R owner/repo issue edit 42` is denied on the same footing as
  `gh -R owner/repo pr merge 1`, while `gh issue view`, `gh issue comment`, `gh issue list`
  and `gh pr edit` are allowed from anywhere.
- **The fast path is widened by one word, not opened.** `hooks/protect-main.mts:162` reads
  `/push|merge|issue/`. The hook still parses only the segments it has a rule for, and the
  two `git` spawns the worktree test costs run lazily, at most once per call, and only once
  a segment is already a `gh issue edit` (`:177`).
- **The refusal names the remedy the contract already has.** `GRANT_REMEDY`
  (`hooks/protect-main.mts:79`) says what the issue body carries, that a session editing the
  issue it is implementing would be granting itself scope, and then the remedy in the words
  `docs/workflow.md:176-177` already uses: ask the orchestrator for the grant on the issue, and
  stop. It also states that no environment variable lifts it.
- **No valve, and none is going to be added.** `AGENTIC_ALLOW_PUSH_MAIN=1` lifts item 2's
  push form only. A valve on this rule would be the self-grant the rule exists to refuse.
  The hook header states this beside the same sentence for item 3, and
  `tests/protect-main.test.mts:170-178` asserts it for the inline and the environment form.
- **The crash policy is unchanged: ALLOW.** A `git` that cannot say where the session is
  standing returns `false` and the call goes through (`:133`). An unreadable repository is
  not evidence of a grant, and this hook is layer three.
- **The docs that carry it.** Five places state this rule and they are written to agree:
  `docs/orchestration.md:354` (the hooks table row) names the denial, its discriminator and
  what stays allowed; `docs/orchestration.md:309-315` (the implementer's `Forbidden:` list)
  names `gh issue edit` beside the other refused commands, with the remedy;
  `docs/workflow.md:177-188` states the enforcement where it already said the implementer
  asks and stops, and `docs/workflow.md:527-533` keeps the enumeration of what this hook
  denies complete at four items; `agents/implementer.md` and
  `skills/issue-and-pr/SKILL.md` forbid the command and point at the orchestrator; and
  `skills/orchestrate/SKILL.md` carries the relabel that moved.

Unchanged by this item: a grant still counts only in the body of an issue the pull request
closes and never from a pull-request body (#155); it is still read once, as a grant, and
never as one of the issue's own globs (#231, item 22); and the reading of what follows
`authorised:` is exactly what it was.

## Reason

**The convention was load-bearing and nothing held it up.** `ci/lib/scope.mts:111` states
the reason a grant in an *issue* body cannot be a self-grant: "The orchestrator writes the
issue at dispatch and the implementer has no reason to edit it." That is a sentence about
what an agent has no reason to do, not about what it is able to do. The implementer has
`Bash`; `ci/scope-check.mts:210` reads the issue body at check time, not at dispatch time,
and feeds whatever it finds under `authorised:` straight into the scope decision (`:216`,
`:221`). One `gh issue edit <n> --body-file <f>` between dispatch and CI and the pull
request may touch whatever the agent typed. That is the self-grant #155 closed on the
pull-request side, re-opened on the issue side, and #210 moved the grant onto the issue
citing precisely the sentence that does not hold.

**The hook could not see it.** On the base (`4cbbfdb`), `hooks/protect-main.mts` denied
three forms, and its fast path returned on any command without the words `push` or `merge`
in it — so `gh issue edit 42 --body-file x` was never looked at at all, in any session,
from anywhere.

**The discriminator was already in the directory, tested, for the same failure mode.**
`hooks/protect-worktree.mts` exists because a rule written in prose ("only edit inside your
worktree") is skipped under load. This is that rule's twin: the prose here is "only the
orchestrator writes an `authorised:` line", and it is skipped the same way, by an agent
that has hit a file outside its globs at the end of a long round and has the tool to fix it
in front of it.

## Cost accepted

**The implementer's closing relabel becomes the orchestrator's, and that trades an error
that could not happen for one that can.** `agents/implementer.md` and
`skills/issue-and-pr/SKILL.md` both ended the implementer's step 7 with
`gh issue edit <n> --add-label state:in-review --remove-label state:in-progress`, run from
the worktree. This item denies that command along with the grant, because the hook reads a
segment's head and not its flags, and `--add-label` is one `--body-file` away on the same
line. So the step moves, in this same pull request, to the orchestrator's step 4
(`skills/orchestrate/SKILL.md`), beside the `type:`/`scope:` copy that is already there for
the same reason — an agent that labels its own work could buy its own exemptions.

**What the move costs is a step that can now be forgotten.** The implementer could not
finish its round without relabelling; the orchestrator can skip it and nothing fails. The
consequence is the one that was measured: `reconcile`'s `inReview` bucket is filtered on the
issue's own `state:in-review` label (`scripts/reconcile.mts:715`), so an issue nobody moved
is missing from the bucket the orchestrator works from, and `stale` does not catch it either
because that wants no pull request and no remote branch (`:731-733`). The pull request goes
quiet instead of loud (`docs/dogfood/2026-09-10.md`, L14 — the incident that put the step on
the implementer's card in the first place). It is not invisible: it surfaces as an
`inProgress` entry carrying a `pr` with `foreignLock: false`, and the orchestrate card names
that signature where the step now lives. Nothing enforces it: this is a workflow change, not a
mechanism, and a second hook to police the first would be the arms race this file already
refuses. Who pays: the orchestrator, which gains a step it can drop, and whoever reads a
milestone whose issues stopped tracking their pull requests.

**The denial is deliberately the wider one.** Narrowing it to the body-writing forms
(`--body`, `--body-file`, `-b`, `-F`) would put the rule back in the business of enumerating
flags — the arms race the hook's header refuses for every other item — and an agent that
reads "`gh issue edit` is denied" is told something it cannot get wrong. Moving the one
legitimate use is the cheaper half of that trade.

**Four documents carried the old rule, and the fourth was a test.** `agents/implementer.md`,
`skills/issue-and-pr/SKILL.md` and `docs/workflow.md:286-290` each stated it in prose, and
`tests/doctrine.test.mts` pinned the implementer card to carry that exact command string
under #264's AC4 — a guard that was right when the implementer owned the step and asserts
the opposite of the contract now. All four move in this pull request. A rule fixed in three
places and left in a fourth is how the next agent learns the old one.

**This is layer three, and it is bypassable on purpose.** `bash -c 'gh issue edit …'`, a
wrapper script, an alias, `$(…)` substitution, and above all
`gh api -X PATCH repos/{owner}/{repo}/issues/<n>` — which edits a body without the words
`issue edit` occurring in it — all walk past this check, exactly as they walk past items 1
to 3. The hook's header says so for item 4 in the same paragraph it says so for the others.
It is worth having anyway for the reason item 14 gives for the merge rule: the failure this
stops is not an adversary, it is an agent under load reaching for the obvious tool, and a
refusal with a remedy in it costs a round trip rather than a review.

**The durable half is deferred, with a named blocker.** `ci/scope-check.mts` reads the issue
body already and could hold a grant to its provenance — the login that wrote the body's last
revision, from the issue timeline's `edited` event — refusing a grant last written by anyone
but the orchestrator. That needs a definition of "the orchestrator's identity" this
repository does not have: it runs a single GitHub login by the owner's decision (#148,
#156), so on the timeline the orchestrator and the implementer are the same user and the
check would compare a value against itself. It becomes a follow-up when #156 gives `land` a
recorded mode and identity. Who pays until then: whoever assumes a grant on an issue was
written by the orchestrator, because the hook makes that likely and nothing makes it
certain.

**One more rule for whoever writes an agent card.** The set of commands an agent may run
from its worktree now has a hole in it that is not about files, branches or merges. A card
that tells an agent to edit an issue must say from where.

## Supersedes

`nothing`. It completes #155 and item 22 (#231) — a grant counts only where the orchestrator
wrote it, and is read once as a grant — by making the place the orchestrator writes it a
place the implementer cannot reach. Neither is replaced.

## Updates

None yet.
