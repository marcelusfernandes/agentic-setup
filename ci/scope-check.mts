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
// It also holds every changed file to FILE_LINE_LIMIT, and says which of two
// things it found (#310). A file this diff took past the limit — new at head
// over it, or longer at the head than at the base — **fails** the check under
// `### File growth`. A file that was already over the limit at the base and
// that this diff did not lengthen is **reported** under `### Already over the
// line limit` and does not fail: a pull request is not blamed for length it
// did not add. Reporting it is the point — before #310 that case produced no
// message at all, so a file that had crossed the limit was exempt from then
// on. "Under the limit" and "not failing this check" are two questions, and
// the summary answers them separately. Since #413 a third: a file left within
// FILE_LINE_APPROACH_BAND lines of the limit without crossing it is named
// under `### Approaching the line limit`, also without failing, so the rule
// speaks before the pull request that crosses rather than after it. A file at
// exactly FILE_LINE_LIMIT is reported there, and that section says in words
// that it is not over the limit.
//
// Every one of those length questions is answered against the **merge base**
// of the pull request, and so is the changed-file list — one base per
// question (#387). The base tip the event carries is named in the summary and
// read for nothing else; see `showAt`.
//
// It also says what it audited and where it learned it: how many globs came
// from how many linked issues, each issue marked `declared` when the body's
// opening lines link it and `from prose` when only later prose does, and a
// `warning:` for each of the second kind naming the phrase, the issue and the
// globs it adds. `LINKED_ISSUE_RE` is deliberately not narrowed — GitHub
// closes an issue named in prose too, so a narrower parser would audit less
// than GitHub actually closes (#359).
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
import { approachingLimit, checkScope, collectLinkedGlobs, decisionNudge, dogfoodTrigger, FILE_LINE_APPROACH_BAND, FILE_LINE_LIMIT, fileGrowth, findMisplacedAuthorisedLines, incidentalLinkedIssues, inheritedOverLimit, parseAuthorisedGlobs, parseLinkedIssues } from './lib/scope.mts';
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

// The one commit every question in this file is answered against: the merge
// base of the pull request's base branch and its head — the commit the branch
// forked from, which is what `git diff base...head` has always resolved to
// internally. Computed once, by name, so the changed-file list and the base
// line counts read the same commit instead of two that coincide only while the
// branch is level with `main` (#387, via #413).
//
// Fails closed. `git merge-base` answers from the object store alone; when it
// cannot, the two commits are not both present (a shallow checkout — this
// repository's workflow sets `fetch-depth: 0` precisely so they are) and every
// answer below would be computed against the wrong history. A check that
// guessed here would guess in the direction of passing.
function mergeBaseOf(base: string, head: string): string {
  const r = spawnSync('git', ['merge-base', base, head], { cwd: root, encoding: 'utf8' });
  // `git merge-base` exits 1 with no output at all when the two commits share
  // no ancestor, so the reason has to be supplied here or the refusal reads as
  // a blank one.
  if (r.status !== 0) {
    const why = (r.stderr || r.stdout).trim();
    fail(`git merge-base ${base} ${head} found no common commit${why ? `: ${why}` : ' and said nothing'} — the two have unrelated histories, or the checkout is too shallow to hold both (this workflow sets fetch-depth: 0 so that it is not).`);
  }
  const sha = r.stdout.trim();
  if (!sha) fail(`git merge-base ${base} ${head} named no commit.`);
  return sha;
}

function changedFiles(base: string, head: string): string[] {
  const r = spawnSync('git', ['diff', '--no-renames', '--name-only', base, head], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) fail(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

// The deleted paths and the "from" side of every rename in the PR's diff —
// the paths that stop existing at head. `--find-renames` (unlike
// `changedFiles`'s `--no-renames`) is what turns a delete+add pair back
// into a single `R<score>\t<from>\t<to>` line so the "from" path is
// recoverable at all.
function removedPaths(base: string, head: string): string[] {
  const r = spawnSync('git', ['diff', '--name-status', '--find-renames', base, head], { cwd: root, encoding: 'utf8' });
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
//
// The base side of every call below is the **merge base**, never the base tip
// (`event.pull_request.base.sha`). The tip is deliberately not used here and
// this is the place it would have been read: it answers a different question —
// "what will `main` look like" — and the line rule asks "what did this branch
// do to this file", which is the merge base. Reading the tip made #290 report
// a branch that had added 10 lines to `tests/init.test.mts` as having removed
// 3, because #283 had landed in between (#387, item 0029's own second finding).
// The tip is still printed in the summary, under its own name, so the number
// that is not being used is visible rather than merely absent.
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
// The base **tip** as the event reports it. Used for exactly one thing: to
// find the merge base below, and to be named in the summary as the commit the
// line rule is not measured against (#387).
const baseTip = String(args.base ?? event?.pull_request?.base?.sha ?? '');
const headRef = String(args.head ?? event?.pull_request?.head?.sha ?? '');
// One base per question. Empty only on a --files-file dry run, which has no
// commits to compare and asks none of the questions that need one.
const baseRef = baseTip && headRef ? mergeBaseOf(baseTip, headRef) : '';

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
// Where each linked issue was found. An issue linked from prose still counts —
// GitHub closes it, so auditing it is right — but the run now says so, which is
// the whole of #359: both incidents were invisible because the merged glob list
// was printed and the issue numbers behind it never were, so a widened run and
// a correct run produced identical output.
const incidental = incidentalLinkedIssues(prBody);
const incidentalIssues = new Set(incidental.map((m) => m.issue));
const declaredGlobs = new Set(
  linkedGlobs.filter(({ issue }) => issue === null || !incidentalIssues.has(issue)).flatMap((g) => [...g.globs, ...g.authorised]),
);
// Per incidental issue: the globs it adds that the declaration did not already
// carry. Distinct paths, not a count of bullets — the reviewer of #359
// corrected its own wording here, because the accidental issue on PR #389
// contributed six globs but five paths nothing else granted.
const incidentalLinks = incidental.map((m) => ({
  issue: m.issue,
  line: m.line,
  phrase: m.phrase,
  adds: [...new Set(
    linkedGlobs.filter(({ issue }) => issue === m.issue).flatMap((g) => [...g.globs, ...g.authorised]),
  )].filter((g) => !declaredGlobs.has(g)),
}));
const audited = { globs: issueGlobs.length + authorisedGlobs.length, issues: linkedGlobs.length };
const AUDITED_LINE = `Audited ${audited.globs} glob(s) from ${audited.issues} linked issue(s): ${
  linkedGlobs
    .map(({ issue }) => `#${issue ?? '?'} (${issue !== null && incidentalIssues.has(issue) ? 'from prose' : 'declared'})`)
    .join(', ')
}`;
// Parsed, never applied: a grant in the PR body is the self-grant #155
// closed. Reported whether or not the check passes — a stale grant that
// did nothing should not read as accepted.
const ignoredPrGrants = parseAuthorisedGlobs(prBody);
const result = checkScope({ files, issueGlobs, authorisedGlobs });
const dangling = danglingReferences(removed, files, [...issueGlobs, ...authorisedGlobs]);
const lengths = baseRef && headRef ? growthEntries(baseRef, headRef, files) : [];
// Two halves of the same rule, read off the same entries. `growth` is the
// length this diff added and fails the check; `inherited` is length it found
// already over the limit and only reports (#310). Folding the second into
// `ok` would blame a pull request for somebody else's file, which is the
// reason the exemption was written in the first place — but leaving it unsaid
// is how a file that crossed the limit stayed across it, with every later
// change to it silently exempt.
const growth = fileGrowth(lengths);
const inherited = inheritedOverLimit(lengths);
// The third reading of the same entries (#413): files this diff leaves close
// to the limit without crossing it. Reported like `inherited`, never folded
// into `ok`, and never overlapping either over-limit list — one file has one
// outcome. A file at exactly FILE_LINE_LIMIT is here, and the section says so
// in words, because "at the limit" and "over the limit" were the same sentence
// to a reader and are not the same fact.
const approaching = approachingLimit(lengths);
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
// A third warning of the same shape, never folded into `ok` either: an issue
// linked from prose rather than from the declaration at the top of the body.
// Warned and not failed on purpose — a hard failure would refuse a body that
// is merely discursive, and a body explaining which pull request closed which
// issue is a good body, not a broken one (#359).
const linkedWarnings = incidentalLinks.map(
  (l) =>
    `#${l.issue} is linked from prose rather than from the declaration at the top of the body, and ${
      l.adds.length ? `adds ${l.adds.length} glob(s) the declaration did not: ${l.adds.map((g) => `\`${g}\``).join(', ')}` : 'adds no glob the declaration did not'
    } — line ${l.line + 1}: "${l.phrase}"`,
);

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
  audited,
  ...(baseRef ? { measuredBase: { mergeBase: baseRef, baseTip, head: headRef } } : {}),
  danglingReferences: dangling,
  growth,
  inherited,
  approaching,
  ...(incidentalLinks.length ? { incidentalLinks } : {}),
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
    ...(baseRef
      ? [`Measured against the merge base \`${baseRef}\` — the commit this branch forked from. The base tip \`${baseTip}\` is not what the line counts below are read from; the head is \`${headRef}\`.`, '']
      : []),
    AUDITED_LINE,
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
          // "took it past the limit" is false for a file already over that
          // grows further — 900 to 950 is further past, not past. What is
          // true of all three sub-cases (new at head over the limit, grown
          // from under to over, grown from over to more over) is that the
          // file is over at the head and this pull request is what added the
          // length. Kept parallel to the reported section below, which is the
          // same sentence with both halves negated.
          `**FAILED** — over ${FILE_LINE_LIMIT} lines at the head, and this pull request added or lengthened them, so it is answerable for them:`,
          ...growth.map((g) => `- \`${g.path}\` ${g.baseLines === null ? 'is new at' : `grew from ${g.baseLines} to`} ${g.headLines} line(s)`),
        ]
      : []),
    ...(inherited.length
      ? [
          '',
          '### Already over the line limit',
          '',
          `**REPORTED, not failed** — over ${FILE_LINE_LIMIT} lines at the base, and this pull request did not lengthen them, so it is not answerable for them:`,
          ...inherited.map((g) => `- \`${g.path}\` was already over at the base: ${g.baseLines} line(s) there, ${g.headLines} at the head`),
          '',
          `What closes it: a pull request that brings the file back under ${FILE_LINE_LIMIT} lines — split it, or move part of it out. Until one does, every pull request that touches the file repeats this message, the ones that shorten it included.`,
        ]
      : []),
    ...(approaching.length
      ? [
          '',
          '### Approaching the line limit',
          '',
          // The one sentence that has to be unmistakable, because the two
          // sections above it are about being over the limit and this one is
          // about not being over it. It states the band, states that the head
          // is under the limit, and answers the question a reader arrives with
          // — is 800 over 800 — rather than leaving it to be inferred from an
          // absent failure.
          `**REPORTED, not failed** — within ${FILE_LINE_APPROACH_BAND} lines of the ${FILE_LINE_LIMIT}-line limit at the head, and not over it: a file at exactly ${FILE_LINE_LIMIT} lines is at the limit, not past it, and fails nothing.`,
          ...approaching.map((g) => `- \`${g.path}\` is at ${g.headLines} line(s), ${FILE_LINE_LIMIT - g.headLines} from the limit${g.baseLines === null ? ', new at head' : ` (${g.baseLines} at the merge base)`}`),
          '',
          `What closes it: a pull request that leaves the file with room — split it, or move part of it out — or nothing at all, if the file is finished. This is not a refusal and nothing here changes the exit code; it is the warning the ${FILE_LINE_LIMIT}-line rule never gave before the pull request that crossed.`,
        ]
      : []),
    ...(decisionWarning ? ['', `> warning: ${decisionWarning}`] : []),
    ...(dogfoodWarning ? ['', `> warning: ${dogfoodWarning}`] : []),
    ...linkedWarnings.flatMap((w) => ['', `> warning: ${w}`]),
  ].join('\n'),
);
if (!ok) process.exit(1);
