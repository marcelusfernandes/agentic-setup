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
