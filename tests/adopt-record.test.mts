#!/usr/bin/env node
// Cases for the adoption record (#163): `scripts/lib/adopt/record.mts`
// defines, validates and writes `agentic.config.json`, and
// `scripts/adopt.mts --record` is the only thing that produces it.
//
// The script is spawned for real (CLAUDE.md invariant 6) against throwaway
// git repositories, with a small fake `gh` first on PATH: the three reads
// `takeInventory` makes, plus the `issue list`/`label create`/`issue create`
// the one `--plan-issue` case needs, dumping that issue's arguments
// NUL-separated so its body can be read back.
//
// Nothing here imports the code under test. The record's file name and this
// tool's `generatedBy` are written out as literals below: they are the
// contract the script is held to, and importing them from the module that
// produces them would let both sides move together without a case noticing.
//
// Negative control: on the base there is no `--record` flag at all, so every
// `--record` spawn exits 1 on usage with nothing to parse, and no report
// carries a `record` key or the `record:stale` gap — nothing on the base
// compares a record with detection anywhere in the tree.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

/** The record's name, as `docs/adopt.md` and `docs/decisions.md` item 15 name it. */
const RECORD_FILE = 'agentic.config.json';

/** The only `generatedBy` the script may overwrite without `--force`. */
const GENERATED_BY = 'agentic-setup/adopt';

// --- a fake `gh` -------------------------------------------------------------
const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
case "\${1:-} \${2:-}" in
  "api repos/{owner}/{repo}")
    echo '{"default_branch":"main","allow_auto_merge":true,"delete_branch_on_merge":false}'
    ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    echo '[{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"scope"},{"context":"negative-control"}]}}]'
    ;;
  "label list")
    echo '[]'
    ;;
  "issue list")
    echo '[]'
    ;;
  "label create")
    echo "fake-gh: label created"
    ;;
  "issue create")
    : > "$state/issue-create.args"
    for a in "$@"; do printf '%s\\0' "$a" >> "$state/issue-create.args"; done
    echo "https://github.com/org/repo/issues/7"
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-record-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// This repository dogfoods itself, so the shell running the suite may have
// the detection overrides set for real; every case below asserts the
// *detected* commands.
const { AGENTIC_TEST_CMD: _t, AGENTIC_CHECK_CMD: _c, ...BASE_ENV } = process.env;

type Run = { status: number | null; stdout: string; stderr: string; stateDir: string };

/** A fresh directory for the fake `gh` to dump what it was asked to create into. */
function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-record-state-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function adopt(args: string[], cwd: string, stateDir = newStateDir()): Run {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'adopt.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', stateDir };
}

/** The `gh issue create` argument that followed `flag`, or ''. */
function createdArg(stateDir: string, flag: string): string {
  const path = join(stateDir, 'issue-create.args');
  if (!existsSync(path)) return '';
  const args = readFileSync(path, 'utf8').split('\0').filter((s) => s.length > 0);
  const i = args.indexOf(flag);
  return i === -1 ? '' : (args[i + 1] ?? '');
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** A committed throwaway repository; `files` land in the initial commit. */
function fixture(files: Record<string, string>): string {
  const dir = tempRepo();
  commit(dir, { 'README.md': '# fixture\n', ...files }, 'initial');
  return dir;
}

/** package.json with a `check` script and, optionally, a `test` one. */
const pkg = (withTest: boolean): string =>
  JSON.stringify({ name: 'fx', scripts: withTest ? { test: 'node t.mjs', check: 'tsc' } : { check: 'tsc' } });

const recordAt = (dir: string): string => join(dir, RECORD_FILE);
const readRaw = (dir: string): string => (existsSync(recordAt(dir)) ? readFileSync(recordAt(dir), 'utf8') : '');
const readRecord = (dir: string): any => parse(readRaw(dir));
/** Overwrites the record with arbitrary text, the way a person would. */
const handEdit = (dir: string, text: string): void => writeFileSync(recordAt(dir), text);
/** The `changed` entry for one field, or undefined. */
const changedField = (out: any, field: string): any =>
  Array.isArray(out?.changed) ? out.changed.find((c: any) => c?.field === field) : undefined;

const RECORD_FIELDS = ['version', 'stack', 'commands', 'checks', 'hooks', 'proof', 'labels', 'generatedAt', 'generatedBy'];

// --- A: --record writes the record, and only the record ---------------------
const repo = fixture({ 'package.json': pkg(false) });
const a = adopt(['--record'], repo);
const aOut = parse(a.stdout);
check('--record exits 0', a.status === 0 && aOut !== null, `${a.stdout}\n${a.stderr}`);
check('--record reports the file it wrote', aOut?.record === RECORD_FILE && aOut?.written === true, a.stdout);
check('--record on a repository with no record reports nothing changed', Array.isArray(aOut?.changed) && aOut.changed.length === 0, a.stdout);
check('--record creates the record at the repository root', existsSync(recordAt(repo)), recordAt(repo));

const written = readRecord(repo);
check(
  '--record writes every field of the shape',
  written !== null && RECORD_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(written, k)),
  `missing: ${RECORD_FIELDS.filter((k) => !written || !Object.prototype.hasOwnProperty.call(written, k)).join(', ')} — ${readRaw(repo)}`,
);
check('the record carries a version', typeof written?.version === 'number' && written.version >= 1, readRaw(repo));
check(
  'the record carries the detected stack and commands',
  written?.stack === 'node' && written?.commands?.test === null && written?.commands?.check === 'npm run check',
  readRaw(repo),
);
check(
  'the record carries the required checks, the hooks, the proof directory and the label source',
  Array.isArray(written?.checks) &&
    written.checks.includes('negative-control') &&
    Array.isArray(written?.hooks) &&
    typeof written?.proof?.dir === 'string' &&
    written.proof.dir.length > 0 &&
    typeof written?.labels?.source === 'string' &&
    written.labels.source.length > 0,
  readRaw(repo),
);
check('the record says this tool generated it', written?.generatedBy === GENERATED_BY, readRaw(repo));
check(
  'the record carries a timestamp that is a real instant',
  typeof written?.generatedAt === 'string' && !Number.isNaN(Date.parse(written.generatedAt)),
  readRaw(repo),
);
check(
  '--record wrote the record and nothing else',
  git(['status', '--porcelain'], repo) === `?? ${RECORD_FILE}`,
  git(['status', '--porcelain'], repo),
);

// --- B: the record is read back, and agrees with detection -------------------
const b = adopt(['--inventory'], repo);
const bOut = parse(b.stdout);
check('--inventory with a fresh record exits 0', b.status === 0 && bOut !== null, `${b.stdout}\n${b.stderr}`);
check('--inventory reports the record it found', bOut?.record !== null && bOut?.record !== undefined, b.stdout);
check(
  'a record that agrees with detection is not stale',
  Array.isArray(bOut?.gaps) && !bOut.gaps.includes('record:stale') && Array.isArray(bOut?.record?.stale) && bOut.record.stale.length === 0,
  b.stdout,
);

// --- C: detection stays the default -----------------------------------------
// The repository gains a test script after the record was written. Detection
// runs on every read, so the disagreement is named rather than ignored.
writeFileSync(join(repo, 'package.json'), pkg(true));
const beforeStale = git(['status', '--porcelain'], repo);
const c = adopt(['--inventory'], repo);
const cOut = parse(c.stdout);
check('--inventory over a stale record still exits 0', c.status === 0 && cOut !== null, `${c.stdout}\n${c.stderr}`);
check('a record detection no longer agrees with is reported as record:stale', Array.isArray(cOut?.gaps) && cOut.gaps.includes('record:stale'), c.stdout);
check(
  'the stale report names the field that disagrees, not just the gap',
  Array.isArray(cOut?.record?.stale) && cOut.record.stale.includes('commands.test'),
  c.stdout,
);
check('--inventory reports detection, never the record, as the stack and commands', cOut?.test === 'npm test', c.stdout);
check('--inventory over a stale record still writes nothing', git(['status', '--porcelain'], repo) === beforeStale, git(['status', '--porcelain'], repo));

// --- D: --record --force rewrites and reports every field that changed -------
const d = adopt(['--record', '--force'], repo);
const dOut = parse(d.stdout);
check('--record --force exits 0', d.status === 0 && dOut !== null, `${d.stdout}\n${d.stderr}`);
const dTest = changedField(dOut, 'commands.test');
check(
  '--record --force reports the field that changed, with its old and new value',
  dTest !== undefined && dTest.from === null && dTest.to === 'npm test',
  d.stdout,
);
check('the rewritten record holds the newly detected command', readRecord(repo)?.commands?.test === 'npm test', readRaw(repo));

const dAfter = adopt(['--inventory'], repo);
const dAfterOut = parse(dAfter.stdout);
check(
  'a rewritten record is no longer stale',
  Array.isArray(dAfterOut?.gaps) && !dAfterOut.gaps.includes('record:stale'),
  dAfter.stdout,
);

// --- E: rewriting an unchanged record changes nothing ------------------------
const e = adopt(['--record'], repo);
const eOut = parse(e.stdout);
check('--record over a current record this tool generated exits 0', e.status === 0 && eOut !== null, `${e.stdout}\n${e.stderr}`);
check('rewriting an unchanged record reports no changed field', Array.isArray(eOut?.changed) && eOut.changed.length === 0, e.stdout);
check(
  'the timestamp is not reported as a change (it moves on every write by definition)',
  changedField(eOut, 'generatedAt') === undefined,
  e.stdout,
);

// --- F: a record this tool did not generate is never overwritten -------------
const handEdited = { ...readRecord(repo), generatedBy: 'a person, by hand' };
handEdit(repo, `${JSON.stringify(handEdited, null, 2)}\n`);
const beforeRefusal = readRaw(repo);
const f = adopt(['--record'], repo);
const fOut = parse(f.stdout);
check('--record over a hand-edited record exits 1', f.status === 1 && fOut !== null, `${f.stdout}\n${f.stderr}`);
check(
  '--record over a hand-edited record reports { refused, reason: record:not-ours }',
  fOut?.refused !== undefined && fOut?.reason === 'record:not-ours',
  f.stdout,
);
check('--record over a hand-edited record leaves the file byte-identical', readRaw(repo) === beforeRefusal, readRaw(repo));

// --- G: --force is the way past that refusal --------------------------------
const g = adopt(['--record', '--force'], repo);
const gOut = parse(g.stdout);
check('--record --force over a hand-edited record exits 0', g.status === 0 && gOut !== null, `${g.stdout}\n${g.stderr}`);
check(
  '--record --force reports generatedBy among the fields it changed',
  changedField(gOut, 'generatedBy')?.from === 'a person, by hand' && changedField(gOut, 'generatedBy')?.to === GENERATED_BY,
  g.stdout,
);
check('--record --force puts the record back under this tool', readRecord(repo)?.generatedBy === GENERATED_BY, readRaw(repo));

// --- H: a record that is not the shape is a named error, never a default ----
// Every case fails closed: exit 1, a named reason, and the file left alone.
type Broken = { name: string; text: string; reason: string; field?: string };
const valid = readRecord(repo);
const BROKEN: Broken[] = [
  { name: 'an unknown key', text: JSON.stringify({ ...valid, surprise: 1 }), reason: 'record:unknown-key', field: 'surprise' },
  {
    name: 'an unknown key inside a nested object',
    text: JSON.stringify({ ...valid, commands: { ...valid.commands, surprise: 1 } }),
    reason: 'record:unknown-key',
    field: 'commands.surprise',
  },
  { name: 'a missing required field', text: JSON.stringify({ ...valid, stack: undefined }), reason: 'record:missing-field', field: 'stack' },
  { name: 'a missing nested field', text: JSON.stringify({ ...valid, proof: {} }), reason: 'record:missing-field', field: 'proof.dir' },
  { name: 'a field of the wrong type', text: JSON.stringify({ ...valid, checks: 'negative-control' }), reason: 'record:wrong-type', field: 'checks' },
  { name: 'a nested field of the wrong type', text: JSON.stringify({ ...valid, commands: { test: 1, check: null } }), reason: 'record:wrong-type', field: 'commands.test' },
  { name: 'an array holding the wrong type', text: JSON.stringify({ ...valid, hooks: [1] }), reason: 'record:wrong-type', field: 'hooks' },
  { name: 'a version this reader does not know', text: JSON.stringify({ ...valid, version: 99 }), reason: 'record:unknown-version', field: 'version' },
  { name: 'text that is not JSON at all', text: '{ not json', reason: 'record:unparsable' },
  { name: 'JSON that is not an object', text: '[]', reason: 'record:wrong-type' },
];

for (const broken of BROKEN) {
  handEdit(repo, broken.text);
  const before = readRaw(repo);
  const r = adopt(['--record'], repo);
  const out = parse(r.stdout);
  check(`${broken.name} exits 1 with { error: ${broken.reason} }`, r.status === 1 && out?.error === broken.reason, `${r.stdout}\n${r.stderr}`);
  if (broken.field !== undefined) {
    check(`${broken.name} names the field it rejected`, out?.field === broken.field, r.stdout);
  }
  check(`${broken.name} is never silently replaced by a default`, readRaw(repo) === before, readRaw(repo));

  const inv = adopt(['--inventory'], repo);
  const invOut = parse(inv.stdout);
  check(`${broken.name} also fails --inventory closed, with the same named reason`, inv.status === 1 && invOut?.error === broken.reason, `${inv.stdout}\n${inv.stderr}`);
  check(`${broken.name} never lets --inventory report a gap list at all`, invOut !== null && !Object.prototype.hasOwnProperty.call(invOut, 'gaps'), inv.stdout);
}

// --- I: usage ----------------------------------------------------------------
const iBoth = adopt(['--record', '--inventory'], repo);
check(
  'two flags at once exits 1 with { error: usage… } before anything is read',
  iBoth.status === 1 && typeof parse(iBoth.stdout)?.error === 'string' && /usage/.test(parse(iBoth.stdout).error),
  `${iBoth.stdout}\n${iBoth.stderr}`,
);

const iForce = adopt(['--force'], repo);
check(
  '--force on its own is a usage error, not a silent record write',
  iForce.status === 1 && /usage/.test(parse(iForce.stdout)?.error ?? ''),
  `${iForce.stdout}\n${iForce.stderr}`,
);

// --- J: the record is written from the inventory, on a bare repository too ---
const bare = fixture({});
const j = adopt(['--record'], bare);
const jOut = parse(j.stdout);
check('--record on a repository with no stack exits 0', j.status === 0 && jOut !== null, `${j.stdout}\n${j.stderr}`);
const jRecord = readRecord(bare);
check(
  'a repository with nothing detected records nulls, not invented commands',
  jRecord?.stack === 'unknown' && jRecord?.commands?.test === null && jRecord?.commands?.check === null,
  readRaw(bare),
);
check('a repository with no hook installed records an empty hooks list', Array.isArray(jRecord?.hooks) && jRecord.hooks.length === 0, readRaw(bare));

// --- K: a stale record reaches the plan issue, and the reported gaps --------
// `--plan-issue` renders the same report `--inventory` prints, so a record
// detection no longer agrees with has to appear in both the JSON it prints
// and the checkboxes a person ticks — otherwise the one gap adoption
// introduced is the one gap the plan never mentions.
const planned = fixture({ 'package.json': pkg(false) });
check('the plan fixture starts with a record', adopt(['--record'], planned).status === 0, readRaw(planned));
writeFileSync(join(planned, 'package.json'), pkg(true));

const k = adopt(['--plan-issue'], planned);
const kOut = parse(k.stdout);
check('--plan-issue with a stale record exits 0', k.status === 0 && kOut !== null, `${k.stdout}\n${k.stderr}`);
check(
  '--plan-issue reports record:stale among the gaps it printed',
  Array.isArray(kOut?.gaps) && kOut.gaps.includes('record:stale'),
  k.stdout,
);
const kBody = createdArg(k.stateDir, '--body');
check(
  'the plan issue body lists record:stale as a checkbox with a remedy',
  /^- \[ \] `record:stale` — .{20,}$/m.test(kBody),
  kBody,
);
check(
  'the plan issue body says the record is stale and on which field',
  /- Adoption record: .*stale on `commands\.test`/.test(kBody),
  kBody,
);

// --- L: the record's own fail-closed branches -------------------------------
// A record that exists and cannot be read is not a record that is absent,
// and a record that cannot be written is not a record that was written.
const IS_ROOT = process.getuid?.() === 0;

/** Runs `fn` with `path` at `mode`, and puts the mode back afterwards. */
function withMode<T>(path: string, mode: number, fn: () => T): T {
  const original = statSync(path).mode & 0o7777;
  const restore = () => {
    try {
      chmodSync(path, original);
    } catch {
      /* already restored */
    }
  };
  cleanup(restore);
  chmodSync(path, mode);
  try {
    return fn();
  } finally {
    restore();
  }
}

if (IS_ROOT) {
  check('unreadable and unwritable record cases skipped (running as root, which EACCES cannot stop)', true);
} else {
  const locked = fixture({ 'package.json': pkg(true) });
  check('the locked fixture starts with a record', adopt(['--record'], locked).status === 0, readRaw(locked));

  const lUnreadable = withMode(recordAt(locked), 0o000, () => adopt(['--inventory'], locked));
  const lUnreadableOut = parse(lUnreadable.stdout);
  check(
    'a record that exists and cannot be read exits 1 with { error: record:unreadable }',
    lUnreadable.status === 1 && lUnreadableOut?.error === 'record:unreadable',
    `${lUnreadable.stdout}\n${lUnreadable.stderr}`,
  );
  check(
    'an unreadable record is never reported as no record at all',
    lUnreadableOut !== null && !Object.prototype.hasOwnProperty.call(lUnreadableOut, 'record'),
    lUnreadable.stdout,
  );

  // Readable, valid and ours — so the run gets all the way to the write, and
  // only the write fails.
  const before = readRaw(locked);
  const lNotWritten = withMode(recordAt(locked), 0o444, () => adopt(['--record'], locked));
  const lNotWrittenOut = parse(lNotWritten.stdout);
  check(
    'a record that cannot be written exits 1 with { error: record:not-written }',
    lNotWritten.status === 1 && lNotWrittenOut?.error === 'record:not-written',
    `${lNotWritten.stdout}\n${lNotWritten.stderr}`,
  );
  check('a failed write never reports { written: true }', lNotWrittenOut?.written === undefined, lNotWritten.stdout);
  check('a failed write leaves the record as it found it', readRaw(locked) === before, readRaw(locked));
}

finish();
