#!/usr/bin/env node
// Cases for scripts/init.mts: the installer copies templates into a target
// repository, merges settings, and installs an executable pre-push hook.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { check, cleanup, commit, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
commit(repo, { 'README.md': '# x\n' }, 'init');
mkdirSync(join(repo, '.claude'), { recursive: true });
writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf / *)', 'WebFetch', 'Bash(gh pr merge *--admin*)'] }, other: true }));
const init = (...extra: string[]) => spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mts'), '--no-gh', ...extra], { cwd: repo, encoding: 'utf8' });

let r = init();
check('init exits 0', r.status === 0, `${r.stdout}${r.stderr}`);
for (const f of [
  '.github/ISSUE_TEMPLATE/task.md', '.github/ISSUE_TEMPLATE/config.yml', '.github/pull_request_template.md',
  '.github/workflows/guard-main.yml', '.github/workflows/agentic-checks.yml',
  '.github/scripts/agentic/scope-check.mts', '.github/scripts/agentic/negative-control.mts', '.github/scripts/agentic/lib/detect.mts',
  '.worktreeinclude',
]) check(`init copies ${f}`, existsSync(join(repo, f)));
check('init leaves nothing stray at the root', !existsSync(join(repo, 'claude-settings.json')) && !existsSync(join(repo, 'ci')));

const settings = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
check('init keeps existing settings', settings.other === true && settings.permissions.deny.includes('WebFetch'));
check('init merges the deny list without duplicates', settings.permissions.deny.includes('Bash(git push --force *)') && settings.permissions.deny.filter((d: string) => d === 'Bash(rm -rf / *)').length === 1);
// #204: a deny rule this installer once seeded is replaced by its current
// wording, not kept beside it; a rule the adopter added is left alone.
const mergeRules = settings.permissions.deny.filter((d: string) => d.includes('gh pr merge'));
check('init replaces the stale --admin-only merge rule with the current one', mergeRules.length === 1 && mergeRules[0] === 'Bash(gh pr merge *)', JSON.stringify(mergeRules));
check('init leaves a rule it never seeded untouched', settings.permissions.deny.includes('WebFetch'));

const prePush = join(repo, '.git', 'hooks', 'pre-push');
check('init installs an executable pre-push', existsSync(prePush) && (statSync(prePush).mode & 0o111) !== 0);

writeFileSync(join(repo, '.github', 'pull_request_template.md'), 'mine\n');
r = init();
check('init rerun respects an edited file', r.status === 0 && /pull_request_template\.md exists and differs/.test(r.stdout) && readFileSync(join(repo, '.github', 'pull_request_template.md'), 'utf8') === 'mine\n', r.stdout);
const settings2 = JSON.parse(readFileSync(join(repo, '.claude', 'settings.json'), 'utf8'));
check('init rerun does not duplicate deny rules', new Set(settings2.permissions.deny).size === settings2.permissions.deny.length);
init('--force');
check('init --force overwrites an edited file', readFileSync(join(repo, '.github', 'pull_request_template.md'), 'utf8') !== 'mine\n');

// the installed git pre-push, fed the way git feeds it
const pre = (line: string, env: Record<string, string> = {}) => spawnSync('bash', [prePush, 'origin', 'https://example.invalid/x.git'], { cwd: repo, input: line, encoding: 'utf8', env: { ...process.env, ...env } });
const sha = git(['rev-parse', 'HEAD'], repo);
const zero = '0'.repeat(40);
check('pre-push refuses a push to main', pre(`refs/heads/main ${sha} refs/heads/main ${zero}\n`).status === 1);
check('pre-push allows a new work branch', pre(`refs/heads/feat/1-x ${sha} refs/heads/feat/1-x ${zero}\n`).status === 0);
check('pre-push honours the bootstrap valve', pre(`refs/heads/main ${sha} refs/heads/main ${zero}\n`, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 0);
// #72: the bootstrap valve lifts "push to main" only, never "delete main" —
// a zero local sha against refs/heads/main is a remote deletion.
check('pre-push valve does not cover deleting main', pre(`refs/heads/main ${zero} refs/heads/main ${sha}\n`, { AGENTIC_ALLOW_PUSH_MAIN: '1' }).status === 1);
check('pre-push allows deleting a work branch', pre(`refs/heads/feat/1-x ${zero} refs/heads/feat/1-x ${sha}\n`).status === 0);

// --dry-run: an adopter previews what init would do; nothing is written, and
// the report of the dry run matches the report of the real run that follows.
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === '.git') return [];
    const p = join(dir, name);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p)];
  });
}
function snapshot(dir: string): string {
  return listFiles(dir)
    .sort()
    .map((f) => `${f} ${readFileSync(join(dir, f), 'utf8')}`)
    .join('');
}

const dryRepo = tempRepo();
commit(dryRepo, { 'README.md': '# y\n' }, 'init');
const initIn = (dir: string, ...extra: string[]) =>
  spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mts'), '--no-gh', ...extra], { cwd: dir, encoding: 'utf8' });

const dryPrePush = join(dryRepo, '.git', 'hooks', 'pre-push');
const beforePrePushExists = existsSync(dryPrePush);
const beforeTree = snapshot(dryRepo);

const dry = initIn(dryRepo, '--dry-run');
check('init --dry-run exits 0', dry.status === 0, `${dry.stdout}${dry.stderr}`);
check('init --dry-run reports a header', /^dry run — nothing written\n/.test(dry.stdout), dry.stdout);

check('init --dry-run creates or modifies no file', snapshot(dryRepo) === beforeTree);
check('init --dry-run leaves .git/hooks/pre-push untouched', existsSync(dryPrePush) === beforePrePushExists);

const real = initIn(dryRepo);
check('init real run (after dry run) exits 0', real.status === 0, `${real.stdout}${real.stderr}`);
check(
  'dry run report equals the following real run report',
  dry.stdout === `dry run — nothing written\n${real.stdout}`,
  `dry:\n${dry.stdout}\nreal:\n${real.stdout}`,
);
check('the real run actually wrote the pre-push hook', existsSync(dryPrePush));

// --- gh section: labels no longer seed state:done; auto-merge and
// delete-branch-on-merge get enabled -----------------------------------
// A fake `gh` on PATH mocking the real contract: `auth status` always
// succeeds; `api repos/{owner}/{repo} --jq .allow_auto_merge` /
// `--jq .delete_branch_on_merge` each report a state-dir marker (real gh
// does not have an `autoMergeAllowed` field on `repo view --json`, so that
// command is deliberately left unmocked -- it falls to the catch-all);
// `repo edit --enable-auto-merge` / `--delete-branch-on-merge` create the
// matching marker; `label create` succeeds and dumps its argv
// NUL-separated, one record per line, to `$state/gh-label-argv.log`, so a
// label seeded with an empty `--description` (every `type:` label) can still
// be read back argument by argument — the space-joined `gh-argv.log` above
// cannot show one. `repo view --json
// defaultBranchRef` (the ruleset's target) always answers "main". Every
// call touching `.../rulesets` (list, detail, POST, PUT) is handled by one
// case arm keyed on the endpoint prefix: a 403 fixture
// (`$state/rulesets-403`) wins over everything; otherwise `-X POST`/`-X PUT`
// write the request body to `$state/ruleset-{post,put}-body.json` and report
// a canned id, a GET on the collection echoes `$state/rulesets-list.json`
// (default `[]`), and a GET on `.../rulesets/<id>` echoes
// `$state/ruleset-<id>.json` (default `{}`) — the live list endpoint answers
// with summaries only, so conditions, rules and bypass actors live in the
// per-id fixture, exactly as the real API serves them. A
// `$state/ruleset-<id>-fail` marker makes that one detail GET fail instead —
// the refusal path of the lookup.
const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"
case "\${1:-} \${2:-}" in
  "auth status") exit 0 ;;
  "repo view") echo '{"defaultBranchRef":{"name":"main"}}' ;;
  "api repos/{owner}/{repo}")
    case "$4" in
      .allow_auto_merge)
        if [ -f "$state/automerge-enabled" ]; then echo "true"; else echo "false"; fi ;;
      .delete_branch_on_merge)
        if [ -f "$state/deletebranch-enabled" ]; then echo "true"; else echo "false"; fi ;;
      *) echo "" ;;
    esac
    ;;
  "api repos/{owner}/{repo}/rulesets"*)
    if [ -f "$state/rulesets-403" ]; then
      echo "gh: HTTP 403: Upgrade to GitHub Pro or make this repository public to enable this feature (https://docs.github.com)" >&2
      exit 1
    fi
    if [ "\${3:-}" = "-X" ] && [ "\${4:-}" = "POST" ]; then
      cat > "$state/ruleset-post-body.json"
      echo '{"id":101,"name":"agentic-setup"}'
    elif [ "\${3:-}" = "-X" ] && [ "\${4:-}" = "PUT" ]; then
      cat > "$state/ruleset-put-body.json"
      echo '{"id":42,"name":"agentic-setup"}'
    else
      id="\${2##*/rulesets/}"
      if [ "$id" = "\${2:-}" ]; then
        cat "$state/rulesets-list.json" 2>/dev/null || echo '[]'
      elif [ -f "$state/ruleset-$id-fail" ]; then
        echo "gh: HTTP 500: Internal Server Error (https://api.github.invalid/rulesets/$id)" >&2
        exit 1
      else
        cat "$state/ruleset-$id.json" 2>/dev/null || echo '{}'
      fi
    fi
    ;;
  "repo edit")
    case "$3" in
      --enable-auto-merge) touch "$state/automerge-enabled" ;;
      --delete-branch-on-merge) touch "$state/deletebranch-enabled" ;;
    esac
    ;;
  "label create")
    printf '%s\\0' "$@" >> "$state/gh-label-argv.log"
    printf '\\n' >> "$state/gh-label-argv.log"
    exit 0 ;;
  "api") echo "" ;;
  *) exit 0 ;;
esac
`;
const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-init-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// AGENTIC_REVIEWER_TOKEN decides whether --require-review warns (#143 AC3),
// so the base environment of every fake-gh run drops it: the cases below say
// what it is, never the shell the suite happens to run in.
const ENV_WITHOUT_REVIEWER_TOKEN = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => name !== 'AGENTIC_REVIEWER_TOKEN'),
);

function initWithGh(dir: string, stateDir: string, ...extra: string[]) {
  return initWithGhEnv(dir, stateDir, {}, ...extra);
}
/** The same run with `env` laid over that reviewer-token-free base environment. */
function initWithGhEnv(dir: string, stateDir: string, env: Record<string, string>, ...extra: string[]) {
  return spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mts'), ...extra], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...ENV_WITHOUT_REVIEWER_TOKEN, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, ...env },
  });
}
function ghLog(stateDir: string): string {
  return existsSync(join(stateDir, 'gh-argv.log')) ? readFileSync(join(stateDir, 'gh-argv.log'), 'utf8') : '';
}

const ghRepo = tempRepo();
commit(ghRepo, { 'README.md': '# gh\n' }, 'init');

const state1 = mkdtempSync(join(tmpdir(), 'agentic-init-ghstate-'));
cleanup(() => rmSync(state1, { recursive: true, force: true }));
const gh1 = initWithGh(ghRepo, state1);
check('init (gh, both settings disabled) exits 0', gh1.status === 0, `${gh1.stdout}${gh1.stderr}`);
check('init enables auto-merge and reports it', /\+ auto-merge enabled/.test(gh1.stdout) && /repo edit --enable-auto-merge/.test(ghLog(state1)), gh1.stdout);
check('init enables delete-branch-on-merge and reports it', /\+ delete-branch-on-merge enabled/.test(gh1.stdout) && /repo edit --delete-branch-on-merge/.test(ghLog(state1)), gh1.stdout);
check('init no longer seeds state:done', !/label create state:done\b/.test(ghLog(state1)), ghLog(state1));
check('init still seeds other state labels', /label create state:ready\b/.test(ghLog(state1)), ghLog(state1));
check('init seeds human:pending with the colour and description shared with the Codex route',
  /label create human:pending --color f9d0c4 --description A human decision is required; affected work is paused/.test(ghLog(state1)), ghLog(state1));
check('init seeds human:decided with the colour and description shared with the Codex route',
  /label create human:decided --color c2e0c6 --description A human decision was recorded; kept as the audit trail/.test(ghLog(state1)), ghLog(state1));
check('init no longer seeds the bare human label, so a pre-existing one is left untouched', !/label create human --color/.test(ghLog(state1)), ghLog(state1));

// #145: the seeded set is `labels.json`, not an array inside the installer.
// The dictionary is read here with plain JSON.parse — `scripts/lib/labels.mts`
// is the code under test, so the expectation cannot come from it.
type DictionaryEntry = { name: string; color: string; description: string; routes: string[]; legacy?: boolean };
function dictionary(): DictionaryEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(join(ROOT, 'labels.json'), 'utf8'));
    return Array.isArray(parsed) ? (parsed as DictionaryEntry[]) : [];
  } catch {
    return [];
  }
}
/** Every `gh label create` the fake gh recorded, as its argv. */
function labelCalls(stateDir: string): string[][] {
  const log = join(stateDir, 'gh-label-argv.log');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((record) => record !== '')
    .map((record) => {
      const args = record.split('\0');
      args.pop(); // the trailing NUL of the last argument
      return args;
    });
}
const argAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1] ?? '';
const seeded = labelCalls(state1).map((args) => `${args[2]}\t${argAfter(args, '--color')}\t${argAfter(args, '--description')}`).sort();
const expectedSeeded = dictionary()
  .filter((entry) => entry.routes?.includes('claude') && !entry.legacy)
  .map((entry) => `${entry.name}\t${entry.color}\t${entry.description}`)
  .sort();
check('init seeds exactly the claude-routed entries of labels.json, colours and descriptions included',
  expectedSeeded.length > 0 && JSON.stringify(seeded) === JSON.stringify(expectedSeeded),
  `seeded:\n${seeded.join('\n')}\nexpected:\n${expectedSeeded.join('\n')}`);
check('init passes --force on every label create, so a drifted colour is corrected',
  labelCalls(state1).length > 0 && labelCalls(state1).every((args) => args.includes('--force')), JSON.stringify(labelCalls(state1)));

const gh2 = initWithGh(ghRepo, state1); // same state dir: both markers now present
check('init rerun (both settings already enabled) exits 0', gh2.status === 0, `${gh2.stdout}${gh2.stderr}`);
check('init rerun reports auto-merge already enabled and does not call repo edit again', /= auto-merge already enabled/.test(gh2.stdout), gh2.stdout);
check('init rerun reports delete-branch-on-merge already enabled and does not call repo edit again', /= delete-branch-on-merge already enabled/.test(gh2.stdout), gh2.stdout);
check('init rerun did not call gh repo edit --enable-auto-merge a second time', (ghLog(state1).match(/repo edit --enable-auto-merge/g) ?? []).length === 1, ghLog(state1));
check('init rerun did not call gh repo edit --delete-branch-on-merge a second time', (ghLog(state1).match(/repo edit --delete-branch-on-merge/g) ?? []).length === 1, ghLog(state1));

// A fixture that starts already enabled (both settings), proving the read
// path -- not just the write path -- actually works: a run against this
// fixture must report "=" on its very first call, with no repo edit at all.
const state3 = mkdtempSync(join(tmpdir(), 'agentic-init-ghstate-already-'));
cleanup(() => rmSync(state3, { recursive: true, force: true }));
writeFileSync(join(state3, 'automerge-enabled'), '');
writeFileSync(join(state3, 'deletebranch-enabled'), '');
const gh3 = initWithGh(ghRepo, state3);
check('init against an already-enabled repository exits 0', gh3.status === 0, `${gh3.stdout}${gh3.stderr}`);
check('init against an already-enabled repository reports both settings as "="', /= auto-merge already enabled/.test(gh3.stdout) && /= delete-branch-on-merge already enabled/.test(gh3.stdout), gh3.stdout);
check('init against an already-enabled repository never calls gh repo edit', !/repo edit/.test(ghLog(state3)), ghLog(state3));

const state2 = mkdtempSync(join(tmpdir(), 'agentic-init-ghstate-dry-'));
cleanup(() => rmSync(state2, { recursive: true, force: true }));
const ghDry = initWithGh(ghRepo, state2, '--dry-run');
check('init --dry-run (with gh) exits 0', ghDry.status === 0, `${ghDry.stdout}${ghDry.stderr}`);
check('init --dry-run reports it would enable auto-merge and delete-branch-on-merge', /\+ auto-merge enabled/.test(ghDry.stdout) && /\+ delete-branch-on-merge enabled/.test(ghDry.stdout), ghDry.stdout);
check('init --dry-run never actually calls gh repo edit', !/repo edit/.test(ghLog(state2)), ghLog(state2));

// --- --rules: creates, or updates, the branch ruleset that governs the
// default branch — matched by what it governs, never by its name (#143) —
// with the checks the merge model depends on (docs/decisions.md item 9(a))
// and the review gate left off unless `--require-review` asks for it (#143).
// `ghRepo` carries no workflow files of its own, so the third required check
// falls back to its default, "test".
check('init without --rules never touches the rulesets endpoint', !/rulesets/.test(ghLog(state1)), ghLog(state1));

/** The body the fake gh recorded for a POST or a PUT, or null when none was sent. */
function ruleBody(stateDir: string, kind: 'post' | 'put'): any {
  const p = join(stateDir, `ruleset-${kind}-body.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
/** One rule of a recorded payload by type, or null. */
const ruleOfType = (body: any, type: string): any => body?.rules?.find((r: { type: string }) => r.type === type) ?? null;
/** The `pull_request` rule's parameters of a recorded payload, or null. */
const prParameters = (body: any): any => ruleOfType(body, 'pull_request')?.parameters ?? null;
/**
 * The default `--rules` writes (#143 AC2): the review gate stays off — count
 * 0, and the two stale-approval fields exactly as the fetched ruleset carried
 * them (`false` when there was nothing to fetch) — with squash as the only
 * merge method.
 */
function leavesReviewGateOff(body: any, fetched = { dismiss: false, lastPush: false }): boolean {
  const p = prParameters(body);
  return (
    !!p &&
    p.required_approving_review_count === 0 &&
    p.dismiss_stale_reviews_on_push === fetched.dismiss &&
    p.require_last_push_approval === fetched.lastPush &&
    JSON.stringify(p.allowed_merge_methods) === JSON.stringify(['squash'])
  );
}
/** What `--require-review` adds on top (#143 AC3): the three fields raised together. */
function requiresOneApprovingReview(body: any): boolean {
  const p = prParameters(body);
  return (
    !!p &&
    p.required_approving_review_count === 1 &&
    p.dismiss_stale_reviews_on_push === true &&
    p.require_last_push_approval === true &&
    JSON.stringify(p.allowed_merge_methods) === JSON.stringify(['squash'])
  );
}
/** A state dir seeded with a ruleset list and one detail fixture per entry. */
function rulesState(label: string, entries: Array<Record<string, any>>): string {
  const dir = mkdtempSync(join(tmpdir(), `agentic-init-rules-${label}-`));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  // the live list endpoint answers with summaries; details come per id
  writeFileSync(join(dir, 'rulesets-list.json'), JSON.stringify(entries.map(({ rules, bypass_actors, ...summary }) => summary)));
  for (const entry of entries) writeFileSync(join(dir, `ruleset-${entry.id}.json`), JSON.stringify(entry));
  return dir;
}

const stateRulesEmpty = mkdtempSync(join(tmpdir(), 'agentic-init-rules-empty-'));
cleanup(() => rmSync(stateRulesEmpty, { recursive: true, force: true }));
const rulesEmpty = initWithGh(ghRepo, stateRulesEmpty, '--rules');
check('init --rules (no existing ruleset) exits 0', rulesEmpty.status === 0, `${rulesEmpty.stdout}${rulesEmpty.stderr}`);
check('init --rules creates a ruleset when none governs the default branch', /\+ ruleset created/.test(rulesEmpty.stdout), rulesEmpty.stdout);
check('init --rules POSTs to the rulesets collection', ghLog(stateRulesEmpty).includes('rulesets -X POST'), ghLog(stateRulesEmpty));
const postBody = ruleBody(stateRulesEmpty, 'post');
check('the created ruleset targets the default branch', postBody.conditions.ref_name.include.includes('refs/heads/main'), JSON.stringify(postBody));
check(
  'the created ruleset requires scope, negative-control and the default test check',
  JSON.stringify(ruleOfType(postBody, 'required_status_checks').parameters.required_status_checks) ===
    JSON.stringify([{ context: 'scope' }, { context: 'negative-control' }, { context: 'test' }]),
  JSON.stringify(postBody),
);
check(
  'the created ruleset requires a pull request and blocks force-push and deletion',
  ['pull_request', 'non_fast_forward', 'deletion'].every((t) => postBody.rules.some((r: { type: string }) => r.type === t)),
  JSON.stringify(postBody),
);
check(
  'the created ruleset leaves the review gate off by default and allows squash only',
  leavesReviewGateOff(postBody),
  JSON.stringify(postBody),
);

// The shape this repository's own ruleset really has, read from the live
// API: named after the branch ("main", not "agentic-setup"), its condition
// the ~DEFAULT_BRANCH placeholder rather than refs/heads/main, and carrying
// rules, parameters and bypass actors the installer does not manage. A
// name-based lookup takes the create path here and POSTs a second ruleset
// over the same branch — that is the defect #143 fixes.
const LIVE_ID = 22358260;
const stateRulesLive = rulesState('live', [
  {
    id: LIVE_ID,
    name: 'main',
    target: 'branch',
    source_type: 'Repository',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_last_push_approval: false,
          require_extra_approval_for_unattributed_changes: true,
          allowed_merge_methods: ['squash'],
        },
      },
      { type: 'required_signatures' },
    ],
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    node_id: 'RRS_fixture',
    created_at: '2026-09-05T19:58:40.311-03:00',
    _links: { self: { href: 'https://api.github.invalid/x' } },
  },
]);
const rulesLive = initWithGh(ghRepo, stateRulesLive, '--rules');
check('init --rules against a ruleset named after the branch exits 0', rulesLive.status === 0, `${rulesLive.stdout}${rulesLive.stderr}`);
check(
  'init --rules updates the ruleset that governs the default branch whatever its name',
  ghLog(stateRulesLive).includes(`rulesets/${LIVE_ID} -X PUT`),
  ghLog(stateRulesLive),
);
check(
  'init --rules never POSTs a second ruleset over a branch one already governs',
  !ghLog(stateRulesLive).includes('-X POST') && ruleBody(stateRulesLive, 'post') === null,
  ghLog(stateRulesLive),
);
const liveBody = ruleBody(stateRulesLive, 'put');
check(
  'the update keeps the review gate off: count 0 and the fetched dismiss_stale_reviews_on_push: false left alone',
  leavesReviewGateOff(liveBody),
  JSON.stringify(liveBody),
);
check(
  'the update keeps a pull_request parameter the installer does not set',
  ruleOfType(liveBody, 'pull_request')?.parameters?.require_extra_approval_for_unattributed_changes === true,
  JSON.stringify(liveBody),
);
check('the update carries an unmanaged rule type through unchanged', ruleOfType(liveBody, 'required_signatures') !== null, JSON.stringify(liveBody));
check(
  'the update carries the fetched bypass actors through unchanged',
  JSON.stringify(liveBody?.bypass_actors) === JSON.stringify([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]),
  JSON.stringify(liveBody),
);
check(
  'the update keeps the ruleset own name and condition instead of renaming it',
  liveBody?.name === 'main' && JSON.stringify(liveBody?.conditions?.ref_name?.include) === JSON.stringify(['~DEFAULT_BRANCH']),
  JSON.stringify(liveBody),
);
check(
  'the update sends back none of the read-only fields the detail fetch carries',
  !!liveBody && !('node_id' in liveBody) && !('_links' in liveBody) && !('created_at' in liveBody) && !('source_type' in liveBody),
  JSON.stringify(liveBody),
);

// --- --require-review: the only way --rules raises the review gate (#143
// AC3). Both cases run against the live-shaped fixture, whose fetched
// pull_request rule carries the three fields at 0/false/false — so the flag
// is shown overriding fetched values, not just the installer's own default.
const REVIEW_OPT_IN_RULES = [
  { type: 'deletion' },
  {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: false,
      require_last_push_approval: false,
      require_extra_approval_for_unattributed_changes: true,
      allowed_merge_methods: ['squash'],
    },
  },
];
const FREEZE_WARNING = /! --require-review: AGENTIC_REVIEWER_TOKEN is unset/;

const stateRequireReview = rulesState('require-review', [
  { id: 51, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: REVIEW_OPT_IN_RULES, bypass_actors: [] },
]);
const requireReview = initWithGhEnv(ghRepo, stateRequireReview, {}, '--rules', '--require-review');
check('init --rules --require-review exits 0', requireReview.status === 0, `${requireReview.stdout}${requireReview.stderr}`);
const requireReviewBody = ruleBody(stateRequireReview, 'put');
check(
  'init --rules --require-review raises the count to 1, dismisses stale approvals and requires last-push approval',
  requiresOneApprovingReview(requireReviewBody),
  JSON.stringify(requireReviewBody),
);
check(
  'init --rules --require-review still carries the unmanaged pull_request parameters through',
  prParameters(requireReviewBody)?.require_extra_approval_for_unattributed_changes === true,
  JSON.stringify(requireReviewBody),
);
check(
  'init --rules --require-review with AGENTIC_REVIEWER_TOKEN unset warns that a single identity freezes every merge',
  FREEZE_WARNING.test(requireReview.stdout) && /freez/.test(requireReview.stdout),
  requireReview.stdout,
);

const stateRequireReviewToken = rulesState('require-review-token', [
  { id: 52, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: REVIEW_OPT_IN_RULES, bypass_actors: [] },
]);
const requireReviewToken = initWithGhEnv(ghRepo, stateRequireReviewToken, { AGENTIC_REVIEWER_TOKEN: 'ghp_fixture' }, '--rules', '--require-review');
check('init --rules --require-review (token set) exits 0', requireReviewToken.status === 0, `${requireReviewToken.stdout}${requireReviewToken.stderr}`);
const requireReviewTokenBody = ruleBody(stateRequireReviewToken, 'put');
check(
  'init --rules --require-review writes the same three fields whether or not the token is set',
  requiresOneApprovingReview(requireReviewTokenBody),
  JSON.stringify(requireReviewTokenBody),
);
check(
  'init --rules --require-review with AGENTIC_REVIEWER_TOKEN set prints no freeze warning',
  !FREEZE_WARNING.test(requireReviewToken.stdout),
  requireReviewToken.stdout,
);
check(
  'init --rules --require-review never calls itself ignored',
  !/--require-review ignored/.test(requireReview.stdout) && !/--require-review ignored/.test(requireReviewToken.stdout),
  requireReview.stdout,
);

// Without --rules there is no ruleset call for --require-review to change,
// and --no-gh skips that call entirely: say so rather than accept the flag
// silently and write nothing.
const ignoredNoRules = init('--require-review');
check('init --require-review without --rules exits 0', ignoredNoRules.status === 0, `${ignoredNoRules.stdout}${ignoredNoRules.stderr}`);
check(
  'init --require-review without --rules reports the flag as ignored',
  /! --require-review ignored: it raises the ruleset review gate, which only --rules writes/.test(ignoredNoRules.stdout),
  ignoredNoRules.stdout,
);
const ignoredNoGh = init('--rules', '--require-review');
check('init --no-gh --rules --require-review exits 0', ignoredNoGh.status === 0, `${ignoredNoGh.stdout}${ignoredNoGh.stderr}`);
check(
  'init --rules --require-review under --no-gh reports the flag as ignored',
  /! --require-review ignored: --no-gh skips the ruleset call it would change/.test(ignoredNoGh.stdout),
  ignoredNoGh.stdout,
);

// The default carries the fetched stale-approval fields through as they are:
// a ruleset already dismissing stale approvals keeps doing so, even though
// --require-review was not passed and the count is reset to 0.
const stateRulesCarry = rulesState('carry', [
  {
    id: 71,
    name: 'main',
    target: 'branch',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'pull_request',
        parameters: { required_approving_review_count: 2, dismiss_stale_reviews_on_push: true, require_last_push_approval: true },
      },
    ],
    bypass_actors: [],
  },
]);
const rulesCarry = initWithGh(ghRepo, stateRulesCarry, '--rules');
check('init --rules against a ruleset that dismisses stale approvals exits 0', rulesCarry.status === 0, `${rulesCarry.stdout}${rulesCarry.stderr}`);
const carryBody = ruleBody(stateRulesCarry, 'put');
check(
  'init --rules resets the count to 0 but carries a fetched dismiss_stale_reviews_on_push / require_last_push_approval: true through',
  leavesReviewGateOff(carryBody, { dismiss: true, lastPush: true }),
  JSON.stringify(carryBody),
);

// --- the refusal path of the lookup: a ruleset detail that cannot be read.
// `GET .../rulesets` answers with summaries only, so a failed or unparsable
// `GET .../rulesets/<id>` leaves a ruleset with no conditions — which reads
// exactly like a ruleset governing nothing and would send the run down the
// create path, POSTing a second ruleset over the branch the unreadable one
// already governs (#143 B1 all over again). The run has to refuse instead.
const UNREADABLE = (id: number) => new RegExp(`! ruleset: could not read ruleset #${id}: `);

const stateDetail500 = rulesState('detail-500', [
  { id: 61, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateDetail500, 'ruleset-61-fail'), '');
const detail500 = initWithGh(ghRepo, stateDetail500, '--rules');
check('init --rules exits 0 when a ruleset detail cannot be read', detail500.status === 0, `${detail500.stdout}${detail500.stderr}`);
check(
  'init --rules reports the ruleset whose detail it could not read, with gh first error line',
  UNREADABLE(61).test(detail500.stdout) && /HTTP 500/.test(detail500.stdout),
  detail500.stdout,
);
check(
  'init --rules never reports a ruleset created when a detail fetch failed',
  !/\+ ruleset created/.test(detail500.stdout) && !/= ruleset updated/.test(detail500.stdout),
  detail500.stdout,
);
check(
  'init --rules makes no mutating call when a detail fetch failed',
  !ghLog(stateDetail500).includes('-X POST') &&
    !ghLog(stateDetail500).includes('-X PUT') &&
    ruleBody(stateDetail500, 'post') === null &&
    ruleBody(stateDetail500, 'put') === null,
  ghLog(stateDetail500),
);

// The same refusal when the detail GET succeeds but answers with something
// that is not a ruleset object.
const stateDetailJunk = rulesState('detail-junk', [
  { id: 62, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateDetailJunk, 'ruleset-62.json'), 'not json at all');
const detailJunk = initWithGh(ghRepo, stateDetailJunk, '--rules');
check('init --rules exits 0 when a ruleset detail does not parse', detailJunk.status === 0, `${detailJunk.stdout}${detailJunk.stderr}`);
check(
  'init --rules reports a ruleset detail that is not a ruleset object and creates nothing',
  UNREADABLE(62).test(detailJunk.stdout) && !/\+ ruleset created/.test(detailJunk.stdout),
  detailJunk.stdout,
);
check(
  'init --rules makes no mutating call when a ruleset detail does not parse',
  !ghLog(stateDetailJunk).includes('-X POST') && !ghLog(stateDetailJunk).includes('-X PUT'),
  ghLog(stateDetailJunk),
);

// --dry-run previews the same refusal: no payload, no outcome line.
const stateDetailDry = rulesState('detail-dry', [
  { id: 63, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateDetailDry, 'ruleset-63-fail'), '');
const detailDry = initWithGh(ghRepo, stateDetailDry, '--rules', '--dry-run');
check('init --rules --dry-run exits 0 when a ruleset detail cannot be read', detailDry.status === 0, `${detailDry.stdout}${detailDry.stderr}`);
check(
  'init --rules --dry-run previews the same refusal and no payload',
  UNREADABLE(63).test(detailDry.stdout) && !/payload for /.test(detailDry.stdout) && !/\+ ruleset created/.test(detailDry.stdout),
  detailDry.stdout,
);

// The other spelling of the same condition: a ruleset whose include list
// names refs/heads/<default branch> literally is matched too.
const stateRulesExisting = rulesState('existing', [
  {
    id: 42,
    name: 'agentic-setup',
    target: 'branch',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [],
    bypass_actors: [],
  },
]);
const rulesExisting = initWithGh(ghRepo, stateRulesExisting, '--rules');
check('init --rules (existing ruleset on refs/heads/main) exits 0', rulesExisting.status === 0, `${rulesExisting.stdout}${rulesExisting.stderr}`);
check('init --rules updates the existing ruleset instead of creating one', /= ruleset updated/.test(rulesExisting.stdout), rulesExisting.stdout);
check('init --rules PUTs to the existing ruleset by id', ghLog(stateRulesExisting).includes('rulesets/42 -X PUT'), ghLog(stateRulesExisting));
check('init --rules does not also create a second ruleset', !existsSync(join(stateRulesExisting, 'ruleset-post-body.json')));

// A ruleset that governs some other branch is not ours, whatever it is
// called: only the one over the default branch is updated.
const stateRulesOther = rulesState('other', [
  { id: 8, name: 'agentic-setup', target: 'branch', conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } }, rules: [] },
]);
const rulesOther = initWithGh(ghRepo, stateRulesOther, '--rules');
check('init --rules exits 0 when no ruleset governs the default branch', rulesOther.status === 0, `${rulesOther.stdout}${rulesOther.stderr}`);
check(
  'init --rules leaves a ruleset over another branch alone and creates one',
  !ghLog(stateRulesOther).includes('rulesets/8 -X PUT') && ghLog(stateRulesOther).includes('rulesets -X POST'),
  ghLog(stateRulesOther),
);

// --ruleset-name overrides the choice: the named ruleset is updated even
// though another one governs the default branch.
const stateRulesNamed = rulesState('named', [
  { id: 11, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [] },
  { id: 12, name: 'chosen', target: 'branch', conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } }, rules: [] },
]);
const rulesNamed = initWithGh(ghRepo, stateRulesNamed, '--rules', '--ruleset-name', 'chosen');
check('init --rules --ruleset-name exits 0', rulesNamed.status === 0, `${rulesNamed.stdout}${rulesNamed.stderr}`);
check(
  'init --rules --ruleset-name updates the ruleset it names, not the one matched by condition',
  ghLog(stateRulesNamed).includes('rulesets/12 -X PUT') && !ghLog(stateRulesNamed).includes('rulesets/11 -X PUT'),
  ghLog(stateRulesNamed),
);

// Several rulesets over the same branch: the first is updated, the rest are
// reported and left exactly as they are — never created over.
const stateRulesMany = rulesState('many', [
  { id: 21, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [] },
  { id: 22, name: 'legacy', target: 'branch', conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } }, rules: [] },
]);
const rulesMany = initWithGh(ghRepo, stateRulesMany, '--rules');
check('init --rules with several matching rulesets exits 0', rulesMany.status === 0, `${rulesMany.stdout}${rulesMany.stderr}`);
check('init --rules updates the first matching ruleset', ghLog(stateRulesMany).includes('rulesets/21 -X PUT'), ghLog(stateRulesMany));
check(
  'init --rules reports the other matching rulesets and neither updates nor creates over them',
  /! ruleset: 2 rulesets govern main/.test(rulesMany.stdout) && /"legacy" \(#22\)/.test(rulesMany.stdout) && !ghLog(stateRulesMany).includes('-X POST'),
  `${rulesMany.stdout}\n${ghLog(stateRulesMany)}`,
);

// A tag ruleset shares the endpoint and must never be matched or updated.
const stateRulesTag = rulesState('tag', [
  { id: 31, name: 'tags', target: 'tag', conditions: { ref_name: { include: ['~ALL'], exclude: [] } }, rules: [] },
]);
const rulesTag = initWithGh(ghRepo, stateRulesTag, '--rules');
check(
  'init --rules ignores a ruleset that does not target branches',
  rulesTag.status === 0 && !ghLog(stateRulesTag).includes('rulesets/31 -X PUT') && ghLog(stateRulesTag).includes('rulesets -X POST'),
  ghLog(stateRulesTag),
);

const stateRules403 = mkdtempSync(join(tmpdir(), 'agentic-init-rules-403-'));
cleanup(() => rmSync(stateRules403, { recursive: true, force: true }));
writeFileSync(join(stateRules403, 'rulesets-403'), '');
const rules403 = initWithGh(ghRepo, stateRules403, '--rules');
check('init --rules still exits 0 when the plan forbids rulesets', rules403.status === 0, `${rules403.stdout}${rules403.stderr}`);
check(
  'init --rules reports the free-plan private-repository limit on a 403',
  rules403.stdout.includes('! ruleset: not available on this plan for a private repository'),
  rules403.stdout,
);

const stateRulesDry = mkdtempSync(join(tmpdir(), 'agentic-init-rules-dry-'));
cleanup(() => rmSync(stateRulesDry, { recursive: true, force: true }));
const rulesDry = initWithGh(ghRepo, stateRulesDry, '--rules', '--dry-run');
check('init --rules --dry-run exits 0', rulesDry.status === 0, `${rulesDry.stdout}${rulesDry.stderr}`);
check('init --rules --dry-run reports the same outcome a real run would', /\+ ruleset created/.test(rulesDry.stdout), rulesDry.stdout);
check(
  'init --rules --dry-run reads the rulesets list but never writes one',
  ghLog(stateRulesDry).includes('rulesets') && !ghLog(stateRulesDry).includes('-X POST') && !ghLog(stateRulesDry).includes('-X PUT'),
  ghLog(stateRulesDry),
);
check(
  'init --rules --dry-run prints the payload it would POST',
  /"required_approving_review_count": 0/.test(rulesDry.stdout) && /POST repos\/\{owner\}\/\{repo\}\/rulesets/.test(rulesDry.stdout),
  rulesDry.stdout,
);

// The same preview against a repository that already has the ruleset: the
// payload is the update body, and nothing mutating leaves the process.
const stateRulesDryLive = rulesState('dry-live', [
  {
    id: LIVE_ID,
    name: 'main',
    target: 'branch',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false } }],
    bypass_actors: [],
  },
]);
const rulesDryLive = initWithGh(ghRepo, stateRulesDryLive, '--rules', '--dry-run');
check('init --rules --dry-run against an existing ruleset exits 0', rulesDryLive.status === 0, `${rulesDryLive.stdout}${rulesDryLive.stderr}`);
check('init --rules --dry-run against an existing ruleset reports the update', /= ruleset updated/.test(rulesDryLive.stdout), rulesDryLive.stdout);
check(
  'init --rules --dry-run prints the payload it would PUT and sends nothing',
  new RegExp(`PUT repos/\\{owner\\}/\\{repo\\}/rulesets/${LIVE_ID}`).test(rulesDryLive.stdout) &&
    /"required_approving_review_count": 0/.test(rulesDryLive.stdout) &&
    /"dismiss_stale_reviews_on_push": false/.test(rulesDryLive.stdout),
  rulesDryLive.stdout,
);
check(
  'init --rules --dry-run records zero mutating calls',
  !ghLog(stateRulesDryLive).includes('-X POST') &&
    !ghLog(stateRulesDryLive).includes('-X PUT') &&
    ruleBody(stateRulesDryLive, 'post') === null &&
    ruleBody(stateRulesDryLive, 'put') === null,
  ghLog(stateRulesDryLive),
);

// --- a malformed dictionary refuses the run (#145). The installer reads
// `labels.json` from its own plugin root, so these cases run a copy of that
// root (the same trick tests/codex-plugin.test.mts uses) whose dictionary is
// the broken one. The refusal is checked like a happy path: a named reason
// on stderr, a non-zero exit, and nothing written into the target.
const pluginCopy = mkdtempSync(join(tmpdir(), 'agentic-init-plugin-'));
cleanup(() => rmSync(pluginCopy, { recursive: true, force: true }));
for (const dir of ['templates', 'ci', 'hooks', 'scripts']) cpSync(join(ROOT, dir), join(pluginCopy, dir), { recursive: true });
const realDictionary = existsSync(join(ROOT, 'labels.json')) ? readFileSync(join(ROOT, 'labels.json'), 'utf8') : '';

/** Runs the copied installer, with `text` as its dictionary, in a fresh repository. */
function initFromCopy(text: string) {
  writeFileSync(join(pluginCopy, 'labels.json'), text);
  const target = tempRepo();
  commit(target, { 'README.md': '# x\n' }, 'init');
  const r = spawnSync(RUNTIME, [join(pluginCopy, 'scripts', 'init.mts'), '--no-gh'], { cwd: target, encoding: 'utf8' });
  return { out: `${r.stdout}${r.stderr}`, status: r.status, wrote: existsSync(join(target, '.github')) };
}

const copyOk = initFromCopy(realDictionary);
check('the installer copy, with the real labels.json, still installs', copyOk.status === 0 && copyOk.wrote, copyOk.out);

const ENTRY = '{ "name": "state:ready", "color": "0e8a16", "description": "Ready", "routes": ["claude"] }';
for (const [name, text, reason] of [
  ['unparseable JSON', '{\n', /not valid JSON/],
  ['a dictionary that is not an array', `{ "labels": [${ENTRY}] }`, /must be a JSON array/],
  ['an unknown key', '[{ "name": "state:ready", "colour": "0e8a16", "color": "0e8a16", "description": "Ready", "routes": ["claude"] }]', /unknown key "colour"/],
  ['a missing field', '[{ "name": "state:ready", "color": "0e8a16", "routes": ["claude"] }]', /"description"/],
  ['a duplicate name', `[${ENTRY}, ${ENTRY}]`, /duplicate/],
  ['an unknown route', '[{ "name": "state:ready", "color": "0e8a16", "description": "Ready", "routes": ["gemini"] }]', /unknown route "gemini"/],
  ['an empty dictionary', '[]', /at least one label/],
] as Array<[string, string, RegExp]>) {
  const r = initFromCopy(text);
  check(`init refuses ${name} instead of seeding a partial set`, r.status !== 0 && /labels\.json/.test(r.out) && reason.test(r.out), r.out);
  check(`init refuses ${name} before writing anything into the repository`, !r.wrote, r.out);
}

finish();
