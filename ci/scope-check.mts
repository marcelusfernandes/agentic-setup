#!/usr/bin/env node
// scope — the PR's diff must sit inside the union of the `## Files` globs
// of every issue it closes, plus whatever an `authorised:` line in one of
// those **issue** bodies grants. A PR links an issue with
// Closes/Fixes/Resolves (or their close/closed, fix/fixed,
// resolve/resolved forms), and may link several.
//
// The grant lives on the issue because the orchestrator writes the issue at
// dispatch while the implementer writes the PR body: a grant read from the
// PR is a self-grant, and one line added to its own description would carry
// a diff outside the issue's globs past this check (#155). A grant found in
// the PR body is parsed anyway, and reported as ignored with the reason,
// so it fails loudly rather than silently.
//
// It also fails a PR that deletes or renames a tracked path still named by
// another tracked file outside the diff (#51) — the #3 shape: a path drops
// out from under a reference nobody updated. Undecidable at issue-lint time
// (no diff exists yet to tell a rename from an in-place edit — see
// issue-lint.mts's header); decidable here, where the diff is known. A
// dangling reference is not a failure when the referencing file sits inside
// the linked issue's globs (the PR is expected to touch it, or the reviewer
// sees it in the diff) or is granted by an `authorised:` line in one of
// those issue bodies.
//
// It also names, as a `warning:` that never changes the exit code, every
// mechanism file the diff changes when the same diff records no decision
// (`decisionNudge` in lib/scope.mts) — the shape negative-control.mts uses
// for its structural-red warning.
//
// A second, independent warning of the same shape covers the dogfood loop
// (`dogfoodTrigger` in lib/scope.mts, #182): a diff that changes `hooks/`,
// `ci/`, `scripts/` or a `skills/**/SKILL.md` while the PR points at no
// `docs/dogfood/<date>.md` report is named the same way, and the check still
// exits 0. The binding half is `scripts/close-milestone.mts`, once per phase.
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
import { checkScope, collectLinkedGlobs, decisionNudge, dogfoodTrigger, FILE_LINE_LIMIT, fileGrowth, findMisplacedAuthorisedLines, parseAuthorisedGlobs, parseLinkedIssues } from './lib/scope.mts';
import type { FileLinesEntry } from './lib/scope.mts';
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

// The content of `path` at `ref`, or null when it does not exist there (a
// new file at head, or absent at base).
function showAt(base: string, path: string): string | null {
  const r = spawnSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function countLines(content: string): number {
  if (content === '') return 0;
  const withoutTrailingNewline = content.endsWith('\n') ? content.slice(0, -1) : content;
  return withoutTrailingNewline.split('\n').length;
}

// One entry per changed path that still exists at head — a deleted path has
// no head line count to check against the 800-line rule.
function growthEntries(base: string, head: string, paths: string[]): FileLinesEntry[] {
  const out: FileLinesEntry[] = [];
  for (const path of paths) {
    const headContent = showAt(head, path);
    if (headContent === null) continue;
    const baseContent = showAt(base, path);
    const firstLine = headContent.split(/\r?\n/, 1)[0] ?? '';
    out.push({
      path,
      baseLines: baseContent === null ? null : countLines(baseContent),
      headLines: countLines(headContent),
      generated: /@generated/.test(firstLine),
    });
  }
  return out;
}

type DanglingRef = { removed: string; referencedBy: string };

/** A hit is dangling unless it sits inside the diff itself (git grep runs
 * over the whole tree, then this drops what the diff already covers) or is
 * covered by the linked issue's globs / one of its `authorised:` grants. */
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
const authorisedGlobs = linkedGlobs.flatMap((g) => g.authorised);
// Parsed, never applied: a grant in the PR body is the self-grant #155
// closed. Reported whether or not the check passes — a stale grant that
// did nothing should not read as accepted.
const ignoredPrGrants = parseAuthorisedGlobs(prBody);
const result = checkScope({ files, issueGlobs, authorisedGlobs });
const dangling = danglingReferences(removed, files, [...issueGlobs, ...authorisedGlobs]);
const growth = baseRef && headRef ? fileGrowth(growthEntries(baseRef, headRef, files)) : [];
const ok = result.ok && dangling.length === 0 && growth.length === 0;
// A grant written outside ## Files never reaches parseAuthorisedGlobs at
// all, so it is not even among the ignored grants above; only worth
// surfacing once the glob check itself fails on something it might have
// covered — dangling references and file growth are unrelated to
// authorised: grants.
const misplacedAuthorised = result.ok ? [] : findMisplacedAuthorisedLines(prBody);
// A nudge, not a verdict: computed whatever the checks above decided, and
// never folded into `ok`. See lib/scope.mts's decisionNudge for why this
// stays a warning.
const nudged = decisionNudge(files);
const decisionWarning = nudged.length
  ? `${nudged.length} mechanism file(s) changed and no decision recorded in the same diff — add an entry under docs/decisions/ if this changes the contract (docs/decisions/README.md says what earns one): ${nudged.join(', ')}`
  : null;
// The same shape for the dogfood loop (#182), computed independently: a diff
// can owe a decision entry, a dogfood report, both or neither, and neither
// answer is ever folded into `ok`.
const owedDogfood = dogfoodTrigger(files, prBody);
const dogfoodWarning = owedDogfood.length
  ? `${owedDogfood.length} mechanism file(s) changed and this pull request names no dogfood report — name a \`docs/dogfood/<date>.md\` report, or expect scripts/close-milestone.mts to refuse the phase: ${owedDogfood.join(', ')}`
  : null;

let firstLine: string;
if (!result.ok) {
  firstLine = '**FAILED** — outside the linked issues\' globs:';
} else if (ok) {
  firstLine = `${files.length} file(s), all inside the linked issues' globs.`;
} else if (growth.length === 0) {
  firstLine = `**FAILED** — ${dangling.length} dangling reference(s); every changed file is inside the linked issues' globs.`;
} else if (dangling.length === 0) {
  firstLine = `**FAILED** — ${growth.length} file(s) new or grown past ${FILE_LINE_LIMIT} lines; every changed file is inside the linked issues' globs.`;
} else {
  firstLine = `**FAILED** — ${dangling.length} dangling reference(s) and ${growth.length} file(s) new or grown past ${FILE_LINE_LIMIT} lines; every changed file is inside the linked issues' globs.`;
}

const IGNORED_PR_GRANT_REASON =
  "An authorised: line in the pull-request body grants nothing — the grant is read from the linked issue's ## Files.";
const MISPLACED_REASON =
  'An authorised: line outside ## Files is not parsed at all — and a grant in the pull-request body grants nothing either.';

console.log(JSON.stringify({
  ...result,
  ok,
  danglingReferences: dangling,
  growth,
  ...(ignoredPrGrants.length ? { ignoredPrGrants } : {}),
  ...(misplacedAuthorised.length ? { misplacedAuthorised } : {}),
  ...(decisionWarning ? { decisionNudge: nudged, warning: decisionWarning } : {}),
  ...(dogfoodWarning ? { dogfoodTrigger: owedDogfood, dogfoodWarning } : {}),
}, null, 2));
appendSummary(
  [
    '## scope',
    '',
    firstLine,
    ...(result.ok ? [] : result.violations.map((f) => `- \`${f}\``)),
    ...(misplacedAuthorised.length
      ? [
          MISPLACED_REASON,
          ...misplacedAuthorised.map((l) => `- \`${l}\``),
        ]
      : []),
    ...(ignoredPrGrants.length
      ? [
          '',
          IGNORED_PR_GRANT_REASON,
          ...ignoredPrGrants.map((g) => `- ignored: \`${g}\``),
        ]
      : []),
    '',
    'Globs by linked issue:',
    ...linkedGlobs.map(({ issue, globs }) => `- #${issue ?? '?'}: ${globs.length ? globs.map((g) => `\`${g}\``).join(', ') : '(none)'}`),
    ...linkedGlobs
      .filter(({ authorised }) => authorised.length)
      .flatMap(({ issue, authorised }) => ['', `Authorised by #${issue ?? '?'}: ${authorised.map((g) => `\`${g}\``).join(', ')}`]),
    ...(dangling.length
      ? [
          '',
          '### Dangling references',
          '',
          '**FAILED** — removed or renamed, still referenced outside the diff:',
          ...dangling.map((d) => `- \`${d.removed}\` referenced by \`${d.referencedBy}\``),
        ]
      : []),
    ...(growth.length
      ? [
          '',
          '### File growth',
          '',
          `**FAILED** — new or grown past ${FILE_LINE_LIMIT} lines:`,
          ...growth.map((g) => `- \`${g.path}\` ${g.baseLines === null ? 'is new at' : `grew from ${g.baseLines} to`} ${g.headLines} line(s)`),
        ]
      : []),
    ...(decisionWarning ? ['', `> warning: ${decisionWarning}`] : []),
    ...(dogfoodWarning ? ['', `> warning: ${dogfoodWarning}`] : []),
  ].join('\n'),
);
if (!ok) process.exit(1);
