#!/usr/bin/env node
// Pin test for the `scripts/` bullet of the `## Map` section, in AGENTS.md and
// CLAUDE.md (issue #202). The bullet is the only inventory of `scripts/` a reader
// gets, and it had no consumer: it still named four scripts long after seven more
// had landed, and it still described `init.mts` as copying `agents/`, `skills/`,
// `templates/`, `docs/` when `scripts/init.mts` copies none of the first, second
// or fourth.
//
// The pin is a rule over the directory, never a hand-typed list: it reads
// `scripts/*.mts` from disk, so a script added without a Map row fails here on the
// commit that adds it. The installer half is a rule over `scripts/init.mts` for the
// same reason — it parses that file's own top-level `copyTree`/`copyOne` calls and
// refuses any repository directory the sentence names that no such call touches.
//
// Pure-read: no script is spawned, only the filesystem. Invariant 6 has no target
// here: it asks a case for a hook, a CI script or the installer to run the real
// file, and nothing under `hooks/`, `ci/` or `scripts/` implements the Map —
// `tests/init.test.mts` is where `init.mts` itself is spawned. What licenses the
// shape below is invariant 10 (CLAUDE.md and AGENTS.md, the two files this pins):
// the bullet grammar and the `copyTree`/`copyOne` reading are stated here rather
// than imported from a shared parser, because a pin that reuses the thing it pins
// cannot catch that thing drifting. Crash policy: fails closed — an unreadable
// file or an unparseable Map throws, and a bullet or sentence that cannot be
// located is an assertion red rather than a silent pass.
//
// Since #330 this file pins one more thing, and it is about itself: invariant 10 is
// asserted to exist, once, inside the `## Invariants` section of both documents and
// identical between them, and the two corrected headers are read back for the rule
// they cite. A citation nothing checks is how a wrong one survived two reviews.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

/** The two documents that carry the Map, relative to the repository root. */
const MAP_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** The exact opening of the bullet this file pins. The closing backtick matters:
 *  CLAUDE.md also carries a `- `scripts/setup-codex.mts` — ...` bullet. */
const BULLET_PREFIX = '- `scripts/` — ';

/** The opening of the parenthetical that describes what `init` copies. */
const INSTALLER_OPEN = '(the installer:';

/** Reads a repository file as text. */
function read(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8');
}

/** The body of the `## Map` section, up to the next `## ` heading; null when absent. */
function mapSection(text: string): string | null {
  const heading = '\n## Map\n';
  const at = text.indexOf(heading);
  if (at === -1) return null;
  const rest = text.slice(at + heading.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * The `scripts/` bullet: its first line plus every following continuation line
 * (two spaces then non-space). Returned verbatim, so two files can be compared
 * byte for byte.
 */
function scriptsBullet(section: string): string | null {
  const lines = section.split('\n');
  const at = lines.findIndex((line) => line.startsWith(BULLET_PREFIX));
  if (at === -1) return null;
  const bullet = [lines[at] as string];
  for (const line of lines.slice(at + 1)) {
    if (!/^ {2}\S/.test(line)) break;
    bullet.push(line);
  }
  return bullet.join('\n');
}

/** The installer parenthetical of a bullet, without its brackets; null when absent. */
function installerSentence(bullet: string): string | null {
  const open = bullet.indexOf(INSTALLER_OPEN);
  if (open === -1) return null;
  const close = bullet.indexOf(')', open);
  return close === -1 ? null : bullet.slice(open + 1, close);
}

/** Every backticked token of a span, in order. */
function backticked(span: string): string[] {
  return [...span.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
}

/** The first path segment of a token, with a leading `./` and a trailing `/` dropped. */
function firstSegment(token: string): string {
  return (token.replace(/^\.\//, '').split('/')[0] ?? '').trim();
}

/** True when `span` names `path` as a backticked token, with or without a trailing slash. */
function names(span: string, path: string): boolean {
  return span.includes(`\`${path}\``) || span.includes(`\`${path}/\``);
}

// --- what the repository actually has -------------------------------------------

const scripts = readdirSync(join(ROOT, 'scripts'))
  .filter((name) => name.endsWith('.mts'))
  .sort();

check('scripts/ holds at least one .mts script to pin', scripts.length > 0);

// --- what scripts/init.mts actually copies ---------------------------------------
// Only top-level statements are read (`copyTree(` / `copyOne(` at column 0), so the
// definitions of the two helpers and the recursive call inside `copyTree` are not
// mistaken for installs. Each call's `join(PLUGIN, ...)` is its source and its
// `join(root, ...)` its destination; the repository directories it touches are the
// first segments of both.

const init = read(join('scripts', 'init.mts'));
const calls = [...init.matchAll(/^(?:copyTree|copyOne)\(([^;]*)\);$/gm)].map((m) => m[1] as string);

check(
  'scripts/init.mts still makes top-level copyTree/copyOne calls to read',
  calls.length >= 3,
  `found ${calls.length}`,
);

/** The `'a', 'b'` segments of the first `join(<base>, ...)` of a call, as a path. */
function joinedPath(call: string, base: 'PLUGIN' | 'root'): string | null {
  const at = call.indexOf(`join(${base},`);
  if (at === -1) return null;
  const close = call.indexOf(')', at);
  if (close === -1) return null;
  const segments = [...call.slice(at, close).matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
  return segments.length > 0 ? segments.join('/') : null;
}

const installs = calls
  .map((call) => ({ source: joinedPath(call, 'PLUGIN'), destination: joinedPath(call, 'root') }))
  .filter((i): i is { source: string; destination: string } => i.source !== null && i.destination !== null);

check('every copy call names a source under the plugin and a destination under the root', installs.length === calls.length, `${installs.length} of ${calls.length}`);

/** The repository directories the installer touches: first segment of each side. */
const touched = new Set(installs.flatMap((i) => [firstSegment(i.source), firstSegment(i.destination)]));

// --- AC2a: the bullet names every scripts/*.mts, in both files --------------------

const bullets = MAP_FILES.map((file) => {
  const section = mapSection(read(file));
  check(`${file} has a \`## Map\` section`, section !== null);
  const bullet = section === null ? null : scriptsBullet(section);
  check(`${file} has a \`scripts/\` bullet in its Map`, bullet !== null);
  return { file, bullet };
});

for (const { file, bullet } of bullets) {
  if (bullet === null) continue;
  for (const script of scripts) {
    check(
      `AC2a ${file} names \`${script}\` in the \`scripts/\` bullet`,
      bullet.includes(`\`${script}\``),
      bullet,
    );
  }
}

// --- AC2b: the installer sentence names nothing init does not copy ----------------

for (const { file, bullet } of bullets) {
  if (bullet === null) continue;
  const sentence = installerSentence(bullet);
  check(`AC2b ${file} describes the installer as \`${INSTALLER_OPEN} …)\``, sentence !== null, bullet);
  if (sentence === null) continue;

  for (const token of backticked(sentence)) {
    const segment = firstSegment(token);
    if (segment === '' || !existsSync(join(ROOT, segment))) continue;
    check(
      `AC2b ${file} installer sentence names \`${token}\`, which a copy call touches`,
      touched.has(segment),
      `${sentence}\n      copy calls touch: ${[...touched].sort().join(', ')}`,
    );
  }

  for (const { source, destination } of installs) {
    check(
      `AC2b ${file} installer sentence names the copied \`${source}\``,
      names(sentence, source),
      sentence,
    );
    check(
      `AC2b ${file} installer sentence names its destination \`${destination}\``,
      names(sentence, destination),
      sentence,
    );
  }
}

// --- AC3: the two files stay byte-identical on this bullet -----------------------
// tests/doctrine.test.mts proves a different sentence is shared verbatim; this is the
// same check for the `scripts/` line, without touching that file.

const [first, second] = bullets;
check(
  `AC3 the \`scripts/\` bullet is byte-identical in ${MAP_FILES.join(' and ')}`,
  first?.bullet !== null && first?.bullet === second?.bullet,
  `${first?.file}:\n      ${first?.bullet}\n      ${second?.file}:\n      ${second?.bullet}`,
);

// --- #330: the invariant these pin headers cite exists, in both documents --------
// A citation is worth no more than the rule behind it. Both headers this issue
// corrected cited invariant 6 for an exemption invariant 6 does not grant, and nothing
// failed — the defect waited for a reader. Invariant 10 is the rule that licenses the
// shape of both files, so it is pinned the way AC3 above pins the bullet: present, in
// the `## Invariants` section, stated once, and identical across the two documents.
// Same shape as tests/doctrine.test.mts's doctrine pin, done here because these two
// documents are already this file's subject.

/** The invariant both pin headers cite, character for character, collapsed to one line. */
const PIN_INVARIANT =
  '10. **A pin states what it pins.** A test over prose or data — a Map bullet, a proof '
  + 'declaration, a catalogue — writes the expected shape out itself rather than importing '
  + 'the parser or the list it checks: a pin that reuses the thing it pins cannot catch '
  + 'that thing drifting. The duplication is the point; the pin names what it mirrors.';

/** Its first and last words, used to extract each file's copy so a drifted middle is
 *  reported with the divergent text rather than as a bare "not found". */
const INVARIANT_HEAD = '10. **A pin states what it pins.**';
const INVARIANT_TAIL = 'the pin names what it mirrors.';

/** Every whitespace run collapsed to one space, so a wrapped item compares as one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The body of the `## Invariants …` section. The heading carries a parenthetical, so it
 *  is found by prefix and the body starts after that heading's own line; null when absent. */
function invariantsSection(text: string): string | null {
  const at = text.indexOf('\n## Invariants');
  if (at === -1) return null;
  const from = text.indexOf('\n', at + 1);
  if (from === -1) return null;
  const rest = text.slice(from + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** The invariant-shaped span of a collapsed section; null when either end is missing. */
function invariantSpan(flat: string): string | null {
  const start = flat.indexOf(INVARIANT_HEAD);
  if (start === -1) return null;
  const end = flat.indexOf(INVARIANT_TAIL, start);
  return end === -1 ? null : flat.slice(start, end + INVARIANT_TAIL.length);
}

const invariants = MAP_FILES.map((file) => {
  const body = invariantsSection(read(file));
  const flat = body === null ? null : oneLine(body);
  return { file, flat };
});

for (const { file, flat } of invariants) {
  check(`#330 ${file} has an \`## Invariants\` section to read`, flat !== null);
  if (flat === null) continue;
  check(
    `#330 ${file} states the invariant both pin headers cite, character for character`,
    flat.includes(PIN_INVARIANT),
    `expected inside ${file}'s ## Invariants:\n      ${PIN_INVARIANT}`,
  );
  check(
    `#330 ${file} states it exactly once`,
    flat.split(PIN_INVARIANT).length === 2,
    `${flat.split(PIN_INVARIANT).length - 1} occurrence(s)`,
  );
}

const [firstInvariant, secondInvariant] = invariants.map(({ file, flat }) => ({
  file,
  span: flat === null ? null : invariantSpan(flat),
}));
check(
  `#330 the invariant is identical in ${MAP_FILES.join(' and ')}`,
  firstInvariant?.span != null && firstInvariant.span === secondInvariant?.span,
  `${firstInvariant?.file}:\n      ${firstInvariant?.span}\n      ${secondInvariant?.file}:\n      ${secondInvariant?.span}`,
);

// --- #330: and the two headers cite it, without the claim invariant 6 never made ---
// Each header is read only down to that file's first `import` line, so the two constants
// above and below — which necessarily carry the phrases they pin — are outside what is
// read. The `//` markers are stripped and the lines joined before matching, because the
// wrong claim straddles a line break in both files at the base: a matcher that reads the
// lines apart finds nothing and reports a clean that is not there.

const HEADER_FILES = ['tests/map-pin.test.mts', 'tests/proof-declarations.test.mts'] as const;
const WRONG_CLAIM = 'invariant 6 exempts catalogue reads';

/** A file's leading comment block as one line of prose, markers stripped. */
function headerProse(text: string): string | null {
  const cut = text.indexOf('\nimport ');
  if (cut === -1) return null;
  return oneLine(text.slice(0, cut).split('\n').map((line) => line.replace(/^\s*(?:#!.*|\/\/ ?)/, '')).join(' '));
}

for (const file of HEADER_FILES) {
  const header = headerProse(read(file));
  check(`#330 ${file} has a header to read`, header !== null);
  if (header === null) continue;
  check(
    `#330 ${file}'s header does not claim invariant 6 exempts catalogue reads`,
    !header.includes(WRONG_CLAIM),
    header,
  );
  check(
    `#330 ${file}'s header cites invariant 10 for the shape it uses`,
    /\binvariant 10\b/.test(header),
    header,
  );
}

finish();
