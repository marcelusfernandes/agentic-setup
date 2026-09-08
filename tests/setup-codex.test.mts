#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, commit, finish, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

const repo = tempRepo(); const skill = join(repo, '.agents/skills/autonomous-loop');
function setup(...flags: string[]) {
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts/setup-codex.mts'), '--target', repo, ...flags], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, data: JSON.parse(r.stdout || '{}') };
}
let r = setup('--dry-run');
check('preview does not create files', r.code === 0 && !existsSync(skill) && !existsSync(join(repo, 'AGENTS.md')), r.out);
r = setup();
check('setup installs a discoverable, self-contained Codex skill', r.code === 0 && existsSync(join(skill, 'SKILL.md')) && existsSync(join(skill, 'scripts/github.mts')) && existsSync(join(skill, 'scripts/run.mts')), r.out);
check('setup supplies minimal project instructions in a new repository', existsSync(join(repo, 'AGENTS.md')));
check('setup does not install Claude configuration or change the GitHub workflow', !existsSync(join(repo, '.claude')) && !existsSync(join(repo, '.github')) && !existsSync(join(repo, '.codex')));
r = setup(); check('repeat installation is idempotent', r.code === 0 && r.data.files.every((f: any) => f.action === 'unchanged'), r.out);
writeFileSync(join(repo, 'AGENTS.md'), 'User project instructions\n');
mkdirSync(join(repo, '.codex')); writeFileSync(join(repo, '.codex/config.toml'), 'model = "user-choice"\n');
writeFileSync(join(skill, 'SKILL.md'), 'User edited skill\n');
r = setup(); check('modified installed skills cause a conflict instead of being overwritten', r.code === 1 && readFileSync(join(skill, 'SKILL.md'), 'utf8') === 'User edited skill\n', r.out);
r = setup('--force'); check('explicit force replaces only the distributed skill files', r.code === 0 && readFileSync(join(skill, 'SKILL.md'), 'utf8').includes('name: autonomous-loop'), r.out);
check('existing project instructions and model settings survive even force', readFileSync(join(repo, 'AGENTS.md'), 'utf8') === 'User project instructions\n' && readFileSync(join(repo, '.codex/config.toml'), 'utf8') === 'model = "user-choice"\n');
const invoked = spawnSync(RUNTIME, [join(skill, 'scripts/github.mts')], { cwd: repo, encoding: 'utf8' });
check('installed helper resolves without dependencies on the source repository', invoked.status === 1 && /usage: github.mts/.test(invoked.stdout), invoked.stderr);

const symlinkRepo = tempRepo();
commit(symlinkRepo, { 'README.md': '# symlink target test\n' }, 'init');
const outside = tempRepo();
commit(outside, { 'marker.txt': 'outside stays untouched\n' }, 'init');
symlinkSync(outside, join(symlinkRepo, '.agents'));
const outsideMarker = readFileSync(join(outside, 'marker.txt'));
for (const flag of ['--dry-run', '--force']) {
  const blocked = spawnSync(
    RUNTIME,
    [join(ROOT, 'scripts/setup-codex.mts'), '--target', symlinkRepo, flag],
    { encoding: 'utf8' },
  );
  check(`setup ${flag} rejects a symlinked destination before writing`,
    blocked.status === 1 && /refusing symlink in destination path/.test(blocked.stderr),
    `${blocked.stdout}${blocked.stderr}`);
  check(`setup ${flag} leaves the outside directory untouched`,
    readFileSync(join(outside, 'marker.txt')).equals(outsideMarker) &&
    !existsSync(join(outside, 'skills')) && !existsSync(join(outside, 'autonomous-loop')));
  check(`setup ${flag} leaves no partial project instructions`,
    !existsSync(join(symlinkRepo, 'AGENTS.md')));
}
finish();
