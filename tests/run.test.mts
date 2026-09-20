#!/usr/bin/env node
// Proves tests/run.mts discovers tests/*.test.mts (sorted), runs each with
// the runtime that launched it, aggregates the counts, and exits non-zero
// on any failure. Runs the real runner against a temp directory holding a
// passing file, a failing file, a file whose stderr contains a summary-
// shaped decoy, a passing file that emits both a `note` line and ordinary
// chatter, three files whose notes are shaped so that a runner reading its
// child's two streams as one string loses them, and a non-test helper it
// must ignore.
//
// The note fixture and the failure fixture pin the two halves of #382: a
// passing file's `note` lines reach the log while the rest of its output
// does not, and a failing file still prints in full, its own note included
// exactly once. The `e`, `f` and `h` fixtures pin #429: a note is more than
// its first line, and neither of the two streams may be allowed to run into
// the other. Their stream shapes are the point, so none of them ends its
// stdout with a tidy newline where the case says it must not. The expected
// shapes are written out here as literal text rather than imported from
// run.mts, so a change to the runner's marker, its prefix, its continuation
// rule or its summary handling fails this file.
//
// The marked continuation is pinned in both directions — the marked shape
// present and the bare shape absent — because the marker is what a filter
// over this log keys on (#428), and a pin that only asked for the text would
// pass against a runner that printed the line bare.
//
// The `i`, `j` and `k` fixtures pin #439: a file's reported result comes from
// the summary line it printed as such, not from summary-shaped text it
// happened to write somewhere else. Each of the three really passes one case
// and writes one stray count — before its real summary, after it, and inside
// a note — and each is pinned twice: the real count present and the stray
// count absent under that file's name, because a pin that only asked for the
// real count would pass against a runner that printed both. The aggregate is
// pinned as literal text for the same reason: it is built from the per-file
// counts, so a stray one of them reaches it.
//
// The `g` fixture is #439's own regression case and pins the two rules
// against each other: it holds a stray count that *does* start a line and a
// real summary that does not, because the note above it was never
// terminated. Preferring any line-starting summary reports the stray and
// puts the real summary back inside the printed note, which is the #429
// defect the `e` fixture exists to keep out. Its stream shape is the point;
// do not tidy the missing newline. The `p` fixture pins the rank above both:
// its stray ends its line with the runtime parenthetical, exactly as the
// protocol line does, so only "the line is nothing but the summary"
// separates them. Without `p`, a runner ranking by ends-a-line alone passes
// every other case here. The `n` fixture is the trailing-whitespace boundary
// of the rank above that: its own summary line ends with a space, so a rule
// that asked for a bare end-of-line would drop it under the rank-2 stray
// above it. Base reports `n` correctly, so a runner that fails this check
// has regressed against the rule it replaced.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, cleanup, finish, ROOT, RUNTIME } from './lib/harness.mts';

const dir = mkdtempSync(join(tmpdir(), 'agentic-runner-'));
cleanup(() => rmSync(dir, { recursive: true, force: true }));

// Named so creation order differs from sort order: "b" is written first.
writeFileSync(
  join(dir, 'b.test.mts'),
  "console.log(`3 passed, 0 failed (${process.argv[0].split('/').pop()})`);\nprocess.exit(0);\n",
);
// Fails, and also carries a `note` line, so the failing branch is pinned
// against printing that note a second time on top of the full output.
writeFileSync(
  join(dir, 'a.test.mts'),
  "console.error('note  a: a failing file says this once, with the rest');\n" +
    "console.error('FAIL  something broke\\n      wanted true, got false');\n" +
    "console.log(`1 passed, 1 failed (${process.argv[0].split('/').pop()})`);\n" +
    'process.exit(1);\n',
);
// Not a *.test.mts file: the runner must not pick it up.
writeFileSync(join(dir, 'helper.mts'), "throw new Error('the runner must never execute this file');\n");
// Its stderr contains a summary-shaped line that is not the real result, to
// prove the runner parses the summary from stdout only (not stdout+stderr).
writeFileSync(
  join(dir, 'c.test.mts'),
  "console.error('FAIL  something (9 passed, 9 failed)');\n" +
    "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    'process.exit(0);\n',
);
// Passes, and means to say something while passing: one `note` line an
// operator must see, and one ordinary line that must stay out of a green run.
writeFileSync(
  join(dir, 'd.test.mts'),
  "console.error('note  d: the live half was skipped, so this file says why');\n" +
    "console.log('chatter no operator asked for');\n" +
    "console.log(`2 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    'process.exit(0);\n',
);

// Passes, and writes a note whose detail lives on a second, indented line —
// the shape a `FAIL` detail already uses. Truncating it to the first line
// drops exactly the part an operator needs. The unindented line after it is
// on the same stream and must still be discarded: a note ends somewhere.
writeFileSync(
  join(dir, 'f.test.mts'),
  "console.error('note  multi: first line\\n      continuation with the detail that matters');\n" +
    "console.error('stderr chatter under the note, unindented, and no part of it');\n" +
    "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    'process.exit(0);\n',
);
// Passes, and ends its stdout without a trailing newline, then writes its
// note to stderr. A runner that concatenates the two streams glues the note
// onto the tail of the summary line and never sees a line starting `note`.
// The missing newline is the case: do not tidy it.
writeFileSync(
  join(dir, 'h.test.mts'),
  "process.stdout.write(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    "console.error('note  h: a note on stderr after a newline-less stdout');\n" +
    'process.exit(0);\n',
);
// Passes, and writes its note to stdout without terminating the line, so the
// summary that follows lands on the same line. The runner reprints that
// summary itself, so it must not also ride into the log inside the note.
// The missing newline is the case: do not tidy it.
writeFileSync(
  join(dir, 'e.test.mts'),
  "process.stdout.write('note  glued: stdout has no trailing newline');\n" +
    "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    'process.exit(0);\n',
);

// Passes one case, and is both shapes at once: a summary-shaped line at the
// start of a line, and then its real summary glued onto a note whose line was
// never terminated. So no line of its stdout starts with *its own* count,
// while one does start with a count that is not its result. A runner that
// prefers any line-starting summary reports the stray and lets the real
// summary ride into the printed note. The missing newline is the case: do not
// tidy it.
writeFileSync(
  join(dir, 'g.test.mts'),
  "console.log('3 passed, 0 failed  <- the count this file is not reporting');\n" +
    "process.stdout.write('note  g: stdout has no trailing newline either');\n" +
    "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    'process.exit(0);\n',
);
// Passes one case, and writes a summary-shaped line of its own *before* it —
// a quoted count at the very start of a line, which is the one place the
// runner's own summaries appear. Only "the last one" tells the two apart
// here, so this file pins that anchoring did not become "the first one".
writeFileSync(
  join(dir, 'i.test.mts'),
  "console.log('3 passed, 0 failed  <- the count this file is not reporting');\n" +
    "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    'process.exit(0);\n',
);
// Passes one case, and writes a summary-shaped line *after* it: an indented
// quoted expectation, the shape a test writes when it says what some other
// run should print. A runner taking the last summary-shaped text anywhere in
// stdout reports this file as `3 passed, 0 failed`.
writeFileSync(
  join(dir, 'j.test.mts'),
  "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    "console.log('  expected 3 passed, 0 failed from the run this file read');\n" +
    'process.exit(0);\n',
);
// Passes one case, and says so in a note that quotes *another* run's counts,
// on stdout and after its own summary. The stray count is non-zero, so a
// runner reading it as this file's result also reports failures nobody had,
// and removing that "summary" from the note truncates the note at it.
writeFileSync(
  join(dir, 'k.test.mts'),
  "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    "console.log('note  k: the run it read reported 2 passed, 3 failed, which is not this result');\n" +
    'process.exit(0);\n',
);

// Passes one case, and ends its own summary line with a trailing space —
// which the protocol does not ask for and does not forbid. A runner that
// asks whether a summary ends its line has to allow that whitespace, or the
// file's real summary drops below a stray that ends its line cleanly. The
// trailing space is the case: do not tidy it.
writeFileSync(
  join(dir, 'n.test.mts'),
  "console.log('note  n: the run it read reported 3 passed, 0 failed (node)');\n" +
    "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()}) `);\n" +
    'process.exit(0);\n',
);
// Passes one case, and quotes another run's count in a note *carrying the
// runtime parenthetical*, so the stray ends its line exactly as the protocol
// line does. Only "the line is nothing but the summary" tells the two apart:
// a runner that ranks by ends-a-line alone takes the stray, because it comes
// last. This file is the pin for that rank.
writeFileSync(
  join(dir, 'p.test.mts'),
  "console.log(`1 passed, 0 failed (${process.argv[0].split('/').pop()})`);\n" +
    "console.log('note  p: the run it read reported 3 passed, 0 failed (node)');\n" +
    'process.exit(0);\n',
);

const r = spawnSync(RUNTIME, [join(ROOT, 'tests', 'run.mts'), dir], { encoding: 'utf8' });
const out = `${r.stdout}${r.stderr}`;

check('run.mts exits non-zero when a discovered file fails', r.status !== 0, out);
check('run.mts runs the passing file', /b\.test\.mts[\s\S]*3 passed, 0 failed/.test(out), out);
check('run.mts runs the failing file', /a\.test\.mts[\s\S]*1 passed, 1 failed/.test(out), out);
check('run.mts discovers files in sorted order (a before b)', out.indexOf('a.test.mts') < out.indexOf('b.test.mts'), out);
check('run.mts ignores files that are not *.test.mts', !/helper\.mts/.test(out), out);
check('run.mts prints an aggregate line summing all files (16 passed, 1 failed)', /\b16 passed, 1 failed\b/.test(out), out);
check('run.mts spawns test files with the runtime that launched it', out.includes(`1 passed, 1 failed (${RUNTIME.split('/').pop()})`), out);
check(
  'run.mts parses the summary from stdout only, ignoring a look-alike line on stderr',
  /c\.test\.mts: 1 passed, 0 failed/.test(out) && !/9 passed, 9 failed/.test(out),
  out,
);
check(
  "run.mts prints a passing file's note lines, prefixed with that file's name",
  out.includes('d.test.mts: note  d: the live half was skipped, so this file says why'),
  out,
);
check(
  "run.mts still discards the rest of a passing file's output",
  !out.includes('chatter no operator asked for'),
  out,
);
check(
  'run.mts still prints a failing file in full, detail lines included',
  out.includes('FAIL  something broke\n      wanted true, got false'),
  out,
);
check(
  "run.mts prints a failing file's note once, with that file's output, not again",
  out.split('note  a: a failing file says this once, with the rest').length - 1 === 1,
  out,
);

check(
  "run.mts prints a multi-line note whole, every line carrying the same file's name",
  out.includes('f.test.mts: note  multi: first line\n') &&
    out.includes('f.test.mts: note      continuation with the detail that matters'),
  out,
);
check(
  'run.mts keeps the note marker on a continuation line, so no line it adds to the log is unmarked',
  out.includes('f.test.mts: note      continuation with the detail that matters') &&
    !out.includes('f.test.mts:       continuation with the detail that matters'),
  out,
);
check(
  'run.mts ends a note at the first unindented line of the same stream',
  !out.includes('stderr chatter under the note, unindented, and no part of it'),
  out,
);
check(
  "run.mts prints a note on stderr even when the file's stdout has no trailing newline",
  out.includes('h.test.mts: note  h: a note on stderr after a newline-less stdout'),
  out,
);
check(
  'run.mts does not let the summary ride into a note whose stdout line was never terminated',
  out.includes('e.test.mts: note  glued: stdout has no trailing newline\n') &&
    !out.includes('newline1 passed'),
  out,
);
check(
  "run.mts still prints its own summary line for a file whose note ran into it",
  out.includes('e.test.mts: 1 passed, 0 failed'),
  out,
);

check(
  'run.mts reports a file by its own summary, not by a summary-shaped line it wrote before it',
  out.includes('i.test.mts: 1 passed, 0 failed') && !out.includes('i.test.mts: 3 passed, 0 failed'),
  out,
);
check(
  'run.mts reports a file by its own summary, not by a summary-shaped line it wrote after it',
  out.includes('j.test.mts: 1 passed, 0 failed') && !out.includes('j.test.mts: 3 passed, 0 failed'),
  out,
);
check(
  'run.mts reports a file by its own summary, not by a summary-shaped fragment inside its note',
  out.includes('k.test.mts: 1 passed, 0 failed') && !out.includes('k.test.mts: 2 passed, 3 failed'),
  out,
);
check(
  "run.mts leaves a note whole when the note's own text is summary-shaped",
  out.includes('k.test.mts: note  k: the run it read reported 2 passed, 3 failed, which is not this result'),
  out,
);
check(
  'run.mts prefers a summary glued onto an unterminated note over a stray one that does start a line',
  out.includes('g.test.mts: 1 passed, 0 failed') && !out.includes('g.test.mts: 3 passed, 0 failed'),
  out,
);
check(
  'run.mts keeps a glued summary out of the note even when the file also wrote a line-starting stray',
  out.includes('g.test.mts: note  g: stdout has no trailing newline either\n') &&
    !out.includes('newline either1 passed'),
  out,
);
check(
  'run.mts prefers the summary that is a whole line over a stray that merely ends one',
  out.includes('p.test.mts: 1 passed, 0 failed') && !out.includes('p.test.mts: 3 passed, 0 failed'),
  out,
);
check(
  'run.mts leaves a note whole when its stray count carries the runtime parenthetical',
  out.includes('p.test.mts: note  p: the run it read reported 3 passed, 0 failed (node)'),
  out,
);
check(
  "run.mts reads a file's own summary even when that line ends with trailing whitespace",
  out.includes('n.test.mts: 1 passed, 0 failed') && !out.includes('n.test.mts: 3 passed, 0 failed'),
  out,
);
check(
  'run.mts leaves a note whole when the summary line after it carries trailing whitespace',
  out.includes('n.test.mts: note  n: the run it read reported 3 passed, 0 failed (node)'),
  out,
);
finish();
