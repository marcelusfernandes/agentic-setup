#!/usr/bin/env node
// protect-worktree — PreToolUse (Edit|Write|MultiEdit).
//
// A subagent running in its own worktree sometimes writes with an absolute
// path rooted at the MAIN checkout instead of the worktree. The prose rule
// ("only edit inside your worktree") is skipped under load, so this enforces
// it: when the payload carries an agent_id and the file resolves inside the
// main repository but outside the current worktree, the write is denied.
//
// Everything else is allowed — scratch directories, the user's own files,
// the main session editing its own checkout. This is a fence around one
// failure mode, not a sandbox.
//
// One of the things outside the checkout is named rather than merely
// tolerated: the durable memory location (#327). An agent's memory goes
// wherever the `memory:` line of its card sends it, and Claude Code fixes
// those three destinations — `user` at `~/.claude/agent-memory/<agent>/`,
// `project` at `<project>/.claude/agent-memory/<agent>/`, `local` at
// `<project>/.claude/agent-memory-local/<agent>/`. Only the first lies
// outside every checkout, so only the first survives a worktree removal, and
// the scope is written in the card the agent cannot reach — this hook denies
// the write that would change it. So the hook says which one it is: it notes
// the permit when a write lands under the `user` directory, and every
// main-checkout refusal carries that path, which is how an agent that knows
// only its own worktree learns where a durable write goes. The permit is
// withheld when that directory resolves inside the checkout (a `$HOME` that
// contains it), because a hole in this fence is worth more than a memory.
//
// Crash policy: ALLOW. Unchanged by the above: the memory paths are derived
// from `os.homedir()` and the roots git already reported, nothing is read
// from disk that was not read before, and any throw still allows the write.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { deny, git, note, parsePayload, readStdin } from './lib/common.mts';

const HOOK = 'protect-worktree';

/** `memory: user` — the one memory scope that is outside every checkout. */
const userMemory = (): string => join(homedir(), '.claude', 'agent-memory');

/** `memory: project` and `memory: local`, relative to a project root. */
const PROJECT_MEMORY = [join('.claude', 'agent-memory'), join('.claude', 'agent-memory-local')];

/**
 * Real path of `p`, resolving symlinks through the deepest ancestor that
 * exists (the file itself may not exist yet). `/var/...` and
 * `/private/var/...` must compare equal on macOS.
 */
function realish(p: string): string {
  let existing = p;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const rest = relative(existing, p);
  try {
    return rest ? join(realpathSync.native(existing), rest) : realpathSync.native(existing);
  } catch {
    return p;
  }
}

const isInside = (parent: string, child: string): boolean => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

async function main() {
  const payload = parsePayload(await readStdin());
  if (!payload || !payload.agent_id) return;
  const filePath = payload.tool_input?.file_path;
  if (!filePath) return;
  const cwd = payload.cwd || process.cwd();

  const top = git(['rev-parse', '--show-toplevel'], cwd);
  const common = git(['rev-parse', '--git-common-dir'], cwd);
  if (!top.ok || !common.ok) return;
  const worktreeRoot = realish(top.stdout.trim());
  const mainRoot = realish(resolve(cwd, common.stdout.trim(), '..'));
  if (mainRoot === worktreeRoot) return; // not a linked worktree

  const target = realish(resolve(cwd, String(filePath)));
  if (isInside(worktreeRoot, target)) return;

  // The durable location, and the one condition on it: it has to be outside
  // the checkout this hook fences off, or the permit below would open the
  // fence rather than point past it.
  const durable = realish(userMemory());
  const durableIsOutside = !isInside(mainRoot, durable) && !isInside(durable, mainRoot);
  if (durableIsOutside && isInside(durable, target)) {
    note(HOOK, `durable memory: ${target} is under ${durable} (the \`memory: user\` scope), outside every checkout, so removing this worktree cannot take it.`);
    return;
  }

  if (isInside(mainRoot, target)) {
    const scoped = PROJECT_MEMORY.some((dir) => isInside(join(mainRoot, dir), target));
    let remedy: string;
    if (!durableIsOutside) {
      // Never name a location this call is itself refusing.
      remedy = `No durable location is reachable from here: \`memory: user\` resolves to ${durable}, which this \`$HOME\` puts inside the checkout, so it is denied like any other path in it.`;
    } else if (scoped) {
      remedy = `That is \`memory: project\`/\`memory: local\`, which resolves inside a checkout and is denied here like any other path in it. The scope that outlives a worktree is \`memory: user\`, at ${durable}, and it is set in the agent's card by whoever writes the card — not by the agent, and not at write time.`;
    } else {
      remedy = `Something that has to outlive this worktree goes under ${durable} (the \`memory: user\` scope), which is outside every checkout.`;
    }
    deny(HOOK, `write outside your worktree: ${target} is in the main checkout (${mainRoot}). Use the path under ${worktreeRoot}. ${remedy}`);
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the write: ${err?.message ?? err}`);
  process.exit(0);
});
