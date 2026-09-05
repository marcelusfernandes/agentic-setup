#!/usr/bin/env node
// Cases for ci/lib/detect.mts: detectCommands is a pure function (CLAUDE.md
// invariant 6), so these import it directly and point it at temp
// directories holding only the marker files for one stack.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectCommands } from '../ci/lib/detect.mts';
import { check, cleanup, finish } from './lib/harness.mts';

function tempDir(files: Record<string, string> = {}, dirs: string[] = []): string {
  const d = mkdtempSync(join(tmpdir(), 'agentic-detect-'));
  cleanup(() => rmSync(d, { recursive: true, force: true }));
  for (const name of dirs) mkdirSync(join(d, name), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(d, name)), { recursive: true });
    writeFileSync(join(d, name), content);
  }
  return d;
}

// --- AC1: Ruby, Elixir, Gradle, Maven ---

let d = tempDir({ Gemfile: '' }, ['spec']);
let c = detectCommands(d, {});
check('ruby with spec/ uses rspec', c.test === 'bundle exec rspec' && c.stack === 'ruby' && c.source === 'detected', JSON.stringify(c));
check('ruby with spec/ has no check without rubocop config', c.check === null, JSON.stringify(c));

d = tempDir({ Gemfile: '' });
c = detectCommands(d, {});
check('ruby without spec/ falls back to rake test', c.test === 'bundle exec rake test' && c.stack === 'ruby', JSON.stringify(c));

d = tempDir({ Gemfile: '', '.rubocop.yml': '' });
c = detectCommands(d, {});
check('ruby with .rubocop.yml adds a rubocop check', c.check === 'bundle exec rubocop' && c.stack === 'ruby', JSON.stringify(c));

d = tempDir({ 'mix.exs': '' });
c = detectCommands(d, {});
check(
  'elixir detects mix test and a format check',
  c.test === 'mix test' && c.check === 'mix format --check-formatted' && c.stack === 'elixir' && c.source === 'detected',
  JSON.stringify(c),
);

d = tempDir({ 'build.gradle': '', gradlew: '' });
c = detectCommands(d, {});
check('gradle with a wrapper uses ./gradlew test', c.test === './gradlew test' && c.stack === 'gradle' && c.source === 'detected', JSON.stringify(c));

d = tempDir({ 'build.gradle.kts': '' });
c = detectCommands(d, {});
check('gradle.kts without a wrapper falls back to gradle test', c.test === 'gradle test' && c.stack === 'gradle', JSON.stringify(c));

d = tempDir({ 'pom.xml': '' });
c = detectCommands(d, {});
check('maven detects mvn -q test', c.test === 'mvn -q test' && c.stack === 'maven' && c.source === 'detected', JSON.stringify(c));

// --- AC2: Makefile still wins over everything ---

d = tempDir({ Makefile: 'test:\n\techo hi\n', Gemfile: '', 'mix.exs': '', 'pom.xml': '' });
c = detectCommands(d, {});
check('Makefile wins over other stacks', c.test === 'make test' && c.stack === 'make', JSON.stringify(c));

// --- AC3: env still overrides every new stack ---

for (const files of [{ Gemfile: '' }, { 'mix.exs': '' }, { 'build.gradle': '' }, { 'pom.xml': '' }]) {
  d = tempDir(files);
  c = detectCommands(d, { AGENTIC_TEST_CMD: 'custom test', AGENTIC_CHECK_CMD: 'custom check' });
  check(`env overrides ${Object.keys(files)[0]}`, c.test === 'custom test' && c.check === 'custom check' && c.source === 'override', JSON.stringify(c));
}

// --- regression: existing stacks (this file is new, so these are free) ---

d = tempDir({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }) });
c = detectCommands(d, {});
check('node (npm) detects npm test', c.test === 'npm test' && c.stack === 'node', JSON.stringify(c));

d = tempDir({ 'package.json': JSON.stringify({ scripts: { test: 'vitest' } }), 'pnpm-lock.yaml': '' });
c = detectCommands(d, {});
check('node (pnpm) detects pnpm test', c.test === 'pnpm test' && c.stack === 'node', JSON.stringify(c));

d = tempDir({ 'pyproject.toml': '' });
c = detectCommands(d, {});
check('python detects pytest', c.test === 'pytest' && c.stack === 'python', JSON.stringify(c));

d = tempDir({ 'go.mod': '' });
c = detectCommands(d, {});
check('go detects go test', c.test === 'go test ./...' && c.stack === 'go', JSON.stringify(c));

d = tempDir({ 'Cargo.toml': '' });
c = detectCommands(d, {});
check('rust detects cargo test', c.test === 'cargo test' && c.stack === 'rust', JSON.stringify(c));

d = tempDir({ Makefile: 'test:\n\techo hi\n' });
c = detectCommands(d, {});
check('makefile detects make test', c.test === 'make test' && c.stack === 'make', JSON.stringify(c));

d = tempDir({});
c = detectCommands(d, {});
check('unknown stack when nothing matches', c.stack === 'unknown' && c.source === 'none' && c.test === null, JSON.stringify(c));

finish();
