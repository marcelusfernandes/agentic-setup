#!/usr/bin/env node
// Cases for hooks/stop-gate.mts: run the detected check/test commands before
// an agent on a work branch stops. Spawns the real hook against a throwaway
// git repo.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, commit, finish, git, hook, ROOT, tempRepo } from './lib/harness.mts';

const hooksJson = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
check('hooks.json registers stop-gate for SubagentStop too', Array.isArray(hooksJson.hooks?.SubagentStop));
check(
  'hooks.json Stop and SubagentStop run the same stop-gate command',
  hooksJson.hooks?.Stop?.[0]?.hooks?.[0]?.command === hooksJson.hooks?.SubagentStop?.[0]?.hooks?.[0]?.command,
);
check(
  'hooks.json Stop and SubagentStop share the same timeout',
  hooksJson.hooks?.Stop?.[0]?.hooks?.[0]?.timeout === hooksJson.hooks?.SubagentStop?.[0]?.hooks?.[0]?.timeout,
);

const repo = tempRepo();
commit(repo, { 'a.txt': 'a' }, 'init');
const stop = (env: Record<string, string> = {}, payload: object = {}) =>
  hook('stop-gate.mts', { hook_event_name: 'Stop', cwd: repo, ...payload }, { cwd: repo, env: { AGENTIC_TEST_CMD: '', AGENTIC_CHECK_CMD: '', ...env } });

check('stop-gate skips on main', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 0);
git(['checkout', '-q', '-b', 'feat/1-x'], repo);
check('stop-gate blocks when the test command fails', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 2);
check('stop-gate passes when the test command passes', stop({ AGENTIC_TEST_CMD: 'exit 0' }).status === 0);
check('stop-gate runs check before test', stop({ AGENTIC_CHECK_CMD: 'exit 1', AGENTIC_TEST_CMD: 'exit 0' }).status === 2);
check('stop-gate skips when a stop hook is already active', stop({ AGENTIC_TEST_CMD: 'exit 1' }, { stop_hook_active: true }).status === 0);
check('stop-gate does not recurse', stop({ AGENTIC_TEST_CMD: 'exit 1', AGENTIC_STOP_GATE_ACTIVE: '1' }).status === 0);
check('stop-gate skips with nothing detectable', stop().status === 0);
commit(repo, { 'b.txt': 'b' }, 'test(red): b must exist');
check('stop-gate skips after a test(red) commit', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 2 ? false : true);
git(['checkout', '-q', '-b', 'feat/2-y'], repo);
commit(repo, { 'package.json': JSON.stringify({ scripts: { test: 'exit 3' } }) }, 'feat: failing suite');
check('stop-gate detects npm test from package.json', stop().status === 2);
git(['checkout', '-q', '-b', 'wip'], repo);
check('stop-gate skips a branch outside <type>/<n>-<slug>', stop({ AGENTIC_TEST_CMD: 'exit 1' }).status === 0);

// SubagentStop: an implementer subagent stopping in its worktree is gated
// the same way as the main session's Stop.
git(['checkout', '-q', '-b', 'fix/3-z'], repo);
check(
  'stop-gate blocks a SubagentStop on a work branch when the test command fails',
  stop({ AGENTIC_TEST_CMD: 'exit 1' }, { hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'implementer' }).status === 2,
);
git(['checkout', '-q', 'main'], repo);
check(
  'stop-gate skips a SubagentStop on main',
  stop({ AGENTIC_TEST_CMD: 'exit 1' }, { hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'implementer' }).status === 0,
);
git(['checkout', '-q', 'fix/3-z'], repo);
check(
  'stop-gate skips a SubagentStop when stop_hook_active',
  stop(
    { AGENTIC_TEST_CMD: 'exit 1' },
    { hook_event_name: 'SubagentStop', agent_id: 'agent-1', agent_type: 'implementer', stop_hook_active: true },
  ).status === 0,
);

finish();
