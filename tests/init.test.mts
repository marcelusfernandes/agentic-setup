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

// --- gh section: labels no longer seed state:done; auto-merge gets enabled -
// A fake `gh` on PATH: `auth status` always succeeds, `repo view` reports
// autoMergeAllowed from a state-dir marker (so the second run of the same
// scenario sees it as already enabled), `repo edit --enable-auto-merge`
// creates that marker, `label create` and the milestone lookup are no-ops.
const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"
case "\${1:-} \${2:-}" in
  "auth status") exit 0 ;;
  "repo view")
    if [ -f "$state/automerge-enabled" ]; then echo '{"autoMergeAllowed":true}'; else echo '{"autoMergeAllowed":false}'; fi
    ;;
  "repo edit") touch "$state/automerge-enabled" ;;
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
check('init (gh, auto-merge disabled) exits 0', gh1.status === 0, `${gh1.stdout}${gh1.stderr}`);
check('init enables auto-merge and reports it', /\+ auto-merge enabled/.test(gh1.stdout) && /repo edit --enable-auto-merge/.test(ghLog(state1)), gh1.stdout);
check('init no longer seeds state:done', !/label create state:done\b/.test(ghLog(state1)), ghLog(state1));
check('init still seeds other state labels', /label create state:ready\b/.test(ghLog(state1)), ghLog(state1));

const gh2 = initWithGh(ghRepo, state1); // same state dir: repo view now reports autoMergeAllowed: true
check('init rerun (auto-merge already enabled) exits 0', gh2.status === 0, `${gh2.stdout}${gh2.stderr}`);
check('init rerun reports auto-merge already enabled and does not call repo edit again', /= auto-merge already enabled/.test(gh2.stdout), gh2.stdout);
check('init rerun did not call gh repo edit a second time', (ghLog(state1).match(/repo edit --enable-auto-merge/g) ?? []).length === 1, ghLog(state1));

const state2 = mkdtempSync(join(tmpdir(), 'agentic-init-ghstate-dry-'));
cleanup(() => rmSync(state2, { recursive: true, force: true }));
const ghDry = initWithGh(ghRepo, state2, '--dry-run');
check('init --dry-run (with gh) exits 0', ghDry.status === 0, `${ghDry.stdout}${ghDry.stderr}`);
check('init --dry-run reports it would enable auto-merge', /\+ auto-merge enabled/.test(ghDry.stdout), ghDry.stdout);
check('init --dry-run never actually calls gh repo edit', !/repo edit/.test(ghLog(state2)), ghLog(state2));

finish();
