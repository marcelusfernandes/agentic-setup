// Shared helpers for the agentic-setup hooks. Node built-ins only, so the
// same files run unchanged under Bun. Nothing here exits on its own: every
// hook states its crash policy in its own header and decides for itself.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

const MAX_STDIN = 1024 * 1024;

/** The raw stdin, capped at 1 MiB. */
export function readStdin(): Promise<string> {
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

/** `null` when the payload is not JSON. */
export function parsePayload(raw: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return null;
  }
}

export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: String(r.stdout ?? ''),
    stderr: String(r.stderr ?? ''),
    error: r.error,
  };
}

export const git = (args: string[], cwd: string) => run('git', args, { cwd });

export function currentBranch(cwd: string): string {
  const r = git(['branch', '--show-current'], cwd);
  return r.ok ? r.stdout.trim() : '';
}

export function repoRoot(cwd: string): string {
  const r = git(['rev-parse', '--show-toplevel'], cwd);
  return r.ok ? r.stdout.trim() : cwd;
}

export function lastCommitSubject(cwd: string): string {
  const r = git(['log', '-1', '--pretty=%s'], cwd);
  return r.ok ? r.stdout.trim() : '';
}

/**
 * Deny a PreToolUse call: JSON decision on stdout (the documented channel),
 * the reason on stderr (what the agent reads), exit 2 (blocks regardless).
 */
export function deny(hook: string, reason: string): never {
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

export function note(hook: string, message: string): void {
  process.stderr.write(`[agentic-setup/${hook}] ${message}\n`);
}

/**
 * A valve is an env var set to "1" in the hook's environment OR written
 * inline at the front of the command (`AGENTIC_ALLOW_PUSH_MAIN=1 git push …`).
 * Hooks run with Claude Code's environment, not the command's, so inline is
 * the only way an agent can declare one — and declaring it is deliberate,
 * visible in the transcript, and greppable.
 */
export function valve(name: string, command: string): boolean {
  if (process.env[name] === '1') return true;
  return new RegExp(`(?:^|[\\s;&|(])${name}=1(?=\\s)`).test(command);
}

/**
 * Split a shell command into the segments that sit in command position:
 * the start, and after `;` `&&` `||` `|` `(` `)` and newlines — a `)` closes
 * a subshell segment the same way `(` opens one, so `$(git push ...)` still
 * yields a clean `git push ...` segment. Splitting happens only outside
 * quotes: single quotes escape nothing until the next `'`; double quotes let
 * a backslash escape the next character (so `\"` inside a double-quoted
 * string does not end it); outside any quote a backslash also escapes the
 * next character, so `\"` there is a literal quote and does not open one
 * either. Leading env assignments, `sudo` and `env` are stripped from each
 * segment so `FOO=1 git push` still reads as `git push`. An unterminated
 * quote runs to the end of the string as one segment — the shell would
 * refuse that command anyway.
 */
export function commandSegments(command: string): string[] {
  const str = String(command);
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      continue;
    }

    if (inDouble) {
      if (ch === '\\' && i + 1 < str.length) {
        current += ch + str[i + 1];
        i++;
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    // Outside any quote.
    if (ch === '\\' && i + 1 < str.length) {
      current += ch + str[i + 1];
      i++;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      continue;
    }
    if ((ch === '&' && str[i + 1] === '&') || (ch === '|' && str[i + 1] === '|')) {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  segments.push(current);

  return segments
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^(?:\w+=\S*\s+|sudo\s+|env\s+)*/, ''));
}
