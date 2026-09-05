#!/usr/bin/env node
// Cases for hooks/protect-worktree.mts: a subagent may not write into the
// main checkout. Spawns the real hook against a throwaway git repo.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, commit, finish, git, hook, tempRepo } from './lib/harness.mts';

const repo = tempRepo();
commit(repo, { 'a.txt': 'a' }, 'init');
const wt = join(repo, '.worktrees', 'agent-1');
git(['worktree', 'add', '-q', '-b', 'feat/1-x', wt], repo);
const write = (file_path: string, extra: object = {}, cwd: string = wt) =>
  hook('protect-worktree.mts', { tool_name: 'Write', tool_input: { file_path }, cwd, agent_id: 'agent-1', ...extra }, { cwd });

check('protect-worktree denies a subagent writing into the main checkout', write(join(repo, 'a.txt')).status === 2);
check('protect-worktree denies a new file under the main checkout', write(join(repo, 'src', 'new.ts')).status === 2);
check('protect-worktree allows a write inside the worktree', write(join(wt, 'a.txt')).status === 0);
check('protect-worktree allows a relative path (resolved against cwd)', write('b.txt').status === 0);
check('protect-worktree allows scratch files outside both', write(join(tmpdir(), 'scratch.txt')).status === 0);
check('protect-worktree ignores the main session (no agent_id)', hook('protect-worktree.mts', { tool_name: 'Write', tool_input: { file_path: join(repo, 'a.txt') }, cwd: wt }, { cwd: wt }).status === 0);
check('protect-worktree ignores a subagent in the main checkout', write(join(repo, 'a.txt'), {}, repo).status === 0);

finish();
