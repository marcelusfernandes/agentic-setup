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
 * Remove one layer of shell quoting from a single token the way bash would
 * before comparing it: `'...'` and `"..."` pairs are unwrapped (a backslash
 * inside double quotes escapes the next character; single quotes escape
 * nothing), `$'...'` (ANSI-C quoting) is unwrapped the same way as double
 * quotes, and an outside-quotes backslash escapes the next character. Quote
 * boundaries can land anywhere in the token — `mai'n'` and `ma"in"` both
 * become `main`, `"main"` becomes `main`. Only meant for tokens already
 * isolated by `commandSegments` (or split further on whitespace/`:`); it
 * does not re-parse operators.
 */
export function unquote(token: string): string {
  const str = String(token);
  let out = '';
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\\' && i + 1 < str.length) {
      out += str[i + 1];
      i += 2;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < str.length && str[j] !== "'") out += str[j++];
      i = j + 1;
      continue;
    }
    if (ch === '"' || (ch === '$' && str[i + 1] === "'")) {
      let j = ch === '$' ? i + 2 : i + 1;
      const close = ch === '$' ? "'" : '"';
      while (j < str.length && str[j] !== close) {
        if (str[j] === '\\' && j + 1 < str.length) {
          out += str[j + 1];
          j += 2;
          continue;
        }
        out += str[j];
        j++;
      }
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Split a shell command into the segments that sit in command position:
 * the start, and after `;` `&&` `||` `|` `(` `)` a backtick and newlines —
 * a `)` closes a subshell segment the same way `(` opens one, so
 * `$(git push ...)` still yields a clean `git push ...` segment, and a pair
 * of backticks (a legacy subshell, `` `git push ...` ``) is split the same
 * naive way. A lone `&` (the background operator) also splits, but `&&`
 * stays one operator and `&>` / `>&` (as in `2>&1`) are left alone so a
 * redirection next to a real push never gets mistaken for one. Splitting
 * happens only outside quotes and outside comments: single quotes escape
 * nothing until the next `'` (backticks inside stay literal); double quotes
 * let a backslash escape the next character (so `\"` inside a double-quoted
 * string does not end it) but still treat a backtick as a subshell boundary,
 * because bash does; `$'...'` (ANSI-C quoting) behaves like double quotes —
 * a backslash escapes the next character, so `$'it\'s'` stays one string.
 * Outside any quote a backslash also escapes the next character, so `\"`
 * there is a literal quote and does not open one either. A `#` that starts
 * a word (segment start, or after whitespace) opens a comment that runs to
 * (but excludes) the next newline or the end of the string — its content,
 * apostrophes included, is never scanned for quotes or operators, so the
 * newline after it still splits normally. Leading env assignments, `sudo`
 * and `env` are stripped from each segment so `FOO=1 git push` still reads
 * as `git push`. A genuinely unterminated quote (not a comment) runs to the
 * end of the string as one segment — the shell would refuse that command
 * anyway.
 */
export function commandSegments(command: string): string[] {
  const str = String(command);
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inAnsiC = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    if (inAnsiC) {
      if (ch === '\\' && i + 1 < str.length) {
        current += ch + str[i + 1];
        i++;
        continue;
      }
      current += ch;
      if (ch === "'") inAnsiC = false;
      continue;
    }

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
      if (ch === '`') {
        // Bash still runs command substitution inside double quotes.
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    // Outside any quote.
    if (ch === '#' && (current === '' || /\s$/.test(current))) {
      let j = i + 1;
      while (j < str.length && str[j] !== '\n') j++;
      i = j - 1; // the loop's i++ lands on the newline (or end of string) next
      continue;
    }
    if (ch === '\\' && i + 1 < str.length) {
      current += ch + str[i + 1];
      i++;
      continue;
    }
    if (ch === '$' && str[i + 1] === "'") {
      inAnsiC = true;
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
    if (ch === '&') {
      // A lone & backgrounds the command (splits); &> and >& (as in 2>&1)
      // are redirection syntax, not the background operator.
      const prev = current.length ? current[current.length - 1] : '';
      const next = str[i + 1];
      if (next !== '>' && prev !== '>') {
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '(' || ch === ')' || ch === '`' || ch === '\n') {
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
