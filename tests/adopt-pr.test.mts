#!/usr/bin/env node
// Cases for the adoption pull request (#167): `scripts/lib/adopt/pr.mts`
// assembles the branch `chore/adopt-agentic-setup` out of the record, the
// generated workflows, the deny list and one deliberate red test, and
// `scripts/adopt.mts --pr` is the only thing that pushes it and opens the
// pull request.
//
// The same split as `tests/adopt-hooks.test.mts` and
// `tests/adopt-workflows.test.mts`:
//  - the **writes** — the branch, the push, the pull request — are proved by
//    spawning the real script (CLAUDE.md invariant 6) against throwaway git
//    repositories whose `origin` is a throwaway bare repository, with a small
//    fake `gh` first on PATH for every GitHub read and for `pr create`. No
//    case here ever reaches a real repository;
//  - the **plan** is a value the module returns *without writing*, which no
//    amount of spawning can observe, so that one module is imported.
//
// The fourth acceptance criterion is the reason this file is long: the
// deliberate red is not asserted, it is *run*. The real `ci/negative-control.mts`
// is executed over the generated branch against its base in the disposable
// repository, and the outcome it prints must be `pass` — the baseline green on
// the base, the overlaid run red.
//
// The branch name, the slug, the refusal names and the record's shape are
// written out as literals below. They are the contract the script is held to,
// and importing them from the module that produces them would let both sides
// move together without a case noticing.
//
// Negative control: on the base `scripts/lib/adopt/pr.mts` does not exist, so
// the import below answers `null` and every plan case fails on its own
// assertion; `--pr` is not a flag there either, so every spawn exits 1 on
// usage, no branch is ever pushed, and the negative-control case has no
// generated diff to run over.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, commit, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

/** The one adoption branch, as the acceptance criterion names it. */
const BRANCH = 'chore/adopt-agentic-setup';

/** Its slug — what `node scripts/proof.mts <slug>` is given. */
const SLUG = 'adopt-agentic-setup';

/** The record's name, at the adopted repository's root. */
const RECORD_FILE = 'agentic.config.json';

/** The permission file the deny list is merged into. */
const SETTINGS = '.claude/settings.json';

/** The title the plan issue of #162 is deduplicated by; one per repository. */
const PLAN_ISSUE_TITLE = 'Adoption plan: what this repository is missing';

/** The two labels the plan issue may carry, and the one `--pr` requires. */
const PENDING_LABEL = 'human:pending';
const DECIDED_LABEL = 'human:decided';

/** The plan issue number the fake `gh` answers with. */
const PLAN_ISSUE = 41;

/** The pull request the fake `gh` answers `pr create` with. */
const PR_URL = 'https://github.com/org/repo/pull/99';

/** The files the branch is expected to carry, in the order the plan lists them. */
const GENERATED = [
  RECORD_FILE,
  '.github/workflows/agentic-checks.yml',
  '.github/workflows/guard-main.yml',
  '.github/workflows/issue-lint.yml',
  SETTINGS,
  `proof/${SLUG}.json`,
  `proof/${SLUG}.test.mjs`,
];

// --- the module under test, imported rather than spawned --------------------
type PlannedFile = { path: string; content: string | null; outcome: string; reason: string; commit: string };
type Plan = {
  branch: string;
  slug: string;
  files: PlannedFile[];
  globs: string[];
  checks: string[];
  proof: { slug: string; command: string; declaration: string };
};
type Module = {
  ADOPTION_BRANCH: string;
  ADOPTION_SLUG: string;
  planPullRequest: (record: unknown, options: unknown) => Plan;
  renderBody: (plan: Plan, context: unknown) => string;
};

let mod: Module | null = null;
try {
  mod = (await import('../scripts/lib/adopt/pr.mts')) as unknown as Module;
} catch {
  mod = null;
}

check('scripts/lib/adopt/pr.mts exists and exports planPullRequest', typeof mod?.planPullRequest === 'function');
check('it exports the body renderer the pull request is written from', typeof mod?.renderBody === 'function');
check('it names the one adoption branch and its slug', mod?.ADOPTION_BRANCH === BRANCH && mod?.ADOPTION_SLUG === SLUG, `${mod?.ADOPTION_BRANCH} | ${mod?.ADOPTION_SLUG}`);

// --- a fake `gh` -------------------------------------------------------------
// Every GitHub call of this file goes through it: the three inventory reads,
// the plan-issue lookup (with its labels) and `pr create`, which records its
// own argv rather than reaching any repository.
const FAKE_GH = `#!/usr/bin/env bash
set -u
state="\$FAKE_GH_STATE_DIR"
printf '%s\\n' "\$*" >> "\$state/gh-argv.log"

case "\${1:-} \${2:-}" in
  "api repos/{owner}/{repo}")
    echo '{"default_branch":"main","allow_auto_merge":true,"delete_branch_on_merge":false}'
    ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    echo '[]'
    ;;
  "label list")
    echo '[]'
    ;;
  "issue list")
    case "\${FAKE_GH_PLAN:-none}" in
      pending) echo '[{"number":${PLAN_ISSUE},"title":"${PLAN_ISSUE_TITLE}","state":"OPEN","labels":[{"name":"${PENDING_LABEL}"}]}]' ;;
      decided) echo '[{"number":${PLAN_ISSUE},"title":"${PLAN_ISSUE_TITLE}","state":"OPEN","labels":[{"name":"${DECIDED_LABEL}"}]}]' ;;
      *) echo '[]' ;;
    esac
    ;;
  "issue create")
    : > "\$state/issue-create.args"
    for a in "\$@"; do printf '%s\\0' "\$a" >> "\$state/issue-create.args"; done
    echo "https://github.com/org/repo/issues/${PLAN_ISSUE}"
    ;;
  "label create")
    echo "fake-gh: label created"
    ;;
  "pr create")
    : > "\$state/pr-create.args"
    for a in "\$@"; do printf '%s\\0' "\$a" >> "\$state/pr-create.args"; done
    echo "${PR_URL}"
    ;;
  *)
    echo "fake-gh: unknown command: \$*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-pr-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// This repository dogfoods itself, so the shell running the suite may have the
// detection overrides set for real. Every child below starts without them.
const { AGENTIC_TEST_CMD: _t, AGENTIC_CHECK_CMD: _c, ...BASE_ENV } = process.env;

/** A fresh directory for one run's `gh` argv log and recorded arguments. */
function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-ghstate-pr-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function adopt(args: string[], cwd: string, env: Record<string, string> = {}, stateDir = newStateDir()) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'adopt.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', stateDir };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** The `--body` a recorded `gh` invocation carried, or '' when there was none. */
function bodyOf(stateDir: string, file: string): string {
  const path = join(stateDir, file);
  if (!existsSync(path)) return '';
  const args = readFileSync(path, 'utf8').split('\0').filter((s) => s.length > 0);
  const at = args.indexOf('--body');
  return at === -1 ? '' : (args[at + 1] ?? '');
}

/** One recorded `gh` flag's value, or '' when the flag was not passed. */
function argOf(stateDir: string, file: string, flag: string): string {
  const path = join(stateDir, file);
  if (!existsSync(path)) return '';
  const args = readFileSync(path, 'utf8').split('\0').filter((s) => s.length > 0);
  const at = args.indexOf(flag);
  return at === -1 ? '' : (args[at + 1] ?? '');
}

// --- the disposable repository, and its disposable `origin` -----------------
/** A green test on the base: the baseline the negative control needs. */
const GREEN_TEST = "import { test } from 'node:test';\ntest('the base passes its own tests', () => {});\n";

/** A throwaway repository with a bare `origin`, one commit on `main`, pushed. */
function fixture(extra: Record<string, string> = {}): { repo: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), 'agentic-origin-pr-'));
  cleanup(() => rmSync(origin, { recursive: true, force: true }));
  git(['init', '-q', '--bare', '-b', 'main'], origin);

  const repo = tempRepo();
  commit(
    repo,
    {
      'package.json': `${JSON.stringify({ name: 'fx', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
      'tests/ok.test.mjs': GREEN_TEST,
      ...extra,
    },
    'initial',
  );
  git(['remote', 'add', 'origin', origin], repo);
  git(['push', '-q', '-u', 'origin', 'main'], repo);
  return { repo, origin };
}

/** The sha a ref points at in the bare origin, or '' when there is no such ref. */
function remoteSha(origin: string, ref: string): string {
  const r = spawnSync('git', ['rev-parse', '--verify', ref], { cwd: origin, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

/** The paths a commit range touches, sorted. */
const pathsIn = (repo: string, range: string): string[] =>
  git(['diff', '--no-renames', '--name-only', range], repo).split('\n').map((l) => l.trim()).filter(Boolean).sort();

/** A file's text at a commit, or '' when the commit does not carry it. */
function showAt(repo: string, sha: string, path: string): string {
  const r = spawnSync('git', ['show', `${sha}:${path}`], { cwd: repo, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout ?? '') : '';
}

// --- A: no plan issue at all is a refusal, and pushes nothing ---------------
const none = fixture();
const beforeNone = git(['status', '--porcelain'], none.repo);
const a = adopt(['--pr'], none.repo, { FAKE_GH_PLAN: 'none' });
const aOut = parse(a.stdout);
check('--pr without a plan issue exits 1 with JSON on stdout', a.status === 1 && aOut !== null, `${a.stdout}\n${a.stderr}`);
check(
  '--pr without a plan issue refuses, naming what is missing',
  typeof aOut?.refused === 'string' && aOut.refused.length > 0 && Array.isArray(aOut?.missing) && aOut.missing.includes('plan:not-found'),
  a.stdout,
);
check('--pr without a plan issue pushes no branch', remoteSha(none.origin, `refs/heads/${BRANCH}`) === '', BRANCH);
check('--pr without a plan issue writes nothing', git(['status', '--porcelain'], none.repo) === beforeNone, git(['status', '--porcelain'], none.repo));

// --- B: a plan issue still `human:pending` is the refusal the AC names ------
const pending = fixture();
const b = adopt(['--pr'], pending.repo, { FAKE_GH_PLAN: 'pending' });
const bOut = parse(b.stdout);
check('--pr over a human:pending plan issue exits 1', b.status === 1 && bOut !== null, `${b.stdout}\n${b.stderr}`);
check(
  '--pr over a human:pending plan issue reports { refused, missing: [plan:not-decided] }',
  typeof bOut?.refused === 'string' && Array.isArray(bOut?.missing) && bOut.missing.length === 1 && bOut.missing[0] === 'plan:not-decided',
  b.stdout,
);
check('the refusal names the plan issue it read', bOut?.issue === PLAN_ISSUE, b.stdout);
check('--pr over a human:pending plan issue pushes no branch', remoteSha(pending.origin, `refs/heads/${BRANCH}`) === '', BRANCH);
check('--pr over a human:pending plan issue opens no pull request', !existsSync(join(b.stateDir, 'pr-create.args')), b.stateDir);
check(
  '--pr over a human:pending plan issue leaves the working tree byte-identical',
  git(['status', '--porcelain'], pending.repo) === '',
  git(['status', '--porcelain'], pending.repo),
);

// --- C: a `human:decided` plan issue is the success path --------------------
const decided = fixture();
const base = git(['rev-parse', 'HEAD'], decided.repo);
const c = adopt(['--pr'], decided.repo, { FAKE_GH_PLAN: 'decided' });
const cOut = parse(c.stdout);
check('--pr over a human:decided plan issue exits 0', c.status === 0 && cOut !== null, `${c.stdout}\n${c.stderr}`);
check('--pr reports the branch it assembled', cOut?.branch === BRANCH, c.stdout);
check('--pr reports the base it assembled it from', cOut?.base === base, `${cOut?.base} vs ${base}`);
check('--pr reports the pull request the fake gh answered with', cOut?.pr === PR_URL && cOut?.issue === PLAN_ISSUE, c.stdout);

const head = String(cOut?.head ?? '');
check('--pr pushed the adoption branch to origin', head.length === 40 && remoteSha(decided.origin, `refs/heads/${BRANCH}`) === head, `${head} | ${remoteSha(decided.origin, `refs/heads/${BRANCH}`)}`);
check(
  '--pr writes nothing into the working tree: the branch is assembled in the object database',
  git(['status', '--porcelain'], decided.repo) === '',
  git(['status', '--porcelain'], decided.repo),
);
check('--pr leaves the checked-out branch where it found it', git(['rev-parse', 'HEAD'], decided.repo) === base, git(['rev-parse', '--abbrev-ref', 'HEAD'], decided.repo));

const carried = head.length === 40 ? pathsIn(decided.repo, `${base}...${head}`) : [];
check('the branch carries exactly the generated files', carried.join(',') === [...GENERATED].sort().join(','), carried.join(','));
check(
  'the branch carries the adoption record, generated by this tool',
  (() => {
    try {
      return JSON.parse(showAt(decided.repo, head, RECORD_FILE))?.generatedBy === 'agentic-setup/adopt';
    } catch {
      return false;
    }
  })(),
  showAt(decided.repo, head, RECORD_FILE).slice(0, 200),
);
check(
  'the branch carries the generated workflows, marker and all',
  showAt(decided.repo, head, '.github/workflows/agentic-checks.yml').includes('generated by agentic-setup adopt'),
  showAt(decided.repo, head, '.github/workflows/agentic-checks.yml').split('\n').slice(0, 3).join('\n'),
);
check(
  'the branch carries the deny list the hooks step merges',
  (() => {
    try {
      return Array.isArray(JSON.parse(showAt(decided.repo, head, SETTINGS))?.permissions?.deny);
    } catch {
      return false;
    }
  })(),
  showAt(decided.repo, head, SETTINGS).slice(0, 200),
);
check('the branch carries the proof declaration the slug names', showAt(decided.repo, head, `proof/${SLUG}.json`).includes(`proof/${SLUG}.test.mjs`), showAt(decided.repo, head, `proof/${SLUG}.json`));
check('the branch carries the deliberate red test under the record’s proof.dir', showAt(decided.repo, head, `proof/${SLUG}.test.mjs`).length > 0, `proof/${SLUG}.test.mjs`);

// The red is committed first and on its own, so `negative-control` has the
// `test(red):` commit it reads when a red looks structural.
const subjects = head.length === 40 ? git(['log', '--format=%s', `${base}..${head}`], decided.repo).split('\n').filter(Boolean).reverse() : [];
check('the branch carries two commits, the red one first', subjects.length === 2 && /^test\(red\):/.test(subjects[0] ?? ''), subjects.join(' | '));
check('the second commit is a conventional adoption commit', /^chore\(adopt\):/.test(subjects[1] ?? ''), subjects.join(' | '));
check(
  'the test(red): commit touches only the proof files',
  subjects.length === 2 &&
    git(['diff', '--no-renames', '--name-only', `${base}..${head}~1`], decided.repo).split('\n').filter(Boolean).sort().join(',') ===
      [`proof/${SLUG}.json`, `proof/${SLUG}.test.mjs`].sort().join(','),
  head.length === 40 ? git(['diff', '--no-renames', '--name-only', `${base}..${head}~1`], decided.repo) : '',
);

// --- D: the pull request body ------------------------------------------------
const prBody = bodyOf(c.stateDir, 'pr-create.args');
check('--pr opened one pull request with a body', prBody.length > 0, `${c.stdout}\n${c.stderr}`);
check('the pull request is opened against the adoption branch', argOf(c.stateDir, 'pr-create.args', '--head') === BRANCH && argOf(c.stateDir, 'pr-create.args', '--base') === 'main', `${argOf(c.stateDir, 'pr-create.args', '--head')} | ${argOf(c.stateDir, 'pr-create.args', '--base')}`);
check(
  'the body closes the plan issue, in plain text and not inside backticks',
  new RegExp(`^Closes #${PLAN_ISSUE}$`, 'm').test(prBody),
  prBody.split('\n').slice(0, 3).join('\n'),
);

/** The bullets of one `## <heading>` section of a body, backticks stripped. */
function bullets(body: string, heading: string): string[] {
  const lines = body.split('\n');
  const at = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (at === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (/^##\s+\S/.test(line.trim())) break;
    const bullet = line.trim().match(/^[-*]\s+(.*)$/);
    if (bullet) out.push(bullet[1].replace(/`/g, '').trim());
  }
  return out;
}

check(
  'the body’s ## Files section lists exactly the files generated',
  bullets(prBody, 'Files').sort().join(',') === [...GENERATED].sort().join(','),
  bullets(prBody, 'Files').join(','),
);
check('the body carries a ## Proof section', /^## Proof$/m.test(prBody), prBody);
check(
  'the ## Proof section names the command scripts/proof.mts will run',
  /^## Proof$/m.test(prBody) &&
    prBody.split('## Proof')[1].includes(`scripts/proof.mts ${SLUG}`) &&
    prBody.split('## Proof')[1].includes(String(cOut?.proof?.command ?? ' ')),
  `${cOut?.proof?.command} | ${prBody.split('## Proof')[1]?.slice(0, 400)}`,
);
check('the reported proof command is the one the record holds', cOut?.proof?.command === 'npm test' && cOut?.proof?.slug === SLUG, JSON.stringify(cOut?.proof));
check('the body says adoption never merges: scripts/land.mts does', /land\.mts/.test(prBody), prBody);

// --- E: the body passes ci/scope-check.mts, as any other pull request does --
// The globs come from the **plan issue**, as `ci/scope-check.mts` reads them
// on a real pull request, and the plan issue is the one `--plan-issue` opens —
// so the body used here is the one that script actually renders.
const planned = fixture();
const planRun = adopt(['--plan-issue'], planned.repo, { FAKE_GH_PLAN: 'none' });
const planBody = bodyOf(planRun.stateDir, 'issue-create.args');
check('--plan-issue still opens its issue', planRun.status === 0 && planBody.length > 0, `${planRun.stdout}\n${planRun.stderr}`);
check(
  'the plan issue declares the globs adoption writes under ## Files',
  bullets(planBody, 'Files').length > 0 && bullets(planBody, 'Files').includes(RECORD_FILE),
  bullets(planBody, 'Files').join(','),
);

const scopeDir = mkdtempSync(join(tmpdir(), 'agentic-scope-pr-'));
cleanup(() => rmSync(scopeDir, { recursive: true, force: true }));
writeFileSync(join(scopeDir, 'files.txt'), `${carried.join('\n')}\n`);
writeFileSync(join(scopeDir, 'issue.md'), planBody);
writeFileSync(join(scopeDir, 'pr.md'), prBody);
const scope = ci(
  'scope-check.mts',
  [
    '--files-file', join(scopeDir, 'files.txt'),
    '--issue-body-file', join(scopeDir, 'issue.md'),
    '--issue', String(PLAN_ISSUE),
    '--pr-body-file', join(scopeDir, 'pr.md'),
  ],
  { cwd: decided.repo },
);
check('the generated body and file list pass ci/scope-check.mts', scope.status === 0, scope.out);

// --- F: the deliberate red is run, not asserted -----------------------------
// The real `ci/negative-control.mts`, over the generated branch against its
// base, in the disposable repository: the baseline green on the base, the
// overlaid run red. Anything but `pass` means the adoption pull request does
// not prove itself.
const control = head.length === 40
  ? ci('negative-control.mts', ['--base', base, '--head', head, '--branch', BRANCH], {
      cwd: decided.repo,
      env: { AGENTIC_TEST_CMD: '', AGENTIC_CHECK_CMD: '', AGENTIC_SKIP_GLOBS: '', AGENTIC_TEST_GLOBS: '' },
    })
  : { status: 1, out: 'no branch was generated' };
check('ci/negative-control.mts over the generated branch reports pass', control.status === 0 && /negative-control: pass\b/.test(control.out), control.out);

// --- G: a branch that already exists is held, never forced ------------------
const secondHead = head;
const g = adopt(['--pr'], decided.repo, { FAKE_GH_PLAN: 'decided' });
const gOut = parse(g.stdout);
check('a second --pr over an existing branch reports { held }', gOut?.held === BRANCH, `${g.stdout}\n${g.stderr}`);
check('a second --pr exits non-zero', g.status !== 0, String(g.status));
check('a second --pr leaves the remote branch exactly where it was', remoteSha(decided.origin, `refs/heads/${BRANCH}`) === secondHead, remoteSha(decided.origin, `refs/heads/${BRANCH}`));
check('a second --pr opens no second pull request', !existsSync(join(g.stateDir, 'pr-create.args')), g.stateDir);

// --- H: usage ----------------------------------------------------------------
const both = adopt(['--pr', '--hooks'], decided.repo, { FAKE_GH_PLAN: 'decided' });
check('--pr with a second mode flag is a usage error', both.status === 1 && /usage/.test(parse(both.stdout)?.error ?? ''), `${both.stdout}\n${both.stderr}`);
check('the usage line names --pr', /--pr\b/.test(parse(both.stdout)?.error ?? ''), `${both.stdout}\n${both.stderr}`);
const forced = adopt(['--pr', '--force'], decided.repo, { FAKE_GH_PLAN: 'decided' });
check(
  '--force is not a modifier of --pr: there is no way to force the branch',
  forced.status === 1 && /usage/.test(parse(forced.stdout)?.error ?? ''),
  `${forced.stdout}\n${forced.stderr}`,
);

// --- I: the plan, as a value, writes nothing --------------------------------
const planning = fixture();
const beforePlanning = git(['status', '--porcelain'], planning.repo);
const recordValue = {
  version: 1,
  stack: 'node',
  commands: { test: 'npm test', check: 'tsc' },
  checks: [],
  hooks: ['pre-push'],
  proof: { dir: 'proof' },
  labels: { source: 'scripts/init.mts' },
  generatedAt: '2026-01-01T00:00:00.000Z',
  generatedBy: 'agentic-setup/adopt',
};

/** Calls the planner, answering `null` when the module or the call is not there. */
function plan(record: unknown, root: string): Plan | null {
  if (!mod) return null;
  try {
    return mod.planPullRequest(record, { root, baseFile: () => null });
  } catch {
    return null;
  }
}

const p = plan(recordValue, planning.repo);
check('planPullRequest returns the branch, its slug and its files', p?.branch === BRANCH && p?.slug === SLUG && Array.isArray(p?.files), JSON.stringify(p?.files?.map((f) => f.path)));
check(
  'every planned file carries a path, an outcome, a reason and the commit it belongs to',
  (p?.files ?? []).length > 0 &&
    (p?.files ?? []).every((f) => typeof f.path === 'string' && typeof f.outcome === 'string' && typeof f.reason === 'string' && ['red', 'adopt'].includes(f.commit)),
  JSON.stringify(p?.files),
);
check('the plan names the globs the pull request declares', Array.isArray(p?.globs) && (p?.globs ?? []).includes(RECORD_FILE), (p?.globs ?? []).join(','));
check('the plan names the checks the generated workflow produces', Array.isArray(p?.checks) && (p?.checks ?? []).includes('test'), (p?.checks ?? []).join(','));
check('planPullRequest writes nothing of its own', git(['status', '--porcelain'], planning.repo) === beforePlanning, git(['status', '--porcelain'], planning.repo));

/** The reason a refused plan carries, and the field it rejected. */
function planFailure(record: unknown, root: string): { reason: string; field: string } {
  if (!mod) return { reason: '', field: '' };
  try {
    mod.planPullRequest(record, { root, baseFile: () => null });
    return { reason: '', field: '' };
  } catch (err) {
    return { reason: String((err as { reason?: unknown })?.reason ?? ''), field: String((err as { field?: unknown })?.field ?? '') };
  }
}

const noCommand = planFailure({ ...recordValue, commands: { test: null, check: null } }, planning.repo);
check('a record with no test command is refused by name', noCommand.reason === 'pr:no-test-command', `${noCommand.reason} ${noCommand.field}`);
const otherStack = planFailure({ ...recordValue, stack: 'python' }, planning.repo);
check('a stack whose runner would never see the generated test is refused by name', otherStack.reason === 'pr:stack-not-supported', `${otherStack.reason} ${otherStack.field}`);

const strange = fixture({ [RECORD_FILE]: '{"version":1}\n' });
const s = adopt(['--pr'], strange.repo, { FAKE_GH_PLAN: 'decided' });
check('--pr over a record that is not the shape exits 1 by name', s.status === 1 && /^record:/.test(parse(s.stdout)?.error ?? ''), `${s.stdout}\n${s.stderr}`);
check('--pr over a record that is not the shape pushes nothing', remoteSha(strange.origin, `refs/heads/${BRANCH}`) === '', BRANCH);

// --- J: the documentation the acceptance criterion asks for -----------------
const docs = readFileSync(join(ROOT, 'docs', 'adopt.md'), 'utf8');
check('docs/adopt.md documents the --pr flag', /node scripts\/adopt\.mts --pr\b/.test(docs));
check('docs/adopt.md documents the full sequence', ['--inventory', '--plan-issue', DECIDED_LABEL, '--pr'].every((step) => docs.includes(step)), 'sequence');
check('docs/adopt.md says what the deliberate red test is for', /deliberate red/i.test(docs) && docs.includes('negative-control'), 'deliberate red');
check('docs/adopt.md says adopt never merges, and names scripts/land.mts', /never merges/i.test(docs) && docs.includes('scripts/land.mts'), 'never merges');
check('docs/adopt.md names the adoption branch and the refusal the plan issue can cause', docs.includes(BRANCH) && docs.includes('plan:not-decided'), 'branch and refusal');

finish();
