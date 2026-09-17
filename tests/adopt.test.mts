#!/usr/bin/env node
// Hardening cases for scripts/adopt.mts (#215): the branches the second
// review round of #193 found open. `tests/adopt-inventory.test.mts` covers
// what `--inventory` and `--plan-issue` report; this file covers what they
// refuse, and the harness rules that keep such a refusal readable.
//
// The script is spawned for real (CLAUDE.md invariant 6) against throwaway
// git repositories, with a fake `gh` first on PATH. That fake validates
// every environment knob it reads against a closed set before it answers
// anything: an unrecognised value is a typo, and a typo that behaved like
// the default would make a case here pass for the wrong reason. It records
// the rejection in a marker file because `scripts/adopt.mts` reports a read
// that failed by its own named reason and never by `gh`'s wording, so the
// knob error is invisible on stdout by design.
//
// Negative control: the zero-gap refusal below is an assertion red —
// `scripts/adopt.mts` exists on the base and opens an issue with an empty
// checklist there instead of refusing, so the case fails on the base with
// the script present.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

// The label vocabulary scripts/init.mts seeds; a repository missing any of
// it carries the `labels:missing` gap, and a repository with all of it and
// nothing else missing is the one case `--plan-issue` has no question for.
const ALL_LABELS = [
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
const ALL_LABELS_JSON = JSON.stringify(ALL_LABELS.map((name) => ({ name })));

/** Every value each knob accepts; anything else is a typo and is refused. */
const KNOBS = {
  FAKE_GH_FAIL: ['', 'repo', 'issue-list', 'issue-create'],
  FAKE_GH_RULES: ['', 'full'],
  FAKE_GH_LABELS: ['', 'all'],
};

/** `knob NAME "$NAME" allowed...` lines, one per knob, in a stable order. */
const KNOB_GUARDS = Object.entries(KNOBS)
  .map(([name, values]) => `knob ${name} "\${${name}:-}" ${values.map((v) => `'${v}'`).join(' ')}`)
  .join('\n');

// --- a fake `gh` on PATH that refuses a knob it does not know ---------------
const FAKE_GH = `#!/usr/bin/env bash
set -u
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"

# A gating variable is read against a closed set of values, never trusted as
# typed: an unrecognised value stops the fake with a named error instead of
# falling through to the default branch of the case below.
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
    echo '{"default_branch":"main","allow_auto_merge":true,"delete_branch_on_merge":false}'
    ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    case "\${FAKE_GH_RULES:-}" in
      full) echo '[{"type":"deletion"},{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"scope"},{"context":"negative-control"}]}}]' ;;
      *) echo '[]' ;;
    esac
    ;;
  "label list")
    case "\${FAKE_GH_LABELS:-}" in
      all) echo '${ALL_LABELS_JSON}' ;;
      *) echo '[]' ;;
    esac
    ;;
  "issue list")
    if [ "\${FAKE_GH_FAIL:-}" = "issue-list" ]; then echo "fake-gh: issue search failed" >&2; exit 1; fi
    echo '[]'
    ;;
  "issue create")
    if [ "\${FAKE_GH_FAIL:-}" = "issue-create" ]; then echo "fake-gh: could not create the issue" >&2; exit 1; fi
    : > "$state/issue-create.args"
    for a in "$@"; do printf '%s\\0' "$a" >> "$state/issue-create.args"; done
    echo "https://github.com/org/repo/issues/7"
    ;;
  "label create")
    echo "fake-gh: label created"
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-hardening-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
const FAKE_GH_PATH = join(fakeGhDir, 'gh');
writeFileSync(FAKE_GH_PATH, FAKE_GH);
chmodSync(FAKE_GH_PATH, 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a fake `git` behind a path that contains a space ------------------------
// The shim the inventory cases wrap git in interpolates an absolute path into
// a shell script. Word-splitting is the failure mode that only shows up on a
// machine whose git lives under "Program Files" or "My Repos", so the shim is
// exercised here from a directory that has a space in its name: unquoted, the
// `exec` below runs a command that does not exist.
const REAL_GIT = (spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout ?? '').trim();
const spacedDir = mkdtempSync(join(tmpdir(), 'agentic-spaced-adopt-'));
cleanup(() => rmSync(spacedDir, { recursive: true, force: true }));
const SPACED_GIT_DIR = join(spacedDir, 'git wrapper dir');
mkdirSync(SPACED_GIT_DIR, { recursive: true });
const SPACED_GIT = join(SPACED_GIT_DIR, 'real git');
writeFileSync(SPACED_GIT, `#!/usr/bin/env bash\nexec "${REAL_GIT}" "$@"\n`);
chmodSync(SPACED_GIT, 0o755);

const FAKE_GIT = `#!/usr/bin/env bash
exec "${SPACED_GIT}" "$@"
`;
const fakeGitDir = mkdtempSync(join(tmpdir(), 'agentic-fakegit-hardening-'));
cleanup(() => rmSync(fakeGitDir, { recursive: true, force: true }));
const FAKE_GIT_PATH = join(fakeGitDir, 'git');
writeFileSync(FAKE_GIT_PATH, FAKE_GIT);
chmodSync(FAKE_GIT_PATH, 0o755);
const PATH_WITH_SPACED_GIT = `${fakeGitDir}:${PATH_WITH_FAKE_GH}`;

// --- fixtures ----------------------------------------------------------------
const WORKFLOW = 'name: x\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n';
const OUR_PRE_PUSH = '#!/bin/sh\n# agentic-setup pre-push\nexit 0\n';

/** A committed throwaway repository; `files` land in the initial commit. */
function fixture(files: Record<string, string>): string {
  const dir = tempRepo();
  commit(dir, { 'README.md': '# fixture\n', ...files }, 'initial');
  return dir;
}

/** Installs a pre-push hook that looks like the one scripts/init.mts writes. */
function installPrePush(dir: string): void {
  const path = join(dir, '.git', 'hooks', 'pre-push');
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  writeFileSync(path, OUR_PRE_PUSH);
  chmodSync(path, 0o755);
}

function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-adopt-hardening-state-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  return dir;
}

type Run = { status: number | null; stdout: string; stderr: string; log: string; stateDir: string };

// The detection overrides are stripped from the inherited environment: this
// repository dogfoods itself, so the shell running this suite may have them
// set for real, and the fixtures below assert the *detected* commands.
const { AGENTIC_TEST_CMD: _t, AGENTIC_CHECK_CMD: _c, ...BASE_ENV } = process.env;

function adopt(args: string[], cwd: string, env: Record<string, string> = {}, stateDir = newStateDir()): Run {
  writeFileSync(join(stateDir, 'gh-argv.log'), '');
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'adopt.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, ...env },
  });
  const logPath = join(stateDir, 'gh-argv.log');
  return {
    status: r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    log: existsSync(logPath) ? readFileSync(logPath, 'utf8') : '',
    stateDir,
  };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** How many times `gh` was asked to run the given subcommand in one run. */
const ran = (log: string, verb: string): number => (log.match(new RegExp(`^${verb} `, 'gm')) ?? []).length;

/** Everything a fully adopted repository has, so the report names no gap. */
const WHOLE_ENV = { FAKE_GH_RULES: 'full', FAKE_GH_LABELS: 'all' };
const whole = fixture({
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs', check: 'tsc' } }),
  '.github/workflows/agentic-checks.yml': WORKFLOW,
  '.github/workflows/guard-main.yml': WORKFLOW,
  '.github/workflows/issue-lint.yml': WORKFLOW,
});
installPrePush(whole);

// --- A: the fixture really has nothing left to plan --------------------------
// The control for case B: a refusal that fired because the fixture was
// accidentally incomplete would prove nothing.
const a = adopt(['--inventory'], whole, WHOLE_ENV);
const aOut = parse(a.stdout);
check('the whole repository fixture reports no gap at all', a.status === 0 && Array.isArray(aOut?.gaps) && aOut.gaps.length === 0, `${a.stdout}\n${a.stderr}`);
check('the whole repository fixture has no adoption record, so no record:stale', aOut?.record === null, a.stdout);

// --- B: --plan-issue with zero gaps refuses, and opens nothing ---------------
const b = adopt(['--plan-issue'], whole, WHOLE_ENV);
const bOut = parse(b.stdout);
check('zero-gap --plan-issue exits 1 with JSON on stdout', b.status === 1 && bOut !== null, `${b.stdout}\n${b.stderr}`);
check(
  'zero-gap --plan-issue reports { refused, reason: plan-issue:nothing-to-plan, gaps: [] }',
  typeof bOut?.refused === 'string' &&
    bOut.refused.length > 0 &&
    bOut?.reason === 'plan-issue:nothing-to-plan' &&
    Array.isArray(bOut?.gaps) &&
    bOut.gaps.length === 0,
  b.stdout,
);
check('zero-gap --plan-issue opens no issue', ran(b.log, 'issue create') === 0, b.log);
check(
  'zero-gap --plan-issue makes no gh call beyond the inventory reads: no search, no label create',
  ran(b.log, 'issue list') === 0 && ran(b.log, 'label create') === 0,
  b.log,
);
check('zero-gap --plan-issue never reports { error }: nothing failed', bOut !== null && bOut.error === undefined, b.stdout);
check('zero-gap --plan-issue leaves the working tree byte-identical', git(['status', '--porcelain'], whole) === '', git(['status', '--porcelain'], whole));

// --- C: a gh issue create that fails is named, with gh's own message ---------
// The refusal shape the rest of the script uses: a stable name a caller
// branches on, and the tool's wording kept out of it and in `detail`.
const gappy = fixture({ 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs' } }) });
const c = adopt(['--plan-issue'], gappy, { FAKE_GH_FAIL: 'issue-create' });
const cOut = parse(c.stdout);
check(
  "a failed gh issue create exits 1 with a named { error } and gh's own message in { detail }",
  c.status === 1 && typeof cOut?.error === 'string' && /^plan-issue:/.test(cOut.error) && /could not create the issue/.test(cOut?.detail ?? ''),
  `${c.stdout}\n${c.stderr}`,
);
check('a failed gh issue create never leaks gh wording into the name', cOut !== null && !/could not create/.test(cOut?.error ?? ''), c.stdout);
check('a failed gh issue create tried exactly once, never twice', ran(c.log, 'issue create') === 1, c.log);

// --- D: a knob typo stops the harness instead of behaving like the default ---
// `FAKE_GH_FAIH` is not the knob; `FAKE_GH_FAIL=issue-creat` is the knob with
// a typed value. Without validation the fake would answer normally and the
// case that asked for a failure would pass while proving nothing.
const dState = newStateDir();
const d = adopt(['--inventory'], whole, { ...WHOLE_ENV, FAKE_GH_FAIL: 'issue-creat' }, dState);
const knobErrorPath = join(dState, 'knob-error');
check('an unrecognised knob value stops the run instead of running the default', d.status !== 0, `${d.status}: ${d.stdout}\n${d.stderr}`);
check(
  'an unrecognised knob value is reported by name, not swallowed',
  existsSync(knobErrorPath) && /FAKE_GH_FAIL=issue-creat/.test(readFileSync(knobErrorPath, 'utf8')),
  existsSync(knobErrorPath) ? readFileSync(knobErrorPath, 'utf8') : 'no knob-error file written',
);
check(
  'a knob typo never produces a report: adopt fails closed on the read it could not make',
  parse(d.stdout)?.gaps === undefined,
  d.stdout,
);

// A knob the harness does know still runs every case above it.
const dOk = adopt(['--inventory'], whole, { ...WHOLE_ENV, FAKE_GH_FAIL: '' });
check('the empty value of a knob is a value the harness knows, not a typo', dOk.status === 0, `${dOk.stdout}\n${dOk.stderr}`);

// --- E: the git shim survives a path with a space in it ----------------------
const e = adopt(['--inventory'], whole, { ...WHOLE_ENV, PATH: PATH_WITH_SPACED_GIT });
const eOut = parse(e.stdout);
check(
  'a git shim whose target path contains a space still resolves the repository',
  e.status === 0 && eOut?.defaultBranch === 'main',
  `${e.stdout}\n${e.stderr}`,
);
check('the spaced git path is quoted in the shim it is interpolated into', readFileSync(FAKE_GIT_PATH, 'utf8').includes(`exec "${SPACED_GIT}" "$@"`), readFileSync(FAKE_GIT_PATH, 'utf8'));

// --- F: shellcheck, when this machine has it ---------------------------------
// The acceptance criterion asks for shellcheck over the touched file's shell
// text when it is available. It is not a dependency of this repository, so an
// absent shellcheck is a skip and never a failure.
const shellcheck = spawnSync('sh', ['-c', 'command -v shellcheck'], { encoding: 'utf8' });
if ((shellcheck.stdout ?? '').trim() === '') {
  check('shellcheck over the generated fakes skipped (not installed on this machine)', true);
} else {
  for (const [name, path] of [
    ['fake gh', FAKE_GH_PATH],
    ['fake git', FAKE_GIT_PATH],
    ['spaced git shim', SPACED_GIT],
  ] as Array<[string, string]>) {
    const r = spawnSync('shellcheck', ['-f', 'gcc', '-S', 'warning', path], { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    check(`shellcheck reports no unquoted expansion (SC2086) in the ${name}`, !/SC2086/.test(out), out);
    check(`shellcheck reports no warning at all in the ${name}`, out.trim() === '', out);
  }
}

finish();
