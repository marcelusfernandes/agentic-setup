#!/usr/bin/env node
// init — sets a repository up for the agent loop. Run from the repository
// root; idempotent; never overwrites a file you edited unless --force.
//
//   node scripts/init.mjs [--milestone "<title>"] [--no-gh] [--force]
//
// What it does is listed in skills/init/SKILL.md. Node built-ins only.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LABELS = [
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

/** @type {string[]} */
const report = [];
/** @param {string} line */
const say = (line) => report.push(line);

/** @param {string} cmd @param {string[]} args @param {string} [cwd] */
function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}`.trim(), err: `${r.stderr ?? ''}`.trim() };
}

const top = run('git', ['rev-parse', '--show-toplevel']);
if (!top.ok) {
  console.error('init: run this from inside a git repository.');
  process.exit(1);
}
const root = top.out;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/**
 * Copy one file. Existing files are left alone unless `overwrite` (plugin-
 * owned code) or --force; identical files are reported as `=`.
 * @param {string} src @param {string} dst @param {boolean} overwrite
 */
function copyOne(src, dst, overwrite) {
  const shown = relative(root, dst);
  if (existsSync(dst) && !overwrite && !force) {
    if (readFileSync(dst, 'utf8') === readFileSync(src, 'utf8')) say(`  = ${shown}`);
    else say(`  ! ${shown} exists and differs; left alone (--force to overwrite)`);
    return;
  }
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst);
  say(`  + ${shown}`);
}

/** @param {string} srcDir @param {string} dstDir @param {boolean} overwrite */
function copyTree(srcDir, dstDir, overwrite) {
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
/** @type {Record<string, any> | null} */
let settings = {};
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
  const added = wanted.permissions.deny.filter((/** @type {string} */ rule) => !current.has(rule));
  const merged = { ...settings, permissions: { ...(settings.permissions ?? {}), deny: [...current, ...added] } };
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
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
  mkdirSync(dirname(prePush), { recursive: true });
  writeFileSync(prePush, ours);
  chmodSync(prePush, 0o755);
  say(`  + ${relative(root, prePush)}`);
}

// 5. labels and milestone
if (useGh) {
  say('github');
  const auth = run('gh', ['auth', 'status']);
  if (!auth.ok) {
    say('  ! gh is not authenticated; skipped labels and milestone (run again, or --no-gh)');
  } else {
    let created = 0;
    for (const [name, color, description] of LABELS) {
      const r = run('gh', ['label', 'create', name, '--color', color, '--description', description, '--force'], root);
      if (r.ok) created++;
      else say(`  ! label ${name}: ${r.err.split('\n')[0]}`);
    }
    say(`  + ${created}/${LABELS.length} labels present`);
    if (milestone) {
      const list = run('gh', ['api', 'repos/{owner}/{repo}/milestones', '--jq', '.[].title'], root);
      if (list.ok && list.out.split('\n').includes(milestone)) say(`  = milestone "${milestone}" exists`);
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
