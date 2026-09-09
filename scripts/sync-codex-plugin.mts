#!/usr/bin/env node
// Synchronize the isolated native Codex plugin from canonical repository files.
// Built-ins only; --check is read-only. Refuse extras and symlinks before writes.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
const STATIC_FILES = ['.codex-plugin/plugin.json'];

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
  const checkOnly = process.argv.length === 3 && process.argv[2] === '--check';
  if (process.argv.length > (checkOnly ? 3 : 2)) {
    throw new Error('usage: sync-codex-plugin.mts [--check]');
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
  console.log(checkOnly ? 'Codex plugin snapshot is current.' :
    `Codex plugin snapshot synchronized (${drift.length} file(s) updated).`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
