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

const SUMMARY = /(\d+) passed, (\d+) failed/g;

/**
 * A line a test file means an operator to read even when the file passes:
 * `note` at the start of the line, then whitespace. `tests/provenance.test.mts`
 * writes `note  provenance: ...` for each check it skipped and why.
 */
const NOTE = /^note\s/;

/** Returns the last "N passed, M failed" match in text, or null if there is none. */
function lastSummary(text: string): { passed: number; failed: number } | null {
  let last: RegExpExecArray | null = null;
  for (const m of text.matchAll(SUMMARY)) last = m;
  return last ? { passed: Number(last[1]), failed: Number(last[2]) } : null;
}

let totalPassed = 0;
let totalFailed = 0;
let anyFailed = false;

for (const file of files) {
  const r = spawnSync(runtime, [join(dir, file)], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  const summary = lastSummary(r.stdout ?? '');

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
    for (const line of out.split('\n')) {
      if (NOTE.test(line)) console.log(`${file}: ${line}`);
    }
  }
}

console.log(`${totalPassed} passed, ${totalFailed} failed (${runtime.split('/').pop()})`);
process.exit(anyFailed ? 1 : 0);
