// Shared test harness for the per-area test files under tests/*.test.mts.
// No framework and node: built-ins only, so every file that imports this
// runs under both `node <file>` and `bun <file>`. Each *.test.mts is its own
// process (spawned by tests/run.mts), so the module-level counters below are
// private to that one file's run.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RUNTIME = process.argv[0];

const cleanups: Array<() => void> = [];
let passed = 0;
let failed = 0;

/** Registers a cleanup to run when finish() is called. */
export function cleanup(fn: () => void): void {
  cleanups.push(fn);
}

/** Records one case's outcome; prints a FAIL line (with trimmed detail) when it fails. */
export function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++;
    return;
  }
  failed++;
  console.error(`FAIL  ${name}${detail ? `\n      ${detail.trim().split('\n').slice(-6).join('\n      ')}` : ''}`);
}

/** Runs a git command against a throwaway repository; throws on failure. */
export function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Creates a throwaway git repository on branch main; cleaned up by finish(). */
export function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentic-smoke-'));
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'smoke@example.com'], dir);
  git(['config', 'user.name', 'smoke'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

/** Writes files and commits them (allow-empty) in the given repo; returns the new HEAD sha. */
export function commit(dir: string, files: Record<string, string>, message: string): string {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  git(['add', '-A'], dir);
  git(['commit', '-q', '--allow-empty', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

export type Opts = { cwd?: string; env?: Record<string, string> };

/** Spawns a hook under hooks/<script> with the runtime that launched this file. */
export function hook(script: string, payload: object | string, opts: Opts = {}) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'hooks', script)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Spawns a CI script under ci/<script> with the runtime that launched this file. */
export function ci(script: string, args: string[], opts: Opts = {}) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'ci', script), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '', ...opts.env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Runs registered cleanups, prints the file's summary line, and exits with the right code. */
export function finish(): void {
  for (const fn of cleanups) fn();
  console.log(`${passed} passed, ${failed} failed (${RUNTIME.split('/').pop()})`);
  process.exit(failed ? 1 : 0);
}
