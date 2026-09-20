#!/usr/bin/env node
// What `node scripts/adopt.mts --pr` does with the boxes the plan issue asks a
// person to tick, and where the decision it acted on is recorded (#368).
//
// The plan issue `--plan-issue` opens ends "Tick what should happen, then move
// this issue to `human:decided`", and `--pr` refuses with the same sentence.
// Before this, the ticks were never read: the search asked for
// `number,title,state,labels` and the gate decided on the label alone, so a
// person who ticked two gaps out of five and one who ticked all five got the
// same pull request, and neither was told. Nothing recorded the decision
// either — no comment on the plan issue, and a pull request body that named no
// gap at all.
//
// This file is separate from `tests/adopt-pr.test.mts` because that one is
// three lines from the 800-line cap this repository holds every file to; it is
// granted by the issue's `## Files` for exactly that reason. The cases there
// prove the branch, the push and the gate; the cases here prove the decision.
//
// It has a split target of its own for the same reason (#423):
// `tests/adopt-pr-vocabulary.test.mts`. The rule the split follows is what a
// case needs to run. **A case that spawns the real script stays here**, with
// the plan bodies the fake `gh` answers with — including the parser cases
// below, which read those same four bodies. **A case that proves a module by
// importing it moves there**: who decided, the gap vocabulary, the report the
// JSON carries, the planner's reading of a declined box, and the prose pins of
// both adoption documents.
//
// Invariant 6: every write is proved by spawning the real script against a
// throwaway git repository whose `origin` is a throwaway bare repository, with
// a small fake `gh` first on PATH for every GitHub read, for `issue comment`
// and for `pr create`. No case here reaches a real repository. The parser is
// also exercised directly, as `resolvePlanIssue` already is in the sibling
// file: it is a pure function over what the search returned.
//
// Invariant 10: every plan body this file feeds the script is written out here
// as a literal. None of them comes from `renderPlan`, and no expected gap name
// is imported from `scripts/lib/adopt/inventory.mts` — a pin that reuses the
// thing it pins cannot catch that thing drifting.
//
// Negative control: when this file was written `--pr` never read a body, so
// the "some ticked" and "none ticked" cases failed on their own assertions and
// no comment was ever posted, and `scripts/lib/adopt/decision.mts` did not
// exist. It does now (#396), so the guarded import below answers with whatever
// the base exports and every case still fails on its own assertion rather than
// on a missing module — which is what the guard is for, and what keeps a red
// here from being read as structural.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

/** The one adoption branch, written out rather than imported. */
const BRANCH = 'chore/adopt-agentic-setup';

/** Its slug — what `node scripts/proof.mts <slug>` is given. */
const SLUG = 'adopt-agentic-setup';

/** The record's name, at the adopted repository's root. */
const RECORD_FILE = 'agentic.config.json';

/** The permission file the deny list is merged into. */
const SETTINGS = '.claude/settings.json';

/** The title the plan issue is deduplicated by; one per repository. */
const PLAN_ISSUE_TITLE = 'Adoption plan: what this repository is missing';

/** The label a plan issue carries once the decision it asked for was made. */
const DECIDED_LABEL = 'human:decided';

/** The plan issue number the fake `gh` answers with. */
const PLAN_ISSUE = 41;

/** The pull request the fake `gh` answers `pr create` with. */
const PR_URL = 'https://github.com/org/repo/pull/99';

/** The login the fake timeline says applied `human:decided`. */
const DECIDED_BY = 'the-owner';

/** A login that applied the *other* human label, and must never be reported. */
const PENDING_BY = 'planner-bot';

/**
 * The gap names the plan bodies below use, written out here. They are the
 * vocabulary `scripts/lib/adopt/inventory.mts` names, mirrored rather than
 * imported: a pin that reads the list it pins cannot catch the list drifting.
 */
const GAPS = ['ruleset:absent', 'labels:missing', 'workflows:missing', 'hooks:not-installed', 'test-command:none'];

/** The one gap of that list whose remedy is a file the pull request carries. */
const FILE_GAP = 'workflows:missing';

/** The workflow files that gap's remedy writes, and that declining it leaves out. */
const WORKFLOW_FILES = [
  '.github/workflows/agentic-checks.yml',
  '.github/workflows/guard-main.yml',
  '.github/workflows/issue-lint.yml',
];

/** The files the branch carries whatever was ticked: none of them is a gap's remedy. */
const ALWAYS = [RECORD_FILE, SETTINGS, `proof/${SLUG}.json`, `proof/${SLUG}.test.mjs`];

// --- the plan bodies, written out --------------------------------------------
// Each is the shape `--plan-issue` renders, reproduced here by hand. A checkbox
// line opens with its gap name in backticks; what follows the dash is prose a
// person may rewrite, and the parser must not read it.

/** One plan issue body, with the checklist lines it is given. */
const planBody = (lines: string[]): string =>
  [
    'The agent loop reads a repository, it does not assume one. This is what it reads here today.',
    '',
    '## What this repository has',
    '',
    '- Stack: `node` (detected)',
    '',
    '## What adoption would do',
    '',
    ...lines,
    '',
    'Tick what should happen, then move this issue to `human:decided`.',
    '',
    '## Files',
    '',
    '- `agentic.config.json`',
    '- `.github/workflows/**`',
  ].join('\n');

const ticked = (gap: string): string => `- [x] \`${gap}\` — adopt it`;
const empty = (gap: string): string => `- [ ] \`${gap}\` — adopt it`;

/** Every box ticked: the decision is "do all of it". */
const ALL_BODY = planBody(GAPS.map(ticked));

/** One box left empty, and it is the one whose remedy is a file. */
const SOME_BODY = planBody(GAPS.map((gap) => (gap === FILE_GAP ? empty(gap) : ticked(gap))));

/** No box ticked at all: a decision that accepts nothing is not an adoption. */
const NONE_BODY = planBody(GAPS.map(empty));

/**
 * The same decision as `SOME_BODY`, written by a person who rewrote every
 * remedy, used `*` for one bullet, uppercased one mark and spaced another out.
 * The backticked token that opens each line is the only thing that survived,
 * and it is the only thing the parser may read.
 */
const REWORDED_BODY = planBody([
  '- [X] `ruleset:absent` — yes please, we want the ruleset',
  '* [x] `labels:missing` — go ahead',
  '-   [ ]   `workflows:missing` — no: we maintain these by hand, leave them alone',
  '- [x] `hooks:not-installed` — fine',
  '- [x] `test-command:none` — fine',
]);

/**
 * The typo a person produces by dropping one character of `workflows:missing`.
 * Ticking it accepts a name no version of the inventory defines, while the box
 * it was nearly is left empty and counted as declined — so the workflows are
 * left out of the branch and every artefact records the decision as intended.
 */
const TYPO = 'workflow:missing';

/** `SOME_BODY`, plus a ticked box for a gap name that does not exist. */
const TYPO_BODY = planBody([...GAPS.map((gap) => (gap === FILE_GAP ? empty(gap) : ticked(gap))), ticked(TYPO)]);

/** What each body decides, as the run must report it. */
const ALL_ACCEPTED = [...GAPS];
const SOME_ACCEPTED = GAPS.filter((gap) => gap !== FILE_GAP);

// --- a fake `gh` -------------------------------------------------------------
// Every GitHub call of this file goes through it: the three inventory reads,
// the plan-issue search (which must now ask for the body), the timeline read
// that names who applied `human:decided`, `issue comment` and `pr create`.
// An unknown knob stops the fake with a named error rather than falling
// through to an empty list, which would read as "no plan issue" and pass a
// case by accident.

/** One issue of the plan title, as `gh issue list --json …` renders it. */
const issueJson = (body: string): string =>
  JSON.stringify([{ number: PLAN_ISSUE, title: PLAN_ISSUE_TITLE, state: 'OPEN', labels: [{ name: DECIDED_LABEL }], body }]);

const PLAN_ANSWERS: Record<string, string> = {
  all: issueJson(ALL_BODY),
  some: issueJson(SOME_BODY),
  none: issueJson(NONE_BODY),
  reworded: issueJson(REWORDED_BODY),
  typo: issueJson(TYPO_BODY),
  // A decided issue whose body carries no checklist at all — the shape a
  // person produces by deleting the section rather than by ticking nothing.
  'no-boxes': issueJson('Tick what should happen, then move this issue to `human:decided`.'),
};

/** `knob) echo '<json>' ;;` arms, one per body. */
const PLAN_ARMS = Object.entries(PLAN_ANSWERS)
  .map(([knob, answer]) => `      ${knob}) echo '${answer}' ;;`)
  .join('\n');

/** The issue timeline, oldest first: the decided event is not the last one. */
const TIMELINE = JSON.stringify([
  { event: 'labeled', label: { name: 'human:pending' }, actor: { login: PENDING_BY } },
  { event: 'labeled', label: { name: DECIDED_LABEL }, actor: { login: DECIDED_BY } },
  { event: 'commented', actor: { login: 'a-passer-by' } },
]);

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
  "api repos/{owner}/{repo}/issues/"*"/timeline"*)
    if [ "\${FAKE_GH_FAIL:-}" = "timeline" ]; then
      echo "fake-gh: the timeline could not be read" >&2
      exit 1
    fi
    echo '${TIMELINE}'
    ;;
  "label list")
    echo '[]'
    ;;
  "issue list")
    case "\${FAKE_GH_PLAN:-all}" in
${PLAN_ARMS}
      *)
        echo "fake-gh: no answer for FAKE_GH_PLAN=\${FAKE_GH_PLAN:-all}" >&2
        exit 64
        ;;
    esac
    ;;
  "issue comment")
    if [ "\${FAKE_GH_FAIL:-}" = "comment" ]; then
      echo "fake-gh: the comment could not be posted" >&2
      exit 1
    fi
    : > "\$state/issue-comment.args"
    for a in "\$@"; do printf '%s\\0' "\$a" >> "\$state/issue-comment.args"; done
    echo "https://github.com/org/repo/issues/${PLAN_ISSUE}#issuecomment-1"
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

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-dec-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// This repository dogfoods itself, so the shell running the suite may have the
// detection overrides set for real. Every child below starts without them.
const { AGENTIC_TEST_CMD: _t, AGENTIC_CHECK_CMD: _c, ...BASE_ENV } = process.env;

/** A fresh directory for one run's `gh` argv log and recorded arguments. */
function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-ghstate-dec-'));
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

/** Everything one recorded `gh` invocation was given, as a flat list. */
function argsOf(stateDir: string, file: string): string[] {
  const path = join(stateDir, file);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\0').filter((s) => s.length > 0);
}

/** The `gh` calls one run made, in the order it made them. */
const ghLog = (stateDir: string): string[] => {
  const path = join(stateDir, 'gh-argv.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.length > 0);
};

/** Where a `gh` call sits in one run's log, or -1 when it was never made. */
const indexOfCall = (stateDir: string, pattern: RegExp): number => ghLog(stateDir).findIndex((line) => pattern.test(line));

// --- the disposable repository, and its disposable `origin` -----------------
/** A green test on the base: the baseline the generated red is measured against. */
const GREEN_TEST = "import { test } from 'node:test';\ntest('the base passes its own tests', () => {});\n";

/** A throwaway repository with a bare `origin`, one commit on `main`, pushed. */
function fixture(): { repo: string; origin: string } {
  const origin = mkdtempSync(join(tmpdir(), 'agentic-origin-dec-'));
  cleanup(() => rmSync(origin, { recursive: true, force: true }));
  git(['init', '-q', '--bare', '-b', 'main'], origin);

  const repo = tempRepo();
  commit(
    repo,
    {
      'package.json': `${JSON.stringify({ name: 'fx', private: true, scripts: { test: 'node --test' } }, null, 2)}\n`,
      'tests/ok.test.mjs': GREEN_TEST,
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

// --- the modules under test, imported rather than spawned -------------------
type Decision = { accepted: string[]; declined: string[] };
type Module = {
  parseDecision: (body: string) => Decision;
  decidedBy: (timeline: unknown, label: string) => string | null;
};

let mod: Module | null = null;
try {
  mod = (await import('../scripts/lib/adopt/decision.mts')) as unknown as Module;
} catch {
  mod = null;
}

// --- A: the search has to ask for the body ----------------------------------
// A gate that asks for `number,title,state,labels` cannot read a tick at all:
// the boxes are in the body, and no call requested it.
const all = fixture();
const a = adopt(['--pr'], all.repo, { FAKE_GH_PLAN: 'all' });
const aOut = parse(a.stdout);
check(
  'the plan search asks GitHub for the issue body, where the boxes are',
  ghLog(a.stateDir).some((line) => /^issue list /.test(line) && /--json [^ ]*\bbody\b/.test(line)),
  ghLog(a.stateDir).find((line) => /^issue list /.test(line)) ?? '(no issue list call)',
);

// --- B: every box ticked is the whole adoption ------------------------------
check('--pr over a plan with every box ticked exits 0', a.status === 0 && aOut !== null, `${a.stdout}\n${a.stderr}`);
check(
  '--pr reports the decision it acted on: every gap accepted, none declined',
  [...(aOut?.decision?.accepted ?? [])].sort().join(',') === [...ALL_ACCEPTED].sort().join(',') &&
    (aOut?.decision?.declined ?? []).length === 0,
  JSON.stringify(aOut?.decision),
);
// The JSON is the third place a decision is read, and until #423 it said only
// which boxes were ticked. What each tick did is proved here end to end, over
// the real run; `tests/adopt-pr-vocabulary.test.mts` holds the shape itself.
const ticksOf = (out: any): any[] => out?.decision?.ticks ?? [];
const tickFor = (out: any, gap: string): any => ticksOf(out).find((tick: any) => tick?.gap === gap) ?? null;
check(
  'the JSON tells the accepted gap this branch carries from the ones it only recorded, with their remedies',
  tickFor(aOut, FILE_GAP)?.state === 'carried' &&
    ALL_ACCEPTED.filter((gap) => gap !== FILE_GAP).every(
      (gap) => tickFor(aOut, gap)?.state === 'recorded' && String(tickFor(aOut, gap)?.remedy ?? '') !== '',
    ),
  JSON.stringify(ticksOf(aOut)),
);
const allHead = String(aOut?.head ?? '');
const allBase = git(['rev-parse', 'HEAD'], all.repo);
const allCarried = allHead.length === 40 ? pathsIn(all.repo, `${allBase}...${allHead}`) : [];
check(
  'every box ticked carries every generated file, the workflows included',
  allCarried.join(',') === [...ALWAYS, ...WORKFLOW_FILES].sort().join(','),
  allCarried.join(','),
);

// --- C: a box left empty leaves its remedy out of the diff ------------------
// The person ticked four gaps of five, and the one they left empty is the only
// one of the five whose remedy is a file this pull request would carry. That
// file is not in the branch.
const some = fixture();
const someBase = git(['rev-parse', 'HEAD'], some.repo);
const c = adopt(['--pr'], some.repo, { FAKE_GH_PLAN: 'some' });
const cOut = parse(c.stdout);
check('--pr over a partly ticked plan exits 0', c.status === 0 && cOut !== null, `${c.stdout}\n${c.stderr}`);
check(
  'the run reports the four accepted gaps and the one declined',
  [...(cOut?.decision?.accepted ?? [])].sort().join(',') === [...SOME_ACCEPTED].sort().join(',') &&
    (cOut?.decision?.declined ?? []).join(',') === FILE_GAP,
  JSON.stringify(cOut?.decision),
);
const someHead = String(cOut?.head ?? '');
const someCarried = someHead.length === 40 ? pathsIn(some.repo, `${someBase}...${someHead}`) : [];
check(
  'the declined gap’s remedy is not in the branch, and everything else is',
  someCarried.join(',') === [...ALWAYS].sort().join(','),
  someCarried.join(','),
);
check(
  'no workflow file rides in a branch whose workflow box was left empty',
  WORKFLOW_FILES.every((path) => !someCarried.includes(path)),
  someCarried.join(','),
);

// The body names both sides, so a reader of the pull request alone knows what
// was accepted and what was not — and a declined gap whose remedy is not a
// file (the ruleset) is named as declined and nothing more.
const somePr = bodyOf(c.stateDir, 'pr-create.args');
check('the pull request body names the declined gap', somePr.includes(FILE_GAP), somePr.slice(0, 600));
check(
  'the pull request body names every accepted gap',
  SOME_ACCEPTED.every((gap) => somePr.includes(gap)),
  somePr.slice(0, 600),
);
check(
  'the pull request body still closes the plan issue on its first line',
  new RegExp(`^Closes #${PLAN_ISSUE}$`, 'm').test(somePr),
  somePr.split('\n').slice(0, 3).join('\n'),
);
check(
  'the body’s ## Files section lists no workflow the decision declined',
  somePr.split('## Files')[1] !== undefined && WORKFLOW_FILES.every((path) => !somePr.split('## Files')[1].includes(path)),
  somePr.split('## Files')[1]?.slice(0, 400) ?? '(no ## Files section)',
);

// --- D: a decision that accepts nothing is not an adoption ------------------
const none = fixture();
const d = adopt(['--pr'], none.repo, { FAKE_GH_PLAN: 'none' });
const dOut = parse(d.stdout);
check('--pr over a decided plan with no box ticked exits 1', d.status === 1 && dOut !== null, `${d.stdout}\n${d.stderr}`);
check(
  'it refuses by its own name, not as a missing label',
  dOut?.reason === 'pr:plan-nothing-ticked' && Array.isArray(dOut?.missing) && dOut.missing.includes('plan:nothing-ticked'),
  d.stdout,
);
check('the refusal names the plan issue it read', dOut?.issue === PLAN_ISSUE, d.stdout);
check('a plan with no box ticked pushes no branch', remoteSha(none.origin, `refs/heads/${BRANCH}`) === '', BRANCH);
check('a plan with no box ticked opens no pull request', !existsSync(join(d.stateDir, 'pr-create.args')), d.stateDir);
check('a plan with no box ticked comments nothing: there is no decision to record', !existsSync(join(d.stateDir, 'issue-comment.args')), d.stateDir);
check('a plan with no box ticked leaves the working tree byte-identical', git(['status', '--porcelain'], none.repo) === '', git(['status', '--porcelain'], none.repo));

// A decided issue whose checklist a person deleted outright is the same
// answer: nothing was accepted, so nothing is adopted.
const gone = fixture();
const dGone = adopt(['--pr'], gone.repo, { FAKE_GH_PLAN: 'no-boxes' });
check(
  'a decided plan carrying no checkbox at all refuses the same way',
  dGone.status === 1 && parse(dGone.stdout)?.reason === 'pr:plan-nothing-ticked',
  `${dGone.stdout}\n${dGone.stderr}`,
);
check('a decided plan carrying no checkbox pushes nothing', remoteSha(gone.origin, `refs/heads/${BRANCH}`) === '', BRANCH);

// --- E: the boxes are read by their token, never by their prose -------------
// A person who rewrote every remedy, uppercased a mark, used `*` for a bullet
// and spread the brackets out still decided exactly what `SOME_BODY` decides.
const reworded = fixture();
const rewordedBase = git(['rev-parse', 'HEAD'], reworded.repo);
const e = adopt(['--pr'], reworded.repo, { FAKE_GH_PLAN: 'reworded' });
const eOut = parse(e.stdout);
check('--pr over a reworded plan exits 0', e.status === 0 && eOut !== null, `${e.stdout}\n${e.stderr}`);
check(
  'a reworded plan decides exactly what its ticks say, and the prose changes nothing',
  [...(eOut?.decision?.accepted ?? [])].sort().join(',') === [...SOME_ACCEPTED].sort().join(',') &&
    (eOut?.decision?.declined ?? []).join(',') === FILE_GAP,
  JSON.stringify(eOut?.decision),
);
const rewordedHead = String(eOut?.head ?? '');
check(
  'a reworded plan carries the same files the same decision carries',
  rewordedHead.length === 40 && pathsIn(reworded.repo, `${rewordedBase}...${rewordedHead}`).join(',') === [...ALWAYS].sort().join(','),
  rewordedHead.length === 40 ? pathsIn(reworded.repo, `${rewordedBase}...${rewordedHead}`).join(',') : '(no branch)',
);

// --- F: the decision is recorded on the plan issue, before the pull request --
const comment = bodyOf(c.stateDir, 'issue-comment.args');
check('--pr comments on the plan issue', comment.length > 0, argsOf(c.stateDir, 'issue-comment.args').join(' ') || '(no comment)');
check(
  'the comment is left on the plan issue the run read, by number',
  argsOf(c.stateDir, 'issue-comment.args').includes(String(PLAN_ISSUE)),
  argsOf(c.stateDir, 'issue-comment.args').join(' '),
);
check(
  'the comment names every accepted gap',
  SOME_ACCEPTED.every((gap) => comment.includes(gap)),
  comment,
);
check('the comment names the declined gap', comment.includes(FILE_GAP), comment);
check(
  'the comment names the login that applied human:decided, and not the one that applied human:pending',
  comment.includes(DECIDED_BY) && !comment.includes(PENDING_BY),
  comment,
);
check(
  'the run reports the same login it commented',
  cOut?.decision?.decidedBy === DECIDED_BY,
  JSON.stringify(cOut?.decision),
);
check(
  'the decision is commented before the pull request is opened',
  indexOfCall(c.stateDir, /^issue comment /) !== -1 &&
    indexOfCall(c.stateDir, /^pr create /) !== -1 &&
    indexOfCall(c.stateDir, /^issue comment /) < indexOfCall(c.stateDir, /^pr create /),
  ghLog(c.stateDir).join('\n'),
);
check(
  'the login is read from the issue timeline, not guessed',
  ghLog(c.stateDir).some((line) => /^api repos\/\{owner\}\/\{repo\}\/issues\/41\/timeline/.test(line)),
  ghLog(c.stateDir).join('\n'),
);

// A timeline that cannot be read is a named failure, not a field quietly
// reported as absent: this module's header says it fails closed.
const blind = fixture();
const f = adopt(['--pr'], blind.repo, { FAKE_GH_PLAN: 'all', FAKE_GH_FAIL: 'timeline' });
check(
  'a timeline that cannot be read is a named error, and nothing is pushed',
  f.status === 1 && /^pr:/.test(parse(f.stdout)?.error ?? '') && remoteSha(blind.origin, `refs/heads/${BRANCH}`) === '',
  `${f.stdout}\n${f.stderr}`,
);
check('a timeline that cannot be read opens no pull request', !existsSync(join(f.stateDir, 'pr-create.args')), f.stateDir);

// --- F2: a comment that cannot be written is the one failure that leaves state
// `pr:decision-not-recorded` is the only new path that leaves something behind:
// the branch is pushed by the time the comment is attempted, and it stays
// pushed. The pull request is not opened, so re-running is the remedy — and
// re-running has to answer `{ held }` on the branch rather than commenting a
// second time, which is the whole reason the comment sits after the push.
const mute = fixture();
const f2 = adopt(['--pr'], mute.repo, { FAKE_GH_PLAN: 'all', FAKE_GH_FAIL: 'comment' });
const f2Out = parse(f2.stdout);
check(
  'a comment that cannot be written exits 1 as pr:decision-not-recorded',
  f2.status === 1 && f2Out?.error === 'pr:decision-not-recorded',
  `${f2.stdout}\n${f2.stderr}`,
);
const mutedHead = remoteSha(mute.origin, `refs/heads/${BRANCH}`);
check('the branch is on origin: the push happened before the comment was attempted', mutedHead.length === 40, mutedHead || '(no branch)');
check('no pull request is opened over an unrecorded decision', !existsSync(join(f2.stateDir, 'pr-create.args')), f2.stateDir);
check('nothing is written into the working tree either', git(['status', '--porcelain'], mute.repo) === '', git(['status', '--porcelain'], mute.repo));

// The remedy `docs/adopt.md` names: run it again. The branch is there, so the
// create-only push is `held`, and the run stops before it comments twice.
const again = adopt(['--pr'], mute.repo, { FAKE_GH_PLAN: 'all' });
check('running it again answers { held } rather than pushing over the branch', parse(again.stdout)?.held === BRANCH && again.status === 2, `${again.stdout}\n${again.stderr}`);
check('and leaves the remote branch exactly where it was', remoteSha(mute.origin, `refs/heads/${BRANCH}`) === mutedHead, remoteSha(mute.origin, `refs/heads/${BRANCH}`));
check('a held run comments nothing: one decision is recorded once', !existsSync(join(again.stateDir, 'issue-comment.args')), again.stateDir);
check('and opens no pull request', !existsSync(join(again.stateDir, 'pr-create.args')), again.stateDir);

// --- F3: a mistyped tick is carried, and the report says it was one ---------
// The defect #400 names, end to end: the person ticked `workflow:missing`, so
// `workflows:missing` is untouched and its files are left out of the branch.
// The run must not refuse over a typo, and must not leave the two facts to be
// found apart: the comment and the body name the unrecognised tick and the
// untouched box it was nearly, side by side.
const typo = fixture();
const typoBase = git(['rev-parse', 'HEAD'], typo.repo);
const g2 = adopt(['--pr'], typo.repo, { FAKE_GH_PLAN: 'typo' });
const g2Out = parse(g2.stdout);
check('--pr over a plan carrying a mistyped tick still exits 0', g2.status === 0 && g2Out !== null, `${g2.stdout}\n${g2.stderr}`);
check(
  'the mistyped name is carried into the decision rather than refused',
  (g2Out?.decision?.accepted ?? []).includes(TYPO) && (g2Out?.decision?.declined ?? []).includes(FILE_GAP),
  JSON.stringify(g2Out?.decision),
);
const typoHead = String(g2Out?.head ?? '');
const typoCarried = typoHead.length === 40 ? pathsIn(typo.repo, `${typoBase}...${typoHead}`) : [];
check(
  'and the workflows are left out of the branch, which is the harm the report has to name',
  WORKFLOW_FILES.every((path) => !typoCarried.includes(path)),
  typoCarried.join(','),
);
check(
  'the JSON names the tick nothing can act on, what it was nearest, and the declined gap it was aimed at',
  tickFor(g2Out, TYPO)?.state === 'unrecognised' &&
    tickFor(g2Out, TYPO)?.nearest === FILE_GAP &&
    (g2Out?.decision?.shadowed ?? []).some((entry: any) => entry?.gap === FILE_GAP && entry?.tick === TYPO),
  JSON.stringify(g2Out?.decision),
);
const typoComment = bodyOf(g2.stateDir, 'issue-comment.args');
const typoPr = bodyOf(g2.stateDir, 'pr-create.args');
const flat = (text: string): string => text.split('\n').join(' ').replace(/\s+/g, ' ');
const declinedLineOf = (text: string): string => text.split('\n').find((l) => l.trimStart().startsWith(`- \`${FILE_GAP}\``)) ?? '';
check(
  'the comment on the plan issue names the tick nothing can act on',
  /unrecognised/i.test(typoComment) && flat(typoComment).includes(`\`${TYPO}\``),
  typoComment.slice(0, 700) || '(no comment)',
);
check(
  'and names the untouched box beside it, in the same line as the gap it declined',
  flat(declinedLineOf(typoComment)).includes(TYPO),
  declinedLineOf(typoComment) || typoComment.slice(0, 700),
);
check(
  'the pull request body says both of the same two things',
  /unrecognised/i.test(typoPr) && flat(typoPr).includes(`\`${TYPO}\``) && flat(declinedLineOf(typoPr)).includes(TYPO),
  declinedLineOf(typoPr) || typoPr.slice(0, 700),
);

// --- F4: a base that already carries the workflows is not a branch that does --
// The reviewer's reproduction of #431's own defect, end to end. `--record` and
// `--workflows` write the generated files, a commit puts them on the base, and
// the same all-ticked plan is answered again. Every workflow then plans as
// `skipped (unchanged)`, no commit touches `.github/workflows/`, and the
// decision must not say the branch carries them: a gap is carried because this
// diff carries its files, never because of what kind of gap it is.
const settled = fixture();
adopt(['--record'], settled.repo, { FAKE_GH_PLAN: 'all' });
adopt(['--workflows'], settled.repo, { FAKE_GH_PLAN: 'all' });
check(
  'the fixture really does carry the generated workflows before --pr runs',
  WORKFLOW_FILES.every((path) => existsSync(join(settled.repo, path))),
  WORKFLOW_FILES.filter((path) => !existsSync(join(settled.repo, path))).join(',') || '(all present)',
);
git(['add', '-A'], settled.repo);
git(['commit', '-q', '-m', 'the workflows this repository already had'], settled.repo);
git(['push', '-q', 'origin', 'main'], settled.repo);
const settledBase = git(['rev-parse', 'HEAD'], settled.repo);
const h = adopt(['--pr'], settled.repo, { FAKE_GH_PLAN: 'all' });
const hOut = parse(h.stdout);
check('--pr over a base that already has the workflows exits 0', h.status === 0 && hOut !== null, `${h.stdout}\n${h.stderr}`);
const settledHead = String(hOut?.head ?? '');
const settledCarried = settledHead.length === 40 ? pathsIn(settled.repo, `${settledBase}...${settledHead}`) : [];
check(
  'no commit of that branch touches the workflows, because the base already has them',
  WORKFLOW_FILES.every((path) => !settledCarried.includes(path)),
  settledCarried.join(','),
);
check(
  'so the JSON does not report the workflow gap as carried, though its box was ticked',
  (hOut?.decision?.accepted ?? []).includes(FILE_GAP) && tickFor(hOut, FILE_GAP)?.state === 'not-in-diff',
  JSON.stringify(ticksOf(hOut)),
);
check(
  'and the body does not claim it either, fourteen lines under a file list carrying none of it',
  !bodyOf(h.stateDir, 'pr-create.args').includes(`\`${FILE_GAP}\` — **carried**`),
  bodyOf(h.stateDir, 'pr-create.args').split('## The decision this acts on')[1]?.slice(0, 400) ?? '(no decision section)',
);

// --- G: the parser itself, over bodies written out here ---------------------
// The spawn cases above are what invariant 6 asks for; these prove the reading
// directly, the way `resolvePlanIssue` is proved in the sibling file. Every
// body is a literal of this file, so nothing here can agree with the parser by
// sharing its source.
check('parseDecision is exported', typeof mod?.parseDecision === 'function');

const read = (body: string): Decision => {
  if (!mod?.parseDecision) return { accepted: ['(not exported)'], declined: ['(not exported)'] };
  try {
    return mod.parseDecision(body);
  } catch {
    return { accepted: ['(threw)'], declined: ['(threw)'] };
  }
};

const readAll = read(ALL_BODY);
check(
  'a body with every box ticked accepts every gap and declines none',
  readAll.accepted.join(',') === GAPS.join(',') && readAll.declined.length === 0,
  JSON.stringify(readAll),
);
const readSome = read(SOME_BODY);
check(
  'a body with one box empty declines exactly that gap',
  readSome.accepted.join(',') === SOME_ACCEPTED.join(',') && readSome.declined.join(',') === FILE_GAP,
  JSON.stringify(readSome),
);
const readNone = read(NONE_BODY);
check(
  'a body with no box ticked accepts nothing and declines every gap',
  readNone.accepted.length === 0 && readNone.declined.join(',') === GAPS.join(','),
  JSON.stringify(readNone),
);
const readReworded = read(REWORDED_BODY);
check(
  'the reworded body reads exactly as the plain one: the token decides, not the prose',
  readReworded.accepted.join(',') === readSome.accepted.join(',') && readReworded.declined.join(',') === readSome.declined.join(','),
  JSON.stringify(readReworded),
);
check(
  'an uppercase X is a tick',
  read('- [X] `ruleset:absent` — yes').accepted.join(',') === 'ruleset:absent',
  JSON.stringify(read('- [X] `ruleset:absent` — yes')),
);
check(
  'a body with no checkbox at all decides nothing, rather than throwing',
  read('Nothing to see here.\n\n## Files\n\n- `agentic.config.json`').accepted.length === 0 &&
    read('Nothing to see here.\n\n## Files\n\n- `agentic.config.json`').declined.length === 0,
  JSON.stringify(read('Nothing to see here.')),
);
check(
  'a bulleted line that is not a checkbox is not a gap',
  read('- `agentic.config.json`\n- [x] `labels:missing` — do it').accepted.join(',') === 'labels:missing',
  JSON.stringify(read('- `agentic.config.json`\n- [x] `labels:missing` — do it')),
);
check(
  'a checkbox whose gap name is not backticked is read as no gap at all',
  read('- [x] labels:missing — do it').accepted.length === 0 && read('- [x] labels:missing — do it').declined.length === 0,
  JSON.stringify(read('- [x] labels:missing — do it')),
);
check(
  'only the first backticked span of a line is the gap name',
  read('- [x] `labels:missing` — create `state:ready` too').accepted.join(',') === 'labels:missing',
  JSON.stringify(read('- [x] `labels:missing` — create `state:ready` too')),
);

finish();
