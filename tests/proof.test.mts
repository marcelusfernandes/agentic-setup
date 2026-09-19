#!/usr/bin/env node
// Cases for the proof runner (#164): `scripts/proof.mts <slug>` resolves the
// proof a branch slug declares, runs it in the repository root and reports a
// named outcome; `scripts/lib/proof.mts` is the resolver and the validator.
//
// The script is spawned for real (CLAUDE.md invariant 6) against throwaway
// git repositories built by `tempRepo()`. Nothing here imports the code under
// test: the JSON keys, the three source names, the three outcome names and
// every `reason` are written out as literals below, because they are the
// contract the script is held to and importing them from the module that
// produces them would let both sides move together without a case noticing.
//
// The detection overrides are stripped from every spawn's environment: this
// repository dogfoods itself, so the shell running the suite may have
// AGENTIC_TEST_CMD set for real, which would turn the "nothing is resolvable"
// case into a run.
//
// Negative control: on the base `scripts/proof.mts` does not exist, so every
// spawn exits non-zero on `Cannot find module`, prints no JSON at all, and
// none of the three outcomes can be asserted.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { check, finish, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

/** The keys the runner always prints, in the order the issue names them. */
const KEYS = ['slug', 'source', 'outcome', 'command', 'tail'];
/** The closed set of outcomes, as `ci/negative-control.mts` keeps one. */
const OUTCOMES = ['pass', 'fail', 'cannot-run'];
/** The closed set of sources: where resolution stopped. */
const SOURCES = ['declaration', 'record', 'detection'];

// This repository dogfoods itself; a real AGENTIC_TEST_CMD in the shell would
// answer for a fixture that is supposed to resolve nothing.
const { AGENTIC_TEST_CMD: _t, AGENTIC_CHECK_CMD: _c, ...BASE_ENV } = process.env;

type Run = { status: number | null; stdout: string; stderr: string };

function proof(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'proof.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, ...env } as NodeJS.ProcessEnv,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
  } catch {
    return null;
  }
}

/** A throwaway repository holding `files`, written into the working tree. */
function fixture(files: Record<string, string>): string {
  const dir = tempRepo();
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

/** A declaration, as `proof/README.md` defines it. */
const declaration = (decl: object): string => `${JSON.stringify(decl, null, 2)}\n`;

/**
 * An adoption record, written as a literal: `scripts/lib/adopt/record.mts`
 * refuses anything short of the whole shape, and the runner reads it.
 */
const record = (commands: { test: string | null; check: string | null }, extra: object = {}): string =>
  `${JSON.stringify(
    {
      version: 1,
      stack: 'node',
      commands,
      checks: [],
      hooks: [],
      proof: { dir: 'proof' },
      labels: { source: 'scripts/init.mts' },
      generatedAt: '2026-01-01T00:00:00.000Z',
      generatedBy: 'agentic-setup/adopt',
      ...extra,
    },
    null,
    2,
  )}\n`;

/** Every run prints the same object, whatever the outcome. */
function checkShape(name: string, out: any, raw: string): void {
  check(`${name}: prints one JSON object carrying ${KEYS.join(', ')}`, out !== null && KEYS.every((k) => Object.prototype.hasOwnProperty.call(out, k)), raw);
  check(`${name}: reports an outcome from the closed set`, OUTCOMES.includes(out?.outcome), raw);
  check(`${name}: reports a source from the closed set`, SOURCES.includes(out?.source), raw);
  check(`${name}: names the slug it was asked about`, typeof out?.slug === 'string' && out.slug.length > 0, raw);
}

// --- A: a declared command that passes --------------------------------------
const passing = fixture({
  'tests/proof-fixture.test.mts': '// overlaid by the negative control\n',
  'proof/runner-pass.json': declaration({
    tests: ['tests/proof-fixture.test.mts'],
    command: 'echo proof-ran-green',
    describes: 'the runner runs what the slug declares',
  }),
});
const a = proof(['runner-pass'], passing);
const aOut = parse(a.stdout);
checkShape('a declared passing command', aOut, `${a.stdout}\n${a.stderr}`);
check('a declared passing command exits 0', a.status === 0, `${a.stdout}\n${a.stderr}`);
check('a declared passing command reports outcome pass', aOut?.outcome === 'pass', a.stdout);
check('a declared passing command reports source declaration', aOut?.source === 'declaration', a.stdout);
check('a declared passing command reports the command it ran', aOut?.command === 'echo proof-ran-green', a.stdout);
check('a declared passing command reports the tail of the output it produced', typeof aOut?.tail === 'string' && aOut.tail.includes('proof-ran-green'), a.stdout);

// --- B: a declared command that fails ---------------------------------------
const failing = fixture({
  'tests/proof-fixture.test.mts': '// overlaid by the negative control\n',
  'proof/runner-fail.json': declaration({
    tests: ['tests/proof-fixture.test.mts'],
    command: 'echo first-line; echo proof-ran-red 1>&2; exit 3',
  }),
});
const b = proof(['runner-fail'], failing);
const bOut = parse(b.stdout);
checkShape('a declared failing command', bOut, `${b.stdout}\n${b.stderr}`);
check('a declared failing command exits non-zero', b.status !== 0, `${b.status} — ${b.stdout}`);
check('a declared failing command reports outcome fail', bOut?.outcome === 'fail', b.stdout);
check('a declared failing command reports the tail of what it printed, stderr included', typeof bOut?.tail === 'string' && bOut.tail.includes('proof-ran-red'), b.stdout);
check('a failing run is never reported as cannot-run', bOut?.outcome !== 'cannot-run', b.stdout);

// --- C: no command anywhere -------------------------------------------------
// No declaration, no adoption record, and nothing `ci/lib/detect.mts` can
// detect: there is nothing to run, and that is not a pass.
const nothing = fixture({ 'README.md': '# nothing to detect\n' });
const c = proof(['runner-missing'], nothing);
const cOut = parse(c.stdout);
checkShape('a repository with no command at all', cOut, `${c.stdout}\n${c.stderr}`);
check('a repository with no command at all exits non-zero', c.status !== 0, `${c.status} — ${c.stdout}`);
check('a repository with no command at all reports outcome cannot-run', cOut?.outcome === 'cannot-run', c.stdout);
check('cannot-run reports no command rather than inventing one', cOut?.command === null, c.stdout);
check('cannot-run names the reason it could not run', typeof cOut?.reason === 'string' && cOut.reason.length > 0, c.stdout);

// --- D: a declaration naming a test file that does not exist ----------------
const missingTest = fixture({
  'proof/runner-ghost.json': declaration({ tests: ['tests/never-written.test.mts'], command: 'echo would-have-run' }),
});
const d = proof(['runner-ghost'], missingTest);
const dOut = parse(d.stdout);
checkShape('a declaration naming a file that does not exist', dOut, `${d.stdout}\n${d.stderr}`);
check('a declaration naming a file that does not exist exits non-zero', d.status !== 0, `${d.status} — ${d.stdout}`);
check('a declaration naming a file that does not exist reports outcome cannot-run', dOut?.outcome === 'cannot-run', d.stdout);
check('a broken declaration names the reason', dOut?.reason === 'proof:missing-test-file', d.stdout);
check('a broken declaration names the entry it rejected', dOut?.field === 'tests/never-written.test.mts', d.stdout);
check('a broken declaration is never a silent fallback to detection', dOut?.source === 'declaration', d.stdout);
check('a broken declaration never runs the command it carries', !String(dOut?.tail ?? '').includes('would-have-run'), d.stdout);

// --- E: the other two validations the declaration owes ----------------------
const invalid: Array<{ name: string; decl: object; reason: string; field?: string }> = [
  { name: 'an unknown key', decl: { tests: ['proof/README.md'], comand: 'echo typo' }, reason: 'proof:unknown-key', field: 'comand' },
  { name: 'an empty command', decl: { tests: ['proof/README.md'], command: '   ' }, reason: 'proof:empty-command', field: 'command' },
  { name: 'no tests at all', decl: { command: 'echo orphan' }, reason: 'proof:missing-tests', field: 'tests' },
  { name: 'a tests entry of the wrong type', decl: { tests: [7], command: 'echo wrong' }, reason: 'proof:wrong-type', field: 'tests' },
];
for (const bad of invalid) {
  const dir = fixture({ 'proof/README.md': '# fixture\n', 'proof/runner-bad.json': declaration(bad.decl) });
  const r = proof(['runner-bad'], dir);
  const out = parse(r.stdout);
  checkShape(`a declaration with ${bad.name}`, out, `${r.stdout}\n${r.stderr}`);
  check(`a declaration with ${bad.name} reports cannot-run and exits non-zero`, r.status !== 0 && out?.outcome === 'cannot-run', `${r.status} — ${r.stdout}`);
  check(`a declaration with ${bad.name} names the reason ${bad.reason}`, out?.reason === bad.reason, r.stdout);
  if (bad.field !== undefined) check(`a declaration with ${bad.name} names the field it rejected`, out?.field === bad.field, r.stdout);
}

const unparsable = fixture({ 'proof/runner-broken.json': '{ not json\n' });
const e = proof(['runner-broken'], unparsable);
const eOut = parse(e.stdout);
check('a declaration that does not parse reports cannot-run', e.status !== 0 && eOut?.outcome === 'cannot-run' && eOut?.reason === 'proof:unparsable', `${e.stdout}\n${e.stderr}`);

// --- F: the second source, the adoption record ------------------------------
const fromRecord = fixture({
  'agentic.config.json': record({ test: 'echo ran-from-the-record', check: null }),
});
const f = proof(['runner-recorded'], fromRecord);
const fOut = parse(f.stdout);
checkShape('a repository with a record and no declaration', fOut, `${f.stdout}\n${f.stderr}`);
check('a repository with a record and no declaration exits 0', f.status === 0, `${f.stdout}\n${f.stderr}`);
check('a repository with a record and no declaration reports source record', fOut?.source === 'record', f.stdout);
check('the recorded command is the one that ran', fOut?.command === 'echo ran-from-the-record' && String(fOut?.tail ?? '').includes('ran-from-the-record'), f.stdout);

// A declaration always wins over the record.
const both = fixture({
  'agentic.config.json': record({ test: 'echo ran-from-the-record', check: null }),
  'tests/proof-fixture.test.mts': '// overlaid by the negative control\n',
  'proof/runner-both.json': declaration({ tests: ['tests/proof-fixture.test.mts'], command: 'echo ran-from-the-declaration' }),
});
const fBoth = proof(['runner-both'], both);
const fBothOut = parse(fBoth.stdout);
check('a declaration is preferred over the record', fBothOut?.source === 'declaration' && fBothOut?.command === 'echo ran-from-the-declaration', fBoth.stdout);

// A record that is not the shape stops the run: it is never read as "no record".
const brokenRecord = fixture({
  'agentic.config.json': record({ test: 'echo ran-from-the-record', check: null }, { surprise: 1 }),
});
const fBroken = proof(['runner-recorded'], brokenRecord);
const fBrokenOut = parse(fBroken.stdout);
check('a record that is not the shape reports cannot-run and exits non-zero', fBroken.status !== 0 && fBrokenOut?.outcome === 'cannot-run', `${fBroken.stdout}\n${fBroken.stderr}`);
check('a record that is not the shape keeps its own named reason', fBrokenOut?.reason === 'record:unknown-key', fBroken.stdout);
check('a rejected record never falls through to detection', fBrokenOut?.source === 'record', fBroken.stdout);

// --- G: the third source, detection -----------------------------------------
const detected = fixture({
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2),
});
const g = proof(['runner-detected'], detected);
const gOut = parse(g.stdout);
checkShape('a repository where only detection answers', gOut, `${g.stdout}\n${g.stderr}`);
check('a repository where only detection answers reports source detection', gOut?.source === 'detection', g.stdout);
check('the detected command is the one that ran', gOut?.command === 'npm test', g.stdout);

// --- H: a command that cannot be executed is cannot-run, not fail -----------
const unrunnable = fixture({
  'tests/proof-fixture.test.mts': '// overlaid by the negative control\n',
  'proof/runner-absent.json': declaration({ tests: ['tests/proof-fixture.test.mts'], command: 'agentic-no-such-binary-4d9f' }),
});
const h = proof(['runner-absent'], unrunnable);
const hOut = parse(h.stdout);
check('a command that is not on PATH reports cannot-run, never fail', h.status !== 0 && hOut?.outcome === 'cannot-run', `${h.stdout}\n${h.stderr}`);
check('a command that is not on PATH still reports the command it tried', hOut?.command === 'agentic-no-such-binary-4d9f', h.stdout);

// --- H2: a run that overran its buffer or its clock ------------------------
// `spawnSync`'s defaults are a 1 MiB buffer and no timeout at all, so a suite
// that printed more than that came back as a command that could not be
// executed, and a command that hung hung the job with no verdict ever. Both
// limits are explicit named constants now, each with an env override — which
// is also the only way a case can reach either path without printing tens of
// megabytes or waiting out half an hour.
//
// Neither is `proof:command-not-runnable`: that reason says the command never
// ran at all (exit 127, or a spawn that never started), and a command killed
// for printing too much or for taking too long is one that ran. Reporting
// them alike would hide the only two causes an operator can act on by raising
// a limit.
const noisy = fixture({
  'tests/proof-fixture.test.mts': '// overlaid by the negative control\n',
  'proof/runner-noisy.json': declaration({
    tests: ['tests/proof-fixture.test.mts'],
    // Twenty thousand characters: past the 1024-byte override below and well
    // short of `spawnSync`'s own 1 MiB default, so the only thing that makes
    // this run overrun is the constant the fix introduces. Printed as lines
    // so the report's 40-line tail stays a few kilobytes.
    command: `${RUNTIME} -e "for (let i = 0; i < 200; i++) console.log('x'.repeat(100))"`,
  }),
});
const noisyRun = proof(['runner-noisy'], noisy, { AGENTIC_RUN_MAX_BUFFER: '1024' });
const noisyOut = parse(noisyRun.stdout);
checkShape('a run that printed more than the buffer holds', noisyOut, `${noisyRun.stdout}\n${noisyRun.stderr}`);
check(
  'a run that printed more than the buffer holds reports cannot-run, never pass',
  noisyRun.status !== 0 && noisyOut?.outcome === 'cannot-run',
  `${noisyRun.status} — ${noisyRun.stdout}${noisyRun.stderr}`,
);
check('a run that printed more than the buffer holds names the exceeded buffer', noisyOut?.reason === 'proof:output-too-large', noisyRun.stdout);
check('a run that printed more than the buffer holds still reports the command it ran', String(noisyOut?.command ?? '').includes("'x'.repeat(100)"), noisyOut?.command ?? noisyRun.stdout);

const hanging = fixture({
  'tests/proof-fixture.test.mts': '// overlaid by the negative control\n',
  'proof/runner-hang.json': declaration({ tests: ['tests/proof-fixture.test.mts'], command: 'sleep 5' }),
});
const hangingRun = proof(['runner-hang'], hanging, { AGENTIC_RUN_TIMEOUT_MS: '300' });
const hangingOut = parse(hangingRun.stdout);
checkShape('a run that outran the timeout', hangingOut, `${hangingRun.stdout}\n${hangingRun.stderr}`);
check(
  'a run that outran the timeout reports cannot-run, never pass',
  hangingRun.status !== 0 && hangingOut?.outcome === 'cannot-run',
  `${hangingRun.status} — ${hangingRun.stdout}${hangingRun.stderr}`,
);
check('a run that outran the timeout names the timeout', hangingOut?.reason === 'proof:command-timed-out', hangingRun.stdout);
check(
  'a run that outran the timeout is not reported as a command that never started',
  hangingOut?.reason !== 'proof:command-not-runnable',
  hangingRun.stdout,
);

// --- I: the runner never takes a command from anywhere but the three sources -
// An issue body and a pull request body are data, not authority (invariant 9):
// there is no flag that takes a command string, so there is no path by which
// text from either can be executed.
const guarded = fixture({
  'tests/proof-fixture.test.mts': '// overlaid by the negative control\n',
  'proof/runner-guard.json': declaration({ tests: ['tests/proof-fixture.test.mts'], command: 'echo declared-only' }),
});
const injected = `node -e "require('fs').writeFileSync('executed-from-a-flag','x')"`;
for (const args of [['--command', injected], ['runner-guard', '--command', injected], ['--test-cmd', injected], ['runner-guard', injected]]) {
  const r = proof(args, guarded);
  check(`\`${args.join(' ')}\` is refused, not run`, r.status !== 0, `${r.status} — ${r.stdout}${r.stderr}`);
}
check('no flag ever executed a command string', !existsSync(join(guarded, 'executed-from-a-flag')), 'executed-from-a-flag was created');

const noSlug = proof([], guarded);
check('no slug at all is a usage error', noSlug.status !== 0 && /usage/.test(`${noSlug.stdout}${noSlug.stderr}`), `${noSlug.stdout}\n${noSlug.stderr}`);

// A slug is a slug: nothing that could name a path outside `proof/` is read.
for (const slug of ['../outside', 'Upper', 'with space', 'dot.json']) {
  const r = proof([slug], guarded);
  const out = parse(r.stdout);
  check(`\`${slug}\` is refused as a slug`, r.status !== 0 && (out === null || out?.outcome === 'cannot-run'), `${r.status} — ${r.stdout}${r.stderr}`);
}

finish();
