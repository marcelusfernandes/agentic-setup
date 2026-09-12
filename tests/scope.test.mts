#!/usr/bin/env node
// Cases for ci/scope-check.mts: the PR diff must stay inside the issue's
// `## Files` globs, unless the PR body grants extra files with `authorised:`.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, commit, finish, git, tempRepo } from './lib/harness.mts';
import { fileGrowth, findMisplacedAuthorisedLines, parseLinkedIssues } from '../ci/lib/scope.mts';

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
check('scope passes when the PR grants the files with authorised:', scope(files, issueLib, prGrant).status === 0);
check('scope fails without Closes #N', scope(files, null, prNoClose).status === 1);
const r = scope(files, issueLib, prPlain);
check('scope names the violations', /src\/a\.ts/.test(r.out) && /src\/lib\/b\.ts/.test(r.out), r.out);

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

const rAuthorised = scopeReal(issueTestsOnly, prClosesAuthorised);
check(
  'scope passes the same rename when the PR authorises the referencing workflow file',
  rAuthorised.status === 0,
  rAuthorised.out,
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
  'scope summary explains that an authorised: line outside ## Files does not count',
  /An authorised: line outside ## Files does not count — move it into that section\./.test(rMisplaced.out) &&
    /authorised: `src\/a\.ts`/.test(rMisplaced.out),
  rMisplaced.out,
);

const rGrantOk = scope(files, issueLib, prGrant);
check(
  'scope JSON has no misplacedAuthorised key when the grant is inside ## Files and the check passes',
  (() => {
    const json = scopeJson(rGrantOk.out);
    return json.ok === true && !('misplacedAuthorised' in json);
  })(),
  rGrantOk.out,
);
check('scope prints no misplacedAuthorised text when the grant is inside ## Files and the check passes', !/misplacedAuthorised/.test(rGrantOk.out), rGrantOk.out);

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

finish();
