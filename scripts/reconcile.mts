#!/usr/bin/env node
// reconcile — prints the agent loop's current state as one JSON document, so
// step 0 of skills/orchestrate/SKILL.md reads it instead of running three
// gh/git commands and cross-referencing them by hand.
//
//   node scripts/reconcile.mts [--milestone "<title>"] [--no-fetch]
//
// Without --milestone, picks the open milestone with the lowest number.
//
// Without --no-fetch, runs `git fetch --prune origin` once before reading
// remote branches, so step 0 of skills/orchestrate/SKILL.md no longer runs
// its own fetch and a pass makes one network call for git, not two. Remote
// branches then come from the local refs (`git for-each-ref
// refs/remotes/origin`), not a second network round trip.
// --no-fetch skips the fetch and reads whatever those local refs already
// hold, so a pass can run offline against the state of the last fetch — at
// the cost of not seeing a branch deleted on the remote since then.
//
// Output shape:
//   {
//     milestone: string,
//     milestoneLint: { ok, missing },                         // whether that milestone's
//                                                              // description holds the
//                                                              // format of
//                                                              // .github/MILESTONE_TEMPLATE.md;
//                                                              // missing names the parts that
//                                                              // are absent, in the template's
//                                                              // order: 'objective',
//                                                              // 'out-of-phase',
//                                                              // 'exit-criteria',
//                                                              // 'depends-on'. Reported, never
//                                                              // refused (see below)
//     ready: [{ number, title, blockedBy: number[] }],       // Blocked-by all closed
//     inProgress: [{ number, branch, hasRemoteBranch, foreignLock, pr }],
//                                                              // pr: number | null.
//                                                              // foreignLock: the branch is
//                                                              // the *other* route's lock
//                                                              // (`codex/task-<n>`), so this
//                                                              // route neither claims nor
//                                                              // resumes it
//     resumable: [{ number, branch, commitsAheadOfMain }],    // in-progress, remote
//                                                              // branch of *this* route's
//                                                              // shape, no open PR, not
//                                                              // checked out in any *live*
//                                                              // local worktree of this
//                                                              // checkout (dead-locked ones
//                                                              // don't count)
//     inReview: [{ number, pr, checks: 'green'|'red'|'pending', reviewApproved }],
//                                                              // checks comes from one
//                                                              // `gh pr checks <pr>` call per
//                                                              // in-review PR, not from the
//                                                              // list-call's rollup
//     stale: [{ number, reason }],                            // in-progress, no PR, no remote branch
//     humanPending: [{ number, title, label }],               // carries human:pending or the
//                                                              // legacy bare human (any case);
//                                                              // never in ready, whatever its
//                                                              // state label. human:decided
//                                                              // is not listed: it records a
//                                                              // past decision and never gates
//     orphanWorktrees: [path],                                // linked worktree, branch gone from origin
//     deadWorktrees: [{ path, branch, pid, dirty, unpushed }], // locked by a pid that no
//                                                              // longer exists. dirty: true
//                                                              // when `git -C <path> status
//                                                              // --porcelain` prints
//                                                              // anything, else false, else
//                                                              // (a broken worktree) null.
//                                                              // unpushed: commits in the
//                                                              // worktree's HEAD not on
//                                                              // `origin/<branch>`, or null
//                                                              // when there is no such
//                                                              // remote branch (or no
//                                                              // `branch` at all, or the
//                                                              // worktree is broken). These
//                                                              // two `git` calls run only
//                                                              // for dead worktrees, never
//                                                              // for live ones.
//   }
//
// A fresh orchestrator session has no live agents by definition, so an
// in-progress issue with a remote branch, no open PR, and no local worktree
// checked out on that branch is not "an implementer is working right now" —
// it is resumable: round N+1 from `origin/<branch>` (skills/safe-worktree
// §C). Classification order for an in-progress issue: open PR -> inProgress
// (with pr); else no remote branch -> stale; else the branch is the other
// route's lock -> inProgress (`foreignLock: true`); else branch checked out
// in a *live* local worktree of this checkout -> inProgress (pr: null);
// else -> resumable, and it is removed from inProgress.
//
// That third step is the one an issue locked by the Codex route lands on,
// and it exists because resolving both lock shapes (#157) is not only a
// refusal: `resumable` is a *dispatch* list. An issue holding
// `codex/task-<n>` and no pull request yet is the Codex loop's normal state
// between its claim push and its PR, and without the step it would read as
// "a branch, no PR, nobody working" — round N+1 material, sending a Claude
// implementer to push to another coordinator's lock branch without
// `claim.mts` ever being consulted. The lock is reported, never resumed:
// only the route that owns the branch namespace works it.
//
// Claude Code locks an agent worktree only while that agent runs, with a
// reason of the form `claude agent agent-<id> (pid <N> start <date>)`; it
// removes the lock on a clean exit (the worktree stays, unlocked), but a
// killed session leaves the lock behind, still naming the now-dead pid. A
// worktree whose lock names a pid that `process.kill(N, 0)` reports gone
// (ESRCH) does not count as a live agent's checkout, so its branch does not
// block `resumable` — the worktree is instead listed in `deadWorktrees` for
// the orchestrator to remove (`git worktree unlock` then `remove --force`)
// before dispatching round N+1. A worktree with no lock, a lock with no pid
// in its reason (or `pid <= 0`, which signals nothing and proves nothing),
// or a lock whose pid is alive (or whose signal fails with EPERM — no
// permission to signal it is not evidence it is gone) is treated exactly as
// before: alive, still "checked out". This narrows, but does not close, the
// #46 restart gap: an agent that finished *without* opening a PR, in a
// session that has since died, leaves an unlocked worktree indistinguishable
// from a live session's paused agent — that residual still reads
// `inProgress` and needs a person, or a future liveness signal, to resolve.
//
// A dead worktree can still hold work the orchestrator would otherwise throw
// away by following its own advice (`git worktree remove --force`): an
// uncommitted change, or a local commit never pushed (#88, four implementers
// died mid-work in M4). Each `deadWorktrees[]` entry therefore also reports
// `dirty` (`git -C <path> status --porcelain` printed anything) and
// `unpushed` (commits on the worktree's `HEAD` not on `origin/<branch>`, via
// `git -C <path> rev-list --count refs/remotes/origin/<branch>..HEAD` — fully
// qualified, same #48 reason as `commitsAhead` below: a local branch literally
// named `origin/<branch>` would otherwise shadow the remote-tracking ref —
// gated by `git -C <path> rev-parse --verify --quiet
// refs/remotes/origin/<branch>` so a branch never pushed reads `unpushed:
// null` rather than a nonsensical count). Both `git` calls run only for
// entries already in `deadWorktrees` — never for a live worktree, whether or
// not it turns out to be dirty or ahead.
//
// `milestoneLint` answers "does this phase say when it is finished?" from the
// milestone's own description, read from the single `gh api
// repos/{owner}/{repo}/milestones?state=all --paginate --jq '.[]'` call this
// script already makes to pick the default milestone (so `--milestone` now
// costs that one call too, not two). `state=all` and `--paginate` are what
// make that one call able to answer for *any* milestone the pass may name:
// the endpoint returns open milestones only, 30 per page, by default, so a
// closed phase or a 31st one would otherwise be invisible — to the default
// pick and to this lint alike. The flatten is needed because `--paginate`
// prints one array per page, which does not parse as a whole.
// The format it lints is the one `.github/MILESTONE_TEMPLATE.md` fixes:
//   - `objective`     — at least one line of prose before the first labelled
//                       section (a bullet or a `#` heading is not prose).
//   - `out-of-phase`  — a line starting with `Out of this phase:`.
//   - `exit-criteria` — a line starting with `Exit criteria:` *and* at least
//                       one checklist item under that label, before the next
//                       one — bulleted (`- [ ]`) or numbered (`1. [ ]`,
//                       `2) [x]`): the checklist is the point, and a checkbox
//                       belonging to another section proves nothing about it.
//   - `depends-on`    — a line starting with `Depends on:`.
// A label line may be wrapped in `#`, `*`, `_` or `>` (`**Out of this
// phase:**`, `## Exit criteria`) and is matched case-insensitively. The colon
// is required unless the line is a markdown heading, so prose that merely
// opens with a label's words ("Depends on the day the upstream API lands.")
// stays prose. Fenced code blocks (``` or ~~~) and HTML comments are stripped
// before any of that, so a label or a checkbox the description only *shows*
// — a template pasted into a fence, a commented-out criterion — satisfies
// nothing. `missing` lists the absent parts in that order and `ok` is
// `missing.length === 0`.
//
// It reports; it never refuses. A milestone whose description has not been
// migrated yet still reconciles normally — the lint changes neither which
// milestone is picked nor the exit code — because a loop that stopped on an
// unmigrated description would be worse than the gap it reports. A milestone
// title that the API call does not return (or a milestone with no description
// at all) reads as an empty description: all four parts missing.
//
// GitHub data comes only from `gh` (issue list, pr list, api, pr checks);
// worktree and branch data from `git worktree list --porcelain` and (after
// `git fetch --prune origin`, unless --no-fetch) `git for-each-ref
// refs/remotes/origin`. Node built-ins only, no dependency.
//
// `inReview[].checks` comes from one `gh pr checks <pr> --json name,bucket`
// call per in-review PR (cached by PR number, so two issues closed by the
// same PR still cost one call) — `gh` already deduplicates superseded check
// runs and classifies each into `bucket` (pass, fail, pending, skipping,
// cancel) the way `gh pr list --json statusCheckRollup` does neither, so
// reconcile no longer re-implements either (the #21 and #24 bugs were bugs
// of that re-implementation). `gh pr checks` exits non-zero whenever a check
// is failing or still pending, but still prints the JSON on stdout in that
// case, so its exit code is ignored; if stdout does not parse as JSON,
// `checks` reads 'pending' rather than failing the whole pass over one PR.
//
// Crash policy: never a stack trace. A failing `gh` or `git` call (auth,
// rate limit, an unknown milestone, no remote) prints { "error": "..." } to
// stdout and exits 1 — except `gh pr checks`, whose failure degrades that
// one PR's `checks` to 'pending' instead (see above), the `git status`
// call behind `deadWorktrees[].dirty`, whose failure (a broken or removed
// worktree) degrades that one entry's `dirty` (and `unpushed`, since a
// worktree whose status cannot be read cannot be trusted for a commit range
// either) to `null` instead of failing the whole pass, and — when
// `--milestone` names the milestone — the `gh api .../milestones` read behind
// `milestoneLint`, whose failure (or output no line of which is a milestone
// object) degrades that one field to "all four parts missing" rather than
// failing a pass whose milestone the caller already named. That same read still fails
// the pass in the other direction, when it is what picks the milestone (no
// `--milestone` given): there is nothing left to reconcile against.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../ci/lib/args.mts';
import { codexLockBranch, lockBranches, parseBlockedBy } from './lib/issues.mts';

type Label = { name: string };
type Issue = { number: number; title: string; body: string; labels: Label[] };
type PR = { number: number; headRefName: string; labels: Label[]; reviewDecision: string | null };
type Milestone = { number: number; title: string; state: string; description?: string | null };
type PrCheckEntry = { name?: string; bucket?: string };

// `gh pr checks --json name,bucket` categorizes each check's raw CI state
// into exactly one of these five buckets (see `gh pr checks --help`) — this
// mirrors that five-way split, not GitHub's raw CheckConclusionState names.
const CHECK_GREEN = new Set(['pass', 'skipping']);
const CHECK_RED = new Set(['fail', 'cancel']);

function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function gh(args: string[]): string {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`gh ${args.join(' ')}: ${(r.stderr || r.stdout || 'failed').trim().split('\n')[0]}`);
  return r.stdout;
}

function ghJson<T>(args: string[], fallback: T): T {
  const out = gh(args).trim();
  if (!out) return fallback;
  try {
    return JSON.parse(out) as T;
  } catch {
    fail(`gh ${args.join(' ')}: could not parse JSON output`);
  }
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) fail(`git ${args.join(' ')}: ${(r.stderr || 'failed').trim().split('\n')[0]}`);
  return r.stdout;
}

function hasLabel(labels: Label[] | undefined, name: string): boolean {
  return (labels ?? []).some((l) => l.name === name);
}

// The one milestones read, shared by both callers below. `state=all` because
// a phase being reconciled can already be closed, and `--paginate` because
// the endpoint answers 30 per page by default — either way the milestone the
// pass names must be in the list. `--paginate` prints one JSON array per
// page, which does not parse as a whole, so `--jq '.[]'` flattens the pages
// into one object per line, the same way `scripts/log-decision.mts` keeps its
// paginated comments read honest.
const MILESTONES_ARGS = ['api', 'repos/{owner}/{repo}/milestones?state=all', '--paginate', '--jq', '.[]'];

/**
 * The `--jq '.[]'` flatten above: one compact JSON object per line. A line
 * that is not an object carrying a string `title` is not a milestone and is
 * dropped, so a `gh` error payload (`{"message":"Not Found"}`) or a non-JSON
 * line reads as no milestones rather than as one.
 */
function parseMilestones(stdout: string): Milestone[] {
  const milestones: Milestone[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.title === 'string') {
        milestones.push(parsed as Milestone);
      }
    } catch {
      // Not JSON: an actual `gh` failure printed on stdout, not a milestone.
    }
  }
  return milestones;
}

// The labelled sections of `.github/MILESTONE_TEMPLATE.md`, in the order the
// template lays them out — `missing` reports them in this order.
const MILESTONE_SECTIONS = [
  { key: 'out-of-phase', label: 'out of this phase' },
  { key: 'exit-criteria', label: 'exit criteria' },
  { key: 'depends-on', label: 'depends on' },
];

// A checklist item, bulleted (`- [ ]`, `* [x]`, `+ [X]`) or numbered
// (`1. [ ]`, `2) [x]`): both are checklists, and the template's own list
// being bulleted does not make a numbered one an absent one.
const CHECKBOX_ITEM = /^\s*(?:[-*+]|\d+[.)])\s*\[[ xX]\]/;
// A bullet or a heading: not the objective's prose.
const NOT_PROSE = /^\s*(?:[-*+]\s|#|>|\||```)/;

// A markdown heading: `## Exit criteria` labels its section without a colon.
const HEADING_LINE = /^\s{0,3}#{1,6}\s/;

// A line opening or closing a fenced code block: ``` or ~~~, up to three
// spaces of indent, plus whatever info string follows.
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/;

/**
 * The description with everything it only *shows* removed, so the scan below
 * reads only what it *states*: HTML comments first (a commented-out fence
 * opens nothing), then every line from a fence to its matching close — or to
 * the end, when the block is never closed. Stripped before parsing, the order
 * `docs/closeout/README.md` already states for its own HTML-comment rule and
 * `scripts/close-milestone.mts` already applies to a closeout table.
 */
function stripShownText(description: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of description.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const marker = FENCE_LINE.exec(line)?.[1] ?? null;
    if (fence === null) {
      if (marker === null) kept.push(line);
      else fence = marker;
    } else if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) {
      fence = null;
    }
  }
  return kept.join('\n');
}

/**
 * The section a line labels (`Out of this phase:`, `**Out of this phase:**`,
 * `## Exit criteria`), or null. The label must be followed by its colon
 * unless the line is a heading, so prose that merely opens with a label's
 * words ("Depends on the day the upstream API lands.") stays prose.
 */
function sectionOf(line: string): string | null {
  const bare = line.replace(/^[\s>#*_]+/, '').toLowerCase();
  const section = MILESTONE_SECTIONS.find((s) => bare.startsWith(s.label));
  if (!section) return null;
  const afterLabel = bare.slice(section.label.length).replace(/^[*_\s]+/, '');
  return afterLabel.startsWith(':') || HEADING_LINE.test(line) ? section.key : null;
}

/**
 * Which parts of the one milestone format (`.github/MILESTONE_TEMPLATE.md`) a
 * milestone description does not hold: an objective in prose, `Out of this
 * phase:`, `Exit criteria:` with at least one `- [ ]` item *under it*, and
 * `Depends on:`. Pure reporting: nothing here refuses, and an empty or absent
 * description simply misses all four. Fenced code blocks and HTML comments
 * are stripped first (`stripShownText`), so a sample label or checkbox the
 * description merely displays satisfies nothing. See the header for the exact
 * matching rules.
 */
function lintMilestoneDescription(description: string | null): { ok: boolean; missing: string[] } {
  const found = new Set<string>();
  let objective = false;
  let section: string | null = null;
  let exitCriteriaHasItem = false;

  for (const line of stripShownText(description ?? '').split('\n')) {
    const label = sectionOf(line);
    if (label !== null) {
      found.add(label);
      section = label;
      continue;
    }
    if (section === null) {
      if (line.trim().length > 0 && !NOT_PROSE.test(line)) objective = true;
    } else if (section === 'exit-criteria' && CHECKBOX_ITEM.test(line)) {
      exitCriteriaHasItem = true;
    }
  }

  // A checkbox belonging to another section proves nothing about the exit
  // criteria, so the search is scoped to the lines under their own label.
  if (!exitCriteriaHasItem) found.delete('exit-criteria');

  const missing = [
    ...(objective ? [] : ['objective']),
    ...MILESTONE_SECTIONS.filter((s) => !found.has(s.key)).map((s) => s.key),
  ];
  return { ok: missing.length === 0, missing };
}

// Gate labels by exact name, case-insensitive: `human:pending`, or the bare
// `human` that predates the two states. `human:decided` records a past
// decision and never gates, so no prefix match.
const PENDING_HUMAN = new Set(['human', 'human:pending']);
function pendingHumanLabel(labels: Label[] | undefined): string | null {
  return (labels ?? []).find((l) => PENDING_HUMAN.has(l.name.toLowerCase()))?.name ?? null;
}

/**
 * `gh pr checks <pr>` already deduplicates superseded check runs (a re-run
 * `concurrency.cancel-in-progress` cancelled when the PR was pushed to
 * again) the way `gh pr list --json statusCheckRollup` does not, and its
 * `bucket` field already classifies each surviving check into pass, fail,
 * pending, skipping or cancel — so this reads that instead of re-deriving
 * green/red/pending from raw CheckConclusionState strings the old rollup
 * code did. `gh pr checks` exits non-zero whenever a check is failing or
 * still pending, but still prints the JSON on stdout in that case — so the
 * exit code is ignored and only stdout is read. A non-JSON stdout (an actual
 * `gh` failure: no such PR, no auth, `gh` not on PATH) degrades to 'pending'
 * rather than failing the whole pass over one PR's checks. Cached by PR
 * number so a PR closing more than one in-review issue costs one call.
 */
const checksCache = new Map<number, 'green' | 'red' | 'pending'>();
function checksForPr(prNumber: number): 'green' | 'red' | 'pending' {
  const cached = checksCache.get(prNumber);
  if (cached) return cached;
  const r = spawnSync('gh', ['pr', 'checks', String(prNumber), '--json', 'name,bucket'], { encoding: 'utf8' });
  const out = (r.stdout ?? '').trim();
  let result: 'green' | 'red' | 'pending' = 'pending';
  if (out) {
    try {
      const entries: PrCheckEntry[] = JSON.parse(out);
      const bucket = (c: PrCheckEntry) => String(c.bucket ?? '').toLowerCase();
      if (Array.isArray(entries) && entries.length > 0) {
        if (entries.some((c) => CHECK_RED.has(bucket(c)))) result = 'red';
        else if (entries.every((c) => CHECK_GREEN.has(bucket(c)))) result = 'green';
      }
    } catch {
      // Non-JSON stdout: leave result at 'pending' rather than failing the
      // whole pass over one PR's checks.
    }
  }
  checksCache.set(prNumber, result);
  return result;
}

const args = parseArgs(process.argv.slice(2));

// 1. milestone: --milestone as given, else the open milestone with the lowest
// number. Either way the milestone list is read once, across every state and
// every page (`MILESTONES_ARGS`) — the default pick needs it, and
// `milestoneLint` (step 1b) needs the reconciled milestone's description,
// which is as likely to be a closed phase's as an open one's. The default
// pick still filters to `state === 'open'` itself: reading the closed ones is
// what lets a caller name one, not a reason to reconcile against one.
// With `--milestone` the read is soft: an unreadable list leaves
// the description empty and the lint says so, rather than refusing a pass
// whose milestone the caller already named.
let milestones: Milestone[];
let milestone: string;
if (typeof args.milestone === 'string') {
  milestone = args.milestone;
  const soft = spawnSync('gh', MILESTONES_ARGS, { encoding: 'utf8' });
  milestones = soft.status === 0 ? parseMilestones(soft.stdout) : [];
} else {
  milestones = parseMilestones(gh(MILESTONES_ARGS));
  const open = milestones.filter((m) => m.state === 'open').sort((a, b) => a.number - b.number);
  if (open.length === 0) fail('no open milestone (pass --milestone).');
  milestone = open[0].title;
}

// 1b. milestoneLint: does that milestone's description say when the phase is
// finished? Reported, never refused — see the header.
const milestoneLint = lintMilestoneDescription(milestones.find((m) => m.title === milestone)?.description ?? '');

// 2. open issues in the milestone.
const issues = ghJson<Issue[]>(
  ['issue', 'list', '--milestone', milestone, '--state', 'open', '--json', 'number,title,body,labels', '--limit', '200'],
  [],
);

// 3. closed issues, repo-wide (a blocker can sit in another milestone).
const closedNumbers = new Set(
  ghJson<{ number: number }[]>(['issue', 'list', '--state', 'closed', '--json', 'number', '--limit', '1000'], []).map((i) => i.number),
);

// 4. open PRs.
const prs = ghJson<PR[]>(
  ['pr', 'list', '--state', 'open', '--json', 'number,headRefName,labels,reviewDecision', '--limit', '200'],
  [],
);

// 5. remote branches: one fetch (unless --no-fetch), then local refs — no
// `git ls-remote` network round trip.
if (!args['no-fetch']) {
  git(['fetch', '--prune', 'origin']);
}
// `%(refname:short)` picks the shortest name that stays unambiguous among
// *all* local refs, not a fixed "strip refs/remotes/origin/" prefix: a local
// branch can force it to render a tracking ref differently (down to the
// literal "origin" for refs/remotes/origin/HEAD itself, which the old
// `.replace(/^origin\//, '')` + `!== 'HEAD'` filter never caught). `lstrip=3`
// always drops exactly the leading `refs/remotes/origin/` components,
// leaving `HEAD` (then filtered) or the real branch name, slashes included.
const remoteHeads = new Set(
  git(['for-each-ref', '--format=%(refname:lstrip=3)', 'refs/remotes/origin'])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((ref) => ref !== 'HEAD'),
);

// `origin/<default>` for the resumable count below. `refs/remotes/origin/HEAD`
// is set by a real clone, and the test fixture sets it explicitly (`git
// remote set-head origin <default>`) after its first fetch, so this resolves
// offline from local refs — no extra `gh` call. Only if that symbolic ref is
// missing (an `origin` added by hand, never fetched with a HEAD) does this
// fall back to `gh repo view`, the same source `claim.mts`/`land.mts` use.
function defaultBranchName(): string {
  const symref = spawnSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], { encoding: 'utf8' });
  if (symref.status === 0) {
    return symref.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  }
  const repoInfo = ghJson<{ defaultBranchRef?: { name?: string } }>(['repo', 'view', '--json', 'defaultBranchRef'], {});
  return repoInfo.defaultBranchRef?.name ?? 'main';
}
const defaultBranch = defaultBranchName();

// A `pid <N>` a Claude Code lock reason names, tested against the live
// process table: no throw -> alive; ESRCH -> gone; anything else (EPERM: no
// permission to signal it, or an unexpected errno) -> alive, fail safe —
// never remove a worktree that might still be in use (AC4).
function isPidAlive(pid: number): boolean {
  // A `\d+` capture cannot itself produce a negative or non-numeric pid, but
  // guard anyway: `pid <= 0` (a bare "pid 0", or a NaN from an unparsable
  // capture) is not a real, signalable process — signal 0 to pid 0 hits the
  // caller's own process group and proves nothing, so treat it as no
  // evidence rather than asking `process.kill` to answer a question it was
  // never asked. No evidence -> alive, same as a lock with no pid at all.
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Whether a dead worktree still holds work worth saving (#88): `dirty` when
 * `git -C <path> status --porcelain` prints anything, `unpushed` the count of
 * commits on its `HEAD` not on `origin/<branch>` (`null` when `branch` is
 * absent, or names no remote-tracking ref — a branch never pushed at all). A
 * `git status` failure (a broken or removed worktree) reports `dirty: null`
 * rather than throwing; `unpushed` degrades to `null` alongside it, since a
 * worktree whose status cannot be trusted cannot be trusted for a commit
 * range either. Called only for entries already known to be dead.
 */
function deadWorktreeWork(path: string, branch: string | null): { dirty: boolean | null; unpushed: number | null } {
  const status = spawnSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.status !== 0) return { dirty: null, unpushed: null };
  const dirty = status.stdout.trim().length > 0;

  if (!branch) return { dirty, unpushed: null };
  const verify = spawnSync('git', ['-C', path, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { encoding: 'utf8' });
  if (verify.status !== 0) return { dirty, unpushed: null };

  const count = spawnSync('git', ['-C', path, 'rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`], { encoding: 'utf8' });
  const unpushed = count.status === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : null;
  return { dirty, unpushed };
}

// 6. worktrees; the first block from `git worktree list` is always the main
// one. A `locked` line with no reason on it, or a reason with no `pid <N>` in
// it, is treated as alive: no evidence the process is gone.
const worktrees = git(['worktree', 'list', '--porcelain'])
  .split(/\n{2,}/)
  .map((b) => b.trim())
  .filter(Boolean)
  .map((block) => {
    const lockedLine = block.match(/^locked(?:[ \t]+(.*))?$/m);
    const pidMatch = lockedLine?.[1]?.match(/pid\s+(\d+)/);
    const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
    return {
      path: block.match(/^worktree\s+(.*)$/m)?.[1] ?? '',
      branch: block.match(/^branch\s+refs\/heads\/(.*)$/m)?.[1] ?? null,
      dead: lockedLine !== null && pid !== null && !isPidAlive(pid),
      pid,
    };
  });
const linkedWorktrees = worktrees.slice(1);
const deadWorktrees = linkedWorktrees
  .filter((w) => w.dead)
  .map((w) => ({ path: w.path, branch: w.branch, pid: w.pid as number, ...deadWorktreeWork(w.path, w.branch) }));

// Which branch names lock an issue is `scripts/lib/issues.mts`'s to say —
// both routes' shapes, `<type>/<n>-<slug>` (scripts/claim.mts) and
// `codex/task-<n>` (the Codex loop's github.mts). Resolving through it is
// what keeps an issue the other route already locked from reading as free
// here (no branch, no PR, "stale"), which is the state a fresh orchestrator
// treats as its own to take (#157). `lockBranches` puts the Claude route's
// own shape first, so a branch this route can act on wins when an issue
// somehow carries both.
function branchFor(number: number): string | null {
  return lockBranches(number, remoteHeads)[0] ?? null;
}
function prFor(branch: string | null): PR | null {
  if (!branch) return null;
  return prs.find((p) => p.headRefName === branch) ?? null;
}

// Issues a person must decide on before any agent touches them. They are
// excluded from `ready` whatever their state label says.
const humanPending = issues
  .map((i) => ({ number: i.number, title: i.title, label: pendingHumanLabel(i.labels) }))
  .filter((i): i is { number: number; title: string; label: string } => i.label !== null);
const humanPendingNumbers = new Set(humanPending.map((i) => i.number));

const ready = issues
  .filter((i) => hasLabel(i.labels, 'state:ready') && !humanPendingNumbers.has(i.number))
  .map((i) => ({ number: i.number, title: i.title, blockedBy: parseBlockedBy(i.body ?? '') }))
  .filter((i) => i.blockedBy.every((n) => closedNumbers.has(n)));

// Branches checked out in any *live* local worktree of this checkout (the
// main worktree included) — an issue whose lock branch is checked out here
// may have a live agent, even before it has opened a PR. A worktree whose
// lock names a dead pid does not count: no evidence an agent is alive there.
const checkedOutBranches = new Set(
  worktrees
    .filter((w) => !w.dead)
    .map((w) => w.branch)
    .filter((b): b is string => b !== null),
);

// Fully-qualified `refs/remotes/origin/...` on both sides, not the short
// `origin/<x>` form: git's revision resolution for a short name prefers a
// local branch (`refs/heads/origin/<x>`) over the remote-tracking ref
// (`refs/remotes/origin/<x>`) of the same name — the exact shadow #48 fixed
// for `for-each-ref`. A local branch literally named `origin/main` or
// `origin/<lock-branch>` would otherwise make this resolve to the wrong
// commit and silently misreport the count instead of failing loudly.
function commitsAhead(branch: string): number {
  const out = git(['rev-list', `refs/remotes/origin/${defaultBranch}..refs/remotes/origin/${branch}`, '--count']).trim();
  return Number.parseInt(out, 10) || 0;
}

const inProgressAll = issues
  .filter((i) => hasLabel(i.labels, 'state:in-progress'))
  .map((i) => {
    const branch = branchFor(i.number);
    const pr = prFor(branch);
    return {
      number: i.number,
      branch,
      hasRemoteBranch: branch !== null,
      // The other route's lock, which this route may report but never take:
      // no claim (scripts/claim.mts refuses it) and no round N+1 either.
      foreignLock: branch === codexLockBranch(i.number),
      pr: pr ? pr.number : null,
    };
  });

// Resumable: a remote branch of this route's own shape, no open PR, not
// checked out in any *live* local worktree of this checkout
// (checkedOutBranches already excludes dead-locked worktrees) — see the
// header comment for the classification order and rationale. A foreign lock
// is excluded here, not merely refused later: `resumable` is what the
// orchestrator dispatches as round N+1 without claiming again
// (skills/orchestrate/SKILL.md), so an issue the Codex route holds would
// reach an implementer with `claim.mts` never consulted.
const resumable = inProgressAll
  .filter((i) => i.pr === null && i.branch !== null && !i.foreignLock && !checkedOutBranches.has(i.branch))
  .map((i) => ({ number: i.number, branch: i.branch as string, commitsAheadOfMain: commitsAhead(i.branch as string) }));
const resumableNumbers = new Set(resumable.map((i) => i.number));

const inProgress = inProgressAll.filter((i) => !resumableNumbers.has(i.number));

const inReview = issues
  .filter((i) => hasLabel(i.labels, 'state:in-review'))
  .map((i) => {
    const branch = branchFor(i.number);
    const pr = prFor(branch);
    return {
      number: i.number,
      pr: pr ? pr.number : null,
      checks: pr ? checksForPr(pr.number) : 'pending' as const,
      reviewApproved: pr ? hasLabel(pr.labels, 'review:approved') || pr.reviewDecision === 'APPROVED' : false,
    };
  });

const stale = inProgress
  .filter((i) => i.pr === null && !i.hasRemoteBranch)
  .map((i) => ({ number: i.number, reason: 'no open PR and no remote branch' }));

const orphanWorktrees = linkedWorktrees.filter((w) => w.branch && !remoteHeads.has(w.branch)).map((w) => w.path);

console.log(
  JSON.stringify(
    { milestone, milestoneLint, ready, humanPending, inProgress, resumable, inReview, stale, orphanWorktrees, deadWorktrees },
    null,
    2,
  ),
);
