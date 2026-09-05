// Shared helpers for the agentic-setup hooks. Node built-ins only, so the
// same files run unchanged under Bun. Nothing here exits on its own: every
// hook states its crash policy in its own header and decides for itself.
import { spawnSync } from 'node:child_process';

const MAX_STDIN = 1024 * 1024;

/** @returns {Promise<string>} the raw stdin, capped at 1 MiB */
export function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      if (raw.length < MAX_STDIN) raw += chunk.slice(0, MAX_STDIN - raw.length);
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
  });
}

/** @param {string} raw @returns {Record<string, any> | null} null when the payload is not JSON */
export function parsePayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    error: r.error,
  };
}

/** @param {string[]} args @param {string} cwd */
export const git = (args, cwd) => run('git', args, { cwd });

/** @param {string} cwd */
export function currentBranch(cwd) {
  const r = git(['branch', '--show-current'], cwd);
  return r.ok ? r.stdout.trim() : '';
}

/** @param {string} cwd */
export function repoRoot(cwd) {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? r.stdout.trim() : cwd;
}

/** @param {string} cwd */
export function lastCommitSubject(cwd) {
  const r = git(['log', '-1', '--pretty=%s'], cwd);
  return r.ok ? r.stdout.trim() : '';
}

/**
 * Deny a PreToolUse call: JSON decision on stdout (the documented channel),
 * the reason on stderr (what the agent reads), exit 2 (blocks regardless).
 * @param {string} hook @param {string} reason
 * @returns {never}
 */
export function deny(hook, reason) {
  const text = `[agentic-setup/${hook}] ${reason}`;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: text,
      },
    }),
  );
  process.stderr.write(`${text}\n`);
  process.exit(2);
}

/** @param {string} hook @param {string} message */
export function note(hook, message) {
  process.stderr.write(`[agentic-setup/${hook}] ${message}\n`);
}

/**
 * A valve is an env var set to "1" in the hook's environment OR written
 * inline at the front of the command (`AGENTIC_ALLOW_PUSH_MAIN=1 git push …`).
 * Hooks run with Claude Code's environment, not the command's, so inline is
 * the only way an agent can declare one — and declaring it is deliberate,
 * visible in the transcript, and greppable.
 * @param {string} name @param {string} command
 */
export function valve(name, command) {
  if (process.env[name] === '1') return true;
  return new RegExp(`(?:^|[\\s;&|(])${name}=1(?=\\s)`).test(command);
}

/**
 * Split a shell command into the segments that sit in command position:
 * the start, and after `;` `&&` `||` `|` `(` and newlines. Leading env
 * assignments, `sudo` and `env` are stripped so `FOO=1 git push` still reads
 * as `git push`. Quotes are not parsed: a string that contains `&& git push`
 * will be seen as a push. That errs on the side of denying, and the agent
 * can rephrase — the cheap side of the trade.
 * @param {string} command @returns {string[]}
 */
export function commandSegments(command) {
  return String(command)
    .split(/&&|\|\||[;|\n(]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^(?:\w+=\S*\s+|sudo\s+|env\s+)*/, ''));
}
