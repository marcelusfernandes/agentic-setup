// labels — reads and validates `labels.json`, the one label dictionary of
// this repository (#145). Node built-ins only; no side effect on import.
//
// The file is the union of what the two routes seed, one entry per label
// name, each entry marked with the routes that seed it:
//
//   { "name": "state:done", "color": "0e8a16", "description": "…",
//     "routes": ["codex"], "legacy": true }
//
// `routes` is what makes a union possible without a second dictionary:
// `state:done` is written by the Codex route's state synchronisation and by
// nothing on the Claude route, and the bare `human` label predates the
// `human:pending` / `human:decided` split. `legacy: true` marks a name kept
// so it can still be *read* — `scripts/init.mts` never seeds one.
//
// The Codex helper (`.agents/skills/autonomous-loop/scripts/github.mts`)
// ships as a standalone file inside the plugin package, so it cannot import
// this module: it keeps its list inline and `tests/labels.test.mts` fails
// when the two drift apart.
//
// **Crash policy: fail closed.** Every departure from the schema throws an
// Error naming the file, the entry and the reason. Nothing is defaulted,
// repaired or skipped: a dictionary that cannot be trusted whole must not
// seed a partial set of labels.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export const ROUTES = ['claude', 'codex'] as const;
export type Route = (typeof ROUTES)[number];

/** One label: its name, its GitHub colour, its description and who seeds it. */
export type LabelEntry = {
  name: string;
  color: string;
  description: string;
  routes: Route[];
  /** Kept for reading only — never seeded by any route this repository installs. */
  legacy?: boolean;
};

const KEYS = ['name', 'color', 'description', 'routes', 'legacy'];
const COLOR = /^[0-9a-f]{6}$/;

/** Parses and validates a dictionary; `source` names the file in every message. */
export function parseLabels(text: string, source: string): LabelEntry[] {
  const fail = (reason: string): never => {
    throw new Error(`${source}: ${reason}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return fail(`not valid JSON (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!Array.isArray(parsed)) return fail('must be a JSON array of label entries');
  if (parsed.length === 0) return fail('must hold at least one label');

  const entries: LabelEntry[] = [];
  const seen = new Set<string>();
  parsed.forEach((raw, index) => {
    const at = (reason: string): never => fail(`entry ${index + 1}${typeof (raw as LabelEntry)?.name === 'string' ? ` (${(raw as LabelEntry).name})` : ''}: ${reason}`);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return at('is not an object');
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) if (!KEYS.includes(key)) at(`unknown key "${key}" (allowed: ${KEYS.join(', ')})`);
    if (typeof entry.name !== 'string' || entry.name.trim() === '' || entry.name.trim() !== entry.name) at('"name" must be a non-empty string with no surrounding space');
    if (typeof entry.color !== 'string' || !COLOR.test(entry.color)) at('"color" must be six lowercase hexadecimal digits, with no "#"');
    if (typeof entry.description !== 'string') at('"description" must be a string (empty is allowed, absent is not)');
    if (!Array.isArray(entry.routes) || entry.routes.length === 0) at('"routes" must list at least one route');
    const routes = entry.routes as unknown[];
    for (const route of routes) if (typeof route !== 'string' || !ROUTES.includes(route as Route)) at(`unknown route "${String(route)}" (known: ${ROUTES.join(', ')})`);
    if (new Set(routes).size !== routes.length) at('"routes" repeats a route');
    if ('legacy' in entry && typeof entry.legacy !== 'boolean') at('"legacy" must be true or false when present');

    const name = entry.name as string;
    const key = name.toLowerCase();
    if (seen.has(key)) at(`duplicate name "${name}" (GitHub label names are case-insensitive)`);
    seen.add(key);
    entries.push({
      name,
      color: entry.color as string,
      description: entry.description as string,
      routes: routes as Route[],
      ...(entry.legacy === true ? { legacy: true } : {}),
    });
  });
  return entries;
}

/** Reads the dictionary at `file`; an unreadable file throws, like a malformed one. */
export function loadLabels(file: string): LabelEntry[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${basename(file)}: cannot be read (${err instanceof Error ? err.message : String(err)})`);
  }
  return parseLabels(text, basename(file));
}

/** Every entry a route reads, legacy names included, in dictionary order. */
export function labelsForRoute(labels: LabelEntry[], route: Route): LabelEntry[] {
  return labels.filter((entry) => entry.routes.includes(route));
}

/** Every entry a route seeds: what it reads, minus the legacy names. */
export function seededLabels(labels: LabelEntry[], route: Route): LabelEntry[] {
  return labelsForRoute(labels, route).filter((entry) => !entry.legacy);
}
