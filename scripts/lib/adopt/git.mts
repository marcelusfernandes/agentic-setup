// The one `git` runner the adoption steps spawn through (#302).
//
// `child_process`'s default `maxBuffer` is 1 MB. `scripts/adopt.mts` read the
// base tree with `git ls-tree -r --name-only -z <base>`, whose answer is the
// whole path text of a repository: a large one outgrows a megabyte long before
// it outgrows anything else, and `spawnSync` then killed the child and
// answered with `status: null` and an empty `stderr`. The caller's
// `status ?? 1` turned that into "git failed" with no detail at all — a read
// that failed closed, correctly, but said nothing a person could act on, while
// `git show` two lines below already passed 64 MB.
//
// So the buffer is named once, here, and every adoption `git` gets it; and a
// spawn that could not run or could not be held is reported with the reason
// Node gave it (`ENOBUFS`, `ENOENT`, …) in `stderr`, so the named refusal the
// caller prints carries a detail rather than an empty string.
//
// **Crash policy: fail closed, and never throw.** Every outcome is a
// `CommandResult`; a spawn that did not produce an exit status is status 1
// with the error's own code in `stderr`. The caller decides what that means.
//
// Node built-ins only.
import { spawnSync } from 'node:child_process';

/** What one `git` call answered: the shape every adoption caller reads. */
export type CommandResult = { status: number; stdout: string; stderr: string };

/**
 * The buffer every adoption `git` call is given, and the reason for the size:
 * `ls-tree -r` of a large repository is megabytes of path text, and 1 MB — the
 * default — is a limit a real repository reaches. 64 MB is what the `git show`
 * of the base's version of a file already used, so the two are one number.
 */
export const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** What a caller may vary; the buffer is the only one, and it defaults. */
export type GitOptions = {
  maxBuffer?: number;
  input?: string;
  env?: Record<string, string>;
};

/**
 * One `git` call inside `cwd`.
 *
 * **`error` decides before `status` does.** A child that outgrows the buffer
 * is reported by `spawnSync` as `error.code === 'ENOBUFS'` with an exit status
 * of 0 and *truncated* output — so reading the status alone answers "git
 * succeeded" over an answer that is missing its tail. For `ls-tree`, whose
 * answer is the set of paths the base tree holds, a truncated success is the
 * worst of the three outcomes: a path that fell off the end reads as one the
 * base does not carry, and a generated file gets planned as `created` over the
 * base's own version of it (#302). So any `error` at all is status 1, with
 * Node's own code in `stderr`: a named refusal with an empty detail is a
 * refusal nobody can act on.
 */
export function runGit(cwd: string, args: string[], options: GitOptions = {}): CommandResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? GIT_MAX_BUFFER,
    ...(options.input === undefined ? {} : { input: options.input }),
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
  });
  const failure = r.error as NodeJS.ErrnoException | undefined;
  if (failure !== undefined || r.status === null || r.status === undefined) {
    const code = failure?.code ?? 'unknown';
    const detail = failure?.message ?? 'git produced no exit status';
    return { status: 1, stdout: '', stderr: `git ${args[0] ?? ''}: ${code}: ${detail}` };
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `git` bound to one repository: the form `scripts/adopt.mts` passes around. */
export function gitIn(cwd: string): (args: string[], options?: GitOptions) => CommandResult {
  return (args, options) => runGit(cwd, args, options);
}
