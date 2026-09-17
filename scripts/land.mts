#!/usr/bin/env node
// land — the only way the orchestrator merges a PR: asks the server to
// merge when it can, and nothing else (#63). `gh pr merge --auto` merges
// the instant GitHub's own rules are satisfied, so there is no client-side
// read (rulesets, rollup dedupe, --wait polling) that can go stale between
// being taken and the merge happening (#25's incident by construction).
// `Closes #N` closes the linked issue when the PR merges — closed is done,
// nothing left here to relabel. The worktree becomes an orphan once GitHub
// deletes the branch on merge (delete_branch_on_merge, init-enabled); the
// next claim already removes orphaned worktrees. `--delete-branch` is not
// passed to `gh pr merge` (#66 AC0): under `--auto` gh does not delete
// anything itself, but when the PR is *already* mergeable gh merges at once
// and then tries a local `git branch -D`, which fails whenever that branch
// is checked out in a worktree — printing { error } here even though the
// merge already succeeded on the server.
//
//   node scripts/land.mts <pr>
//
// Refuses (exit 1, { refused, pr, missing, mode }) unless OPEN and approved
// (or type:docs). Every output — each refusal, the merge and the queue —
// names the review mode it applied, so no path is silent about which binding
// it ran under (#144):
//
//   'agent'    the label-plus-marker path this repository runs. The reviewer
//              is an isolated agent that returns { verdict, reasons } to the
//              orchestrator and casts nothing on the server (#148), so there
//              is no PullRequestReview to read a commit off: the binding is
//              the `review:approved` label *plus* the marker comment
//              `<!-- agentic-reviewed-sha: <oid> -->` that the orchestrator
//              writes with the head it reviewed, at the moment it applies
//              that label (`skills/orchestrate/SKILL.md` step 5).
//   'approved' `reviewDecision === 'APPROVED'`: a review the server itself
//              verified and carries, so the server's decision is the binding
//              and no marker is read.
//   'docs'     the `type:docs` exemption, which merges with no review at all
//              and so has no reviewed head to compare.
//
// Choosing between 'agent' and 'approved' is #156's; this file only reports
// which one ran. Today the mode is 'approved' whenever the PR carries an
// APPROVED review or the orchestrator's environment has
// AGENTIC_REVIEWER_TOKEN set — the reviewer agent then authenticates as a
// separate identity (`agents/reviewer.md`) and its GitHub review is the only
// thing that satisfies approval: the same token that runs this script can no
// longer write itself an approval by mistake or via a prompt injection in
// the issue (#66, audit finding 6). Without that variable and without such a
// review, the label is what approval means, and that is mode 'agent' (#66
// AC4). Setting the variable without also setting the base branch ruleset's
// required_approving_review_count (`scripts/init.mts`'s "by hand" list)
// leaves `reviewDecision` null forever on a repository with no review
// policy — every PR would then refuse here with no way to satisfy it.
//
// In mode 'agent' the commit the review was cast against is the newest
// `<!-- agentic-reviewed-sha: <oid> -->` marker on the pull request, and it
// must equal the `headRefOid` read in the same `gh pr view` call. A push
// after the review, or no marker at all — a label records no commit, so it
// binds nothing — refuses with missing ['head:changed'] instead of merging a
// head nobody read (#191 was approved at 2b9dc20 and the merge commit
// f624902 landed behind it on the queued `--auto`). A comments read that
// cannot answer refuses with missing ['gh-pr-comments'] and attempts no
// merge: this file fails closed (invariant 3).
//
// Then gate='ruleset' iff the PR base branch's *effective* rules (`gh api
// repos/{owner}/{repo}/rules/branches/<baseRefName>`, flattened and
// enforcement-aware -- unlike the ruleset *list*, summaries only, which
// cannot tell a required_status_checks ruleset from a deletion-only one)
// include a required_status_checks rule. Otherwise runs `gh pr checks <pr>
// --required`, refusing if it is red/pending: the fallback for a branch
// with no such rule, where `--auto` alone would queue an ungated merge.
//
// On success: `gh pr merge <pr> --squash --auto --match-head-commit
// <headRefOid>` (never --delete-branch, never --admin). The oid is the one
// read above, so the server itself refuses the merge if the head moved
// between that read and this call — the client-side marker comparison cannot
// go stale either. `gh` decides between enabling auto-merge and merging
// immediately from a mergeStateStatus it read moments earlier; when
// something else (e.g. a label re-triggering `agentic-checks`) makes it
// choose "enable auto-merge" but GitHub already considers the PR clean by
// the time the mutation lands, the call refuses with "is in clean status"
// even though the exact same command run again a moment later simply
// merges (#78's incident). On that one message, and only that one, land.mts
// retries once with a plain `gh pr merge <pr> --squash --match-head-commit
// <headRefOid>` (no --auto); any
// other failure is reported as before, with no retry. Whichever call
// actually succeeded, the outcome is read back with a fresh
// `gh pr view <pr> --json state` rather than inferred from which call ran:
// state MERGED prints { merged: pr, gate }; anything else -- still OPEN and
// queued for auto-merge, or the state read itself failing -- prints
// { queued: pr, gate }. A merge call that still fails
// (the initial one, or the clean-status retry) prints { error } with gh's
// message, exit 1. No polling, no relabel, no worktree removal either way.
import { spawnSync } from 'node:child_process';

type Label = { name: string };
type PRView = { state: string; labels: Label[]; reviewDecision: string | null; baseRefName: string; headRefOid: string };
type PRComments = { comments?: Array<{ body?: unknown }> };
type Mode = 'agent' | 'approved' | 'docs';

// The marker the orchestrator writes with the head it reviewed. Only a full
// 40-hex oid counts: anything else records no head this script can compare.
const REVIEWED_SHA = /<!--\s*agentic-reviewed-sha:\s*([0-9a-f]{40})\s*-->/gi;

function fail(shape: Record<string, unknown>): never {
  console.log(JSON.stringify(shape));
  process.exit(1);
}

/** The newest marker's oid, lowercased, from comment bodies oldest-first; null when none carries one. */
function newestReviewedSha(bodies: readonly string[]): string | null {
  for (let i = bodies.length - 1; i >= 0; i -= 1) {
    const marker = [...bodies[i].matchAll(REVIEWED_SHA)].at(-1);
    if (marker) return marker[1].toLowerCase();
  }
  return null;
}

const hasLabel = (labels: Label[] | undefined, name: string): boolean => (labels ?? []).some((l) => l.name === name);
const gh = (args: string[]): { status: number; stdout: string; stderr: string } => {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
function ghJson<T>(args: string[], fallback: T): T {
  const out = gh(args);
  if (out.status !== 0 || !out.stdout.trim()) return fallback;
  try {
    return JSON.parse(out.stdout) as T;
  } catch {
    return fallback;
  }
}

const prArg = process.argv[2];
const pr = Number(prArg);
if (!prArg || !Number.isInteger(pr) || pr <= 0) fail({ error: 'usage: node scripts/land.mts <pr>' });

const view = ghJson<PRView | null>(['pr', 'view', String(pr), '--json', 'state,labels,reviewDecision,baseRefName,headRefOid'], null);
// No head oid is the same as no readable PR: nothing to pin the merge to.
if (!view || typeof view.headRefOid !== 'string' || !view.headRefOid) {
  fail({ refused: `could not read PR #${pr} from gh.`, pr, missing: ['gh-pr-view'], mode: null });
}

const missing: string[] = [];
if (view.state !== 'OPEN') missing.push(`state=${view.state}`);
const isDocs = hasLabel(view.labels, 'type:docs');
// A reviewer identity configured means the label alone is a convenience,
// never the gate: only a real review from that identity counts (#66 AC2).
const reviewerIdentityConfigured = Boolean(process.env.AGENTIC_REVIEWER_TOKEN);
const approved = view.reviewDecision === 'APPROVED' || (!reviewerIdentityConfigured && hasLabel(view.labels, 'review:approved'));
// The mode this run applies, named on every output below (#144). The docs
// exemption comes first: it merges with no review at all, so it has no
// reviewed head and reads no marker.
const mode: Mode = isDocs ? 'docs' : view.reviewDecision === 'APPROVED' || reviewerIdentityConfigured ? 'approved' : 'agent';
if (!isDocs && !approved) missing.push('review:not-approved');
if (missing.length) fail({ refused: `PR #${pr} is not ready to merge: ${missing.join(', ')}.`, pr, missing, mode });

// Mode 'agent': the label says a review happened, the marker says at which
// commit. Both, or neither counts — and a read that cannot answer refuses.
if (mode === 'agent') {
  const commentsView = ghJson<PRComments | null>(['pr', 'view', String(pr), '--json', 'comments'], null);
  const comments = commentsView && Array.isArray(commentsView.comments) ? commentsView.comments : null;
  if (comments === null) {
    fail({ refused: `PR #${pr}: could not read its comments from gh, so the reviewed commit is unknown.`, pr, missing: ['gh-pr-comments'], mode });
  }
  const reviewed = newestReviewedSha(comments.map((c) => (typeof c.body === 'string' ? c.body : '')));
  if (reviewed !== view.headRefOid.toLowerCase()) {
    const why = reviewed === null ? 'no reviewed commit is recorded on it' : `the review was cast against ${reviewed}`;
    fail({ refused: `PR #${pr}: its head ${view.headRefOid} is not the commit the review approved — ${why}.`, pr, missing: ['head:changed'], mode });
  }
}

const rules = ghJson<Array<{ type?: string }>>(['api', `repos/{owner}/{repo}/rules/branches/${view.baseRefName}`], []);
const gate: 'ruleset' | 'client-checks' = rules.some((r) => r.type === 'required_status_checks') ? 'ruleset' : 'client-checks';

if (gate === 'client-checks' && gh(['pr', 'checks', String(pr), '--required']).status !== 0) {
  fail({ refused: `PR #${pr}: required checks are not green.`, pr, missing: ['checks:required'], gate, mode });
}

const autoMergeResult = gh(['pr', 'merge', String(pr), '--squash', '--auto', '--match-head-commit', view.headRefOid]);
if (autoMergeResult.status !== 0) {
  const message = (autoMergeResult.stderr || autoMergeResult.stdout || 'gh pr merge failed').trim();
  if (!/is in clean status/.test(message)) fail({ error: message });
  // #78: gh chose "enable auto-merge" off a stale mergeStateStatus, but
  // GitHub now considers the PR clean and refuses that mutation. The exact
  // same intent, minus --auto, merges it outright.
  const retryResult = gh(['pr', 'merge', String(pr), '--squash', '--match-head-commit', view.headRefOid]);
  if (retryResult.status !== 0) {
    fail({ error: (retryResult.stderr || retryResult.stdout || 'gh pr merge failed').trim() });
  }
}

const after = ghJson<{ state?: string } | null>(['pr', 'view', String(pr), '--json', 'state'], null);
const outcome = after?.state === 'MERGED' ? 'merged' : 'queued';
console.log(JSON.stringify({ [outcome]: pr, gate, mode }));
