// Parses the `## Files` sections of an issue and a PR body, and checks a
// list of changed files against them. See docs/workflow.md, "Issue" and
// "PR": only bullet lines count in the issue; only `authorised:` lines
// count in the PR; only backtick-quoted spans are globs when any are
// present, otherwise the first whitespace-delimited token is.
import { matchesAny } from './globs.mts';

/**
 * The text under `## <heading>` up to the next `## `.
 */
export function extractSection(body: string | null | undefined, heading: string): string | null {
  const lines = String(body ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(l.trim()));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s+\S/.test(l.trim()));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);
}

/**
 * One or more globs per bullet line, backticked or bare, comma-separated.
 * Prose lines (no leading `-`/`*`) are ignored.
 */
export function parseIssueGlobs(issueBody: string): string[] {
  const section = extractSection(issueBody, 'Files');
  if (section === null) return [];
  const globs: string[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const bullet = raw.trim().match(/^[-*]\s+(.*)$/);
    if (!bullet) continue;
    const quoted = backticked(bullet[1]);
    if (quoted.length) {
      globs.push(...quoted);
      continue;
    }
    globs.push(...bullet[1].split(',').map((g) => g.trim()).filter((g) => g && !/\s/.test(g)));
  }
  return globs;
}

/**
 * Only `authorised:` lines (bullet or bare) grant globs; the rest of the
 * PR's `## Files` section is prose. Trailing prose on an `authorised:` line
 * is ignored when the glob is backticked; otherwise the first token wins.
 */
export function parseAuthorisedGlobs(prBody: string): string[] {
  const section = extractSection(prBody, 'Files');
  if (section === null) return [];
  const globs: string[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[-*]\s+/, '');
    const m = line.match(/^authorised:\s*(.*)$/i);
    if (!m || !m[1].trim()) continue;
    const quoted = backticked(m[1]);
    if (quoted.length) {
      globs.push(...quoted);
      continue;
    }
    const bare = m[1].trim().split(/\s+/)[0]?.replace(/[,;]+$/, '');
    if (bare) globs.push(bare);
  }
  return globs;
}

export function checkScope({ files, issueGlobs, authorisedGlobs = [] }: { files: string[]; issueGlobs: string[]; authorisedGlobs?: string[] }) {
  const globs = [...issueGlobs, ...authorisedGlobs];
  const violations = files.filter((f) => !matchesAny(f, globs));
  return { ok: violations.length === 0, violations, globs };
}

// GitHub closes an issue on Closes/Fixes/Resolves (and close/closed,
// fix/fixed, resolve/resolved), each optionally followed by a colon before
// the `#N`. See docs/workflow.md, "PR": `Closes #N` is plain text.
const LINKED_ISSUE_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)/gi;

/**
 * The issue numbers a PR body links via a GitHub closing keyword, in order
 * of first appearance, deduplicated. A bare `#N` with no keyword before it
 * is not a linked issue and is ignored.
 */
export function parseLinkedIssues(prBody: string | null | undefined): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const m of String(prBody ?? '').matchAll(LINKED_ISSUE_RE)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }
  return result;
}

export type LinkedIssueGlobs = { issue: number | null; globs: string[] };

/**
 * Parses the `## Files` globs of several linked issues, keeping each
 * glob's source issue so the job summary can attribute it.
 */
export function collectLinkedGlobs(issues: Array<{ issue: number | null; body: string }>): LinkedIssueGlobs[] {
  return issues.map(({ issue, body }) => ({ issue, globs: parseIssueGlobs(body) }));
}
