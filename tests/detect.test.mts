#!/usr/bin/env node
// Cases for ci/lib/detect.mts: detectCommands is a pure function (CLAUDE.md
// invariant 6), so these import it directly and point it at temp
// directories holding only the marker files for one stack.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectCommands } from '../ci/lib/detect.mts';
import { check, cleanup, commit, finish, tempRepo } from './lib/harness.mts';

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
check('ruby with spec/ has no check without rubocop config', c.check === null && c.stack === 'ruby', JSON.stringify(c));

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

const markerFiles: Array<Record<string, string>> = [{ Gemfile: '' }, { 'mix.exs': '' }, { 'build.gradle': '' }, { 'pom.xml': '' }];
for (const files of markerFiles) {
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

// --- AC: a Python test tree that carries no packaging marker (#256) ---
// These trees are real git repositories: the last-resort signal reads
// `git ls-files`, so "has a test file" means tracked, not merely on disk.

// A packaging marker still answers pytest, even next to a tracked test file.
let repo = tempRepo();
commit(repo, { 'pyproject.toml': '', 'test_engine.py': '' }, 'python with a marker');
c = detectCommands(repo, {});
check(
  'a packaging marker still wins over the test-tree fallback',
  c.test === 'pytest' && c.check === null && c.stack === 'python' && c.source === 'detected',
  JSON.stringify(c),
);

// No marker at all, but a tracked test_*.py at depth: the last-resort signal.
repo = tempRepo();
commit(repo, { 'engine/runner.py': '', 'engine/test_engine.py': '' }, 'python scripts only');
c = detectCommands(repo, {});
check(
  'a tracked test_*.py with no marker detects python',
  c.test === 'python3 -m unittest discover' && c.check === null && c.stack === 'python' && c.source === 'detected',
  JSON.stringify(c),
);

repo = tempRepo();
commit(repo, { 'engine_test.py': '' }, 'python with the suffix spelling');
c = detectCommands(repo, {});
check(
  'a tracked *_test.py with no marker detects python',
  c.test === 'python3 -m unittest discover' && c.stack === 'python',
  JSON.stringify(c),
);

repo = tempRepo();
commit(repo, { 'tests/helpers.py': '' }, 'python with a tests directory');
c = detectCommands(repo, {});
check(
  'a tracked tests/ holding a .py with no marker detects python',
  c.test === 'python3 -m unittest discover' && c.stack === 'python',
  JSON.stringify(c),
);

// Neither a marker nor a test tree: unchanged, still unknown.
repo = tempRepo();
commit(repo, { 'main.py': '', 'README.md': '' }, 'python sources with no tests');
c = detectCommands(repo, {});
check(
  'python sources with no marker and no test tree stay unknown',
  c.stack === 'unknown' && c.test === null && c.source === 'none',
  JSON.stringify(c),
);

// The fallback is last, so no repository that detects today changes its answer.
repo = tempRepo();
commit(repo, { 'go.mod': '', 'test_engine.py': '' }, 'go repo that also ships a python test');
c = detectCommands(repo, {});
check(
  'a tracked test_*.py does not steal a repository that already detects',
  c.test === 'go test ./...' && c.stack === 'go',
  JSON.stringify(c),
);

// A file that only looks like a test name is not a signal.
repo = tempRepo();
commit(repo, { 'my_latest_thing.py': '', 'contest_helper.py': '' }, 'python names that merely contain test');
c = detectCommands(repo, {});
check(
  'a .py whose name merely contains "test" is not a signal',
  c.stack === 'unknown' && c.test === null,
  JSON.stringify(c),
);

// Untracked, and outside a repository: the signal is tracked files only.
repo = tempRepo();
writeFileSync(join(repo, 'test_engine.py'), '');
c = detectCommands(repo, {});
check('an untracked test_*.py is not a signal', c.stack === 'unknown' && c.test === null, JSON.stringify(c));

d = tempDir({ 'test_engine.py': '' });
c = detectCommands(d, {});
check('a test_*.py outside a git repository is not a signal', c.stack === 'unknown' && c.test === null, JSON.stringify(c));

// The env override still wins over the fallback.
repo = tempRepo();
commit(repo, { 'test_engine.py': '' }, 'python test tree');
c = detectCommands(repo, { AGENTIC_TEST_CMD: 'custom test' });
check(
  'env overrides the python test-tree fallback',
  c.test === 'custom test' && c.source === 'override',
  JSON.stringify(c),
);

finish();
