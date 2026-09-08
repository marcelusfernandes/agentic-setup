#!/usr/bin/env node
// Local installation only. Preview all writes first; preserve existing configuration.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const args = process.argv.slice(2); let target = process.cwd(); let dryRun = false; let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) target = resolve(args[++i]);
    else if (args[i] === '--dry-run') dryRun = true;
    else if (args[i] === '--force') force = true;
    else throw new Error('usage: setup-codex.mts [--target repo] [--dry-run] [--force]');
  }
  const top = spawnSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) throw new Error('target must be an existing git repository');
  target = top.stdout.trim();
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const skill = '.agents/skills/autonomous-loop';
  const walk = (dir: string): string[] => readdirSync(join(source, dir), { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
  const files = walk(skill).map((path) => ({ source: path, target: path }));
  const existingAgents = existsSync(join(target, 'AGENTS.md'));
  if (!existingAgents) files.push({ source: 'templates/codex/AGENTS.md', target: 'AGENTS.md' });
  // Refuse symlinks anywhere below the repository root before calculating
  // actions or writing. Otherwise `.agents -> /outside` could turn a local
  // install into an external/global write, including under --force.
  for (const file of files) {
    let destination = target;
    for (const segment of file.target.split('/')) {
      destination = join(destination, segment);
      try {
        if (lstatSync(destination).isSymbolicLink()) {
          throw new Error(`refusing symlink in destination path: ${file.target}`);
        }
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      }
    }
  }
  const actions = files.map((file) => {
    const destination = join(target, file.target);
    const exists = existsSync(destination);
    const same = exists && readFileSync(destination).equals(readFileSync(join(source, file.source)));
    return { ...file, action: same ? 'unchanged' : exists && !force ? 'conflict' : exists ? 'replace' : 'create' };
  });
  const conflicts = actions.some((a) => a.action === 'conflict');
  if (!dryRun && !conflicts) for (const entry of actions.filter((a) => ['replace', 'create'].includes(a.action))) {
    mkdirSync(dirname(join(target, entry.target)), { recursive: true });
    cpSync(join(source, entry.source), join(target, entry.target));
  }
  console.log(JSON.stringify({ target, dryRun, applied: !dryRun && !conflicts, files: actions.map(({ target: path, action }) => ({ path, action })),
    notes: [existingAgents ? 'Existing AGENTS.md preserved: reconcile old workflow instructions with the Codex contract.' : 'Fill in the actual project commands in AGENTS.md.',
      'No global config, sandbox, GitHub settings, hooks or CI changed.',
      'Configure required branch checks and review before authorizing automatic merge.'] }, null, 2));
  if (conflicts) process.exitCode = 1;
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
