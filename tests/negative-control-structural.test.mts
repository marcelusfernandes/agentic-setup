#!/usr/bin/env node
// The structural-versus-runtime distinction, on this repository's own harness
// output (#297, AC1 and AC2). `tests/run.mts` discovers every
// `tests/*.test.mts` in this directory, so this file is picked up by the
// suite without being listed anywhere.
//
// `ci/negative-control.mts` tells a structural red — the overlaid files could
// not even load — from an assertion red, and on this repository the
// distinction never operated. Measured during the review of PR #236: the base
// run with `tests/proof.test.mts` overlaid failed with `MODULE_NOT_FOUND` 79
// times, CI printed no `warning:` line, and the `test(red):` vouch was never
// consulted. The cause is one line of `tests/lib/harness.mts`: a failure's
// detail was truncated to its last six lines, and Node prints
// `Error: Cannot find module …` about ten lines above that, so the header
// `STRUCTURAL_SIGNATURE` matches never reached the output the check reads.
// What survived — `code: 'MODULE_NOT_FOUND'` — is deliberately not in that
// signature: `MODULE_NOT_FOUND` without the `ERR_` prefix is the CommonJS
// loader's property name and appears in ordinary logs.
//
// Both cases below spawn the real thing (CLAUDE.md invariant 6): the first
// runs a fixture test file that imports `tests/lib/harness.mts` itself and
// fails on a genuine spawn of an absent module, and the second spawns
// `ci/negative-control.mts` against a throwaway git repository whose overlaid
// run reproduces that same shape. Neither asserts against a synthetic string,
// which is what AC2 asks for: a pin written against a hand-made
// `Cannot find module` line would pass on the base, where the header is
// truncated away, and prove nothing about the harness at all.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, ci, commit, finish, git, tempRepo, ROOT, RUNTIME } from './lib/harness.mts';

/** The real harness, copied into every fixture repository below. */
const HARNESS = readFileSync(join(ROOT, 'tests', 'lib', 'harness.mts'), 'utf8');

/** A fixture test file that fails on a real spawn of a module that is absent. */
const failingOnAbsentModule = (module: string): string => [
  "import { spawnSync } from 'node:child_process';",
  "import { check, finish } from './lib/harness.mts';",
  `const r = spawnSync(process.argv[0], ['${module}'], { encoding: 'utf8' });`,
  "check('the module under test runs', r.status === 0, `${r.stdout}${r.stderr}`);",
  'finish();',
].join('\n');

// A note on the case names below, because the omission is deliberate: none of
// them quotes `Cannot find module` literally, although that is exactly what
// they are about. A failing case prints its name, `tests/run.mts` prints the
// file's `N passed, M failed` line immediately above it with no blank line
// between, and `structuralInOverlay` reads a diagnostic *block* — so a case
// name carrying the signature sits in the same block as the overlaid file's
// own name and reports this pull request's honest red as `structural`. That
// is the prose-mention hazard `ci/negative-control.mts` documents on
// `overlayNames`, measured here: with the literal string in two case names
// this branch's own negative control passed with a `warning:` that described
// nothing real. The assertions still match the literal header; only the names
// avoid it.

// --- AC1: the error header survives the truncation -------------------------
// The detail a failure carries is truncated, and must stay truncated — the
// whole point of the tail is that a suite's FAIL lines stay readable. What
// changes is that the error name and the first line of its message are
// printed ahead of that tail, so a header ten lines above it is no longer
// lost. The case asserts all three: the header is there, the tail is still
// there, and the header comes first.
const pinRepo = tempRepo();
mkdirSync(join(pinRepo, 'tests', 'lib'), { recursive: true });
writeFileSync(join(pinRepo, 'tests', 'lib', 'harness.mts'), HARNESS);
writeFileSync(join(pinRepo, 'tests', 'one.test.mts'), failingOnAbsentModule('./absent-module.mts'));
const pin = spawnSync(RUNTIME, [join(pinRepo, 'tests', 'one.test.mts')], { cwd: pinRepo, encoding: 'utf8' });
const pinOut = `${pin.stdout}${pin.stderr}`;
const pinLines = pinOut.split('\n');
const headerAt = pinLines.findIndex((line) => line.includes('Cannot find module'));
const tailAt = pinLines.findIndex((line) => line.includes('MODULE_NOT_FOUND'));

check('the fixture failure is a real MODULE_NOT_FOUND, not a synthetic string', tailAt >= 0, pinOut);
check("a failure's detail carries the missing-module header, not only its tail", headerAt >= 0, pinOut);
check("a failure's detail still carries the truncated tail", tailAt >= 0, pinOut);
check(
  'the error header is printed ahead of the tail, not inside it',
  headerAt >= 0 && tailAt >= 0 && headerAt < tailAt,
  `header at ${headerAt}, tail at ${tailAt}\n${pinOut}`,
);
check('the detail is still truncated rather than printed whole', !pinOut.includes('at wrapModuleLoad'), pinOut);

// --- AC2: the check reads that header as `structural` ----------------------
// The fixture reproduces the PR #236 shape end to end. The base carries the
// real harness and a test file that passes; the head replaces that test file
// with one that spawns `scripts/added.mts`, which only the head has. Overlay
// the head's test file on the base and the spawn fails with
// `Cannot find module`, through the harness, exactly as #236 measured.
//
// `scripts/added.mts` is a file the diff touches, so the diagnostic block
// naming it is a block that names the overlay — which is what
// `structuralInOverlay` requires beyond the signature itself (#214).
const structural = tempRepo();
const structuralBase = commit(structural, {
  'package.json': JSON.stringify({ name: 'x', private: true, scripts: { test: 'node tests/one.test.mts' } }),
  'tests/lib/harness.mts': HARNESS,
  'tests/one.test.mts': "import { check, finish } from './lib/harness.mts';\ncheck('nothing to prove yet', true);\nfinish();\n",
}, 'chore: base');

git(['checkout', '-q', '-b', 'fix/1-structural', structuralBase], structural);
const structuralHead = commit(structural, {
  'scripts/added.mts': 'process.exit(0);\n',
  'tests/one.test.mts': failingOnAbsentModule('./scripts/added.mts'),
}, 'fix: spawn a script the base does not have');

const nc = (head: string, base = structuralBase, cwd = structural) =>
  ci('negative-control.mts', ['--base', base, '--head', head], { cwd });

let r = nc(structuralHead);
check(
  'an overlaid run whose harness output carries the missing-module header is `structural`',
  r.status === 1 && /negative-control: structural/.test(r.out),
  r.out,
);
check(
  'the `structural` detail says the file could not run there at all',
  /could not run there at all/.test(r.out) && /tests\/one\.test\.mts/.test(r.out),
  r.out,
);

// The vouch still decides it. The same red, with a `test(red):` commit in
// `base..head` touching the overlaid file, is a pass carrying the warning —
// so making the signature visible did not make the structural red
// unconditional, it made the existing rule reachable.
git(['checkout', '-q', '-b', 'test/2-vouched', structuralBase], structural);
const vouchedHead = commit(structural, {
  'scripts/added.mts': 'process.exit(0);\n',
  'tests/one.test.mts': failingOnAbsentModule('./scripts/added.mts'),
}, 'test(red): spawn a script the base does not have');
r = nc(vouchedHead);
check(
  'the same structural red vouched by a test(red): commit passes with the warning',
  r.status === 0 && /negative-control: pass/.test(r.out) && /warning:/.test(r.out),
  r.out,
);

check('negative-control leaves no worktree behind', !/negative-control-/.test(git(['worktree', 'list'], structural)));

finish();
