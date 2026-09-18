// The one `git` runner the adoption steps spawn through (#302).
//
// This module closes a ceiling and an uninformative refusal. It does not close
// a silent corruption: there was none, and the measurement is in `runGit` below.
//
// `child_process`'s default `maxBuffer` is 1 MB. `scripts/adopt.mts` read the
// base tree with `git ls-tree -r --name-only -z <base>`, whose answer is the
// whole path text of a repository: a large one outgrows a megabyte long before
// it outgrows anything else. `spawnSync` then killed the child and answered
// with `status: null` and an empty `stderr`, so the caller's `status ?? 1`
// refused — correctly, and with nothing in `detail` that a person could act
// on, while `git show` two lines below already passed 64 MB and would have
// answered. A repository was refused for being large, and told only that git
// had failed.
//
// So the buffer is named once, here, and every adoption `git` gets it — the
// ceiling; and a spawn that could not run or could not be held is reported
// with the reason Node gave it (`ENOBUFS`, `ENOENT`, …) in `stderr` — the
// detail, so `pr:base-unreadable` says which path and why.
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
 * **`error` decides before `status` does**, and the reason is narrower than it
 * looks. Measured over a 30,000-path repository (1.44 MB of `-z` listing) at
 * eleven buffer sizes from 8 bytes to 2 MB: every size that actually truncated
 * answered `status: null`, `signal: 'SIGTERM'`, `error.code: 'ENOBUFS'`, which
 * the old `status ?? 1` turned into 1 — so the base **did** fail closed, as
 * the issue said. `status: 0` beside an `ENOBUFS` appeared only where the
 * complete answer had already arrived in one read; nothing was lost there, and
 * no truncated listing was ever read as a whole one.
 *
 * So reading `error` first is not undoing a silent corruption. It is the
 * fail-closed reading of a signal that is ambiguous from the outside: Node
 * reports the same `ENOBUFS` for "killed with the tail missing" and for "the
 * whole answer arrived and then the limit was noticed", and this runner cannot
 * tell them apart — only the caller's expectation of length could, and it has
 * none. Refusing both is the answer that is never wrong; accepting both is the
 * one that would be.
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
