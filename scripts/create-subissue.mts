#!/usr/bin/env node
// create-subissue — creates a sub-issue, links it to its parent by id,
// inherits the parent's milestone, and applies `state:ready` only once
// `ci/issue-lint.mts` reports `ok: true` for the new issue (#173).
//
//   node scripts/create-subissue.mts <parent> --title <t> --body-file <path> \
//     [--label <l>]...
//
// This replaces the three-line snippet the planner used to copy by hand
// (`docs/workflow.md`, `skills/issue-and-pr/SKILL.md`, "Write sub-issues"):
// GitHub's sub-issue API wants the issue **id**, not the number, so the
// snippet's middle line resolved one from the other and a mistyped
// `-F sub_issue_id` produced a child that lints and dispatches while
// nothing ties it to the phase it belongs to. It was also the last
// mutating GitHub step with no refusal path beside the milestone close —
// the shape item 11 of `docs/decisions.md` rules out.
//
// **Crash policy: fail closed.** Nothing is created unless every check
// passes first. The two local checks (the title's shape, the body file's
// readability) run before `gh` is called at all; the parent is then read
// once, and only an open parent that carries a milestone is written under.
// A `gh` call that fails for any reason other than a 404 on the parent — a
// network error, a rate limit, a token problem — is reported as
// `{ error }` and exits 1 without creating anything; it is never reported
// as a refusal, because it is not a verdict on the sub-issue. A response
// that does not parse is treated the same way.
//
// Past the creation there is no undo: if the id lookup or the link POST
// then fails, the issue exists and is reported as `{ error, issue }` (exit
// 1) so the number is never lost — it is left without `state:ready`, which
// is what keeps it out of `reconcile`'s `ready` list until a person or a
// re-run finishes the link. The same holds for the lint: anything other
// than an explicit `ok: true` — a normal failure, or the lint's own
// `{ error }` shape when it could not even run — leaves the issue created,
// linked and not ready, and exits 1.
//
// `state:ready` is never passed at creation time, even when the caller
// lists it in `--label`: the lint is the only thing that applies it, and
// applying it last is what makes the gate real.
//
// Exit 1 with `{ refused, parent, missing }` when the parent does not
// exist or is closed (`parent:state`), the parent carries no milestone
// (`parent:milestone`), the title does not match
// `^(feat|fix|…)\([a-z]+\): .+` — the same set `scripts/claim.mts` derives a
// branch type from (`scripts/lib/issues.mts`, BRANCH_TYPES) — (`title:format`),
// or `--body-file` is missing or unreadable (`body:missing`).
// Exit 1 with `{ error }` on a usage problem or a `gh`/filesystem failure.
// Exit 0 with `{ issue, parent, milestone, linked: true, lint }`.
//
// Note on the lint field: a passing lint is reported as exactly
// `{ ok: true }`, as `scripts/claim.mts` does — there is nothing else in a
// clean result a caller acts on — while a failing one is forwarded whole,
// because its `failures` are the reason the issue is not ready.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRANCH_TYPES } from './lib/issues.mts';

/** The title shape an issue must have for claim.mts to derive a branch from it. */
const TITLE = new RegExp(`^(${BRANCH_TYPES.join('|')})\\([a-z]+\\): .+`);
/** Applied by this script alone, after the lint passes — never at creation. */
const READY = 'state:ready';
const USAGE = 'usage: node scripts/create-subissue.mts <parent> --title <t> --body-file <path> [--label <l>]...';

function out(shape: Record<string, unknown>, code: number): never {
  console.log(JSON.stringify(shape));
  process.exit(code);
}
function fail(shape: Record<string, unknown>): never {
  out(shape, 1);
}

type Run = { status: number; stdout: string; stderr: string };
const gh = (args: string[]): Run => {
  const r = spawnSync('gh', args, { encoding: 'utf8' });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/** The first line of whatever `gh` said, so an error is one line of JSON. */
const why = (r: Run): string => (r.stderr || r.stdout || 'gh failed').trim().split('\n')[0] ?? 'gh failed';

/** JSON.parse that answers null instead of throwing, so every caller fails closed the same way. */
function safeParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** gh's own wording when the resource is not there, as opposed to any other failure. */
const isNotFound = (r: Run): boolean => /HTTP 404|Not Found \(HTTP/.test(r.stderr);

type Args = { parent: number; title: string; bodyFile: string | null; labels: string[] };

/** Splits argv into the parent, the two single flags and the repeatable `--label`, or null on a usage problem. */
function parseArgs(argv: string[]): Args | null {
  const positional: string[] = [];
  let title = '';
  let bodyFile: string | null = null;
  const labels: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--title' || a === '--body-file' || a === '--label') {
      const value = argv[i + 1];
      if (value === undefined) return null;
      if (a === '--title') title = value;
      else if (a === '--body-file') bodyFile = value;
      else labels.push(value);
      i++;
      continue;
    }
    if (a.startsWith('--')) return null;
    positional.push(a);
  }
  if (positional.length !== 1) return null;
  const parent = Number(positional[0]);
  if (!Number.isInteger(parent) || parent <= 0) return null;
  return { parent, title, bodyFile, labels };
}

/** Whether the path names a file this process can read; the content itself is gh's to send. */
function readable(path: string | null): boolean {
  if (path === null) return false;
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}

const args = parseArgs(process.argv.slice(2));
if (!args) fail({ error: USAGE });

// --- 1. local refusal checks, before `gh` is called at all -------------------
const missing: string[] = [];
if (!TITLE.test(args.title)) missing.push('title:format');
if (!readable(args.bodyFile)) missing.push('body:missing');
if (missing.length) {
  fail({ refused: `not created: ${missing.join(', ')}.`, parent: args.parent, missing });
}

// --- 2. the parent, read once, before anything is created -------------------
// REST rather than `gh issue view`: `state` and `milestone` come from the
// same API the sub-issue POST below expects.
const parentRead = gh(['api', `repos/{owner}/{repo}/issues/${args.parent}`]);
if (parentRead.status !== 0) {
  if (!isNotFound(parentRead)) fail({ error: why(parentRead) });
  fail({
    refused: `issue #${args.parent} does not exist.`,
    parent: args.parent,
    missing: ['parent:state'],
  });
}

const parent = safeParse<{ state?: unknown; milestone?: { title?: unknown } | null }>(parentRead.stdout);
if (!parent) fail({ error: `could not parse gh's answer for issue #${args.parent}.` });

const parentState = String(parent.state ?? '');
const milestone = typeof parent.milestone?.title === 'string' ? parent.milestone.title : null;
if (parentState !== 'open') missing.push('parent:state');
if (milestone === null || milestone.trim() === '') missing.push('parent:milestone');
if (missing.length) {
  const reasons = [
    missing.includes('parent:state') ? `is ${parentState || 'in an unknown state'}, not open` : '',
    missing.includes('parent:milestone') ? 'carries no milestone' : '',
  ].filter(Boolean);
  fail({ refused: `issue #${args.parent} ${reasons.join(' and ')}.`, parent: args.parent, missing });
}

// --- 3. create the issue: the parent's milestone, the caller's labels -------
// `state:ready` is dropped here whatever the caller passed: step 5 is the
// only thing that applies it.
const labels = args.labels.filter((l) => l.trim().toLowerCase() !== READY);
const createArgs = [
  'issue',
  'create',
  '--title',
  args.title,
  '--body-file',
  String(args.bodyFile),
  '--milestone',
  String(milestone),
  ...labels.flatMap((l) => ['--label', l]),
];
const created = gh(createArgs);
if (created.status !== 0) fail({ error: why(created) });

// `gh issue create` prints the new issue's URL; the number is its last path segment.
const issue = Number(
  created.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.match(/\/(\d+)$/)?.[1])
    .filter((n): n is string => n !== undefined)
    .pop() ?? '',
);
if (!Number.isInteger(issue) || issue <= 0) {
  fail({ error: `could not read the new issue's number from gh: ${created.stdout.trim() || '(no output)'}` });
}

// --- 4. link it to the parent, by id ----------------------------------------
// The sub-issue API takes the child's REST `id`, not its number, which is
// why this lookup exists at all.
const idRead = gh(['api', `repos/{owner}/{repo}/issues/${issue}`, '-q', '.id']);
if (idRead.status !== 0) fail({ error: why(idRead), issue });
const id = Number(idRead.stdout.trim());
if (!Number.isInteger(id) || id <= 0) {
  fail({ error: `could not read issue #${issue}'s id from gh: ${idRead.stdout.trim() || '(no output)'}`, issue });
}

const linked = gh([
  'api',
  '-X',
  'POST',
  `repos/{owner}/{repo}/issues/${args.parent}/sub_issues`,
  '-F',
  `sub_issue_id=${id}`,
]);
if (linked.status !== 0) fail({ error: why(linked), issue });

// --- 5. the lint gate: `state:ready` only on `ok: true` ---------------------
// ci/issue-lint.mts is resolved relative to this file (not the caller's
// cwd) and spawned with the same runtime as this script, its cwd left at
// this process's own — the repository root, as for every gh call above.
const lintScript = fileURLToPath(new URL('../ci/issue-lint.mts', import.meta.url));
const lintRun = spawnSync(process.execPath, [lintScript, String(issue)], { encoding: 'utf8' });
const lint: Record<string, unknown> = lintRun.error
  ? { error: `issue-lint: ${lintRun.error.message}` }
  : (safeParse<Record<string, unknown>>((lintRun.stdout || '').trim()) ??
    { error: `issue-lint: could not parse output: ${(lintRun.stderr || lintRun.stdout || 'failed').trim().split('\n')[0]}` });

const report = { issue, parent: args.parent, milestone, linked: true };
if (lint.ok !== true) out({ ...report, lint }, 1);

const ready = gh(['issue', 'edit', String(issue), '--add-label', READY]);
if (ready.status !== 0) fail({ error: why(ready), issue });

out({ ...report, lint: { ok: true } }, 0);
