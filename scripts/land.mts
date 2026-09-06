#!/usr/bin/env node
// land — the only way the orchestrator merges a PR: refuses unless the
// server will accept the merge, and changes labels and worktrees only after
// GitHub reports the PR as merged. See skills/orchestrate/SKILL.md step 5,
// which used to be prose ("green checks and review:approved -> merge ->
// label done -> remove the worktree") with nothing between the arrows
// verifying anything.
//
//   node scripts/land.mts <pr> [--wait <seconds>]
//
// Preconditions, read live via `gh pr view`:
//   - state is OPEN
//   - mergeStateStatus is CLEAN
//   - the review:approved label, or an APPROVED review, unless the PR
//     carries type:docs
//   - every check required by the default branch's required_status_checks
//     ruleset rule (or, when there is no such ruleset/rule, every check in
//     the rollup) is green, after deduplication by name/context keeping the
//     latest run by startedAt
//
// Any precondition failing prints { refused, pr, missing, rulesetChecks } to
// stdout, exits 1, and changes nothing.
//
// --wait <seconds> (default 0): while mergeStateStatus is BLOCKED, UNKNOWN
// or BEHIND *and* some required check's latest run is still IN_PROGRESS or
// QUEUED, poll and re-evaluate instead of refusing immediately.
//
// On success: `gh pr merge <pr> --squash --delete-branch` (gh's own default
// squash subject, "<title> (#<pr>)"; never --admin, never --auto, no force
// of any kind; AGENTIC_ALLOW_MERGE is protect-main's valve, not read here —
// the hook still runs on this call). Only once `gh pr view` reports state
// MERGED: every issue the PR body links via a closing keyword gets
// state:done (its other state:* labels removed), and the local worktree
// checked out on the PR's head branch, if any, is removed.
//
// If the merge command fails, or the PR never reaches MERGED, prints
// { error } to stdout, exits 1, and changes no label and no worktree.
//
// Poll intervals are overridable so the test suite does not sleep:
// AGENTIC_LAND_POLL_MS overrides both the AC2 poll (default 15s) and the
// AC4 poll (default 5s). The AC4 attempt count is fixed at 12 (60s at the
// default interval) regardless of the override, so a "never merges"
// scenario cannot loop forever even with a large override.
//
// Node built-ins only, no dependency.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../ci/lib/args.mts';
import { parseLinkedIssues } from '../ci/lib/scope.mts';

type Label = { name: string };
type CheckEntry = {
  name?: string;
  context?: string;
  status?: string;
  state?: string;
  conclusion?: string;
  startedAt?: string;
  completedAt?: string;
};
type PRView = {
  number: number;
  state: string;
  headRefName: string;
  body: string;
  labels: Label[];
  reviewDecision: string | null;
  mergeStateStatus: string;
  statusCheckRollup: CheckEntry[] | null;
};
type MergeView = { state: string; mergeCommit?: { oid?: string } | null };
type Ruleset = {
  conditions?: { ref_name?: { include?: string[] } };
  rules?: Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string }> } }>;
};

const GREEN = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const PENDING = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING']);
const WAITABLE_MERGE_STATUS = new Set(['BLOCKED', 'UNKNOWN', 'BEHIND']);

const POLL_OVERRIDE_MS = process.env.AGENTIC_LAND_POLL_MS ? Number(process.env.AGENTIC_LAND_POLL_MS) : undefined;
const AC2_POLL_MS = POLL_OVERRIDE_MS ?? 15000;
const AC4_POLL_MS = POLL_OVERRIDE_MS ?? 5000;
const AC4_MAX_ATTEMPTS = 12; // 12 * 5000ms default = 60s, per AC4

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function fail(shape: Record<string, unknown>): never {
  console.log(JSON.stringify(shape));
  process.exit(1);
}

function hasLabel(labels: Label[] | undefined, name: string): boolean {
  return (labels ?? []).some((l) => l.name === name);
}

function repoRoot(): string {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) fail({ error: `git rev-parse --show-toplevel: ${(r.stderr || 'failed').trim()}` });
  return r.stdout.trim();
}

function gh(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function ghJson<T>(cwd: string, args: string[], fallback: T): T {
  const r = gh(cwd, args);
  if (r.status !== 0) return fallback;
  const out = r.stdout.trim();
  if (!out) return fallback;
  try {
    return JSON.parse(out) as T;
  } catch {
    return fallback;
  }
}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Same rule as scripts/reconcile.mts's latestChecksByName: keep only the
 * latest entry per check name/context, ordered by startedAt (a re-run
 * always starts after the run it replaces, whatever that run's
 * completedAt). reconcile.mts does not export this function and #31 owns
 * that file, so it is copied here rather than imported.
 */
function latestChecksByName(entries: CheckEntry[]): CheckEntry[] {
  const latest = new Map<string, CheckEntry>();
  for (const entry of entries) {
    const key = entry.name ?? entry.context ?? '';
    const existing = latest.get(key);
    if (!existing) {
      latest.set(key, entry);
      continue;
    }
    const existingTime = existing.startedAt ?? existing.completedAt;
    const time = entry.startedAt ?? entry.completedAt;
    if (existingTime && time ? time >= existingTime : true) latest.set(key, entry);
  }
  return [...latest.values()];
}

/**
 * A check run's outcome lives in `conclusion` once `status` is COMPLETED,
 * and in `status` itself (IN_PROGRESS, QUEUED) while it is not; a status
 * context instead carries its outcome in `state` (SUCCESS, FAILURE, ERROR,
 * PENDING). reconcile.mts's equivalent reads only conclusion/state, which
 * is enough there (anything not green falls into "pending" by elimination);
 * land.mts needs to positively recognise IN_PROGRESS/QUEUED to drive the
 * AC2 wait, so it also reads `status`.
 */
function checkStatus(c: CheckEntry): string {
  return String(c.conclusion ?? c.state ?? c.status ?? '').toUpperCase();
}

/**
 * The check names the default branch's ruleset requires, or null when there
 * is no ruleset targeting the default branch, or none of those carries a
 * required_status_checks rule with any check named. AC1 then falls back to
 * "every check in the rollup is green".
 */
function requiredCheckNames(cwd: string): string[] | null {
  const repoInfo = ghJson<{ defaultBranchRef?: { name?: string } }>(cwd, ['repo', 'view', '--json', 'defaultBranchRef'], {});
  const defaultBranch = repoInfo.defaultBranchRef?.name ?? 'main';
  const rulesets = ghJson<Ruleset[]>(cwd, ['api', 'repos/{owner}/{repo}/rulesets'], []);
  for (const rs of rulesets) {
    const refs = rs.conditions?.ref_name?.include ?? [];
    const targetsDefault = refs.includes('~DEFAULT_BRANCH') || refs.includes(`refs/heads/${defaultBranch}`) || refs.includes(defaultBranch);
    if (!targetsDefault) continue;
    const rule = (rs.rules ?? []).find((r) => r.type === 'required_status_checks');
    if (!rule) continue;
    const names = (rule.parameters?.required_status_checks ?? []).map((c) => c.context).filter((n): n is string => Boolean(n));
    if (names.length) return names;
  }
  return null;
}

type Evaluation = { ok: boolean; missing: string[]; view: PRView; anyPending: boolean };

function evaluate(cwd: string, pr: number, rulesetChecks: string[] | null): Evaluation {
  const view = ghJson<PRView | null>(
    cwd,
    ['pr', 'view', String(pr), '--json', 'number,state,headRefName,body,labels,reviewDecision,mergeStateStatus,statusCheckRollup'],
    null,
  );
  if (!view) fail({ refused: `could not read PR #${pr} from gh.`, pr, missing: ['gh-pr-view'], rulesetChecks });

  const missing: string[] = [];
  if (view.state !== 'OPEN') missing.push(`state=${view.state}`);
  if (view.mergeStateStatus !== 'CLEAN') missing.push(`mergeStateStatus=${view.mergeStateStatus}`);
  const isDocs = hasLabel(view.labels, 'type:docs');
  const approved = hasLabel(view.labels, 'review:approved') || view.reviewDecision === 'APPROVED';
  if (!isDocs && !approved) missing.push('review:not-approved');

  const latest = latestChecksByName(view.statusCheckRollup ?? []);
  let anyPending = false;
  if (rulesetChecks) {
    for (const name of rulesetChecks) {
      const entry = latest.find((c) => (c.name ?? c.context) === name);
      const status = entry ? checkStatus(entry) : '';
      if (entry && PENDING.has(status)) anyPending = true;
      if (!entry || !GREEN.has(status)) missing.push(`checks:${name}=${entry ? status : 'missing'}`);
    }
  } else {
    if (latest.length === 0) missing.push('checks:none-registered');
    for (const entry of latest) {
      const status = checkStatus(entry);
      if (PENDING.has(status)) anyPending = true;
      if (!GREEN.has(status)) missing.push(`checks:${entry.name ?? entry.context ?? '?'}=${status}`);
    }
  }

  return { ok: missing.length === 0, missing, view, anyPending };
}

type WorktreeEntry = { path: string; branch: string | null };

function listWorktrees(cwd: string): WorktreeEntry[] {
  const out = git(cwd, ['worktree', 'list', '--porcelain']).stdout;
  return out
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => ({
      path: block.match(/^worktree\s+(.*)$/m)?.[1] ?? '',
      branch: block.match(/^branch\s+refs\/heads\/(.*)$/m)?.[1] ?? null,
    }));
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const prArg = rawArgs.find((a) => !a.startsWith('--'));
  const flags = parseArgs(rawArgs);
  const pr = Number(prArg);
  if (!prArg || !Number.isInteger(pr) || pr <= 0) {
    fail({ error: 'usage: node scripts/land.mts <pr> [--wait <seconds>]' });
  }
  const waitSeconds = typeof flags.wait === 'string' && Number.isFinite(Number(flags.wait)) ? Number(flags.wait) : 0;

  const cwd = repoRoot();
  const rulesetChecks = requiredCheckNames(cwd);

  let evaluation = evaluate(cwd, pr, rulesetChecks);
  const deadline = Date.now() + waitSeconds * 1000;
  while (WAITABLE_MERGE_STATUS.has(evaluation.view.mergeStateStatus) && evaluation.anyPending && Date.now() < deadline) {
    await sleep(AC2_POLL_MS);
    evaluation = evaluate(cwd, pr, rulesetChecks);
  }

  if (!evaluation.ok) {
    fail({
      refused: `PR #${pr} is not ready to merge: ${evaluation.missing.join(', ')}.`,
      pr,
      missing: evaluation.missing,
      rulesetChecks,
    });
  }

  const { headRefName, body } = evaluation.view;

  const mergeResult = gh(cwd, ['pr', 'merge', String(pr), '--squash', '--delete-branch']);
  if (mergeResult.status !== 0) {
    fail({ error: (mergeResult.stderr || mergeResult.stdout || 'gh pr merge failed').trim() });
  }

  // AC4: only once `gh pr view` reports state MERGED do we touch labels or worktrees.
  let mergedView: MergeView | null = null;
  for (let attempt = 0; attempt <= AC4_MAX_ATTEMPTS; attempt++) {
    const v = ghJson<MergeView | null>(cwd, ['pr', 'view', String(pr), '--json', 'state,mergeCommit'], null);
    if (v && v.state === 'MERGED') {
      mergedView = v;
      break;
    }
    if (attempt === AC4_MAX_ATTEMPTS) break;
    await sleep(AC4_POLL_MS);
  }
  if (!mergedView) {
    fail({ error: `PR #${pr}: gh pr merge succeeded but the PR never reached state MERGED.` });
  }

  const issues = parseLinkedIssues(body);
  for (const issueNumber of issues) {
    const issue = ghJson<{ labels?: Label[] }>(cwd, ['issue', 'view', String(issueNumber), '--json', 'labels'], {});
    const toRemove = (issue.labels ?? []).map((l) => l.name).filter((name) => name.startsWith('state:') && name !== 'state:done');
    const editArgs = ['issue', 'edit', String(issueNumber), '--add-label', 'state:done'];
    for (const name of toRemove) editArgs.push('--remove-label', name);
    const editResult = gh(cwd, editArgs);
    if (editResult.status !== 0) {
      console.error(`land: could not relabel issue #${issueNumber}: ${(editResult.stderr || editResult.stdout || '').trim()}`);
    }
  }

  const match = listWorktrees(cwd).find((w) => w.branch === headRefName);
  let worktreeRemoved: string | null = null;
  if (match) {
    const rm = git(cwd, ['worktree', 'remove', '--force', match.path]);
    if (rm.status === 0) {
      git(cwd, ['worktree', 'prune']);
      worktreeRemoved = match.path;
    } else {
      console.error(`land: could not remove worktree ${match.path}: ${(rm.stderr || '').trim()}`);
    }
  }

  console.log(JSON.stringify({ merged: mergedView.mergeCommit?.oid ?? null, pr, issues, worktreeRemoved }));
}

main().catch((err) => {
  console.log(JSON.stringify({ error: `land: unexpected error: ${err?.message ?? err}` }));
  process.exit(1);
});
