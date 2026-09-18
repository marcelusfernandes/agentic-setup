#!/usr/bin/env node
// Cases for scripts/init.mts: the installer copies templates into a target
// repository, merges settings, and installs an executable pre-push hook.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { check, cleanup, commit, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';
import { ghLog, initWithGh } from './lib/init-gh.mts';

const repo = tempRepo();
commit(repo, { 'README.md': '# x\n' }, 'init');
mkdirSync(join(repo, '.claude'), { recursive: true });
writeFileSync(join(repo, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(rm -rf / *)', 'WebFetch', 'Bash(gh pr merge *--admin*)', 'toString', 'constructor'] }, other: true }));
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
const mergeRules = settings.permissions.deny.filter((d: unknown) => typeof d === 'string' && d.includes('gh pr merge'));
check('init replaces the stale --admin-only merge rule with the current one', mergeRules.length === 1 && mergeRules[0] === 'Bash(gh pr merge *)', JSON.stringify(mergeRules));
check('init leaves a rule it never seeded untouched', settings.permissions.deny.includes('WebFetch'));
// #204: the seeded set is matched by own property, never by prototype — a deny
// rule spelled `toString` or `constructor` is the adopter's, not the installer's.
check(
  'init keeps a deny rule named like an Object prototype key',
  ['toString', 'constructor'].every((rule) => settings.permissions.deny.includes(rule)) && settings.permissions.deny.every((rule: unknown) => typeof rule === 'string'),
  JSON.stringify(settings.permissions.deny),
);

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
// The fake `gh` these runs go through, and the helpers that drive it, are
// `tests/lib/init-gh.mts` — one fake, shared with tests/init-rules.test.mts
// (#229). Its header states the contract it mocks.

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
// The `type:docs` description is the one label text a reader acts on, and it
// was stale: since #135 the label never skips the negative control — that skip
// is by path class — and its one live effect is the review exemption
// (`scripts/land.mts:230`). Pinned literally, not through the dictionary the
// check above already compares against, so the wording itself is held.
check('init seeds type:docs with a description that claims only the review exemption',
  /label create type:docs --color 0075ca --description Docs only: merges with no reviewer; negative-control skips by path class, not by this label/
    .test(ghLog(state1)),
  ghLog(state1));

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

// #261: a default branch that is neither main nor master earns one line in the
// report; main and master print nothing new, and the read that finds it happens
// under --dry-run too. `$state/default-branch` is what the fake gh's
// `repo view --json defaultBranchRef` answers with.
const oddBranchLine = (b: string) => `  ! default branch is "${b}", not main or master: the installed workflow templates and hooks/protect-main.mts are written around main/master`;
for (const [branch, named, mode] of [['claude/x', true, '--dry-run'], ['claude/x', true, ''], ['main', false, '--dry-run'], ['master', false, '--dry-run']] as Array<[string, boolean, string]>) {
  const st = mkdtempSync(join(tmpdir(), 'agentic-init-defaultbranch-'));
  cleanup(() => rmSync(st, { recursive: true, force: true }));
  writeFileSync(join(st, 'default-branch'), branch);
  const r = initWithGh(ghRepo, st, ...(mode ? [mode] : []));
  check(`init ${mode || '(real run)'} ${named ? 'names' : 'says nothing about'} a "${branch}" default branch`, r.status === 0 && r.stdout.includes(oddBranchLine(branch)) === named, r.stdout);
}

// Without --rules the installer must not even look at the rulesets endpoint.
check('init without --rules never touches the rulesets endpoint', !/rulesets/.test(ghLog(state1)), ghLog(state1));


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
