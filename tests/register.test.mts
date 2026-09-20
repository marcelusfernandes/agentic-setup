#!/usr/bin/env node
// Cases for the decision register's computed index (#411): the two awk commands
// `docs/decisions/README.md` documents in place of the index table it used to carry, and
// the property removing that table bought — two issues each adding a numbered decision no
// longer collide in `ci/issue-lint.mts`.
//
// Split out of tests/doctrine.test.mts (#448), which stood at 800 of 800 against the
// `scope` line limit with five issues queued behind it. The boundary is mechanical rather
// than thematic: **tests/doctrine.test.mts is pure-read throughout** — every case there
// reads a tracked file and asserts on its text — and this block is the one that was not.
// Everything else that file pins stayed there, the register's own prose pins (#336, the
// correcting-an-item split) included, because that prose is read and nothing more. The
// rule is stated here in full; that file carries a pointer to it and no second version of
// it, so the two headers cannot disagree (#431).
//
// Invariant 6, where this file is pure-read and where it is not. Pure-read: the cases over
// `docs/decisions/README.md` and `docs/decisions.md`, and the TypeScript scan `numbersIn`
// the commands' output is checked against. Not pure-read: the two documented commands are
// run through `sh -c` the way a reader would run them — over this repository's register and
// over a fixture register written here — and `ci/issue-lint.mts` is spawned for real
// against this repository's tracked tree, because "two pull requests do not collide" is a
// property of that script and no amount of prose settles it.
//
// Invariant 10 is held in the block's own comments below: every expectation is written out
// here rather than read back from the thing it pins.
//
// Negative control: there is no red for the move itself, and none is offered. Nothing here
// changed — every case below passed at the base inside tests/doctrine.test.mts and passes
// here — and a red would mean weakening a pin in order to re-strengthen it. The pull request
// that made this file does carry one, elsewhere: moving the block falsified the seven
// sentences in `docs/decisions.md` and `docs/decisions/README.md` that named the old file as
// the consumer of the two commands, and correcting them under a grant took the diff outside
// the test globs, so the control asked for a consumer and refused it as `vacuous` until it
// had one. That consumer is tests/doctrine.test.mts's `#448` block — pure-read prose, so it
// belongs on that side of the split — and nine of its ten cases are red against the base.
// The base-commit red the #411 block's own comment records below is that issue's history and
// is left as it was written.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, finish, ROOT } from './lib/harness.mts';
import { PATH_WITH_FAKE_GH } from './lib/issue-lint-harness.mts';

/** Collapses every whitespace run to one space, so a wrapped paragraph compares as one line. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Reads a repository file, collapsed to a single line. */
function readNormalized(relative: string): string {
  return normalize(readFileSync(join(ROOT, relative), 'utf8'));
}

/** The register's two documents, as the cases below read them: normalized, because this
 *  prose wraps at ~90 columns and a pinned phrase straddling a line break would otherwise
 *  be unreachable. The commands themselves are compared against the README raw. */
const DECISIONS = join('docs', 'decisions.md');
const DECISIONS_README = join('docs', 'decisions', 'README.md');

const decisions = readNormalized(DECISIONS);
const decisionsReadme = readNormalized(DECISIONS_README);

// --- #411: the register's index is not a file every decision PR must edit ---
// `docs/decisions/README.md` used to carry an index table with one row per item and a
// prose line naming the next free number, and required every pull request that added a
// numbered decision to edit both. That made the file a lock: `ci/issue-lint.mts` refuses
// a claim whose globs overlap an open sibling's, so two issues that owed an item could
// not both hold a grant. Three things are pinned here, in the order the issue asks.
//
// Negative control: the prose cases below red on the base commit — the file still has
// `## Index`, still says the index row is added "in the same diff", and carries neither
// command. The computation and issue-lint cases pass on the base too, which is what makes
// the third one's negative-control leg load-bearing: it shows the lint really does refuse
// the pair when both declare the shared file, so the passing leg is not a case that could
// never fail (docs/workflow.md, `test-only`).
//
// Invariant 10: every expectation below is written out here rather than read from the thing it
// pins — the two commands are this file's own copies, run as such and separately asserted to
// match the README, and the numbers they are checked against come from a scan written here in
// TypeScript rather than from the commands' output. No case names a literal item number: such a
// pin would itself be edited by every pull request that adds an item, which is the lock this
// issue removes. What that cross-check does not catch: awk and TypeScript are two
// implementations, so one drifting from the other reds, but they share one *assumption* — "an
// item is a `#` or `##` heading whose first word is a number, outside a fence" — and a register
// that stopped being shaped that way is misread by both in the same direction, with no case to
// notice. The fixture-register cases answer the two shapes that bit first, and are cases about
// the command rather than about this repository's text. The two-file read is pinned by the
// next-free-number case alone, discriminating only because item 35 lives in
// `docs/decisions.md`: a directory-only derivation returns 0035, which item 35 holds, while
// before it the highest number was also the highest-numbered file. The "carries numbers no
// directory file carries" case is not the pin — items 1 to 13 satisfy it forever and it cannot
// fail. It says what the arrangement is, not that it holds.

/** The register's two sources. The numbering spans both, which is the whole difficulty:
 *  items 1 to 13 and a handful of later exceptions live in the first. */
const DECISIONS_DIR = join(ROOT, 'docs', 'decisions');
const DECISIONS_MD = join(ROOT, 'docs', 'decisions.md');

/** The three characters that open and close a Markdown fence, spelled out: a template
 *  literal cannot carry them, and both commands below have to recognise one. */
const FENCE = '`'.repeat(3);

/** This file's own copy of the command the README documents for the next free number. */
const NEXT_NUMBER_COMMAND =
  `awk 'FNR==1{c=0} substr($0,1,3)=="${FENCE}"{c=!c; next} c{next} /^##? [0-9]+\\. /{n=$0; sub(/^#+ +/,"",n); sub(/\\..*/,"",n); if (n+0>m) m=n+0} END{printf "%04d\\n", m+1}' docs/decisions.md docs/decisions/[0-9]*.md`;

/** This file's own copy of the command the README documents for the status view. */
const STATUS_VIEW_COMMAND =
  `awk 'FNR==1{h="";c=0} substr($0,1,3)=="${FENCE}"{c=!c; next} c{next} /^##? [0-9]+\\. /{h=$0} /^Status:/ && h!=""{print FILENAME" | "h" | "$0}' docs/decisions.md docs/decisions/[0-9]*.md`;

/** Runs a documented command the way a reader would: `sh -c`, from a repository root. */
function shell(command: string, cwd: string = ROOT): { status: number | null; out: string } {
  const r = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Every item number a register file carries, read from its headings — `## 20.` in
 *  `docs/decisions.md`, `# 0034.` in a dated file, and those two depths only. Fenced
 *  blocks are skipped: a heading quoted in one is a quotation, not an item. Written out
 *  here rather than shared with the awk commands above on purpose: a cross-check that
 *  reuses the thing it checks cannot catch it drifting. `0000-template.md` heads with
 *  `# NNNN.`, which carries no digits, so it contributes nothing here and nothing to
 *  either command. */
function numbersIn(text: string): number[] {
  const found: number[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith(FENCE)) fenced = !fenced;
    else if (!fenced) {
      const heading = /^#{1,2} (\d+)\. /.exec(line);
      if (heading !== null) found.push(Number(heading[1]));
    }
  }
  return found;
}

const datedFiles = readdirSync(DECISIONS_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
const dirNumbers = datedFiles.flatMap((f) => numbersIn(readFileSync(join(DECISIONS_DIR, f), 'utf8')));
const mdNumbers = numbersIn(readFileSync(DECISIONS_MD, 'utf8'));
const allNumbers = [...mdNumbers, ...dirNumbers];
const expectedNext = Math.max(...allNumbers) + 1;

// AC1: the next free number is computed, and the computation reads both files.

check('#411 AC1 `0000-template.md` is not an item — its heading carries `NNNN`, not digits', numbersIn(readFileSync(join(DECISIONS_DIR, '0000-template.md'), 'utf8')).length === 0);
check('#411 AC1 docs/decisions.md carries numbers no file under docs/decisions/ carries — the numbering spans both files', mdNumbers.length > 0 && mdNumbers.some((n) => !dirNumbers.includes(n)), `decisions.md: ${mdNumbers.join(',')} / dir: ${dirNumbers.join(',')}`);
check('#411 AC1 no number is carried twice across the two files — a race that hands out a taken number reds here', new Set(allNumbers).size === allNumbers.length, allNumbers.join(','));

const nextRun = shell(NEXT_NUMBER_COMMAND);
const nextPrinted = nextRun.out.trim();
check('#411 AC1 the documented command prints a four-digit number', nextRun.status === 0 && /^\d{4}$/.test(nextPrinted), nextRun.out);
check('#411 AC1 it prints one past the highest number either file carries', Number(nextPrinted) === expectedNext, `printed ${nextPrinted}, expected ${expectedNext}`);
check('#411 AC1 the number it prints is free — no item in either file holds it', !allNumbers.includes(Number(nextPrinted)), `${nextPrinted} in ${allNumbers.join(',')}`);

// AC2: what the index gave a reader is still one command away, over both files.

const statusRun = shell(STATUS_VIEW_COMMAND);
const statusLines = statusRun.out.trim().split('\n').filter(Boolean);
check('#411 AC2 the documented status view prints one line per item', statusRun.status === 0 && statusLines.length === allNumbers.length, `${statusLines.length} lines, ${allNumbers.length} items`);
check('#411 AC2 every line carries a Status:, so a reader sees the status of every item', statusLines.every((l) => l.includes('Status:')), statusRun.out.slice(0, 400));
check('#411 AC2 the view reaches both files', statusLines.some((l) => l.startsWith('docs/decisions.md ')) && statusLines.some((l) => l.startsWith('docs/decisions/0')), statusRun.out.slice(0, 400));
check('#411 AC2 the template is not in the view', !statusRun.out.includes('0000-template.md'), statusRun.out.slice(0, 400));

// AC2: and the README is where both commands are written, verbatim. Read raw, not
// normalized: a command compared with its whitespace collapsed is not the command.

const readmeRaw = readFileSync(join(DECISIONS_DIR, 'README.md'), 'utf8');
const READING_HEADING = '## Reading the register';
check(`#411 AC2 docs/decisions/README.md has a "${READING_HEADING.slice(3)}" section`, readmeRaw.includes(READING_HEADING), readmeRaw.slice(0, 300));
check('#411 AC2 the README carries the next-free-number command verbatim', readmeRaw.includes(NEXT_NUMBER_COMMAND), NEXT_NUMBER_COMMAND);
check('#411 AC2 the README carries the status-view command verbatim', readmeRaw.includes(STATUS_VIEW_COMMAND), STATUS_VIEW_COMMAND);
check('#411 AC2 the README no longer has an `## Index` section', !readmeRaw.includes('## Index'), readmeRaw.slice(-600));
check('#411 AC2 the README no longer writes the next free number down', !/next free number is `?[0-9]/.test(readmeRaw), readmeRaw.slice(0, 600));

check('#411 AC2 the README no longer sends a decision PR to an index row in the same diff', !/adds its line to the index below in the same diff/.test(decisionsReadme), decisionsReadme.slice(0, 600));
check('#411 AC2 the README says such a pull request touches its own file and nothing else', /touches its own file and nothing else/.test(decisionsReadme), decisionsReadme.slice(0, 600));
check('#411 AC2 the README resolves a number to a file by name rather than by a row', /resolves to a file by name/.test(decisionsReadme), decisionsReadme.slice(0, 600));
check('#411 AC2 the README says what the reader loses', /What a reader loses/.test(decisionsReadme), decisionsReadme.slice(0, 600));

// AC2: what is left of the race is stated as it behaves under this repository's own
// configuration, not as the catch a strict policy would give — `test.yml` fires on
// `pull_request` and the ruleset sets `strict_required_status_checks_policy: false`, so a
// green recorded before a sibling merged still counts, against a base nothing re-checks.

for (const [name, text] of [['docs/decisions/README.md', decisionsReadme], ['docs/decisions.md item 35', decisions]] as const) {
  check(`#411 AC2 ${name} does not claim the duplicate is caught before the second lands`, !/rename before/.test(text), text.slice(-1500));
  check(`#411 AC2 ${name} names the precondition the catch assumes`, /strict_required_status_checks_policy/.test(text), text.slice(-1500));
  check(`#411 AC2 ${name} says the case catches the duplicate only when it runs after the sibling landed`, /only when that case runs after the sibling landed/.test(text), text.slice(-1500));
  check(`#411 AC2 ${name} says an earlier green can land the duplicate and red main afterwards`, /reds `main`/.test(text) && /every pull request/.test(text), text.slice(-1500));
}

// AC1: the same two commands against a register written here. The two shapes a
// heading-matching derivation gets wrong: a heading inside a fenced block is not an item,
// and neither is a numbered `###` sub-heading, the register documenting two depths only
// (`# <nnnn>.` in a dated file, `## <n>.` in `docs/decisions.md`).

const fixtureRoot = mkdtempSync(join(tmpdir(), 'agentic-register-fixture-'));
cleanup(() => rmSync(fixtureRoot, { recursive: true, force: true }));
mkdirSync(join(fixtureRoot, 'docs', 'decisions'), { recursive: true });
writeFileSync(join(fixtureRoot, 'docs', 'decisions.md'), [
  '# Decisions', '', '## 7. A real item, in the file that holds the exceptions', '', 'Status: accepted', '',
  '### 8. A numbered sub-heading, which is not an item', '', 'Prose under it.', '',
  '```md', '## 900. A heading quoted inside a fence, which is not an item either', '', 'Status: proposed', '```', '',
].join('\n'));
writeFileSync(join(fixtureRoot, 'docs', 'decisions', '0000-template.md'), '# NNNN. The shape\n\nStatus: proposed\n');
writeFileSync(join(fixtureRoot, 'docs', 'decisions', '0009-a-dated-file.md'), '# 0009. A real item, in a dated file\n\nStatus: proposed\n');

const fixtureNext = shell(NEXT_NUMBER_COMMAND, fixtureRoot);
check('#411 AC1 the next-free-number command counts neither a fenced heading nor a numbered sub-heading', fixtureNext.status === 0 && fixtureNext.out.trim() === '0010', `printed ${fixtureNext.out.trim()}, expected 0010`);
const fixtureStatus = shell(STATUS_VIEW_COMMAND, fixtureRoot);
const fixtureLines = fixtureStatus.out.trim().split('\n').filter(Boolean);
check('#411 AC2 the status view prints the two real items of the fixture register and nothing else', fixtureStatus.status === 0 && fixtureLines.length === 2, fixtureStatus.out);
check('#411 AC2 it prints the item from each file, and neither the fence nor the sub-heading', fixtureLines.some((l) => l.includes('## 7.')) && fixtureLines.some((l) => l.includes('# 0009.')) && !fixtureStatus.out.includes('900.') && !fixtureStatus.out.includes('### 8.'), fixtureStatus.out);

// AC1: the naming rule the README states — `<nnnn>-<slug>.md`, four digits — is what
// makes "a number resolves to a file by name" true, so it is held here rather than
// assumed. A file whose heading and filename disagree resolves to the wrong file.

for (const name of datedFiles) {
  const prefix = /^(\d{4})-[a-z0-9-]+\.md$/.exec(name);
  check(`#411 AC1 docs/decisions/${name} is named <nnnn>-<slug>.md with four digits`, name === '0000-template.md' || prefix !== null, name);
  if (prefix === null || name === '0000-template.md') continue;
  const heading = numbersIn(readFileSync(join(DECISIONS_DIR, name), 'utf8'));
  check(`#411 AC1 docs/decisions/${name} heads with the number its name carries`, heading.length === 1 && heading[0] === Number(prefix[1]), `${name}: heading ${heading.join(',')}`);
}

// AC3: the property this issue exists for, held against the mechanism that enforced the
// lock. Two issues each adding a numbered decision declare their own file and nothing
// shared, so `ci/issue-lint.mts` reports no overlap and no `sequenced` entry — while the
// same two with the index row the README used to require *do* collide, which is what says
// this pass could have failed. The script is spawned for real (invariant 6) against this
// repository's tracked tree, so the control leg's shared file is the real README.

const fixtures = mkdtempSync(join(tmpdir(), 'agentic-register-'));
cleanup(() => rmSync(fixtures, { recursive: true, force: true }));

/** A valid six-section body declaring exactly the given paths under `## Files`. */
function registerIssue(paths: string[]): string {
  return [
    '## Context\nA decision this issue records.\n',
    '## Goal\nRecord it.\n',
    '## Acceptance criteria\n- [ ] AC1 the item is written\n',
    '## Proof\nnpm test covers it.\n',
    `## Files\n${paths.map((p) => `- \`${p}\``).join('\n')}\n`,
    '## Dependencies\nBlocked by: none\n',
  ].join('\n');
}

let fixtureSeq = 0;
function fixture(name: string, content: string): string {
  const p = join(fixtures, `${fixtureSeq++}-${name}`);
  writeFileSync(p, content);
  return p;
}

/** Spawns the real lint for `issue` against a one-issue milestone holding `other`. */
function lintAgainst(issue: number, ownPaths: string[], other: number, otherPaths: string[]) {
  const bodyFile = fixture('body.md', registerIssue(ownPaths));
  const milestoneFile = fixture('milestone.json', JSON.stringify([{ number: other, labels: ['state:ready'], body: registerIssue(otherPaths) }]));
  const r = ci('issue-lint.mts', ['--issue', String(issue), '--issue-body-file', bodyFile, '--milestone-issues-file', milestoneFile], { cwd: ROOT, env: { PATH: PATH_WITH_FAKE_GH } });
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.out);
  } catch {
    parsed = null;
  }
  return { status: r.status, out: r.out, json: parsed };
}

// Numbers no item will ever take, so these fixture paths stay untracked whatever the
// register grows to.
const OWN_A = 'docs/decisions/9001-fixture-a.md';
const OWN_B = 'docs/decisions/9002-fixture-b.md';
const SHARED_INDEX = 'docs/decisions/README.md';

for (const [self, selfPath, other, otherPath] of [[9001, OWN_A, 9002, OWN_B], [9002, OWN_B, 9001, OWN_A]] as const) {
  const run = lintAgainst(self, [selfPath], other, [otherPath]);
  check(`#411 AC3 #${self} adding its own decision file does not overlap #${other} adding its own`, run.status === 0 && run.json?.ok === true && (run.json?.failures ?? []).length === 0, run.out);
  check(`#411 AC3 #${self} against #${other} needs no Blocked-by order — nothing is reported as sequenced`, Array.isArray(run.json?.sequenced) && run.json.sequenced.length === 0, run.out);
  check(`#411 AC3 the disjointness check actually compared #${self} against #${other}`, run.json?.disjointness?.checked === true && run.json?.disjointness?.compared === 1, run.out);
}

const locked = lintAgainst(9001, [OWN_A, SHARED_INDEX], 9002, [OWN_B, SHARED_INDEX]);
check('#411 AC3 negative control: the same two issues collide when both also declare the index file', locked.status === 1 && locked.json?.ok === false, locked.out);
check('#411 AC3 negative control: the overlap the lint names is the index file itself', (locked.json?.failures ?? []).some((f: any) => f?.issue === 9002 && Array.isArray(f?.files) && f.files.includes(SHARED_INDEX)), locked.out);

// AC1 again, at the other end: `docs/decisions.md` still announces the register's rule,
// and no longer points at a table for which item lives where.

const decisionsIntro = decisions.slice(0, 1200);
check('#411 AC1 docs/decisions.md no longer names the index as the authority on which item lives where', !/The index in \[`decisions\/README\.md`\]/.test(decisionsIntro), decisionsIntro.slice(0, 900));
check('#411 AC1 docs/decisions.md sends a reader to the command instead', /Reading the register/.test(decisionsIntro), decisionsIntro.slice(0, 900));

finish();
