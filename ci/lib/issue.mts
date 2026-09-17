// Pure parsing helpers for the issue contract that ci/issue-lint.mts checks.
// Reuses ci/lib/scope.mts's extractSection instead of re-implementing
// section slicing; scope.mts stays untouched.
import { extractSection } from './scope.mts';

export const REQUIRED_SECTIONS = ['Context', 'Goal', 'Acceptance criteria', 'Proof', 'Files', 'Dependencies'] as const;
export type SectionName = (typeof REQUIRED_SECTIONS)[number];

/**
 * The headings accepted for the `Proof` section: `Proof` is this route's
 * name, `Validation` the Codex route's name for the same section (#114).
 * A task written for either route lints clean without a second heading.
 */
export const PROOF_HEADINGS = ['Proof', 'Validation'] as const;

/** The first non-empty of the accepted proof headings; else the first present one; else `null`. */
function proofSection(body: string): string | null {
  const present = PROOF_HEADINGS.map((heading) => extractSection(body, heading)).filter((text): text is string => text !== null);
  return present.find((text) => text.trim() !== '') ?? present[0] ?? null;
}

/**
 * The text under each of the six required `## <heading>` sections, or
 * `null` per heading that is missing from the body. Mirrors
 * `extractSection`'s "up to the next `## `" slicing for every heading in
 * one pass; `Proof` reads through `proofSection` so either accepted
 * heading fills it.
 */
export function sections(body: string): Record<SectionName, string | null> {
  const out = {} as Record<SectionName, string | null>;
  for (const heading of REQUIRED_SECTIONS) out[heading] = heading === 'Proof' ? proofSection(body) : extractSection(body, heading);
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

/** The shape a declaration path must have: `proof/<slug>.json` (#136). */
export const PROOF_DECLARATION_PATH = /^proof\/[a-z0-9-]+\.json$/;

/**
 * The optional `Declaration: proof/<slug>.json` line of the `## Proof`
 * section (#136), as written — the path is returned raw (one pair of
 * surrounding backticks stripped, because the section is prose and the
 * templates show the path backticked), and `ci/issue-lint.mts` is what
 * judges it against `PROOF_DECLARATION_PATH`.
 *
 * `null` when the section carries no such line at all: the declaration is
 * optional and its absence is never a failure. An empty value (`Declaration:`
 * with nothing after it) returns `''`, which the lint rejects — a line that
 * announces a declaration and names none is a mistake, not an absence.
 *
 * The line is read from the `## Proof`/`## Validation` section only, so the
 * word cannot be picked up from prose elsewhere in the body. It is read for
 * linting and never to locate a file to execute: `ci/negative-control.mts`
 * derives the slug from the branch, never from the issue (invariant 9).
 */
export function proofDeclaration(body: string): string | null {
  const section = proofSection(body);
  if (section === null) return null;
  for (const raw of section.split(/\r?\n/)) {
    const m = raw.trim().match(/^(?:[-*]\s+)?Declaration:(.*)$/i);
    if (!m) continue;
    const value = m[1].trim();
    return /^`[^`]*`$/.test(value) ? value.slice(1, -1).trim() : value;
  }
  return null;
}
