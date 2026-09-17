#!/usr/bin/env node
// Pin test for `proof/<slug>.json` (issue #136): every declaration this
// repository ships must be readable by `ci/negative-control.mts` before CI
// ever reads it. A declaration names the files the negative control overlays
// on the base, so a typo in it silently narrows the control instead of
// failing it — this file is the consumer that makes the typo loud.
//
// Pure-read: no script is spawned, only the filesystem (CLAUDE.md invariant 6
// exempts catalogue reads). The validation is deliberately written out here
// rather than imported from the script under test: a pin test that reuses the
// parser it pins cannot catch that parser drifting away from the documented
// shape.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny } from '../ci/lib/globs.mts';
import { check, finish, ROOT } from './lib/harness.mts';

// Mirrors TEST_FILE_GLOBS in ci/negative-control.mts. Duplicated on purpose:
// the script's list is module-private (importing it would execute the
// script), and pinning a copy makes a divergence visible here.
const TEST_FILE_GLOBS = [
  '**/*.test.*', '**/*.spec.*', '**/*_test.go', '**/test_*.py', '**/*_test.py',
  '**/tests/**', '**/test/**', '**/__tests__/**', 'e2e/**', 'spec/**',
];
// The documented shape: `tests` is required, `command` and `describes` are
// optional (`describes` is #164's key, accepted here so both issues read the
// same file). Anything else is a typo until it is documented.
const KNOWN_KEYS = ['tests', 'command', 'describes'];
const SLUG = /^[a-z0-9-]+$/;

const dir = join(ROOT, 'proof');

check('proof/ exists', existsSync(dir) && statSync(dir).isDirectory());
check('proof/README.md documents the declaration format', existsSync(join(dir, 'README.md')));

const entries = existsSync(dir) ? readdirSync(dir).sort() : [];
const declarations = entries.filter((name) => name.endsWith('.json'));

check(
  'proof/ holds nothing but README.md and *.json declarations',
  entries.every((name) => name === 'README.md' || name.endsWith('.json')),
  entries.join(', '),
);
check('proof/ ships at least one declaration', declarations.length > 0, entries.join(', '));

for (const name of declarations) {
  const slug = name.slice(0, -'.json'.length);
  check(`${name}: the slug matches ^[a-z0-9-]+$`, SLUG.test(slug), slug);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch (error) {
    check(`${name}: parses as JSON`, false, String(error));
    continue;
  }
  check(`${name}: parses as JSON`, true);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    check(`${name}: is a JSON object`, false, JSON.stringify(parsed));
    continue;
  }
  check(`${name}: is a JSON object`, true);
  const decl = parsed as Record<string, unknown>;

  const unknown = Object.keys(decl).filter((key) => !KNOWN_KEYS.includes(key));
  check(`${name}: carries no key outside ${KNOWN_KEYS.join('/')}`, unknown.length === 0, unknown.join(', '));

  const tests = decl.tests;
  const testsOk = Array.isArray(tests) && tests.length > 0 && tests.every((t) => typeof t === 'string' && t.trim() !== '');
  check(`${name}: "tests" is a non-empty array of paths`, testsOk, JSON.stringify(tests));
  if (testsOk) {
    for (const file of tests as string[]) {
      check(`${name}: "${file}" exists`, existsSync(join(ROOT, file)));
      check(`${name}: "${file}" matches a test glob`, matchesAny(file, TEST_FILE_GLOBS));
    }
  }

  if ('command' in decl) {
    check(`${name}: "command" is a non-empty string`, typeof decl.command === 'string' && decl.command.trim() !== '', JSON.stringify(decl.command));
  }
  if ('describes' in decl) {
    check(`${name}: "describes" is a non-empty string`, typeof decl.describes === 'string' && decl.describes.trim() !== '', JSON.stringify(decl.describes));
  }
}

finish();
