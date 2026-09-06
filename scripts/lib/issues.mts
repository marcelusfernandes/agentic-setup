// Shared issue-body/title parsing used by scripts/reconcile.mts (loop state)
// and scripts/claim.mts (claimability checks + branch naming). Node
// built-ins only, no dependency.
import { extractSection } from '../../ci/lib/scope.mts';

/** Conventional-commit types a branch name (and PR title) may start with. */
export const BRANCH_TYPES = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'ci', 'deps'];

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
