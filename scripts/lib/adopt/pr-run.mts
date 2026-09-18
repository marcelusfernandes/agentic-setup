// `node scripts/adopt.mts --pr`, as a function (#302).
//
// The flag's body used to live in `scripts/adopt.mts` itself, which took that
// file to 793 of its 800 lines: the next mode had nowhere to go, and the CLI
// held the gate, the base read, the plumbing and the push beside the five
// other flags' reporting. This module is the whole of `--pr` except the
// printing: it takes what the CLI already read — the report, the record, the
// two runners — and answers a `PrOutcome` the CLI turns into JSON and an exit
// code. Nothing here calls `process.exit` and nothing here prints.
//
// **What it does.** It resolves the plan issue (`resolvePlanIssue`), refuses a
// record it did not generate, reads the base as `origin` has it, plans the
// branch against that base tree, builds the commits through git's plumbing
// against a temporary index, pushes create-only and opens the pull request.
// The sequence and every refusal are `docs/adopt.md`'s `--pr` section.
//
// **The temporary index is removed on every path.** `baseFile` used to call
// the CLI's module-level `fail()`, which exits the process from inside the
// block that owns the directory: a `pr:base-unreadable` left an
// `agentic-adopt-index-*` behind and falsified the header's own claim. Here it
// throws a `PrError` like every other refusal of `pr.mts`, and the one
// `finally` below is what removes the directory.
//
// **Crash policy: fail closed, the same as its caller.** Every read that
// cannot answer becomes `{ kind: 'error', reason }`, which the CLI prints as
// `{ error: <named reason> }` and exits 1 on. No field is ever reported as
// absent because the read for it failed. A refusal a person answers is
// `{ kind: 'refused' }` — exit 1 too, but a question rather than a failure —
// and a branch someone else already holds is `{ kind: 'held' }`, exit 2.
//
// Node built-ins only.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ADOPTION_BRANCH,
  PR_TITLE,
  PrError,
  buildBranch,
  planPullRequest,
  renderBody,
  resolvePlanIssue,
  type PlanCandidate,
} from './pr.mts';
import { GENERATED_BY, RECORD_FILE, buildRecord, type AdoptionRecord } from './record.mts';
import type { CommandResult, GitOptions } from './git.mts';
import type { Inventory } from './inventory.mts';

/** Runs `gh` with the given argv and reports what it printed. */
export type GhRunner = (args: string[]) => CommandResult;

/** Runs `git` inside the adopted repository; the buffer is the runner's. */
export type GitRunner = (args: string[], options?: GitOptions) => CommandResult;

/** What `--pr` needs, all of it already read by the CLI. */
export type PrRunContext = {
  /** The adopted repository's root. */
  root: string;
  /** The report `takeInventory` produced, used for the default branch and the record. */
  inventory: Inventory;
  /** The record on disk, or `null`; one is built from the inventory when there is none. */
  existing: AdoptionRecord | null;
  gh: GhRunner;
  git: GitRunner;
  /** The title the plan issue is deduplicated by. */
  planIssueTitle: string;
  /** The label a plan issue carries once the decision it asked for was made. */
  decidedLabel: string;
};

/**
 * What happened. `error` is a failure, `refused` a question for a person,
 * `held` a branch that already exists, `ok` a pull request that was opened.
 */
export type PrOutcome =
  | { kind: 'ok'; body: Record<string, unknown> }
  | { kind: 'refused'; body: Record<string, unknown> }
  | { kind: 'held'; body: Record<string, unknown> }
  | { kind: 'error'; reason: string; field?: string | null; detail?: string };

/** The named failure shape, with the underlying tool's own first line when there is one. */
const failure = (reason: string, detail?: string): PrOutcome =>
  detail === undefined || detail === '' ? { kind: 'error', reason } : { kind: 'error', reason, detail };

/** A `PrError` as the outcome the caller prints. */
const refusedByModule = (err: PrError): PrOutcome => ({
  kind: 'error',
  reason: err.reason,
  ...(err.field === null ? {} : { field: err.field }),
  detail: err.message,
});

/** The first line of whatever a command said, or `undefined` when it said nothing. */
const firstLine = (text: string): string | undefined => text.trim().split('\n')[0] || undefined;

/**
 * The whole of `--pr`. Writes nothing into the working tree: the branch is
 * assembled in the object database against a temporary index, which is removed
 * on every path out of this function.
 */
export function runPullRequest(context: PrRunContext): PrOutcome {
  const { root, inventory, existing, gh, git } = context;

  // 1. the decision. A script does not decide adoption for a repository: the
  // plan issue is the question, and the label is the answer.
  //
  // **Two issues can share the title, so the gate cannot read "the" match.**
  // `--plan-issue` deduplicates against *open* issues only, so closing a plan
  // issue and running the documented sequence again leaves a closed one beside
  // an open one. Taking whichever the search returned first would let a closed
  // `human:decided` issue authorise a push and put `Closes #<a closed issue>`
  // in the body — a keyword GitHub will not act on — or let a closed undecided
  // one produce a refusal the live question does not deserve. Resolving the
  // only mode that writes to a remote repository by search order is not a gate.
  //
  // So the state is *requested* and the **open** issue is preferred: it is the
  // live question, and the one `--plan-issue` maintains as unique. A closed
  // issue is history — a decision that was made, acted on and filed — and
  // history is not a standing authorisation. Where preference cannot resolve
  // it (several open matches, which only a person opening one by hand
  // produces) the run refuses by name rather than picking.
  const search = gh([
    'issue', 'list', '--search', `"${context.planIssueTitle}" in:title`,
    '--state', 'all', '--limit', '100', '--json', 'number,title,state,labels',
  ]);
  if (search.status !== 0 || !search.stdout.trim()) return failure('pr:plan-unreadable');
  let plans: unknown;
  try {
    plans = JSON.parse(search.stdout);
  } catch {
    return failure('pr:plan-unreadable');
  }
  if (!Array.isArray(plans)) return failure('pr:plan-unreadable');

  // Which of the matches authorises is `resolvePlanIssue`'s answer, not this
  // file's: it is a decision over what GitHub returned, so it is a pure
  // function tested directly rather than only through a spawn.
  const decision = resolvePlanIssue(plans as PlanCandidate[], context.planIssueTitle, context.decidedLabel);
  if (!decision.ok) {
    return {
      kind: 'refused',
      body: {
        refused: decision.message,
        reason: decision.reason,
        missing: decision.missing,
        ...(decision.issue === null ? {} : { issue: decision.issue }),
        ...(decision.issues === null ? {} : { issues: decision.issues }),
      },
    };
  }
  const planNumber = decision.issue;

  // 2. the record. An existing one is used as it stands, so the pull request
  // carries what the repository already decided; one that a person wrote is
  // refused here exactly as `--record` refuses it, and there is no `--force`
  // past it on this flag.
  if (existing !== null && existing.generatedBy !== GENERATED_BY) {
    return {
      kind: 'refused',
      body: {
        refused:
          `${RECORD_FILE} says it was generated by \`${existing.generatedBy}\`, not by this tool; no person edits this file, ` +
          'and a pull request built on one is a pull request nobody can regenerate. Run `--record --force` first.',
        reason: 'record:not-ours',
        generatedBy: existing.generatedBy,
      },
    };
  }
  const record = existing ?? buildRecord(inventory);

  // 3. the base: the default branch as origin has it, never the checkout.
  if (git(['fetch', 'origin']).status !== 0) return failure('pr:origin-unreadable');
  const rev = git(['rev-parse', `origin/${inventory.defaultBranch}`]);
  if (rev.status !== 0 || rev.stdout.trim().length !== 40) return failure('pr:base-unreadable');
  const base = rev.stdout.trim();
  // What the base tree holds is asked once, of `ls-tree`, and never inferred
  // from a failed read. `git show <sha>:<path>` exits non-zero both for "the
  // tree does not carry this path" and for every other reason it could not
  // answer, so branching on its status alone would plan a file as `created` —
  // and write over the base's version of it — because the read for it failed.
  // That is the one thing this module's header promises it does not do.
  // `-z` keeps a path with a special character unquoted and whole.
  const listing = git(['ls-tree', '-r', '--name-only', '-z', base]);
  if (listing.status !== 0) return failure('pr:base-unreadable', firstLine(listing.stderr || ''));
  const inBase = new Set(listing.stdout.split('\0').filter((path) => path.length > 0));
  const baseFile = (path: string): string | null => {
    if (!inBase.has(path)) return null;
    const show = git(['show', `${base}:${path}`]);
    // The tree says this path is there, so a read that fails is a failure and
    // never an absence: fail closed rather than plan a write over it. It is a
    // *throw* and not an exit, so the caller's `finally` still removes the
    // temporary index directory (#302).
    if (show.status !== 0) {
      throw new PrError('pr:base-unreadable', `the base tree names \`${path}\` and git could not read it: ${firstLine(show.stderr || '') ?? 'git gave no reason'}`, path);
    }
    return show.stdout ?? '';
  };

  // 4. the plan, and the commits it implies. The index directory is this
  // function's, and the `finally` is what makes "removed on every path" true.
  const indexDir = mkdtempSync(join(tmpdir(), 'agentic-adopt-index-'));
  let plan;
  let branch;
  try {
    plan = planPullRequest(record, { root, baseFile });
    branch = buildBranch(plan, { git: (args, options) => git(args, options), base, indexFile: join(indexDir, 'index') });
  } catch (err) {
    if (err instanceof PrError) return refusedByModule(err);
    throw err;
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }

  // 5. the create-only push. The same form `scripts/claim.mts` uses: an empty
  // expected value means the ref must not already exist, the `--porcelain`
  // data line is the signal, and a branch someone else already holds is
  // `held` rather than a force.
  const held: PrOutcome = {
    kind: 'held',
    body: { held: ADOPTION_BRANCH, branch: ADOPTION_BRANCH, base, issue: planNumber },
  };
  const push = git([
    'push', '--porcelain', `--force-with-lease=refs/heads/${ADOPTION_BRANCH}:`, 'origin', `${branch.head}:refs/heads/${ADOPTION_BRANCH}`,
  ]);
  const dataLine = push.stdout.split(/\r?\n/).find((line) => /^[*=!+\- ]\t/.test(line)) ?? '';
  if (push.status === 0) {
    if (!dataLine.startsWith('*')) return held;
  } else {
    const output = `${push.stdout}${push.stderr}`;
    if (/\[rejected\]/.test(output) || /already exists/i.test(output) || /cannot lock ref/i.test(output)) return held;
    return failure('pr:not-pushed', dataLine ? dataLine.replace(/\t/g, ' ').trim() : firstLine(push.stderr || push.stdout || 'push failed'));
  }

  // 6. the pull request. The body is the one `ci/scope-check.mts` reads: the
  // closing keyword in plain text, and `## Files` naming exactly what the
  // branch carries. No `type:` label is applied — an agent that labels its own
  // work buys its own exemptions (`agents/implementer.md`).
  const body = renderBody(plan, { issue: planNumber, defaultBranch: inventory.defaultBranch, record });
  const created = gh(['pr', 'create', '--base', inventory.defaultBranch, '--head', ADOPTION_BRANCH, '--title', PR_TITLE, '--body', body]);
  if (created.status !== 0) return failure('pr:not-created', firstLine(created.stderr || created.stdout || ''));

  return {
    kind: 'ok',
    body: {
      branch: ADOPTION_BRANCH,
      base,
      head: branch.head,
      issue: planNumber,
      pr: created.stdout.trim().split('\n').filter(Boolean).pop() ?? '',
      commits: branch.commits.map(({ subject, sha, paths }) => ({ subject, sha, paths })),
      files: plan.files.map(({ content: _content, ...rest }) => rest),
      globs: plan.globs,
      checks: plan.checks,
      proof: plan.proof,
    },
  };
}
