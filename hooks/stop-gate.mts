#!/usr/bin/env node
// stop-gate — Stop, SubagentStop.
//
// Before an agent on a work branch is allowed to stop, run the project's
// check and test commands (ci/lib/detect.mts; AGENTIC_CHECK_CMD /
// AGENTIC_TEST_CMD override). Red output goes to stderr and the stop is
// blocked (exit 2), so the agent reads the failure and keeps working.
// Registered under both events: Stop fires for the main session, and
// SubagentStop fires for an implementer subagent stopping in its own
// worktree (`cwd` is the subagent's worktree in that payload); both are
// handled identically here — same skip rules, same crash policy.
//
// Skips, with a note on stderr, when:
//   - Claude Code says a stop hook is already active (no loops);
//   - the current branch is main/master or not `<type>/<n>-<slug>` — the
//     orchestrator, or a person, is not gated;
//   - the last commit is `test(red): …` — that red is the negative control;
//   - no test command can be detected — the real gate is CI.
//
// Crash policy: ALLOW. A hook that cannot run must not trap the agent.
import { currentBranch, lastCommitSubject, note, parsePayload, readStdin, repoRoot, run } from './lib/common.mts';
import { detectCommands } from '../ci/lib/detect.mts';

const HOOK = 'stop-gate';
const WORK_BRANCH = /^[a-z]+\/\d+-[a-z0-9-]+$/;
const PROTECTED = /^(?:main|master)$/;
const TAIL_LINES = 60;
const REENTRY = 'AGENTIC_STOP_GATE_ACTIVE';

const tail = (text: string): string => text.trim().split('\n').slice(-TAIL_LINES).join('\n');

function sh(command: string, cwd: string) {
  const env = { ...process.env, [REENTRY]: '1' };
  const r = run(command, [], { cwd, shell: true, env });
  return { ok: r.ok, output: `${r.stdout}${r.stderr}` };
}

async function main() {
  const payload = parsePayload(await readStdin()) ?? {};
  const eventName = typeof payload.hook_event_name === 'string' ? payload.hook_event_name : 'Stop';
  const agentSuffix = typeof payload.agent_type === 'string' ? `, agent_type "${payload.agent_type}"` : '';
  const evNote = (message: string) => note(HOOK, `[${eventName}${agentSuffix}] ${message}`);

  if (payload.stop_hook_active) return;
  if (process.env[REENTRY] === '1') {
    evNote('already running further up the process tree; not recursing.');
    return;
  }
  const cwd = payload.cwd || process.cwd();
  const root = repoRoot(cwd);
  const branch = currentBranch(root);

  if (PROTECTED.test(branch) || !WORK_BRANCH.test(branch)) {
    evNote(`branch "${branch || '(none)'}" is not a work branch; skipping.`);
    return;
  }
  if (lastCommitSubject(root).startsWith('test(red):')) {
    evNote('last commit is `test(red):` — that is the negative control; skipping.');
    return;
  }

  const commands = detectCommands(root);
  if (!commands.test && !commands.check) {
    evNote('no check or test command detected (set AGENTIC_TEST_CMD to declare one); skipping — CI is the gate.');
    return;
  }

  const steps: [string, string | null][] = [['check', commands.check], ['test', commands.test]];
  for (const [kind, command] of steps) {
    if (!command) continue;
    const r = sh(command, root);
    if (!r.ok) {
      process.stderr.write(`[agentic-setup/${HOOK}] ${kind} failed: \`${command}\` (${commands.source})\n${tail(r.output)}\n`);
      process.exit(2);
    }
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the stop: ${err?.message ?? err}`);
  process.exit(0);
});
