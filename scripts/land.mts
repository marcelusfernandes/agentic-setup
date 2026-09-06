#!/usr/bin/env node
// land — the only way the orchestrator merges a PR: asks the server to
// merge when it can, and nothing else (#63). `gh pr merge --auto` merges
// the instant GitHub's own rules are satisfied, so there is no client-side
// read (rulesets, rollup dedupe, --wait polling) that can go stale between
// being taken and the merge happening (#25's incident by construction).
// `Closes #N` closes the linked issue when the PR merges — closed is done,
// nothing left here to relabel. The worktree becomes an orphan once GitHub
// deletes the branch on merge (delete_branch_on_merge, init-enabled;
// --delete-branch below is inert under --auto until then); the next claim
// already removes orphaned worktrees.
//
//   node scripts/land.mts <pr>
//
// Refuses (exit 1, { refused, pr, missing }) unless OPEN and approved (or
// type:docs). Then gate='ruleset' iff the PR base branch's *effective*
// rules (`gh api repos/{owner}/{repo}/rules/branches/<baseRefName>`,
// flattened and enforcement-aware -- unlike the ruleset *list*, summaries
// only, which cannot tell a required_status_checks ruleset from a
// deletion-only one) include a required_status_checks rule. Otherwise runs
// `gh pr checks <pr> --required`, refusing if it is red/pending: the
// fallback for a branch with no such rule, where `--auto` alone would
// queue an ungated merge.
//
// On success: `gh pr merge <pr> --squash --delete-branch --auto` (never
// --admin); prints { queued: pr, gate }. If that fails (e.g. auto-merge
// disabled), prints { error } with gh's message, exit 1. No polling, no
// relabel, no worktree removal either way.
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
const approved = hasLabel(view.labels, 'review:approved') || view.reviewDecision === 'APPROVED';
if (!isDocs && !approved) missing.push('review:not-approved');
if (missing.length) fail({ refused: `PR #${pr} is not ready to merge: ${missing.join(', ')}.`, pr, missing });

const rules = ghJson<Array<{ type?: string }>>(['api', `repos/{owner}/{repo}/rules/branches/${view.baseRefName}`], []);
const gate: 'ruleset' | 'client-checks' = rules.some((r) => r.type === 'required_status_checks') ? 'ruleset' : 'client-checks';

if (gate === 'client-checks' && gh(['pr', 'checks', String(pr), '--required']).status !== 0) {
  fail({ refused: `PR #${pr}: required checks are not green.`, pr, missing: ['checks:required'], gate });
}

const mergeResult = gh(['pr', 'merge', String(pr), '--squash', '--delete-branch', '--auto']);
if (mergeResult.status !== 0) {
  fail({ error: (mergeResult.stderr || mergeResult.stdout || 'gh pr merge failed').trim() });
}

console.log(JSON.stringify({ queued: pr, gate }));
