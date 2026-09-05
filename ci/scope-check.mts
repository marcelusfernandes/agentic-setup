#!/usr/bin/env node
// scope — the PR's diff must sit inside the union of the `## Files` globs
// of every issue it closes, plus whatever an `authorised:` line in the PR
// body grants. A PR links an issue with Closes/Fixes/Resolves (or their
// close/closed, fix/fixed, resolve/resolved forms), and may link several.
//
// In CI it reads the pull_request event (body, base, head), diffs with git
// and fetches each linked issue's body with `gh` (GH_TOKEN from the
// workflow). For a dry run, every input can come from flags instead:
//   --files-file <path>
//   --issue-body-file <path>[,<path>...]   (comma-separated, repeatable set)
//   --issue <N>[,<N>...]                   (pairs positionally with the files above)
//   --pr-body-file <path>
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from './lib/args.mts';
import { checkScope, collectLinkedGlobs, parseAuthorisedGlobs, parseLinkedIssues } from './lib/scope.mts';
import { appendSummary } from './lib/summary.mts';

const args = parseArgs(process.argv.slice(2));
const root = typeof args.root === 'string' ? args.root : process.cwd();

function fail(message: string): never {
  console.error(`scope: ${message}`);
  appendSummary(`## scope\n\n**FAILED** — ${message}`);
  process.exit(1);
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function gh(ghArgs: string[]): string {
  const r = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (r.status !== 0) fail(`gh ${ghArgs.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

function changedFiles(base: string, head: string): string[] {
  const r = spawnSync('git', ['diff', '--no-renames', '--name-only', `${base}...${head}`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) fail(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

const lines = (p: string): string[] => readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const splitList = (v: string | true | undefined): string[] =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const event = readEvent();

const files = typeof args['files-file'] === 'string'
  ? lines(args['files-file'])
  : changedFiles(
      String(args.base ?? event?.pull_request?.base?.sha ?? ''),
      String(args.head ?? event?.pull_request?.head?.sha ?? ''),
    );

const prBody = typeof args['pr-body-file'] === 'string'
  ? readFileSync(args['pr-body-file'], 'utf8')
  : String(event?.pull_request?.body ?? '');

const issueBodyFiles = splitList(args['issue-body-file']);
const explicitIssues = splitList(args.issue).map(Number);

let linked: Array<{ issue: number | null; body: string }>;
if (issueBodyFiles.length > 0) {
  const numbers = explicitIssues.length > 0 ? explicitIssues : parseLinkedIssues(prBody);
  linked = issueBodyFiles.map((path, i) => ({ issue: numbers[i] ?? null, body: readFileSync(path, 'utf8') }));
} else {
  const numbers = explicitIssues.length > 0 ? explicitIssues : parseLinkedIssues(prBody);
  if (numbers.length === 0) {
    fail('no "Closes #N", "Fixes #N" or "Resolves #N" in the PR body (and no --issue-body-file).');
  }
  linked = numbers.map((n) => ({ issue: n, body: gh(['issue', 'view', String(n), '--json', 'body', '-q', '.body']) }));
}

const linkedGlobs = collectLinkedGlobs(linked);
const issueGlobs = linkedGlobs.flatMap((g) => g.globs);
if (issueGlobs.length === 0) fail('the linked issue(s) declare no globs under `## Files`.');
const authorisedGlobs = parseAuthorisedGlobs(prBody);
const result = checkScope({ files, issueGlobs, authorisedGlobs });

console.log(JSON.stringify(result, null, 2));
appendSummary(
  [
    '## scope',
    '',
    result.ok ? `${files.length} file(s), all inside the linked issues' globs.` : '**FAILED** — outside the linked issues\' globs:',
    ...(result.ok ? [] : result.violations.map((f) => `- \`${f}\``)),
    '',
    'Globs by linked issue:',
    ...linkedGlobs.map(({ issue, globs }) => `- #${issue ?? '?'}: ${globs.length ? globs.map((g) => `\`${g}\``).join(', ') : '(none)'}`),
    ...(authorisedGlobs.length ? ['', `Authorised by the PR: ${authorisedGlobs.map((g) => `\`${g}\``).join(', ')}`] : []),
  ].join('\n'),
);
if (!result.ok) process.exit(1);
