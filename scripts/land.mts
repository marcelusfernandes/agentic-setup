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
//   node scripts/land.mts <pr> [--require-review]
//
// Refuses (exit 1, { refused, pr, missing, mode }) unless OPEN and approved
// under the mode it declares. Every output — each refusal, the merge and the
// queue — names that mode, so no path is silent about which binding it ran
// under (#144, #156), and each mode carries its *complete* set of
// conditions: there is no downgrade from one to the other, and no mode is
// ever selected by the absence of something.
//
//   'agent'    the default, and the binding this repository runs. The
//              reviewer is an isolated agent that returns { verdict, reasons }
//              to the orchestrator and casts nothing on the server (#148), so
//              there is no PullRequestReview to read a commit off. Requires,
//              all three: the `review:approved` label; the marker comment
//              `<!-- agentic-reviewed-sha: <oid> -->` that the orchestrator
//              writes with the head it reviewed, at the moment it applies that
//              label (`skills/orchestrate/SKILL.md` step 5), equal to the
//              `headRefOid` read here; and every required check in bucket
//              `pass`.
//   'approved' opt-in: everything 'agent' requires *plus*
//              `reviewDecision === 'APPROVED'`, a review the server itself
//              verified and carries. Selected by `--require-review`, or by a
//              base branch whose effective rules already require an approving
//              review (`pull_request` with
//              `required_approving_review_count > 0`) — never by whether
//              AGENTIC_REVIEWER_TOKEN happens to be set, which selects
//              nothing at all. It stays opt-in because it needs a second
//              login: with `required_approving_review_count: 1` and nobody to
//              cast the review, a solo repository freezes at its first merge,
//              and every pull request refuses here with no way to satisfy it.
//              The count is the installer's to own, never a field left to be
//              set by an operator: `scripts/init.mts --rules` resets it to 0
//              and `scripts/init.mts --rules --require-review` raises it to 1
//              (with stale approvals dismissed and the last push approved).
//              Order matters on the way in — GitHub computes reviewDecision
//              only on a branch where a review is actually required, so
//              --require-review passed here against a base branch whose
//              ruleset does not require one leaves reviewDecision null
//              forever and refuses every pull request with no way to satisfy
//              it.
//   'docs'     the `type:docs` exemption, which merges with no review at all
//              and so has no reviewed head to compare and reads no marker. It
//              is an exemption from the *review*, never from the checks.
//
// The mode is read before anything else is decided, because a refusal that
// cannot name its mode says nothing: the base branch's effective rules are
// fetched first (`gh api repos/{owner}/{repo}/rules/branches/<baseRefName>`,
// flattened and enforcement-aware -- unlike the ruleset *list*, summaries
// only, which cannot tell a required_status_checks ruleset from a
// deletion-only one). A rules read that cannot answer refuses with missing
// ['gh-rules'] and mode null rather than falling back to the mode left over
// when a read fails: this file fails closed (invariant 3).
//
// In modes 'agent' and 'approved' the commit the review was cast against is
// the newest `<!-- agentic-reviewed-sha: <oid> -->` marker on the pull
// request, and it must equal the `headRefOid` read in the same `gh pr view`
// call. A push after the review, or no marker at all — a label records no
// commit, so it binds nothing — refuses with missing ['head:changed']
// instead of merging a head nobody read (#191 was approved at 2b9dc20 and
// the merge commit f624902 landed behind it on the queued `--auto`). A
// comments read that cannot answer refuses with missing ['gh-pr-comments']
// and attempts no merge.
//
// A head GitHub does not report as MERGEABLE refuses with missing
// ['merge:not-mergeable'] — CONFLICTING, and UNKNOWN too, because a
// mergeability GitHub has not computed is not a mergeability this script may
// assume. #241 armed `--auto` on a conflicting pull request, where the very
// commit that resolves the conflict would then have merged itself unreviewed.
//
// Then the checks, in *both* gates: `gh pr checks <pr> --required --json
// name,bucket` must return a non-empty list in which every bucket is `pass`,
// or the run refuses with missing ['checks:required']. An empty list is not
// "nothing is red", it is "nothing held the line"; a bucket that is merely
// not red (`pending`, `skipping`) is not `pass`; and gh prints that JSON
// while exiting non-zero (1 red, 8 pending), so the read is parsed from
// stdout rather than judged by its exit code. gate='ruleset' iff those
// effective rules include a required_status_checks rule and 'client-checks'
// otherwise — the gate names who *else* holds the line, never whether the
// buckets were read (#156: "the checks held the line" was assumed under the
// ruleset gate until this read made it true).
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
// state MERGED prints { merged: pr, gate, mode }.
//
// Anything else means GitHub queued the merge instead of performing it. In
// mode 'agent' that queue is disarmed at once — `gh pr merge <pr>
// --disable-auto` — and the run refuses with missing ['merge:not-clean'].
// `--match-head-commit` is passed to GitHub when auto-merge is *enabled*,
// not when it later fires, so a queue left armed merges whatever the branch
// carries by then; that is how #191 landed a commit nobody reviewed. Agent
// mode binds the review to one commit client-side, so it merges now or not
// at all: clear the blockage and run land again. Modes 'approved' and 'docs'
// print { queued: pr, gate, mode } — there, the review requirement the
// server itself enforces (or the absence of any review to outrun) is what
// the queue answers to. A merge call that still fails (the initial one, the
// clean-status retry, or the disarm) prints { error } with gh's message,
// exit 1. No polling, no relabel, no worktree removal either way.
import { spawnSync } from 'node:child_process';

type Label = { name: string };
type PRView = {
  state: string;
  labels: Label[];
  reviewDecision: string | null;
  baseRefName: string;
  headRefOid: string;
  mergeable?: string;
};
type PRComments = { comments?: Array<{ body?: unknown }> };
type Rule = { type?: string; parameters?: { required_approving_review_count?: number } };
type Check = { bucket?: unknown };
type Mode = 'agent' | 'approved' | 'docs';

// The marker the orchestrator writes with the head it reviewed. Only a full
// 40-hex oid counts: anything else records no head this script can compare.
const REVIEWED_SHA = /<!--\s*agentic-reviewed-sha:\s*([0-9a-f]{40})\s*-->/gi;
const USAGE = 'usage: node scripts/land.mts <pr> [--require-review]';

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

/** The base branch's effective rules, or null when the read could not answer. */
function effectiveRules(base: string): Rule[] | null {
  const out = gh(['api', `repos/{owner}/{repo}/rules/branches/${base}`]);
  if (out.status !== 0) return null;
  try {
    const parsed: unknown = JSON.parse(out.stdout);
    return Array.isArray(parsed) ? (parsed as Rule[]) : null;
  } catch {
    return null;
  }
}

/**
 * True only when `gh pr checks --required` answers with a non-empty list in
 * which every check sits in bucket `pass`. gh prints the JSON and exits
 * non-zero whenever something is not green, so the status is ignored and an
 * unparseable answer is a refusal, never a pass.
 */
function everyRequiredCheckPasses(pr: number): boolean {
  const out = gh(['pr', 'checks', String(pr), '--required', '--json', 'name,bucket']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return false;
  return parsed.every((c) => (c as Check | null)?.bucket === 'pass');
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('-'));
if (flags.some((f) => f !== '--require-review')) fail({ error: USAGE });
const requireReview = flags.includes('--require-review');
const prArg = args.find((a) => !a.startsWith('-'));
const pr = Number(prArg);
if (!prArg || !Number.isInteger(pr) || pr <= 0) fail({ error: USAGE });

const view = ghJson<PRView | null>(
  ['pr', 'view', String(pr), '--json', 'state,labels,reviewDecision,baseRefName,headRefOid,mergeable'],
  null,
);
// No head oid is the same as no readable PR: nothing to pin the merge to.
if (!view || typeof view.headRefOid !== 'string' || !view.headRefOid) {
  fail({ refused: `could not read PR #${pr} from gh.`, pr, missing: ['gh-pr-view'], mode: null });
}

// The mode, decided before any condition is judged, so every refusal below
// can name it. The rules are read here because one of the two selectors
// lives in them — and because the gate does too, further down.
const rules = effectiveRules(view.baseRefName);
const isDocs = hasLabel(view.labels, 'type:docs');
const rulesRequireReview = (rules ?? []).some(
  (r) => r.type === 'pull_request' && Number(r.parameters?.required_approving_review_count ?? 0) > 0,
);
const mode: Mode | null = isDocs
  ? 'docs'
  : requireReview || rulesRequireReview
    ? 'approved'
    : rules === null
      ? null
      : 'agent';
if (rules === null) {
  fail({
    refused: `PR #${pr}: could not read the effective rules of base branch ${view.baseRefName}, so neither the review mode nor the gate is known.`,
    pr,
    missing: ['gh-rules'],
    mode,
  });
}

const missing: string[] = [];
if (view.state !== 'OPEN') missing.push(`state=${view.state}`);
// The label is what an agent review leaves behind, in both reviewing modes;
// mode 'approved' adds the server's own decision on top of it, and never
// falls back to the label alone when that decision is missing.
if (!isDocs && !hasLabel(view.labels, 'review:approved')) missing.push('review:not-approved');
if (mode === 'approved' && view.reviewDecision !== 'APPROVED' && !missing.includes('review:not-approved')) {
  missing.push('review:not-approved');
}
if (missing.length) {
  const cost =
    mode === 'approved' && missing.includes('review:not-approved')
      ? ` Mode 'approved' costs a second identity: a repository whose only login is the one running this script cannot cast the review it asks for.`
      : '';
  fail({ refused: `PR #${pr} is not ready to merge: ${missing.join(', ')}.${cost}`, pr, missing, mode });
}

// Modes 'agent' and 'approved': the label says a review happened, the marker
// says at which commit. Both, or neither counts — and a read that cannot
// answer refuses.
if (mode === 'agent' || mode === 'approved') {
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

const gate: 'ruleset' | 'client-checks' = rules.some((r) => r.type === 'required_status_checks') ? 'ruleset' : 'client-checks';

// A head that cannot merge must not have a merge armed on it: the commit
// that later makes it mergeable is one nobody reviewed (#241).
if (view.mergeable !== 'MERGEABLE') {
  fail({
    refused: `PR #${pr}: GitHub reports its head as ${view.mergeable ?? 'unknown'}, not MERGEABLE — nothing is queued on a head that cannot merge.`,
    pr,
    missing: ['merge:not-mergeable'],
    gate,
    mode,
  });
}

if (!everyRequiredCheckPasses(pr)) {
  fail({ refused: `PR #${pr}: not every required check is in bucket pass.`, pr, missing: ['checks:required'], gate, mode });
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
if (after?.state !== 'MERGED' && mode === 'agent') {
  // The merge did not happen, so an auto-merge is armed on a head this run
  // bound to one reviewed commit — and GitHub checks the pinned oid when the
  // queue is enabled, not when it fires (#191). Disarm it and refuse.
  const disarm = gh(['pr', 'merge', String(pr), '--disable-auto']);
  if (disarm.status !== 0) {
    fail({ error: (disarm.stderr || disarm.stdout || 'gh pr merge --disable-auto failed').trim() });
  }
  fail({
    refused: `PR #${pr}: GitHub queued the merge instead of performing it, so the auto-merge was disabled again — mode agent merges the reviewed commit or nothing. Clear what blocks it and run land again.`,
    pr,
    missing: ['merge:not-clean'],
    gate,
    mode,
  });
}
const outcome = after?.state === 'MERGED' ? 'merged' : 'queued';
console.log(JSON.stringify({ [outcome]: pr, gate, mode }));
