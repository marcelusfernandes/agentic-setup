#!/usr/bin/env node
// init — sets a repository up for the agent loop. Run from the repository
// root; idempotent; never overwrites a file you edited unless --force.
//
//   node scripts/init.mts [--milestone "<title>"] [--no-gh] [--force] [--dry-run]
//
// --dry-run prints the same report a real run would, changes nothing on disk
// or on GitHub. Every filesystem write is routed through the write() gate
// below, so its report line comes from the same code path in both modes. gh
// writes (label create, milestone POST) are instead skipped by an explicit
// `if (dryRun)` and their report line names the outcome a fully successful
// write would reach (e.g. "N/N labels present") — reading gh state (auth
// status, milestone listing) still happens so the report can say "="
// (exists) vs "+" (would be created).
//
// What it does is listed in skills/init/SKILL.md. Node built-ins only.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABELS: [string, string, string][] = [
  ['state:ready', '0e8a16', 'Ready to be picked up by an agent'],
  ['state:in-progress', 'fbca04', 'An agent holds the branch lock'],
  ['state:in-review', '1d76db', 'PR open, waiting for CI and the reviewer'],
  ['state:qa-failed', 'd93f0b', 'Sent back by CI or the reviewer'],
  ['state:blocked', 'b60205', 'Two failed rounds; needs a person'],
  ['state:done', 'cccccc', 'Merged'],
  ['type:feature', 'a2eeef', ''],
  ['type:bug', 'd73a4a', ''],
  ['type:refactor', 'c5def5', ''],
  ['type:infra', 'bfd4f2', ''],
  ['type:spec', 'd4c5f9', ''],
  ['type:docs', '0075ca', 'Docs only: no reviewer, no negative control'],
  ['type:deps', 'ededed', 'Dependency change: orchestrator only'],
  ['review:approved', '0e8a16', 'The reviewer approved'],
  ['human', 'e99695', 'Needs a person'],
];

const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--') && !a.includes('=')));
const milestoneIdx = process.argv.indexOf('--milestone');
const milestone = milestoneIdx !== -1 ? process.argv[milestoneIdx + 1] : null;
const force = flags.has('--force');
const useGh = !flags.has('--no-gh');
const dryRun = flags.has('--dry-run');

const report: string[] = [];
const say = (line: string): number => report.push(line);
if (dryRun) say('dry run — nothing written');

/**
 * The single gate every filesystem write goes through: performs the action,
 * or no-ops under --dry-run. Report lines are produced by the caller
 * regardless of mode, so the report is identical either way.
 */
function write(action: () => void): void {
  if (!dryRun) action();
}

function run(cmd: string, args: string[], cwd?: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}`.trim(), err: `${r.stderr ?? ''}`.trim() };
}

const top = run('git', ['rev-parse', '--show-toplevel']);
if (!top.ok) {
  console.error('init: run this from inside a git repository.');
  process.exit(1);
}
const root = top.out;

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  say(`! node ${process.versions.node}: the hooks and CI scripts run TypeScript directly and need 22.18 or newer`);
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Copy one file. Existing files are left alone unless `overwrite` (plugin-
 * owned code) or --force; identical files are reported as `=`.
 */
function copyOne(src: string, dst: string, overwrite: boolean): void {
  const shown = relative(root, dst);
  if (existsSync(dst) && !overwrite && !force) {
    if (readFileSync(dst, 'utf8') === readFileSync(src, 'utf8')) say(`  = ${shown}`);
    else say(`  ! ${shown} exists and differs; left alone (--force to overwrite)`);
    return;
  }
  write(() => {
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  });
  say(`  + ${shown}`);
}

function copyTree(srcDir: string, dstDir: string, overwrite: boolean): void {
  for (const src of walk(srcDir)) copyOne(src, join(dstDir, relative(srcDir, src)), overwrite);
}

// 1. templates
say('templates');
copyTree(join(PLUGIN, 'templates', '.github'), join(root, '.github'), false);
copyOne(join(PLUGIN, 'templates', '.worktreeinclude'), join(root, '.worktreeinclude'), false);

// 2. CI scripts (plugin-owned: always current)
say('ci scripts');
copyTree(join(PLUGIN, 'ci'), join(root, '.github', 'scripts', 'agentic'), true);

// 3. permission deny list
say('.claude/settings.json');
const settingsPath = join(root, '.claude', 'settings.json');
const wanted = JSON.parse(readFileSync(join(PLUGIN, 'templates', 'claude-settings.json'), 'utf8'));
let settings: Record<string, any> | null = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    say('  ! .claude/settings.json is not valid JSON; not touched');
    settings = null;
  }
}
if (settings) {
  const current = new Set(settings.permissions?.deny ?? []);
  const added = wanted.permissions.deny.filter((rule: string) => !current.has(rule));
  const merged = { ...settings, permissions: { ...(settings.permissions ?? {}), deny: [...current, ...added] } };
  write(() => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  });
  say(added.length ? `  + ${added.length} deny rule(s) added` : '  = deny list already complete');
}

// 4. git pre-push
say('git pre-push');
const hooksDir = run('git', ['rev-parse', '--git-path', 'hooks']).out;
const prePush = resolve(root, hooksDir, 'pre-push');
const ours = readFileSync(join(PLUGIN, 'hooks', 'git-pre-push'), 'utf8');
if (existsSync(prePush) && readFileSync(prePush, 'utf8') !== ours && !/agentic-setup/.test(readFileSync(prePush, 'utf8')) && !force) {
  say(`  ! ${relative(root, prePush)} exists and is not ours; left alone (--force to replace)`);
} else {
  write(() => {
    mkdirSync(dirname(prePush), { recursive: true });
    writeFileSync(prePush, ours);
    chmodSync(prePush, 0o755);
  });
  say(`  + ${relative(root, prePush)}`);
}

// 5. labels and milestone
if (useGh) {
  say('github');
  const auth = run('gh', ['auth', 'status']);
  if (!auth.ok) {
    say('  ! gh is not authenticated; skipped labels and milestone (run again, or --no-gh)');
  } else {
    if (dryRun) {
      say(`  + ${LABELS.length}/${LABELS.length} labels present`);
    } else {
      let created = 0;
      for (const [name, color, description] of LABELS) {
        const r = run('gh', ['label', 'create', name, '--color', color, '--description', description, '--force'], root);
        if (r.ok) created++;
        else say(`  ! label ${name}: ${r.err.split('\n')[0]}`);
      }
      say(`  + ${created}/${LABELS.length} labels present`);
    }
    if (milestone) {
      // reading is allowed even in dry-run: it decides whether the report
      // says "=" (exists) or "+" (would be created), without writing.
      const list = run('gh', ['api', 'repos/{owner}/{repo}/milestones', '--jq', '.[].title'], root);
      const exists = list.ok && list.out.split('\n').includes(milestone);
      if (exists) say(`  = milestone "${milestone}" exists`);
      else if (dryRun) say(`  + milestone "${milestone}"`);
      else {
        const r = run('gh', ['api', '-X', 'POST', 'repos/{owner}/{repo}/milestones', '-f', `title=${milestone}`], root);
        say(r.ok ? `  + milestone "${milestone}"` : `  ! milestone: ${r.err.split('\n')[0]}`);
      }
    }
  }
}

console.log(report.join('\n'));
console.log(`
next, by hand:
  - review \`git status\` and open the bootstrap PR
  - make scope, negative-control and your test workflow required checks on main
  - add a ruleset if your plan allows one (PR required, no force-push, no deletion)
  - add scope: labels for your repository; set AGENTIC_TEST_CMD in agentic-checks.yml if needed
  - name the invariants in CLAUDE.md — the reviewer checks what it names`);
