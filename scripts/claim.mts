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
// The lock is the push's own protocol exchange with the remote, read via
// `git push --porcelain`, not a local pre-check: a local
// refs/remotes/origin/<branch> pre-check has two failure modes — (a)
// pushing the exact commit a ref already points at is a silent no-op
// success ("Everything up-to-date", exit 0), so a race between two claims
// before either has committed anything is missed if only the push's exit
// code is inspected; (b) `git fetch` never prunes, while `gh pr merge
// --delete-branch` deletes branches server-side, so a stale local
// tracking ref can report `held` for a branch that is actually free. The
// porcelain summary line is authoritative either way: `*` (new branch) is
// success, `=` (up to date) is `held`; on a non-zero exit, `[rejected]` /
// "already exists" / "cannot lock ref" also mean `held` (a diverged
// branch — the implementer already committed — is rejected as
// non-fast-forward, not "already exists"; that literal wording is git's
// for tags, not branches); anything else is a real `{ error }`.
//
// Crash policy: never a stack trace. Refusal checks (closed, not
// state:ready, an open blocker, no ## Files bullet) run before any push, so
// a refusal changes nothing. The push is the lock: only a successful push
// is followed by `gh issue edit`. Run from the repository root — git
// commands use the current working directory. Node built-ins only.
//
// Note: titleType() is case-sensitive ("Feat: x" falls through to
// "pass --type"); the issue is silent on case, so this is left as-is.
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

const base = git(['rev-parse', `origin/${defaultBranch}`]).trim();

const push = spawnSync('git', ['push', '--porcelain', 'origin', `origin/${defaultBranch}:refs/heads/${branch}`], { encoding: 'utf8' });
const dataLine = (push.stdout || '').split(/\r?\n/).find((l) => /^[*=!+\- ]\t/.test(l)) ?? '';

if (push.status === 0) {
  // The porcelain summary line is authoritative: "*" means this push
  // created the ref (a genuine claim); "=" ("up to date") means the ref
  // already pointed at this exact commit, so someone else already holds
  // it — a silent no-op success, not a rejection.
  if (!dataLine.startsWith('*')) held(branch);
} else {
  const output = `${push.stdout || ''}${push.stderr || ''}`;
  // A diverged remote branch (the implementer already committed) is
  // rejected as non-fast-forward, not "already exists" — either message
  // (or a ref-locking race) means someone else holds the ref; anything
  // else is a real error. Build the message from the "!" data line, not
  // the porcelain output's first line ("To <url>").
  if (/\[rejected\]/.test(output) || /already exists/i.test(output) || /cannot lock ref/i.test(output)) held(branch);
  errorOut(dataLine ? dataLine.replace(/\t/g, ' ').trim() : firstLine(push.stderr || push.stdout || 'push failed'));
}

// --- 5. only now: assign and relabel ----------------------------------------
gh(['issue', 'edit', String(number), '--add-assignee', '@me', '--add-label', 'state:in-progress', '--remove-label', 'state:ready']);

console.log(JSON.stringify({ issue: number, branch, base }));
