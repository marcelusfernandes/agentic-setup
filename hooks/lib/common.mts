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
 * nothing), `$'...'` (ANSI-C quoting) and `$"..."` (locale quoting) are each
 * unwrapped the same way as double quotes, and an outside-quotes backslash
 * escapes the next character. Quote
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
    if (ch === '"' || (ch === '$' && (str[i + 1] === "'" || str[i + 1] === '"'))) {
      let j = ch === '$' ? i + 2 : i + 1;
      const close = ch === '$' ? str[i + 1] : '"';
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
 * the start, and after `;` `&&` `||` `|` a bare `(` `)` a backtick pair and
 * newlines. Backticks do not nest: the first backtick opens a subshell and
 * sets aside whatever came before it in the current segment, the matching
 * backtick closes it — emitting the enclosed text as its own segment — and
 * the command resumes from where it left off, so
 * `` git push origin `echo` main `` still yields a clean
 * `git push origin  main` segment (the outer command stays contiguous)
 * alongside the inner `echo`. `$( … )` command substitution behaves the same
 * way but nests (unlike backticks), so it is tracked with a depth counter
 * instead of a single saved outer: `git push origin $(echo x) main` yields
 * the inner `echo x` as its own segment and keeps
 * `git push origin  main` contiguous, and `$(a $(b) c)` finds the *outer*
 * closing paren correctly because every `(` seen while a substitution is
 * open (its own `$(` or a bare one, as in `$( (echo x) )`) pushes the depth
 * before any `)` is allowed to pop it. `$(` is recognised outside quotes and
 * inside double quotes (bash still runs the substitution there); a `#`
 * inside `$( … )` is a syntax error in bash, so no comment handling is
 * needed for it. A lone `&` (the background operator) also splits, but `&&`
 * stays one operator and a redirection (`>` `<` `>>` `<<` `&>` `&>>` `>&`
 * `<&`, optionally with a glued file-descriptor number as in `2>&1`) is
 * recognised and dropped — operator and target both — from the segment text
 * so it never gets mistaken for an argument (`main>&2` still yields the
 * refspec `main`) and never masks a real `&&` or lone `&` next to it; a
 * backslash-escaped `>` is ordinary text for this purpose (and for the lone
 * `&` split above), so `echo \>& cmd` still splits on that `&`. Splitting
 * happens only outside quotes and outside comments: single quotes escape
 * nothing until the next `'` (backticks inside stay literal); double quotes
 * let a backslash escape the next character (so `\"` inside a double-quoted
 * string does not end it) but still treat a backtick or `$(` as a boundary,
 * because bash does; `$'...'` and `$"..."` (ANSI-C and locale quoting)
 * behave like double quotes — a backslash escapes the next character, so
 * `$'it\'s'` stays one string. Outside any quote a backslash also escapes
 * the next character, so `\"` there is a literal quote and does not open one
 * either. A `#` that starts a word (segment start, or after whitespace)
 * opens a comment that runs to (but excludes) the next newline or the end of
 * the string — its content, apostrophes included, is never scanned for
 * quotes or operators, so the newline after it still splits normally.
 * Leading env assignments, `sudo` and `env` are stripped from each segment
 * so `FOO=1 git push` still reads as `git push`. A genuinely unterminated
 * quote (not a comment) runs to the end of the string as one segment — the
 * shell would refuse that command
 * anyway.
 */
/**
 * Advances past one shell word (respecting `'…'`, `"…"`, `$'…'`, `$"…"` and
 * an outside-quotes backslash escape) starting at `str[from]`, stopping at
 * the first unquoted whitespace or operator character. Used to drop a
 * redirection target from a segment without losing track of its own quotes.
 */
function skipWord(str: string, from: number): number {
  let j = from;
  let single = false;
  let double = false;
  let ansiC = false;
  while (j < str.length) {
    const c = str[j];
    if (single) {
      if (c === "'") single = false;
      j++;
      continue;
    }
    if (double || ansiC) {
      if (c === '\\' && j + 1 < str.length) {
        j += 2;
        continue;
      }
      if ((double && c === '"') || (ansiC && c === "'")) {
        double = false;
        ansiC = false;
      }
      j++;
      continue;
    }
    if (c === '\\' && j + 1 < str.length) {
      j += 2;
      continue;
    }
    if (c === "'") {
      single = true;
      j++;
      continue;
    }
    if (c === '"') {
      double = true;
      j++;
      continue;
    }
    if (c === '$' && (str[j + 1] === "'" || str[j + 1] === '"')) {
      if (str[j + 1] === "'") ansiC = true;
      else double = true;
      j += 2;
      continue;
    }
    if (/[\s;|&()<>\n]/.test(c)) break;
    j++;
  }
  return j;
}

export function commandSegments(command: string): string[] {
  const str = String(command);
  const segments: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let inAnsiC = false;
  // Backticks do not nest: null outside a backtick pair; otherwise the
  // segment text that was accumulating before the opening backtick, so the
  // outer command can resume once the matching backtick closes.
  let backtickOuter: string | null = null;
  // $( … ) does nest, so each open substitution gets its own frame: the
  // segment text saved aside (like backtickOuter), a depth counter for any
  // '(' seen while this substitution is open (its own nested $( or a bare
  // subshell), and whether double-quote mode should resume when it closes.
  const dollarStack: { outer: string; depth: number; wasInDouble: boolean }[] = [];

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
      if (ch === '$' && str[i + 1] === '(') {
        // Bash still runs command substitution inside double quotes; resume
        // double-quote mode when the matching ')' closes it below.
        dollarStack.push({ outer: current, depth: 0, wasInDouble: true });
        current = '';
        inDouble = false;
        i++;
        continue;
      }
      if (ch === '`') {
        // Bash still runs command substitution inside double quotes.
        if (backtickOuter === null) {
          backtickOuter = current;
          current = '';
        } else {
          segments.push(current);
          current = backtickOuter;
          backtickOuter = null;
        }
        continue;
      }
      current += ch;
      if (ch === '"') inDouble = false;
      continue;
    }

    // Outside any quote.
    if (ch === '#' && (current === '' || /\s$/.test(current))) {
      let j = i + 1;
      while (j < str.length && str[j] !== '\n') {
        if (backtickOuter !== null) {
          // Bash ends a comment inside backquotes at the matching (unescaped)
          // backquote — it doesn't run past it to the next newline.
          if (str[j] === '\\' && j + 1 < str.length) {
            j += 2;
            continue;
          }
          if (str[j] === '`') break;
        }
        j++;
      }
      i = j - 1; // the loop's i++ lands on the boundary (backtick, newline, or end) next
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
    if (ch === '$' && str[i + 1] === '(') {
      dollarStack.push({ outer: current, depth: 0, wasInDouble: false });
      current = '';
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
      // are redirection syntax, not the background operator — but only when
      // the '>' is real: a backslash-escaped '>' (\>&) is ordinary text, so
      // it must not suppress a genuine & split next to it.
      const prev = current.length ? current[current.length - 1] : '';
      const prevEscaped = prev === '>' && current[current.length - 2] === '\\';
      const next = str[i + 1];
      if (next !== '>' && (prev !== '>' || prevEscaped)) {
        segments.push(current);
        current = '';
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '>' || ch === '<') {
      // A redirection: never a command boundary, but the operator and its
      // target must not leak into the argument list as if they were a real
      // word (main>&2 must still yield the refspec "main"). A directly-glued
      // '&' (main&>) was already appended literally by the check above;
      // strip it back off first, along with a bare leading fd-number word
      // (the "2" in "2>&1").
      if (current.endsWith('&') && current[current.length - 2] !== '\\') current = current.slice(0, -1);
      const fd = /(?:^|\s)([0-9]+)$/.exec(current);
      if (fd) current = current.slice(0, current.length - fd[1].length);
      let j = i;
      while (j < str.length && (str[j] === '<' || str[j] === '>' || str[j] === '&')) j++;
      if (j < str.length && (str[j] === '-' || /[0-9]/.test(str[j]))) {
        // A duplicate/close-fd form glued on the far side (>&2, 2>&1, >&-)
        // has no separate target word.
        while (j < str.length && /[0-9]/.test(str[j])) j++;
        if (str[j] === '-') j++;
      } else {
        while (j < str.length && /\s/.test(str[j])) j++;
        j = skipWord(str, j);
      }
      i = j - 1;
      continue;
    }
    if (ch === '`') {
      if (backtickOuter === null) {
        backtickOuter = current;
        current = '';
      } else {
        segments.push(current);
        current = backtickOuter;
        backtickOuter = null;
      }
      continue;
    }
    if (ch === '(') {
      // A bare '(' is a plain segment boundary (a subshell) whether or not
      // we're inside a substitution — that doesn't change just because it's
      // nested. Inside one it *also* bumps the depth counter, so the
      // matching ')' is recognised as closing this subshell rather than the
      // enclosing $( … ) (depth must return to zero before that's allowed).
      if (dollarStack.length) dollarStack[dollarStack.length - 1].depth++;
      segments.push(current);
      current = '';
      continue;
    }
    if (ch === ')') {
      if (dollarStack.length) {
        const top = dollarStack[dollarStack.length - 1];
        if (top.depth > 0) {
          top.depth--;
          segments.push(current);
          current = '';
        } else {
          dollarStack.pop();
          segments.push(current);
          current = top.outer;
          inDouble = top.wasInDouble;
        }
      } else {
        segments.push(current);
        current = '';
      }
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  // An unterminated backtick pair or $( … ): keep the outer text as one
  // segment rather than losing it (the shell would refuse this command
  // anyway).
  if (backtickOuter !== null) current = backtickOuter + current;
  while (dollarStack.length) {
    const top = dollarStack.pop();
    if (top) current = top.outer + current;
  }
  segments.push(current);

  return segments
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^(?:\w+=\S*\s+|sudo\s+|env\s+)*/, ''));
}
