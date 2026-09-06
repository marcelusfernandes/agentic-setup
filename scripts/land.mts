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
// Refuses (exit 1, { refused, pr, missing }) unless OPEN and approved (or
// type:docs). "Approved" is `reviewDecision === 'APPROVED'`, or — only when
// the orchestrator's environment has no AGENTIC_REVIEWER_TOKEN set — the
// `review:approved` label as a fallback. When that variable is set, the
// reviewer agent authenticates as a separate identity (`agents/reviewer.md`)
// and its GitHub review is the only thing that satisfies approval: the same
// token that runs this script can no longer write itself an approval by
// mistake or via a prompt injection in the issue (#66, audit finding 6).
// Without the variable, behaviour is unchanged (#66 AC4). Setting the
// variable without also setting the base branch ruleset's
// required_approving_review_count (`scripts/init.mts`'s "by hand" list)
// leaves `reviewDecision` null forever on a repository with no review
// policy — every PR would then refuse here with no way to satisfy it.
//
// Then gate='ruleset' iff the PR base branch's *effective* rules (`gh api
// repos/{owner}/{repo}/rules/branches/<baseRefName>`, flattened and
// enforcement-aware -- unlike the ruleset *list*, summaries only, which
// cannot tell a required_status_checks ruleset from a deletion-only one)
// include a required_status_checks rule. Otherwise runs `gh pr checks <pr>
// --required`, refusing if it is red/pending: the fallback for a branch
// with no such rule, where `--auto` alone would queue an ungated merge.
//
// On success: `gh pr merge <pr> --squash --auto` (never --delete-branch,
// never --admin). `gh` decides between enabling auto-merge and merging
// immediately from a mergeStateStatus it read moments earlier; when
// something else (e.g. a label re-triggering `agentic-checks`) makes it
// choose "enable auto-merge" but GitHub already considers the PR clean by
// the time the mutation lands, the call refuses with "is in clean status"
// even though the exact same command run again a moment later simply
// merges (#78's incident). On that one message, and only that one, land.mts
// retries once with a plain `gh pr merge <pr> --squash` (no --auto); any
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
type PRView = { state: string; labels: Label[]; reviewDecision: string | null; baseRefName: string };

function fail(shape: Record<string, unknown>): never {
  console.log(JSON.stringify(shape));
  process.exit(1);
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

const view = ghJson<PRView | null>(['pr', 'view', String(pr), '--json', 'state,labels,reviewDecision,baseRefName'], null);
if (!view) fail({ refused: `could not read PR #${pr} from gh.`, pr, missing: ['gh-pr-view'] });

const missing: string[] = [];
if (view.state !== 'OPEN') missing.push(`state=${view.state}`);
const isDocs = hasLabel(view.labels, 'type:docs');
// A reviewer identity configured means the label alone is a convenience,
// never the gate: only a real review from that identity counts (#66 AC2).
const reviewerIdentityConfigured = Boolean(process.env.AGENTIC_REVIEWER_TOKEN);
const approved = view.reviewDecision === 'APPROVED' || (!reviewerIdentityConfigured && hasLabel(view.labels, 'review:approved'));
if (!isDocs && !approved) missing.push('review:not-approved');
if (missing.length) fail({ refused: `PR #${pr} is not ready to merge: ${missing.join(', ')}.`, pr, missing });

const rules = ghJson<Array<{ type?: string }>>(['api', `repos/{owner}/{repo}/rules/branches/${view.baseRefName}`], []);
const gate: 'ruleset' | 'client-checks' = rules.some((r) => r.type === 'required_status_checks') ? 'ruleset' : 'client-checks';

if (gate === 'client-checks' && gh(['pr', 'checks', String(pr), '--required']).status !== 0) {
  fail({ refused: `PR #${pr}: required checks are not green.`, pr, missing: ['checks:required'], gate });
}

const autoMergeResult = gh(['pr', 'merge', String(pr), '--squash', '--auto']);
if (autoMergeResult.status !== 0) {
  const message = (autoMergeResult.stderr || autoMergeResult.stdout || 'gh pr merge failed').trim();
  if (!/is in clean status/.test(message)) fail({ error: message });
  // #78: gh chose "enable auto-merge" off a stale mergeStateStatus, but
  // GitHub now considers the PR clean and refuses that mutation. The exact
  // same intent, minus --auto, merges it outright.
  const retryResult = gh(['pr', 'merge', String(pr), '--squash']);
  if (retryResult.status !== 0) {
    fail({ error: (retryResult.stderr || retryResult.stdout || 'gh pr merge failed').trim() });
  }
}

const after = ghJson<{ state?: string } | null>(['pr', 'view', String(pr), '--json', 'state'], null);
const outcome = after?.state === 'MERGED' ? 'merged' : 'queued';
console.log(JSON.stringify({ [outcome]: pr, gate }));
