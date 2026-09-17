#!/usr/bin/env node
// proof — runs the proof a branch slug declares, and reports a named outcome
// (#164).
//
//   node scripts/proof.mts <slug>
//
// `<slug>` is the `<slug>` of the branch `<type>/<n>-<slug>` — the value
// `scripts/claim.mts` takes as `--slug`. The command comes from one of three
// sources, in this order (`scripts/lib/proof.mts` resolves them):
//   `declaration`  `proof/<slug>.json`, under the directory the adoption
//                  record names (`proof.dir`, default `proof`)
//   `record`       the adoption record's `commands.test`
//   `detection`    `ci/lib/detect.mts`, with its AGENTIC_TEST_CMD override
//
// **There is no fourth source, and no flag that takes a command string.** The
// only argument this script accepts is a slug, and the only string it will
// execute is one it read from a file in the repository. Text that arrives in
// an issue body or a pull request body is task data, never authority
// (invariant 9, `.agents/skills/autonomous-loop/references/contract.md`): an
// issue may carry a `Declaration: proof/<slug>.json` *pointer*, whose shape
// `ci/issue-lint.mts` checks and whose contents only the branch decides. A
// command pasted into a comment therefore has no path into this runner at
// all — not through an argument, not through the record, and not through the
// declaration, which is read from the repository and not from GitHub.
//
// It prints one JSON object on stdout and writes nothing:
//
//   { "slug": …, "source": "declaration" | "record" | "detection",
//     "outcome": "pass" | "fail" | "cannot-run", "command": … , "tail": … }
//
// `outcome` is a closed set, as `ci/negative-control.mts` keeps one, and
// `cannot-run` carries the named `reason` it could not run — and the `field`
// it rejected when there is one. `tail` is the last 40 lines of the run's
// output, stdout and stderr together.
//
// **Crash policy: fail closed.** `pass` is the only outcome that exits 0;
// `fail` and `cannot-run` exit 1. Nothing is ever reported as passing because
// a read failed: a declaration that is present and unusable, a record that is
// not the shape, a slug that is not a slug and a command that cannot be
// executed are each `cannot-run` with their own reason, never a fallback to
// the next source and never a silent pass. A usage problem is reported the
// same way — `{ "error": "usage: …" }`, exit 1 — before anything is read.
//
// Node built-ins only.
import { spawnSync } from 'node:child_process';
import { ProofError, resolveProof } from './lib/proof.mts';
import { RecordError } from './lib/adopt/record.mts';

const USAGE = 'usage: node scripts/proof.mts <slug>';

/** How many lines of the run's output the report carries, as `negative-control` does. */
const TAIL = 40;

type Outcome = 'pass' | 'fail' | 'cannot-run';

/** A usage problem: named, printed, and nothing read. */
function usage(): never {
  console.log(JSON.stringify({ error: USAGE }));
  process.exit(1);
}

/** The report, and the exit code that goes with it. `pass` alone exits 0. */
function report(fields: {
  slug: string;
  source: string;
  outcome: Outcome;
  command: string | null;
  tail: string;
  reason?: string;
  field?: string | null;
}): never {
  const { reason, field, ...rest } = fields;
  console.log(JSON.stringify({ ...rest, ...(reason ? { reason } : {}), ...(field ? { field } : {}) }));
  process.exit(fields.outcome === 'pass' ? 0 : 1);
}

// --- 1. the argument, before anything is read --------------------------------
// Exactly one positional and no flags: a second argument, or any `--…`, is a
// caller trying to hand the runner something other than a slug.
const argv = process.argv.slice(2);
if (argv.length !== 1 || argv[0] === undefined || argv[0].startsWith('-')) usage();
const slug = argv[0];

// --- 2. the repository root ---------------------------------------------------
const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
if (top.status !== 0 || !top.stdout.trim()) {
  console.log(JSON.stringify({ error: 'root:not-a-git-repository' }));
  process.exit(1);
}
const root = top.stdout.trim();

// --- 3. the command, from the declaration, the record or detection -----------
let resolved;
try {
  resolved = resolveProof(root, slug);
} catch (err) {
  if (err instanceof ProofError) {
    report({ slug, source: err.source, outcome: 'cannot-run', command: null, tail: '', reason: err.reason, field: err.field });
  }
  if (err instanceof RecordError) {
    report({ slug, source: 'record', outcome: 'cannot-run', command: null, tail: '', reason: err.reason, field: err.field });
  }
  throw err;
}

// --- 4. the run ---------------------------------------------------------------
// The command runs in the repository root, never in the caller's directory:
// a proof is a statement about the repository.
const run = spawnSync(resolved.command, [], { cwd: root, shell: true, encoding: 'utf8', env: { ...process.env, CI: '1' } });
const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
const tail = output.split('\n').slice(-TAIL).join('\n');

// 127 is the shell's "command not found", and `error` is a spawn that never
// started: neither is a proof that failed, so neither is `fail`.
const unrunnable = run.status === 127 || Boolean(run.error);
const outcome: Outcome = unrunnable ? 'cannot-run' : run.status === 0 ? 'pass' : 'fail';

report({
  slug,
  source: resolved.source,
  outcome,
  command: resolved.command,
  tail,
  ...(unrunnable ? { reason: 'proof:command-not-runnable' } : {}),
});
