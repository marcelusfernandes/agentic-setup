// Parses the `## Files` sections of an issue and a PR body, and checks a
// list of changed files against them. See docs/workflow.md, "Issue" and
// "PR": only bullet lines count as the issue's globs, and a bullet whose
// content starts `authorised:` is a grant rather than one of them (#231);
// only `authorised:` lines grant anything, and only in the **issue** body
// (#155 — the implementer writes the PR body, so a grant there would be a
// self-grant); only backtick-quoted spans are globs when any are present,
// otherwise the first whitespace-delimited token is. A grant line carrying
// more than one backticked span grants nothing at all and is reported by
// `findMultiGlobGrantLines` instead (#316).
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
 * The text after `authorised:` on a line, bullet marker stripped — `null`
 * when the line is not a grant, `''` when it grants nothing. The single
 * recogniser every parser below shares, so which line is a grant is decided
 * in one place instead of by two regexes that happen to agree (#231).
 */
function grantRemainder(rawLine: string): string | null {
  const line = rawLine.trim().replace(/^[-*]\s+/, '');
  const m = line.match(/^authorised:\s*(.*)$/i);
  return m ? m[1] : null;
}

/**
 * One or more globs per bullet line, backticked or bare, comma-separated.
 * Prose lines (no leading `-`/`*`) are ignored, and so is a bullet that is
 * a grant: `authorisedGlobsIn` reads that line, and reading it here too
 * would put the granted path in `issueGlobs` as well — a second, unaudited
 * route to the same widening, and one `ci/issue-lint.mts` (which reads this
 * parser alone) cannot tell from real scope (#231).
 */
export function parseIssueGlobs(issueBody: string): string[] {
  const section = extractSection(issueBody, 'Files');
  if (section === null) return [];
  const globs: string[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const bullet = raw.trim().match(/^[-*]\s+(.*)$/);
    if (!bullet) continue;
    if (grantRemainder(raw) !== null) continue;
    const quoted = backticked(bullet[1]);
    if (quoted.length) {
      globs.push(...quoted);
      continue;
    }
    globs.push(...bullet[1].split(',').map((g) => g.trim()).filter((g) => g && !/\s/.test(g)));
  }
  return globs;
}

type GrantLine = { line: string; spans: string[]; remainder: string };

/**
 * One `authorised:` line, read once: the line itself (trimmed, bullet marker
 * removed, the form `findMisplacedAuthorisedLines` already reports) and every
 * backticked span on it. `null` when the line is not a grant, or grants
 * nothing.
 *
 * The single reader of a grant's *content*, the way `grantRemainder` is the
 * single reader of whether a line is one (#231). What `authorisedGlobsIn`
 * refuses and what `findMultiGlobGrantLines` reports are therefore the same
 * decision taken once, rather than two span counts that have to agree.
 */
function readGrantLine(rawLine: string): GrantLine | null {
  const remainder = grantRemainder(rawLine);
  if (remainder === null || !remainder.trim()) return null;
  return { line: rawLine.trim().replace(/^[-*]\s+/, ''), spans: backticked(remainder), remainder };
}

/**
 * The globs granted by `authorised:` lines (bullet or bare) in a body's
 * `## Files` section; every other line there is prose. One glob per line
 * (invariant 5), and since #316 that is enforced rather than conventional:
 * a line carrying more than one backticked span grants **nothing** — see
 * `findMultiGlobGrantLines`, which names it. Exactly one span grants that
 * span; no span at all falls back to the first whitespace-delimited token,
 * trailing `,`/`;` stripped, so a bare comma list grants its first entry and
 * nothing else.
 *
 * Refusing rather than taking the first span is the point: narrowing would
 * trade a silent over-grant for a silent under-grant, and a line with two
 * spans is a line whose author meant something this format cannot express.
 * The direction matters — an over-grant fails open, quietly widening the
 * audited scope, while a refusal fails closed, as something a person reads.
 *
 * Shared by the issue and PR parsers below so the two read a grant
 * identically — what differs is only whose body is allowed to carry one.
 */
function authorisedGlobsIn(body: string): string[] {
  const section = extractSection(body, 'Files');
  if (section === null) return [];
  const globs: string[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const grant = readGrantLine(raw);
    if (grant === null) continue;
    if (grant.spans.length > 1) continue; // refused, not narrowed (#316)
    if (grant.spans.length === 1) {
      globs.push(grant.spans[0]);
      continue;
    }
    const bare = grant.remainder.trim().split(/\s+/)[0]?.replace(/[,;]+$/, '');
    if (bare) globs.push(bare);
  }
  return globs;
}

export type MultiGlobGrant = { line: string; spans: string[] };

/**
 * The `authorised:` lines of a body's `## Files` section that carry more than
 * one backticked span — the lines `authorisedGlobsIn` refuses. Each entry
 * carries the line as written (trimmed, bullet marker removed) and every span
 * on it, so the caller can name both halves of what was refused instead of
 * reporting a count.
 *
 * Read by `ci/issue-lint.mts`, which turns each entry into a failure: the
 * refusal has to reach the orchestrator at dispatch, where the line is
 * written, rather than at the `scope` check on somebody else's pull request
 * (#316). A justification belongs on the next line, indented and not a
 * bullet; a bare (unbackticked) justification on the same line is fine, since
 * it adds no span.
 */
export function findMultiGlobGrantLines(body: string): MultiGlobGrant[] {
  const section = extractSection(body, 'Files');
  if (section === null) return [];
  const refused: MultiGlobGrant[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const grant = readGrantLine(raw);
    if (grant !== null && grant.spans.length > 1) refused.push({ line: grant.line, spans: grant.spans });
  }
  return refused;
}

/**
 * The grants that actually widen the scope check: `authorised:` lines in
 * the `## Files` section of an issue the PR closes. The orchestrator writes
 * the issue at dispatch and the implementer has no reason to edit it, so a
 * grant here cannot be a self-grant (#155). A bare (non-bullet) line is
 * accepted too, and a bullet one is read here alone: both parsers ask
 * `grantRemainder`, so the answer to "is this line a grant" is one answer,
 * not two that have to agree (#231).
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
    if (grantRemainder(raw)?.trim()) misplaced.push(raw.trim().replace(/^[-*]\s+/, ''));
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

// The mechanism of the loop: a hook, a CI check, a script, a skill card or
// a workflow. A change here changes the contract the next agent runs under,
// which is what `docs/decisions/README.md` says earns a numbered decision.
// `tests/**` and `templates/**` are deliberately out — they follow a
// mechanism change rather than deciding one (#180).
export const MECHANISM_GLOBS = ['hooks/**', 'ci/**', 'scripts/**', 'skills/**/SKILL.md', '.github/workflows/**'];

// Any of these in the same diff means the decision was recorded: item 1-13
// live in `docs/decisions.md`, everything after them is one dated file
// under `docs/decisions/`.
export const DECISION_GLOBS = ['docs/decisions.md', 'docs/decisions/**'];

/**
 * The mechanism files a diff changes while recording no decision — empty
 * when the same diff also touches `docs/decisions.md` or anything under
 * `docs/decisions/`. Order follows the diff, so the warning reads in the
 * order `git diff --name-only` printed.
 *
 * A nudge, never a verdict: the caller reports it as a `warning:` and still
 * exits 0. A required check cannot tell from a file name whether a change
 * deserves a decision entry, and failing on that guess would gate every
 * mechanism PR on a judgement it cannot make (the decision on #180). The
 * binding half stays where a judgement is possible: the reviewer's
 * checklist and the milestone closeout.
 */
export function decisionNudge(files: string[]): string[] {
  if (files.some((f) => matchesAny(f, DECISION_GLOBS))) return [];
  return files.filter((f) => matchesAny(f, MECHANISM_GLOBS));
}

// The mechanism the dogfood loop itself runs on (#182). Deliberately
// narrower than MECHANISM_GLOBS: a workflow file decides what CI runs, but a
// dogfood pass exercises the hooks, the checks, the scripts and the skill
// cards an agent actually meets, which is the list #181 and #182 both name.
export const DOGFOOD_GLOBS = ['hooks/**', 'ci/**', 'scripts/**', 'skills/**/SKILL.md'];

// A dated report under `docs/dogfood/`, the format #183 defines. Matched by
// shape rather than by the `docs/dogfood/**` glob on purpose: the README and
// the template that will live beside the reports are not reports, and must
// not silence the nudge.
export const DOGFOOD_REPORT_RE = /docs\/dogfood\/\d{4}-\d{2}-\d{2}\.md/;

/**
 * The mechanism files a diff changes while pointing at no dogfood report —
 * empty when the PR body names a `docs/dogfood/<date>.md` path or the diff
 * itself carries one. Order follows the diff, like `decisionNudge`.
 *
 * "The diff adds one" is read as "the diff contains one": `git diff
 * --name-only` cannot tell an added file from an edited one, and editing the
 * report of the pass that is being reported on is the same claim.
 *
 * A nudge, never a verdict: the caller reports it as a `warning:` and still
 * exits 0, the same shape the decision nudge settled on (#180). A required
 * check cannot tell from a file name whether a dogfood run was owed. The
 * binding half is once per phase, in `scripts/close-milestone.mts`, where the
 * whole phase is visible.
 */
export function dogfoodTrigger(files: string[], prBody?: string | null): string[] {
  if (DOGFOOD_REPORT_RE.test(String(prBody ?? ''))) return [];
  if (files.some((f) => DOGFOOD_REPORT_RE.test(f))) return [];
  return files.filter((f) => matchesAny(f, DOGFOOD_GLOBS));
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
