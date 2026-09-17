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
// template must *not* match it, and every dated report must.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DOGFOOD_REPORT_RE } from '../ci/lib/scope.mts';
import { check, finish, ROOT } from './lib/harness.mts';

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
const SECTIONS = ['## Scoreboard', '## Findings'];
const SCOREBOARD_COLUMNS = ['case', 'exit', 'error class', 'tool calls', 'decision', 'reason'];
const FINDINGS_COLUMNS = ['finding', 'origin', 'outcome'];
const row = (columns: string[]) => `| ${columns.join(' | ')} |`;
const SCOREBOARD_HEADER = row(SCOREBOARD_COLUMNS);
const FINDINGS_HEADER = row(FINDINGS_COLUMNS);
const DECISIONS = ['keep', 'fix'];
/** A `<...>` field nobody filled in. An HTML comment is stripped before this runs. */
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
    if (!MONEY.test(value('Cost (USD)')) && !absent(value('Cost (USD)'))) {
      errors.push(`${name}: "Cost (USD)" must be a number${orAbsent}, got "${value('Cost (USD)')}"`);
    }
  }
  return errors;
}

// --- fixtures: the refusal paths, each one line away from the valid document ---

const VALID = [
  '# Dogfood 2026-01-31 — the loop end to end against a disposable repository',
  '',
  '- Repository: example/disposable',
  '- Commit: 0123456789abcdef0123456789abcdef01234567',
  '- Turns: 41',
  '- Minutes: 96',
  '- Cost (USD): 12.40',
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
fixture(
  'a report with no Retroactive bullet may not write `not recorded`',
  swap('- Turns: 41', `- Turns: ${NOT_RECORDED}`),
  false,
  /"Turns" must be a whole number/,
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

// Docs equal code: the README is where a reader meets this grammar, so it has
// to carry the parts this file enforces — both fixed table headers and all six
// header bullet labels. Existence alone would let the prose drift away from the
// rules above while the pin stayed green.
const readme = entries.includes('README.md') ? readFileSync(join(dir, 'README.md'), 'utf8') : '';
const stated = [
  SCOREBOARD_HEADER,
  FINDINGS_HEADER,
  ...[...BULLETS, RETROACTIVE].map((b) => `\`${b}\``),
  // The escape is a rule of the format, so the README owes it a sentence too.
  `\`${NOT_RECORDED}\``,
];
const unstated = stated.filter((part) => !readme.includes(part));
check(
  'docs/dogfood/README.md states the format this test enforces',
  readme !== '' && unstated.length === 0,
  readme === '' ? entries.join(', ') : `not stated in the README: ${unstated.join(', ')}`,
);
check(
  'docs/dogfood/ holds nothing but README.md, TEMPLATE.md and dated reports',
  exists && entries.every((n) => n === 'README.md' || n === 'TEMPLATE.md' || DOGFOOD_REPORT_RE.test(`docs/dogfood/${n}`)),
  entries.join(', '),
);
// The #182 coupling, both ways: what `scope` and `close-milestone` count as a
// report is exactly what this test validates as one.
for (const name of ['README.md', 'TEMPLATE.md']) {
  check(`docs/dogfood/${name} is not counted as a report by scope`, !DOGFOOD_REPORT_RE.test(`docs/dogfood/${name}`));
}

if (entries.includes('TEMPLATE.md')) {
  const template = readFileSync(join(dir, 'TEMPLATE.md'), 'utf8');
  const errors = validate('TEMPLATE.md', template);
  check('docs/dogfood/TEMPLATE.md is the valid-but-empty case', errors.length === 0, errors.join('\n'));
  check(
    'docs/dogfood/TEMPLATE.md is still empty (every field a placeholder)',
    PLACEHOLDER.test(template.replace(/<!--[\s\S]*?-->/g, '')),
  );
}

for (const name of entries.filter((n) => DOGFOOD_REPORT_RE.test(`docs/dogfood/${n}`))) {
  const text = readFileSync(join(dir, name), 'utf8');
  const errors = validate(name, text);
  check(`docs/dogfood/${name} parses`, errors.length === 0, errors.join('\n'));
  const date = name.slice(0, -'.md'.length);
  const heading = text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  check(`docs/dogfood/${name}: the heading date matches the filename`, heading.includes(`# Dogfood ${date} `), heading);
  check(`docs/dogfood/${name} is filled, not the template`, !PLACEHOLDER.test(text.replace(/<!--[\s\S]*?-->/g, '')));
}

finish();
