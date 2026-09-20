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
// contains it) or inside the worktree (a `$HOME` that resolves to nothing, so
// the path is relative), because a hole in this fence — or a "durable"
// location that dies with the pass — is worth more than the naming.
//
// What the naming does NOT promise: that directory is one global location per
// card, with no per-run, per-worktree, per-branch or per-repository
// component, and this hook cannot add one (the payload carries `agent_id`,
// never the card name that names the directory). Two agents of the same card,
// which is the loop's normal parallel dispatch, write the same files.
//
// Crash policy: ALLOW. The memory path is new work this hook did not do
// before — `realish` stats that path and its ancestors — so it is computed
// inside `durableLocation`, which returns `null` on any throw instead of
// propagating. That matters because it runs ahead of the only `deny()` here:
// reaching the crash handler would turn a refused main-checkout write into an
// allowed one. The policy is unchanged; what is bounded is the new code's
// ability to invoke it.
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deny, git, note, parsePayload, readStdin } from './lib/common.mts';

const HOOK = 'protect-worktree';

/** `memory: project` and `memory: local`, relative to a project root. */
const PROJECT_MEMORY = [join('.claude', 'agent-memory'), join('.claude', 'agent-memory-local')];

/**
 * Said on every refusal that names the durable location, because the location
 * is not a directory to hand-write into: Claude Code owns it and fills it from
 * the scope in the agent's card.
 */
const CARD_CAVEAT = "The scope is set in the agent's card by whoever writes the card — not by the agent, and not at write time.";

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

/**
 * Where `memory: user` resolves, or `null` when this session has no durable
 * location to offer — in which case the hook names none rather than pointing
 * at somewhere that is not durable.
 *
 * Four ways there is none, and the last is why this never throws: it sits
 * ahead of the only `deny()` in the file, so an exception here would reach
 * the crash handler and allow a main-checkout write. Degrading to `null`
 * costs the permit and the naming; degrading to a throw costs the fence.
 */
function durableLocation(mainRoot: string, worktreeRoot: string): string | null {
  try {
    const home = homedir();
    // `$HOME` unset or empty makes `homedir()` return `''`, and a relative
    // memory path resolves against the hook's own cwd — the worktree.
    if (!isAbsolute(home)) return null;
    const dir = realish(join(home, '.claude', 'agent-memory'));
    // Inside the checkout this hook fences off, or containing it: naming it
    // would open the fence rather than point past it.
    if (isInside(mainRoot, dir) || isInside(dir, mainRoot)) return null;
    // Inside the worktree: it dies with the pass, which is the finding.
    if (isInside(worktreeRoot, dir)) return null;
    return dir;
  } catch {
    return null;
  }
}

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

  const durable = durableLocation(mainRoot, worktreeRoot);
  if (durable !== null && isInside(durable, target)) {
    note(HOOK, `durable memory: ${target} is under ${durable} (the \`memory: user\` scope), outside every checkout, so removing this worktree cannot take it. It is one global directory per card, shared by every agent of that card in every repository — see the "Known limits" section of docs/orchestration.md.`);
    return;
  }

  if (isInside(mainRoot, target)) {
    const scoped = PROJECT_MEMORY.some((dir) => isInside(join(mainRoot, dir), target));
    let remedy: string;
    if (durable === null) {
      // Never name a location this session cannot offer, and never one this
      // call is itself refusing.
      remedy = 'No durable location is on offer here: `memory: user` does not resolve to a path outside every checkout from this session, so nothing reachable from here outlives the pass.';
    } else if (scoped) {
      remedy = `That is \`memory: project\`/\`memory: local\`, which resolves inside a checkout and is denied here like any other path in it. The scope that outlives a worktree is \`memory: user\`, at ${durable}. ${CARD_CAVEAT}`;
    } else {
      remedy = `Something that has to outlive this worktree goes under ${durable} (the \`memory: user\` scope), which is outside every checkout. ${CARD_CAVEAT}`;
    }
    deny(HOOK, `write outside your worktree: ${target} is in the main checkout (${mainRoot}). Use the path under ${worktreeRoot}. ${remedy}`);
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the write: ${err?.message ?? err}`);
  process.exit(0);
});
