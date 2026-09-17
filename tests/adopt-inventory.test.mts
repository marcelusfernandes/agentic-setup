#!/usr/bin/env node
// Cases for scripts/adopt.mts and scripts/lib/adopt/inventory.mts (#162):
// `--inventory` describes a repository without changing it, and
// `--plan-issue` turns that description into exactly one `human:pending`
// issue.
//
// The script is spawned for real (CLAUDE.md invariant 6) against throwaway
// git repositories, with a fake `gh` first on PATH: a bash script that
// dispatches on the subcommand, logs its argv, dumps `issue create`'s
// arguments NUL-separated so the body can be read back, and prints canned
// JSON keyed by environment knobs (FAKE_GH_RULES, FAKE_GH_LABELS,
// FAKE_GH_FAIL).
//
// Negative control: on the base, `scripts/adopt.mts` does not exist, so
// every spawn below exits non-zero with nothing on stdout and every JSON
// assertion has nothing to parse. No case can pass vacuously.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, tempRepo, RUNTIME, ROOT } from './lib/harness.mts';

// The label vocabulary scripts/init.mts seeds; a repository missing any of
// it carries the `labels:missing` gap.
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
 * Every value each knob below accepts. A knob is a gate, and a gate read
 * without checking what it was set to is no gate at all: `FAKE_GH_FAIL` with
 * a typo used to fall through to the `*)` arm of each case and answer
 * normally, so a case asking for a failure would pass while proving nothing.
 * The empty string is listed explicitly — "unset" is a value the harness
 * knows, not the absence of one.
 */
const KNOBS = {
  FAKE_GH_FAIL: ['', 'repo', 'ruleset', 'labels', 'issue-list', 'issue-create', 'issue-url', 'label-create'],
  FAKE_GH_RULES: ['', 'full', 'no-review'],
  FAKE_GH_LABELS: ['', 'all'],
};

/** `knob NAME "$NAME" allowed...` lines, one per knob, in a stable order. */
const KNOB_GUARDS = Object.entries(KNOBS)
  .map(([name, values]) => `knob ${name} "\${${name}:-}" ${values.map((v) => `'${v}'`).join(' ')}`)
  .join('\n');

// --- a fake `gh` on PATH ----------------------------------------------------
const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"

# Every knob is checked against its closed set before anything is answered.
# The rejection goes to a marker file as well as to stderr: adopt.mts reports
# a read that failed by its own named reason and never by gh's wording, so a
# typo is invisible on stdout by design.
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
    if [ "\${FAKE_GH_FAIL:-}" = "ruleset" ]; then echo "fake-gh: rules read failed" >&2; exit 1; fi
    case "\${FAKE_GH_RULES:-}" in
      full) echo '[{"type":"deletion"},{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"scope"},{"context":"negative-control"}]}}]' ;;
      no-review) echo '[{"type":"pull_request","parameters":{"required_approving_review_count":0}},{"type":"required_status_checks","parameters":{"required_status_checks":[{"context":"scope"}]}}]' ;;
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
  "issue list")
    if [ "\${FAKE_GH_FAIL:-}" = "issue-list" ]; then echo "fake-gh: issue search failed" >&2; exit 1; fi
    if [ -f "$state/created-title" ]; then
      title="$(cat "$state/created-title")"
      printf '[{"number":7,"title":"%s"}]\\n' "$title"
    else
      echo '[]'
    fi
    ;;
  "issue create")
    if [ "\${FAKE_GH_FAIL:-}" = "issue-create" ]; then echo "fake-gh: could not create the issue" >&2; exit 1; fi
    : > "$state/issue-create.args"
    for a in "$@"; do printf '%s\\0' "$a" >> "$state/issue-create.args"; done
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--title" ]; then printf '%s' "$a" > "$state/created-title"; fi
      prev="$a"
    done
    # Exit 0 with output the caller cannot read a number out of: the branch
    # where gh "succeeded" but said nothing usable.
    if [ "\${FAKE_GH_FAIL:-}" = "issue-url" ]; then echo "Creating issue in org/repo"; exit 0; fi
    echo "https://github.com/org/repo/issues/7"
    ;;
  "label create")
    if [ "\${FAKE_GH_FAIL:-}" = "label-create" ]; then echo "fake-gh: could not create the label" >&2; exit 1; fi
    echo "fake-gh: label created"
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-adopt-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a fake `git` that answers everything but one question ------------------
// Real git for every call except `rev-parse --git-path hooks`, which exits
// non-zero: the only way to exercise "git could not tell us where the hooks
// live" without breaking `rev-parse --show-toplevel` in the same run.
const REAL_GIT = (spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout ?? '').trim();
const FAKE_GIT = `#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = "--git-path" ]; then echo "fake-git: cannot resolve a git path" >&2; exit 1; fi
done
exec "${REAL_GIT}" "$@"
`;
const fakeGitDir = mkdtempSync(join(tmpdir(), 'agentic-fakegit-adopt-'));
cleanup(() => rmSync(fakeGitDir, { recursive: true, force: true }));
writeFileSync(join(fakeGitDir, 'git'), FAKE_GIT);
chmodSync(join(fakeGitDir, 'git'), 0o755);
const PATH_WITH_FAKE_GIT = `${fakeGitDir}:${PATH_WITH_FAKE_GH}`;

// --- fixtures ----------------------------------------------------------------
/** A committed throwaway repository; `files` land in the initial commit. */
function fixture(files: Record<string, string>): string {
  const dir = tempRepo();
  commit(dir, { 'README.md': '# fixture\n', ...files }, 'initial');
  return dir;
}

/** The text of the hook `scripts/init.mts` installs, marker and all. */
const OUR_PRE_PUSH = '#!/bin/sh\n# agentic-setup pre-push\nexit 0\n';

/** Installs a pre-push hook that looks like the one scripts/init.mts writes. */
function installPrePush(dir: string, at = join('.git', 'hooks')): void {
  mkdirSync(join(dir, at), { recursive: true });
  const path = join(dir, at, 'pre-push');
  writeFileSync(path, OUR_PRE_PUSH);
  chmodSync(path, 0o755);
}

const WORKFLOW = 'name: x\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n';

function newStateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-adopt-state-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh-argv.log'), '');
  return dir;
}

type Run = { status: number | null; stdout: string; stderr: string; log: string; stateDir: string };

// The detection overrides are stripped from the inherited environment: this
// repository dogfoods itself, so the shell running this suite may have them
// set for real, and every case below asserts the *detected* commands.
const { AGENTIC_TEST_CMD: _t, AGENTIC_CHECK_CMD: _c, ...BASE_ENV } = process.env;

function adopt(args: string[], cwd: string, env: Record<string, string> = {}, stateDir = newStateDir()): Run {
  // The argv log is per-run even when the state directory is shared (the
  // two --plan-issue runs share one, so the second sees the first's issue).
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
 * Every `gh` invocation that would change something on GitHub. `gh api`
 * with a field flag (`-f`, `-F`, `--field`, `--raw-field`, `--input`) is
 * included: gh switches that request to POST on its own, so a "read" that
 * carries one is a write with no `-X` to give it away.
 */
const MUTATING =
  /\b(issue (create|edit|close|delete|comment|reopen|lock)|label (create|edit|delete|clone)|repo edit|pr (create|merge|edit|close|comment|review|ready)|api .*(-X|--method) (POST|PUT|PATCH|DELETE)|api .*( -f | -F | --field | --raw-field | --input )|ruleset)\b/;

const INVENTORY_KEYS = [
  'stack',
  'test',
  'check',
  'source',
  'defaultBranch',
  'ruleset',
  'labels',
  'hooks',
  'workflows',
  'autoMerge',
  'deleteBranchOnMerge',
  'gaps',
];

// --- A: a fully adopted repository -> every field, no gap, nothing written ---
const adopted = fixture({
  'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs', check: 'tsc' } }),
  '.github/workflows/agentic-checks.yml': WORKFLOW,
  '.github/workflows/guard-main.yml': WORKFLOW,
  '.github/workflows/issue-lint.yml': WORKFLOW,
});
installPrePush(adopted);
const a = adopt(['--inventory'], adopted, { FAKE_GH_RULES: 'full', FAKE_GH_LABELS: 'all' });
check('inventory on an adopted repo exits 0', a.status === 0, `${a.stdout}\n${a.stderr}`);
const aOut = parse(a.stdout);
check(
  'inventory prints every field of the report',
  aOut !== null && INVENTORY_KEYS.every((k) => Object.prototype.hasOwnProperty.call(aOut, k)),
  `missing: ${INVENTORY_KEYS.filter((k) => !aOut || !Object.prototype.hasOwnProperty.call(aOut, k)).join(', ')} — ${a.stdout}`,
);
check(
  'inventory reports the stack and commands from detectCommands',
  aOut?.stack === 'node' && aOut?.test === 'npm test' && aOut?.check === 'npm run check' && aOut?.source === 'detected',
  a.stdout,
);
check(
  'inventory reports the repository settings it read from gh',
  aOut?.defaultBranch === 'main' && aOut?.autoMerge === true && aOut?.deleteBranchOnMerge === false,
  a.stdout,
);
check(
  'inventory reports the ruleset, the labels, the hooks and the workflows it found',
  aOut?.ruleset !== null &&
    aOut?.ruleset?.requiredApprovingReviewCount === 1 &&
    Array.isArray(aOut?.labels) &&
    aOut.labels.includes('human:pending') &&
    Array.isArray(aOut?.hooks) &&
    aOut.hooks.includes('pre-push') &&
    Array.isArray(aOut?.workflows) &&
    aOut.workflows.includes('guard-main.yml'),
  a.stdout,
);
check('an adopted repository has no gaps', Array.isArray(aOut?.gaps) && aOut.gaps.length === 0, a.stdout);
check(
  'inventory leaves the working tree byte-identical',
  aOut !== null && git(['status', '--porcelain'], adopted) === '',
  git(['status', '--porcelain'], adopted),
);
check('inventory used gh, and used no mutating verb', a.log.trim().length > 0 && !MUTATING.test(a.log), a.log);

// --- B: a repository that has adopted nothing -> every gap, still no write ---
const bare = fixture({});
const b = adopt(['--inventory'], bare, {});
check('inventory on a bare repo exits 0', b.status === 0, `${b.stdout}\n${b.stderr}`);
const bOut = parse(b.stdout);
const EXPECTED_GAPS = ['ruleset:absent', 'labels:missing', 'hooks:not-installed', 'workflows:missing', 'test-command:none'];
check(
  'a bare repository reports every gap by its name',
  Array.isArray(bOut?.gaps) && EXPECTED_GAPS.every((g) => bOut.gaps.includes(g)),
  JSON.stringify(bOut?.gaps),
);
check('a bare repository reports ruleset: null, not a made-up one', bOut?.ruleset === null, b.stdout);
check('a bare repository reports stack unknown and source none', bOut?.stack === 'unknown' && bOut?.source === 'none', b.stdout);
check(
  'inventory on a bare repo leaves the working tree byte-identical',
  bOut !== null && git(['status', '--porcelain'], bare) === '',
  git(['status', '--porcelain'], bare),
);
check('inventory on a bare repo used gh, and used no mutating verb', b.log.trim().length > 0 && !MUTATING.test(b.log), b.log);

// --- C: a ruleset that exists but does not require a review ------------------
const c = adopt(['--inventory'], adopted, { FAKE_GH_RULES: 'no-review', FAKE_GH_LABELS: 'all' });
const cOut = parse(c.stdout);
check(
  'a ruleset without a required review is a review-not-required gap, not an absent one',
  Array.isArray(cOut?.gaps) && cOut.gaps.includes('ruleset:review-not-required') && !cOut.gaps.includes('ruleset:absent'),
  c.stdout,
);

// --- D: a read that cannot answer fails closed -------------------------------
const d = adopt(['--inventory'], adopted, { FAKE_GH_RULES: 'full', FAKE_GH_LABELS: 'all', FAKE_GH_FAIL: 'ruleset' });
const dOut = parse(d.stdout);
check('an unreadable ruleset exits 1', d.status === 1 && dOut !== null, `${d.stdout}\n${d.stderr}`);
check('an unreadable ruleset reports { error } with a named reason', typeof dOut?.error === 'string' && /ruleset/.test(dOut.error), d.stdout);
check('an unreadable ruleset never reports a ruleset field at all', dOut !== null && !Object.prototype.hasOwnProperty.call(dOut, 'ruleset'), d.stdout);
check('an unreadable ruleset never claims the gap ruleset:absent', dOut !== null && !/ruleset:absent/.test(d.stdout), d.stdout);

const dl = adopt(['--inventory'], adopted, { FAKE_GH_RULES: 'full', FAKE_GH_FAIL: 'labels' });
const dlOut = parse(dl.stdout);
check('an unreadable label list exits 1 with { error }', dl.status === 1 && typeof dlOut?.error === 'string', `${dl.stdout}\n${dl.stderr}`);
check('an unreadable label list never claims the gap labels:missing', dlOut !== null && !/labels:missing/.test(dl.stdout), dl.stdout);

const outside = mkdtempSync(join(tmpdir(), 'agentic-adopt-nogit-'));
cleanup(() => rmSync(outside, { recursive: true, force: true }));
const dg = adopt(['--inventory'], outside, {});
check('outside a git repository exits 1 with { error }', dg.status === 1 && typeof parse(dg.stdout)?.error === 'string', `${dg.stdout}\n${dg.stderr}`);

// --- E: --plan-issue opens exactly one human:pending issue -------------------
const planned = fixture({ 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs' } }) });
const planState = newStateDir();
const e = adopt(['--plan-issue'], planned, {}, planState);
check('first --plan-issue exits 0', e.status === 0, `${e.stdout}\n${e.stderr}`);
const eOut = parse(e.stdout);
check('first --plan-issue reports the issue it opened', eOut?.issue === 7 && typeof eOut?.url === 'string', e.stdout);
const eCreates = e.log.trim().split('\n').filter((l) => l.startsWith('issue create'));
check('first --plan-issue ran exactly one gh issue create', eCreates.length === 1, e.log);
const createArgs = existsSync(join(planState, 'issue-create.args'))
  ? readFileSync(join(planState, 'issue-create.args'), 'utf8').split('\0').filter((s) => s.length > 0)
  : [];
check('the plan issue carries the human:pending label', createArgs.includes('--label') && createArgs.includes('human:pending'), createArgs.join(' | '));
const titleIdx = createArgs.indexOf('--title');
const planTitle = titleIdx === -1 ? '' : createArgs[titleIdx + 1];
check('the plan issue has a title', planTitle.length > 0, createArgs.join(' | '));
const bodyIdx = createArgs.indexOf('--body');
const planBody = bodyIdx === -1 ? '' : createArgs[bodyIdx + 1];
check(
  'the plan issue body renders the inventory',
  /stack:\s*`node`/i.test(planBody) && /npm test/.test(planBody) && /default branch:/i.test(planBody),
  planBody,
);
const bodyGaps = ['ruleset:absent', 'labels:missing', 'hooks:not-installed', 'workflows:missing'];
check(
  'the plan issue lists exactly the gaps found, as checkboxes',
  bodyGaps.every((g) => new RegExp(`- \\[ \\] .*${g.replace(':', ':')}`).test(planBody)) && !/test-command:none/.test(planBody),
  planBody,
);
// Not just "there are N checkbox lines": every one must carry real remedy
// prose after the em-dash, so a REMEDIES entry that returned '' fails here.
const checkboxes = planBody.split(/\r?\n/).filter((line) => line.startsWith('- [ ] '));
const remedies = checkboxes.map((line) => line.split('—').slice(1).join('—').trim());
check(
  'each checkbox says what adoption would do about that gap, in non-empty prose',
  checkboxes.length === bodyGaps.length && remedies.length === bodyGaps.length && remedies.every((text) => /[a-z]{4}/.test(text) && text.length >= 20),
  checkboxes.join('\n'),
);
check(
  'each remedy names the concrete thing adoption would do',
  /ruleset/.test(remedies[0] ?? '') &&
    remedies.some((text) => /label/.test(text)) &&
    remedies.some((text) => /pre-push/.test(text)) &&
    remedies.some((text) => /workflow/.test(text)),
  checkboxes.join('\n'),
);
check('the plan issue was the only mutation: one issue create, one label create, nothing else', eCreates.length === 1 && (e.log.match(/^label create /gm) ?? []).length === 1, e.log);

// --- F: a second run never opens a second issue ------------------------------
const f = adopt(['--plan-issue'], planned, {}, planState);
const fOut = parse(f.stdout);
check('second --plan-issue refuses (exit 1)', f.status === 1 && fOut !== null, `${f.stdout}\n${f.stderr}`);
check(
  'second --plan-issue reports { refused, reason: plan-issue:already-open }',
  fOut?.refused !== undefined && fOut?.reason === 'plan-issue:already-open',
  f.stdout,
);
check(
  'second --plan-issue ran no gh issue create at all',
  f.log.trim().length > 0 && !f.log.split('\n').some((l) => l.startsWith('issue create')),
  f.log,
);

// --- G: usage -----------------------------------------------------------------
const g = adopt([], adopted, {});
check(
  'no flag exits 1 with { error } and makes no gh call at all',
  g.status === 1 && typeof parse(g.stdout)?.error === 'string' && g.log.trim() === '',
  `${g.stdout}\n${g.stderr}\n${g.log}`,
);

// --- H: core.hooksPath -------------------------------------------------------
// A repository that points git elsewhere for its hooks (husky, lefthook, a
// shared hooks directory) still runs our pre-push -- so it is installed, and
// reporting hooks:not-installed would send adoption to overwrite a hook it
// never looked at. scripts/init.mts:175 asks git where the hooks are
// (`git rev-parse --git-path hooks`); this must ask the same question.
const husky = fixture({ '.husky/.keep': '' });
git(['config', 'core.hooksPath', '.husky'], husky);
installPrePush(husky, '.husky');
// The hook itself is untracked here (it is installed, not committed), so
// "writes nothing" is measured against the tree as the run found it.
const huskyBefore = git(['status', '--porcelain'], husky);
const h = adopt(['--inventory'], husky, {});
const hOut = parse(h.stdout);
check('core.hooksPath: inventory still exits 0', h.status === 0 && hOut !== null, `${h.stdout}\n${h.stderr}`);
check('core.hooksPath: the hook git would actually run is reported as installed', Array.isArray(hOut?.hooks) && hOut.hooks.includes('pre-push'), h.stdout);
check(
  'core.hooksPath: no false hooks:not-installed gap',
  Array.isArray(hOut?.gaps) && !hOut.gaps.includes('hooks:not-installed'),
  JSON.stringify(hOut?.gaps),
);
check(
  'core.hooksPath: still writes nothing',
  hOut !== null && git(['status', '--porcelain'], husky) === huskyBefore,
  `${huskyBefore} -> ${git(['status', '--porcelain'], husky)}`,
);

// A hook at the default path is *not* ours when git was told to look
// elsewhere -- the inverse mistake, and the one that would report a hook
// that never runs.
const misleading = fixture({ '.husky/.keep': '' });
git(['config', 'core.hooksPath', '.husky'], misleading);
installPrePush(misleading);
const hm = adopt(['--inventory'], misleading, {});
const hmOut = parse(hm.stdout);
check(
  'core.hooksPath: a hook at .git/hooks that git no longer runs is not reported as installed',
  hmOut !== null && Array.isArray(hmOut?.hooks) && !hmOut.hooks.includes('pre-push') && hmOut.gaps.includes('hooks:not-installed'),
  hm.stdout,
);

// And when git cannot answer where the hooks live, that is not "no hooks".
const hf = adopt(['--inventory'], adopted, { FAKE_GH_RULES: 'full', FAKE_GH_LABELS: 'all', PATH: PATH_WITH_FAKE_GIT });
const hfOut = parse(hf.stdout);
check('an unresolvable hooks path exits 1 with { error }', hf.status === 1 && typeof hfOut?.error === 'string' && /hooks/.test(hfOut.error), `${hf.stdout}\n${hf.stderr}`);
check('an unresolvable hooks path never claims the gap hooks:not-installed', hfOut !== null && !/hooks:not-installed/.test(hf.stdout), hf.stdout);

// --- I: every fail-closed branch of --plan-issue ----------------------------
// Each of these is a read or a write that could not answer. None may end in
// a plan issue, and none may end in a report that quietly omits a field.
const plannable = fixture({ 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs' } }) });
const created = (log: string): number => (log.match(/^issue create /gm) ?? []).length;

const iRepo = adopt(['--plan-issue'], plannable, { FAKE_GH_FAIL: 'repo' });
const iRepoOut = parse(iRepo.stdout);
check(
  'plan-issue: an unreadable repository exits 1 with { error: repository:… } and creates nothing',
  iRepo.status === 1 && iRepoOut?.error === 'repository:unreadable' && created(iRepo.log) === 0,
  `${iRepo.stdout}\n${iRepo.log}`,
);

const iInv = adopt(['--inventory'], plannable, { FAKE_GH_FAIL: 'repo' });
const iInvOut = parse(iInv.stdout);
check(
  'inventory: an unreadable repository exits 1 with { error } and reports no field of it',
  iInv.status === 1 && iInvOut?.error === 'repository:unreadable' && !Object.prototype.hasOwnProperty.call(iInvOut, 'defaultBranch'),
  iInv.stdout,
);

const iSearch = adopt(['--plan-issue'], plannable, { FAKE_GH_FAIL: 'issue-list' });
const iSearchOut = parse(iSearch.stdout);
check(
  'plan-issue: an unreadable open-issue search exits 1 with { error } and creates nothing',
  iSearch.status === 1 && typeof iSearchOut?.error === 'string' && created(iSearch.log) === 0,
  `${iSearch.stdout}\n${iSearch.log}`,
);
check(
  'plan-issue: an unreadable search never reports { refused } instead (a failed read is not "none open")',
  iSearchOut !== null && iSearchOut?.refused === undefined,
  iSearch.stdout,
);

const iLabel = adopt(['--plan-issue'], plannable, { FAKE_GH_FAIL: 'label-create' });
const iLabelOut = parse(iLabel.stdout);
check(
  'plan-issue: a label that cannot be created exits 1 with { error } and creates no issue',
  iLabel.status === 1 && typeof iLabelOut?.error === 'string' && /human:pending/.test(iLabelOut.error) && created(iLabel.log) === 0,
  `${iLabel.stdout}\n${iLabel.log}`,
);

const iCreate = adopt(['--plan-issue'], plannable, { FAKE_GH_FAIL: 'issue-create' });
const iCreateOut = parse(iCreate.stdout);
// The name is pinned, not merely "some named reason": callers branch on it,
// `docs/adopt.md` lists it, and renaming it is a breaking change rather than
// a rewording.
check(
  "plan-issue: a failed issue create exits 1 with a stable { error } and gh's own message in { detail }",
  iCreate.status === 1 && iCreateOut?.error === 'plan-issue:not-created' && /could not create the issue/.test(iCreateOut?.detail ?? ''),
  `${iCreate.stdout}\n${iCreate.stderr}`,
);
check(
  'plan-issue: the failed-create name is exactly plan-issue:not-created, and carries no gh wording',
  iCreateOut?.error === 'plan-issue:not-created' && !/could not/.test(iCreateOut?.error ?? ''),
  JSON.stringify(iCreateOut),
);
check('plan-issue: a failed issue create tried exactly once, never twice', created(iCreate.log) === 1, iCreate.log);

const iUrl = adopt(['--plan-issue'], plannable, { FAKE_GH_FAIL: 'issue-url' });
const iUrlOut = parse(iUrl.stdout);
check(
  'plan-issue: an issue number that cannot be read back exits 1 with { error }, never { issue: NaN }',
  iUrl.status === 1 && typeof iUrlOut?.error === 'string' && iUrlOut?.issue === undefined,
  `${iUrl.stdout}\n${iUrl.stderr}`,
);

// --- J: a path that exists and cannot be read is not a path that is absent --
// ENOENT is the only errno that means "not there". EACCES on a hook file or
// on .github/workflows must fail closed: reporting hooks:not-installed or
// workflows:missing would send adoption to install over something it was
// never allowed to look at.
const IS_ROOT = process.getuid?.() === 0;

/**
 * Runs `fn` with `path` at `mode`, and puts the mode back afterwards —
 * inline, not only in a cleanup, because the harness runs tempRepo()'s
 * rmSync before any cleanup registered later and `force` does not get it
 * past a directory it cannot read. The cleanup is the belt to that braces.
 */
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
  check('unreadable hook and workflows cases skipped (running as root, which EACCES cannot stop)', true);
} else {
  const lockedHook = fixture({ 'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs' } }) });
  installPrePush(lockedHook);
  const jh = withMode(join(lockedHook, '.git', 'hooks', 'pre-push'), 0o000, () =>
    adopt(['--inventory'], lockedHook, { FAKE_GH_RULES: 'full', FAKE_GH_LABELS: 'all' }),
  );
  const jhOut = parse(jh.stdout);
  check(
    'a hook file that exists and cannot be read exits 1 with { error: hooks:unreadable }',
    jh.status === 1 && jhOut?.error === 'hooks:unreadable',
    `${jh.stdout}\n${jh.stderr}`,
  );
  check(
    'an unreadable hook file is never reported as hooks:not-installed',
    jhOut !== null && !jh.stdout.includes('hooks:not-installed'),
    jh.stdout,
  );

  const lockedWorkflows = fixture({
    'package.json': JSON.stringify({ name: 'fx', scripts: { test: 'node t.mjs' } }),
    '.github/workflows/agentic-checks.yml': WORKFLOW,
  });
  const jw = withMode(join(lockedWorkflows, '.github', 'workflows'), 0o000, () =>
    adopt(['--inventory'], lockedWorkflows, { FAKE_GH_RULES: 'full', FAKE_GH_LABELS: 'all' }),
  );
  const jwOut = parse(jw.stdout);
  check(
    'a workflows directory that exists and cannot be listed exits 1 with { error: workflows:unreadable }',
    jw.status === 1 && jwOut?.error === 'workflows:unreadable',
    `${jw.stdout}\n${jw.stderr}`,
  );
  check(
    'an unlistable workflows directory is never reported as workflows:missing',
    jwOut !== null && !jw.stdout.includes('workflows:missing'),
    jw.stdout,
  );
}

// --- K: a knob this harness does not know stops it, loudly ------------------
// The gate on every case above. `FAKE_GH_FAIL=labls` used to be answered as
// though nothing was meant to fail, which would turn a fail-closed case into
// a green one that proved the opposite of what it claims.
const kState = newStateDir();
const k = adopt(['--inventory'], adopted, { FAKE_GH_RULES: 'full', FAKE_GH_FAIL: 'labls' }, kState);
const kMarker = join(kState, 'knob-error');
check('a knob value this harness does not know stops the run', k.status !== 0, `${k.status}: ${k.stdout}\n${k.stderr}`);
check(
  'a knob value this harness does not know is named, not silently treated as the default',
  existsSync(kMarker) && /FAKE_GH_FAIL=labls/.test(readFileSync(kMarker, 'utf8')),
  existsSync(kMarker) ? readFileSync(kMarker, 'utf8') : 'no knob-error file written',
);
check('a knob typo never yields a report', parse(k.stdout)?.gaps === undefined, k.stdout);

finish();
