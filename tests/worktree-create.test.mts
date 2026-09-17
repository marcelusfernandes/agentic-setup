#!/usr/bin/env node
// Cases for hooks/worktree-create.mts: the WorktreeCreate hook that creates an agent's
// worktree outside the main checkout (#129 L10/L11, L13) — a detached worktree under
// `${AGENTIC_WORKTREE_DIR}/<name>`, `node_modules` linked when the checkout has one, the
// path printed on stdout. Spawns the real hook against a throwaway git repo, always
// redirecting AGENTIC_WORKTREE_DIR to a temp directory so a run never touches the real
// default location (`<tmpdir>/agentic-worktrees`). One case reads this repository's own
// `.gitignore` instead of the hook: the `node_modules` the hook symlinks must stay ignored
// in both shapes (symlink and directory) for the knob's in-repository settings (#234).
import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, check, cleanup, commit, finish, git, hook, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
commit(repo, { 'a.txt': 'a' }, 'init');
const repoHead = git(['rev-parse', 'HEAD'], repo);

const worktreeDir = mkdtempSync(join(tmpdir(), 'agentic-wt-test-'));
cleanup(() => rmSync(worktreeDir, { recursive: true, force: true }));

const create = (payload: object, env: Record<string, string> = {}) =>
  hook('worktree-create.mts', payload, { cwd: repo, env: { AGENTIC_WORKTREE_DIR: worktreeDir, ...env } });

// AC: reads the payload's `name`, creates a detached worktree outside the main checkout,
// prints the path.
const dir1 = join(worktreeDir, 'agent-1');
const r1 = create({ name: 'agent-1', cwd: repo });
check('worktree-create exits 0 on a real repository', r1.status === 0, r1.stderr);
check('worktree-create prints the worktree path on stdout', r1.stdout === dir1, r1.stdout);
check('worktree-create creates the directory', existsSync(dir1));
check('worktree-create places the worktree outside the main checkout', !dir1.startsWith(repo));

// AC: the detached HEAD.
check(
  'worktree-create leaves the new worktree on a detached HEAD',
  git(['rev-parse', '--abbrev-ref', 'HEAD'], dir1) === 'HEAD',
);
check('worktree-create checks out the same commit as the source repo', git(['rev-parse', 'HEAD'], dir1) === repoHead);

// AC: links node_modules when present.
mkdirSync(join(repo, 'node_modules'), { recursive: true });
writeFileSync(join(repo, 'node_modules', 'marker.txt'), 'x');
const dir2 = join(worktreeDir, 'agent-2');
const r2 = create({ name: 'agent-2', cwd: repo });
check('worktree-create exits 0 when the repo has node_modules', r2.status === 0, r2.stderr);
check(
  'worktree-create symlinks node_modules into the new worktree',
  existsSync(join(dir2, 'node_modules')) && lstatSync(join(dir2, 'node_modules')).isSymbolicLink(),
);

// AC (#234): this repository's own `.gitignore` ignores that `node_modules` in BOTH shapes
// — the symlink the hook creates and the ordinary directory an install leaves. The worktree
// normally sits outside the checkout, but `AGENTIC_WORKTREE_DIR` is a knob and Claude Code's
// own default when this hook is not loaded (`.claude/worktrees/agent-<id>`) is inside it. A
// pattern ending in `/` matches directories only, and git reports a symlink as a file, so an
// in-repository worktree would otherwise leave an untracked `node_modules` entry that `git
// status --porcelain` prints — the exact signal `deadWorktreeWork` in `scripts/reconcile.mts`
// reads to call a worktree dirty, and one `git add -A` away from being committed as a link.
//
// The fixture carries this repository's real `.gitignore`, so the case goes red the moment
// the rule stops covering either shape.
const ignoreRepo = tempRepo();
// Local config beats the user's global one: a machine-level `core.excludesFile` that happens
// to ignore `node_modules` must not decide this case.
git(['config', 'core.excludesFile', '/dev/null'], ignoreRepo);
commit(ignoreRepo, { '.gitignore': readFileSync(join(ROOT, '.gitignore'), 'utf8') }, 'carry the repository .gitignore');

/** `git check-ignore` without throwing: exit 0 means the path is ignored. */
const checkIgnore = (path: string) =>
  spawnSync('git', ['check-ignore', '-q', path], { cwd: ignoreRepo, encoding: 'utf8' }).status === 0;
const porcelain = () => git(['status', '--porcelain'], ignoreRepo);

// The symlink shape: what hooks/worktree-create.mts creates, pointing at a real directory
// outside the fixture exactly as the hook points at the main checkout's node_modules.
symlinkSync(worktreeDir, join(ignoreRepo, 'node_modules'), 'dir');
check(
  "the repository's .gitignore ignores a node_modules symlink",
  checkIgnore('node_modules'),
  'git check-ignore does not claim the symlink — a pattern ending in `/` matches directories only',
);
check(
  'a node_modules symlink leaves the working tree clean for `git status --porcelain`',
  porcelain() === '',
  `git status --porcelain printed: ${porcelain()}`,
);

// The directory shape: an ordinary install, which must stay ignored too.
unlinkSync(join(ignoreRepo, 'node_modules'));
mkdirSync(join(ignoreRepo, 'node_modules'), { recursive: true });
writeFileSync(join(ignoreRepo, 'node_modules', 'marker.txt'), 'x');
check("the repository's .gitignore ignores a node_modules directory", checkIgnore('node_modules/marker.txt'));
check(
  'a node_modules directory leaves the working tree clean for `git status --porcelain`',
  porcelain() === '',
  `git status --porcelain printed: ${porcelain()}`,
);

// AC: the failure mode on a missing repository — fails closed, nothing printed.
const missing = join(worktreeDir, 'does-not-exist');
const r3 = create({ name: 'agent-3', cwd: missing });
check('worktree-create fails on a missing repository', r3.status !== 0, `status=${r3.status}`);
check('worktree-create prints nothing on stdout when it fails', r3.stdout === '', r3.stdout);
check('worktree-create explains the failure on stderr', r3.stderr.length > 0);
check('worktree-create does not create a directory for the missing repository', !existsSync(join(worktreeDir, 'agent-3')));

// Defaults the name to "agent" when the payload carries none.
const r4 = create({ cwd: repo });
check('worktree-create defaults the name to "agent"', r4.stdout === join(worktreeDir, 'agent'), r4.stdout);

// Refuses a path-traversal name rather than escaping AGENTIC_WORKTREE_DIR.
const r5 = create({ name: '../escape', cwd: repo });
check('worktree-create refuses a path-traversal name', r5.status !== 0 && r5.stdout === '', r5.stdout);

// Refuses to reuse an existing path rather than guessing what to do with it.
mkdirSync(join(worktreeDir, 'agent-dup'));
const r6 = create({ name: 'agent-dup', cwd: repo });
check('worktree-create refuses an already-occupied path', r6.status !== 0 && r6.stdout === '', r6.stdout);

// Fails closed (not open, unlike the PreToolUse hooks) on an unreadable payload — there is
// no later layer to catch a bogus or missing worktree once this hook is registered.
const r7 = hook('worktree-create.mts', '{not json', { cwd: repo, env: { AGENTIC_WORKTREE_DIR: worktreeDir } });
check('worktree-create fails closed on an unreadable payload', r7.status !== 0 && r7.stdout === '', r7.stdout);

finish();
