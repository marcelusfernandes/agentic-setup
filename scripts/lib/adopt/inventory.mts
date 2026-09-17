// What a repository already has, read and nothing else (#162). Adoption's
// first step is the one nothing did before: look at the repository and say
// what is there, before writing a single byte into someone else's tree.
//
// The label read is one page, asked for explicitly (`LABEL_LIST_LIMIT`)
// rather than left at `gh`'s default of 30. A page that comes back full may
// be hiding more, and `gh` reports neither a total nor a cursor to tell, so
// the report carries `labelsTruncated` instead of letting a caller read the
// page as the whole set — `labels:missing` is drawn from that page and is a
// guess whenever it is truncated.
//
// `takeInventory(root, gh, git)` is pure in the sense that matters here:
// every effect it can have goes through the two command runners handed to
// it, and it only ever asks them for reads — `gh api repos/{owner}/{repo}`,
// the default branch's effective rules, `gh label list`, and
// `git rev-parse --git-path hooks`. Everything else comes off the
// filesystem under `root`. The check and test commands, the stack and the
// detection source come from `ci/lib/detect.mts` unchanged — this file adds
// no detector and knows nothing about stacks.
//
// Where the hooks live is git's answer, not a guess: `core.hooksPath` moves
// them (husky, lefthook, a shared team directory) and a worktree's `.git`
// is a file, so `git rev-parse --git-path hooks` is the only thing that
// knows. This is the same question `scripts/init.mts` asks before it
// installs the hook, so the two cannot disagree about which file is ours.
//
// **Crash policy: fail closed.** A read that cannot answer returns
// `{ error: <named reason> }` and the caller exits non-zero; no field is
// ever reported as absent because the read failed. "No ruleset" and "the
// ruleset could not be read" are different answers and this file never
// conflates them — and neither is "no hook installed" the same as "git
// could not say where hooks live", nor "no workflows directory" the same as
// "the workflows directory could not be listed". Only ENOENT — the file or
// directory genuinely is not there — reads as absent; every other errno
// (EACCES above all) fails closed.
//
// Node built-ins only.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectCommands } from '../../../ci/lib/detect.mts';

export type CommandResult = { status: number; stdout: string; stderr: string };
/** Runs `gh` with the given argv and reports what it printed. */
export type GhRunner = (args: string[]) => CommandResult;
/** Runs `git` with the given argv, inside the repository, and reports what it printed. */
export type GitRunner = (args: string[]) => CommandResult;

/** The workflows `scripts/init.mts` copies from `templates/.github/workflows`. */
export const OWNED_WORKFLOWS = ['agentic-checks.yml', 'guard-main.yml', 'issue-lint.yml'];

/**
 * The label vocabulary `scripts/init.mts` seeds (its `LABELS`, names only)
 * and `.agents/skills/autonomous-loop/scripts/github.mts` mirrors. Kept as
 * names here because both of those are executable scripts, not modules:
 * importing either to reuse its list would run an installer.
 */
export const SEEDED_LABELS = [
  'state:ready',
  'state:in-progress',
  'state:in-review',
  'state:qa-failed',
  'state:blocked',
  'type:feature',
  'type:bug',
  'type:refactor',
  'type:infra',
  'type:spec',
  'type:docs',
  'type:deps',
  'review:approved',
  'human:pending',
  'human:decided',
];

/**
 * The page `gh label list` is asked for. `gh` defaults to 30, which a real
 * repository outgrows long before it runs out of labels — the same reason
 * `ci/issue-lint.mts` sets an explicit `GH_LIST_LIMIT` on its own list read.
 * It is a page and not a promise: an answer that fills it may be hiding more,
 * which is what `labelsTruncated` says.
 */
export const LABEL_LIST_LIMIT = 200;

/** The git hooks `scripts/init.mts` installs into the adopting repository. */
const OWNED_HOOKS = ['pre-push'];

/** The marker every hook this setup installs carries in its text. */
const HOOK_MARKER = 'agentic-setup';

/** Every gap this inventory can name. A gap is a fact, not a judgement. */
const GAP_NAMES = [
  'ruleset:absent',
  'ruleset:review-not-required',
  'labels:missing',
  'hooks:not-installed',
  'workflows:missing',
  'test-command:none',
] as const;

export type Gap = (typeof GAP_NAMES)[number];

export type Ruleset = {
  /** Rule types in force on the default branch, as GitHub flattens them. */
  rules: string[];
  requiresPullRequest: boolean;
  requiredApprovingReviewCount: number;
  requiredStatusChecks: string[];
};

export type Inventory = {
  stack: string;
  test: string | null;
  check: string | null;
  source: 'override' | 'detected' | 'none';
  defaultBranch: string;
  ruleset: Ruleset | null;
  labels: string[];
  /**
   * `true` when the label read came back holding exactly the page it asked
   * for (`LABEL_LIST_LIMIT`). The repository may have more labels the read
   * never saw, so `labels` is a page rather than the whole set and
   * `labels:missing` is a guess drawn from it. Reported on every run, never
   * inferred by the reader from `labels.length`.
   */
  labelsTruncated: boolean;
  hooks: string[];
  workflows: string[];
  autoMerge: boolean;
  deleteBranchOnMerge: boolean;
  gaps: Gap[];
};

/** The fail-closed outcome: a named reason, never a half-filled report. */
export type InventoryFailure = { error: string };
export type InventoryResult = Inventory | InventoryFailure;

/** Narrows an inventory result to the failure branch. */
export function isFailure(result: InventoryResult): result is InventoryFailure {
  return Object.prototype.hasOwnProperty.call(result, 'error');
}

type Read<T> = { ok: true; value: T } | { ok: false; error: string };

/** One `gh` read, parsed as JSON; any failure becomes the named reason. */
function readJson<T>(gh: GhRunner, args: string[], reason: string): Read<T> {
  let result: CommandResult;
  try {
    result = gh(args);
  } catch {
    return { ok: false, error: reason };
  }
  if (result.status !== 0 || !result.stdout.trim()) return { ok: false, error: reason };
  try {
    return { ok: true, value: JSON.parse(result.stdout) as T };
  } catch {
    return { ok: false, error: reason };
  }
}

/** True only for "it genuinely is not there"; every other errno fails closed. */
const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

/**
 * The directory git would actually run hooks from. Asked of git rather than
 * assembled from `<root>/.git`, exactly as `scripts/init.mts` asks it:
 * `core.hooksPath` redirects it, and in a worktree `.git` is a file whose
 * hooks live in the common directory. The answer may be relative to the
 * repository root, so it is resolved against it.
 */
function gitHooksDir(root: string, git: GitRunner): Read<string> {
  let result: CommandResult;
  try {
    result = git(['rev-parse', '--git-path', 'hooks']);
  } catch {
    return { ok: false, error: 'hooks:unreadable' };
  }
  const path = result.stdout.trim();
  if (result.status !== 0 || path.length === 0) return { ok: false, error: 'hooks:unreadable' };
  return { ok: true, value: resolve(root, path) };
}

/**
 * The names of this setup's hooks that are installed at that directory and
 * are recognisably ours (someone else's `pre-push` is not).
 */
function installedHooks(dir: string): Read<string[]> {
  const found: string[] = [];
  for (const name of OWNED_HOOKS) {
    try {
      if (readFileSync(join(dir, name), 'utf8').includes(HOOK_MARKER)) found.push(name);
    } catch (err) {
      if (!isMissing(err)) return { ok: false, error: 'hooks:unreadable' };
    }
  }
  return { ok: true, value: found };
}

/** Every workflow file present in `.github/workflows`, sorted; not only ours. */
function workflowFiles(root: string): Read<string[]> {
  const dir = join(root, '.github', 'workflows');
  try {
    return { ok: true, value: readdirSync(dir).filter((name) => /\.ya?ml$/.test(name)).sort() };
  } catch (err) {
    if (isMissing(err)) return { ok: true, value: [] };
    return { ok: false, error: 'workflows:unreadable' };
  }
}

type BranchRule = { type?: string; parameters?: Record<string, unknown> };

/** The default branch's effective rules, flattened into what adoption cares about. */
function toRuleset(rules: BranchRule[]): Ruleset | null {
  if (rules.length === 0) return null;
  const pullRequest = rules.find((r) => r.type === 'pull_request');
  const statusChecks = rules.find((r) => r.type === 'required_status_checks');
  const contexts = (statusChecks?.parameters?.required_status_checks ?? []) as Array<{ context?: string }>;
  const reviews = pullRequest?.parameters?.required_approving_review_count;
  return {
    rules: rules.map((r) => r.type ?? 'unknown').sort(),
    requiresPullRequest: Boolean(pullRequest),
    requiredApprovingReviewCount: typeof reviews === 'number' ? reviews : 0,
    requiredStatusChecks: Array.isArray(contexts) ? contexts.map((c) => c?.context ?? 'unknown') : [],
  };
}

/** The gaps a report implies. Order is the order of GAP_NAMES. */
function findGaps(report: Omit<Inventory, 'gaps'>): Gap[] {
  const gaps: Gap[] = [];
  if (report.ruleset === null) gaps.push('ruleset:absent');
  else if (report.ruleset.requiredApprovingReviewCount < 1) gaps.push('ruleset:review-not-required');
  if (SEEDED_LABELS.some((name) => !report.labels.includes(name))) gaps.push('labels:missing');
  if (OWNED_HOOKS.some((name) => !report.hooks.includes(name))) gaps.push('hooks:not-installed');
  if (OWNED_WORKFLOWS.some((name) => !report.workflows.includes(name))) gaps.push('workflows:missing');
  if (report.test === null) gaps.push('test-command:none');
  return gaps;
}

type RepoView = { default_branch?: unknown; allow_auto_merge?: unknown; delete_branch_on_merge?: unknown };

/**
 * Describes the repository at `root` without changing anything: three `gh`
 * reads, one `git` read and the filesystem. Returns `{ error }` — never a
 * partial report — when any of those reads cannot answer.
 */
export function takeInventory(root: string, gh: GhRunner, git: GitRunner): InventoryResult {
  const repo = readJson<RepoView>(gh, ['api', 'repos/{owner}/{repo}'], 'repository:unreadable');
  if (!repo.ok) return { error: repo.error };
  // Fail closed on every field of this read, not only the branch name: a
  // merge setting missing from the response is "could not be read", and
  // reporting it as `false` is exactly the silent absence the header forbids.
  const defaultBranch = repo.value?.default_branch;
  const autoMerge = repo.value?.allow_auto_merge;
  const deleteBranchOnMerge = repo.value?.delete_branch_on_merge;
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) return { error: 'repository:unreadable' };
  if (typeof autoMerge !== 'boolean' || typeof deleteBranchOnMerge !== 'boolean') return { error: 'repository:unreadable' };

  const rules = readJson<BranchRule[]>(gh, ['api', `repos/{owner}/{repo}/rules/branches/${defaultBranch}`], 'ruleset:unreadable');
  if (!rules.ok) return { error: rules.error };
  if (!Array.isArray(rules.value)) return { error: 'ruleset:unreadable' };

  const labels = readJson<Array<{ name?: unknown }>>(
    gh,
    ['label', 'list', '--json', 'name', '--limit', String(LABEL_LIST_LIMIT)],
    'labels:unreadable',
  );
  if (!labels.ok) return { error: labels.error };
  if (!Array.isArray(labels.value)) return { error: 'labels:unreadable' };
  // A page that came back full is the only signal `gh` gives that there may
  // be more: it reports no total and no cursor. Measured on what the read
  // returned, before the empty names below are dropped, because it is a fact
  // about the read and not about the names that survived it.
  const labelsTruncated = labels.value.length >= LABEL_LIST_LIMIT;

  const hooksDir = gitHooksDir(root, git);
  if (!hooksDir.ok) return { error: hooksDir.error };
  const hooks = installedHooks(hooksDir.value);
  if (!hooks.ok) return { error: hooks.error };

  const workflows = workflowFiles(root);
  if (!workflows.ok) return { error: workflows.error };

  const detected = detectCommands(root);
  const report = {
    stack: detected.stack,
    test: detected.test,
    check: detected.check,
    source: detected.source,
    defaultBranch,
    ruleset: toRuleset(rules.value),
    labels: labels.value.map((l) => String(l?.name ?? '')).filter((name) => name.length > 0).sort(),
    labelsTruncated,
    hooks: hooks.value,
    workflows: workflows.value,
    autoMerge,
    deleteBranchOnMerge,
  };
  return { ...report, gaps: findGaps(report) };
}
