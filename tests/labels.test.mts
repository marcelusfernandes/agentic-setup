#!/usr/bin/env node
// Cases for `labels.json`, the one label dictionary this repository seeds
// from (#145), and for the copy of it the Codex route carries inline at
// `.agents/skills/autonomous-loop/scripts/github.mts`.
//
// The Codex helper ships as a standalone file inside the plugin package
// (`scripts/sync-codex-plugin.mts` copies `github.mts` alone), so it cannot
// import a module from `scripts/lib/`: its `LABELS` array stays inline and
// this file is what holds it to the dictionary. The array is read out of the
// source text rather than imported, because importing that file would run
// the helper.
//
// Nothing here imports `scripts/lib/labels.mts`: the dictionary is parsed
// with `JSON.parse` independently, so a bug in the loader cannot make the
// comparison agree with itself.
//
// Negative control: on the base `labels.json` does not exist, so the
// dictionary reads as empty, "labels.json is readable" fails and every
// comparison below fails with it — no case can pass vacuously.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

type Entry = { name: string; color: string; description: string; routes: string[]; legacy?: boolean };

const DICTIONARY = join(ROOT, 'labels.json');
const CODEX_HELPER = join(ROOT, '.agents', 'skills', 'autonomous-loop', 'scripts', 'github.mts');

let raw = '';
let readError = '';
try {
  raw = readFileSync(DICTIONARY, 'utf8');
} catch (err) {
  readError = err instanceof Error ? err.message : String(err);
}
check('labels.json is readable at the repository root', raw !== '', readError);

let entries: Entry[] = [];
let parseError = '';
try {
  const parsed = JSON.parse(raw || 'null');
  if (Array.isArray(parsed)) entries = parsed as Entry[];
  else parseError = 'labels.json is not a JSON array';
} catch (err) {
  parseError = err instanceof Error ? err.message : String(err);
}
check('labels.json is a non-empty JSON array of entries', entries.length > 0, parseError);

// --- the dictionary's own shape: what `scripts/lib/labels.mts` refuses to
// load is also what nobody may commit here.
const ALLOWED_KEYS = ['name', 'color', 'description', 'routes', 'legacy'];
const ROUTES = ['claude', 'codex'];
const malformed = entries.filter(
  (entry) =>
    typeof entry !== 'object' ||
    entry === null ||
    Object.keys(entry).some((key) => !ALLOWED_KEYS.includes(key)) ||
    typeof entry.name !== 'string' ||
    entry.name.trim() !== entry.name ||
    entry.name === '' ||
    !/^[0-9a-f]{6}$/.test(entry.color) ||
    typeof entry.description !== 'string' ||
    !Array.isArray(entry.routes) ||
    entry.routes.length === 0 ||
    entry.routes.some((route) => !ROUTES.includes(route)) ||
    new Set(entry.routes).size !== entry.routes.length ||
    (entry.legacy !== undefined && typeof entry.legacy !== 'boolean'),
);
check('every entry carries a name, a six-digit colour, a description and known routes', malformed.length === 0, JSON.stringify(malformed));
const names = entries.map((entry) => entry.name.toLowerCase());
check('no name appears twice', new Set(names).size === names.length, names.join(', '));

const byName = (name: string): Entry | undefined => entries.find((entry) => entry.name === name);
const routesOf = (name: string): string => (byName(name)?.routes ?? []).join('+');

// --- the union, and the two entries that are not shared (#145).
check('state:done is marked as the Codex route only', routesOf('state:done') === 'codex', routesOf('state:done'));
check('the bare human label is Codex-route only and marked legacy', routesOf('human') === 'codex' && byName('human')?.legacy === true, JSON.stringify(byName('human')));
check('the state labels both routes write are marked for both', ['state:ready', 'state:in-progress', 'state:in-review', 'state:qa-failed', 'state:blocked'].every((name) => routesOf(name) === 'claude+codex'));
check('the two human states are marked for both routes', routesOf('human:pending') === 'claude+codex' && routesOf('human:decided') === 'claude+codex');
check('the type: and review: labels are the Claude route only', [...entries.filter((entry) => /^(type|review):/.test(entry.name))].every((entry) => entry.routes.join('+') === 'claude'));

const claudeSeeded = entries.filter((entry) => entry.routes.includes('claude') && !entry.legacy);
check('the Claude route seeds no legacy label and never state:done', !claudeSeeded.some((entry) => entry.legacy || entry.name === 'state:done'));

// --- the drift check: the Codex helper's inline LABELS, read out of its
// source, must be exactly the codex-routed entries of the dictionary.
let helper = '';
let helperError = '';
try {
  helper = readFileSync(CODEX_HELPER, 'utf8');
} catch (err) {
  helperError = err instanceof Error ? err.message : String(err);
}
const block = helper.match(/\nconst LABELS = \[\n([\s\S]*?)\n\] as const;/);
check('the Codex helper still declares an inline LABELS array', block !== null, helperError || 'no `const LABELS = [ … ] as const;` block found');

// Tuple order there is [name, description, color] — not the dictionary's.
const inline = (block?.[1] ?? '')
  .split('\n')
  .map((line) => line.match(/^\s*\['([^']+)', '([^']*)', '([0-9a-f]{6})'\],$/))
  .filter((match): match is RegExpMatchArray => match !== null)
  .map((match) => ({ name: match[1], description: match[2], color: match[3] }));
check('every line of that array parses as a [name, description, colour] tuple', inline.length > 0 && inline.length === (block?.[1] ?? '').split('\n').length, `${inline.length} parsed`);

const codexEntries = entries.filter((entry) => entry.routes.includes('codex'));
const shape = (label: { name: string; color: string; description: string }) => `${label.name}\t${label.color}\t${label.description}`;
const fromDictionary = codexEntries.map(shape).sort();
const fromHelper = inline.map(shape).sort();
check('the Codex route seeds as many labels as the dictionary marks codex', inline.length > 0 && inline.length === codexEntries.length, `helper ${inline.length}, dictionary ${codexEntries.length}`);
check(
  "the Codex route's inline LABELS equals the dictionary's codex entries, name, colour and description",
  fromDictionary.length > 0 && JSON.stringify(fromDictionary) === JSON.stringify(fromHelper),
  `dictionary:\n${fromDictionary.join('\n')}\nhelper:\n${fromHelper.join('\n')}`,
);

finish();
