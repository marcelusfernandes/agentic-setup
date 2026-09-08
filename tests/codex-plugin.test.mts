#!/usr/bin/env node
// Native plugin packaging uses the real synchronizer in disposable repositories.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { check, commit, finish, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

const FILES = [
  'SKILL.md', 'references/contract.md', 'scripts/github.mts',
  'scripts/result.schema.json', 'scripts/run.mts',
];

function fixture(): string {
  const repo = tempRepo();
  commit(repo, { 'README.md': '# plugin fixture\n' }, 'init');
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'scripts/sync-codex-plugin.mts'), join(repo, 'scripts/sync-codex-plugin.mts'));
  cpSync(join(ROOT, '.agents'), join(repo, '.agents'), { recursive: true });
  cpSync(join(ROOT, 'LICENSE'), join(repo, 'LICENSE'));
  mkdirSync(join(repo, 'plugins/agentic-setup/.codex-plugin'), { recursive: true });
  cpSync(join(ROOT, 'plugins/agentic-setup/.codex-plugin/plugin.json'),
    join(repo, 'plugins/agentic-setup/.codex-plugin/plugin.json'));
  return repo;
}

function sync(repo: string, ...args: string[]) {
  return spawnSync(RUNTIME, [join(repo, 'scripts/sync-codex-plugin.mts'), ...args],
    { cwd: repo, encoding: 'utf8' });
}

let result = spawnSync(RUNTIME, [join(ROOT, 'scripts/sync-codex-plugin.mts'), '--check'],
  { cwd: ROOT, encoding: 'utf8' });
check('repository test checks the actual packaged snapshot', result.status === 0,
  `${result.stdout}${result.stderr}`);
const catalog = JSON.parse(readFileSync(join(ROOT, '.agents/plugins/marketplace.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(ROOT, 'plugins/agentic-setup/.codex-plugin/plugin.json'), 'utf8'));
const listed = catalog.plugins.find((entry: { name?: string }) => entry.name === 'agentic-setup');
check('actual catalog uses the local plugin source', listed?.source?.source === 'local' &&
  listed.source.path === './plugins/agentic-setup');
check('actual catalog keeps explicit installation and authentication policy',
  listed?.policy?.installation === 'AVAILABLE' && listed.policy.authentication === 'ON_INSTALL');
check('actual manifest exposes the namespaced isolated skill',
  manifest.name === 'agentic-setup' && manifest.skills === './skills/');
check('actual plugin root contains only manifest, license, and skills',
  JSON.stringify(readdirSync(join(ROOT, 'plugins/agentic-setup')).sort()) ===
    JSON.stringify(['.codex-plugin', 'LICENSE', 'skills']));

const repo = fixture();
result = sync(repo, '--check');
check('check detects a missing package snapshot', result.status === 1 && /missing/.test(result.stderr));
result = sync(repo);
check('sync creates the package snapshot', result.status === 0, `${result.stdout}${result.stderr}`);
for (const file of FILES) {
  check(`packaged ${file} matches canonical bytes`,
    readFileSync(join(repo, 'plugins/agentic-setup/skills/autonomous-loop', file))
      .equals(readFileSync(join(repo, '.agents/skills/autonomous-loop', file))));
}
check('packaged license matches canonical bytes',
  readFileSync(join(repo, 'plugins/agentic-setup/LICENSE')).equals(readFileSync(join(repo, 'LICENSE'))));
check('check accepts a current snapshot', sync(repo, '--check').status === 0);
check('sync is idempotent', sync(repo).status === 0 && sync(repo, '--check').status === 0);

const missingManifestRepo = fixture();
rmSync(join(missingManifestRepo, 'plugins/agentic-setup/.codex-plugin/plugin.json'));
result = sync(missingManifestRepo, '--check');
check('check refuses a missing static manifest', result.status === 1 && /static plugin file missing/.test(result.stderr));

const expandedCanonicalRepo = fixture();
writeFileSync(join(expandedCanonicalRepo, '.agents/skills/autonomous-loop/new-resource.md'), 'not allowlisted\n');
result = sync(expandedCanonicalRepo);
check('sync refuses an unlisted canonical resource',
  result.status === 1 && /unexpected canonical skill path/.test(result.stderr));
check('canonical refusal happens before package writes',
  !existsSync(join(expandedCanonicalRepo, 'plugins/agentic-setup/LICENSE')));

const packagedSkill = join(repo, 'plugins/agentic-setup/skills/autonomous-loop/SKILL.md');
writeFileSync(packagedSkill, 'drift\n');
check('check detects stale package bytes', sync(repo, '--check').status === 1);
check('sync repairs stale package bytes', sync(repo).status === 0 &&
  readFileSync(packagedSkill).equals(readFileSync(join(repo, '.agents/skills/autonomous-loop/SKILL.md'))));

const extra = join(repo, 'plugins/agentic-setup/user-note.txt');
writeFileSync(extra, 'preserve me\n');
writeFileSync(packagedSkill, 'do not partially repair\n');
result = sync(repo);
check('sync refuses unexpected files before writes', result.status === 1 && /unexpected/.test(result.stderr));
check('sync preserves unexpected files and makes no partial repair',
  readFileSync(extra, 'utf8') === 'preserve me\n' && readFileSync(packagedSkill, 'utf8') === 'do not partially repair\n');

const linkedRepo = fixture();
const outside = tempRepo();
commit(outside, { 'marker.txt': 'outside\n' }, 'outside');
mkdirSync(join(linkedRepo, 'plugins/agentic-setup'), { recursive: true });
symlinkSync(outside, join(linkedRepo, 'plugins/agentic-setup/skills'));
for (const args of [[], ['--check']]) {
  result = sync(linkedRepo, ...args);
  check(`sync ${args[0] ?? 'write'} refuses symlink destinations`,
    result.status === 1 && /symlink/.test(result.stderr));
  check('symlink refusal leaves outside untouched',
    readFileSync(join(outside, 'marker.txt'), 'utf8') === 'outside\n' && !existsSync(join(outside, 'autonomous-loop')));
}

const helper = join(repo, 'plugins/agentic-setup/skills/autonomous-loop/scripts/github.mts');
const runner = join(repo, 'plugins/agentic-setup/skills/autonomous-loop/scripts/run.mts');
rmSync(extra); sync(repo);
const bin = join(outside, 'bin');
mkdirSync(bin);
const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
writeFileSync(join(bin, 'git'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'ls-remote') process.stdout.write('0123456789012345678901234567890123456789\\trefs/heads/main\\n');
else { const r = spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' }); process.exit(r.status ?? 1); }
`);
writeFileSync(join(bin, 'gh'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const goal = { number: 1, title: 'Done objective', state: 'closed', state_reason: 'completed', body: [
  '## Goal','Prove relocation.','## Success criteria','Runner reconciles.','## Boundaries','Fixture only.',
  '## Permissions','publish: no','merge: no','## Decision makers','@human','## Plan','- #2','## Checkpoints','none'
].join('\\n') };
const task = { number: 2, title: 'Done task', state: 'closed', state_reason: 'completed', body: [
  '## Goal','Exercise packaged helper.','## Acceptance criteria','It runs.','## Validation','Real subprocess.',
  '## Dependencies','none'
].join('\\n') };
if (args[0] === 'repo') console.log(JSON.stringify({ defaultBranchRef: { name: 'main' } }));
else if (args[0] === 'api' && args[1].endsWith('/issues/1')) console.log(JSON.stringify(goal));
else if (args[0] === 'api' && args[1].endsWith('/issues/2')) console.log(JSON.stringify(task));
else if (args[0] === 'pr' && args[1] === 'list') console.log('[]');
else { console.error('unexpected gh invocation: ' + args.join(' ')); process.exit(1); }
`);
writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho codex-must-not-run >&2\nexit 99\n');
for (const file of ['git', 'gh', 'codex']) chmodSync(join(bin, file), 0o755);
const env = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
const helperRun = spawnSync(RUNTIME, [helper, 'status', '1'], { cwd: outside, encoding: 'utf8', env });
const runnerRun = spawnSync(RUNTIME, [runner, '1', '--max-turns', '1'], { cwd: outside, encoding: 'utf8', env });
check('packaged helper resolves and reconciles outside the source checkout',
  helperRun.status === 0 && JSON.parse(helperRun.stdout).status === 'complete', helperRun.stderr);
check('packaged runner reaches its sibling helper outside the source checkout',
  runnerRun.status === 0 && JSON.parse(runnerRun.stdout).status === 'complete' &&
    !/codex-must-not-run/.test(runnerRun.stderr), runnerRun.stderr);

finish();
