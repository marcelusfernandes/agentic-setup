#!/usr/bin/env node
// stop-gate — SubagentStop (and Stop, where the same rules make it a no-op).
//
// An implementer that stops with a red suite used to find out from the `test`
// check on its pull request: a full CI round plus a reviewer for a defect the
// worktree could have shown in seconds. This hook runs the project's own check
// and test commands in the worktree the agent is stopping from, and blocks the
// stop while they are red.
//
// It is not a second CI, and it is bounded on four sides:
//   1. the trunk (`main`/`master`) is never gated — which is what makes the
//      same hook a no-op when it fires on `Stop` in the main session;
//   2. a last commit whose subject starts with `test(red):` is exempt: that
//      red is the point of the commit (`docs/workflow.md`, safe-worktree §B7);
//   3. with no test command detected there is nothing to run, and the hook
//      says so on stderr rather than inventing one — detection is a default,
//      never a contract (AGENTS.md invariant 4), and the commands come from
//      `ci/lib/detect.mts`, the same file `negative-control` uses, so "the
//      tests" means one thing in both places;
//   4. after MAX_BLOCKS consecutive blocks in the same worktree the stop is
//      let through with a note. An agent that cannot get to green in three
//      rounds needs the reviewer, not a fourth identical block.
// A branch that declares its proof (`proof/<slug>.json`, #136) has its
// `command` run in place of the detected test command, so the gate and the
// negative control agree on what proves the branch.
//
// The commands run with AGENTIC_STOP_GATE=1 in their environment: this
// repository's own suite spawns this hook, and without the marker the gate
// would recurse into itself.
//
// The block is a top-level `{ decision: 'block', reason }` (`blockStop` in
// lib/common.mts), not `continue`/`stopReason`: `continue: false` ends the
// turn, while a gate wants the agent sent back to work.
//
// The consecutive-block counter lives in the worktree's own git directory
// (`.git/worktrees/<name>/` for a linked worktree), never in a tracked file:
// it is per-worktree state, and a counter in the tree would show up in the
// diff the agent is about to push. It resets three ways: on a green run, on a
// change of branch in the same worktree, and on the cap pass itself — so the
// gate is live again for the agent's next turn rather than switched off for
// the rest of the branch.
//
// What it judges is the payload's `cwd`, which is the agent's worktree only
// when the agent was spawned with `isolation: "worktree"` or the session's own
// cwd is the worktree. A subagent that merely `cd`s into a worktree is judged
// on the session's checkout, and on the trunk that means no gate at all —
// measured, three headless runs, #137 (comment 5715271545).
//
// Crash policy: ALLOW. An unreadable payload, a git command that cannot
// answer, a counter that cannot be read or written, a command that times out
// or cannot be spawned — every one of them lets the stop through with a note
// on stderr. A gate that cannot judge must not hold the agent: CI is still
// behind it, and an unwritable counter would otherwise mean the cap never
// fires.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blockStop, currentBranch, git, note, parsePayload, readStdin, run } from './lib/common.mts';
import { detectCommands } from '../ci/lib/detect.mts';

const HOOK = 'stop-gate';
/** Set in every command's environment; the hook exits 0 when it sees it. */
const NESTED = 'AGENTIC_STOP_GATE';
const STATE_FILE = 'agentic-stop-gate.json';
const MAX_BLOCKS = 3;
/** Per command. Twice this, plus the git calls, stays under the hook's own
 *  900-second timeout in `hooks.json`. */
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const REASON_LINES = 25;
const REASON_CHARS = 4000;
const TRUNK = /^(?:main|master)$/;
const SLUG = /^[^/]+\/\d+-([a-z0-9-]+)$/;

type State = { blocks: number; branch: string };

/** The last REASON_LINES lines of `text`, capped at REASON_CHARS. */
function tail(text: string): string {
  const lines = text.trim().split('\n').slice(-REASON_LINES).join('\n');
  return lines.length > REASON_CHARS ? `…${lines.slice(-REASON_CHARS)}` : lines;
}

/** The `<slug>` of a `<type>/<n>-<slug>` branch, or `null` for any other shape. */
function branchSlug(branch: string): string | null {
  const m = branch.match(SLUG);
  return m ? m[1] : null;
}

/**
 * The test command `proof/<slug>.json` declares, read from the working tree
 * (the file may not be committed yet when the agent stops). A declaration
 * that does not parse, or that names no usable `command`, falls back to the
 * detected command with a note — unlike `negative-control`, which refuses:
 * there the declaration decides what is overlaid, here it only renames a
 * command the hook would otherwise have found itself.
 */
function declaredCommand(root: string, branch: string): { path: string; command: string } | null {
  const slug = branchSlug(branch);
  if (!slug) return null;
  const path = `proof/${slug}.json`;
  const absolute = join(root, path);
  if (!existsSync(absolute)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(absolute, 'utf8'));
  } catch (error) {
    note(HOOK, `\`${path}\` does not parse (${error instanceof Error ? error.message : String(error)}); using the detected command instead.`);
    return null;
  }
  const command = (parsed as Record<string, unknown> | null)?.command;
  if (typeof command !== 'string' || command.trim() === '') {
    note(HOOK, `\`${path}\` names no \`"command"\`; using the detected command instead.`);
    return null;
  }
  return { path, command: command.trim() };
}

/** The worktree's own git directory, or `null` when git cannot answer. */
function gitDir(root: string): string | null {
  const r = git(['rev-parse', '--absolute-git-dir'], root);
  return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The counter as it stands, reset to zero when it is for another branch. */
function readState(file: string, branch: string): State {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    const blocks = Number(parsed?.blocks);
    if (!Number.isInteger(blocks) || blocks < 0 || parsed?.branch !== branch) return { blocks: 0, branch };
    return { blocks, branch };
  } catch {
    return { blocks: 0, branch };
  }
}

/** Persists the counter; `false` when it could not be written. */
function writeState(file: string, state: State): boolean {
  try {
    writeFileSync(file, `${JSON.stringify({ ...state, updated: new Date().toISOString() })}\n`);
    return true;
  } catch {
    return false;
  }
}

type Ran = { ok: boolean; output: string; unusable: string | null };

/** Runs one shell command in the worktree. Never throws. */
function runCommand(command: string, root: string): Ran {
  const r = run(command, [], {
    cwd: root,
    shell: true,
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT,
    env: { ...process.env, [NESTED]: '1' },
  });
  const output = `${r.stdout}${r.stderr}`;
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  const unusable = code === 'ETIMEDOUT'
    ? `it did not finish within ${RUN_TIMEOUT_MS / 60000} minutes`
    : r.error
      ? `it could not be spawned (${r.error.message})`
      : r.status === 127
        ? 'the command was not found'
        : null;
  return { ok: r.ok, output, unusable };
}

async function main() {
  const payload = parsePayload(await readStdin());
  if (!payload) {
    note(HOOK, 'the payload is not JSON; letting the stop through.');
    return;
  }
  if (process.env[NESTED] === '1') return; // a command this gate itself spawned

  const cwd = String(payload.cwd || process.cwd());
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok || !top.stdout.trim()) {
    note(HOOK, `\`${cwd}\` is not inside a git worktree (git could not name a top level), so there is no project to run; letting the stop through.`);
    return;
  }
  const root = top.stdout.trim();

  const branch = currentBranch(root);
  if (TRUNK.test(branch)) return; // the trunk is never gated; this is the Stop no-op

  const subject = git(['log', '-1', '--format=%s'], root);
  if (subject.ok && subject.stdout.trim().startsWith('test(red):')) {
    note(HOOK, 'the last commit is a `test(red):` — a red suite is what it commits; letting the stop through.');
    return;
  }

  const declaration = declaredCommand(root, branch);
  const detected = detectCommands(root);
  const testCommand = declaration?.command ?? detected.test;
  if (!testCommand) {
    note(HOOK, `no test command detected for this project (stack: ${detected.stack}); letting the stop through. Set AGENTIC_TEST_CMD, or name the command in \`proof/<slug>.json\`, to gate it.`);
    return;
  }
  if (declaration) note(HOOK, `\`${declaration.path}\` declares this branch's test command: \`${declaration.command}\`.`);

  const dir = gitDir(root);
  if (!dir) {
    note(HOOK, 'git cannot name this worktree\'s git directory, so the block counter has nowhere to live; letting the stop through.');
    return;
  }
  const stateFile = join(dir, STATE_FILE);
  const state = readState(stateFile, branch);
  if (state.blocks >= MAX_BLOCKS) {
    // Third reset: the cap pass clears the counter, so the gate is live again
    // for the agent's next turn instead of being off for the rest of the
    // branch. It never holds the same turn, because this stop goes through.
    writeState(stateFile, { blocks: 0, branch });
    note(HOOK, `already blocked ${state.blocks} times on this branch — ${MAX_BLOCKS} consecutive blocks is the cap, so this stop goes through with the suite unproven. Say so in the pull request: the reviewer and CI are what is left.`);
    return;
  }

  const stages: Array<{ label: string; command: string }> = [];
  if (detected.check) stages.push({ label: 'check', command: detected.check });
  stages.push({ label: 'test', command: testCommand });

  for (const stage of stages) {
    const result = runCommand(stage.command, root);
    if (result.unusable) {
      note(HOOK, `the ${stage.label} command \`${stage.command}\` could not be judged: ${result.unusable}. Letting the stop through.`);
      return;
    }
    if (result.ok) continue;
    const blocks = state.blocks + 1;
    const stored = writeState(stateFile, { blocks, branch });
    const counter = stored
      ? `This is block ${blocks} of ${MAX_BLOCKS}; after ${MAX_BLOCKS} the stop goes through and CI becomes the gate again.`
      : `The block counter could not be written (${stateFile}), so this block does not count towards the cap of ${MAX_BLOCKS}.`;
    blockStop(
      HOOK,
      `the ${stage.label} command \`${stage.command}\` is red in ${root}. Fix it, or commit the failing test as \`test(red): …\` if the red is the point. ${counter}\nLast lines:\n${tail(result.output)}`,
    );
  }

  writeState(stateFile, { blocks: 0, branch });
  note(HOOK, `green: ${stages.map((s) => `\`${s.command}\``).join(' then ')}.`);
}

main().catch((err) => {
  note(HOOK, `hook error, letting the stop through: ${err?.message ?? err}`);
  process.exit(0);
});
