#!/usr/bin/env node
// Proves tests/run.mts discovers tests/*.test.mts (sorted), runs each with
// the runtime that launched it, aggregates the counts, and exits non-zero
// on any failure. Runs the real runner against a temp directory holding a
// passing file, a failing file, a file whose stderr contains a summary-
// shaped decoy, and a non-test helper it must ignore.
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
writeFileSync(
  join(dir, 'a.test.mts'),
  "console.error('FAIL  something broke\\n      wanted true, got false');\nconsole.log(`1 passed, 1 failed (${process.argv[0].split('/').pop()})`);\nprocess.exit(1);\n",
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

const r = spawnSync(RUNTIME, [join(ROOT, 'tests', 'run.mts'), dir], { encoding: 'utf8' });
const out = `${r.stdout}${r.stderr}`;

check('run.mts exits non-zero when a discovered file fails', r.status !== 0, out);
check('run.mts runs the passing file', /b\.test\.mts[\s\S]*3 passed, 0 failed/.test(out), out);
check('run.mts runs the failing file', /a\.test\.mts[\s\S]*1 passed, 1 failed/.test(out), out);
check('run.mts discovers files in sorted order (a before b)', out.indexOf('a.test.mts') < out.indexOf('b.test.mts'), out);
check('run.mts ignores files that are not *.test.mts', !/helper\.mts/.test(out), out);
check('run.mts prints an aggregate line summing all files (5 passed, 1 failed)', /\b5 passed, 1 failed\b/.test(out), out);
check('run.mts spawns test files with the runtime that launched it', out.includes(`1 passed, 1 failed (${RUNTIME.split('/').pop()})`), out);
check(
  'run.mts parses the summary from stdout only, ignoring a look-alike line on stderr',
  /c\.test\.mts: 1 passed, 0 failed/.test(out) && !/9 passed, 9 failed/.test(out),
  out,
);

finish();
