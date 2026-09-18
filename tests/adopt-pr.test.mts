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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** The plan issue number the fake `gh` answers with, open unless a knob says otherwise. */
const PLAN_ISSUE = 41;

/**
 * A second issue of the same title. Two can exist because `--plan-issue`
 * deduplicates against **open** issues only: close one, run the documented
 * sequence again, and the repository holds a closed plan issue and an open
 * one. The gate on the only mode that writes to a remote must not resolve
 * that by whichever the search happens to return first.
 */
const OPEN_PLAN_ISSUE = 42;

/** A third, so "two open matches" — which no preference resolves — has a case. */
const SECOND_OPEN_ISSUE = 43;

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
type PlanDecision =
  | { ok: true; issue: number }
  | { ok: false; reason: string; missing: string[]; message: string; issue: number | null; issues: number[] | null };
type Module = {
  ADOPTION_BRANCH: string;
  ADOPTION_SLUG: string;
  planPullRequest: (record: unknown, options: unknown) => Plan;
  renderBody: (plan: Plan, context: unknown) => string;
  resolvePlanIssue: (plans: unknown[], title: string, decidedLabel: string) => PlanDecision;
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
// the plan-issue lookup (with its labels *and its state*) and `pr create`,
// which records its own argv rather than reaching any repository.
//
// The `issue list` arm **honours `--state`**, and several knobs answer with
// more than one issue of the plan title. Both matter: a fake that ignored
// `--state` and never returned two issues could not tell a correct gate from
// one that resolves by whichever match the search returned first, which is
// exactly the defect these cases exist to catch.

/** One issue of the plan title, as `gh issue list --json …` renders it. */
const issueJson = (n: number, label: string, state: 'OPEN' | 'CLOSED'): string =>
  `{"number":${n},"title":"${PLAN_ISSUE_TITLE}","state":"${state}","labels":[{"name":"${label}"}]}`;

const OPEN_PENDING = issueJson(PLAN_ISSUE, PENDING_LABEL, 'OPEN');
const OPEN_DECIDED = issueJson(PLAN_ISSUE, DECIDED_LABEL, 'OPEN');
const CLOSED_DECIDED = issueJson(PLAN_ISSUE, DECIDED_LABEL, 'CLOSED');
const CLOSED_PENDING = issueJson(PLAN_ISSUE, PENDING_LABEL, 'CLOSED');
const OTHER_OPEN_PENDING = issueJson(OPEN_PLAN_ISSUE, PENDING_LABEL, 'OPEN');
const OTHER_OPEN_DECIDED = issueJson(OPEN_PLAN_ISSUE, DECIDED_LABEL, 'OPEN');
const THIRD_OPEN_DECIDED = issueJson(SECOND_OPEN_ISSUE, DECIDED_LABEL, 'OPEN');

/**
 * What each knob answers, per requested state. The closed issue is listed
 * **first** in every `all` answer on purpose: a gate that takes the first
 * title match picks it, which is the coin flip these cases pin down.
 */
const PLAN_ANSWERS: Record<string, { all: string; open: string }> = {
  none: { all: '[]', open: '[]' },
  pending: { all: `[${OPEN_PENDING}]`, open: `[${OPEN_PENDING}]` },
  decided: { all: `[${OPEN_DECIDED}]`, open: `[${OPEN_DECIDED}]` },
  // A decision that was made and then closed, beside the live question.
  'closed-decided-open-pending': { all: `[${CLOSED_DECIDED},${OTHER_OPEN_PENDING}]`, open: `[${OTHER_OPEN_PENDING}]` },
  // The mirror: the stale one is undecided and the live one is decided.
  'closed-pending-open-decided': { all: `[${CLOSED_PENDING},${OTHER_OPEN_DECIDED}]`, open: `[${OTHER_OPEN_DECIDED}]` },
  // Two open matches: no preference resolves this one.
  'two-open': { all: `[${OTHER_OPEN_DECIDED},${THIRD_OPEN_DECIDED}]`, open: `[${OTHER_OPEN_DECIDED},${THIRD_OPEN_DECIDED}]` },
  // History and nothing else: a closed decision is not a live authorisation.
  'closed-decided-only': { all: `[${CLOSED_DECIDED}]`, open: '[]' },
};

/** `knob:state) echo '<json>' ;;` arms, so an unknown pair stops the fake. */
const PLAN_ARMS = Object.entries(PLAN_ANSWERS)
  .map(([knob, answer]) => `      ${knob}:all) echo '${answer.all}' ;;\n      ${knob}:open) echo '${answer.open}' ;;`)
  .join('\n');

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
    # --state is honoured, not ignored: the caller says which states it wants
    # and gets those. An unknown knob/state pair stops the fake with a named
    # error rather than falling through to an empty list, which would read as
    # "this repository has no plan issue" and quietly pass a case.
    want_state=all
    prev=""
    for a in "\$@"; do
      if [ "\$prev" = "--state" ]; then want_state="\$a"; fi
      prev="\$a"
    done
    case "\${FAKE_GH_PLAN:-none}:\$want_state" in
${PLAN_ARMS}
      *)
        echo "fake-gh: no answer for FAKE_GH_PLAN=\${FAKE_GH_PLAN:-none} --state \$want_state" >&2
        exit 64
        ;;
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

// --- B2: two issues share the title, and the gate must not flip a coin ------
// `--plan-issue` deduplicates against **open** issues only, so closing a plan
// issue and running the documented sequence again leaves a closed one beside
// an open one. Whichever the search returns first must not be what authorises
// a push to a remote repository. The open issue is the live question; a closed
// one is history.
//
// The fake lists the closed issue first in every `all` answer, so a gate that
// takes the first title match reads the closed `human:decided` one, pushes the
// branch and writes `Closes #<a closed issue>` into the body.
const stale = fixture();
const staleRun = adopt(['--pr'], stale.repo, { FAKE_GH_PLAN: 'closed-decided-open-pending' });
const staleOut = parse(staleRun.stdout);
check('a closed decided issue beside an open pending one exits 1', staleRun.status === 1 && staleOut !== null, `${staleRun.stdout}\n${staleRun.stderr}`);
check(
  'the open, undecided plan issue is what the gate reads — not the closed decided one',
  staleOut?.reason === 'pr:plan-not-decided' && Array.isArray(staleOut?.missing) && staleOut.missing.includes('plan:not-decided'),
  staleRun.stdout,
);
check('the refusal names the open issue, never the closed one', staleOut?.issue === OPEN_PLAN_ISSUE, `${staleOut?.issue} (closed one is #${PLAN_ISSUE})`);
check('a closed decision authorises no push', remoteSha(stale.origin, `refs/heads/${BRANCH}`) === '', BRANCH);
check('a closed decision opens no pull request', !existsSync(join(staleRun.stateDir, 'pr-create.args')), staleRun.stateDir);

// The search has to ask for the state to be able to prefer by it. A gate that
// requests only `number,title,labels` cannot tell the two apart at all.
const staleLog = (() => {
  try {
    return readFileSync(join(staleRun.stateDir, 'gh-argv.log'), 'utf8');
  } catch {
    return '';
  }
})();
check('the plan search asks GitHub for each issue’s state', /^issue list .*--json [^ ]*\bstate\b/m.test(staleLog), staleLog);

// --- B3: the mirror — the live question is the decided one ------------------
// Pins which one wins: the stale, closed issue is undecided and would refuse;
// the open one carries the decision and is what the run proceeds on.
const live = fixture();
const liveRun = adopt(['--pr'], live.repo, { FAKE_GH_PLAN: 'closed-pending-open-decided' });
const liveOut = parse(liveRun.stdout);
check('a closed pending issue beside an open decided one exits 0', liveRun.status === 0 && liveOut !== null, `${liveRun.stdout}\n${liveRun.stderr}`);
check('the open, decided plan issue is the one adoption proceeds on', liveOut?.issue === OPEN_PLAN_ISSUE, liveRun.stdout);
check('the branch is pushed on the live decision', String(liveOut?.head ?? '').length === 40 && remoteSha(live.origin, `refs/heads/${BRANCH}`) === liveOut.head, String(liveOut?.head));
check(
  'the body closes the open issue, never the closed one',
  new RegExp(`^Closes #${OPEN_PLAN_ISSUE}$`, 'm').test(bodyOf(liveRun.stateDir, 'pr-create.args')),
  bodyOf(liveRun.stateDir, 'pr-create.args').split('\n').slice(0, 3).join('\n'),
);

// --- B4: two open matches are ambiguous, and ambiguity is a named refusal ---
// Preferring the open one resolves the ordinary case; it cannot resolve this
// one. A repository holding two open plan issues is a question nobody can
// answer mechanically, so the run stops by name rather than picking.
const twins = fixture();
const twinsRun = adopt(['--pr'], twins.repo, { FAKE_GH_PLAN: 'two-open' });
const twinsOut = parse(twinsRun.stdout);
check('two open plan issues exit 1', twinsRun.status === 1 && twinsOut !== null, `${twinsRun.stdout}\n${twinsRun.stderr}`);
check(
  'two open plan issues are refused by name, never resolved by order',
  twinsOut?.reason === 'pr:plan-ambiguous' && Array.isArray(twinsOut?.missing) && twinsOut.missing.includes('plan:ambiguous'),
  twinsRun.stdout,
);
check(
  'the ambiguity refusal names every issue it could not choose between',
  Array.isArray(twinsOut?.issues) && [OPEN_PLAN_ISSUE, SECOND_OPEN_ISSUE].every((n) => twinsOut.issues.includes(n)),
  JSON.stringify(twinsOut?.issues),
);
check('an ambiguous plan pushes nothing', remoteSha(twins.origin, `refs/heads/${BRANCH}`) === '', BRANCH);
check('an ambiguous plan opens no pull request', !existsSync(join(twinsRun.stateDir, 'pr-create.args')), twinsRun.stateDir);

// --- B5: a closed decision on its own is history, not an authorisation ------
const history = fixture();
const historyRun = adopt(['--pr'], history.repo, { FAKE_GH_PLAN: 'closed-decided-only' });
const historyOut = parse(historyRun.stdout);
check('a closed decided issue and nothing else exits 1', historyRun.status === 1 && historyOut !== null, `${historyRun.stdout}\n${historyRun.stderr}`);
check(
  'a closed decision alone is reported as no live plan issue',
  Array.isArray(historyOut?.missing) && historyOut.missing.includes('plan:not-found'),
  historyRun.stdout,
);
check('a closed decision alone pushes nothing', remoteSha(history.origin, `refs/heads/${BRANCH}`) === '', BRANCH);

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

// --- I2: the gate itself, as a pure function --------------------------------
// The cases above prove the gate through the real script, which is what
// invariant 6 asks for. These prove the *decision* directly, because it is a
// pure function over what the search returned (`ci/lib/` pure functions may be
// imported and tested directly, and this is the same kind): the orderings a
// spawn cannot conveniently enumerate belong here.
const decide = (plans: unknown[]): PlanDecision | null => {
  if (!mod?.resolvePlanIssue) return null;
  try {
    return mod.resolvePlanIssue(plans, PLAN_ISSUE_TITLE, DECIDED_LABEL);
  } catch {
    return null;
  }
};
const issueOf = (n: number, label: string, state: string) => ({
  number: n,
  title: PLAN_ISSUE_TITLE,
  state,
  labels: [{ name: label }],
});

check('resolvePlanIssue is exported', typeof mod?.resolvePlanIssue === 'function');
check(
  'one open decided issue authorises',
  decide([issueOf(PLAN_ISSUE, DECIDED_LABEL, 'OPEN')])?.ok === true,
  JSON.stringify(decide([issueOf(PLAN_ISSUE, DECIDED_LABEL, 'OPEN')])),
);

// The ordering the search returns must not change the answer. Both orders of
// the same two issues resolve to the same open one — that is the whole point.
const closedFirst = decide([issueOf(PLAN_ISSUE, DECIDED_LABEL, 'CLOSED'), issueOf(OPEN_PLAN_ISSUE, DECIDED_LABEL, 'OPEN')]);
const openFirst = decide([issueOf(OPEN_PLAN_ISSUE, DECIDED_LABEL, 'OPEN'), issueOf(PLAN_ISSUE, DECIDED_LABEL, 'CLOSED')]);
check(
  'search order cannot change which issue authorises',
  closedFirst?.ok === true && openFirst?.ok === true && closedFirst.issue === OPEN_PLAN_ISSUE && openFirst.issue === OPEN_PLAN_ISSUE,
  `${JSON.stringify(closedFirst)} vs ${JSON.stringify(openFirst)}`,
);

const onlyClosed = decide([issueOf(PLAN_ISSUE, DECIDED_LABEL, 'CLOSED')]);
check(
  'a closed decided issue alone never authorises',
  onlyClosed?.ok === false && onlyClosed.reason === 'pr:no-plan-issue' && onlyClosed.missing.includes('plan:not-found'),
  JSON.stringify(onlyClosed),
);
check('the closed-only refusal names the issue it found', String(onlyClosed?.ok === false ? onlyClosed.message : '').includes(`#${PLAN_ISSUE}`), JSON.stringify(onlyClosed));

// Fail closed on a state this reader cannot name: `null`, a typo or a shape
// GitHub may grow later must never be read as open.
for (const state of ['', 'oPeN', 'MERGED', 'unknown']) {
  const answer = decide([issueOf(PLAN_ISSUE, DECIDED_LABEL, state)]);
  const authorises = answer?.ok === true;
  const shouldAuthorise = state.toUpperCase() === 'OPEN';
  check(`a state of "${state}" ${shouldAuthorise ? 'authorises' : 'does not authorise'}`, authorises === shouldAuthorise, JSON.stringify(answer));
}
check('an issue carrying no state at all does not authorise', decide([{ number: PLAN_ISSUE, title: PLAN_ISSUE_TITLE, labels: [{ name: DECIDED_LABEL }] }])?.ok === false, 'no state');
check('an issue of another title is not a plan issue', decide([{ ...issueOf(PLAN_ISSUE, DECIDED_LABEL, 'OPEN'), title: 'something else' }])?.ok === false, 'other title');
check('an empty search is no plan issue', decide([])?.ok === false, JSON.stringify(decide([])));

// --- K: the residuals the two reviews of #167 left behind (#302) ------------
// The source-level cases of this group — the lifted module, the git buffer and
// what the two adoption documents are held to — are in `tests/adopt.test.mts`,
// which has room for them; this file started 74 lines from the 800-line cap.
//
// K3. the two checks the adoption pull request cannot pass, stated on it the
// way `skills/init/SKILL.md` states them for the bootstrap pull request.
// The body is hard-wrapped, so it is read unwrapped and the whole clause is
// asserted: three loose substrings passed over a sentence truncated mid-clause
// ("runs the with `node …`"), which is what that reader would have got.
const unwrap = (text: string): string => text.split('\n').join(' ').replace(/\s+/g, ' ');
const bodyFor = (record: any): string =>
  mod ? unwrap(mod.renderBody(plan(record, planning.repo) as Plan, { issue: PLAN_ISSUE, defaultBranch: 'main', record })) : '';
const bodyReds = bodyFor(recordValue);
const RED_CLAUSE =
  '**`scope` and `negative-control` are expected red on this pull request; the generated `test` and `check` jobs are the ones expected green on it.** `agentic-checks.yml` runs the two of them with `node .github/scripts/agentic/scope-check.mts` and `…/negative-control.mts`, which `node scripts/init.mts` copies into the repository and this branch does not carry';
check('the body states, as one unbroken sentence, which checks are expected red and why', bodyReds.includes(RED_CLAUSE), bodyReds.slice(bodyReds.indexOf('expected red') - 80, bodyReds.indexOf('expected red') + 340));

// Which jobs the workflow declares depends on the record: `renderChecks` emits
// `check` only when `commands.check` is set, so a body naming it regardless
// would send a reader after a job that does not exist.
const noCheckBody = bodyFor({ ...recordValue, commands: { test: recordValue.commands.test, check: null } });
check(
  'the jobs named as expected green are the ones that record actually renders',
  noCheckBody.includes('the generated `test` job is the one expected green on it.') && !noCheckBody.includes('`check` job'),
  noCheckBody.slice(noCheckBody.indexOf('expected red'), noCheckBody.indexOf('expected red') + 200),
);

// A deny list the planner cannot read is skipped, never filtered: the twin of
// the `--hooks` refusal, on the path that decides what the branch carries.
const strayDeny = (path: string) => (path === SETTINGS ? JSON.stringify({ permissions: { deny: ['Bash(x)', 7] } }) : null);
const strayPlan = mod?.planPullRequest(recordValue, { root: planning.repo, baseFile: strayDeny });
const strayEntry = strayPlan?.files.find((file) => file.path === SETTINGS);
check(
  'a base deny entry that is not a string is skipped by name, and nothing is rewritten',
  strayEntry?.outcome === 'skipped' && strayEntry?.reason === 'deny-not-strings' && strayEntry?.content === null,
  JSON.stringify(strayEntry),
);
// K4. a question that has already been answered is not asked again.
const answered = fixture();
const answeredRun = adopt(['--plan-issue'], answered.repo, { FAKE_GH_PLAN: 'decided' });
const answeredOut = parse(answeredRun.stdout);
check(
  '--plan-issue refuses by name when the open plan issue already carries human:decided',
  answeredRun.status === 1 && answeredOut?.reason === 'plan-issue:already-decided' && answeredOut?.issue === PLAN_ISSUE,
  `${answeredRun.stdout}\n${answeredRun.stderr}`,
);
check('a decided plan issue is not asked again', !existsSync(join(answeredRun.stateDir, 'issue-create.args')), answeredRun.stateDir);

// K5. a base tree whose path cannot be read leaves no temporary index behind.
const broken = fixture({ [SETTINGS]: `${JSON.stringify({ permissions: { deny: [] } }, null, 2)}\n` });
const blob = git(['rev-parse', `HEAD:${SETTINGS}`], broken.repo).trim();
rmSync(join(broken.repo, '.git', 'objects', blob.slice(0, 2), blob.slice(2)), { force: true });
const ownTmp = mkdtempSync(join(tmpdir(), 'agentic-prtmp-'));
cleanup(() => rmSync(ownTmp, { recursive: true, force: true }));
const unreadable = adopt(['--pr'], broken.repo, { FAKE_GH_PLAN: 'decided', TMPDIR: ownTmp });
check(
  'a base path the tree names and git cannot read is pr:base-unreadable',
  unreadable.status === 1 && parse(unreadable.stdout)?.error === 'pr:base-unreadable',
  `${unreadable.stdout}\n${unreadable.stderr}`,
);
check(
  'the temporary index directory is removed after pr:base-unreadable',
  readdirSync(ownTmp).filter((name) => name.startsWith('agentic-adopt-index-')).length === 0,
  readdirSync(ownTmp).join(',') || '(empty)',
);
check('a base path that cannot be read pushes nothing', remoteSha(broken.origin, `refs/heads/${BRANCH}`) === '', BRANCH);

// K6. what the record says enters the plan issue as data, never as markup.
const WEIRD_BY = 'agentic-setup/adopt`x`';
const weird = fixture({ [RECORD_FILE]: `${JSON.stringify({ ...recordValue, generatedBy: WEIRD_BY }, null, 2)}\n` });
const weirdRun = adopt(['--plan-issue'], weird.repo, { FAKE_GH_PLAN: 'none' });
const weirdBody = bodyOf(weirdRun.stateDir, 'issue-create.args');
check(
  'a generatedBy holding a backtick enters the plan issue as a code span it cannot break out of',
  weirdBody.includes(`\`\` ${WEIRD_BY} \`\``),
  weirdBody.split('\n').find((line) => line.includes('Adoption record')) ?? `${weirdRun.stdout}\n${weirdRun.stderr}`,
);
check(
  'the record’s generatedAt is a code span too',
  new RegExp(`\`${recordValue.generatedAt}\``).test(weirdBody),
  weirdBody.split('\n').find((line) => line.includes('Adoption record')) ?? '',
);

finish();
