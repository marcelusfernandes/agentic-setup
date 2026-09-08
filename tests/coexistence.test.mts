#!/usr/bin/env node
// Codex and legacy Claude setup are independent, opt-in installation routes.
// Exercise both real installers in throwaway git repositories; no GitHub calls.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, commit, finish, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

function run(script: string, cwd: string, args: string[] = []) {
  return spawnSync(RUNTIME, [join(ROOT, 'scripts', script), ...args], { cwd, encoding: 'utf8' });
}

function bytes(repo: string, paths: string[]): Map<string, Buffer> {
  return new Map(paths.map((path) => [path, readFileSync(join(repo, path))]));
}

function unchanged(repo: string, before: Map<string, Buffer>): boolean {
  return [...before].every(([path, content]) => readFileSync(join(repo, path)).equals(content));
}

// Codex setup over a repository already bootstrapped for Claude.
const claudeRepo = tempRepo();
commit(claudeRepo, { 'README.md': '# coexistence\n' }, 'init');
let result = run('init.mts', claudeRepo, ['--no-gh']);
check('legacy setup succeeds without GitHub', result.status === 0, `${result.stdout}${result.stderr}`);
check('legacy setup does not leak the Codex AGENTS template',
  !existsSync(join(claudeRepo, 'AGENTS.md')) &&
  !existsSync(join(claudeRepo, 'codex', 'AGENTS.md')) &&
  !existsSync(join(claudeRepo, 'templates', 'codex', 'AGENTS.md')));
writeFileSync(join(claudeRepo, 'CLAUDE.md'), '# Project Claude instructions\n');
const claudeOwned = [
  'CLAUDE.md', '.claude/settings.json', '.git/hooks/pre-push',
  '.github/workflows/guard-main.yml', '.github/workflows/agentic-checks.yml',
  '.github/scripts/agentic/scope-check.mts', '.github/pull_request_template.md',
];
const beforeClaude = bytes(claudeRepo, claudeOwned);

for (const flags of [['--dry-run'], [], [], ['--force']]) {
  result = run('setup-codex.mts', claudeRepo, ['--target', claudeRepo, ...flags]);
  check(`Codex setup ${flags.join(' ') || 'run'} succeeds over legacy setup`,
    result.status === 0, `${result.stdout}${result.stderr}`);
  check(`Codex setup ${flags.join(' ') || 'run'} preserves Claude-owned files byte-for-byte`,
    unchanged(claudeRepo, beforeClaude));
}
check('Codex setup adds only its local route alongside Claude',
  existsSync(join(claudeRepo, '.agents/skills/autonomous-loop/SKILL.md')) &&
  existsSync(join(claudeRepo, 'AGENTS.md')));

// Legacy setup over a repository already bootstrapped for Codex.
const codexRepo = tempRepo();
commit(codexRepo, { 'README.md': '# coexistence reverse\n' }, 'init');
result = run('setup-codex.mts', codexRepo, ['--target', codexRepo]);
check('Codex setup succeeds before legacy setup', result.status === 0, `${result.stdout}${result.stderr}`);
mkdirSync(join(codexRepo, '.codex'));
writeFileSync(join(codexRepo, '.codex', 'config.toml'), 'model = "user-choice"\n');
const codexOwned = [
  'AGENTS.md', '.codex/config.toml',
  '.agents/skills/autonomous-loop/SKILL.md',
  '.agents/skills/autonomous-loop/references/contract.md',
  '.agents/skills/autonomous-loop/scripts/github.mts',
  '.agents/skills/autonomous-loop/scripts/result.schema.json',
  '.agents/skills/autonomous-loop/scripts/run.mts',
];
const beforeCodex = bytes(codexRepo, codexOwned);
for (const flags of [[], ['--dry-run'], ['--force']]) {
  result = run('init.mts', codexRepo, ['--no-gh', ...flags]);
  check(`legacy setup ${flags.join(' ') || 'run'} succeeds over Codex setup`,
    result.status === 0, `${result.stdout}${result.stderr}`);
  check(`legacy setup ${flags.join(' ') || 'run'} preserves Codex files byte-for-byte`,
    unchanged(codexRepo, beforeCodex));
}

finish();
