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

finish();
