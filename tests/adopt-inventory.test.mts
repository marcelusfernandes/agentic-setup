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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

// --- a fake `gh` on PATH ----------------------------------------------------
const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"

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
    if [ -f "$state/created-title" ]; then
      title="$(cat "$state/created-title")"
      printf '[{"number":7,"title":"%s"}]\\n' "$title"
    else
      echo '[]'
    fi
    ;;
  "issue create")
    : > "$state/issue-create.args"
    for a in "$@"; do printf '%s\\0' "$a" >> "$state/issue-create.args"; done
    prev=""
    for a in "$@"; do
      if [ "$prev" = "--title" ]; then printf '%s' "$a" > "$state/created-title"; fi
      prev="$a"
    done
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

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-adopt-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- fixtures ----------------------------------------------------------------
/** A committed throwaway repository; `files` land in the initial commit. */
function fixture(files: Record<string, string>): string {
  const dir = tempRepo();
  commit(dir, { 'README.md': '# fixture\n', ...files }, 'initial');
  return dir;
}

/** Installs a pre-push hook that looks like the one scripts/init.mts writes. */
function installPrePush(dir: string): void {
  mkdirSync(join(dir, '.git', 'hooks'), { recursive: true });
  const path = join(dir, '.git', 'hooks', 'pre-push');
  writeFileSync(path, '#!/bin/sh\n# agentic-setup pre-push\nexit 0\n');
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

function adopt(args: string[], cwd: string, env: Record<string, string> = {}, stateDir = newStateDir()): Run {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'adopt.mts'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, ...env },
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

/** Every `gh` verb that would change something on GitHub. */
const MUTATING = /\b(issue create|issue edit|issue close|label create|label edit|label delete|repo edit|pr create|pr merge|pr edit|api -X|--method (POST|PUT|PATCH|DELETE)|ruleset)\b/;

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
check('each checkbox says what adoption would do about that gap', (planBody.match(/^- \[ \] /gm) ?? []).length === bodyGaps.length, planBody);

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

finish();
