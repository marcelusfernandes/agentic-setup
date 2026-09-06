// Pure parsing helpers for the issue contract that ci/issue-lint.mts checks.
// Reuses ci/lib/scope.mts's extractSection instead of re-implementing
// section slicing; scope.mts stays untouched.
import { extractSection } from './scope.mts';

export const REQUIRED_SECTIONS = ['Context', 'Goal', 'Acceptance criteria', 'Proof', 'Files', 'Dependencies'] as const;
export type SectionName = (typeof REQUIRED_SECTIONS)[number];

/**
 * The text under each of the six required `## <heading>` sections, or
 * `null` per heading that is missing from the body. Mirrors
 * `extractSection`'s "up to the next `## `" slicing for every heading in
 * one pass.
 */
export function sections(body: string): Record<SectionName, string | null> {
  const out = {} as Record<SectionName, string | null>;
  for (const heading of REQUIRED_SECTIONS) out[heading] = extractSection(body, heading);
  return out;
}

export type Checkbox = { checked: boolean; text: string };

/**
 * Every `- [ ]`/`- [x]` line in a section (bullet or `*`), in order.
 * `null` (section missing) reads as no checkboxes.
 */
export function checkboxes(section: string | null): Checkbox[] {
  if (!section) return [];
  const out: Checkbox[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const m = raw.trim().match(/^[-*]\s+\[([ xX])\]\s*(.*)$/);
    if (m) out.push({ checked: m[1].toLowerCase() === 'x', text: m[2].trim() });
  }
  return out;
}

/**
 * `Blocked by: #3, #4` (or `none`) from the issue body's `## Dependencies`
 * section (falling back to the whole body if the section itself is
 * missing, so a malformed heading still yields an answer for this one
 * check). A bare number (`Blocked by: 32`, no `#`) is accepted too — the
 * `#` is a formatting convention, not the signal. Returns `null` when no
 * `Blocked by:` line exists at all — the caller treats that as a
 * missing-section failure, distinct from an empty array (`none`, or a line
 * with no number in it).
 */
export function blockedBy(body: string): number[] | null {
  const section = extractSection(body, 'Dependencies') ?? body;
  const line = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^blocked by:/i.test(l));
  if (!line) return null;
  const rest = line.replace(/^blocked by:/i, '').trim();
  if (/^none\b/i.test(rest)) return [];
  return [...rest.matchAll(/#?(\d+)/g)].map((m) => Number(m[1]));
}
