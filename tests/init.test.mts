#!/usr/bin/env node
// Cases for scripts/init.mts: the installer copies templates into a target
// repository, merges settings, and installs an executable pre-push hook.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { check, cleanup, commit, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
commit(repo, { 'README.md': '# x\n' }, 'init');
mkdirSync(join(repo, '.claude'), { recursive: true });
writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf / *)', 'WebFetch'] }, other: true }));
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
// matching marker; `label create` is a no-op. `repo view --json
// defaultBranchRef` (the ruleset's target) always answers "main". Every
// call touching `.../rulesets` (list, POST, PUT) is handled by one case arm
// keyed on the endpoint prefix: a 403 fixture (`$state/rulesets-403`) wins
// over everything; otherwise `-X POST`/`-X PUT` write the request body to
// `$state/ruleset-{post,put}-body.json` and report a canned id, and a plain
// GET echoes `$state/rulesets-list.json` (default `[]`).
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
      cat "$state/rulesets-list.json" 2>/dev/null || echo '[]'
    fi
    ;;
  "repo edit")
    case "$3" in
      --enable-auto-merge) touch "$state/automerge-enabled" ;;
      --delete-branch-on-merge) touch "$state/deletebranch-enabled" ;;
    esac
    ;;
  "label create") exit 0 ;;
  "api") echo "" ;;
  *) exit 0 ;;
esac
`;
const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-init-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

function initWithGh(dir: string, stateDir: string, ...extra: string[]) {
  return spawnSync(RUNTIME, [join(ROOT, 'scripts', 'init.mts'), ...extra], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir },
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

// --- --rules: creates or updates a branch ruleset named "agentic-setup"
// with the checks the merge model depends on (docs/decisions.md item 9(a)).
// `ghRepo` carries no workflow files of its own, so the third required
// check falls back to its default, "test".
check('init without --rules never touches the rulesets endpoint', !/rulesets/.test(ghLog(state1)), ghLog(state1));

const stateRulesEmpty = mkdtempSync(join(tmpdir(), 'agentic-init-rules-empty-'));
cleanup(() => rmSync(stateRulesEmpty, { recursive: true, force: true }));
const rulesEmpty = initWithGh(ghRepo, stateRulesEmpty, '--rules');
check('init --rules (no existing ruleset) exits 0', rulesEmpty.status === 0, `${rulesEmpty.stdout}${rulesEmpty.stderr}`);
check('init --rules creates a ruleset when none named agentic-setup exists', /\+ ruleset created/.test(rulesEmpty.stdout), rulesEmpty.stdout);
check('init --rules POSTs to the rulesets collection', ghLog(stateRulesEmpty).includes('rulesets -X POST'), ghLog(stateRulesEmpty));
const postBody = JSON.parse(readFileSync(join(stateRulesEmpty, 'ruleset-post-body.json'), 'utf8'));
check('the created ruleset targets the default branch', postBody.conditions.ref_name.include.includes('refs/heads/main'), JSON.stringify(postBody));
check(
  'the created ruleset requires scope, negative-control and the default test check',
  JSON.stringify(postBody.rules.find((r: { type: string }) => r.type === 'required_status_checks').parameters.required_status_checks) ===
    JSON.stringify([{ context: 'scope' }, { context: 'negative-control' }, { context: 'test' }]),
  JSON.stringify(postBody),
);
check(
  'the created ruleset requires a pull request and blocks force-push and deletion',
  ['pull_request', 'non_fast_forward', 'deletion'].every((t) => postBody.rules.some((r: { type: string }) => r.type === t)),
  JSON.stringify(postBody),
);

const stateRulesExisting = mkdtempSync(join(tmpdir(), 'agentic-init-rules-existing-'));
cleanup(() => rmSync(stateRulesExisting, { recursive: true, force: true }));
writeFileSync(join(stateRulesExisting, 'rulesets-list.json'), JSON.stringify([{ id: 42, name: 'agentic-setup', target: 'branch' }]));
const rulesExisting = initWithGh(ghRepo, stateRulesExisting, '--rules');
check('init --rules (existing agentic-setup ruleset) exits 0', rulesExisting.status === 0, `${rulesExisting.stdout}${rulesExisting.stderr}`);
check('init --rules updates the existing ruleset instead of creating one', /= ruleset updated/.test(rulesExisting.stdout), rulesExisting.stdout);
check('init --rules PUTs to the existing ruleset by id', ghLog(stateRulesExisting).includes('rulesets/42 -X PUT'), ghLog(stateRulesExisting));
check('init --rules does not also create a second ruleset', !existsSync(join(stateRulesExisting, 'ruleset-post-body.json')));

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

finish();
