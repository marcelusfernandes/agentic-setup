#!/usr/bin/env node
// Pin test for `docs/dogfood/` (issue #183): the dogfood report format. A
// report is the only comparable record a pass leaves — two passes can be put
// side by side only if both carry the same three numbers per case and the same
// decision column — and a finding that leaves a report without an issue number
// or a written reason is the "candidate" this format exists to stop. Prose with
// no consumer drifts; this file is the consumer.
//
// Pure-read over the real tree, plus fixture documents for the refusal paths:
// there is no script to spawn, only the filesystem — the shape
// `tests/proof-declarations.test.mts` and `tests/doctrine.test.mts` already use
// for a catalogue of files and for prose with no runtime.
// The grammar is written out here rather than imported from a parser, for the
// same reason `tests/proof-declarations.test.mts` duplicates its own: a pin
// test that reuses the parser it pins cannot catch that parser drifting away
// from the documented shape. `docs/dogfood/README.md` states the same grammar
// for a reader; the two are meant to be compared by eye when either changes.
//
// The one import that is deliberate is `DOGFOOD_REPORT_RE` (#182): `scope` and
// `close-milestone` decide "is this a report" by that shape, so a file this
// test accepts as a report and that regex does not would silence the nudge or
// fail the close. Pinning the coupling is the point — the README and the
// template must *not* match it, and every dated report must. Since #295 that
// shape has two anchored readers derived from one source string — a path one
// and a prose one — and the cases below hold both ends of the coupling.
//
// The last section asks GitHub, which nothing else here does (#295). Two
// questions, neither answerable from the checkout, both stated for a reader in
// `docs/dogfood/README.md`, "Two pins that ask GitHub": a finding row resolving
// to an issue carries that issue's `Origin:` line — the rule `docs/workflow.md`
// states and nothing read, which is why two hand sweeps of
// `docs/dogfood/2026-09-17.md` both reported clean while rows disagreed — and no
// issue proves itself with a test file it neither owns nor has. Provenance, not
// coverage: the README names the readers who own that.
//
// Crash policy: opt-in, and fail open on what passes by itself. Unset,
// `LIVE_GH_ENV` leaves one note naming itself and neither question is asked, so
// the required `test` job spends nothing of a shared quota (the false red #356
// removed) and needs no token it does not have. A `gh` that is absent,
// unauthenticated or unable to answer is a note. A token refused the scope the
// query needs is a **failure**: it never fixes itself and its whole symptom
// would be a green run that checked nothing — `tests/provenance-issues.test.mts`
// settled that shape. Wiring this to a scheduled workflow the way
// `provenance-live.yml` wires that file needs `.github/workflows/**`, which #295
// does not declare, so it is not done here.
//
// `parseOriginLines`, `parseProofTestPaths`, `parseIssueGlobs` and `matchesAny`
// are imported rather than restated, and invariant 10 is not weakened by it:
// what this file pins is the format and the agreement between a row and an
// issue, not those parsers — each of which is pinned by its own cases in
// `tests/scope.test.mts`. The grammar this file pins, it writes out.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DOGFOOD_REPORT_RE, parseIssueAuthorisedGlobs, parseIssueGlobs } from '../ci/lib/scope.mts';
import { matchesAny } from '../ci/lib/globs.mts';
// The three readers #295 adds come in through the namespace, not the named
// import above: a named import of an export the base checkout does not have
// kills this whole file at load time, which reads as a structural red rather
// than an assertion — the reason `tests/scope.test.mts` reaches for
// `decisionNudge` the same way. Through the namespace the base fails on the
// assertions instead, which is what the negative control has to see.
import * as scopeLib from '../ci/lib/scope.mts';
import { check, finish, ROOT } from './lib/harness.mts';

const lib = scopeLib as unknown as {
  DOGFOOD_REPORT_PATH_RE?: RegExp;
  parseOriginLines?: (issueBody: string) => string[];
  parseProofTestPaths?: (issueBody: string) => string[];
};
/** A path that is a dated report, by the anchored reader. */
const REPORT_PATH = (path: string): boolean => lib.DOGFOOD_REPORT_PATH_RE instanceof RegExp && lib.DOGFOOD_REPORT_PATH_RE.test(path);
const originLines = (issueBody: string): string[] => lib.parseOriginLines?.(issueBody) ?? [];
const proofTestPaths = (issueBody: string): string[] => lib.parseProofTestPaths?.(issueBody) ?? [];

// --- the grammar, stated once -------------------------------------------
/** `# Dogfood <date> — <title>`; the date is the placeholder only in TEMPLATE.md. */
const HEADING = /^# Dogfood (<YYYY-MM-DD>|\d{4}-\d{2}-\d{2}) — (\S.*)$/;
/** The six header bullets, in this order, between the heading and `## Scoreboard`. */
const BULLETS = ['Repository', 'Commit', 'Turns', 'Minutes', 'Cost (USD)', 'Transcripts'];
/**
 * The optional seventh bullet (#184), naming the issue a report reproduces.
 * It exists for one case: a pass that ran before this format did, whose record
 * is prose that never carried the numbers. Such a report may write the literal
 * `not recorded` in `Commit` and the five numeric cells rather than have them
 * reconstructed, and the bullet is what makes that visible — a report without
 * it is still held to numbers, so a live pass stays comparable to the next one.
 */
const RETROACTIVE = 'Retroactive';
/** What a retroactive report writes where its source recorded no number. */
const NOT_RECORDED = 'not recorded';
/** The `Retroactive:` value: the one issue the report reproduces. */
const RETROACTIVE_VALUE = /^#\d+$/;
/**
 * The day this format landed: `0ebbf70`, PR #253, 2026-09-17. Written out here
 * rather than read from git, because the duplication is the pin — the README
 * states the same date in the same words. A report dated on or after it may not
 * carry `Retroactive:` at all: nothing tied the bullet to a date before, so a
 * live pass could add it and write `not recorded` in five cells, which is the
 * comparability the format exists for (#295).
 */
const FORMAT_LANDED = '2026-09-17';
/**
 * The two things a `Cost (USD)` number can be, one of which the comment at the
 * bullet has to name. `docs/dogfood/README.md`, "What `Cost (USD)` means",
 * states what each covers; the pin holds only that the comment says which,
 * because what it says *about* the number is prose, like every `finding` cell.
 */
const COST_CLAIMS = ['reconstruction', 'billed'];
const SECTIONS = ['## Scoreboard', '## Findings'];
const SCOREBOARD_COLUMNS = ['case', 'exit', 'error class', 'tool calls', 'decision', 'reason'];
const FINDINGS_COLUMNS = ['finding', 'origin', 'outcome'];
const row = (columns: string[]) => `| ${columns.join(' | ')} |`;
const SCOREBOARD_HEADER = row(SCOREBOARD_COLUMNS);
const FINDINGS_HEADER = row(FINDINGS_COLUMNS);
const DECISIONS = ['keep', 'fix'];
/** A `<...>` field nobody filled in. HTML comments are stripped first. */
const PLACEHOLDER = /<[^<>]*>/;
/** An outcome that parks the finding instead of resolving it (AC2). */
const PARKED = /^(candidates?|todo|tbd|open|later|unresolved|maybe|none|n\/a|\?+)\.?$/i;
const SHA = /^[0-9a-f]{40}$/;
const INTEGER = /^\d+$/;
const MONEY = /^\d+(\.\d+)?$/;

/** The cells of a Markdown table row, or null when the line is not one. */
function cells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map((c) => c.trim());
}

/** A `| --- | --- |` delimiter row. */
function isDelimiter(row: string[]): boolean {
  return row.length > 0 && row.every((c) => /^:?-{3,}:?$/.test(c));
}

/**
 * The body of the HTML comment that sits **at** the `Cost (USD)` bullet — on the
 * line directly below it — or `null` when there is none. Read from the **raw**
 * document, the one place this file does that: `validate` strips comments so a
 * commented-out row is not a row, and this is the single rule whose subject is a
 * comment. "At the bullet" and not "anywhere in the header", because the
 * derivation has to be findable from the number it explains.
 */
function costComment(raw: string): string | null {
  const m = raw.match(/^- Cost \(USD\):[^\n]*\n[ \t]*<!--([\s\S]*?)-->/m);
  return m ? m[1] : null;
}

/**
 * Every rule `docs/dogfood/README.md` states, as a list of failures. An empty
 * list means the document parses. `name` is only used in the messages.
 */
function validate(name: string, raw: string): string[] {
  const errors: string[] = [];
  // HTML comments first, so an illustrative row commented out in the template
  // is not a row (the `docs/closeout/` precedent).
  const text = raw.replace(/<!--[\s\S]*?-->/g, '');
  const lines = text.split(/\r?\n/);

  const firstIndex = lines.findIndex((l) => l.trim() !== '');
  const heading = firstIndex === -1 ? '' : lines[firstIndex].trim();
  const headingMatch = heading.match(HEADING);
  if (!headingMatch) errors.push(`${name}: the first line must be "# Dogfood <YYYY-MM-DD> — <title>", got "${heading}"`);

  const sectionAt = SECTIONS.map((s) => lines.findIndex((l) => l.trim() === s));
  for (const section of SECTIONS) {
    const count = lines.filter((l) => l.trim() === section).length;
    if (count !== 1) errors.push(`${name}: \`${section}\` must appear exactly once, found ${count}`);
  }
  if (sectionAt[0] !== -1 && sectionAt[1] !== -1 && sectionAt[1] < sectionAt[0]) {
    errors.push(`${name}: \`## Findings\` must come after \`## Scoreboard\``);
  }
  if (errors.length) return errors;

  // --- header bullets, six of them, in order, plus an optional `Retroactive` ---
  const header = lines.slice(firstIndex + 1, sectionAt[0]).filter((l) => l.trim().startsWith('- '));
  // The seventh bullet is recognised by its own label, so a report that simply
  // has one bullet too many is still the "wrong count" error it was before.
  const retroactive = header.length === BULLETS.length + 1
    && header[BULLETS.length].trim().startsWith(`- ${RETROACTIVE}: `);
  const expected = retroactive ? [...BULLETS, RETROACTIVE] : BULLETS;
  if (header.length !== expected.length) {
    errors.push(
      `${name}: expected ${BULLETS.length} header bullets (${BULLETS.join(', ')}), optionally followed by "${RETROACTIVE}", got ${header.length}`,
    );
  } else {
    expected.forEach((label, i) => {
      const prefix = `- ${label}: `;
      const line = header[i].trim();
      if (!line.startsWith(prefix)) {
        errors.push(`${name}: header bullet ${i + 1} must start "${prefix.trim()}", got "${line}"`);
        return;
      }
      const value = line.slice(prefix.length).trim();
      if (value === '') errors.push(`${name}: "${label}" is empty`);
      else if (label === RETROACTIVE && !RETROACTIVE_VALUE.test(value)) {
        errors.push(`${name}: "${RETROACTIVE}" must name the issue this report reproduces as \`#N\`, got "${value}"`);
      }
    });
  }
  // The escape is tied to a date, not only to the bullet (#295): a pass that
  // ran after this format landed is held to its numbers whatever it writes
  // here. The heading date is the one the filename must equal, pinned below.
  const headingDate = headingMatch !== null && /^\d{4}-\d{2}-\d{2}$/.test(headingMatch[1]) ? headingMatch[1] : null;
  if (retroactive && headingDate !== null && headingDate >= FORMAT_LANDED) {
    errors.push(
      `${name}: "${RETROACTIVE}" is only for a pass that predates this format, and this report is dated ${headingDate}, on or after ${FORMAT_LANDED}`,
    );
  }
  /** `not recorded` is a value only a retroactive report may write. */
  const absent = (cell: string) => retroactive && cell === NOT_RECORDED;
  /** The escape named in a message, so a failing report is told the one way out. */
  const orAbsent = retroactive ? ` or \`${NOT_RECORDED}\`` : '';

  // --- the two tables ---
  const rowsIn = (from: number, to: number, columns: string[]): string[][] => {
    const region = lines.slice(from + 1, to).map(cells).filter((c): c is string[] => c !== null);
    const headerOk = region.length >= 2 && region[0].join('\0') === columns.join('\0') && isDelimiter(region[1]);
    if (!headerOk) {
      errors.push(`${name}: the table under \`${lines[from].trim()}\` must start with "${row(columns)}" and a delimiter row`);
      return [];
    }
    const body = region.slice(2);
    for (const cell of body) {
      if (cell.length !== columns.length) {
        errors.push(`${name}: a row has ${cell.length} cells, expected ${columns.length}: ${cell.join(' | ')}`);
      }
    }
    return body.filter((cell) => cell.length === columns.length);
  };

  const caseRows = rowsIn(sectionAt[0], sectionAt[1], SCOREBOARD_COLUMNS);
  const findingRows = rowsIn(sectionAt[1], lines.length, FINDINGS_COLUMNS);

  // --- empty (the template) or filled, never half ---
  const placeholders = lines.some((l) => PLACEHOLDER.test(l));
  const rows = caseRows.length + findingRows.length;
  if (placeholders && rows > 0) {
    errors.push(`${name}: half-filled — it carries rows and still carries a <...> placeholder`);
  }
  if (!placeholders && caseRows.length === 0) {
    errors.push(`${name}: filled reports need at least one case row in \`## Scoreboard\``);
  }
  if (placeholders) return errors; // the empty case stops here: its cells are placeholders

  // --- one case row: exit code, error class, tool calls, decision, reason ---
  for (const [name_, exit, errorClass, toolCalls, decision, reason] of caseRows) {
    const where = `${name}: case "${name_}"`;
    if (name_ === '') errors.push(`${name}: a case row has no case name`);
    if (!INTEGER.test(exit) && !absent(exit)) errors.push(`${where}: "exit" must be an integer${orAbsent}, got "${exit}"`);
    if (errorClass === '') errors.push(`${where}: "error class" is empty (write \`none\` for a clean case)`);
    // The escape covers `Commit` and the five numeric cells; this column is not
    // one of them, in a retroactive report either (#295). A pass that ran at all
    // produced an outcome per case, and a class is a name for it rather than a
    // measurement the runtime had to report.
    else if (errorClass === NOT_RECORDED) {
      errors.push(`${where}: "error class" may never be \`${NOT_RECORDED}\` — name the failure, or \`none\` for a clean case`);
    }
    if (!INTEGER.test(toolCalls) && !absent(toolCalls)) errors.push(`${where}: "tool calls" must be an integer${orAbsent}, got "${toolCalls}"`);
    if (!DECISIONS.includes(decision)) errors.push(`${where}: "decision" must be ${DECISIONS.join(' or ')}, got "${decision}"`);
    if (reason === '') errors.push(`${where}: the ${decision || 'keep/fix'} decision carries no reason`);
  }

  // --- one finding row: an origin, and an issue number or a written reason ---
  for (const [finding, origin, outcome] of findingRows) {
    const where = `${name}: finding "${finding}"`;
    if (finding === '') errors.push(`${name}: a finding row has no finding`);
    if (origin === '') errors.push(`${where}: no origin (this cell becomes the issue's \`Origin:\` line)`);
    if (/#\d+/.test(outcome)) continue;
    if (outcome === '' || PARKED.test(outcome)) {
      errors.push(`${where}: the outcome parks it ("${outcome}") — name the \`#N\` it became or give a one-line reason it is not work`);
    }
  }

  // --- the header fields that have a shape ---
  if (header.length === expected.length) {
    const value = (label: string) => header[BULLETS.indexOf(label)].trim().slice(`- ${label}: `.length).trim();
    if (!SHA.test(value('Commit')) && !absent(value('Commit'))) {
      errors.push(`${name}: "Commit" must be a 40-character sha${orAbsent}, got "${value('Commit')}"`);
    }
    for (const label of ['Turns', 'Minutes']) {
      if (!INTEGER.test(value(label)) && !absent(value(label))) {
        errors.push(`${name}: "${label}" must be a whole number${orAbsent}, got "${value(label)}"`);
      }
    }
    const cost = value('Cost (USD)');
    if (!MONEY.test(cost) && !absent(cost)) {
      errors.push(`${name}: "Cost (USD)" must be a number${orAbsent}, got "${cost}"`);
    }
    // A number in that cell is one of two different measurements and the report
    // says which (#295): a figure a runtime or a statement billed, or a
    // reconstruction from token counts at list prices. No runtime here states a
    // cost to an agent at all, so every report so far is the second, and a
    // reader who cannot tell them apart cannot compare two passes.
    if (MONEY.test(cost)) {
      const comment = costComment(raw);
      const says = comment !== null && COST_CLAIMS.some((w) => comment.toLowerCase().includes(w));
      if (!says) {
        errors.push(
          `${name}: "Cost (USD)" is a number, so the comment at its bullet must say whether it is a ${COST_CLAIMS.join(' or a ')} figure — ${comment === null ? 'no comment sits at that bullet' : 'the comment says neither'}`,
        );
      }
    }
  }
  return errors;
}

// --- fixtures: the refusal paths, each one line away from the valid document ---

/** The comment a numeric `Cost (USD)` owes, at its bullet (#295). */
const COST_COMMENT = [
  '<!-- A reconstruction, not a billed amount: token usage summed per model over',
  '     the transcripts the bullet below names, deduplicated by response id,',
  '     restricted to the window, priced at list. -->',
].join('\n');

const VALID = [
  '# Dogfood 2026-01-31 — the loop end to end against a disposable repository',
  '',
  '- Repository: example/disposable',
  '- Commit: 0123456789abcdef0123456789abcdef01234567',
  '- Turns: 41',
  '- Minutes: 96',
  '- Cost (USD): 12.40',
  COST_COMMENT,
  '- Transcripts: run 42 of the scheduler, kept with the run, not in this repository',
  '',
  '## Scoreboard',
  '',
  SCOREBOARD_HEADER,
  '| --- | --- | --- | --- | --- | --- |',
  '| claim a ready issue | 0 | none | 7 | keep | the refusal paths cost one call each |',
  '| land a queued PR | 1 | checks-queued | 12 | fix | the wait loop cannot tell a conflict from a queue |',
  '',
  '## Findings',
  '',
  FINDINGS_HEADER,
  '| --- | --- | --- |',
  '| the wait loop spins on a conflicting PR | case "land a queued PR" | #901 |',
  '| a label edit re-triggers the checks | case "land a queued PR" | accepted: one extra run per edit is cheaper than a workflow condition |',
  '',
].join('\n');

/** The valid document with one line swapped for a broken one. */
const swap = (from: string, to: string) => VALID.replace(from, to);

const fixture = (label: string, text: string, shouldPass: boolean, expect?: RegExp) => {
  const errors = validate('fixture', text);
  const ok = shouldPass ? errors.length === 0 : errors.length > 0 && (!expect || errors.some((e) => expect.test(e)));
  check(label, ok, errors.join('\n'));
};

fixture('a filled report in the format parses', VALID, true);

fixture(
  'a case row missing its exit code fails',
  swap('| claim a ready issue | 0 | none | 7 |', '| claim a ready issue |  | none | 7 |'),
  false,
  /"exit" must be an integer/,
);
fixture(
  'a case row missing its tool calls fails',
  swap('| none | 7 | keep |', '| none |  | keep |'),
  false,
  /"tool calls" must be an integer/,
);
fixture(
  'a case row missing its error class fails',
  swap('| 0 | none | 7 |', '| 0 |  | 7 |'),
  false,
  /"error class" is empty/,
);
fixture(
  'a decision outside keep|fix fails',
  swap('| 7 | keep |', '| 7 | maybe |'),
  false,
  /"decision" must be keep or fix/,
);
fixture(
  'a decision with no reason fails',
  swap('| keep | the refusal paths cost one call each |', '| keep |  |'),
  false,
  /carries no reason/,
);
fixture(
  'a pass with no turns, minutes or cost fails',
  swap('- Turns: 41', '- Turns: some'),
  false,
  /"Turns" must be a whole number/,
);
fixture(
  'a header with a missing bullet fails',
  VALID.split('\n').filter((l) => !l.startsWith('- Minutes:')).join('\n'),
  false,
  /expected 6 header bullets/,
);
fixture(
  'a commit that is not a sha fails',
  swap('- Commit: 0123456789abcdef0123456789abcdef01234567', '- Commit: HEAD'),
  false,
  /"Commit" must be a 40-character sha/,
);
fixture(
  'a finding left as a candidate fails',
  swap('| case "land a queued PR" | #901 |', '| case "land a queued PR" | candidate |'),
  false,
  /the outcome parks it/,
);
fixture(
  'a finding with an empty outcome fails',
  swap('| case "land a queued PR" | #901 |', '| case "land a queued PR" |  |'),
  false,
  /the outcome parks it/,
);
fixture(
  'a finding with no origin fails',
  swap('| the wait loop spins on a conflicting PR | case "land a queued PR" |', '| the wait loop spins on a conflicting PR |  |'),
  false,
  /no origin/,
);
fixture(
  'a finding resolved by a one-line reason, not an issue, parses',
  swap('| case "land a queued PR" | #901 |', '| case "land a queued PR" | the cost is accepted: two calls per claim |'),
  true,
);
fixture(
  'a finding covered by a merged PR parses',
  swap('| case "land a queued PR" | #901 |', '| case "land a queued PR" | already covered by PR #905 |'),
  true,
);
// --- the retroactive escape (#184): the one document that may say `not recorded` ---

/** `VALID` with the seventh bullet, and every number its source never recorded. */
const RETRO = VALID
  .replace(
    '- Transcripts: run 42 of the scheduler, kept with the run, not in this repository',
    '- Transcripts: not kept — the pass predates this format\n- Retroactive: #96',
  )
  .replace('- Commit: 0123456789abcdef0123456789abcdef01234567', `- Commit: ${NOT_RECORDED}`)
  .replace('- Turns: 41', `- Turns: ${NOT_RECORDED}`)
  .replace('- Minutes: 96', `- Minutes: ${NOT_RECORDED}`)
  .replace('- Cost (USD): 12.40', `- Cost (USD): ${NOT_RECORDED}`)
  .replace('| claim a ready issue | 0 | none | 7 |', `| claim a ready issue | ${NOT_RECORDED} | none | ${NOT_RECORDED} |`);

fixture('a retroactive report may write `not recorded` where its source recorded none', RETRO, true);
// Every guarded cell owns a case for the non-retroactive refusal, not only
// `Turns` (#295): the six share one shape and five of them were never exercised,
// so a report writing `not recorded` in `Minutes` or in a case row's `tool calls`
// without the bullet was held by nothing.
const GUARDED: Array<[string, string, string, RegExp]> = [
  ['Commit', '- Commit: 0123456789abcdef0123456789abcdef01234567', `- Commit: ${NOT_RECORDED}`, /"Commit" must be a 40-character sha/],
  ['Turns', '- Turns: 41', `- Turns: ${NOT_RECORDED}`, /"Turns" must be a whole number/],
  ['Minutes', '- Minutes: 96', `- Minutes: ${NOT_RECORDED}`, /"Minutes" must be a whole number/],
  ['Cost (USD)', '- Cost (USD): 12.40', `- Cost (USD): ${NOT_RECORDED}`, /"Cost \(USD\)" must be a number/],
  ["a case row's exit", '| claim a ready issue | 0 |', `| claim a ready issue | ${NOT_RECORDED} |`, /"exit" must be an integer/],
  ["a case row's tool calls", '| none | 7 | keep |', `| none | ${NOT_RECORDED} | keep |`, /"tool calls" must be an integer/],
];
for (const [label, from, to, expect] of GUARDED) {
  fixture(`a report with no Retroactive bullet may not write \`not recorded\` in ${label}`, swap(from, to), false, expect);
}
// `error class` is not one of the six, in any report (#295).
fixture(
  'a case row whose error class is `not recorded` fails',
  swap('| claim a ready issue | 0 | none | 7 |', `| claim a ready issue | 0 | ${NOT_RECORDED} | 7 |`),
  false,
  /"error class" may never be/,
);
// --- the Cost (USD) comment (#295): which of the two measurements it is ----
fixture(
  'a numeric Cost (USD) with no comment at its bullet fails',
  VALID.replace(`${COST_COMMENT}\n`, ''),
  false,
  /no comment sits at that bullet/,
);
fixture(
  'a numeric Cost (USD) whose comment says neither reconstruction nor billed fails',
  VALID.replace(COST_COMMENT, '<!-- Token usage summed per model, priced at list. -->'),
  false,
  /the comment says neither/,
);
fixture(
  'a Cost (USD) comment one blank line away from its bullet is not at the bullet',
  swap('- Cost (USD): 12.40', '- Cost (USD): 12.40\n'),
  false,
  /no comment sits at that bullet/,
);
fixture(
  'a retroactive report still needs its error class, decision and reason',
  RETRO.replace('| none | not recorded | keep |', '| none | not recorded | maybe |'),
  false,
  /"decision" must be keep or fix/,
);
fixture(
  'a Retroactive bullet that does not name an issue fails',
  RETRO.replace('- Retroactive: #96', '- Retroactive: the first third-party run'),
  false,
  /must name the issue this report reproduces/,
);
// The escape is tied to a date as well as to a bullet (#295). The boundary is
// inclusive: the day the format landed is a day a pass ran under it.
fixture(
  'a Retroactive bullet on a report dated the day this format landed fails',
  RETRO.replace('# Dogfood 2026-01-31 —', `# Dogfood ${FORMAT_LANDED} —`),
  false,
  /only for a pass that predates this format/,
);
fixture(
  'a Retroactive bullet on a report dated after this format landed fails',
  RETRO.replace('# Dogfood 2026-01-31 —', '# Dogfood 2026-09-20 —'),
  false,
  /only for a pass that predates this format/,
);
fixture(
  'a report dated the day before this format landed may still be retroactive',
  RETRO.replace('# Dogfood 2026-01-31 —', '# Dogfood 2026-09-16 —'),
  true,
);
fixture(
  'a retroactive report may not write `not recorded` in an error class either',
  RETRO.replace('| claim a ready issue | not recorded | none |', `| claim a ready issue | not recorded | ${NOT_RECORDED} |`),
  false,
  /"error class" may never be/,
);
fixture(
  'a retroactive report owes no Cost (USD) comment, because its cost is not a number',
  RETRO.replace(`${COST_COMMENT}\n`, ''),
  true,
);
fixture(
  'a seventh bullet that is not Retroactive fails',
  VALID.replace(
    '- Transcripts: run 42 of the scheduler, kept with the run, not in this repository',
    '- Transcripts: run 42 of the scheduler\n- Notes: something else',
  ),
  false,
  /expected 6 header bullets/,
);

fixture(
  'a half-filled report fails',
  swap('- Repository: example/disposable', '- Repository: <owner/name the pass ran against>'),
  false,
  /half-filled/,
);
fixture(
  'a report with no case row fails',
  VALID.split('\n').filter((l) => !l.startsWith('| claim') && !l.startsWith('| land')).join('\n'),
  false,
  /at least one case row/,
);
fixture(
  'a report missing `## Findings` fails',
  VALID.split('\n').filter((l) => l.trim() !== '## Findings').join('\n'),
  false,
  /`## Findings` must appear exactly once/,
);
fixture(
  'a scoreboard whose header row is not the fixed one fails',
  swap(SCOREBOARD_HEADER, '| case | exit | tool calls | decision | reason |'),
  false,
  /must start with/,
);

// --- the real tree ------------------------------------------------------

const dir = join(ROOT, 'docs', 'dogfood');
const exists = existsSync(dir) && statSync(dir).isDirectory();
check('docs/dogfood/ exists', exists);

const entries = exists ? readdirSync(dir).sort() : [];
check('docs/dogfood/TEMPLATE.md ships the empty case', entries.includes('TEMPLATE.md'), entries.join(', '));

check('ci/lib/scope.mts exports the three readers #295 adds', [lib.DOGFOOD_REPORT_PATH_RE, lib.parseOriginLines, lib.parseProofTestPaths].every((x) => x !== undefined));
// The prose reader, which `close-milestone.mts` runs over a `## Dogfood` bullet
// and `dogfoodTrigger` over a pull-request body. Anchored at both ends by a
// boundary rather than by `^`/`$`, because both of its readers hand it prose: a
// report named inside a sentence, inside backticks or inside a URL still counts,
// and the two shapes the unanchored regex wrongly accepted do not.
check('the prose reader finds a report named inside a sentence', DOGFOOD_REPORT_RE.test('written up in `docs/dogfood/2026-09-20.md`.'));
check('the prose reader finds a report cited by URL', DOGFOOD_REPORT_RE.test('https://github.com/o/r/blob/main/docs/dogfood/2026-09-20.md'));
check('the prose reader does not count a nested path', !DOGFOOD_REPORT_RE.test('see docs/dogfood/nested/2026-09-20.md'));
check('the prose reader does not count a trailing suffix', !DOGFOOD_REPORT_RE.test('see docs/dogfood/2026-09-20.md.bak'));

// Docs equal code: the README is where a reader meets this grammar, so it has
// to carry the parts this file enforces — both fixed table headers and all six
// header bullet labels. Existence alone would let the prose drift away from the
// rules above while the pin stayed green.
//
// Whitespace is normalised on both sides first, which is the live pins' own
// blindness in reverse (#295): the README wraps its prose, so a clause longer
// than a line is never found by a literal `includes`. Normalising is what lets
// the list hold whole clauses instead of single words — the difference between
// pinning that the README *mentions* `Cost (USD)` and what it *says* about it.
const flat = (s: string) => s.replace(/\s+/g, ' ');
const readme = entries.includes('README.md') ? flat(readFileSync(join(dir, 'README.md'), 'utf8')) : '';
const stated = [
  SCOREBOARD_HEADER,
  FINDINGS_HEADER,
  ...[...BULLETS, RETROACTIVE].map((b) => `\`${b}\``),
  // The escape is a rule of the format, so the README owes it a sentence too.
  `\`${NOT_RECORDED}\``,
  // #295: the sentences, not the words. Each clause below is a rule this file
  // or one of the two live pins enforces, and the README is where it is stated
  // for a reader. A rule deleted from one side has to be deleted from both.
  `${FORMAT_LANDED}, the day this format landed`,
  '`error class` is not one of them',
  'A reconstruction is derived from these inputs and from nothing else',
  'deduplicated by response id',
  'restricted to the window the header measures',
  'the warrant is the reproduction, never the number',
  'only once the diagnosis has been reproduced',
  'do not rewrite the landed file',
  'Yes, it may, and it says so in its `outcome` cell',
  'A matching `Origin:` line proves',
  'coverage is assigned, not checked',
  'join a wrapped line before comparing',
  'DOGFOOD_REPORT_PATH_RE',
].map(flat);
const unstated = stated.filter((part) => !readme.includes(part));
check('docs/dogfood/README.md states the format and the rules this test enforces', readme !== '' && unstated.length === 0, readme === '' ? entries.join(', ') : `not stated in the README: ${unstated.join(' / ')}`);
check('docs/dogfood/ holds nothing but README.md, TEMPLATE.md and dated reports', exists && entries.every((n) => n === 'README.md' || n === 'TEMPLATE.md' || REPORT_PATH(`docs/dogfood/${n}`)), entries.join(', '));
// The #182 coupling, both ways.
for (const name of ['README.md', 'TEMPLATE.md']) {
  check(`docs/dogfood/${name} is not counted as a report by scope`, !REPORT_PATH(`docs/dogfood/${name}`));
}
// #295: the path reader is anchored, so a report is the whole string and nothing
// else. `tests/scope.test.mts` measures which shapes the unanchored regex
// accepted and holds the same four there; these two are the ones the issue names.
check('a nested path under docs/dogfood/ is not a report', !REPORT_PATH('docs/dogfood/nested/2026-09-20.md'));
check('a dated report with a trailing suffix is not a report', !REPORT_PATH('docs/dogfood/2026-09-20.md.bak'));
check('a dated report path is a report', REPORT_PATH('docs/dogfood/2026-09-20.md'));

if (entries.includes('TEMPLATE.md')) {
  const template = readFileSync(join(dir, 'TEMPLATE.md'), 'utf8');
  const errors = validate('TEMPLATE.md', template);
  check('docs/dogfood/TEMPLATE.md is the valid-but-empty case', errors.length === 0, errors.join('\n'));
  check(
    'docs/dogfood/TEMPLATE.md is still empty (every field a placeholder)',
    PLACEHOLDER.test(template.replace(/<!--[\s\S]*?-->/g, '')),
  );
}

const reports = entries.filter((n) => REPORT_PATH(`docs/dogfood/${n}`));
for (const name of reports) {
  const text = readFileSync(join(dir, name), 'utf8');
  const errors = validate(name, text);
  check(`docs/dogfood/${name} parses`, errors.length === 0, errors.join('\n'));
  const date = name.slice(0, -'.md'.length);
  const heading = text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  check(`docs/dogfood/${name}: the heading date matches the filename`, heading.includes(`# Dogfood ${date} `), heading);
  check(`docs/dogfood/${name} is filled, not the template`, !PLACEHOLDER.test(text.replace(/<!--[\s\S]*?-->/g, '')));
}

// --- the two pins that ask GitHub (#295) --------------------------------

/** The environment variable that opts a run into asking GitHub at all. */
const LIVE_GH_ENV = 'AGENTIC_DOGFOOD_LIVE_GH';
/** At most this many numbers per `gh api graphql` call. */
const GRAPHQL_BATCH = 50;
/** Whitespace squashed and trimmed: what the pin compares, never a raw line. */
const squash = (s: string) => flat(s).trim();
/** A written outcome naming a pull request as the cover. */
const PR_CLAIM = /(?:PR|pull request)\s+#(\d+)/gi;

/** The `## Findings` rows of one document, by the grammar stated at the top. */
function findingRowsOf(raw: string): Array<{ finding: string; origin: string; outcome: string }> {
  const lines = raw.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === '## Findings');
  if (at === -1) return [];
  const region = lines.slice(at + 1).map(cells).filter((c): c is string[] => c !== null);
  const headerOk = region.length >= 2 && region[0].join('\0') === FINDINGS_COLUMNS.join('\0') && isDelimiter(region[1]);
  if (!headerOk) return [];
  return region
    .slice(2)
    .filter((c) => c.length === FINDINGS_COLUMNS.length)
    .map(([finding, origin, outcome]) => ({ finding, origin, outcome }));
}

check('a commented-out finding row is not a row the live pins read', findingRowsOf(VALID).length === 2 && findingRowsOf(`${VALID}\n<!--\n| a commented row | somewhere | #1 |\n-->\n`).length === 2, String(findingRowsOf(VALID).length));

type Node = { kind: 'issue'; body: string } | { kind: 'pull-request'; state: string };
type Lookup =
  | { kind: 'answers'; answers: Map<number, Node> }
  | { kind: 'unavailable'; detail: string }
  | { kind: 'forbidden'; detail: string };

const gh = (args: string[]) => {
  const r = spawnSync('gh', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * Every number resolved in `ceil(n / GRAPHQL_BATCH)` calls. The exit status is
 * not read: a number resolving to nothing makes `gh` exit 1 while still printing
 * every other alias's answer, so the body is what is read, and a number absent
 * from the answers is reported by its caller.
 */
function lookup(numbers: number[]): Lookup {
  const answers = new Map<number, Node>();
  const fields = '__typename ... on Issue { body } ... on PullRequest { state }';
  for (let i = 0; i < numbers.length; i += GRAPHQL_BATCH) {
    const chunk = numbers.slice(i, i + GRAPHQL_BATCH);
    const aliases = chunk.map((n) => `i${n}: issueOrPullRequest(number: ${n}) { ${fields} }`).join(' ');
    const r = gh([
      'api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f',
      `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${aliases} } }`,
    ]);
    let body: unknown = null;
    try { body = JSON.parse(r.stdout); } catch { body = null; }
    const parsed = body as { data?: { repository?: Record<string, { __typename?: string; body?: string; state?: string }> }; errors?: Array<{ type?: string; message?: string }> } | null;
    const reported = parsed?.errors ?? [];
    // `FORBIDDEN` first, and it reds: a token without the scope the query needs
    // is a configuration fact that never fixes itself. Everything else passes
    // by itself, so everything else is a note.
    const forbidden = reported.find((e) => e?.type === 'FORBIDDEN');
    if (forbidden) return { kind: 'forbidden', detail: String(forbidden.message ?? 'no message') };
    const repository = parsed?.data?.repository;
    if (!repository) return { kind: 'unavailable', detail: (r.stderr || r.stdout).trim().split('\n')[0] || 'no output' };
    const declined = reported.find((e) => e?.type !== 'NOT_FOUND');
    if (declined) return { kind: 'unavailable', detail: String(declined.message ?? 'no message') };
    for (const n of chunk) {
      const node = repository[`i${n}`];
      if (node?.__typename === 'Issue') answers.set(n, { kind: 'issue', body: String(node.body ?? '') });
      else if (node?.__typename === 'PullRequest') answers.set(n, { kind: 'pull-request', state: String(node.state ?? '') });
    }
  }
  return { kind: 'answers', answers };
}

const everyRow = reports.flatMap((name) => findingRowsOf(readFileSync(join(dir, name), 'utf8')).map((row) => ({ ...row, name })));
const BARE = /^#(\d+)$/;
const wanted = [...new Set(everyRow.flatMap(({ outcome }) => [...outcome.matchAll(/#(\d+)/g)].map((m) => Number(m[1]))))].sort((a, b) => a - b);

/** Opt-in, batched, and a note rather than a failure on anything transient. */
const live = (process.env[LIVE_GH_ENV] ?? '') !== '';
const authenticated = live && gh(['auth', 'status']).status === 0;
const answered = authenticated && wanted.length > 0 ? lookup(wanted) : null;
if (!live) {
  console.error(`note: the two GitHub checks were skipped — the required suite does not ask GitHub: set ${LIVE_GH_ENV}=1 to run them`);
} else if (!authenticated) {
  console.error('note: gh is absent or unauthenticated — the two GitHub checks were skipped');
} else if (answered !== null && answered.kind === 'unavailable') {
  console.error(`note: gh could not answer (${answered.detail}) — the two GitHub checks were skipped`);
}
check('a token refused the scope the query needs is a failure, not a skip', answered === null || answered.kind !== 'forbidden', answered !== null && answered.kind === 'forbidden' ? answered.detail : '');

if (answered !== null && answered.kind === 'answers') {
  const { answers } = answered;
  // origin → issue. Provenance, and provenance only: a matching line says this
  // row and that issue describe the same source, never that the issue would
  // resolve the finding. `docs/dogfood/README.md` says which reader owns that.
  const disagreed: string[] = [];
  const unresolved: string[] = [];
  const notMerged: string[] = [];
  let compared = 0;
  for (const { name, origin, outcome } of everyRow) {
    for (const m of outcome.matchAll(/#(\d+)/g)) {
      if (!answers.has(Number(m[1]))) unresolved.push(`${name}: outcome "${outcome}" names #${m[1]}, which resolves to nothing`);
    }
    for (const m of outcome.matchAll(PR_CLAIM)) {
      const node = answers.get(Number(m[1]));
      if (node !== undefined && (node.kind !== 'pull-request' || node.state !== 'MERGED')) {
        notMerged.push(`${name}: outcome "${outcome}" names ${m[0]} as the cover, which is ${node.kind === 'pull-request' ? node.state.toLowerCase() : 'an issue'}`);
      }
    }
    const bare = outcome.match(BARE);
    const node = bare === null ? undefined : answers.get(Number(bare[1]));
    // A bare `#N` may be a merged pull request, which the README allows and
    // which has no `## Context` to compare against: those are not compared.
    if (node === undefined || node.kind !== 'issue') continue;
    compared++;
    const origins = originLines(node.body);
    if (!origins.some((o) => o === squash(origin))) {
      disagreed.push(`${name}: ${bare?.[0]} carries ${origins.length} Origin: line(s), none equal to "${squash(origin)}"${origins.length ? ` (its first is "${origins[0]}")` : ''}`);
    }
  }
  check(`every finding row resolving to an issue carries that issue's Origin: line (${compared} compared)`, disagreed.length === 0, disagreed.join('\n'));
  check('every #N a finding outcome names resolves', unresolved.length === 0, unresolved.join('\n'));
  check('every pull request a written outcome names as the cover is merged', notMerged.length === 0, notMerged.join('\n'));

  // proof → files. A test path an issue's own proof names, outside its globs and
  // absent from the tree: the pull request has nowhere to produce the file it
  // proves itself with, so the scope or the proof is wrong.
  const unowned: string[] = [];
  let read = 0;
  for (const [number, node] of answers) {
    if (node.kind !== 'issue') continue;
    const globs = [...parseIssueGlobs(node.body), ...parseIssueAuthorisedGlobs(node.body)];
    for (const path of proofTestPaths(node.body)) {
      read++;
      if (matchesAny(path, globs) || existsSync(join(ROOT, path))) continue;
      unowned.push(`#${number}: \`## Proof\` names ${path}, which is outside its \`## Files\` globs and is not in the tree`);
    }
  }
  check(`no issue proves itself with a test file it neither owns nor has (${read} read)`, unowned.length === 0, unowned.join('\n'));
}

finish();
