// Shared issue-body/title parsing used by scripts/reconcile.mts (loop state)
// and scripts/claim.mts (claimability checks + branch naming), and the one
// place that says which branch names lock an issue — both routes' shapes,
// so neither can start work the other already holds. Node built-ins only,
// no dependency.
import { extractSection } from '../../ci/lib/scope.mts';

/** Conventional-commit types a branch name (and PR title) may start with. */
export const BRANCH_TYPES = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'ci', 'deps'];

/**
 * Branch type -> the `type:` label `scripts/init.mts` creates (`feature`,
 * `bug`, `refactor`, `infra`, `spec`, `docs`, `deps`). The two sets are not
 * the same: `feat` is labelled `feature`, `fix` is labelled `bug`, and
 * `chore`, `test` and `ci` all collapse into the single `infra` label.
 * `spec` is a label with no branch type of its own. The orchestrator writes
 * the label at claim time (`scripts/claim.mts`), so no agent labels its own
 * work.
 */
export const TYPE_LABELS: Record<string, string> = {
  feat: 'feature',
  fix: 'bug',
  refactor: 'refactor',
  chore: 'infra',
  docs: 'docs',
  test: 'infra',
  ci: 'infra',
  deps: 'deps',
};

/** The `type:<label>` name for a branch type, or null when there is none. */
export function typeLabel(type: string): string | null {
  const label = TYPE_LABELS[type];
  return label ? `type:${label}` : null;
}

/**
 * The Codex route's lock branch for an issue
 * (`.agents/skills/autonomous-loop/scripts/github.mts`): one canonical name
 * per issue, independent of title and slug, so it never matches the Claude
 * route's `<type>/<n>-<slug>` shape.
 */
export function codexLockBranch(number: number): string {
  return `codex/task-${number}`;
}

/**
 * Whether `branch` is a branch name that locks issue `number`. Both routes
 * take a pushed branch as the lock, in namespaces that cannot see each
 * other: `<type>/<n>-<slug>` (`scripts/claim.mts`) and `codex/task-<n>`
 * (the Codex loop). This is the single place those shapes are written
 * down — `scripts/reconcile.mts` resolves an issue's branch through it and
 * `scripts/claim.mts` refuses a claim when one already exists on the
 * remote, so an issue locked by either route reads as held by the other.
 */
export function locksIssue(branch: string, number: number): boolean {
  return new RegExp(`^[a-z]+/${number}-`).test(branch) || branch === codexLockBranch(number);
}

/**
 * Every branch in `branches` that locks issue `number`, the Claude route's
 * own `<type>/<n>-<slug>` shape first: should an issue somehow carry both
 * locks, the branch a Claude-route agent can act on is the one reported.
 */
export function lockBranches(number: number, branches: Iterable<string>): string[] {
  const found = [...branches].filter((branch) => locksIssue(branch, number));
  const codex = codexLockBranch(number);
  return [...found.filter((branch) => branch !== codex), ...found.filter((branch) => branch === codex)];
}

/** "Blocked by: #3, #4" (or "none") from the issue body's Dependencies section. */
export function parseBlockedBy(body: string): number[] {
  const section = extractSection(body, 'Dependencies') ?? body;
  const line = section.split(/\r?\n/).map((l) => l.trim()).find((l) => /^blocked by:/i.test(l));
  if (!line) return [];
  const rest = line.replace(/^blocked by:/i, '').trim();
  if (/^none\b/i.test(rest)) return [];
  return [...rest.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
}

/**
 * The conventional-commit type prefix on an issue title — "feat(ci): …" and
 * "fix: …" both yield their leading word — or null when the title has no
 * such prefix, or the prefix is not one of BRANCH_TYPES.
 */
export function titleType(title: string): string | null {
  const m = title.match(/^([a-z]+)(?:\([^)]*\))?:/);
  if (!m) return null;
  return BRANCH_TYPES.includes(m[1]) ? m[1] : null;
}

/** Whether the issue body has a `## Files` section with at least one bullet line. */
export function hasFilesBullet(body: string): boolean {
  const section = extractSection(body, 'Files');
  if (section === null) return false;
  return section.split(/\r?\n/).some((l) => /^[-*]\s+\S/.test(l.trim()));
}
