#!/usr/bin/env node
// land — the only way the orchestrator merges a PR: asks the server to
// merge when it can, and nothing else (#63). `gh pr merge --auto` merges
// the instant GitHub's own rules are satisfied, so no client-side read
// (rulesets, rollup dedupe, a poll of the checks) is ever what *decides* a
// merge here, and none can go stale between being taken and the merge
// happening (#25's incident by construction). `--wait` (below) does not
// reopen that door: it reads the *outcome* after the server already owns the
// merge, and decides nothing at all — a state it reads can only end the
// wait, never start a merge.
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
//   node scripts/land.mts <pr> [--require-review] [--wait [--timeout <seconds>]]
//
// Refuses (exit 1, { refused, pr, missing, mode }) unless OPEN and approved
// under the mode it declares. Every output names that mode — each refusal,
// the merge, the queue, and the { error } lines too, which are exactly what an
// operator reads when no merge happened: the usage line names mode null,
// because it is printed before a mode can be read, and every { error } after
// it carries { pr, gate, mode } beside gh's own message (#238). So no path is
// silent about which binding it ran under (#144, #156), and each mode carries
// its *complete* set of conditions: there is no downgrade from one to the
// other, and no mode is ever selected by the absence of something.
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
//              verified and carries, *cast against this very head*. The newest
//              APPROVED entry of `gh pr view <pr> --json reviews` carries the
//              `commit.oid` it was submitted on, and that oid must equal
//              `headRefOid` too, or the run refuses with missing
//              ['head:changed'] (#238). Without that read a stale approval
//              merges the head whenever some marker equal to it exists:
//              GitHub dismisses a stale review only where the repository
//              raised `dismiss_stale_reviews_on_push`, and the marker records
//              what the *orchestrator* reviewed, never what the server-side
//              review was cast on. `--json latestReviews` is the read that
//              cannot answer this — gh returns `commit: { oid: "" }` on every
//              entry there, so `reviews` is the field. A reviews read that
//              cannot answer refuses with missing ['gh-pr-reviews'] and merges
//              nothing, failing closed as the comments read does.
//              Selected by `--require-review`, or by a
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
// That marker binds a commit, not a person. Any identity that can comment on
// the pull request can write one, and nothing here reads the comment's author:
// which identity counts as the orchestrator is the question #156 and #237
// carry, and until that decision lands the marker is read for its oid alone.
// Mode 'approved' is where that gap is narrowest, because there the server
// keeps a record of its own — see that mode's entry above.
//
// A head GitHub reports as CONFLICTING refuses with missing ['pr:conflict'],
// before any merge call. It is named apart from the refusal below because it
// is the one state with a remedy: the implementer merges `origin/<base>` on
// the published branch and the new head is reviewed again
// (docs/orchestration.md step 5, "main moved and conflicts"). And it has to
// be named at all because a conflicting head carries no check runs, so every
// reader that only classifies checks reads the conflict as "still running"
// and waits for what will never arrive (#239, D15/D20).
// Any other head GitHub does not report as MERGEABLE refuses with missing
// ['merge:not-mergeable'] — UNKNOWN included, because a mergeability GitHub
// has not computed is not a mergeability this script may assume; that is not
// a conflict, it is an answer that has not arrived, and this file fails
// closed on those (invariant 3). #241 armed `--auto` on a conflicting pull
// request, where the very commit that resolves the conflict would then have
// merged itself unreviewed.
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
// clean-status retry, or the disarm) prints { error, pr, gate, mode } with
// gh's message, exit 1. No relabel and no worktree removal either way.
//
// `--wait` makes that queue a bounded step of this script instead of a
// person watching `gh pr checks` (measured: `docs/dogfood/2026-09-10.md`,
// L3, where every merge that printed { queued } was finished by ad hoc
// polling). It polls `gh pr view <pr> --json state` — the same read the
// outcome above is taken from — every POLL_INTERVAL_SECONDS, or every
// quarter of the budget when that is shorter, until one of:
//
//   MERGED          { merged: pr, gate, mode }, exit 0 — the same shape, and
//                   the same exit, as a merge that happened at once.
//   the timeout     { queued: pr, gate, mode, timeout: <seconds> }, exit 0.
//                   The bound is --timeout <seconds>, default
//                   DEFAULT_TIMEOUT_SECONDS; the queue is left armed and the
//                   server still fires it when its own rules are met. A
//                   queue that is still a queue is not an error, it is an
//                   unfinished wait — and the output says how long it waited.
//   CLOSED, or a    { error, pr, gate, mode }, exit 1. Neither is worth
//   state the poll  polling to the timeout: a pull request closed without
//   cannot read     merging will not merge, and a read that cannot answer is
//                   a refusal here as everywhere else (invariant 3).
//
// The wait is never unbounded: --timeout must be a positive whole number of
// seconds, and passing it without --wait is a usage error rather than an
// argument silently ignored. In mode 'agent' there is nothing to wait for —
// that mode merges now or disarms and refuses — so --wait is accepted there
// (the mode is selected by the base branch's rules, which the caller cannot
// know before running) and changes no output and makes no extra read. The
// flag is about modes 'approved' and 'docs', the two that print { queued }.
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
type PRReview = { state?: unknown; commit?: { oid?: unknown } | null };
type PRReviews = { reviews?: PRReview[] };
type Rule = { type?: string; parameters?: { required_approving_review_count?: number } };
type Check = { name?: unknown; bucket?: unknown; state?: unknown };
type Mode = 'agent' | 'approved' | 'docs';

// The marker the orchestrator writes with the head it reviewed. Only a full
// 40-hex oid counts: anything else records no head this script can compare.
const REVIEWED_SHA = /<!--\s*agentic-reviewed-sha:\s*([0-9a-f]{40})\s*-->/gi;
const USAGE = 'usage: node scripts/land.mts <pr> [--require-review] [--wait [--timeout <seconds>]]';
/** How long `--wait` waits for the queue to fire when --timeout says nothing. */
const DEFAULT_TIMEOUT_SECONDS = 900;
/** How often it reads the state back — or a quarter of the budget, when that is shorter. */
const POLL_INTERVAL_SECONDS = 10;

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

/**
 * The oid the newest APPROVED review was cast against, lowercased. Null when
 * nothing approves, and null when the newest approving review records no full
 * 40-hex oid: a review that names no commit binds no head, exactly as a label
 * does not. Reviews arrive oldest-first, so this reads from the end for the
 * same reason `newestReviewedSha` does — the newest one is the one in force.
 */
function newestApprovedReviewOid(reviews: readonly PRReview[]): string | null {
  for (let i = reviews.length - 1; i >= 0; i -= 1) {
    if (reviews[i]?.state !== 'APPROVED') continue;
    const oid = reviews[i]?.commit?.oid;
    return typeof oid === 'string' && /^[0-9a-f]{40}$/i.test(oid) ? oid.toLowerCase() : null;
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

// `state` carries the run's conclusion once it has one and its *status*
// until then, so these are the values that mean "not completed". A run
// reporting one of them is pending however it was bucketed: gh derives the
// bucket from a snapshot, and the snapshot can be older than the run (D16).
const CHECK_RUNNING = new Set(['queued', 'in_progress', 'pending', 'waiting', 'requested', 'expected']);
const CHECK_CANCELLED = new Set(['cancelled', 'canceled']); // both spellings GitHub has used

/** A run's effective bucket: `pending` while its own state says it has not completed. */
function bucketOf(c: Check): string {
  const state = String(c?.state ?? '').toLowerCase();
  return CHECK_RUNNING.has(state) ? 'pending' : String(c?.bucket ?? '').toLowerCase();
}

/**
 * The runs that still say something about the pull request. A cancelled run
 * is dropped when another run of the *same check* survives beside it: a label
 * edit re-triggers the workflow and cancels the run in flight, so that
 * cancellation reports on the edit, not on the check (D16). One nothing
 * supersedes is kept and still fails — a check cancelled and never replaced
 * is a check that did not hold the line. No timestamp is consulted, which is
 * the point: gh's own dedupe picks by `startedAt`, and a just-started run
 * reports none, which is how the cancelled run came to look like the latest.
 */
function liveChecks(entries: Check[]): Check[] {
  const isCancelled = (c: Check) =>
    CHECK_CANCELLED.has(String(c?.state ?? '').toLowerCase()) || bucketOf(c) === 'cancel';
  const superseded = new Set(entries.filter((c) => !isCancelled(c)).map((c) => String(c?.name ?? '')));
  return entries.filter((c) => !(isCancelled(c) && superseded.has(String(c?.name ?? ''))));
}

/**
 * True only when `gh pr checks --required` answers with a list that, once the
 * superseded cancellations are dropped, is non-empty and holds nothing but
 * runs whose effective bucket is `pass`. gh prints the JSON and exits
 * non-zero whenever something is not green, so the status is ignored and an
 * unparseable answer is a refusal, never a pass. A list that is empty — or
 * that only held cancellations something replaced — is a refusal too: an
 * empty list is not "nothing is red", it is "nothing held the line".
 */
function everyRequiredCheckPasses(pr: number): boolean {
  const out = gh(['pr', 'checks', String(pr), '--required', '--json', 'name,bucket,state']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.stdout);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const live = liveChecks(parsed as Check[]);
  if (live.length === 0) return false;
  return live.every((c) => bucketOf(c) === 'pass');
}

/** Milliseconds, synchronously, with no dependency and no event loop: this script is a straight line. */
function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Polls `gh pr view <pr> --json state` until it reads MERGED ('merged') or
 * the budget runs out ('timeout'). A state that cannot be read, and a pull
 * request that is no longer OPEN without being MERGED, end the run with
 * { error } and exit 1 instead: neither becomes a merge by being polled
 * again. The wait always ends — the deadline is taken once, before the first
 * poll, and the sleep never overshoots what is left of it.
 */
function waitForMerge(pr: number, timeoutSeconds: number, tail: Record<string, unknown>): 'merged' | 'timeout' {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const intervalMs = Math.min(POLL_INTERVAL_SECONDS, timeoutSeconds / 4) * 1000;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 'timeout';
    sleep(Math.min(intervalMs, remaining));
    const polled = ghJson<{ state?: string } | null>(['pr', 'view', String(pr), '--json', 'state'], null);
    const state = typeof polled?.state === 'string' ? polled.state : null;
    if (state === null) {
      fail({ error: `PR #${pr}: could not read its state from gh while waiting for the merge.`, pr, ...tail });
    }
    if (state === 'MERGED') return 'merged';
    if (state !== 'OPEN') {
      fail({ error: `PR #${pr}: it is ${state}, not MERGED — the merge will not happen, so the wait stops here.`, pr, ...tail });
    }
  }
}

type Options = { pr: number; requireReview: boolean; wait: boolean; timeout: number };

/**
 * `<pr> [--require-review] [--wait [--timeout <seconds>]]`, or null for
 * anything it does not read exactly: an unknown flag, a --timeout given
 * twice, given no positive whole number of seconds, or given without the
 * --wait it bounds, and no pull request number at all. The first non-flag
 * argument is the pull request, as it has always been.
 */
function parseArgs(argv: readonly string[]): Options | null {
  let pr: number | null = null;
  let requireReview = false;
  let wait = false;
  let timeout: number | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--require-review') {
      requireReview = true;
    } else if (arg === '--wait') {
      wait = true;
    } else if (arg === '--timeout') {
      const seconds = Number(argv[i + 1]);
      i += 1;
      if (timeout !== null || argv[i] === undefined || !Number.isInteger(seconds) || seconds <= 0) return null;
      timeout = seconds;
    } else if (arg.startsWith('-')) {
      return null;
    } else if (pr === null) {
      const n = Number(arg);
      if (!Number.isInteger(n) || n <= 0) return null;
      pr = n;
    }
  }
  if (pr === null || (timeout !== null && !wait)) return null;
  return { pr, requireReview, wait, timeout: timeout ?? DEFAULT_TIMEOUT_SECONDS };
}

const options = parseArgs(process.argv.slice(2));
if (!options) fail({ error: USAGE, mode: null });
const { pr, requireReview, wait, timeout } = options;

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

// Mode 'approved' adds the server's own record of that commit. The marker
// above is a pull request comment; the PullRequestReview the server verified
// carries the oid it was cast against, and GitHub does not dismiss a stale
// approval unless the repository raised dismiss_stale_reviews_on_push — so
// without this read a review of an older commit still merges the head
// whenever some marker equal to it exists. A reviews read that cannot answer
// refuses with missing ['gh-pr-reviews'] and merges nothing (invariant 3).
if (mode === 'approved') {
  const reviewsView = ghJson<PRReviews | null>(['pr', 'view', String(pr), '--json', 'reviews'], null);
  const reviews = reviewsView && Array.isArray(reviewsView.reviews) ? reviewsView.reviews : null;
  if (reviews === null) {
    fail({
      refused: `PR #${pr}: could not read its reviews from gh, so the commit the approving review was cast against is unknown.`,
      pr,
      missing: ['gh-pr-reviews'],
      mode,
    });
  }
  const approvedAt = newestApprovedReviewOid(reviews);
  if (approvedAt !== view.headRefOid.toLowerCase()) {
    const why =
      approvedAt === null
        ? 'no approving review on it records a commit'
        : `the approving review was cast against ${approvedAt}`;
    fail({
      refused: `PR #${pr}: its head ${view.headRefOid} is not the commit the server-verified review approved — ${why}.`,
      pr,
      missing: ['head:changed'],
      mode,
    });
  }
}

const gate: 'ruleset' | 'client-checks' = rules.some((r) => r.type === 'required_status_checks') ? 'ruleset' : 'client-checks';

// A conflict is its own refusal, before the general one below, because it is
// the one state here with a remedy the orchestrator can act on: the
// implementer merges `origin/<base>` on the published branch, and the new
// head is reviewed again and gets a fresh marker
// (docs/orchestration.md step 5, "main moved and conflicts"). It also has to
// be named, not merely refused: a conflicting head carries no check runs at
// all, so every reader that only classifies checks calls it "still running"
// and waits for what never arrives (#239, D15/D20).
if (view.mergeable === 'CONFLICTING') {
  fail({
    refused: `PR #${pr}: GitHub reports its head as CONFLICTING with ${view.baseRefName} — merge origin/${view.baseRefName} into the branch, have the new head reviewed, then land again.`,
    pr,
    missing: ['pr:conflict'],
    gate,
    mode,
  });
}

// A head that cannot merge must not have a merge armed on it: the commit
// that later makes it mergeable is one nobody reviewed (#241). UNKNOWN lands
// here and not above: a mergeability GitHub has not computed is not a
// conflict, it is an answer that has not arrived, and this script fails
// closed on those (invariant 3) rather than assuming either way.
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
  if (!/is in clean status/.test(message)) fail({ error: message, pr, gate, mode });
  // #78: gh chose "enable auto-merge" off a stale mergeStateStatus, but
  // GitHub now considers the PR clean and refuses that mutation. The exact
  // same intent, minus --auto, merges it outright.
  const retryResult = gh(['pr', 'merge', String(pr), '--squash', '--match-head-commit', view.headRefOid]);
  if (retryResult.status !== 0) {
    fail({ error: (retryResult.stderr || retryResult.stdout || 'gh pr merge failed').trim(), pr, gate, mode });
  }
}

const after = ghJson<{ state?: string } | null>(['pr', 'view', String(pr), '--json', 'state'], null);
if (after?.state !== 'MERGED' && mode === 'agent') {
  // The merge did not happen, so an auto-merge is armed on a head this run
  // bound to one reviewed commit — and GitHub checks the pinned oid when the
  // queue is enabled, not when it fires (#191). Disarm it and refuse.
  const disarm = gh(['pr', 'merge', String(pr), '--disable-auto']);
  if (disarm.status !== 0) {
    fail({ error: (disarm.stderr || disarm.stdout || 'gh pr merge --disable-auto failed').trim(), pr, gate, mode });
  }
  fail({
    refused: `PR #${pr}: GitHub queued the merge instead of performing it, so the auto-merge was disabled again — mode agent merges the reviewed commit or nothing. Clear what blocks it and run land again.`,
    pr,
    missing: ['merge:not-clean'],
    gate,
    mode,
  });
}
if (after?.state === 'MERGED') {
  console.log(JSON.stringify({ merged: pr, gate, mode }));
} else if (wait) {
  // Modes 'approved' and 'docs' only: mode 'agent' never reaches here with a
  // queue armed, it refused above. The queue is the server's now, so the
  // wait watches it and neither disarms it nor merges anything itself.
  const waited = waitForMerge(pr, timeout, { gate, mode });
  console.log(JSON.stringify(waited === 'merged' ? { merged: pr, gate, mode } : { queued: pr, gate, mode, timeout }));
} else {
  console.log(JSON.stringify({ queued: pr, gate, mode }));
}
