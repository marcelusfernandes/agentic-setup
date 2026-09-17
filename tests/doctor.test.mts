#!/usr/bin/env node
// Cases for `scripts/doctor.mts` (#168): the read-only report that says
// whether a repository actually satisfies what the loop requires, and names
// the exact field when it does not.
//
// The script is spawned for real (CLAUDE.md invariant 6) against throwaway
// git repositories built by `tempRepo()`, with a fake `gh` first on PATH: a
// bash script that answers the three reads the report makes and logs every
// argv it was called with, so "it never calls a mutating verb" is asserted
// against what the run actually did rather than against a reading of the
// source.
//
// Nothing here imports the code under test. The JSON keys, the check names
// and every `missing` field are written out as literals below, because they
// are the contract the script is held to — importing them from the module
// that produces them would let both sides rename a field together and no
// case would notice.
//
// The detection overrides and the reviewer token are stripped from every
// spawn's environment: this repository dogfoods itself, so the shell running
// the suite may carry AGENTIC_TEST_CMD or AGENTIC_REVIEWER_TOKEN for real,
// which would answer for the two fixtures that exist to prove what happens
// when neither is set.
//
// Refusal paths are tested like happy paths, and there are more of them here
// than happy paths on purpose: the whole point of this report is the refusal,
// so every named field has a case, and the two cases that must print `ok:
// true` are asserted by the same exact-array comparison as the refusals.
//
// Negative control: on the base `scripts/doctor.mts` does not exist, so every
// spawn exits non-zero on `Cannot find module`, prints no JSON at all, and no
// `checks` array can be parsed — in particular the review mode, which is this
// repository's whole merge condition, has nothing that reports it.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, tempRepo, ROOT, RUNTIME } from './lib/harness.mts';

// --- the contract, as literals -----------------------------------------------

/** The keys the report always prints, in the order the issue names them. */
const KEYS = ['ok', 'mode', 'checks', 'missing'];

/** The keys every entry of `checks` carries. */
const CHECK_KEYS = ['name', 'ok', 'found', 'expected'];

/** Every check the report covers, in the order it prints them. */
const CHECK_NAMES = ['review-mode', 'record', 'ruleset', 'required-checks', 'labels', 'hooks', 'auto-merge', 'proof'];

/** The two review modes a repository can run. `null` when a read failed. */
const MODES = ['agent', 'approved'];

/** The check names the generated `agentic-checks.yml` produces for a record with both commands. */
const GENERATED_CHECKS = ['scope', 'negative-control', 'test', 'check'];

/** The label vocabulary `scripts/init.mts` seeds, as `labels.json` routes it. */
const SEEDED_LABELS = [
  'state:ready',
  'state:in-progress',
  'state:in-review',
  'state:qa-failed',
  'state:blocked',
  'type:feature',
  'type:bug',
  'type:refactor',
  'type:infra',
  'type:spec',
  'type:docs',
  'type:deps',
  'review:approved',
  'human:pending',
  'human:decided',
];

const ALL_LABELS_JSON = JSON.stringify(SEEDED_LABELS.map((name) => ({ name })));

/** The contexts a complete ruleset names: every generated check. */
const FULL_CONTEXTS = JSON.stringify(GENERATED_CHECKS.map((context) => ({ context })));
/** The contexts of a ruleset that requires checks, but none this setup generates. */
const OTHER_CONTEXTS = JSON.stringify([{ context: 'lint' }, { context: 'build' }]);
/** The two contexts a record holding no command produces. */
const TWO_CONTEXTS = JSON.stringify([{ context: 'scope' }, { context: 'negative-control' }]);
/** The three contexts a record holding a test command and no check command produces. */
const THREE_CONTEXTS = JSON.stringify([{ context: 'scope' }, { context: 'negative-control' }, { context: 'test' }]);

// --- a fake `gh` on PATH ------------------------------------------------------
// Every knob is checked against its closed set before anything is answered, so
// a typo in a case below is a loud failure rather than a silently different
// fixture: `doctor` reports a read that failed by its own named reason and
// never by gh's wording, which would otherwise make the typo invisible.
const KNOBS: Record<string, string[]> = {
  FAKE_GH_FAIL: ['', 'repo', 'ruleset', 'labels'],
  FAKE_GH_RULES: ['', 'full', 'other-checks', 'no-checks', 'two-checks', 'three-checks', 'approved', 'approved-no-checks'],
  FAKE_GH_LABELS: ['', 'all'],
  FAKE_GH_AUTOMERGE: ['', 'true', 'false'],
};

const KNOB_GUARDS = Object.entries(KNOBS)
  .map(([name, values]) => `knob ${name} "\${${name}:-}" ${values.map((v) => `'${v}'`).join(' ')}`)
  .join('\n');

const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"

knob() {
  name="$1"
  value="$2"
  shift 2
  for allowed in "$@"; do
    if [ "$value" = "$allowed" ]; then return 0; fi
  done
  printf '%s=%s\\n' "$name" "$value" >> "$state/knob-error"
  echo "fake-gh: $name=$value is not one of the values this harness knows" >&2
  exit 64
}
${KNOB_GUARDS}

case "\${1:-} \${2:-}" in
  "api repos/{owner}/{repo}")
    if [ "\${FAKE_GH_FAIL:-}" = "repo" ]; then echo "fake-gh: repository read failed" >&2; exit 1; fi
    printf '{"default_branch":"main","allow_auto_merge":%s,"delete_branch_on_merge":true}\\n' "\${FAKE_GH_AUTOMERGE:-true}"
    ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    if [ "\${FAKE_GH_FAIL:-}" = "ruleset" ]; then echo "fake-gh: rules read failed" >&2; exit 1; fi
    case "\${FAKE_GH_RULES:-}" in
      full) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},{"type":"required_status_checks","parameters":{"required_status_checks":${FULL_CONTEXTS}}}]' ;;
      other-checks) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},{"type":"required_status_checks","parameters":{"required_status_checks":${OTHER_CONTEXTS}}}]' ;;
      no-checks) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},{"type":"deletion"}]' ;;
      two-checks) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},{"type":"required_status_checks","parameters":{"required_status_checks":${TWO_CONTEXTS}}}]' ;;
      three-checks) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},{"type":"required_status_checks","parameters":{"required_status_checks":${THREE_CONTEXTS}}}]' ;;
      approved) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"required_status_checks","parameters":{"required_status_checks":${FULL_CONTEXTS}}}]' ;;
      approved-no-checks) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"deletion"}]' ;;
      *) echo '[]' ;;
    esac
    ;;
  "label list")
    if [ "\${FAKE_GH_FAIL:-}" = "labels" ]; then echo "fake-gh: label list failed" >&2; exit 1; fi
    case "\${FAKE_GH_LABELS:-}" in
      all) echo '${ALL_LABELS_JSON}' ;;
      *) echo '[]' ;;
    esac
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-doctor-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- fixtures ------------------------------------------------------------------

// This repository dogfoods itself; a real override or reviewer token in the
// shell would answer for the fixtures that exist to prove what happens when
// none is set.
const {
  AGENTIC_TEST_CMD: _t,
  AGENTIC_CHECK_CMD: _c,
  AGENTIC_REVIEWER_TOKEN: _r,
  ...BASE_ENV
} = process.env;

/** The bytes `scripts/init.mts` installs as the `pre-push` hook, read from this repository. */
const OUR_PRE_PUSH = readFileSync(join(ROOT, 'hooks', 'git-pre-push'), 'utf8');

/** A `package.json` whose scripts detection reads as `npm test` / `npm run check`. */
const PACKAGE_JSON = `${JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node --test', check: 'tsc --noEmit' } }, null, 2)}\n`;

/** An adoption record, written as a literal: the reader refuses anything short of the whole shape. */
const record = (fields: {
  stack?: string;
  test?: string | null;
  checkCmd?: string | null;
  hooks?: string[];
  checks?: string[];
  extra?: object;
}): string =>
  `${JSON.stringify(
    {
      version: 1,
      stack: fields.stack ?? 'node',
      commands: { test: fields.test === undefined ? 'npm test' : fields.test, check: fields.checkCmd === undefined ? 'npm run check' : fields.checkCmd },
      checks: fields.checks ?? GENERATED_CHECKS,
      hooks: fields.hooks ?? ['pre-push'],
      proof: { dir: 'proof' },
      labels: { source: 'scripts/init.mts' },
      generatedAt: '2026-01-01T00:00:00.000Z',
      generatedBy: 'agentic-setup/adopt',
      ...(fields.extra ?? {}),
    },
    null,
    2,
  )}\n`;

/** A committed throwaway repository holding `files`; the pre-push hook is installed unless told not to. */
function fixture(files: Record<string, string>, prePush: string | null = OUR_PRE_PUSH): string {
  const dir = tempRepo();
  commit(dir, { 'README.md': '# fixture\n', ...files }, 'initial');
  if (prePush !== null) {
    mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
    const path = join(dir, '.git', 'hooks', 'pre-push');
    writeFileSync(path, prePush);
    chmodSync(path, 0o755);
  }
  return dir;
}

/** The complete repository: node stack, matching record, hook installed. */
const complete = (extra: Record<string, string> = {}): string =>
  fixture({ 'package.json': PACKAGE_JSON, 'agentic.config.json': record({}), ...extra });

function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-doctor-state-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  return dir;
}

type Run = { status: number | null; stdout: string; stderr: string; out: any; log: string; stateDir: string };

/** Spawns the real script in `cwd`, with the fake `gh` first on PATH. */
function doctor(args: string[], cwd: string, env: Record<string, string> = {}): Run {
  const stateDir = newStateDir();
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'doctor.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, FAKE_GH_LABELS: 'all', FAKE_GH_RULES: 'full', ...env } as NodeJS.ProcessEnv,
  });
  const stdout = r.stdout ?? '';
  let out: any = null;
  try {
    out = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? '');
  } catch {
    out = null;
  }
  const knob = join(stateDir, 'knob-error');
  const rejected = spawnSync('cat', [knob], { encoding: 'utf8' });
  if (rejected.status === 0) check('the fake gh rejected a knob this file set', false, rejected.stdout);
  return { status: r.status, stdout, stderr: r.stderr ?? '', out, log: readFileSync(join(stateDir, 'gh-argv.log'), 'utf8'), stateDir };
}

/** The `missing` array as a comparable string, so a case can assert it exactly. */
const missingOf = (run: Run): string => JSON.stringify(run.out?.missing ?? null);
const exactly = (...fields: string[]): string => JSON.stringify(fields);

/** Every report prints the same object, whatever the outcome. */
function checkShape(name: string, run: Run): void {
  const out = run.out;
  const raw = `${run.stdout}\n${run.stderr}`;
  check(`${name}: prints one JSON object carrying ${KEYS.join(', ')}`, out !== null && KEYS.every((k) => Object.prototype.hasOwnProperty.call(out, k)), raw);
  check(`${name}: reports ok as a boolean`, typeof out?.ok === 'boolean', raw);
  check(`${name}: reports missing as an array of strings`, Array.isArray(out?.missing) && out.missing.every((m: unknown) => typeof m === 'string'), raw);
  check(`${name}: every missing entry is a field name rather than a sentence`, (out?.missing ?? []).every((m: string) => /^[a-z]/.test(m) && !m.includes(' ')), missingOf(run));
  check(`${name}: reports checks as a non-empty array`, Array.isArray(out?.checks) && out.checks.length > 0, raw);
  check(
    `${name}: every check carries ${CHECK_KEYS.join(', ')}`,
    (out?.checks ?? []).every((c: any) => CHECK_KEYS.every((k) => Object.prototype.hasOwnProperty.call(c, k))),
    JSON.stringify(out?.checks),
  );
  check(`${name}: ok is false whenever any check is false`, out?.ok === (out?.checks ?? []).every((c: any) => c.ok === true), JSON.stringify(out?.checks));
  check(`${name}: ok agrees with missing being empty`, out?.ok === ((out?.missing ?? []).length === 0), raw);
  check(`${name}: exits 0 only when ok is true`, run.status === (out?.ok === true ? 0 : 1), `status=${run.status} ${raw}`);
}

// --- AC1/AC5b: the complete repository in agent mode -------------------------

const a = doctor([], complete());
checkShape('a complete repository', a);
check('AC1 a complete repository reports every check by name', CHECK_NAMES.every((name) => (a.out?.checks ?? []).some((c: any) => c.name === name)), JSON.stringify(a.out?.checks));
check('AC1 the checks are reported in one fixed order', JSON.stringify((a.out?.checks ?? []).map((c: any) => c.name)) === JSON.stringify(CHECK_NAMES), JSON.stringify(a.out?.checks));
check('AC1 a complete repository reports a mode from the closed set', MODES.includes(a.out?.mode), a.stdout);
check('AC5b a complete repository in agent mode reports mode agent', a.out?.mode === 'agent', a.stdout);
check('AC5b a complete repository whose ruleset names the generated checks reports ok true', a.out?.ok === true, a.stdout);
check('AC5b a complete repository reports an empty missing', missingOf(a) === exactly(), a.stdout);
check('AC5b a complete repository exits 0', a.status === 0, `${a.stdout}\n${a.stderr}`);

// --- AC5a: the case this repository is in ------------------------------------
// A ruleset that requires status checks, but none of the ones the generated
// workflow produces: the merge gate is on and guards nothing the loop runs.

const b = doctor([], complete(), { FAKE_GH_RULES: 'other-checks' });
checkShape('a ruleset naming none of the generated checks', b);
check('AC5a a ruleset naming none of the generated checks names ruleset:required_status_checks and nothing else', missingOf(b) === exactly('ruleset:required_status_checks'), b.stdout);
check('AC5a a ruleset naming none of the generated checks reports ok false', b.out?.ok === false, b.stdout);
check('AC5a a ruleset naming none of the generated checks exits 1', b.status === 1, `${b.stdout}\n${b.stderr}`);
check(
  'AC5a the required-checks check names the generated checks as what it expected',
  GENERATED_CHECKS.every((name) => String((b.out?.checks ?? []).find((c: any) => c.name === 'required-checks')?.expected ?? '').includes(name)),
  JSON.stringify(b.out?.checks),
);

// A ruleset with no required_status_checks rule at all is the same refusal:
// "nothing requires the checks" is not a different fix from "the wrong ones".
const c = doctor([], complete(), { FAKE_GH_RULES: 'no-checks' });
check('a ruleset with no required_status_checks rule names ruleset:required_status_checks', missingOf(c) === exactly('ruleset:required_status_checks'), c.stdout);

// --- AC4: approved mode with no second identity ------------------------------

const d = doctor([], complete(), { FAKE_GH_RULES: 'approved' });
checkShape('approved mode with no second identity', d);
check('AC4 a ruleset requiring an approving review reports mode approved', d.out?.mode === 'approved', d.stdout);
check('AC4 approved mode with no AGENTIC_REVIEWER_TOKEN names review:no-second-identity and nothing else', missingOf(d) === exactly('review:no-second-identity'), d.stdout);
check('AC4 approved mode with no second identity reports ok false', d.out?.ok === false, d.stdout);
check('AC4 approved mode with no second identity exits 1', d.status === 1, `${d.stdout}\n${d.stderr}`);

// The complement: the same ruleset with a second identity in the environment
// is not a freeze risk, and the report says so rather than staying red.
const e = doctor([], complete(), { FAKE_GH_RULES: 'approved', AGENTIC_REVIEWER_TOKEN: 'ghp_fixture' });
check('AC4 approved mode with a second identity reports ok true', e.out?.ok === true, e.stdout);
check('AC4 approved mode with a second identity still reports mode approved', e.out?.mode === 'approved', e.stdout);
check('AC4 approved mode with a second identity reports an empty missing', missingOf(e) === exactly(), e.stdout);

// The freeze risk is reported even when the same ruleset is also missing the
// checks: the review gate nobody can satisfy is its own field, not a footnote.
const f = doctor([], complete(), { FAKE_GH_RULES: 'approved-no-checks' });
check(
  'approved mode with no second identity and no required checks names both fields',
  missingOf(f) === exactly('review:no-second-identity', 'ruleset:required_status_checks'),
  f.stdout,
);

// --- AC3: a read that cannot answer ------------------------------------------

const g = doctor([], complete(), { FAKE_GH_FAIL: 'ruleset' });
checkShape('a failed ruleset read', g);
check('AC3 a gh that cannot answer the rules read names read-failed:ruleset and nothing else', missingOf(g) === exactly('read-failed:ruleset'), g.stdout);
check('AC3 a failed ruleset read reports ok false', g.out?.ok === false, g.stdout);
check('AC3 a failed ruleset read exits 1', g.status === 1, `${g.stdout}\n${g.stderr}`);
check('AC3 a failed ruleset read reports no mode rather than the mode left over when a read fails', g.out?.mode === null, g.stdout);
check('AC3 a failed read reports no check as passing', (g.out?.checks ?? []).every((c: any) => c.ok === false), JSON.stringify(g.out?.checks));
check('AC3 a failed ruleset read names the failing check after the read it made', (g.out?.checks ?? []).some((c: any) => c.name === 'ruleset' && c.ok === false), JSON.stringify(g.out?.checks));

const h = doctor([], complete(), { FAKE_GH_FAIL: 'repo' });
check('a gh that cannot answer the repository read names read-failed:repository', missingOf(h) === exactly('read-failed:repository'), h.stdout);
check('a failed repository read reports ok false and no mode', h.out?.ok === false && h.out?.mode === null, h.stdout);

const i = doctor([], complete(), { FAKE_GH_FAIL: 'labels' });
check('a gh that cannot answer the label read names read-failed:labels', missingOf(i) === exactly('read-failed:labels'), i.stdout);

// --- the ruleset that is not there at all ------------------------------------

const j = doctor([], complete(), { FAKE_GH_RULES: '' });
check('a default branch with no effective rules names ruleset:absent and nothing else', missingOf(j) === exactly('ruleset:absent'), j.stdout);
check('a default branch with no effective rules reports ok false', j.out?.ok === false, j.stdout);
check('a default branch with no effective rules still reports a mode', MODES.includes(j.out?.mode), j.stdout);

// --- the labels ---------------------------------------------------------------

const k = doctor([], complete(), { FAKE_GH_LABELS: '' });
check('a repository missing the seeded labels names labels:missing and nothing else', missingOf(k) === exactly('labels:missing'), k.stdout);
check(
  'the labels check names a label it did not find as what it expected',
  String((k.out?.checks ?? []).find((c: any) => c.name === 'labels')?.expected ?? '').includes('state:ready'),
  JSON.stringify(k.out?.checks),
);

// --- allow_auto_merge ---------------------------------------------------------

const l = doctor([], complete(), { FAKE_GH_AUTOMERGE: 'false' });
check('a repository that does not allow auto-merge names repository:allow_auto_merge and nothing else', missingOf(l) === exactly('repository:allow_auto_merge'), l.stdout);

// --- the hooks ----------------------------------------------------------------
// Four different repositories, four different fixes, four different fields.

const m = doctor([], fixture({ 'package.json': PACKAGE_JSON, 'agentic.config.json': record({}) }, null));
check('a record naming a hook that is not installed names hooks:not-installed and nothing else', missingOf(m) === exactly('hooks:not-installed'), m.stdout);

// The fool-able case: a record that names no hook at all. A repository whose
// record asks for nothing is not a protected repository, and an empty
// `hooks[]` must not make the check vacuously true.
const n = doctor([], fixture({ 'package.json': PACKAGE_JSON, 'agentic.config.json': record({ hooks: [] }) }, null));
check('a record naming no hook at all names hooks:not-recorded and nothing else', missingOf(n) === exactly('hooks:not-recorded'), n.stdout);
check('a record naming no hook at all reports ok false', n.out?.ok === false, n.stdout);

// Someone else's pre-push is left alone, and said so: the fix is a person's.
const o = doctor([], fixture({ 'package.json': PACKAGE_JSON, 'agentic.config.json': record({}) }, '#!/bin/sh\n# a hook a person wrote\nexit 0\n'));
check("a pre-push this setup did not write names hooks:not-ours and nothing else", missingOf(o) === exactly('hooks:not-ours'), o.stdout);

// Ours, and no longer what this version installs.
const p = doctor([], fixture({ 'package.json': PACKAGE_JSON, 'agentic.config.json': record({}) }, `${OUR_PRE_PUSH}\n# edited by hand\n`));
check('a pre-push of ours whose contents moved names hooks:drifted and nothing else', missingOf(p) === exactly('hooks:drifted'), p.stdout);

// --- the record ---------------------------------------------------------------

// No record: every check that reads it names the same field, once, so a
// record-less repository gets one fix rather than a list of consequences.
const q = doctor([], fixture({ 'package.json': PACKAGE_JSON }));
checkShape('a repository with no adoption record', q);
check('a repository with no adoption record names record:absent and nothing else', missingOf(q) === exactly('record:absent'), q.stdout);
check('a repository with no adoption record reports ok false', q.out?.ok === false, q.stdout);

// A record that is not the shape is reported by the reader's own named reason.
const r = doctor([], fixture({ 'package.json': PACKAGE_JSON, 'agentic.config.json': `${JSON.stringify({ version: 1, surprise: true })}\n` }));
check('a record that is not the shape names the reader\'s own reason', missingOf(r) === exactly('record:unknown-key'), r.stdout);
check('a record that is not the shape reports ok false', r.out?.ok === false, r.stdout);

// A record that no longer describes the repository is stale, not absent.
const s = doctor([], complete({ 'agentic.config.json': record({ test: 'pytest -q' }) }));
check('a record whose commands no longer match detection names record:stale and nothing else', missingOf(s) === exactly('record:stale'), s.stdout);
check(
  'the record check names the stale field rather than the file',
  String((s.out?.checks ?? []).find((c: any) => c.name === 'record')?.found ?? '').includes('commands.test'),
  JSON.stringify(s.out?.checks),
);

// --- the proof ----------------------------------------------------------------
// A tree with no stack marker: detection answers no command, which is a
// legitimate detected state — and a repository in it can prove nothing, so
// the report names the field rather than calling it ok.

const t = doctor([], fixture({ 'agentic.config.json': record({ stack: 'unknown', test: null, checkCmd: null, checks: ['scope', 'negative-control'] }) }), {
  FAKE_GH_RULES: 'two-checks',
});
checkShape('a repository where no command can be resolved', t);
check('a repository where no command can be resolved names proof:no-command and nothing else', missingOf(t) === exactly('proof:no-command'), t.stdout);
check('a repository where no command can be resolved reports ok false', t.out?.ok === false, t.stdout);

// A tree detection does answer for: the record pins the same command, so
// nothing is stale, and the proof resolves out of the record.
const u = doctor(
  [],
  fixture({
    Makefile: 'test:\n\t@true\n',
    'agentic.config.json': record({ stack: 'make', test: 'make test', checkCmd: null, checks: ['scope', 'negative-control', 'test'] }),
  }),
  { FAKE_GH_RULES: 'three-checks' },
);
checkShape('a repository whose record pins the detected command', u);
check('a record that names a test command resolves the proof', u.out?.ok === true, u.stdout);
check('the proof check reports where the command came from', String((u.out?.checks ?? []).find((c: any) => c.name === 'proof')?.found ?? '').includes('record'), JSON.stringify(u.out?.checks));

// A declaration the branch names is read too, and a broken one is its own
// reason rather than a silent fallback to the record or to detection.
const v = doctor(['--slug', 'broken'], complete({ 'proof/broken.json': `${JSON.stringify({ tests: [], command: 'true' })}\n` }));
check('a declaration that names no test file names the resolver\'s own reason', missingOf(v) === exactly('proof:missing-tests'), v.stdout);

// A declaration that is usable is what the report reads for that slug.
const v2 = doctor(['--slug', 'gate'], complete({ 'proof/gate.json': `${JSON.stringify({ tests: ['README.md'], command: 'true' })}\n` }));
check('a usable declaration is reported as the source of the command', String((v2.out?.checks ?? []).find((c: any) => c.name === 'proof')?.found ?? '').includes('declaration'), JSON.stringify(v2.out?.checks));
check('a usable declaration leaves the report ok', v2.out?.ok === true, v2.stdout);

// --- AC2: it writes nothing and calls no mutating verb -----------------------

const w = fixture({ 'package.json': PACKAGE_JSON, 'agentic.config.json': record({}) });
const before = git(['rev-parse', 'HEAD'], w);
const beforeStatus = git(['status', '--porcelain'], w);
const x = doctor([], w);
check('AC2 the run this case measures reported something', x.out !== null, `${x.stdout}\n${x.stderr}`);
check('AC2 the working tree is unchanged after a run', git(['status', '--porcelain'], w) === beforeStatus, git(['status', '--porcelain'], w));
check('AC2 no commit was made', git(['rev-parse', 'HEAD'], w) === before);
check('AC2 no file was written into the repository', !git(['status', '--porcelain', '--untracked-files=all'], w).includes('agentic'), git(['status', '--porcelain', '--untracked-files=all'], w));

/** Every `gh` invocation the run made, one per line. */
const invocations = (log: string): string[] => log.split('\n').filter((line) => line.trim() !== '');

/** A `gh` argv that changes something on the server. */
const MUTATIONS = [/(^|\s)(-X|--method)\s+(POST|PATCH|PUT|DELETE)/i, /^pr (create|merge|edit|review|close|comment)/, /^issue (create|edit|close|comment)/, /^label (create|edit|delete|clone)/, /^api .*-f /, /^repo (edit|delete)/];

const calls = invocations(x.log);
check('AC2 the run made at least one gh read, so the log is not empty by accident', calls.length > 0, x.log);
check('AC2 the fake gh recorded no mutating verb', calls.every((line) => !MUTATIONS.some((pattern) => pattern.test(line))), x.log);
check(
  'AC2 the run made only the three reads it documents',
  calls.every((line) => line.startsWith('api repos/{owner}/{repo}') || line.startsWith('label list')),
  x.log,
);

// A refusal writes nothing either: the path that exits 1 is held to the same
// rule as the path that exits 0.
const y = fixture({ 'package.json': PACKAGE_JSON });
const yStatus = git(['status', '--porcelain'], y);
const z = doctor([], y, { FAKE_GH_RULES: 'other-checks', FAKE_GH_LABELS: '' });
check('AC2 a refusing run also writes nothing', git(['status', '--porcelain'], y) === yStatus && z.status === 1, `${z.stdout}\n${git(['status', '--porcelain'], y)}`);
check('AC2 a refusing run also calls no mutating verb', invocations(z.log).every((line) => !MUTATIONS.some((pattern) => pattern.test(line))), z.log);

// --- usage --------------------------------------------------------------------

const aa = doctor(['--nonsense'], complete());
check('an unknown flag is reported as a usage error', typeof aa.out?.error === 'string' && aa.out.error.includes('usage'), aa.stdout);
check('an unknown flag exits 1', aa.status === 1, `${aa.stdout}\n${aa.stderr}`);
check('an unknown flag reads nothing', invocations(aa.log).length === 0, aa.log);

const ab = doctor(['--slug', 'Not A Slug'], complete());
check('a slug that is not a slug is reported as a usage error', typeof ab.out?.error === 'string', ab.stdout);

// Outside a git repository there is no repository to report on.
const outside = mkdtempSync(join(tmpdir(), 'agentic-doctor-outside-'));
cleanup(() => rmSync(outside, { recursive: true, force: true }));
const ac = doctor([], outside);
check('run outside a git repository, it reports an error rather than a report', typeof ac.out?.error === 'string', `${ac.stdout}\n${ac.stderr}`);
check('run outside a git repository, it exits 1', ac.status === 1, `${ac.stdout}\n${ac.stderr}`);

finish();
