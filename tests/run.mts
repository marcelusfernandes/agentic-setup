#!/usr/bin/env node
// Discovers tests/*.test.mts (sorted) and runs each in its own child process
// with the runtime that launched this file (process.argv[0]), so it works
// under both `node tests/run.mts` and `bun tests/run.mts`. Each test file is
// expected to print "N passed, M failed (<runtime>)" as its last line and
// exit non-zero on failure; this file prints one such line per test file
// plus a final aggregate line, and exits non-zero if any file failed.
//
// A failing file's output is printed in full. A passing file's is not: the
// suite is forty-odd files and a wall of green chatter is a log nobody
// reads, and tests/run.test.mts pins that a passing file's stderr stays out
// (the summary-shaped decoy in its `c.test.mts` fixture). The exception is
// the NOTE marker below: a line a passing file addresses to an operator
// rather than to itself. #356 asked that a live check which cannot answer
// skip rather than fail, because "a skip that says why is information" —
// and information a green run discards reaches nobody (#382). So a passing
// file's `note` lines, and only those, survive to the log, each prefixed
// with the file that said it. What a file marks is what it prints, so the
// volume is the suite's own choice and not this file's to cap.
//
// Where a child's summary may appear, stated here because a note author who
// does not know the rule pays for it in a wrong count (#439). A summary is
// `N passed, M failed` on the child's stdout, and of the several a file may
// write, the one read is the one that is most of its own line — a whole line
// first, then one that ends a line, then one that starts a line, then, only
// if nothing better exists, summary-shaped text sitting inside a line. `rank`
// below is that order; the last match of the winning rank is taken, since a
// file's summary is its last line. A child that terminates its lines prints a
// whole line and never leaves that top rank, so text it quotes in a note, in
// an expectation, or from another run's result loses to it and is not read as
// its result.
//
// Before this rule the last summary-shaped text anywhere won, so a file that
// passed one case and mentioned `3 passed, 0 failed` afterwards was reported
// as passing three, and one that quoted a non-zero count was reported as
// failing that many: counts nobody had, in the aggregate below and in
// ci/negative-control.mts, which reads this log. Ranking rather than
// anchoring is what the lower ranks are for. A file that writes a note
// without terminating the line leaves its summary in the middle of that line
// — the `e` and `g` fixtures in tests/run.test.mts — and anchoring alone
// reports it as CRASHED and hands the summary back to the printed note,
// which is the #429 defect. `g` is why the ranks are ordered this way and not
// by anchoring first: it holds a stray that starts a line *and* a real
// summary that only ends one, and the real summary has to win.
//
// Three things the rule still lets through, none of them new here. A stray
// that is a whole line of its own is indistinguishable from the protocol
// line, so one written after the real summary is read instead of it. A file
// that prints no summary at all but does write summary-shaped text is
// reported by that text, as a *passing* file if the text says `0 failed`,
// where it would otherwise be `CRASHED`. And whichever match is read is cut
// out of the note scan below from the match to the end of its line, so on the
// lowest rank that cut lands inside a note and truncates it there. All three
// end at the same place: terminate the line, and the top rank applies.
//
// A note is everything the file marked, not its first line. A line that
// begins with whitespace and follows a note line, or another such line, is
// that note's continuation and is printed under the same file name; the note
// ends at the first line that is blank or unindented. That is the shape a
// FAIL detail already uses in tests/lib/harness.mts, so an author writing a
// note is not asked to learn a second one — with one difference that is not
// cosmetic: that precedent is capped (DETAIL_TAIL, six tail lines, seven
// when an error header above the cut is carried down with them) and this
// rule caps at nothing. The cap is not copied for the reason no cap was put
// on notes in the first place (#382) — a cap discards exactly the detail the
// note exists to carry, silently, which is the defect #429 is about — so a
// note is as long as the file made it.
//
// Every line this file prints for a passing child carries the marker,
// continuations included: a continuation goes out as `note` followed by the
// line as the file wrote it, which always begins with whitespace because
// that is what made it a continuation. Bare continuations were the first
// spelling and were wrong. ci/negative-control.mts reads this log as
// evidence, and #428 — which exists because a passing file's note can flip
// that check's verdict — records that attributing within a diagnostic block
// cannot discriminate here, since this whole listing is one block with no
// blank lines. That leaves the marker as the only discriminator a fix can
// key on, and an unmarked line would sit outside it.
//
// What that does not buy, stated plainly because the record should not claim
// otherwise: it does not close the hole, and the hole is not new. A note has
// always been able to carry a source location, and `locatesOverlay` turns
// one into `located`, which makes every unattributed failure in the block
// `owned` and empties `elsewhere` — measured as `unattributed` becoming
// `pass`, losing the warning that would have named the unrelated red. That
// path runs on the runner as it stood before this rule existed. Marking
// continuations only keeps the whole of the exposure inside one
// discriminator, so #428 can close it in one move rather than two.
//
// The rejected alternative was to keep truncating at the first line and say
// so here (#429). It lost on the merits. Both notes this repository writes
// today flatten by hand — `.split('\n')[0]` in `classifyGhFailure` and in
// the clone note of tests/provenance.test.mts — and what they drop is `gh`'s
// or `git`'s own error, which is the whole reason the note exists. A rule
// that an author has to pre-flatten to obey costs a line every time someone
// forgets it, and the loss is silent, which is how #429 was found. The cost
// of the rule chosen instead is stated rather than hidden: an indented line
// that happens to sit directly under a note is printed too.
//
// The child's two streams are read separately for notes, never joined. A
// child that ends its stdout without a newline used to have its stderr glued
// onto that last line, so a note at the top of stderr began mid-line, no
// longer started one, and was dropped with no sign of it. For the same
// reason the summary matched below is removed from stdout before the note
// scan: a file that writes its note without terminating the line leaves the
// summary on that line, and this file's own protocol line must not reach the
// log a second time riding inside a note. The failing branch still prints
// both streams verbatim — there, the run's readers want what the child said,
// in the order it said it.
//
// Reading the streams apart does not reorder a passing file's notes: `out`
// was already stdout followed by stderr, so notes were already grouped by
// stream. What changed is that a note at the head of stderr is no longer
// glued onto an unterminated stdout tail and lost.
//
// Takes an optional directory argument (default: this file's own directory)
// so tests/run.test.mts can point it at a temp directory instead of tests/.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
const runtime = process.argv[0];

const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.mts'))
  .sort();

/** Summary-shaped text, wherever in a child's output it sits. */
const SUMMARY = /(\d+) passed, (\d+) failed/g;

/**
 * What a summary may be followed by and still be the end of its line: the
 * runtime parenthetical this protocol's own line carries, or nothing.
 */
const SUMMARY_TAIL = /^(?: \([^()\n]*\))?$/;

/**
 * A line a test file means an operator to read even when the file passes:
 * `note` at the start of the line, then whitespace. `tests/provenance.test.mts`
 * writes `note  provenance: ...` for each check it skipped and why.
 */
const NOTE = /^note\s/;

/** A note's continuation: an indented, non-empty line under the note it belongs to. */
const CONTINUATION = /^\s+\S/;

/**
 * How much of its own line a summary-shaped match is, which is the whole of
 * what this file knows about whether the child printed it as a summary:
 *
 *   3  the line is the summary, and nothing else but the runtime parenthetical
 *   2  the summary ends the line — something unterminated runs into it
 *   1  the summary starts the line — something quoted follows it
 *   0  neither: summary-shaped text sitting inside a line
 *
 * The protocol line is printed by `console.log`, so a child that ends its
 * lines scores 3 every time. The lower ranks exist for the child that does
 * not, and are ordered by how little of the line is someone else's text.
 */
function rank(text: string, match: RegExpExecArray): number {
  const startsLine = match.index === 0 || text[match.index - 1] === '\n';
  const after = match.index + match[0].length;
  const eol = text.indexOf('\n', after);
  const endsLine = SUMMARY_TAIL.test(text.slice(after, eol < 0 ? undefined : eol));
  return (startsLine ? 1 : 0) + (endsLine ? 2 : 0);
}

/**
 * The match this file reads a child's result from: of the summary-shaped text
 * in `text`, the highest-ranked, and the last of those; or null if there is
 * none. See the header for what each rank admits and what it lets through.
 */
function lastSummary(text: string): RegExpExecArray | null {
  let best: RegExpExecArray | null = null;
  let bestRank = -1;
  for (const m of text.matchAll(SUMMARY)) {
    const r = rank(text, m);
    if (r < bestRank) continue;
    best = m;
    bestRank = r;
  }
  return best;
}

/**
 * `stdout` with the summary this file reprints removed, from the match to the
 * end of the line carrying it. A file that writes a note without terminating
 * the line leaves the summary on that same line, and a note is not the place
 * for a second copy of the one line this log's readers trust.
 */
function withoutSummary(stdout: string, match: RegExpExecArray | null): string {
  if (match === null) return stdout;
  const eol = stdout.indexOf('\n', match.index);
  return stdout.slice(0, match.index) + (eol < 0 ? '' : stdout.slice(eol));
}

/**
 * Prints the note lines in one stream of `file`'s output, continuation lines
 * included, each on its own line under that file's name and each carrying the
 * marker. A continuation begins with whitespace by definition, so prefixing
 * the bare marker to it always leaves a line `NOTE` itself matches.
 */
function printNotes(file: string, text: string): void {
  let inNote = false;
  for (const line of text.split('\n')) {
    if (NOTE.test(line)) {
      inNote = true;
      console.log(`${file}: ${line}`);
      continue;
    }
    if (!inNote || !CONTINUATION.test(line)) {
      inNote = false;
      continue;
    }
    console.log(`${file}: note${line}`);
  }
}

let totalPassed = 0;
let totalFailed = 0;
let anyFailed = false;

for (const file of files) {
  const r = spawnSync(runtime, [join(dir, file)], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const match = lastSummary(r.stdout ?? '');
  const summary = match === null ? null : { passed: Number(match[1]), failed: Number(match[2]) };

  if (r.status !== 0) anyFailed = true;

  if (summary) {
    totalPassed += summary.passed;
    totalFailed += summary.failed;
    if (summary.failed > 0) anyFailed = true;
    console.log(`${file}: ${summary.passed} passed, ${summary.failed} failed`);
  } else {
    anyFailed = true;
    totalFailed += 1;
    console.log(`${file}: CRASHED (exit ${r.status})`);
  }
  if (r.status !== 0 || (summary && summary.failed > 0)) {
    process.stdout.write(out);
  } else {
    printNotes(file, withoutSummary(r.stdout ?? '', match));
    printNotes(file, r.stderr ?? '');
  }
}

console.log(`${totalPassed} passed, ${totalFailed} failed (${runtime.split('/').pop()})`);
process.exit(anyFailed ? 1 : 0);
