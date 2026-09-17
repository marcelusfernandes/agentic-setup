// Parses the `## Files` sections of an issue and a PR body, and checks a
// list of changed files against them. See docs/workflow.md, "Issue" and
// "PR": only bullet lines count as the issue's globs; only `authorised:`
// lines grant anything, and only in the **issue** body (#155 — the
// implementer writes the PR body, so a grant there would be a self-grant);
// only backtick-quoted spans are globs when any are present, otherwise the
// first whitespace-delimited token is.
import { matchesAny } from './globs.mts';

/**
 * The line indices of `lines` that sit under `## <heading>` up to the next
 * `## `: `start` is the first line after the heading, `end` is exclusive.
 * `null` when the heading is absent. Shared by `extractSection` and
 * `findMisplacedAuthorisedLines` so both agree on where a section starts
 * and ends.
 */
function sectionLineRange(lines: string[], heading: string): { start: number; end: number } | null {
  const headingIndex = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(l.trim()));
  if (headingIndex === -1) return null;
  const rest = lines.slice(headingIndex + 1);
  const relativeEnd = rest.findIndex((l) => /^##\s+\S/.test(l.trim()));
  const end = relativeEnd === -1 ? lines.length : headingIndex + 1 + relativeEnd;
  return { start: headingIndex + 1, end };
}

/**
 * The text under `## <heading>` up to the next `## `.
 */
export function extractSection(body: string | null | undefined, heading: string): string | null {
  const lines = String(body ?? '').split(/\r?\n/);
  const range = sectionLineRange(lines, heading);
  if (range === null) return null;
  return lines.slice(range.start, range.end).join('\n');
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
 * The globs granted by `authorised:` lines (bullet or bare) in a body's
 * `## Files` section; every other line there is prose. One glob per line
 * (invariant 5): trailing prose is ignored when the glob is backticked,
 * otherwise the first whitespace-delimited token wins. Shared by the issue
 * and PR parsers below so the two read a grant identically — what differs
 * is only whose body is allowed to carry one.
 */
function authorisedGlobsIn(body: string): string[] {
  const section = extractSection(body, 'Files');
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

/**
 * The grants that actually widen the scope check: `authorised:` lines in
 * the `## Files` section of an issue the PR closes. The orchestrator writes
 * the issue at dispatch and the implementer has no reason to edit it, so a
 * grant here cannot be a self-grant (#155). A bare (non-bullet) line is
 * accepted too — `parseIssueGlobs` reads bullets only, so the two parsers
 * never disagree about which line is a grant.
 */
export function parseIssueAuthorisedGlobs(issueBody: string): string[] {
  return authorisedGlobsIn(issueBody);
}

/**
 * The `authorised:` lines in the PR's own `## Files` section. These grant
 * nothing since #155 — the implementer writes that body — but `scope`
 * still parses them so it can report a grant written in the wrong place as
 * ignored, with the reason, instead of failing on the file in silence.
 */
export function parseAuthorisedGlobs(prBody: string): string[] {
  return authorisedGlobsIn(prBody);
}

/**
 * The `authorised:` lines (trimmed, bullet marker removed) that appear
 * outside the PR's `## Files` section — `parseAuthorisedGlobs` never sees
 * these, so a grant written here silently doesn't count. When the PR body
 * has no `## Files` section at all, every `authorised:` line is outside it.
 * See #83.
 */
export function findMisplacedAuthorisedLines(prBody: string): string[] {
  const lines = String(prBody ?? '').split(/\r?\n/);
  const range = sectionLineRange(lines, 'Files');
  const misplaced: string[] = [];
  lines.forEach((raw, i) => {
    if (range !== null && i >= range.start && i < range.end) return;
    const line = raw.trim().replace(/^[-*]\s+/, '');
    if (/^authorised:\s*\S/i.test(line)) misplaced.push(line);
  });
  return misplaced;
}

export const FILE_LINE_LIMIT = 800;

export type FileLinesEntry = { path: string; baseLines: number | null; headLines: number; generated: boolean };
export type FileGrowth = { path: string; baseLines: number | null; headLines: number };

/**
 * A file that is new or grew past FILE_LINE_LIMIT, unless its first line
 * marks it `@generated`. `baseLines` is null for a file that did not exist
 * at the base (new at head) — that always counts as "grew" when it lands
 * over the limit. A file already over the limit that shrinks or holds
 * steady is not a violation: only crossing further, or landing over it for
 * the first time, is.
 */
export function fileGrowth(entries: FileLinesEntry[]): FileGrowth[] {
  const out: FileGrowth[] = [];
  for (const { path, baseLines, headLines, generated } of entries) {
    if (generated) continue;
    if (headLines <= FILE_LINE_LIMIT) continue;
    if (baseLines !== null && headLines <= baseLines) continue;
    out.push({ path, baseLines, headLines });
  }
  return out;
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
 * Strips fenced code blocks and inline code spans so a keyword quoted as an
 * example (in a fence or backticks) is never mistaken for a real link.
 */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

/**
 * The issue numbers a PR body links via a GitHub closing keyword, in order
 * of first appearance, deduplicated. A bare `#N` with no keyword before it
 * is not a linked issue and is ignored, and so is a keyword that only
 * appears inside a fenced code block or an inline code span (unlike
 * `parseAuthorisedGlobs`, which reads backticks deliberately).
 */
export function parseLinkedIssues(prBody: string | null | undefined): number[] {
  const text = stripCode(String(prBody ?? ''));
  const seen = new Set<number>();
  const result: number[] = [];
  for (const m of text.matchAll(LINKED_ISSUE_RE)) {
    const n = Number(m[1]);
    if (!seen.has(n)) {
      seen.add(n);
      result.push(n);
    }
  }
  return result;
}

export type LinkedIssueGlobs = { issue: number | null; globs: string[]; authorised: string[] };

/**
 * Parses the `## Files` globs and `authorised:` grants of several linked
 * issues, keeping each one's source issue so the job summary can attribute
 * both.
 */
export function collectLinkedGlobs(issues: Array<{ issue: number | null; body: string }>): LinkedIssueGlobs[] {
  return issues.map(({ issue, body }) => ({
    issue,
    globs: parseIssueGlobs(body),
    authorised: parseIssueAuthorisedGlobs(body),
  }));
}
