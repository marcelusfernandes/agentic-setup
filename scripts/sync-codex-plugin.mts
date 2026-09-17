#!/usr/bin/env node
// Synchronize the isolated native Codex plugin from canonical repository files.
// Built-ins only; --check is read-only. Refuse extras and symlinks before writes.
//
//   node scripts/sync-codex-plugin.mts [--check | --bump patch|minor|major]
//
// `--bump` is the only path that reads or rewrites the published manifest's
// `version`, and it prints its result as one JSON object naming the old and the
// new value. Without it the script behaves as it always has, so `--check` — the
// packaging gate — still answers one question only: whether the snapshot's bytes
// match the canonical source. The two flags are mutually exclusive: a read-only
// check never writes a version.
//
// **Crash policy: fail closed.** Every refusal prints its message and exits 1,
// and a bump validates the manifest before any file is written: a `version` that
// is missing or is not `x.y.z` is refused where it is found, because inventing a
// starting version would publish a number nobody chose.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = join(ROOT, 'plugins', 'agentic-setup');
const SKILL = '.agents/skills/autonomous-loop';
const DESTINATION = 'skills/autonomous-loop';
const SKILL_FILES = [
  'SKILL.md',
  'references/contract.md',
  'scripts/github.mts',
  'scripts/result.schema.json',
  'scripts/run.mts',
];
const COPIES = [
  ...SKILL_FILES.map((file) => ({ source: join(SKILL, file), target: join(DESTINATION, file) })),
  { source: 'LICENSE', target: 'LICENSE' },
];
const MANIFEST = '.codex-plugin/plugin.json';
const STATIC_FILES = [MANIFEST];
const LEVELS = ['patch', 'minor', 'major'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const USAGE = 'usage: sync-codex-plugin.mts [--check | --bump patch|minor|major]';

function stat(path: string) {
  try { return lstatSync(path); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function rejectSymlinkPath(base: string, path: string): void {
  let current = base;
  for (const segment of path.split(/[\\/]/)) {
    current = join(current, segment);
    const info = stat(current);
    if (info?.isSymbolicLink()) throw new Error(`refusing symlink path: ${relative(ROOT, current)}`);
  }
}

/** Returns version with the named level incremented; the lower fields reset to 0. */
function bump(version: string, level: string): string {
  const parts = SEMVER.exec(version);
  if (!parts) throw new Error(`plugin manifest version is not x.y.z: ${JSON.stringify(version)}`);
  const [major, minor, patch] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (level === 'major') return `${major + 1}.0.0`;
  if (level === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** Reads the published manifest and returns its text, its version and the bumped one. */
function planBump(path: string, level: string) {
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error(`plugin manifest is not JSON: ${MANIFEST}`); }
  const version = (parsed as { version?: unknown })?.version;
  if (typeof version !== 'string') {
    throw new Error(`plugin manifest version is not x.y.z: ${JSON.stringify(version ?? null)}`);
  }
  const next = bump(version, level);
  // Rewrite the one field textually: re-serializing the manifest would reflow
  // every other line and publish a diff nobody asked for.
  const field = new RegExp(`("version"\\s*:\\s*)"${version.replaceAll('.', '\\.')}"`, 'g');
  const matches = text.match(field) ?? [];
  if (matches.length !== 1) {
    throw new Error(`plugin manifest version is not rewritable in place: ${MANIFEST}`);
  }
  return { version, next, rewritten: text.replace(field, `$1"${next}"`) };
}

function expectedEntries(): Set<string> {
  const entries = new Set([...STATIC_FILES, ...COPIES.map((copy) => copy.target)]
    .map((entry) => entry.replaceAll('\\', '/')));
  for (const file of [...entries]) {
    let parent = dirname(file);
    while (parent !== '.') { entries.add(parent); parent = dirname(parent); }
  }
  return entries;
}

function actualEntries(directory: string, base = directory): string[] {
  const info = stat(directory);
  if (!info) return [];
  if (info.isSymbolicLink()) throw new Error(`refusing symlink path: ${relative(ROOT, directory)}`);
  if (!info.isDirectory()) return [relative(base, directory).replaceAll('\\', '/')];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    const child = stat(path);
    const shown = relative(base, path).replaceAll('\\', '/');
    if (child?.isSymbolicLink()) throw new Error(`refusing symlink path: ${relative(ROOT, path)}`);
    return child?.isDirectory() ? [shown, ...actualEntries(path, base)] : [shown];
  });
}

try {
  const args = process.argv.slice(2);
  const checkOnly = args.length === 1 && args[0] === '--check';
  const bumping = args.length === 2 && args[0] === '--bump';
  if (!checkOnly && !bumping && args.length > 0) throw new Error(USAGE);
  const level = bumping ? args[1] : null;
  if (level !== null && !LEVELS.includes(level)) {
    throw new Error(`${USAGE}\n--bump takes ${LEVELS.join(', ')}; got ${JSON.stringify(level)}`);
  }

  rejectSymlinkPath(ROOT, 'plugins/agentic-setup');
  for (const copy of COPIES) {
    rejectSymlinkPath(ROOT, copy.source);
    rejectSymlinkPath(PACKAGE, copy.target);
    const sourceInfo = stat(join(ROOT, copy.source));
    if (!sourceInfo?.isFile()) throw new Error(`canonical file missing: ${copy.source}`);
  }

  const canonicalExpected = expectedEntries();
  const canonicalPrefix = `${DESTINATION}/`;
  const expectedCanonical = new Set([...canonicalExpected]
    .filter((entry) => entry === DESTINATION || entry.startsWith(canonicalPrefix))
    .map((entry) => entry === DESTINATION ? '' : entry.slice(canonicalPrefix.length))
    .filter(Boolean));
  const unexpectedCanonical = actualEntries(join(ROOT, SKILL))
    .filter((entry) => !expectedCanonical.has(entry));
  if (unexpectedCanonical.length) {
    throw new Error(`unexpected canonical skill path: ${unexpectedCanonical.sort()[0]}`);
  }

  const expected = expectedEntries();
  const unexpected = actualEntries(PACKAGE).filter((entry) => !expected.has(entry));
  if (unexpected.length) throw new Error(`unexpected plugin path: ${unexpected.sort()[0]}`);
  for (const file of STATIC_FILES) {
    if (!stat(join(PACKAGE, file))?.isFile()) throw new Error(`static plugin file missing: ${file}`);
  }

  // Read and validate the version before the first copy, so a manifest this
  // script cannot bump refuses the whole run instead of half-publishing it.
  const planned = level === null ? null : planBump(join(PACKAGE, MANIFEST), level);

  const drift = COPIES.flatMap((copy) => {
    const source = join(ROOT, copy.source);
    const target = join(PACKAGE, copy.target);
    const targetInfo = stat(target);
    if (!targetInfo) return [{ ...copy, state: 'missing' }];
    if (!targetInfo.isFile()) throw new Error(`unexpected plugin path: ${copy.target}`);
    return readFileSync(source).equals(readFileSync(target)) ? [] : [{ ...copy, state: 'stale' }];
  });

  if (checkOnly && drift.length) {
    throw new Error(drift.map((entry) => `${entry.state}: ${entry.target}`).join('\n'));
  }
  for (const entry of drift) {
    mkdirSync(dirname(join(PACKAGE, entry.target)), { recursive: true });
    copyFileSync(join(ROOT, entry.source), join(PACKAGE, entry.target));
  }
  if (planned) {
    writeFileSync(join(PACKAGE, MANIFEST), planned.rewritten);
    console.log(JSON.stringify({
      bump: level,
      version: { from: planned.version, to: planned.next },
      files: drift.length,
    }));
  } else {
    console.log(checkOnly ? 'Codex plugin snapshot is current.' :
      `Codex plugin snapshot synchronized (${drift.length} file(s) updated).`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
