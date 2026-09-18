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

/**
 * The page `gh label list` is asked for. A repository with at least this many
 * labels answers with exactly this many and says nothing about the ones it
 * left out, which is the whole point of the case below.
 */
const LABEL_LIST_LIMIT = 200;

/** A full page of labels: what a repository with more than the limit returns. */
const FULL_PAGE_JSON = JSON.stringify(
  Array.from({ length: LABEL_LIST_LIMIT }, (_, i) => ({ name: `topic/${String(i).padStart(3, '0')}` })),
);

/** Every value each knob accepts; anything else is a typo and is refused. */
const KNOBS = {
  FAKE_GH_FAIL: ['', 'repo', 'issue-list', 'issue-create'],
  FAKE_GH_RULES: ['', 'full'],
  FAKE_GH_LABELS: ['', 'all', 'full-page'],
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
      # A page kept beside this script rather than inlined: 200 entries of
      # JSON in a case arm is unreadable, and the file is what a repository
      # with more labels than the limit would hand back.
      full-page) cat "$(dirname "$0")/labels-full-page.json" ;;
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
writeFileSync(join(fakeGhDir, 'labels-full-page.json'), `${FULL_PAGE_JSON}\n`);
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

/**
 * The plan issue's prose, without the raw JSON it ends with. The report is
 * dumped verbatim under `## Inventory`, so a field *name* like
 * `labelsTruncated` appears there whatever its value — asserting on the whole
 * body would let the dump stand in for the sentence a person actually reads.
 */
const prose = (body: string): string => body.split('## Inventory')[0] ?? '';

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

/** A repository with gaps left, so `--plan-issue` has a question to ask. */
const gappy = fixture({ 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs' } }) });

// --- C: a label list that came back full is reported as possibly truncated --
// `gh label list` is asked for one page. A repository whose answer fills that
// page may have more labels the read never saw, and `labels:missing` is then
// a guess — so the report says so rather than letting the reader assume the
// list is the whole vocabulary.
check('a label list well under the limit is not reported as truncated', aOut?.labelsTruncated === false, a.stdout);
check(
  'the report always carries labelsTruncated, so a reader never has to infer it',
  aOut !== null && Object.prototype.hasOwnProperty.call(aOut, 'labelsTruncated'),
  a.stdout,
);

const cTrunc = adopt(['--inventory'], whole, { FAKE_GH_RULES: 'full', FAKE_GH_LABELS: 'full-page' });
const cTruncOut = parse(cTrunc.stdout);
check('a full page of labels still exits 0', cTrunc.status === 0 && cTruncOut !== null, `${cTrunc.stdout}\n${cTrunc.stderr}`);
check(
  'a label list that returned exactly the limit is reported as labelsTruncated: true',
  cTruncOut?.labelsTruncated === true && Array.isArray(cTruncOut?.labels) && cTruncOut.labels.length === LABEL_LIST_LIMIT,
  `${cTruncOut?.labelsTruncated} / ${cTruncOut?.labels?.length}`,
);
check(
  'the label read asks for an explicit limit, never gh’s default page of 30',
  new RegExp(`^label list .*--limit ${LABEL_LIST_LIMIT}\\b`, 'm').test(cTrunc.log),
  cTrunc.log,
);

// The note is only worth having if the person reading the plan issue sees it:
// the checklist there says which labels are missing, and that list is exactly
// what a truncated read cannot be trusted about.
const truncState = newStateDir();
const cPlan = adopt(['--plan-issue'], gappy, { FAKE_GH_LABELS: 'full-page' }, truncState);
const truncArgs = existsSync(join(truncState, 'issue-create.args'))
  ? readFileSync(join(truncState, 'issue-create.args'), 'utf8').split('\0').filter((s) => s.length > 0)
  : [];
const truncBody = truncArgs.indexOf('--body') === -1 ? '' : truncArgs[truncArgs.indexOf('--body') + 1];
check('--plan-issue with a truncated label read still opens the issue', cPlan.status === 0 && truncBody.length > 0, `${cPlan.stdout}\n${cPlan.stderr}`);
check(
  'the plan issue says the label list may be truncated, and names the limit it asked for',
  /truncat/i.test(prose(truncBody)) && new RegExp(`\\b${LABEL_LIST_LIMIT}\\b`).test(prose(truncBody)),
  truncBody.split('\n').filter((l) => /label/i.test(l)).join('\n'),
);

const cPlanWhole = adopt(['--plan-issue'], gappy, { FAKE_GH_LABELS: 'all' }, newStateDir());
const wholeArgs = existsSync(join(cPlanWhole.stateDir, 'issue-create.args'))
  ? readFileSync(join(cPlanWhole.stateDir, 'issue-create.args'), 'utf8').split('\0').filter((s) => s.length > 0)
  : [];
const wholeBody = wholeArgs.indexOf('--body') === -1 ? '' : wholeArgs[wholeArgs.indexOf('--body') + 1];
check(
  'a label read that was not truncated says nothing about truncation',
  wholeBody.length > 0 && !/truncat/i.test(prose(wholeBody)),
  wholeBody.split('\n').filter((l) => /label/i.test(l)).join('\n'),
);

// --- D: a gh issue create that fails is named, with gh's own message ---------
// The refusal shape the rest of the script uses: a stable name a caller
// branches on, and the tool's wording kept out of it and in `detail`.
const c = adopt(['--plan-issue'], gappy, { FAKE_GH_FAIL: 'issue-create' });
const cOut = parse(c.stdout);
check(
  "a failed gh issue create exits 1 with a named { error } and gh's own message in { detail }",
  c.status === 1 && typeof cOut?.error === 'string' && /^plan-issue:/.test(cOut.error) && /could not create the issue/.test(cOut?.detail ?? ''),
  `${c.stdout}\n${c.stderr}`,
);
check('a failed gh issue create never leaks gh wording into the name', cOut !== null && !/could not create/.test(cOut?.error ?? ''), c.stdout);
check('a failed gh issue create tried exactly once, never twice', ran(c.log, 'issue create') === 1, c.log);

// --- E: a knob typo stops the harness instead of behaving like the default ---
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

// --- F: the git shim survives a path with a space in it ----------------------
const e = adopt(['--inventory'], whole, { ...WHOLE_ENV, PATH: PATH_WITH_SPACED_GIT });
const eOut = parse(e.stdout);
check(
  'a git shim whose target path contains a space still resolves the repository',
  e.status === 0 && eOut?.defaultBranch === 'main',
  `${e.stdout}\n${e.stderr}`,
);
check('the spaced git path is quoted in the shim it is interpolated into', readFileSync(FAKE_GIT_PATH, 'utf8').includes(`exec "${SPACED_GIT}" "$@"`), readFileSync(FAKE_GIT_PATH, 'utf8'));

// --- G: shellcheck, when this machine has it ---------------------------------
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

/** The adoption branch and the label the plan issue carries once decided. */
const BRANCH = 'chore/adopt-agentic-setup';
const DECIDED_LABEL = 'human:decided';

// --- H: one definition of the constants three files used to restate (#302) ---
// The hook marker and the superseded deny rules lived in three places at once,
// each comment pointing at the other two and asking that they move together.
// A comment is not a mechanism; one definition is.
const SHARED = ['scripts/init.mts', 'scripts/lib/adopt/hooks.mts', 'scripts/lib/adopt/inventory.mts', 'scripts/lib/adopt/constants.mts'];
const sourceOf = (rel: string): string => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    return '';
  }
};
check('the shared adoption constants have a module of their own', sourceOf('scripts/lib/adopt/constants.mts').length > 0, 'scripts/lib/adopt/constants.mts');
const denyDefiners = SHARED.filter((rel) => /SUPERSEDED_DENY_RULES: Record<string, string> =/.test(sourceOf(rel)));
check(
  'the superseded deny rules are defined exactly once, in that module',
  denyDefiners.length === 1 && denyDefiners[0] === 'scripts/lib/adopt/constants.mts',
  denyDefiners.join(', ') || '(defined nowhere)',
);
const markerDefiners = SHARED.filter((rel) => /^(export )?const [A-Z_]*MARKER = 'agentic-setup';$/m.test(sourceOf(rel)));
check(
  'the hook marker is defined exactly once, in that module',
  markerDefiners.length === 1 && markerDefiners[0] === 'scripts/lib/adopt/constants.mts',
  markerDefiners.join(', ') || '(defined nowhere)',
);
check(
  'scripts/init.mts tests for the marker it shares rather than an inline literal of its own',
  !/\/agentic-setup\/\.test\(/.test(sourceOf('scripts/init.mts')),
  'inline marker regex',
);

// --- H2: the --pr block is a module of its own, and git names its buffer -----
// `scripts/adopt.mts` held the whole of `--pr` and stood at 793 of its 800
// lines, so the next mode had nowhere to go (#302).
check(
  'the --pr command is lifted out of the CLI into a module of its own',
  sourceOf('scripts/lib/adopt/pr-run.mts').length > 0,
  'scripts/lib/adopt/pr-run.mts',
);

// Every `git` the adoption steps spawn goes through one runner with one
// explicit `maxBuffer`. The default is 1 MB, which the `ls-tree` of a large
// repository outgrows — and the base then *refused*, which is what the issue
// said and what a measurement over a 30,000-path repository confirms: every
// buffer size that truncated answered `status: null` with `SIGTERM`, so
// `status ?? 1` was 1. What it did not do is say why, because `stderr` on that
// path is empty. Both branches are exercised below, because `spawnSync`
// reports the same `ENOBUFS` for each and this runner refuses both: a kill
// with the tail missing, and a complete answer whose limit was noticed after
// it had all arrived. A module of the adoption libraries, imported and called
// directly, as `resolvePlanIssue` already is.
type GitModule = {
  GIT_MAX_BUFFER: number;
  runGit: (cwd: string, args: string[], options?: { maxBuffer?: number }) => { status: number; stdout: string; stderr: string };
};
let gitMod: GitModule | null = null;
try {
  gitMod = (await import('../scripts/lib/adopt/git.mts')) as unknown as GitModule;
} catch {
  gitMod = null;
}
check('the adoption git runner names one explicit maxBuffer', gitMod?.GIT_MAX_BUFFER === 64 * 1024 * 1024, String(gitMod?.GIT_MAX_BUFFER));

// `ls-tree` of this repository fits in one read, so the limit is noticed with
// the whole answer already in hand: status 0 beside an `ENOBUFS`. That is the
// branch the old `status ?? 1` would have accepted.
const wholeAnswer = gitMod?.runGit(ROOT, ['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { maxBuffer: 8 });
// `log -p` is large enough to need several, so this one is killed mid-answer:
// `status: null`, `SIGTERM`. The base refused here too — with an empty detail.
const killed = gitMod?.runGit(ROOT, ['log', '-p', '--no-color'], { maxBuffer: 1024 });
type GitAnswer = { status: number; stdout: string; stderr: string } | undefined;
for (const [shape, answer] of [['whole', wholeAnswer], ['killed mid-answer', killed]] as Array<[string, GitAnswer]>) {
  check(
    `a git answer that outgrows the buffer (${shape}) reports a named reason and never an empty detail`,
    answer !== undefined && answer.status !== 0 && /ENOBUFS/.test(answer.stderr),
    JSON.stringify(answer?.stderr),
  );
  check(`and hands back no output at all for the ${shape} one`, answer?.stdout === '', String(answer?.stdout.length));
}

// --- I: `record:stale` is one of the gap names, not a name beside them -------
const gapNames = sourceOf('scripts/lib/adopt/inventory.mts').match(/const GAP_NAMES = \[([\s\S]*?)\] as const;/)?.[1] ?? '';
check('the inventory names the gaps at all (the source was read)', gapNames.includes('ruleset:absent'), gapNames || '(no GAP_NAMES)');
check("the inventory's gap names include record:stale", gapNames.includes("'record:stale'"), gapNames);

// --- J: what the two adoption documents are held to (moved here in #302) ---
// The `--pr` section lives in `docs/adopt-pr.md` since #302: `docs/adopt.md`
// stood at the 800-line cap and had no room for what these cases ask it to
// say. The two are read together here, so a claim that moves between them
// neither passes nor fails by accident; a case naming one file by hand is a
// case about *that* file.
const adoptDoc = readFileSync(join(ROOT, 'docs', 'adopt.md'), 'utf8');
const prDoc = readFileSync(join(ROOT, 'docs', 'adopt-pr.md'), 'utf8');
const docs = `${adoptDoc}\n${prDoc}`;
check('the two documents point at each other', adoptDoc.includes('docs/adopt-pr.md') && prDoc.includes('docs/adopt.md'), 'no pointer');
check(
  'and each sits below the 800-line cap the split exists for',
  [adoptDoc, prDoc].every((text) => text.split('\n').length <= 800),
  [adoptDoc, prDoc].map((text) => text.split('\n').length).join(' | '),
);
check('the documentation documents the --pr flag', /node scripts\/adopt\.mts --pr\b/.test(docs));
check('the documentation documents the full sequence', ['--inventory', '--plan-issue', DECIDED_LABEL, '--pr'].every((step) => docs.includes(step)), 'sequence');
check('the documentation says what the deliberate red test is for', /deliberate red/i.test(docs) && docs.includes('negative-control'), 'deliberate red');
check('the documentation says adopt never merges, and names scripts/land.mts', /never merges/i.test(docs) && docs.includes('scripts/land.mts'), 'never merges');
check('the documentation names the adoption branch and the refusal the plan issue can cause', docs.includes(BRANCH) && docs.includes('plan:not-decided'), 'branch and refusal');
check(
  'the documentation says which of the generated checks cannot run on the adoption pull request',
  prDoc.includes('expected red') && prDoc.includes('.github/scripts/agentic/'),
  'docs expected red',
);
check(
  'the documentation says which plan issue authorises when two share the title, and names the ambiguous refusal',
  docs.includes('pr:plan-ambiguous') && /open/.test(prDoc.split('### Which plan issue authorises')[1] ?? ''),
  'ambiguity',
);

finish();
