#!/usr/bin/env node
// worktree-create — WorktreeCreate.
//
// Creates the worktree an agent runs in outside the main checkout, so a headless agent's
// writes never land under `.claude/worktrees/`, where Claude Code's own protected-path
// rules denied 7 of 28 calls in the run that surfaced this (#129 L10/L11). Once this hook
// is registered, Claude Code delegates the actual worktree creation to it instead of
// making one itself.
//
// Reads the payload's `name` (the worktree's short id, e.g. `agent-<id>`; defaults to
// `agent` when absent) and `cwd` (the main checkout; falls back to this process's own cwd
// when the payload carries none), resolves the checkout's toplevel with `git rev-parse
// --show-toplevel`, then:
//   git worktree add --detach <dir> HEAD
// where <dir> is `${AGENTIC_WORKTREE_DIR:-<tmpdir>/agentic-worktrees}/<name>` (the run that
// worked, #129 L13, used a fixed directory outside `.claude/`; `AGENTIC_WORKTREE_DIR` makes
// that a knob instead of a hardcoded path). Symlinks `node_modules` from the toplevel into
// the new worktree when the toplevel has one and the worktree does not, so `npm
// test`/`npm run check` do not need a fresh install. Prints the absolute path on stdout —
// nothing else — on success.
//
// Crash policy: REFUSE. Unlike the PreToolUse hooks in this directory, which fail open
// because a later layer (the ruleset, `git-pre-push`) still catches what they miss, there
// is no later layer for a worktree that Claude Code no longer creates itself once this
// hook is registered: any error here means no worktree exists at all, so it must fail
// closed. Every failure prints its reason to stderr and exits 1 with nothing on stdout —
// never a bogus or empty path for the caller to build on.
import { existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, note, parsePayload, readStdin } from './lib/common.mts';

const HOOK = 'worktree-create';
// Alphanumeric with . _ - in the middle only — no `/`, no leading `-` (an "option"),
// no `..` segment that could walk the path out of AGENTIC_WORKTREE_DIR.
const VALID_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function fail(reason: string): never {
  process.stderr.write(`[agentic-setup/${HOOK}] ${reason}\n`);
  process.exit(1);
}

async function main() {
  const raw = await readStdin();
  const payload = parsePayload(raw);
  if (!payload) fail('unreadable payload: not JSON');

  const name = String(payload.name ?? '').trim() || 'agent';
  if (!VALID_NAME.test(name)) {
    fail(`refusing worktree name ${JSON.stringify(name)}: alphanumeric with . _ - only, no leading/trailing separator`);
  }

  const cwd = payload.cwd || process.cwd();
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (!top.ok) fail(`not a git repository at ${cwd}: ${top.stderr.trim() || top.error?.message || 'git rev-parse failed'}`);
  const toplevel = top.stdout.trim();

  const base = process.env.AGENTIC_WORKTREE_DIR || join(tmpdir(), 'agentic-worktrees');
  const dir = resolve(base, name);
  if (existsSync(dir)) fail(`refusing to reuse an already-occupied path: ${dir}`);

  const added = git(['worktree', 'add', '--detach', dir, 'HEAD'], toplevel);
  if (!added.ok) fail(`git worktree add --detach failed: ${added.stderr.trim() || added.error?.message || 'unknown error'}`);

  const sourceModules = join(toplevel, 'node_modules');
  const linkedModules = join(dir, 'node_modules');
  if (existsSync(sourceModules) && !existsSync(linkedModules)) {
    try {
      symlinkSync(sourceModules, linkedModules, 'dir');
    } catch (err: any) {
      note(HOOK, `node_modules symlink skipped: ${err?.message ?? err}`);
    }
  }

  process.stdout.write(dir);
}

main().catch((err) => fail(`hook error: ${err?.message ?? err}`));
