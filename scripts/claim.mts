#!/usr/bin/env node
// claim — locks an issue in one step: push (the lock), then assign and
// relabel, only after the push succeeds. Replaces the three hand-typed
// commands in step 3 of skills/orchestrate/SKILL.md ("Claim").
//
//   node scripts/claim.mts <n> --slug <slug> [--type <type>]
//
// <type> comes from the title prefix ("feat(ci): …" -> feat) when --type is
// omitted; the set is feat|fix|refactor|chore|docs|test|ci|deps. Branch is
// <type>/<n>-<slug>.
//
// Exit codes:
//   0  claimed — prints { issue, branch, base }
//   1  refused (issue not claimable) -> { refused }
//      or a usage/gh/git error         -> { error }
//   2  held by another agent (the ref already exists) -> { held }
//
// Crash policy: never a stack trace. Refusal checks (closed, not
// state:ready, an open blocker, no ## Files bullet) run before any push, so
// a refusal changes nothing. The push is the lock: only a successful push
// is followed by `gh issue edit`. Run from the repository root — git
// commands use the current working directory. Node built-ins only.
import { spawnSync } from 'node:child_process';
import { parseArgs } from '../ci/lib/args.mts';
import { BRANCH_TYPES, hasFilesBullet, parseBlockedBy, titleType } from './lib/issues.mts';

type Label = { name: string };
type Issue = { number: number; title: string; body: string; labels: Label[]; state: string };
type RepoView = { defaultBranchRef: { name: string } | null };

function refuse(reason: string): never {
  console.log(JSON.stringify({ refused: reason }));
  process.exit(1);
}

function errorOut(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

function held(branch: string): never {
  console.log(JSON.stringify({ held: branch }));
  process.exit(2);
}

function firstLine(text: string): string {
  return (text || 'failed').trim().split('\n')[0] ?? 'failed';
}

function gh(args: string[]): string {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  if (r.status !== 0) errorOut(`gh ${args.join(' ')}: ${firstLine(r.stderr || r.stdout)}`);
  return r.stdout;
}

function ghJson<T>(args: string[]): T {
  const out = gh(args).trim();
  try {
    return JSON.parse(out) as T;
  } catch {
    errorOut(`gh ${args.join(' ')}: could not parse JSON output`);
  }
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) errorOut(`git ${args.join(' ')}: ${firstLine(r.stderr)}`);
  return r.stdout;
}

function hasLabel(labels: Label[] | undefined, name: string): boolean {
  return (labels ?? []).some((l) => l.name === name);
}

// --- 1. argv: <n> --slug <slug> [--type <type>] -----------------------------
const [numberArg, ...rest] = process.argv.slice(2);
const flags = parseArgs(rest);

if (!numberArg || !/^\d+$/.test(numberArg)) errorOut('issue number is required');
const number = Number(numberArg);

const slug = flags.slug;
if (typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug)) {
  errorOut('--slug is required and must match /^[a-z0-9-]+$/');
}

const explicitType = flags.type;
if (explicitType !== undefined) {
  if (typeof explicitType !== 'string' || !BRANCH_TYPES.includes(explicitType)) {
    errorOut(`invalid --type: ${String(explicitType)} (expected one of ${BRANCH_TYPES.join('|')})`);
  }
}

// --- 2. read the issue -------------------------------------------------------
const issue = ghJson<Issue>(['issue', 'view', String(number), '--json', 'number,title,body,labels,state,milestone']);

const type = typeof explicitType === 'string' ? explicitType : titleType(issue.title);
if (!type) errorOut('cannot determine type from title; pass --type');

// --- 3. refusal checks, before any push --------------------------------------
if (issue.state !== 'OPEN') refuse('issue is closed');
if (!hasLabel(issue.labels, 'state:ready')) refuse('missing state:ready label');

for (const blocker of parseBlockedBy(issue.body ?? '')) {
  const blockerIssue = ghJson<{ state: string }>(['issue', 'view', String(blocker), '--json', 'state']);
  if (blockerIssue.state === 'OPEN') refuse(`blocked by #${blocker} (still open)`);
}

if (!hasFilesBullet(issue.body ?? '')) refuse('missing ## Files section');

// --- 4. lock: fetch, then push the new branch from the default branch -------
const branch = `${type}/${number}-${slug}`;

const repoView = ghJson<RepoView>(['repo', 'view', '--json', 'defaultBranchRef']);
const defaultBranch = repoView.defaultBranchRef?.name;
if (!defaultBranch) errorOut('gh repo view: no default branch');

git(['fetch', 'origin']);

// Pushing the exact commit an existing ref already points at is a silent
// no-op success ("Everything up-to-date"), not a rejection — so a race
// between two claims of the same issue, before the implementer has added
// any commit, would not be caught by inspecting the push result alone.
// `git fetch` above just populated this remote-tracking ref if the branch
// exists on origin at all, so check it first.
const existing = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { encoding: 'utf8' });
if (existing.status === 0) held(branch);

const base = git(['rev-parse', `origin/${defaultBranch}`]).trim();

const push = spawnSync('git', ['push', 'origin', `origin/${defaultBranch}:refs/heads/${branch}`], { encoding: 'utf8' });
if (push.status !== 0) {
  const output = `${push.stderr || ''}${push.stdout || ''}`;
  // A diverged remote branch (the implementer already committed) is
  // rejected as non-fast-forward, not "already exists" — either message
  // means someone else holds the ref; anything else is a real error.
  if (/\[rejected\]/.test(output) || /already exists/i.test(output)) held(branch);
  errorOut(firstLine(output));
}

// --- 5. only now: assign and relabel ----------------------------------------
gh(['issue', 'edit', String(number), '--add-assignee', '@me', '--add-label', 'state:in-progress', '--remove-label', 'state:ready']);

console.log(JSON.stringify({ issue: number, branch, base }));
