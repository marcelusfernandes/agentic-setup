#!/usr/bin/env node
// scope — the PR's diff must sit inside the union of the `## Files` globs
// of every issue it closes, plus whatever an `authorised:` line in the PR
// body grants. A PR links an issue with Closes/Fixes/Resolves (or their
// close/closed, fix/fixed, resolve/resolved forms), and may link several.
//
// It also fails a PR that deletes or renames a tracked path still named by
// another tracked file outside the diff (#51) — the #3 shape: a path drops
// out from under a reference nobody updated. Undecidable at issue-lint time
// (no diff exists yet to tell a rename from an in-place edit — see
// issue-lint.mts's header); decidable here, where the diff is known. A
// dangling reference is not a failure when the referencing file sits inside
// the linked issue's globs (the PR is expected to touch it, or the reviewer
// sees it in the diff) or is granted by an `authorised:` line.
//
// In CI it reads the pull_request event (body, base, head), diffs with git
// and fetches each linked issue's body with `gh` (GH_TOKEN from the
// workflow). For a dry run, every input can come from flags instead:
//   --files-file <path>
//   --removed-file <path>                  (one deleted/renamed-from path per line)
//   --issue-body-file <path>[,<path>...]   (comma-separated, repeatable set)
//   --issue <N>[,<N>...]                   (pairs positionally with the files above)
//   --pr-body-file <path>
//
// The dangling-reference check runs one `git grep -F` per removed/renamed
// path against the tracked tree (few paths per PR; no batching needed),
// excluding lockfiles and docs/research/** (noise, not contract), then
// drops any hit that is itself part of the diff. A basename under 4
// characters is too common to search on its own and is skipped, leaving
// just the full-path pattern.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from './lib/args.mts';
import { checkScope, collectLinkedGlobs, findMisplacedAuthorisedLines, parseAuthorisedGlobs, parseLinkedIssues } from './lib/scope.mts';
import { matchesAny } from './lib/globs.mts';
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

// The deleted paths and the "from" side of every rename in the PR's diff —
// the paths that stop existing at head. `--find-renames` (unlike
// `changedFiles`'s `--no-renames`) is what turns a delete+add pair back
// into a single `R<score>\t<from>\t<to>` line so the "from" path is
// recoverable at all.
function removedPaths(base: string, head: string): string[] {
  const r = spawnSync('git', ['diff', '--name-status', '--find-renames', `${base}...${head}`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) fail(`git diff failed: ${r.stderr.trim()}`);
  const out: string[] = [];
  for (const raw of r.stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const cols = line.split('\t');
    const status = cols[0] ?? '';
    if (status === 'D' || status.startsWith('R')) out.push(cols[1]);
  }
  return out.filter(Boolean);
}

const LOCKFILE_EXCLUDES = [
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb',
  'Cargo.lock', 'Gemfile.lock', 'poetry.lock', 'uv.lock', 'composer.lock', 'Pipfile.lock', 'mix.lock',
];
const MIN_BASENAME_LENGTH = 4;

function basenameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Every tracked file (excluding lockfiles and docs/research/**) whose
 * content literally names `removedPath` or its basename. */
function grepReferences(removedPath: string): string[] {
  const basename = basenameOf(removedPath);
  const patterns = ['-e', removedPath];
  if (basename !== removedPath && basename.length >= MIN_BASENAME_LENGTH) patterns.push('-e', basename);
  const pathspecs = ['.', ...LOCKFILE_EXCLUDES.map((g) => `:!${g}`), ':!docs/research/**'];
  const r = spawnSync('git', ['grep', '-l', '-F', ...patterns, '--', ...pathspecs], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 && r.status !== 1) fail(`git grep failed for ${removedPath}: ${r.stderr.trim()}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

type DanglingRef = { removed: string; referencedBy: string };

/** A hit is dangling unless it sits inside the diff itself (git grep runs
 * over the whole tree, then this drops what the diff already covers) or is
 * covered by the linked issue's globs / an `authorised:` grant. */
function danglingReferences(removed: string[], diffFiles: string[], globs: string[]): DanglingRef[] {
  const inDiff = new Set(diffFiles);
  const out: DanglingRef[] = [];
  for (const removedPath of removed) {
    for (const referencedBy of grepReferences(removedPath)) {
      if (inDiff.has(referencedBy)) continue;
      if (matchesAny(referencedBy, globs)) continue;
      out.push({ removed: removedPath, referencedBy });
    }
  }
  return out;
}

const lines = (p: string): string[] => readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
const splitList = (v: string | true | undefined): string[] =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];

const event = readEvent();
const baseRef = String(args.base ?? event?.pull_request?.base?.sha ?? '');
const headRef = String(args.head ?? event?.pull_request?.head?.sha ?? '');

const files = typeof args['files-file'] === 'string'
  ? lines(args['files-file'])
  : changedFiles(baseRef, headRef);

const removed = typeof args['removed-file'] === 'string'
  ? lines(args['removed-file'])
  : baseRef && headRef ? removedPaths(baseRef, headRef) : [];

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
const dangling = danglingReferences(removed, files, [...issueGlobs, ...authorisedGlobs]);
const ok = result.ok && dangling.length === 0;
// A grant written outside ## Files never reaches parseAuthorisedGlobs, so
// it silently doesn't count; only worth surfacing once the check actually
// fails on something it might have covered.
const misplacedAuthorised = ok ? [] : findMisplacedAuthorisedLines(prBody);

console.log(JSON.stringify({ ...result, ok, danglingReferences: dangling, ...(misplacedAuthorised.length ? { misplacedAuthorised } : {}) }, null, 2));
appendSummary(
  [
    '## scope',
    '',
    result.ok ? `${files.length} file(s), all inside the linked issues' globs.` : '**FAILED** — outside the linked issues\' globs:',
    ...(result.ok ? [] : result.violations.map((f) => `- \`${f}\``)),
    ...(misplacedAuthorised.length
      ? [
          'An authorised: line outside ## Files does not count — move it into that section.',
          ...misplacedAuthorised.map((l) => `- \`${l}\``),
        ]
      : []),
    '',
    'Globs by linked issue:',
    ...linkedGlobs.map(({ issue, globs }) => `- #${issue ?? '?'}: ${globs.length ? globs.map((g) => `\`${g}\``).join(', ') : '(none)'}`),
    ...(authorisedGlobs.length ? ['', `Authorised by the PR: ${authorisedGlobs.map((g) => `\`${g}\``).join(', ')}`] : []),
    ...(dangling.length
      ? [
          '',
          '### Dangling references',
          '',
          '**FAILED** — removed or renamed, still referenced outside the diff:',
          ...dangling.map((d) => `- \`${d.removed}\` referenced by \`${d.referencedBy}\``),
        ]
      : []),
  ].join('\n'),
);
if (!ok) process.exit(1);
