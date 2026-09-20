// Parses the `## Files` sections of an issue and a PR body, and checks a
// list of changed files against them. See docs/workflow.md, "Issue" and
// "PR": only bullet lines count as the issue's globs, and a bullet whose
// content starts `authorised:` is a grant rather than one of them (#231);
// only `authorised:` lines grant anything, and only in the **issue** body
// (#155 — the implementer writes the PR body, so a grant there would be a
// self-grant); a grant's glob is the line's one backticked span when it has
// one, and otherwise its first whitespace-delimited token. Two shapes grant
// nothing at all and are reported instead of read: more than one backticked
// span (`findMultiGlobGrantLines`, #316), and a bare glob on a line that
// also carries a span — a justification written in backticks
// (`findBareGlobBacktickedJustificationLines`, #357).
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

type GrantLine = { line: string; spans: string[]; remainder: string; bare: string };

/**
 * One `authorised:` line, read once: the line itself (trimmed, bullet marker
 * removed, the form `findMisplacedAuthorisedLines` already reports), every
 * backticked span on it, and its first whitespace-delimited token with a
 * trailing `,`/`;` stripped — the `bare` glob, which is what the line grants
 * when it carries no span and what names the refusal when it carries one
 * behind that token. `null` when the line is not a grant, or grants nothing.
 *
 * The single reader of a grant's *content*, the way `grantRemainder` is the
 * single reader of whether a line is one (#231). What `authorisedGlobsIn`
 * refuses and what the two finders report are therefore the same decision
 * taken once, rather than span counts in three places that have to agree.
 */
function readGrantLine(rawLine: string): GrantLine | null {
  const remainder = grantRemainder(rawLine);
  if (remainder === null || !remainder.trim()) return null;
  return {
    line: rawLine.trim().replace(/^[-*]\s+/, ''),
    spans: backticked(remainder),
    remainder,
    bare: remainder.trim().split(/\s+/)[0].replace(/[,;]+$/, ''),
  };
}

/** The two shapes a grant line takes that grant nothing at all. */
export type GrantRefusal = 'multi-span' | 'bare-glob-backticked-justification';

/**
 * Why a grant line grants nothing, or `null` when it grants normally. One
 * line draws at most one refusal, and the order below is what keeps the two
 * apart: a line with several spans is `multi-span` whatever precedes them, so
 * an author fixing one mistake is never handed the other one's remedy (#357
 * AC3).
 *
 * - `multi-span` — more than one backticked span, so which one is the glob
 *   cannot be told from the line (#316).
 * - `bare-glob-backticked-justification` — exactly one span, but the line
 *   does not open with it: the glob is the bare token in front, and the span
 *   is a justification. Reading the span granted the path the author was
 *   *pointing at* and lost the glob they wrote — both halves wrong from one
 *   line, the granting half failing open, exactly as #316's shape did (#357).
 *
 * Both are refused rather than narrowed to the glob that is probably meant:
 * narrowing would trade a silent over-grant for a silent under-grant,
 * discarding what the author wrote without saying so. A line of either shape
 * is a line whose author meant something this format cannot express, so it is
 * named and left to a person to rewrite.
 */
function grantRefusal(grant: GrantLine): GrantRefusal | null {
  if (grant.spans.length > 1) return 'multi-span';
  if (grant.spans.length === 1 && !grant.remainder.trimStart().startsWith('`')) return 'bare-glob-backticked-justification';
  return null;
}

/**
 * The globs granted by `authorised:` lines (bullet or bare) in a body's
 * `## Files` section; every other line there is prose. One glob per line
 * (invariant 5), and since #316 that is enforced rather than conventional.
 * A line `grantRefusal` names grants **nothing**; otherwise its one span is
 * the glob, and with no span at all the first whitespace-delimited token is,
 * trailing `,`/`;` stripped, so a bare comma list grants its first entry and
 * nothing else.
 *
 * The glob therefore always stands at the head of the line, backticked or
 * bare, which is what `docs/workflow.md` has said since #316 and what #357
 * makes true of the parser: reading a span from behind a bare token granted
 * a path the author had only quoted.
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
    if (grantRefusal(grant) !== null) continue; // refused, not narrowed (#316, #357)
    if (grant.spans.length === 1) {
      globs.push(grant.spans[0]);
      continue;
    }
    if (grant.bare) globs.push(grant.bare);
  }
  return globs;
}

/**
 * The grant lines of a body's `## Files` section that `grantRefusal` gives
 * the named reason — the lines `authorisedGlobsIn` refuses. The two exported
 * finders below are this function under two reasons, so a line can never be
 * reported by both and no span count is written down twice.
 */
function refusedGrantLines(body: string, reason: GrantRefusal): GrantLine[] {
  const section = extractSection(body, 'Files');
  if (section === null) return [];
  const refused: GrantLine[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const grant = readGrantLine(raw);
    if (grant !== null && grantRefusal(grant) === reason) refused.push(grant);
  }
  return refused;
}

export type MultiGlobGrant = { line: string; spans: string[] };

/**
 * The `authorised:` lines of a body's `## Files` section that carry more than
 * one backticked span. Each entry carries the line as written (trimmed,
 * bullet marker removed) and every span on it, so the caller can name both
 * halves of what was refused instead of reporting a count.
 *
 * Read by `ci/issue-lint.mts`, which turns each entry into a failure: the
 * refusal has to reach the orchestrator at dispatch, where the line is
 * written, rather than at the `scope` check on somebody else's pull request
 * (#316). A justification belongs on the next line, indented and not a
 * bullet; an unbackticked justification on the same line is fine, since it
 * adds no span.
 */
export function findMultiGlobGrantLines(body: string): MultiGlobGrant[] {
  return refusedGrantLines(body, 'multi-span').map(({ line, spans }) => ({ line, spans }));
}

export type BareGlobGrant = { line: string; bare: string; spans: string[] };

/**
 * The `authorised:` lines of a body's `## Files` section whose glob is bare
 * and whose justification is backticked — `authorised: src/a.ts (see
 * \`src/lib/b.ts\`)`. Each entry carries the line as written, the bare token
 * that was meant to be the glob and the span that was not, because both
 * halves went wrong at once: the span was granted and the bare glob was lost,
 * so naming either alone leaves the author guessing at the other (#357).
 *
 * Read by `ci/issue-lint.mts` beside `findMultiGlobGrantLines`, and reported
 * in wording of its own: "more than one backticked span" and "a bare glob
 * with a backticked justification" are different mistakes with different
 * remedies, and an author fixing one must not be told the other.
 */
export function findBareGlobBacktickedJustificationLines(body: string): BareGlobGrant[] {
  return refusedGrantLines(body, 'bare-glob-backticked-justification').map(({ line, bare, spans }) => ({ line, bare, spans }));
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

/**
 * How close to FILE_LINE_LIMIT a file has to be at the head before `scope`
 * reports it (#413, absorbing #392). A fixed number of lines, not a
 * percentage: FILE_LINE_LIMIT is a constant, so a percentage is the same
 * threshold with a rounding rule attached and one more thing to get wrong.
 *
 * Fifty, because a report that arrives with the pull request that crosses is
 * not a warning. Measured over the eighty most recent landings on `main`, of
 * the twenty-three that lengthened a file already at 700 lines or more, seven
 * added more than 20 lines and four added more than 50 — so a band of 20
 * gives no warning in about 30% of the cases it exists for and a band of 50
 * in about 17%. The cost runs the other way and runs flat: 24 of those eighty
 * landings touched a file at 780 or above, 28 touched one at 750 or above.
 * Thirteen points of coverage for five points of noise. The reasoning and the
 * numbers are `docs/decisions/0036-a-file-approaching-the-line-limit-is-reported.md`.
 */
export const FILE_LINE_APPROACH_BAND = 50;

export type FileLinesEntry = { path: string; baseLines: number | null; headLines: number; generated: boolean };
export type FileGrowth = { path: string; baseLines: number | null; headLines: number };

export type LengthOutcome = 'exempt-generated' | 'under-limit' | 'approaching-limit' | 'pushed-over' | 'inherited-over';

/**
 * What one file's length relation is called. Five relations, five names,
 * decided in one place so the halves of the old condition cannot drift
 * apart (#310, #413):
 *
 * - `exempt-generated` — `@generated` on the first line, whatever the length;
 * - `under-limit` — more than FILE_LINE_APPROACH_BAND lines below
 *   FILE_LINE_LIMIT at the head, whatever it was at the base;
 * - `approaching-limit` — at or below FILE_LINE_LIMIT at the head and within
 *   FILE_LINE_APPROACH_BAND lines of it. **Not over the limit**: a file at exactly
 *   FILE_LINE_LIMIT is at the limit, not past it, and fails nothing. Reported,
 *   never failed on, and never folded into any caller's exit status (#413);
 * - `pushed-over` — over the limit at the head *and* longer than at the base,
 *   or new at head (`baseLines` null) and landing over it. This diff added
 *   the length, so this diff is answerable for it: it fails the check;
 * - `inherited-over` — over the limit at the head, and the base was at least
 *   as long. The length came from somewhere else, so the check reports it and
 *   does not fail on it. A file that shrinks while staying over the limit is
 *   `inherited-over` too: it is still over, and it is still not this diff's
 *   doing.
 *
 * Before #310 `inherited-over` did not exist and the case produced nothing at
 * all, so a file that had crossed the limit was exempt from then on and the
 * rule stopped applying to exactly the files that had already broken it.
 * Naming the case did not change what fails, and neither does
 * `approaching-limit`: `pushed-over` is still the #134 condition, verbatim.
 * What changes each time is what is visible.
 */
export function lengthOutcome({ baseLines, headLines, generated }: FileLinesEntry): LengthOutcome {
  if (generated) return 'exempt-generated';
  if (headLines > FILE_LINE_LIMIT) {
    return baseLines !== null && headLines <= baseLines ? 'inherited-over' : 'pushed-over';
  }
  if (headLines >= FILE_LINE_LIMIT - FILE_LINE_APPROACH_BAND) return 'approaching-limit';
  return 'under-limit';
}

const withOutcome = (entries: FileLinesEntry[], wanted: LengthOutcome): FileGrowth[] =>
  entries
    .filter((entry) => lengthOutcome(entry) === wanted)
    .map(({ path, baseLines, headLines }) => ({ path, baseLines, headLines }));

/**
 * The files this diff is answerable for: new at head over FILE_LINE_LIMIT, or
 * grown past it against the base. The failing half of the rule, and the one
 * the caller folds into its exit status.
 */
export function fileGrowth(entries: FileLinesEntry[]): FileGrowth[] {
  return withOutcome(entries, 'pushed-over');
}

/**
 * The files that were already over FILE_LINE_LIMIT at the base and that this
 * diff did not lengthen. Reported, never failed on: a pull request is not
 * blamed for length it did not add (#310). The caller says so in words, and
 * says what closes it — a pull request that brings the file back under the
 * limit — because nothing else will: until one does, every pull request that
 * touches the file gets the same message, the ones that shorten it included.
 */
export function inheritedOverLimit(entries: FileLinesEntry[]): FileGrowth[] {
  return withOutcome(entries, 'inherited-over');
}

/**
 * The files this diff leaves within FILE_LINE_APPROACH_BAND lines of
 * FILE_LINE_LIMIT without crossing it — the approach report (#413). Reported,
 * never failed on, and never folded into the caller's exit status: #310 had
 * already separated "over the limit" from "failing this check", and this
 * separates "close to the limit" from both.
 *
 * Only files the pull request touched are ever entries here, because the
 * caller builds entries from the diff. That is not a third option beside a
 * band and a percentage — it is true of every shape the report could take,
 * since `scope` reads no file the diff does not name.
 *
 * What closes it is not what closes `inheritedOverLimit`: that one asks for a
 * file to come back under the limit, this one asks only that the next pull
 * request to lengthen the file leaves it room, or splits it. A file at
 * exactly FILE_LINE_LIMIT is here, not in the over-limit sections.
 */
export function approachingLimit(entries: FileLinesEntry[]): FileGrowth[] {
  return withOutcome(entries, 'approaching-limit');
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
 * Blanks fenced code blocks and inline code spans so a keyword quoted as an
 * example (in a fence or backticks) is never mistaken for a real link.
 *
 * Blanked in place — every character replaced by a space, every newline kept —
 * rather than deleted, so an offset in the result is an offset in the body and
 * a match's line number is reportable at all (#413). Two consequences beyond
 * that, both tightenings: an inline span no longer splices the text either side
 * of it together, so ``clos`e`s #1`` stops reading as `closes #1` and links
 * nothing; and an unterminated span no longer runs to the next backtick on a
 * later line, because the inline pattern stops at a newline. Measured before
 * landing over all 178 merged pull requests of this repository: the issue
 * numbers this returns are unchanged for every one of them.
 */
function stripCode(text: string): string {
  const blank = (s: string): string => s.replace(/[^\n]/g, ' ');
  return text.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank);
}

/**
 * One occurrence of a closing keyword in a PR body: the issue it links, the
 * zero-based line it sits on, that line as written (trimmed), and whether it
 * is part of the body's **declaration**.
 */
export type LinkedIssueMatch = { issue: number; line: number; phrase: string; declared: boolean };

/**
 * How many lines from the top of the body are the declaration: the run of
 * non-blank lines, starting at the first, that carry closing-keyword links and
 * nothing else.
 *
 * That form is what `docs/workflow.md` and `skills/issue-and-pr/SKILL.md` have
 * always asked a pull-request body to open with, and both have always allowed
 * several issues, so every well-formed body in this repository already has it —
 * measured over 178 merged pull requests, exactly one would be reported, and
 * that one is a true positive (#440, whose prose named a second issue). It is a
 * form ordinary prose cannot reach by accident because it is positional and
 * exclusive at once: a sentence about an issue has to be the first thing in the
 * body, and the whole of its line, before it counts as a declaration.
 *
 * Deliberately not a discipline and deliberately not a narrower
 * `LINKED_ISSUE_RE`: GitHub itself links a keyword written in prose, so a
 * parser that ignored the form would audit a *narrower* set than the issues
 * GitHub actually closes, and this repository has already measured that
 * authorial care does not hold a parser reading prose (#359).
 */
function declarationLineCount(text: string): number {
  const onlyLinks = /^(?:(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#\d+[,;]?\s*)+$/i;
  let n = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || !onlyLinks.test(line)) break;
    n++;
  }
  return n;
}

/**
 * Every closing-keyword occurrence in a PR body, in order, with its line and
 * whether the declaration carries it. Code is blanked first, so a keyword
 * inside a fence or an inline span is not an occurrence at all.
 *
 * The one reader of where a link sits. `parseLinkedIssues` and
 * `incidentalLinkedIssues` are both derived from it, so "which issues does
 * this body link" and "which of them were declared" are one answer rather than
 * two that have to agree — the hazard #231 named for `authorised:` lines.
 */
export function findLinkedIssueMatches(prBody: string | null | undefined): LinkedIssueMatch[] {
  const body = String(prBody ?? '');
  const text = stripCode(body);
  const sourceLines = body.split('\n');
  const declaredLines = declarationLineCount(text);
  const out: LinkedIssueMatch[] = [];
  for (const m of text.matchAll(LINKED_ISSUE_RE)) {
    const line = text.slice(0, m.index).split('\n').length - 1;
    out.push({
      issue: Number(m[1]),
      line,
      phrase: (sourceLines[line] ?? '').trim(),
      declared: line < declaredLines,
    });
  }
  return out;
}

/**
 * The issue numbers a PR body links via a GitHub closing keyword, in order
 * of first appearance, deduplicated. A bare `#N` with no keyword before it
 * is not a linked issue and is ignored, and so is a keyword that only
 * appears inside a fenced code block or an inline code span (unlike
 * `parseAuthorisedGlobs`, which reads backticks deliberately).
 */
export function parseLinkedIssues(prBody: string | null | undefined): number[] {
  const seen = new Set<number>();
  const result: number[] = [];
  for (const { issue } of findLinkedIssueMatches(prBody)) {
    if (!seen.has(issue)) {
      seen.add(issue);
      result.push(issue);
    }
  }
  return result;
}

/**
 * The issues this body links from somewhere other than its declaration and
 * only from there — one entry per issue, at its first such occurrence.
 *
 * An issue the declaration already carries is not here however often the prose
 * repeats it: it contributes no glob the run was not going to audit anyway, and
 * this exists for scope that was widened, not for every repetition of a number.
 *
 * Reported by `ci/scope-check.mts` as a warning and never as a failure. A hard
 * failure on a second link would refuse bodies that are merely discursive —
 * a body explaining which earlier pull request closed which issue is a good
 * body — and what was actually silent was never the match: it is that the
 * check printed the merged glob list and never the issue numbers the globs
 * came from, so a widened run and a correct run produced identical output
 * (#359).
 */
export function incidentalLinkedIssues(prBody: string | null | undefined): LinkedIssueMatch[] {
  const all = findLinkedIssueMatches(prBody);
  const declared = new Set(all.filter((m) => m.declared).map((m) => m.issue));
  const seen = new Set<number>();
  return all.filter((m) => {
    if (m.declared || declared.has(m.issue) || seen.has(m.issue)) return false;
    seen.add(m.issue);
    return true;
  });
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
