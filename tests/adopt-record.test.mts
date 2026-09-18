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
// compares a record with detection anywhere in the tree. Sections M and N are
// the exception: `record.mts` is tracked, so their red there is an assertion
// red — on the base of #233 the file exported six names nothing outside it
// read, and on the base of #326 `PROOF_DIR`'s docstring names neither of the
// two modules that import it.
//
// #339 is the one change here with no red on its base: it fixed how M and N
// read the tree — a mention counted as a caller, a `/*` inside a glob opened
// a comment — and touched nothing outside this file, so the fixed sections
// read the base's own tree and are green there. Their red is the `test(red):`
// commits', run against the mechanism this file carried before them; the
// negative control, which overlays this file onto that identical base, cannot
// see it and reports `vacuous`.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, type Dirent } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
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
// #302: `hooks[]` is what adoption *intends* to install, not what the
// inventory found installed. A repository that has adopted nothing yet used to
// record `hooks: []`, so `--hooks` installed no hook for it and `docs/adopt.md`
// documented a hand edit of the record as the way round that — a file
// invariant 4 says no person edits.
check(
  'a repository with no hook installed still records the hook adoption intends to install',
  Array.isArray(jRecord?.hooks) && jRecord.hooks.join(',') === 'pre-push',
  readRaw(bare),
);

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

// --- M: every export of record.mts has a caller (#233, #339) ----------------
// An export nothing calls reads as part of the record's contract without
// being one: `LABELS_SOURCE` and five others were placeholders for steps that
// had not landed, and a reviewer of #193 read them as the shape the record
// promises. The pin makes the next speculative export fail the suite instead
// of shipping — a name that is needed is exported with the call that needs it.
//
// **A caller is an importer, not a mention (#339).** The case used to look
// for `\bNAME\b` in the walked files, so any spelling satisfied it. Measured
// before the change, `\bRECORD_FILE\b` matched 9 files against 5 real
// importers and `\bGENERATED_BY\b` 4 against 2, this file among the matches
// for both — so either name would have passed with zero importers anywhere.
// The test tree is out of the walk for the same reason, and the same way
// section N leaves it out of both its sides: this file re-declares both names
// as literals by design (see the header) and spells `PROOF_DIR` throughout
// section N, and a case that names a constant to assert something about it is
// not the call that justifies the export.
//
// **M and N do not restate one another.** M pins *existence*, over every
// export: each has an importer outside `record.mts` and outside the test
// tree. N pins *the prose* of one of them: `PROOF_DIR`'s docstring names the
// modules that import it, in both directions. Neither implies the other, so
// both are kept and read the tree through the same two helpers below.
//
// The source files are walked rather than listed with `git ls-files`: the
// negative control copies the test files onto a checkout of the base, and
// this case must not depend on that checkout being a git repository.
const RECORD_REL = join('scripts', 'lib', 'adopt', 'record.mts');
const RECORD_SRC = readFileSync(join(ROOT, RECORD_REL), 'utf8');

/** The fixture #339 names for the comment-stripper: its line 81 builds a glob. */
const PR_REL = join('scripts', 'lib', 'adopt', 'pr.mts');
const PR_SRC = readFileSync(join(ROOT, PR_REL), 'utf8');

const QUOTES = new Set(["'", '"']);

/** The characters after which a `/` opens a regex literal rather than dividing. */
const BEFORE_REGEX = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '^', '~', '<', '>', '\n']);

/** The keywords after which it opens one too. */
const KEYWORD_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield', 'await']);

/** Whether the `/` that follows this much code opens a regex literal. */
const opensRegex = (previous: string, out: string): boolean =>
  BEFORE_REGEX.has(previous) || KEYWORD_BEFORE_REGEX.has(out.match(/([A-Za-z_$][\w$]*)\s*$/)?.[1] ?? '');

/**
 * A file's code, with its comments removed and its strings left standing: a
 * mention is not a caller (this case names `LABELS_SOURCE` above), but code
 * inside a string is still code (#339). A `/*` inside a string or a template
 * literal opens no comment — `scripts/lib/adopt/pr.mts:81` builds
 * `` `${WORKFLOW_DIR}/**` ``, which used to swallow 238 characters over lines
 * 81-87, one of that file's two `PROOF_DIR` occurrences with them — and a
 * quote inside a regex literal (`hooks/protect-main.mts:83`,
 * `ci/lib/scope.mts:38`) or a template literal nested in a `${…}`
 * (`ci/negative-control.mts:233`) no longer opens a string running to the
 * next matching quote, which left every comment in that span standing as
 * code. That direction is the silent one: a commented-out import counting as
 * a caller. Whether a `/` opens a regex or divides is decided by the
 * character before it, as a tokeniser does it; a division misread as a regex
 * stops at its line end rather than running away.
 */
function code(text: string): string {
  let out = '';
  let i = 0;
  let previous = '';
  /** Copies the next `n` characters through, comments excepted: they never reach here. */
  const take = (n = 1): void => {
    out += text.slice(i, i + n);
    i += n;
  };
  const string = (quote: string): void => {
    take();
    while (i < text.length) {
      const ch = text[i] ?? '';
      if (ch === '\\') { take(2); continue; }
      take();
      if (ch === quote) return;
    }
  };
  /** A template literal, substitutions included: `${…}` is code, and may hold another one. */
  const template = (): void => {
    take();
    while (i < text.length) {
      const ch = text[i] ?? '';
      if (ch === '\\') { take(2); continue; }
      if (ch === '$' && text[i + 1] === '{') {
        take(2);
        scan(true);
        continue;
      }
      take();
      if (ch === '`') return;
    }
  };
  const regex = (): void => {
    take();
    let inClass = false;
    while (i < text.length) {
      const ch = text[i] ?? '';
      if (ch === '\\') { take(2); continue; }
      take();
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '\n' || (ch === '/' && !inClass)) return;
    }
  };
  function scan(untilBrace: boolean): void {
    let depth = 0;
    while (i < text.length) {
      const ch = text[i] ?? '';
      const next = text[i + 1] ?? '';
      if (ch === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
        continue;
      }
      if (QUOTES.has(ch) || ch === '`') {
        if (ch === '`') template();
        else string(ch);
        previous = ch;
        continue;
      }
      if (ch === '/' && opensRegex(previous, out)) {
        regex();
        previous = '/';
        continue;
      }
      if (untilBrace && ch === '}' && depth === 0) {
        take();
        return;
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      take();
      if (ch.trim().length > 0 || ch === '\n') previous = ch;
    }
  }
  scan(false);
  return out;
}

/** How many times one name appears as a whole word in a text. */
const occurrences = (text: string, name: string): number => (text.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;

/** A file's text as one line, so an import list that wraps still reads as one statement. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ');

/**
 * The names one file imports from any `record.mts`, `type` prefixes and
 * aliases removed. Both quote styles count, `import type { … }` counts, and a
 * namespace import contributes every name the file then reads off it
 * (`import * as record from …` plus `record.PROOF_DIR`). Reading only
 * single-quoted brace imports missed a real caller and reported it as none,
 * which is a false pass on the side that matters (#339).
 *
 * The text is read through `code()` first: a commented-out import is not an
 * import.
 */
function importsFromRecord(raw: string): string[] {
  const text = oneLine(code(raw));
  const named = [...text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"][^'"]*record\.mts['"]/g)]
    .flatMap((m) => (m[1] ?? '').split(','))
    .map((name) => name.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim() ?? '');
  const namespaces = [...text.matchAll(/import\s+(?:type\s+)?\*\s+as\s+(\w+)\s+from\s+['"][^'"]*record\.mts['"]/g)].map(
    (m) => m[1] ?? '',
  );
  const read = namespaces.flatMap((alias) =>
    [...text.matchAll(new RegExp(`\\b${alias}\\.(\\w+)`, 'g'))].map((m) => m[1] ?? ''),
  );
  return [...named, ...read].filter((name) => name.length > 0);
}

/** Every name `record.mts` exports: a const, a function, a class or a type. */
const EXPORTED = [...RECORD_SRC.matchAll(/^export (?:const|function|class|type|interface) (\w+)/gm)].map((m) => m[1] ?? '');

/** Every `.mts` file under the directories `tsconfig.json` compiles. */
function sources(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return path.endsWith('.mts') ? [path] : [];
  });
}

/** Whether one file's text counts as a caller of one export of `record.mts`. */
const isCaller = (text: string, name: string): boolean => importsFromRecord(text).includes(name);

/** The directories the caller side walks. `tests` is deliberately not one of them. */
const CALLER_DIRS = ['hooks', 'ci', 'scripts', join('.agents', 'skills')];

/** Every file the caller side walks, with the path its text came from. */
const CALLER_FILES = CALLER_DIRS.flatMap((dir) => sources(join(ROOT, dir)))
  .filter((path) => path !== join(ROOT, RECORD_REL))
  .map((path) => ({ rel: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }));

/** The files that count as callers of one export, by path relative to the root. */
const callersOf = (name: string): string[] => CALLER_FILES.filter((file) => isCaller(file.text, name)).map((file) => file.rel);

const orphans = EXPORTED.filter((name) => callersOf(name).length === 0);
check('record.mts exports something at all (the walk found the file)', EXPORTED.length > 0, RECORD_REL);
check('the caller walk found the rest of the tree', CALLER_FILES.length > 10, `${CALLER_FILES.length} source files read`);
check(
  'every export of record.mts is imported outside it',
  orphans.length === 0,
  `exported and never imported: ${orphans.join(', ')}`,
);

// The pin says "has a caller", so it must be able to tell a caller from a
// mention (#339). A name spelled in a string, a comment or a re-declaration
// is not a call, and the test tree is not the caller side at all: this file
// re-declares `RECORD_FILE` and `GENERATED_BY` as literals by design (see
// the header), so counting it would let either name pass with zero importers
// anywhere in the tree.
check(
  'a re-declaration of an export is not a caller',
  !isCaller("const RECORD_FILE = 'agentic.config.json';", 'RECORD_FILE'),
  'a literal that re-declares the name counts as a caller',
);
check(
  'an import of an export is a caller',
  isCaller("import { RECORD_FILE } from './record.mts';", 'RECORD_FILE'),
  'an import of the name does not count as a caller',
);
const fromTests = EXPORTED.flatMap((name) =>
  callersOf(name)
    .filter((rel) => rel.startsWith(`tests${sep}`))
    .map((rel) => `${name} <- ${rel}`),
);
check(
  'no file under tests/ stands in as a caller of an export',
  fromTests.length === 0,
  `counted as callers: ${fromTests.join(', ')} (the walk reads ${CALLER_DIRS.join(', ')})`,
);

// And it must read code as code (#339). The fixtures below are miniatures of
// the real cases: `scripts/lib/adopt/pr.mts:81` builds `${WORKFLOW_DIR}/**` in
// a template literal, `hooks/protect-main.mts:83` puts a quote inside a regex
// literal and `ci/lib/scope.mts:38` a backtick, and `ci/negative-control.mts:233`
// nests a template literal in a substitution and follows it with an apostrophe.
// Each of those used to swallow the code, or the comments, after it.
check(
  'the stripper leaves a glob inside a template literal alone',
  occurrences(code(PR_SRC), 'PROOF_DIR') === occurrences(PR_SRC, 'PROOF_DIR'),
  `${PR_REL}: ${occurrences(PR_SRC, 'PROOF_DIR')} PROOF_DIR occurrences, ${occurrences(code(PR_SRC), 'PROOF_DIR')} survive the stripper`,
);
const HIDDEN_IMPORT = "// import { PROOF_DIR } from './record.mts';";
const NESTED = 'const line = `note: ${globs.map((g) => `\\`${g}\\``).join(\', \')} — the gate\'s own code`;';

/** One fixture each, with the `PROOF_DIR` occurrences its code must still have. */
const STRIPPER_CASES: Array<[string, string, number]> = [
  ['a /* inside a template literal does not open a comment', 'const glob = `${DIR}/**`;\nconst kept = PROOF_DIR;\n/** a docstring */', 1],
  ['a real block comment is still stripped', '/* PROOF_DIR */ const kept = 1;', 0],
  ['a real line comment is still stripped', '// PROOF_DIR\nconst kept = 1;', 0],
  ['a quote inside a regex literal does not open a string', `const quoted = /^(['"])(.*)\\1$/;\n${HIDDEN_IMPORT}\nconst kept = PROOF_DIR;`, 1],
  ['a backtick inside a regex literal does not open a template literal', 'const backticked = /`([^`]+)`/g;\n// PROOF_DIR\nconst kept = 1;', 0],
  ['a template literal inside a substitution does not end the one around it', `${NESTED}\n${HIDDEN_IMPORT}\nconst kept = PROOF_DIR;`, 1],
];
for (const [name, fixture, left] of STRIPPER_CASES) {
  check(name, occurrences(code(fixture), 'PROOF_DIR') === left, `${occurrences(code(fixture), 'PROOF_DIR')} occurrences left, not ${left}`);
}
check(
  'a commented-out import is not an import',
  !isCaller(HIDDEN_IMPORT, 'PROOF_DIR'),
  'a commented-out import counts as a caller',
);

// --- N: the one export #233 could not withdraw says why it stays (#326) -----
// #233's criterion asked for two names to stop being exported. `LABELS_SOURCE`
// is module-private; `PROOF_DIR` is not, and cannot be — `scripts/lib/proof.mts`
// and `scripts/lib/adopt/pr.mts` import it, so withdrawing the export deletes
// two callers rather than a placeholder. Nothing in the tree said that, so
// re-reading the closed criterion against the file read the export as an
// unfixed leftover and #326 was filed on that reading.
//
// Section M answers "does this export have a caller" for the suite, over
// every export. This one answers it for a person, about one name, and holds
// the answer to the tree in both directions: every module the docstring names
// must import the constant from this file, and every module that imports it
// must be named. One direction alone would let the paragraph go stale — a
// third caller added without a line here is the drift that left #233 half
// met. Neither section implies the other, so #339 kept both and gave them one
// mechanism instead of two: `importsFromRecord` above is the only import
// reader either side has. This section's own copy read single-quoted brace
// imports only, so an `import * as` or a double-quoted specifier reported a
// real caller as none — a false pass on the side that decides this case.
//
// The docstring is read as the block immediately above the export, not by a
// search of the whole file.
const PROOF_DIR_AT = RECORD_SRC.indexOf('\nexport const PROOF_DIR');
const PROOF_DIR_BLOCKS = PROOF_DIR_AT < 0 ? [] : [...RECORD_SRC.slice(0, PROOF_DIR_AT).matchAll(/\/\*\*([\s\S]*?)\*\//g)];
const PROOF_DIR_DOC = PROOF_DIR_BLOCKS.at(-1)?.[1] ?? '';

/**
 * Every `<path>.mts` the docstring names in backticks, in the order it names
 * them, minus this file: the paragraph names the pin that reads it, and a pin
 * is not a caller — counting it would let the docstring satisfy this case by
 * pointing at the case.
 */
const NAMED_CALLERS = [...PROOF_DIR_DOC.matchAll(/`([\w./-]+\.mts)`/g)]
  .map((m) => m[1] ?? '')
  .filter((rel) => !rel.startsWith('tests/'));

// The same defect class as section M's, on the side that matters here: a
// real caller this reader misses is a false pass, not a false orphan (#339).
// Only a brace import with a single-quoted specifier was read, so an
// `import * as` or a double-quoted specifier reported a caller as none.
check(
  'a double-quoted specifier is read as an import of record.mts',
  importsFromRecord('import { PROOF_DIR } from "./record.mts";').includes('PROOF_DIR'),
  `read: ${importsFromRecord('import { PROOF_DIR } from "./record.mts";').join(', ') || 'nothing'}`,
);
check(
  'a namespace import of record.mts is read as an import of what it reads',
  importsFromRecord("import * as record from './record.mts';\nconst dir = record.PROOF_DIR;").includes('PROOF_DIR'),
  `read: ${importsFromRecord("import * as record from './record.mts';\nconst dir = record.PROOF_DIR;").join(', ') || 'nothing'}`,
);

/**
 * Every module of the tree that imports `PROOF_DIR` from a `record.mts`, by
 * path relative to the root. The test tree is left out of both sides of the
 * comparison: a case that imported the constant to assert something about it
 * would otherwise have to be listed in the docstring as a caller.
 */
const REAL_CALLERS = ['hooks', 'ci', 'scripts', join('.agents', 'skills')]
  .flatMap((dir) => sources(join(ROOT, dir)))
  .filter((path) => path !== join(ROOT, RECORD_REL))
  .filter((path) => importsFromRecord(readFileSync(path, 'utf8')).includes('PROOF_DIR'))
  .map((path) => path.slice(ROOT.length + 1));

check('record.mts still exports PROOF_DIR (this case reads the docstring above it)', PROOF_DIR_AT >= 0, RECORD_REL);
check(
  "PROOF_DIR's docstring names the modules outside record.mts that import it",
  NAMED_CALLERS.length >= 2,
  `named by the docstring: ${NAMED_CALLERS.join(', ') || 'none'}`,
);
for (const rel of NAMED_CALLERS) {
  const path = join(ROOT, rel);
  const present = existsSync(path);
  const imported = present ? importsFromRecord(readFileSync(path, 'utf8')) : [];
  check(
    `${rel}, which PROOF_DIR's docstring names, imports PROOF_DIR from record.mts`,
    imported.includes('PROOF_DIR'),
    present ? `imported from record.mts: ${imported.join(', ') || 'nothing'}` : `${rel} is not in the tree`,
  );
}
const unnamed = REAL_CALLERS.filter((rel) => !NAMED_CALLERS.includes(rel));
check(
  "every module that imports PROOF_DIR is named by PROOF_DIR's docstring",
  unnamed.length === 0,
  `imports PROOF_DIR and is not named: ${unnamed.join(', ') || 'none'} (named: ${NAMED_CALLERS.join(', ') || 'none'})`,
);

finish();
