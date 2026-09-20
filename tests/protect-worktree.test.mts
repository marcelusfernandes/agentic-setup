#!/usr/bin/env node
// Cases for hooks/protect-worktree.mts: a subagent may not write into the
// main checkout, and the one location that outlives its worktree is named
// rather than merely tolerated. Spawns the real hook against a throwaway
// git repo.
//
// The durable location is Claude Code's own `memory: user` directory,
// `~/.claude/agent-memory/<agent>/`. This file writes that path out itself
// (invariant 10) instead of importing it from the hook: it mirrors the table
// under "memory" in Claude Code's subagent documentation, and a pin that
// imported the constant could not catch the constant drifting away from it.
// `os.homedir()` reads `$HOME` on POSIX, so the cases below hand the hook a
// throwaway home and get a deterministic path to assert on.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, hook, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
commit(repo, { 'a.txt': 'a' }, 'init');
const wt = join(repo, '.worktrees', 'agent-1');
git(['worktree', 'add', '-q', '-b', 'feat/1-x', wt], repo);

const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'agentic-home-')));
cleanup(() => rmSync(home, { recursive: true, force: true }));
/** What `memory: user` resolves to, spelled out rather than imported. */
const userMemory = join(home, '.claude', 'agent-memory');
/** What `memory: project` resolves to under a given root. */
const projectMemory = (root: string) => join(root, '.claude', 'agent-memory');
/** What `memory: local` resolves to under a given root. */
const localMemory = (root: string) => join(root, '.claude', 'agent-memory-local');

const write = (file_path: string, extra: object = {}, cwd: string = wt, env: Record<string, string> = {}) =>
  hook('protect-worktree.mts', { tool_name: 'Write', tool_input: { file_path }, cwd, agent_id: 'agent-1', ...extra }, { cwd, env });

check('protect-worktree denies a subagent writing into the main checkout', write(join(repo, 'a.txt')).status === 2);
check('protect-worktree denies a new file under the main checkout', write(join(repo, 'src', 'new.ts')).status === 2);
check('protect-worktree allows a write inside the worktree', write(join(wt, 'a.txt')).status === 0);
check('protect-worktree allows a relative path (resolved against cwd)', write('b.txt').status === 0);
check('protect-worktree allows scratch files outside both', write(join(tmpdir(), 'scratch.txt')).status === 0);
check('protect-worktree ignores the main session (no agent_id)', hook('protect-worktree.mts', { tool_name: 'Write', tool_input: { file_path: join(repo, 'a.txt') }, cwd: wt }, { cwd: wt }).status === 0);
check('protect-worktree ignores a subagent in the main checkout', write(join(repo, 'a.txt'), {}, repo).status === 0);

// The four destinations of #327, each with its own named outcome.

// 1. Inside the worktree — allowed, and not called durable: project memory
//    under the worktree dies with the worktree, which is the whole finding.
const insideWorktree = write(join(projectMemory(wt), 'implementer', 'MEMORY.md'), {}, wt, { HOME: home });
check('protect-worktree allows project memory inside the worktree', insideWorktree.status === 0);
check('protect-worktree does not call a write inside the worktree durable', !insideWorktree.stderr.includes('durable memory'));

// 2. The durable location — allowed, and named, so the permit is a stated
//    rule rather than the accident of the path lying outside both roots.
const durable = write(join(userMemory, 'implementer', 'MEMORY.md'), {}, wt, { HOME: home });
check('protect-worktree allows a write to the durable memory location', durable.status === 0);
check('protect-worktree names the durable memory location when it allows one', durable.stderr.includes('durable memory') && durable.stderr.includes(userMemory));

// 3. Elsewhere in the main checkout — denied, and the refusal carries the
//    durable location, which is how an agent that only knows its own
//    worktree learns where a durable write goes.
const elsewhere = write(join(repo, 'a.txt'), {}, wt, { HOME: home });
check('protect-worktree still denies an ordinary main-checkout write', elsewhere.status === 2);
check('protect-worktree names the durable memory location in a main-checkout refusal', elsewhere.stderr.includes(userMemory));

// 3b. Agent memory under the main checkout is denied like any other path
//     there, and the refusal names the scope that would have survived.
const mainProjectMemory = write(join(projectMemory(repo), 'implementer', 'MEMORY.md'), {}, wt, { HOME: home });
check('protect-worktree denies project memory under the main checkout', mainProjectMemory.status === 2);
check('protect-worktree names the memory: user scope when it denies project memory', mainProjectMemory.stderr.includes('memory: user'));
const mainLocalMemory = write(join(localMemory(repo), 'implementer', 'MEMORY.md'), {}, wt, { HOME: home });
check('protect-worktree denies local memory under the main checkout', mainLocalMemory.status === 2);
check('protect-worktree names the memory: user scope when it denies local memory', mainLocalMemory.stderr.includes('memory: user'));

// 4. Outside the checkout and not the durable location — still allowed, and
//    still not durable: this hook is a fence, not a sandbox, and a scratch
//    file is not a memory.
const scratch = write(join(tmpdir(), 'scratch.txt'), {}, wt, { HOME: home });
check('protect-worktree allows a scratch file outside both roots', scratch.status === 0);
check('protect-worktree does not call a scratch file durable', !scratch.stderr.includes('durable memory'));

// A home inside the checkout puts the memory root inside the fence. The
// permit must not punch a hole there: it is the checkout this hook exists to
// protect, and a memory there is no more durable than any other file in it.
const insideHome = write(join(projectMemory(repo), 'implementer', 'MEMORY.md'), {}, wt, { HOME: repo });
check('protect-worktree denies the memory root when it resolves inside the main checkout', insideHome.status === 2);

finish();
