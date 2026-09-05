#!/usr/bin/env node
// scope — the PR's diff must sit inside the `## Files` globs of the issue
// it closes, plus whatever an `authorised:` line in the PR body grants.
//
// In CI it reads the pull_request event (body, base, head), diffs with git
// and fetches the issue body with `gh` (GH_TOKEN from the workflow). For a
// dry run, every input can come from flags instead:
//   --files-file <path>  --issue-body-file <path>  --pr-body-file <path>
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseArgs } from './lib/args.mts';
import { checkScope, parseAuthorisedGlobs, parseIssueGlobs } from './lib/scope.mts';
import { appendSummary } from './lib/summary.mts';

const args = parseArgs(process.argv.slice(2));
const root = typeof args.root === 'string' ? args.root : process.cwd();

function fail(message: string): never {
  console.error(`scope: ${message}`);
  appendSummary(`## scope\n\n**FAILED** — ${message}`);
  process.exit(1);
}

function readEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function gh(ghArgs: string[]): string {
  const r = spawnSync('gh', ghArgs, { encoding: 'utf8' });
  if (r.status !== 0) fail(`gh ${ghArgs.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

function changedFiles(base: string, head: string): string[] {
  const r = spawnSync('git', ['diff', '--no-renames', '--name-only', `${base}...${head}`], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) fail(`git diff failed: ${r.stderr.trim()}`);
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
}

const lines = (p: string): string[] => readFileSync(p, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);

const event = readEvent();

const files = typeof args['files-file'] === 'string'
  ? lines(args['files-file'])
  : changedFiles(
      String(args.base ?? event?.pull_request?.base?.sha ?? ''),
      String(args.head ?? event?.pull_request?.head?.sha ?? ''),
    );

const prBody = typeof args['pr-body-file'] === 'string'
  ? readFileSync(args['pr-body-file'], 'utf8')
  : String(event?.pull_request?.body ?? '');

let issueBody: string;
if (typeof args['issue-body-file'] === 'string') {
  issueBody = readFileSync(args['issue-body-file'], 'utf8');
} else {
  const issue = args.issue ?? prBody.match(/\bcloses\s+#(\d+)/i)?.[1];
  if (!issue) fail('no "Closes #N" in the PR body (and no --issue-body-file).');
  issueBody = gh(['issue', 'view', String(issue), '--json', 'body', '-q', '.body']);
}

const issueGlobs = parseIssueGlobs(issueBody);
if (issueGlobs.length === 0) fail('the linked issue declares no globs under `## Files`.');
const result = checkScope({ files, issueGlobs, authorisedGlobs: parseAuthorisedGlobs(prBody) });

console.log(JSON.stringify(result, null, 2));
appendSummary(
  [
    '## scope',
    '',
    result.ok ? `${files.length} file(s), all inside the issue's globs.` : '**FAILED** — outside the issue globs:',
    ...(result.ok ? [] : result.violations.map((f) => `- \`${f}\``)),
    '',
    `Globs: ${result.globs.map((g) => `\`${g}\``).join(', ')}`,
  ].join('\n'),
);
if (!result.ok) process.exit(1);
