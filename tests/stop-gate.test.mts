#!/usr/bin/env node
// Cases for hooks/stop-gate.mts: the SubagentStop gate that runs the detected
// check and test commands in the implementer's worktree and blocks the stop
// while they are red. Spawns the real hook against throwaway git repositories
// (invariant 6), never the functions behind it.
//
// Every case clears AGENTIC_STOP_GATE in the child's environment. This repo's
// own gate runs `npm test`, which runs this file, which spawns the hook again:
// without the clear, the inner hook would see the marker its own parent set,
// exit 0 as a nested run, and every "blocks" assertion here would fail.
//
// The commands come from ci/lib/detect.mts. Most cases drive them through its
// documented override path (AGENTIC_TEST_CMD / AGENTIC_CHECK_CMD) so a case is
// one process instead of a package manager; the detection path itself gets its
// own case with a real package.json.
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, commit, finish, git, hook, ROOT, tempRepo } from './lib/harness.mts';

const RED = 'node red.mjs';
const GREEN = 'node green.mjs';
const SCRIPTS = {
  'red.mjs': "console.error('boom-line-from-the-suite');\nprocess.exit(1);\n",
  'green.mjs': "console.log('all green');\n",
};

/** A repo with the two fixture commands, on a work branch with one commit. */
function workRepo(branch = 'feat/1-widget'): string {
  const dir = tempRepo();
  commit(dir, SCRIPTS, 'chore: fixtures');
  git(['checkout', '-q', '-b', branch], dir);
  commit(dir, { 'src.txt': 'work' }, 'feat(x): work');
  return dir;
}

/** Spawns the gate against `cwd`; env overrides are cleared unless given. */
function gate(cwd: string, env: Record<string, string> = {}) {
  return hook(
    'stop-gate.mts',
    { hook_event_name: 'SubagentStop', cwd, agent_id: 'agent-1' },
    { cwd, env: { AGENTIC_STOP_GATE: '', AGENTIC_TEST_CMD: '', AGENTIC_CHECK_CMD: '', ...env } },
  );
}

const red = { AGENTIC_TEST_CMD: RED };
const green = { AGENTIC_TEST_CMD: GREEN };

// --- AC1: red blocks, green passes -----------------------------------------

const redRepo = workRepo();
const blocked = gate(redRepo, red);
check('a red test command blocks the stop', blocked.status === 2, `${blocked.stdout}\n${blocked.stderr}`);
check('the block reason carries the last lines of the failing output', /boom-line-from-the-suite/.test(blocked.stderr), blocked.stderr);
check('the block names the command that failed', /node red\.mjs/.test(blocked.stderr), blocked.stderr);

let decision: any = null;
try {
  decision = JSON.parse(blocked.stdout);
} catch {
  decision = null;
}
check('the stop-blocking decision is `decision: block` with a reason', decision?.decision === 'block' && typeof decision?.reason === 'string' && decision.reason.includes('boom-line-from-the-suite'), blocked.stdout);
check('the stop decision is not a PreToolUse permission decision', decision !== null && decision.hookSpecificOutput === undefined, blocked.stdout);

const greenRepo = workRepo();
const passed = gate(greenRepo, green);
check('a green test command lets the stop through', passed.status === 0, `${passed.stdout}\n${passed.stderr}`);
check('a green run writes no blocking decision', passed.stdout.trim() === '', passed.stdout);

// --- AC1: the check command runs before the test command -------------------

const checkRepo = workRepo();
const checkFirst = gate(checkRepo, { AGENTIC_CHECK_CMD: RED, AGENTIC_TEST_CMD: 'node -e "require(\'node:fs\').writeFileSync(\'test-ran\',\'1\')"' });
check('a failing check command blocks the stop', checkFirst.status === 2, `${checkFirst.stdout}\n${checkFirst.stderr}`);
check('a failing check command stops before the test command runs', !existsSync(join(checkRepo, 'test-ran')), 'the test command ran anyway');

const bothRepo = workRepo();
const bothGreen = gate(bothRepo, { AGENTIC_CHECK_CMD: GREEN, AGENTIC_TEST_CMD: GREEN });
check('a green check and a green test let the stop through', bothGreen.status === 0, `${bothGreen.stdout}\n${bothGreen.stderr}`);

// --- AC1: the four ways the gate does not run ------------------------------

const redCommitRepo = workRepo();
commit(redCommitRepo, { 'tests/new.test.mts': 'red' }, 'test(red): the case that fails first');
const afterRedCommit = gate(redCommitRepo, red);
check('a `test(red):` last commit lets the stop through', afterRedCommit.status === 0, `${afterRedCommit.stdout}\n${afterRedCommit.stderr}`);
check('the `test(red):` exemption says so on stderr', /test\(red\):/.test(afterRedCommit.stderr), afterRedCommit.stderr);

const mainRepo = tempRepo();
commit(mainRepo, SCRIPTS, 'chore: fixtures');
const onMain = gate(mainRepo, red);
check('the default branch is never gated', onMain.status === 0, `${onMain.stdout}\n${onMain.stderr}`);

const bareRepo = tempRepo();
commit(bareRepo, { 'notes.txt': 'no stack markers here' }, 'chore: init');
git(['checkout', '-q', '-b', 'feat/2-none'], bareRepo);
const noCommand = gate(bareRepo);
check('no detected test command lets the stop through', noCommand.status === 0, `${noCommand.stdout}\n${noCommand.stderr}`);
check('no detected test command leaves a note on stderr', /no test command/i.test(noCommand.stderr), noCommand.stderr);

const nestedRepo = workRepo();
const nested = gate(nestedRepo, { ...red, AGENTIC_STOP_GATE: '1' });
check('a nested run does not run the commands again', nested.status === 0, `${nested.stdout}\n${nested.stderr}`);

// --- AC1: the cap of three consecutive blocks ------------------------------

const capRepo = workRepo();
const capRuns = [1, 2, 3, 4].map(() => gate(capRepo, red));
check('the first three consecutive red stops are blocked', capRuns.slice(0, 3).every((r) => r.status === 2), capRuns.map((r) => r.status).join(','));
check('three consecutive blocks is the cap: the fourth red stop passes', capRuns[3].status === 0, `${capRuns[3].stdout}\n${capRuns[3].stderr}`);
check('the capped stop says why it was let through', /cap|three consecutive/i.test(capRuns[3].stderr), capRuns[3].stderr);
check('the cap counts each block for the agent', /block 1 of 3/.test(capRuns[0].stderr) && /block 3 of 3/.test(capRuns[2].stderr), capRuns.map((r) => r.stderr).join('\n'));

const resetRepo = workRepo();
const beforeReset = [gate(resetRepo, red), gate(resetRepo, red)];
const greenBetween = gate(resetRepo, green);
const afterReset = gate(resetRepo, red);
check('two blocks then a green then a red is a block again (the counter resets on green)', beforeReset.every((r) => r.status === 2) && greenBetween.status === 0 && afterReset.status === 2, `${beforeReset.map((r) => r.status).join(',')} | ${greenBetween.status} | ${afterReset.status}`);
check('the counter restarts at one after a green run', /block 1 of 3/.test(afterReset.stderr), afterReset.stderr);

// --- AC1: the proof the branch declares (#136) -----------------------------

const proofRepo = workRepo('feat/3-declared');
commit(proofRepo, { 'proof/declared.json': JSON.stringify({ tests: ['tests/declared.test.mts'], command: RED }) }, 'chore: declare the proof');
const declared = gate(proofRepo, green);
check('a `proof/<slug>.json` command replaces the detected test command', declared.status === 2, `${declared.stdout}\n${declared.stderr}`);
check('the declaration is named on stderr', /proof\/declared\.json/.test(declared.stderr), declared.stderr);

const brokenProofRepo = workRepo('feat/4-broken');
commit(brokenProofRepo, { 'proof/broken.json': '{ not json at all\n' }, 'chore: declare badly');
const brokenProof = gate(brokenProofRepo, green);
check('a broken declaration falls back to the detected command with a note', brokenProof.status === 0 && /broken\.json/.test(brokenProof.stderr), `${brokenProof.stdout}\n${brokenProof.stderr}`);

// --- AC1: detection, detached HEAD, and the paths that are not a worktree --

const detectedRepo = tempRepo();
commit(
  detectedRepo,
  { ...SCRIPTS, 'package.json': JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node red.mjs' } }) },
  'chore: a node project',
);
git(['checkout', '-q', '-b', 'feat/5-detected'], detectedRepo);
const detected = gate(detectedRepo);
check('the detected test command is what runs when nothing overrides it', detected.status === 2, `${detected.stdout}\n${detected.stderr}`);
check('the detected command is named in the block', /npm test/.test(detected.stderr), detected.stderr);

const detachedRepo = workRepo('feat/6-detached');
git(['checkout', '-q', '--detach'], detachedRepo);
const detached = gate(detachedRepo, red);
check('a detached HEAD is still gated', detached.status === 2, `${detached.stdout}\n${detached.stderr}`);

const outside = gate(tmpdir(), red);
check('a cwd outside any git repository lets the stop through', outside.status === 0, `${outside.stdout}\n${outside.stderr}`);

const noPayload = hook('stop-gate.mts', 'not json at all', { cwd: redRepo, env: { AGENTIC_STOP_GATE: '' } });
check('an unreadable payload lets the stop through (crash policy: allow)', noPayload.status === 0, `${noPayload.stdout}\n${noPayload.stderr}`);

// --- AC1: the counter is not a tracked file --------------------------------

const stateRepo = workRepo('feat/7-state');
gate(stateRepo, red);
check('the block counter lives under the git directory, not the worktree', existsSync(join(stateRepo, '.git', 'agentic-stop-gate.json')), 'no state file under .git/');
check('the block counter leaves the working tree clean', git(['status', '--porcelain'], stateRepo) === '', git(['status', '--porcelain'], stateRepo));

// --- AC2: hooks.json wires the gate on both stop events --------------------

const wiring = JSON.parse(readFileSync(join(ROOT, 'hooks', 'hooks.json'), 'utf8'))?.hooks ?? {};
for (const event of ['SubagentStop', 'Stop']) {
  const entries = (wiring[event] ?? []).flatMap((entry: any) => entry?.hooks ?? []);
  check(`hooks.json registers stop-gate.mts on ${event}`, entries.some((h: any) => typeof h?.command === 'string' && h.command.includes('hooks/stop-gate.mts')), JSON.stringify(wiring[event]));
  check(`the ${event} entry allows longer than one command run`, entries.every((h: any) => Number(h?.timeout) >= 900), JSON.stringify(wiring[event]));
}

finish();
