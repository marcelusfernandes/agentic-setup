# 0024. An `authorised:` grant is never written from inside the worktree it would exempt

Status: accepted
Date: 2026-09-18

Landed with #237 (this pull request), which implements the rule below in the same diff. The
rule is written here because it binds the next agent rather than because it explains that
diff: it changes what `hooks/protect-main.mts` denies **and** who may write something — two
of the five categories `README.md` lists — and it takes a command every implementer runs at
its step 7 out of that agent's hands.

Accepted, not proposed: the orchestrator's decision comment on #237 (2026-09-18, under the
standing M11–M16 delegation recorded on #161, the owner may veto) answers the open question
the issue body poses and says so in as many words — "the hook alone is accepted as the answer
for now. `Status: accepted` for the hook half." The issue carries `human:decided`. The CI-side
half is deferred, with a reason, under **Cost accepted** below.

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
  `tests/protect-main.test.mts:169-177` asserts it for the inline and the environment form.
- **The crash policy is unchanged: ALLOW.** A `git` that cannot say where the session is
  standing returns `false` and the call goes through (`:133`). An unreadable repository is
  not evidence of a grant, and this hook is layer three.
- **The docs that carry it.** `docs/orchestration.md:349` (the hooks table row) names the
  new denial, its discriminator and what stays allowed.

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

**An implementer can no longer relabel its own issue, and two tracked documents tell it to.**
`agents/implementer.md:50` and `skills/issue-and-pr/SKILL.md:67` both end the implementer's
step 7 with `gh issue edit <n> --add-label state:in-review --remove-label state:in-progress`,
run from the worktree — and `agents/implementer.md:51-53` records why it matters: an issue
left on `state:in-progress` under a pull request in review is listed in neither of
`reconcile`'s buckets (measured, `docs/dogfood/2026-09-10.md`, L14). This item denies that
command along with the grant, because the hook reads the segment's head and not its flags,
and `--add-label` is one `--body-file` away on the same command line.

The denial is deliberately the wider one. Narrowing it to the body-writing forms
(`--body`, `--body-file`, `-b`, `-F`) would put the rule back in the business of enumerating
flags — the arms race the hook's header refuses for every other item — and an agent that
reads "`gh issue edit` is denied" is told something it cannot get wrong. Who pays: the
implementer, which now ends its round by asking the orchestrator to move the label, and the
orchestrator, which gains one step. Moving that step to the orchestrator's step 4, where the
`type:` and `scope:` labels are already copied onto the pull request for the same reason —
an agent that labels its own work could buy its own exemptions — is the change the two
documents need, and it is filed separately rather than smuggled in here, because
`agents/implementer.md` and `skills/issue-and-pr/SKILL.md` are outside this issue's globs.
Until that lands, an implementer's relabel is refused by a hook while two cards still ask
for it.

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
