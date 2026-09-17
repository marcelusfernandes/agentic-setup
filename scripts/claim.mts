#!/usr/bin/env node
// claim — locks an issue in one step: push (the lock), then assign and
// relabel, only after the push succeeds. Replaces the three hand-typed
// commands in step 3 of skills/orchestrate/SKILL.md ("Claim").
//
// The relabel writes `type:` as well as `state:`: the orchestrator owns the
// `type:` label, mapped from the branch type through TYPE_LABELS in
// scripts/lib/issues.mts (feat -> type:feature, fix -> type:bug; chore,
// test and ci all -> type:infra). The implementer no longer labels its own
// PR with it; the orchestrator copies `type:` and `scope:` across at step 4.
// Claim time is where the derived label takes over from whatever the
// planner seeded: any other `type:` label the issue already carries is
// removed in the same edit, so the issue never holds two of them.
//
//   node scripts/claim.mts <n> --slug <slug> [--type <type>] [--no-lint]
//
// <type> comes from the title prefix ("feat(ci): …" -> feat) when --type is
// omitted; the set is feat|fix|refactor|chore|docs|test|ci|deps. Branch is
// <type>/<n>-<slug>. --no-lint controls the ci/issue-lint.mts gate below.
//
// Exit codes:
//   0  claimed — prints { issue, branch, base, lint }
//   1  refused (issue not claimable) -> { refused }
//      or a usage/gh/git error         -> { error }
//   2  held by another agent (a branch that locks the issue already
//      exists) -> { held: "<that branch>" }
//
// Two things hold an issue, in namespaces that cannot see each other: this
// route's own `<type>/<n>-<slug>` and the Codex loop's `codex/task-<n>`
// (scripts/lib/issues.mts names both shapes, and is the only place either
// is written down). So before the push there is one read — `git ls-remote
// --heads origin`, asking the remote rather than the local tracking refs —
// and any branch it finds that locks the issue is reported as { held }
// without pushing anything. That read fails closed: when it errors the
// claim exits 1 with { error } naming it, never assuming the issue is
// free (#157).
//
// The read is an early refusal, not the lock. The lock is the push's own
// protocol exchange with the remote, read via
// `git push --porcelain`, not a local pre-check: a local
// refs/remotes/origin/<branch> pre-check has two failure modes — (a)
// pushing the exact commit a ref already points at is a silent no-op
// success ("Everything up-to-date", exit 0), so a race between two claims
// before either has committed anything is missed if only the push's exit
// code is inspected; (b) `git fetch` never prunes, while the repository
// setting `delete_branch_on_merge` (enabled by `init`) deletes branches
// server-side on merge, so a stale local tracking ref can report `held`
// for a branch that is actually free. The
// porcelain summary line is authoritative either way: `*` (new branch) is
// success, `=` (up to date) is `held`; on a non-zero exit, `[rejected]` /
// "already exists" / "cannot lock ref" also mean `held`; anything else is
// a real `{ error }`. The push itself is create-only
// (`--force-with-lease=refs/heads/<branch>:`, an empty expected value):
// without it, a branch that already exists at an ancestor of `base`
// (claimed earlier; the default branch has since advanced) would
// fast-forward — { held } would still be reported correctly, but the push
// would have already moved the other agent's ref. With the lease, any
// existing branch other than an exact match (`=`) is instead rejected as
// `(stale info)` — the lease check runs before git would otherwise decide
// non-fast-forward, so that wording never appears here — still caught by
// the `[rejected]` fallback.
//
// Crash policy: never a stack trace, and every read that cannot answer
// fails closed. Refusal checks (closed, not state:ready, an open blocker,
// no ## Files bullet, issue-lint) and the pre-push lock read run before any
// push, so a refusal — including a `git ls-remote` that errors — changes
// nothing. The push is the lock: only a
// successful push is followed by `gh issue edit` (assignee, `state:` and
// `type:`, plus the removal of any disagreeing `type:`). Run from the repository
// root — git commands use the current working directory. Node built-ins
// only.
//
// issue-lint gate: the last refusal check before the lock read and the
// push (a lock read that finds a branch reports `{ held }`, exit 2, which
// is not a refusal but the other agent's claim). ci/issue-lint.mts
// is resolved relative to this file's own location (not a hard-coded
// relative path from the caller's cwd) and spawned with `process.execPath`
// — the same node/bun running this script — with `cwd` left at this
// process's own (the repository root, same as every other git/gh call
// here). `--no-lint` skips the check entirely (`"lint": "skipped"` in the
// success JSON). A lint result that isn't `ok: true` — a normal failure, or
// the lint's own `{ error }` shape when it could not even run — refuses the
// claim either way: fail closed rather than let an unreadable lint result
// through. issue-lint itself dropped its `--strict` flag and the
// entry-point-reference warnings it gated, because that check could not
// tell a rename from an in-place edit (#62); claim has nothing left to pass
// through, so a successful lint is reported simply as `{ ok: true }`.
//
// Note: titleType() is case-sensitive ("Feat: x" falls through to
// "pass --type"); the issue is silent on case, so this is left as-is.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../ci/lib/args.mts';
import { BRANCH_TYPES, hasFilesBullet, lockBranches, parseBlockedBy, titleType, typeLabel } from './lib/issues.mts';

type Label = { name: string };
type Issue = { number: number; title: string; body: string; labels: Label[]; state: string };
type RepoView = { defaultBranchRef: { name: string } | null };

function refuse(reason: string): never {
  console.log(JSON.stringify({ refused: reason }));
  process.exit(1);
}

function refuseLint(lint: unknown): never {
  console.log(JSON.stringify({ refused: 'issue-lint failed', lint }));
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

// Gate labels by exact name, case-insensitive: `human:pending`, or the bare
// `human` that predates the two states. `human:decided` records a past
// decision and never gates, so no prefix match.
const PENDING_HUMAN = new Set(['human', 'human:pending']);
function pendingHumanLabel(labels: Label[] | undefined): string | null {
  return (labels ?? []).find((l) => PENDING_HUMAN.has(l.name.toLowerCase()))?.name ?? null;
}

// --- 1. argv: <n> --slug <slug> [--type <type>] [--no-lint] -----------------
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
const pendingHuman = pendingHumanLabel(issue.labels);
if (pendingHuman) refuse(`issue carries ${pendingHuman}`);

for (const blocker of parseBlockedBy(issue.body ?? '')) {
  const blockerIssue = ghJson<{ state: string }>(['issue', 'view', String(blocker), '--json', 'state']);
  if (blockerIssue.state === 'OPEN') refuse(`blocked by #${blocker} (still open)`);
}

if (!hasFilesBullet(issue.body ?? '')) refuse('missing ## Files section');

// --- 4. issue-lint gate, the last refusal check before the push -------------
type LintField = 'skipped' | { ok: true };

const skipLint = flags['no-lint'] === true || flags['no-lint'] === 'true';

let lintField: LintField;
if (skipLint) {
  lintField = 'skipped';
} else {
  const lintScript = fileURLToPath(new URL('../ci/issue-lint.mts', import.meta.url));
  const lintRun = spawnSync(process.execPath, [lintScript, String(number)], { encoding: 'utf8' });
  if (lintRun.error) errorOut(`issue-lint: ${lintRun.error.message}`);

  let lintResult: any;
  try {
    lintResult = JSON.parse((lintRun.stdout || '').trim());
  } catch {
    errorOut(`issue-lint: could not parse output: ${firstLine(lintRun.stderr || lintRun.stdout || 'failed')}`);
  }

  // Fail closed: anything other than an explicit `ok: true` refuses the
  // claim — a normal lint failure (`ok: false`) and the lint's own
  // `{ error }` shape (it could not even run) are refused the same way.
  if (!lintResult || lintResult.ok !== true) refuseLint(lintResult);

  lintField = { ok: true };
}

// --- 5. lock: fetch, read the locks already on the remote, then push the ----
// new branch from the default branch ----------------------------------------
const branch = `${type}/${number}-${slug}`;

const repoView = ghJson<RepoView>(['repo', 'view', '--json', 'defaultBranchRef']);
const defaultBranch = repoView.defaultBranchRef?.name;
if (!defaultBranch) errorOut('gh repo view: no default branch');

git(['fetch', 'origin']);

const base = git(['rev-parse', `origin/${defaultBranch}`]).trim();

// Pre-push read: any branch that already locks this issue, in either
// route's namespace (`scripts/lib/issues.mts` is the single place those
// shapes are written down). The Codex loop locks `codex/task-<n>`, which
// this script would never push and never collide with, so nothing but a
// read can find it. `git ls-remote` asks the remote itself rather than the
// local tracking refs, which `git fetch` never prunes and a narrowed fetch
// refspec may never have created. It fails closed: a read that errors goes
// through `git()` and exits 1 with `{ error }` naming the failed command,
// never on to the push.
//
// This is an early refusal, not the lock. Two Claude-route agents racing
// for the same issue can both read a free remote and then push; what
// decides that race is still the create-only push below, for the reasons
// the header gives. The read is what catches every lock the push cannot:
// the other route's branch, and this route's own under a different slug.
const existingLock = lockBranches(
  number,
  git(['ls-remote', '--heads', 'origin'])
    .split('\n')
    .map((line) => line.trim().split('\t')[1] ?? '')
    .filter(Boolean)
    .map((ref) => ref.replace(/^refs\/heads\//, '')),
)[0];
if (existingLock) held(existingLock);

// --force-with-lease=<ref>: (empty expected value) means the named ref
// must not already exist — the create-only form (git-push(1)). Without it,
// a branch that already exists at an ancestor of `base` (claimed earlier;
// the default branch has since advanced — the loop's normal state) would
// fast-forward: exit 0, so { held } is still reported correctly (the
// porcelain flag isn't "*"), but the push would have already moved the
// other agent's ref. With the lease, that case is instead rejected as
// "(stale info)", caught by the `[rejected]` fallback below. It does not
// cover the up-to-date case: git no-ops a same-commit push client-side
// before any lease is checked, so the "=" branch above stays load-bearing.
const push = spawnSync(
  'git',
  ['push', '--porcelain', `--force-with-lease=refs/heads/${branch}:`, 'origin', `origin/${defaultBranch}:refs/heads/${branch}`],
  { encoding: 'utf8' },
);
const dataLine = (push.stdout || '').split(/\r?\n/).find((l) => /^[*=!+\- ]\t/.test(l)) ?? '';

if (push.status === 0) {
  // The porcelain summary line is authoritative: "*" means this push
  // created the ref (a genuine claim); "=" ("up to date") means the ref
  // already pointed at this exact commit, so someone else already holds
  // it — a silent no-op success, not a rejection.
  if (!dataLine.startsWith('*')) held(branch);
} else {
  const output = `${push.stdout || ''}${push.stderr || ''}`;
  // Any pre-existing branch other than an exact match (the "=" success
  // branch above) is rejected by the lease as "(stale info)" — an
  // ancestor, a diverged branch with real commits, or a locking race all
  // land here, never as "non-fast-forward" (the lease is checked first)
  // or "already exists" (that literal wording is git's for tags, not
  // branches; kept as a fallback regardless). Any of these means someone
  // else holds the ref; anything else is a real error. Build the message
  // from the "!" data line, not the porcelain output's first line
  // ("To <url>").
  if (/\[rejected\]/.test(output) || /already exists/i.test(output) || /cannot lock ref/i.test(output)) held(branch);
  errorOut(dataLine ? dataLine.replace(/\t/g, ' ').trim() : firstLine(push.stderr || push.stdout || 'push failed'));
}

// --- 6. only now: assign and relabel ----------------------------------------
// The `type:` label rides on the same edit as the state change: the
// orchestrator owns it, so no agent ever labels its own work (#135). The
// branch type maps through TYPE_LABELS; `typeLabel` is nullable for an
// arbitrary string, but `type` was validated against BRANCH_TYPES above
// (or derived by `titleType`, which only returns a BRANCH_TYPES member),
// and every BRANCH_TYPES value has a label — so the check below is a real
// invariant that never fires on the validated path, not a fallback for a
// case the mapping allows. It reports through errorOut like every other
// failure here: never a stack trace (#213).
//
// Whoever opened the issue may have seeded a `type:` label of their own,
// and claim time is when the derived one takes over: every `type:` label
// the issue currently carries other than the derived one is removed in
// this same edit, so the issue is never left holding two with no record of
// which the orchestrator meant. A seeded label that already agrees is left
// alone — `--remove-label X --add-label X` in one edit has no defined
// outcome and could strip the label this step exists to write.
const label = typeLabel(type);
if (!label) errorOut(`no type: label for branch type ${type}`);

const staleTypeLabels = (issue.labels ?? [])
  .map((l) => l.name)
  .filter((name) => name.startsWith('type:') && name !== label);

gh([
  'issue', 'edit', String(number),
  '--add-assignee', '@me',
  '--add-label', 'state:in-progress',
  '--add-label', label,
  ...staleTypeLabels.flatMap((name) => ['--remove-label', name]),
  '--remove-label', 'state:ready',
]);

console.log(JSON.stringify({ issue: number, branch, base, lint: lintField }));
