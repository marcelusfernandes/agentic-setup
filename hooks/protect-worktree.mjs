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
// Crash policy: ALLOW.
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { deny, git, note, parsePayload, readStdin } from './lib/common.mjs';

const HOOK = 'protect-worktree';

/**
 * Real path of `p`, resolving symlinks through the deepest ancestor that
 * exists (the file itself may not exist yet). `/var/...` and
 * `/private/var/...` must compare equal on macOS.
 * @param {string} p
 */
function realish(p) {
  let existing = p;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const rest = relative(existing, p);
  try {
    return rest ? join(realpathSync.native(existing), rest) : realpathSync.native(existing);
  } catch {
    return p;
  }
}

/** @param {string} parent @param {string} child */
const isInside = (parent, child) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

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
  if (isInside(mainRoot, target)) {
    deny(HOOK, `write outside your worktree: ${target} is in the main checkout (${mainRoot}). Use the path under ${worktreeRoot}.`);
  }
}

main().catch((err) => {
  note(HOOK, `hook error, allowing the write: ${err?.message ?? err}`);
  process.exit(0);
});
