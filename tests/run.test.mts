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

const r = spawnSync(RUNTIME, [join(ROOT, 'tests', 'run.mts'), dir], { encoding: 'utf8' });
const out = `${r.stdout}${r.stderr}`;

check('run.mts exits non-zero when a discovered file fails', r.status !== 0, out);
check('run.mts runs the passing file', /b\.test\.mts[\s\S]*3 passed, 0 failed/.test(out), out);
check('run.mts runs the failing file', /a\.test\.mts[\s\S]*1 passed, 1 failed/.test(out), out);
check('run.mts discovers files in sorted order (a before b)', out.indexOf('a.test.mts') < out.indexOf('b.test.mts'), out);
check('run.mts ignores files that are not *.test.mts', !/helper\.mts/.test(out), out);
check('run.mts prints an aggregate line summing all files (10 passed, 1 failed)', /\b10 passed, 1 failed\b/.test(out), out);
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

finish();
