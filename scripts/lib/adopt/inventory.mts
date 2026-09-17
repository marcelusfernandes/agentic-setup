// What a repository already has, read and nothing else (#162). Adoption's
// first step is the one nothing did before: look at the repository and say
// what is there, before writing a single byte into someone else's tree.
//
// `takeInventory(root, gh)` is pure in the sense that matters here: every
// effect it can have goes through the `gh` runner handed to it, and it only
// ever asks that runner for reads (`api repos/{owner}/{repo}`, the default
// branch's effective rules, `label list`). Everything else comes off the
// filesystem under `root`. The check and test commands, the stack and the
// detection source come from `ci/lib/detect.mts` unchanged — this file adds
// no detector and knows nothing about stacks.
//
// **Crash policy: fail closed.** A read that cannot answer returns
// `{ error: <named reason> }` and the caller exits non-zero; no field is
// ever reported as absent because the read failed. "No ruleset" and "the
// ruleset could not be read" are different answers and this file never
// conflates them.
//
// Node built-ins only.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { detectCommands } from '../../../ci/lib/detect.mts';

export type GhResult = { status: number; stdout: string; stderr: string };
/** Runs `gh` with the given argv and reports what it printed. */
export type GhRunner = (args: string[]) => GhResult;

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

/** The git hooks `scripts/init.mts` installs into the adopting repository. */
export const OWNED_HOOKS = ['pre-push'];

/** The marker every hook this setup installs carries in its text. */
const HOOK_MARKER = 'agentic-setup';

/** Every gap this inventory can name. A gap is a fact, not a judgement. */
export const GAP_NAMES = [
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
  let result: GhResult;
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

/**
 * The hooks directory git would actually run: `<root>/.git/hooks` for an
 * ordinary clone, and the *common* directory's hooks for a worktree, whose
 * `.git` is a file pointing at `…/.git/worktrees/<name>` (which has a
 * `commondir` file and no hooks of its own).
 */
function gitHooksDir(root: string): string {
  const dotGit = join(root, '.git');
  try {
    if (statSync(dotGit).isDirectory()) return join(dotGit, 'hooks');
    const pointer = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!pointer) return join(dotGit, 'hooks');
    const gitDir = resolve(root, pointer[1].trim());
    const commonFile = join(gitDir, 'commondir');
    const common = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim()) : gitDir;
    return join(common, 'hooks');
  } catch {
    return join(dotGit, 'hooks');
  }
}

/** The names of this setup's hooks that are installed and recognisably ours. */
function installedHooks(root: string): string[] {
  const dir = gitHooksDir(root);
  return OWNED_HOOKS.filter((name) => {
    try {
      return readFileSync(join(dir, name), 'utf8').includes(HOOK_MARKER);
    } catch {
      return false;
    }
  });
}

/** Every workflow file present in `.github/workflows`, sorted. */
function workflowFiles(root: string): string[] {
  const dir = join(root, '.github', 'workflows');
  try {
    return readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .sort();
  } catch {
    return [];
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
export function findGaps(report: Omit<Inventory, 'gaps'>): Gap[] {
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
 * reads plus the filesystem. Returns `{ error }` — never a partial report —
 * when any of those reads cannot answer.
 */
export function takeInventory(root: string, gh: GhRunner, env: NodeJS.ProcessEnv = process.env): InventoryResult {
  const repo = readJson<RepoView>(gh, ['api', 'repos/{owner}/{repo}'], 'repository:unreadable');
  if (!repo.ok) return { error: repo.error };
  const defaultBranch = repo.value?.default_branch;
  if (typeof defaultBranch !== 'string' || defaultBranch.length === 0) return { error: 'repository:unreadable' };

  const rules = readJson<BranchRule[]>(gh, ['api', `repos/{owner}/{repo}/rules/branches/${defaultBranch}`], 'ruleset:unreadable');
  if (!rules.ok) return { error: rules.error };
  if (!Array.isArray(rules.value)) return { error: 'ruleset:unreadable' };

  const labels = readJson<Array<{ name?: unknown }>>(gh, ['label', 'list', '--json', 'name', '--limit', '200'], 'labels:unreadable');
  if (!labels.ok) return { error: labels.error };
  if (!Array.isArray(labels.value)) return { error: 'labels:unreadable' };

  const detected = detectCommands(root, env);
  const report = {
    stack: detected.stack,
    test: detected.test,
    check: detected.check,
    source: detected.source,
    defaultBranch,
    ruleset: toRuleset(rules.value),
    labels: labels.value.map((l) => String(l?.name ?? '')).filter((name) => name.length > 0).sort(),
    hooks: installedHooks(root),
    workflows: workflowFiles(root),
    autoMerge: repo.value?.allow_auto_merge === true,
    deleteBranchOnMerge: repo.value?.delete_branch_on_merge === true,
  };
  return { ...report, gaps: findGaps(report) };
}
