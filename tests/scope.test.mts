#!/usr/bin/env node
// Cases for ci/scope-check.mts: the PR diff must stay inside the issue's
// `## Files` globs, unless an `authorised:` line in the **linked issue's**
// `## Files` grants extra files. A grant in the pull-request body is
// ignored and reported as such (#155): the implementer writes that body.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, commit, finish, git, tempRepo } from './lib/harness.mts';
import { fileGrowth, findMisplacedAuthorisedLines, parseLinkedIssues } from '../ci/lib/scope.mts';
// #177's `decisionNudge` comes in through the namespace, not the named
// import above: a named import of an export the base checkout does not have
// kills this whole file at load time, which reads as a structural red
// ("does not provide an export named") rather than an assertion — exactly
// what `ci/negative-control.mts` warns about. Through the namespace the
// base fails on the assertion instead.
import * as scopeLib from '../ci/lib/scope.mts';

const dir = mkdtempSync(join(tmpdir(), 'agentic-scope-'));
cleanup(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, content: string): string => {
  writeFileSync(join(dir, name), content);
  return join(dir, name);
};
const files = file('files.txt', 'src/a.ts\nsrc/lib/b.ts\n');
const issueSrc = file('issue-src.md', '## Goal\nx\n\n## Files\nGlobs this issue may touch:\n- `src/**`\n\n## Dependencies\nnone\n');
const issueLib = file('issue-lib.md', '## Files\n- `lib/**`, `docs/*.md`\n');
const issueBare = file('issue-bare.md', '## Files\n- src/**\n');
const prPlain = file('pr-plain.md', 'Closes #1\n\n## Files\nGlobs touched (must match the issue).\n');
const prGrant = file('pr-grant.md', 'Closes #1\n\n## Files\n- authorised: `src/a.ts`\n  (orchestrator: needed for AC3)\n- authorised: `src/lib/b.ts` — see issue comment\n');
const prNoClose = file('pr-noclose.md', '## What changed\nstuff\n');
// #155: the grant travels on the issue. Written on bare (non-bullet) lines
// here; the bullet form, which the grant parser must own alone, is #231's
// block at the end of this file.
const issueLibGrant = file(
  'issue-lib-grant.md',
  '## Files\n- `lib/**`, `docs/*.md`\nauthorised: `src/a.ts`\n  (orchestrator: needed for AC3)\nauthorised: `src/lib/b.ts` — see issue comment\n',
);
const issueLibGrantBullet = file(
  'issue-lib-grant-bullet.md',
  '## Files\n- `lib/**`, `docs/*.md`\n- authorised: src/a.ts\n  (orchestrator: needed for AC3)\n- authorised: src/lib/b.ts — see issue comment\n',
);
const scope = (f: string, i: string | null, p: string) => ci('scope-check.mts', ['--files-file', f, ...(i ? ['--issue-body-file', i] : []), '--pr-body-file', p]);
// The script's stdout is the JSON block (indented, so its top-level closing
// `}` is the first line that is exactly `}`) followed by the job summary
// text; this pulls out just the JSON so a case can assert on individual
// keys instead of pattern-matching the whole combined output.
const scopeJson = (out: string): any => {
  const m = out.match(/^\{[\s\S]*?\n\}\n/);
  if (!m) throw new Error(`no top-level JSON object found in: ${out}`);
  return JSON.parse(m[0]);
};

check('scope passes inside the issue globs', scope(files, issueSrc, prPlain).status === 0);
check('scope passes with bare (unquoted) globs', scope(files, issueBare, prPlain).status === 0);
check('scope fails outside the issue globs', scope(files, issueLib, prPlain).status === 1);
check('scope fails without Closes #N', scope(files, null, prNoClose).status === 1);
const r = scope(files, issueLib, prPlain);
check('scope names the violations', /src\/a\.ts/.test(r.out) && /src\/lib\/b\.ts/.test(r.out), r.out);

// #155: an `authorised:` grant counts only in the body of an issue the PR
// closes. The implementer writes the PR body, so a grant there would be a
// self-grant: it is ignored, and the check says so instead of silently
// passing the file.
const IGNORED_PR_GRANT = "An authorised: line in the pull-request body grants nothing — the grant is read from the linked issue's ## Files.";

const rPrOnlyGrant = scope(files, issueLib, prGrant);
check(
  'scope fails when the only authorised: grant is in the pull-request body',
  rPrOnlyGrant.status === 1,
  rPrOnlyGrant.out,
);
check(
  'scope reports the pull-request grant as ignored, with the reason',
  rPrOnlyGrant.out.includes(IGNORED_PR_GRANT) &&
    JSON.stringify(scopeJson(rPrOnlyGrant.out).ignoredPrGrants) === JSON.stringify(['src/a.ts', 'src/lib/b.ts']),
  rPrOnlyGrant.out,
);

const rIssueGrant = scope(files, issueLibGrant, prPlain);
check(
  'scope passes the same diff when the authorised: grant is in the linked issue',
  rIssueGrant.status === 0,
  rIssueGrant.out,
);
check(
  'scope attributes the issue grant in the summary and prints no ignored-grant line',
  /Authorised by #1: [^\n]*`src\/a\.ts`[^\n]*`src\/lib\/b\.ts`/.test(rIssueGrant.out) && !rIssueGrant.out.includes(IGNORED_PR_GRANT),
  rIssueGrant.out,
);
check(
  'scope reads the issue grant with the same strictness: bullet or bare, backticked glob wins, trailing prose ignored',
  scope(files, issueLibGrantBullet, prPlain).status === 0,
  scope(files, issueLibGrantBullet, prPlain).out,
);

// AC3: both `--issue-body-file` and `--pr-body-file` given — only the
// issue's grant applies, and the pull request's is named as ignored.
const issueLibGrantA = file('issue-lib-grant-a.md', '## Files\n- `lib/**`\nauthorised: `src/a.ts`\n  (orchestrator: only this one counts)\n');
const prGrantB = file('pr-grant-b.md', 'Closes #1\n\n## Files\n- authorised: `src/lib/b.ts`\n  (implementer: this must not count)\n');
const rBothBodies = scope(files, issueLibGrantA, prGrantB);
check(
  'scope with both bodies applies only the issue grant and names the pull request one as ignored',
  rBothBodies.status === 1 &&
    JSON.stringify(scopeJson(rBothBodies.out).violations) === JSON.stringify(['src/lib/b.ts']) &&
    JSON.stringify(scopeJson(rBothBodies.out).ignoredPrGrants) === JSON.stringify(['src/lib/b.ts']) &&
    scopeJson(rBothBodies.out).globs.includes('src/a.ts'),
  rBothBodies.out,
);

// A stale grant left in a pull-request body is reported even when the
// check passes on the issue's globs alone — it did nothing, and silence
// would read as acceptance.
const rPassingWithStaleGrant = scope(files, issueSrc, prGrant);
check(
  'scope reports an ignored pull-request grant even when the check passes',
  rPassingWithStaleGrant.status === 0 && rPassingWithStaleGrant.out.includes(IGNORED_PR_GRANT),
  rPassingWithStaleGrant.out,
);

// AC1: parseLinkedIssues accepts Closes/Fixes/Resolves and their forms,
// in order, deduplicated, and ignores a bare #N with no keyword before it.
const linkedBody = [
  'Closes #1',
  'Fixes #2',
  'Resolves #3',
  'this closed #4 already',
  'fixes: #5',
  'see also #6 for context',
  'Closes #1 again',
].join('\n');
check(
  'parseLinkedIssues finds Closes/Fixes/Resolves + closed/fixes: forms, ordered and deduped, ignoring bare #N',
  JSON.stringify(parseLinkedIssues(linkedBody)) === JSON.stringify([1, 2, 3, 4, 5]),
  JSON.stringify(parseLinkedIssues(linkedBody)),
);
check('parseLinkedIssues returns nothing for a body with no linking keyword', parseLinkedIssues('## What changed\nstuff\n#6\n').length === 0);

const linkedBodyWithCode = [
  'fixes: #5',
  'quoted example: `fixes: #6`',
  '```',
  'Closes #7',
  '```',
].join('\n');
check(
  'parseLinkedIssues ignores keywords inside inline code spans and fenced code blocks',
  JSON.stringify(parseLinkedIssues(linkedBodyWithCode)) === JSON.stringify([5]),
  JSON.stringify(parseLinkedIssues(linkedBodyWithCode)),
);

// AC2: several linked issues (Closes #1, Fixes #2) union their `## Files`
// globs, and the job summary attributes each glob to its issue.
const issueA = file('issue-a.md', '## Files\n- `src/**`\n');
const issueB = file('issue-b.md', '## Files\n- `lib/**`\n');
const prTwo = file('pr-two.md', 'Closes #1\nFixes #2\n\n## Files\nGlobs touched.\n');
const filesTwo = file('files-two.txt', 'src/a.ts\nlib/b.ts\n');
const scopeTwo = (f: string) => ci('scope-check.mts', ['--files-file', f, '--issue-body-file', `${issueA},${issueB}`, '--pr-body-file', prTwo]);

const r2 = scopeTwo(filesTwo);
check('scope unions the globs of several linked issues', r2.status === 0, r2.out);
check(
  'scope summary attributes each glob to its linked issue, not the other one',
  /#1:[^\n]*src\/\*\*/.test(r2.out) &&
    /#2:[^\n]*lib\/\*\*/.test(r2.out) &&
    !/#1:[^\n]*lib\/\*\*/.test(r2.out) &&
    !/#2:[^\n]*src\/\*\*/.test(r2.out),
  r2.out,
);

const filesOutsideUnion = file('files-outside-union.txt', 'other/x.ts\n');
const r3 = scopeTwo(filesOutsideUnion);
check('scope fails on a file outside the union of the linked issues\' globs', r3.status === 1, r3.out);

// AC3: zero linked issues still fails, naming the three keywords.
const rZero = scope(files, null, prNoClose);
check(
  'scope names Closes/Fixes/Resolves when no issue is linked',
  /closes/i.test(rZero.out) && /fixes/i.test(rZero.out) && /resolves/i.test(rZero.out),
  rZero.out,
);

// AC1 (#42): `?` is a single-character wildcard, matching exactly one
// character other than `/` — not "optional preceding character" (a live
// regex quantifier) and not a path separator.
const issueQuestion = file('issue-question.md', '## Files\n- `src/a?c.ts`\n');
const filesQuestionMatch = file('files-question-match.txt', 'src/abc.ts\n');
const filesQuestionNoMatch = file('files-question-nomatch.txt', 'src/ac.ts\n');
const filesQuestionNoMatchSlash = file('files-question-nomatch-slash.txt', 'src/a/c.ts\n');
const rQuestionMatch = scope(filesQuestionMatch, issueQuestion, prPlain);
check('scope: `?` matches exactly one character (src/a?c.ts matches src/abc.ts)', rQuestionMatch.status === 0, rQuestionMatch.out);
check(
  'scope: `?` does not match zero characters (src/a?c.ts does not match src/ac.ts)',
  scope(filesQuestionNoMatch, issueQuestion, prPlain).status === 1,
);
check(
  'scope: `?` does not match a path separator (src/a?c.ts does not match src/a/c.ts)',
  scope(filesQuestionNoMatchSlash, issueQuestion, prPlain).status === 1,
);

// #51: `scope` also fails a PR that deletes or renames a tracked path still
// referenced by a tracked file outside the diff — the #3 shape (a rename
// that drops a path a workflow still names by string). Needs a real repo:
// the dangling-reference check runs `git grep` over the tracked tree.
const danglingRepo = tempRepo();
const danglingBase = commit(danglingRepo, {
  'tests/smoke.mts': 'export const x = 1;\n',
  '.github/workflows/test.yml': 'run: node tests/smoke.mts\n',
  'tests/orphan.mts': 'export const y = 1;\n',
}, 'chore: base');
git(['checkout', '-q', '-b', 'feat/51-x'], danglingRepo);
// Rename tests/smoke.mts -> tests/run.mts and delete the unreferenced
// tests/orphan.mts, in one commit; git's diff detects the rename by content
// similarity, no `git mv` needed. The workflow keeps naming the old path.
rmSync(join(danglingRepo, 'tests', 'smoke.mts'), { force: true });
rmSync(join(danglingRepo, 'tests', 'orphan.mts'), { force: true });
writeFileSync(join(danglingRepo, 'tests', 'run.mts'), 'export const x = 1;\n');
git(['add', '-A'], danglingRepo);
git(['commit', '-q', '-m', 'feat: rename tests/smoke.mts to tests/run.mts'], danglingRepo);
const danglingHead = git(['rev-parse', 'HEAD'], danglingRepo);
// Left checked out on the head commit (not main): the dangling-reference
// check greps the currently checked-out tree, same as CI does after
// actions/checkout puts the PR's head (or merge commit) on disk.

const issueTestsOnly = file('issue-tests-only.md', '## Files\n- `tests/**`\n');
const issueTestsAndWorkflow = file('issue-tests-and-workflow.md', '## Files\n- `tests/**`, `.github/workflows/**`\n');
const issueTestsAuthorised = file(
  'issue-tests-authorised.md',
  '## Files\n- `tests/**`\nauthorised: `.github/workflows/test.yml`\n  (orchestrator: needed for the rename)\n',
);
const prClosesOnly = file('pr-closes-only.md', 'Closes #1\n\n## Files\nGlobs touched.\n');
const prClosesAuthorised = file(
  'pr-closes-authorised.md',
  'Closes #1\n\n## Files\n- authorised: `.github/workflows/test.yml`\n  (needed for the rename)\n',
);
const scopeReal = (issueBody: string, prBody: string) =>
  ci('scope-check.mts', ['--base', danglingBase, '--head', danglingHead, '--issue-body-file', issueBody, '--pr-body-file', prBody, '--root', danglingRepo]);

const rDangling = scopeReal(issueTestsOnly, prClosesOnly);
check(
  'scope fails a rename that leaves a dangling reference outside the diff and outside the globs',
  rDangling.status === 1 && /tests\/smoke\.mts/.test(rDangling.out) && /\.github\/workflows\/test\.yml/.test(rDangling.out),
  rDangling.out,
);
check('scope does not report a dangling reference for tests/orphan.mts, which nobody references', !/orphan\.mts/.test(rDangling.out), rDangling.out);

// AC2: `--removed-file` is the dry-run alternative to a real base/head
// diff — same repo, same head state on disk, but the removed path is given
// directly and no `git diff` is computed for it.
const filesRename = file('files-rename.txt', 'tests/smoke.mts\ntests/run.mts\n');
const removedSmoke = file('removed-smoke.txt', 'tests/smoke.mts\n');
const rDryRun = ci('scope-check.mts', [
  '--files-file', filesRename,
  '--removed-file', removedSmoke,
  '--issue-body-file', issueTestsOnly,
  '--pr-body-file', prClosesOnly,
  '--root', danglingRepo,
]);
check(
  'scope --removed-file dry run finds the same dangling reference without a real diff',
  rDryRun.status === 1 && /tests\/smoke\.mts/.test(rDryRun.out) && /\.github\/workflows\/test\.yml/.test(rDryRun.out),
  rDryRun.out,
);

const rWorkflowInGlobs = scopeReal(issueTestsAndWorkflow, prClosesOnly);
check(
  "scope passes the same rename when the referencing workflow file is inside the issue's globs",
  rWorkflowInGlobs.status === 0,
  rWorkflowInGlobs.out,
);

const rAuthorised = scopeReal(issueTestsAuthorised, prClosesOnly);
check(
  'scope passes the same rename when the linked issue authorises the referencing workflow file',
  rAuthorised.status === 0,
  rAuthorised.out,
);

// #155: the dangling-reference check reads the issue's grants too — a
// grant for the same file in the pull-request body does not clear it.
const rAuthorisedInPr = scopeReal(issueTestsOnly, prClosesAuthorised);
check(
  'scope still fails the rename when the workflow file is authorised only in the pull-request body',
  rAuthorisedInPr.status === 1 && rAuthorisedInPr.out.includes(IGNORED_PR_GRANT),
  rAuthorisedInPr.out,
);

// #89: `checkScope` can pass (every changed file sits inside the linked
// issues' globs) while the overall check still fails on a dangling
// reference; the summary's first line must say so instead of reading
// "all inside the linked issues' globs." right above a FAILED section.
// Written against a real GITHUB_STEP_SUMMARY file, per the issue's proof.
// Run here, not further down, while danglingRepo is still checked out on
// danglingHead — the same head this case's --head diffs against; the
// dangling-reference grep reads the checked-out tree (see the comment at
// danglingHead's definition above), so the two must match.
const firstNonEmptyLineAfterHeading = (summary: string, heading: string): string => {
  const lines = summary.split('\n');
  const at = lines.findIndex((l) => l.trim() === heading);
  if (at === -1) throw new Error(`no "${heading}" heading found in: ${summary}`);
  const rest = lines.slice(at + 1).map((l) => l.trim()).filter(Boolean);
  if (rest.length === 0) throw new Error(`no non-empty line after "${heading}" in: ${summary}`);
  return rest[0];
};

const summaryDanglingOnly = join(dir, 'summary-dangling-only.md');
writeFileSync(summaryDanglingOnly, '');
const rDanglingSummary = ci(
  'scope-check.mts',
  ['--base', danglingBase, '--head', danglingHead, '--issue-body-file', issueTestsOnly, '--pr-body-file', prClosesOnly, '--root', danglingRepo],
  { env: { GITHUB_STEP_SUMMARY: summaryDanglingOnly } },
);
const firstLineDangling = firstNonEmptyLineAfterHeading(readFileSync(summaryDanglingOnly, 'utf8'), '## scope');
check(
  'scope summary states the FAILED verdict on its first line when only dangling references fail',
  rDanglingSummary.status === 1 &&
    /^\*\*FAILED\*\* — \d+ dangling reference\(s\); every changed file is inside the linked issues' globs\.$/.test(firstLineDangling) &&
    !/all inside/.test(firstLineDangling),
  firstLineDangling,
);

const summaryPassing = join(dir, 'summary-passing.md');
writeFileSync(summaryPassing, '');
ci('scope-check.mts', ['--files-file', files, '--issue-body-file', issueSrc, '--pr-body-file', prPlain], { env: { GITHUB_STEP_SUMMARY: summaryPassing } });
const firstLinePassing = firstNonEmptyLineAfterHeading(readFileSync(summaryPassing, 'utf8'), '## scope');
check(
  "scope summary's passing first line is unchanged",
  firstLinePassing === "2 file(s), all inside the linked issues' globs.",
  firstLinePassing,
);

const summaryGlobViolation = join(dir, 'summary-glob-violation.md');
writeFileSync(summaryGlobViolation, '');
ci('scope-check.mts', ['--files-file', files, '--issue-body-file', issueLib, '--pr-body-file', prPlain], { env: { GITHUB_STEP_SUMMARY: summaryGlobViolation } });
const firstLineGlobViolation = firstNonEmptyLineAfterHeading(readFileSync(summaryGlobViolation, 'utf8'), '## scope');
check(
  "scope summary's glob-violation first line is unchanged",
  firstLineGlobViolation === "**FAILED** — outside the linked issues' globs:",
  firstLineGlobViolation,
);

// #83: an `authorised:` line outside the PR's `## Files` section is
// prose, not a grant — `parseAuthorisedGlobs` never sees it — but the
// summary and JSON should say why, instead of silently listing it among
// the ordinary violations.
check(
  'findMisplacedAuthorisedLines finds an authorised: line outside ## Files, trimmed and bullet-stripped',
  JSON.stringify(findMisplacedAuthorisedLines('Closes #1\n\n- authorised: `src/a.ts`\n  (justification)\n\n## Files\nGlobs touched.\n')) ===
    JSON.stringify(['authorised: `src/a.ts`']),
  JSON.stringify(findMisplacedAuthorisedLines('Closes #1\n\n- authorised: `src/a.ts`\n  (justification)\n\n## Files\nGlobs touched.\n')),
);
check(
  'findMisplacedAuthorisedLines finds nothing when the authorised: line sits inside ## Files',
  findMisplacedAuthorisedLines('Closes #1\n\n## Files\n- authorised: `src/a.ts`\n  (justification)\n').length === 0,
);
check(
  'findMisplacedAuthorisedLines finds nothing when there is no authorised: line at all',
  findMisplacedAuthorisedLines('Closes #1\n\n## Files\nGlobs touched.\n').length === 0,
);

const prGrantMisplaced = file(
  'pr-grant-misplaced.md',
  'Closes #1\n\n- authorised: `src/a.ts`\n  (orchestrator: needed for AC3)\n\n## Files\nGlobs touched (must match the issue).\n',
);
const rMisplaced = scope(files, issueLib, prGrantMisplaced);
check('scope fails when the only grant sits outside ## Files (it does not count)', rMisplaced.status === 1, rMisplaced.out);
check(
  'scope JSON names the misplaced authorised: line when the check fails',
  JSON.stringify(scopeJson(rMisplaced.out).misplacedAuthorised) === JSON.stringify(['authorised: `src/a.ts`']),
  rMisplaced.out,
);
check(
  'scope summary explains that an authorised: line outside ## Files is not parsed at all',
  /An authorised: line outside ## Files is not parsed at all — and a grant in the pull-request body grants nothing either\./.test(rMisplaced.out) &&
    /authorised: `src\/a\.ts`/.test(rMisplaced.out),
  rMisplaced.out,
);

const rGrantOk = scope(files, issueLibGrant, prPlain);
check(
  'scope JSON has no misplacedAuthorised key when the issue grants the files and the check passes',
  (() => {
    const json = scopeJson(rGrantOk.out);
    return json.ok === true && !('misplacedAuthorised' in json);
  })(),
  rGrantOk.out,
);
check('scope prints no misplacedAuthorised text when the issue grants the files and the check passes', !/misplacedAuthorised/.test(rGrantOk.out), rGrantOk.out);

const rPlainPass = scope(files, issueSrc, prPlain);
check(
  'scope prints no misplacedAuthorised key on an ordinary passing PR',
  (() => {
    const json = scopeJson(rPlainPass.out);
    return json.ok === true && !('misplacedAuthorised' in json);
  })(),
  rPlainPass.out,
);

// A removed path nobody references anywhere else is not a dangling
// reference, and the whole check passes.
git(['checkout', '-q', '-b', 'feat/51-orphan', danglingBase], danglingRepo);
rmSync(join(danglingRepo, 'tests', 'orphan.mts'), { force: true });
git(['add', '-A'], danglingRepo);
git(['commit', '-q', '-m', 'chore: remove unreferenced tests/orphan.mts'], danglingRepo);
const orphanHead = git(['rev-parse', 'HEAD'], danglingRepo);
// Left checked out on orphanHead, for the same reason as above.
const rOrphan = ci('scope-check.mts', [
  '--base', danglingBase, '--head', orphanHead,
  '--issue-body-file', issueTestsOnly, '--pr-body-file', prClosesOnly, '--root', danglingRepo,
]);
check('scope passes when a removed path is referenced nowhere else', rOrphan.status === 0, rOrphan.out);

// AC3: the job summary carries a "Dangling references" heading only when
// there is one to report; a clean PR (like the orphan case above) prints
// nothing new under it.
check(
  'scope summary has a "Dangling references" heading when there is a dangling reference, and none when there is not',
  /### Dangling references/.test(rDangling.out) && !/### Dangling references/.test(rOrphan.out),
  `${rDangling.out}\n---\n${rOrphan.out}`,
);

// AC1: a basename under 4 characters is too common to search on its own —
// only a full-path mention counts as a reference. `x/y.c`'s basename is
// `y.c` (3 chars): a file naming only `y.c` is not a hit, one naming the
// full `x/y.c` still is.
const shortRepo = tempRepo();
commit(shortRepo, {
  'notes.md': 'see y.c for the old approach\n',
  'build.mk': 'obj: x/y.c\n',
}, 'chore: base');
const issueOther = file('issue-other.md', '## Files\n- `other/**`\n');
const filesOther = file('files-other.txt', 'other/removed.c\n');
const removedShort = file('removed-short.txt', 'x/y.c\n');
const rShortBasename = ci('scope-check.mts', [
  '--files-file', filesOther,
  '--removed-file', removedShort,
  '--issue-body-file', issueOther,
  '--pr-body-file', prClosesOnly,
  '--root', shortRepo,
]);
check(
  'scope: a full-path mention of a removed file is a dangling reference even when its basename is short',
  rShortBasename.status === 1 && /build\.mk/.test(rShortBasename.out),
  rShortBasename.out,
);
check(
  "scope: a bare mention of a short basename (< 4 chars) alone is not searched, so notes.md is not flagged",
  !/notes\.md/.test(rShortBasename.out),
  rShortBasename.out,
);

// AC1: lockfiles are excluded from the dangling-reference search — a
// generated file naming an old path is noise, not a contract violation.
const lockRepo = tempRepo();
commit(lockRepo, {
  'package-lock.json': '{"resolved": "path/to/old-module.ts"}\n',
}, 'chore: base');
const removedLock = file('removed-lockref.txt', 'path/to/old-module.ts\n');
const rLockExcluded = ci('scope-check.mts', [
  '--files-file', filesOther,
  '--removed-file', removedLock,
  '--issue-body-file', issueOther,
  '--pr-body-file', prClosesOnly,
  '--root', lockRepo,
]);
check('scope: a lockfile naming a removed path is excluded from the dangling-reference search', rLockExcluded.status === 0, rLockExcluded.out);

// #134: `scope` fails a PR that adds a file over 800 lines or grows a file
// past 800 lines, `@generated` first line exempt. Real repos: the growth
// check runs `git show base:path` / `git show head:path`.
const linesOf = (n: number, fill = 'line'): string => `${Array.from({ length: n }, (_, i) => `${fill} ${i}`).join('\n')}\n`;
const issueSrcStar = file('issue-src-star.md', '## Files\n- `src/**`\n');
const prClosesOnlyGeneric = file('pr-closes-only-generic.md', 'Closes #1\n\n## Files\nGlobs touched.\n');
const scopeGrowth = (base: string, head: string, root: string) =>
  ci('scope-check.mts', ['--base', base, '--head', head, '--issue-body-file', issueSrcStar, '--pr-body-file', prClosesOnlyGeneric, '--root', root]);

const growthRepo = tempRepo();
const growthBase = commit(growthRepo, { 'src/big.ts': linesOf(700) }, 'chore: base at 700 lines');
git(['checkout', '-q', '-b', 'feat/134-grow'], growthRepo);
const growthHead = commit(growthRepo, { 'src/big.ts': linesOf(900) }, 'feat: grow src/big.ts to 900 lines');
const rGrowth = scopeGrowth(growthBase, growthHead, growthRepo);
check(
  'scope fails when a file grows from 700 to 900 lines, naming the file',
  rGrowth.status === 1 && /src\/big\.ts/.test(rGrowth.out) && /### File growth/.test(rGrowth.out),
  rGrowth.out,
);
check(
  "scope JSON's growth key names the one file that grew past the limit",
  (() => {
    const growth = scopeJson(rGrowth.out).growth;
    return Array.isArray(growth) && growth.length === 1 && growth[0].path === 'src/big.ts';
  })(),
  rGrowth.out,
);

// #134 round 2: `misplacedAuthorised` must stay tied to a glob failure —
// `result.ok` — and not to the overall `ok`, which also folds in growth
// and dangling-reference failures. Globs here cover every changed file
// (issueSrcStar matches src/**), so the glob check passes even though the
// growth check still fails the run; a stray authorised: line outside
// ## Files must not be reported as misplacedAuthorised in that case.
const prGrowthMisplaced = file(
  'pr-growth-misplaced.md',
  'Closes #1\n\n- authorised: `src/other.ts`\n  (stray grant outside ## Files; globs already cover everything)\n\n## Files\nGlobs touched.\n',
);
const rGrowthMisplaced = ci('scope-check.mts', [
  '--base', growthBase, '--head', growthHead,
  '--issue-body-file', issueSrcStar, '--pr-body-file', prGrowthMisplaced,
  '--root', growthRepo,
]);
check(
  'scope does not report misplacedAuthorised when only the growth check fails and the glob check passes',
  rGrowthMisplaced.status === 1 && !('misplacedAuthorised' in scopeJson(rGrowthMisplaced.out)),
  rGrowthMisplaced.out,
);

// Already over 800 and edited, without growing further, is not a violation.
git(['checkout', '-q', '-b', 'feat/134-already-900', growthHead], growthRepo);
const growthEditedHead = commit(growthRepo, { 'src/big.ts': linesOf(900, 'edited') }, 'refactor: edit src/big.ts without changing its line count');
const rGrowthEdited = scopeGrowth(growthHead, growthEditedHead, growthRepo);
check(
  'scope passes editing a file already over 800 lines, when it does not grow further',
  rGrowthEdited.status === 0 && !/### File growth/.test(rGrowthEdited.out),
  rGrowthEdited.out,
);

// A new file over 800 lines marked `@generated` on its first line is exempt.
git(['checkout', '-q', '-b', 'feat/134-generated', growthBase], growthRepo);
const generatedHead = commit(growthRepo, { 'src/generated.ts': `// @generated\n${linesOf(900)}` }, 'feat: add generated src/generated.ts');
const rGenerated = scopeGrowth(growthBase, generatedHead, growthRepo);
check(
  'scope passes a new file over 800 lines whose first line marks it @generated',
  rGenerated.status === 0 && !/### File growth/.test(rGenerated.out),
  rGenerated.out,
);

// A --files-file run (no base/head) is unaffected by the growth check.
const rFilesFileOnly = scope(files, issueSrc, prPlain);
check(
  'scope --files-file run without base/head has no File growth section',
  rFilesFileOnly.status === 0 && !/### File growth/.test(rFilesFileOnly.out),
  rFilesFileOnly.out,
);

// Direct unit test of the pure fileGrowth: growth past the limit fails,
// already-over-the-limit-but-not-growing does not, @generated is exempt.
check(
  'fileGrowth: a file growing past 800 lines is a violation',
  JSON.stringify(fileGrowth([{ path: 'a.ts', baseLines: 700, headLines: 900, generated: false }])) ===
    JSON.stringify([{ path: 'a.ts', baseLines: 700, headLines: 900 }]),
);
check('fileGrowth: a new file over 800 lines is a violation', fileGrowth([{ path: 'a.ts', baseLines: null, headLines: 900, generated: false }]).length === 1);
check(
  'fileGrowth: a new file under 800 lines is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: null, headLines: 700, generated: false }]).length === 0,
);
check(
  'fileGrowth: already over 800 lines and shrinking is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: 900, headLines: 850, generated: false }]).length === 0,
);
check(
  'fileGrowth: already over 800 lines and unchanged is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: 900, headLines: 900, generated: false }]).length === 0,
);
check(
  'fileGrowth: a file that grows but stays under 800 lines is not a violation',
  fileGrowth([{ path: 'a.ts', baseLines: 500, headLines: 700, generated: false }]).length === 0,
);
check(
  'fileGrowth: @generated on the first line exempts a file that would otherwise violate',
  fileGrowth([{ path: 'a.ts', baseLines: 700, headLines: 900, generated: true }]).length === 0,
);

// #177: the decision nudge. A PR that changes a mechanism file (a hook, a
// CI check, a script, a skill card, a workflow) without recording a
// decision in the same diff is named in a `warning:` line — and the check
// still exits 0, because a required check cannot make that judgement from
// file names alone (the decision on #180). The issue globs below have to
// cover the sensitive files, or the glob check would fail the run before
// the nudge is ever visible.
const nudgeIssue = file(
  'issue-nudge.md',
  '## Files\n- `hooks/**`, `ci/**`, `scripts/**`, `skills/**`, `.github/**`, `docs/**`\n',
);
const nudgeSensitive = [
  'hooks/protect-main.mts',
  'ci/scope-check.mts',
  'scripts/land.mts',
  'skills/issue-and-pr/SKILL.md',
  '.github/workflows/ci.yml',
];
const filesHookOnly = file('files-nudge-hook.txt', 'hooks/protect-main.mts\n');
const filesHookPlusDecision = file('files-nudge-decision.txt', 'hooks/protect-main.mts\ndocs/decisions/0001-nudge-strength.md\n');
const filesDocsOnly = file('files-nudge-docs.txt', 'docs/workflow.md\n');
const filesAllSensitive = file('files-nudge-all.txt', `${nudgeSensitive.join('\n')}\n`);

const rNudge = scope(filesHookOnly, nudgeIssue, prPlain);
check(
  'scope warns and still exits 0 on a mechanism file with no decision record in the diff',
  rNudge.status === 0 &&
    /warning:/.test(rNudge.out) &&
    JSON.stringify(scopeJson(rNudge.out).decisionNudge) === JSON.stringify(['hooks/protect-main.mts']),
  rNudge.out,
);

// The assertion is on the decision keys, not on `/warning:/` at large: since
// #182 a second, independent nudge (the dogfood one below) prints its own
// `> warning:` line, and `hooks/protect-main.mts` triggers it too.
const rNudgeDecided = scope(filesHookPlusDecision, nudgeIssue, prPlain);
check(
  'scope does not warn when the same diff also touches docs/decisions/',
  rNudgeDecided.status === 0 &&
    !/no decision recorded/.test(rNudgeDecided.out) &&
    !('decisionNudge' in scopeJson(rNudgeDecided.out)) &&
    !('warning' in scopeJson(rNudgeDecided.out)),
  rNudgeDecided.out,
);

const rNudgeDocs = scope(filesDocsOnly, nudgeIssue, prPlain);
check(
  'scope does not warn for a diff touching only docs/',
  rNudgeDocs.status === 0 && !/warning:/.test(rNudgeDocs.out) && !('decisionNudge' in scopeJson(rNudgeDocs.out)),
  rNudgeDocs.out,
);

const rNudgeAll = scope(filesAllSensitive, nudgeIssue, prPlain);
check(
  'the warning names every sensitive path it found',
  rNudgeAll.status === 0 && nudgeSensitive.every((p) => String(scopeJson(rNudgeAll.out).warning ?? '').includes(p)),
  rNudgeAll.out,
);

// Direct unit cases for the pure decisionNudge, which invariant 6 allows
// for `ci/lib/` — including the boundary the owner drew on #180:
// `tests/**` and `templates/**` are deliberately not sensitive.
const decisionNudge = scopeLib.decisionNudge as ((files: string[]) => string[]) | undefined;
check('ci/lib/scope.mts exports decisionNudge', typeof decisionNudge === 'function');
check(
  'decisionNudge returns every sensitive path, in diff order',
  decisionNudge !== undefined &&
    JSON.stringify(decisionNudge(['docs/workflow.md', ...nudgeSensitive])) === JSON.stringify(nudgeSensitive),
  decisionNudge ? JSON.stringify(decisionNudge(['docs/workflow.md', ...nudgeSensitive])) : 'not exported',
);
check(
  'decisionNudge returns nothing when the diff touches docs/decisions.md',
  decisionNudge !== undefined && decisionNudge(['ci/scope-check.mts', 'docs/decisions.md']).length === 0,
);
check(
  'decisionNudge returns nothing when the diff touches a file under docs/decisions/',
  decisionNudge !== undefined && decisionNudge(['ci/scope-check.mts', 'docs/decisions/0001-x.md']).length === 0,
);
check(
  'decisionNudge does not treat tests/** or templates/** as sensitive',
  decisionNudge !== undefined && decisionNudge(['tests/scope.test.mts', 'templates/issue.md']).length === 0,
  decisionNudge ? JSON.stringify(decisionNudge(['tests/scope.test.mts', 'templates/issue.md'])) : 'not exported',
);
check(
  'decisionNudge treats only SKILL.md under skills/, not every file there',
  decisionNudge !== undefined && decisionNudge(['skills/orchestrate/scripts/run.mts', 'skills/orchestrate/notes.md']).length === 0,
);

// #182: the dogfood nudge. A PR that changes the mechanism the loop runs on
// — `hooks/`, `ci/`, `scripts/` or a `skills/**/SKILL.md` — while pointing
// at no `docs/dogfood/<date>.md` report is named in a second `warning:`
// line, and the check still exits 0 (the decision on #180's shape). The
// binding half is `scripts/close-milestone.mts`, once per phase.
//
// These cases assert the dogfood keys specifically: every sensitive file
// here also fires the decision nudge, so `/warning:/` alone would not
// discriminate the two.
const DOGFOOD_PHRASE = /dogfood report/;
const prDogfood = file(
  'pr-dogfood.md',
  'Closes #1\n\n## Proof\nRan the loop against a disposable repository; written up in `docs/dogfood/2026-09-17.md`.\n\n## Files\n',
);
const filesWithReport = file('files-dogfood-added.txt', 'ci/scope-check.mts\ndocs/dogfood/2026-09-17.md\n');
const dogfoodIssue = file(
  'issue-dogfood.md',
  '## Files\n- `hooks/**`, `ci/**`, `scripts/**`, `skills/**`, `.github/**`, `docs/**`\n',
);

const rDogfood = scope(filesHookOnly, dogfoodIssue, prPlain);
const rDogfoodJson = scopeJson(rDogfood.out);
check(
  'scope warns and still exits 0 on a mechanism file when the PR names no dogfood report',
  rDogfood.status === 0 &&
    DOGFOOD_PHRASE.test(rDogfood.out) &&
    JSON.stringify(rDogfoodJson.dogfoodTrigger) === JSON.stringify(['hooks/protect-main.mts']) &&
    typeof rDogfoodJson.dogfoodWarning === 'string',
  rDogfood.out,
);

const rDogfoodNamed = scope(filesHookOnly, dogfoodIssue, prDogfood);
check(
  'scope does not raise the dogfood nudge when the PR body names a docs/dogfood/<date>.md report',
  rDogfoodNamed.status === 0 &&
    !DOGFOOD_PHRASE.test(rDogfoodNamed.out) &&
    !('dogfoodTrigger' in scopeJson(rDogfoodNamed.out)) &&
    !('dogfoodWarning' in scopeJson(rDogfoodNamed.out)),
  rDogfoodNamed.out,
);

const rDogfoodAdded = scope(filesWithReport, dogfoodIssue, prPlain);
check(
  'scope does not raise the dogfood nudge when the diff itself carries a docs/dogfood/<date>.md report',
  rDogfoodAdded.status === 0 &&
    !DOGFOOD_PHRASE.test(rDogfoodAdded.out) &&
    !('dogfoodTrigger' in scopeJson(rDogfoodAdded.out)) &&
    !('dogfoodWarning' in scopeJson(rDogfoodAdded.out)),
  rDogfoodAdded.out,
);

const rDogfoodDocs = scope(filesDocsOnly, dogfoodIssue, prPlain);
check(
  'scope raises no dogfood nudge for a diff touching only docs/',
  rDogfoodDocs.status === 0 && !('dogfoodTrigger' in scopeJson(rDogfoodDocs.out)),
  rDogfoodDocs.out,
);

// The two nudges are independent: a diff that records a decision still owes
// a dogfood report, and the exit code stays 0 either way.
const rBothNudges = scope(filesHookPlusDecision, dogfoodIssue, prPlain);
check(
  'the dogfood nudge fires even when the diff records a decision, and the check still exits 0',
  rBothNudges.status === 0 &&
    JSON.stringify(scopeJson(rBothNudges.out).dogfoodTrigger) === JSON.stringify(['hooks/protect-main.mts']) &&
    !('warning' in scopeJson(rBothNudges.out)),
  rBothNudges.out,
);

// Direct unit cases for the pure `dogfoodTrigger`, through the namespace for
// the same reason `decisionNudge` is imported that way above.
const dogfoodTrigger = scopeLib.dogfoodTrigger as ((files: string[], prBody?: string | null) => string[]) | undefined;
check('ci/lib/scope.mts exports dogfoodTrigger', typeof dogfoodTrigger === 'function');
const dogfoodSensitive = ['hooks/protect-main.mts', 'ci/scope-check.mts', 'scripts/land.mts', 'skills/issue-and-pr/SKILL.md'];
check(
  'dogfoodTrigger returns every sensitive path, in diff order',
  dogfoodTrigger !== undefined &&
    JSON.stringify(dogfoodTrigger(['docs/workflow.md', ...dogfoodSensitive], '')) === JSON.stringify(dogfoodSensitive),
  dogfoodTrigger ? JSON.stringify(dogfoodTrigger(['docs/workflow.md', ...dogfoodSensitive], '')) : 'not exported',
);
check(
  'dogfoodTrigger returns nothing when the PR body names a docs/dogfood/<date>.md report',
  dogfoodTrigger !== undefined && dogfoodTrigger(['ci/scope-check.mts'], 'see `docs/dogfood/2026-09-17.md`').length === 0,
);
check(
  'dogfoodTrigger returns nothing when the diff carries a docs/dogfood/<date>.md report',
  dogfoodTrigger !== undefined && dogfoodTrigger(['ci/scope-check.mts', 'docs/dogfood/2026-09-17.md'], '').length === 0,
);
check(
  'dogfoodTrigger ignores a docs/dogfood/ path that is not a dated report',
  dogfoodTrigger !== undefined && dogfoodTrigger(['ci/scope-check.mts', 'docs/dogfood/README.md'], '').length === 1,
  dogfoodTrigger ? JSON.stringify(dogfoodTrigger(['ci/scope-check.mts', 'docs/dogfood/README.md'], '')) : 'not exported',
);
// Deliberately narrower than MECHANISM_GLOBS: a workflow file is a decision,
// not a dogfood trigger (#182's and #181's acceptance criteria both list
// `hooks/`, `ci/`, `scripts/` and `skills/**/SKILL.md` only).
check(
  'dogfoodTrigger does not treat .github/workflows/** as sensitive',
  dogfoodTrigger !== undefined && dogfoodTrigger(['.github/workflows/agentic-checks.yml'], '').length === 0,
  dogfoodTrigger ? JSON.stringify(dogfoodTrigger(['.github/workflows/agentic-checks.yml'], '')) : 'not exported',
);
check(
  'dogfoodTrigger does not treat tests/** or templates/** as sensitive',
  dogfoodTrigger !== undefined && dogfoodTrigger(['tests/scope.test.mts', 'templates/issue.md'], '').length === 0,
);
check(
  'dogfoodTrigger treats only SKILL.md under skills/, not every file there',
  dogfoodTrigger !== undefined && dogfoodTrigger(['skills/orchestrate/scripts/run.mts', 'skills/orchestrate/notes.md'], '').length === 0,
);

// #231: a grant is read once, as a grant, whatever bullet shape it takes.
// On the base a backticked bullet grant landed in both lists; a bare comma
// list was worse — only its first token was granted, and its second became an
// ordinary issue glob, widening the check through a path no one audited.
const pIG = (b: string) => JSON.stringify(scopeLib.parseIssueGlobs(b));
const pAG = (b: string) => JSON.stringify(scopeLib.parseIssueAuthorisedGlobs(b));
const grantBullet = '## Files\n- `lib/**`\n- authorised: `src/a.ts`\n  (orchestrator: needed for AC3)\n';
const grantUpper = '## Files\n- `lib/**`\n* Authorised: `src/a.ts`\n';
const grantCommas = '## Files\n- `lib/**`\n- authorised: src/a.ts, src/lib/b.ts\n';
// The word opens a grant only when it starts the bullet's content, unquoted,
// and carries the colon. These three stay ordinary globs and grant nothing.
const stillGlobs = '## Files\n- `src/authorised.ts`\n- `docs/x.md` authorised by the owner\n- `authorised: src/a.ts`\n';
check('parseIssueGlobs skips a backticked bullet grant', pIG(grantBullet) === '["lib/**"]', pIG(grantBullet));
check('parseIssueAuthorisedGlobs still reads that same grant', pAG(grantBullet) === '["src/a.ts"]', pAG(grantBullet));
check('the grant bullet is skipped whatever its marker or case', pIG(grantUpper) === '["lib/**"]', pIG(grantUpper));
check('a bare comma-separated grant leaves no ordinary glob behind', pIG(grantCommas) === '["lib/**"]', pIG(grantCommas));
check('a bare comma-separated grant still grants its first token only', pAG(grantCommas) === '["src/a.ts"]', pAG(grantCommas));
check('a path named authorised, the word mid-bullet and a backticked-first line stay ordinary globs and grant nothing', pIG(stillGlobs) === '["src/authorised.ts","docs/x.md","authorised: src/a.ts"]' && pAG(stillGlobs) === '[]', `${pIG(stillGlobs)} / ${pAG(stillGlobs)}`);
const rGrantBullet = scope(files, file('issue-grant-bullet.md', `${grantBullet}- \`src/lib/**\`\n`), prPlain);
check('scope passes a bullet-form grant and names it once, under Authorised by #N only', rGrantBullet.status === 0 && /^- #1: `lib\/\*\*`, `src\/lib\/\*\*`$/m.test(rGrantBullet.out) && /^Authorised by #1: `src\/a\.ts`$/m.test(rGrantBullet.out), rGrantBullet.out);
const rGrantCommas = scope(files, file('issue-grant-commas.md', grantCommas), prPlain);
check('the second token of a bare comma grant no longer widens the check', rGrantCommas.status === 1 && JSON.stringify(scopeJson(rGrantCommas.out).violations) === JSON.stringify(['src/lib/b.ts']), rGrantCommas.out);
const rGrantOnly = scope(files, file('issue-grant-only.md', '## Files\n- authorised: `src/a.ts`\n'), prPlain);
check('an issue whose ## Files carries only a grant declares no globs of its own', rGrantOnly.status === 1 && /declare no globs/.test(rGrantOnly.out), rGrantOnly.out);

finish();
