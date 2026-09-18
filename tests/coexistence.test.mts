#!/usr/bin/env node
// Codex and legacy Claude setup are independent, opt-in installation routes.
// Exercise both real installers in throwaway git repositories; the installer
// cases make no GitHub calls.
//
// The two routes also coexist at run time, on the same issues: each locks an
// issue by pushing a branch, in namespaces that cannot see each other
// (`<type>/<n>-<slug>` for the Claude route's scripts/claim.mts,
// `codex/task-<n>` for the Codex route's autonomous-loop). The last section
// below runs the real scripts/claim.mts against a disposable remote that
// already carries the other route's lock, with a fake `gh` first on PATH
// (GitHub is never called) and — for the fail-closed case — a fake `git`
// whose `ls-remote` fails while every other subcommand delegates to the real
// binary (#157).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

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

// --- the two routes' locks recognise each other (#157) ----------------------
// A pushed branch is the lock on both sides, so an issue the Codex route
// already locked with `codex/task-<n>` must not be claimable by the Claude
// route. scripts/claim.mts reads the remote's heads before it pushes and
// reports the branch it found as { held }, exit 2 — the vocabulary it
// already uses for a branch another agent holds.
const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "repo view")
    echo '{"defaultBranchRef":{"name":"main"}}'
    ;;
  "issue view")
    cat <<'JSON'
{"number":0,"title":"feat: locked elsewhere","body":"## Files\\n- \`x\`\\n\\n## Dependencies\\nBlocked by: none\\n","labels":[{"name":"state:ready"}],"state":"OPEN"}
JSON
    ;;
  "issue edit")
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

// Every subcommand but `ls-remote` is the real git: the pre-push read is the
// only call this fake breaks, so the refusal it produces cannot be confused
// with a repository that was never set up.
const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
const FAKE_GIT = `#!/usr/bin/env bash
if [ "$1" = "ls-remote" ]; then
  echo "fatal: could not read from remote repository (simulated)" >&2
  exit 128
fi
exec ${realGit} "$@"
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-coexistence-gh-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);

const fakeGitDir = mkdtempSync(join(tmpdir(), 'agentic-coexistence-git-'));
cleanup(() => rmSync(fakeGitDir, { recursive: true, force: true }));
writeFileSync(join(fakeGitDir, 'git'), FAKE_GIT);
chmodSync(join(fakeGitDir, 'git'), 0o755);

const lockRepo = tempRepo();
commit(lockRepo, { 'README.md': '# locks\n' }, 'init');
const lockRemote = mkdtempSync(join(tmpdir(), 'agentic-coexistence-remote-'));
cleanup(() => rmSync(lockRemote, { recursive: true, force: true }));
git(['init', '-q', '--bare', lockRemote], lockRepo);
git(['remote', 'add', 'origin', lockRemote], lockRepo);
git(['push', '-q', 'origin', 'main'], lockRepo);

let lockLogCounter = 0;
function claim(args: string[], extraPath = '') {
  const log = join(fakeGhDir, `log-${lockLogCounter++}.txt`);
  const path = `${extraPath ? `${extraPath}:` : ''}${fakeGhDir}:${process.env.PATH ?? ''}`;
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'claim.mts'), ...args], {
    cwd: lockRepo,
    encoding: 'utf8',
    env: { ...process.env, PATH: path, GH_LOG: log },
  });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  let logText = '';
  try {
    logText = readFileSync(log, 'utf8');
  } catch {
    logText = '';
  }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json, log: logText };
}

function remoteBranches(): string[] {
  return git(['ls-remote', '--heads', 'origin'], lockRepo)
    .split('\n')
    .map((l) => l.trim().split('\t')[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/^refs\/heads\//, ''));
}

// The Codex route takes the lock first: `codex/task-7` on the shared remote.
git(['push', '-q', 'origin', 'main:refs/heads/codex/task-7'], lockRepo);

const codexHeld = claim(['7', '--slug', 'x', '--no-lint']);
check(
  'an issue locked by the Codex route is held, exit 2',
  codexHeld.status === 2 && codexHeld.json?.held === 'codex/task-7',
  `${JSON.stringify(codexHeld.json)} (exit ${codexHeld.status})`,
);
check(
  'a held claim never pushes the Claude route\'s own lock branch',
  !remoteBranches().includes('feat/7-x'),
  JSON.stringify(remoteBranches()),
);
check('a held claim does not assign or relabel the issue', !codexHeld.log.includes('issue edit'), codexHeld.log);

// The pre-push read fails closed: a `git ls-remote` that cannot answer
// refuses the claim rather than assuming the issue is free.
const readFails = claim(['8', '--slug', 'y', '--no-lint'], fakeGitDir);
check(
  'a failed remote read refuses the claim, exit 1',
  readFails.status === 1 && typeof readFails.json?.error === 'string' && /ls-remote/.test(readFails.json.error),
  `${JSON.stringify(readFails.json)} (exit ${readFails.status})`,
);
check(
  'a failed remote read never creates a branch',
  !remoteBranches().includes('feat/8-y'),
  JSON.stringify(remoteBranches()),
);
check('a failed remote read does not assign or relabel the issue', !readFails.log.includes('issue edit'), readFails.log);

// --- and the mirror: the Codex route reads the Claude route's lock (#158) ---
// The same rule from the other side. `.agents/skills/autonomous-loop/scripts/
// github.mts claim` pushes `codex/task-<n>`, a namespace the Claude route's
// `<type>/<n>-<slug>` can never collide with, so only a read of the remote's
// heads can find it. The refusal keeps this route's vocabulary: `{ held }`
// with the branch found, exit 2, nothing written.
const codexHelper = join(ROOT, '.agents', 'skills', 'autonomous-loop', 'scripts', 'github.mts');
const codexFixtures = mkdtempSync(join(tmpdir(), 'agentic-coexistence-codex-'));
cleanup(() => rmSync(codexFixtures, { recursive: true, force: true }));

// Issue bodies come from files the cases rewrite, so the fake `gh` needs no
// escaping and each case runs against exactly the plan it declares.
const CODEX_GH = `#!/usr/bin/env bash
echo "$*" >> "$GH_LOG"
if [ "$1" = "api" ]; then
  case "$2" in
    */comments) echo '[[]]'; exit 0 ;;
  esac
  file="$CODEX_FIXTURES/issue-\${2##*/}.json"
  if [ -f "$file" ]; then cat "$file"; exit 0; fi
  echo "fake-gh: no fixture for $2" >&2
  exit 1
fi
case "$1 $2" in
  "repo view")
    echo '{"defaultBranchRef":{"name":"main"}}'
    ;;
  "pr list")
    echo '[]'
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

// Only the bare listing fails: every `ls-remote` that names a refspec is the
// real git, so the refusal below can only come from the new lock read.
const FAKE_GIT_LISTING = `#!/usr/bin/env bash
if [ "$1" = "ls-remote" ] && [ "$#" -eq 3 ]; then
  echo "fatal: could not read from remote repository (simulated)" >&2
  exit 128
fi
exec ${realGit} "$@"
`;

const codexGhDir = mkdtempSync(join(tmpdir(), 'agentic-coexistence-codex-gh-'));
cleanup(() => rmSync(codexGhDir, { recursive: true, force: true }));
writeFileSync(join(codexGhDir, 'gh'), CODEX_GH);
chmodSync(join(codexGhDir, 'gh'), 0o755);

const listingGitDir = mkdtempSync(join(tmpdir(), 'agentic-coexistence-listing-'));
cleanup(() => rmSync(listingGitDir, { recursive: true, force: true }));
writeFileSync(join(listingGitDir, 'git'), FAKE_GIT_LISTING);
chmodSync(join(listingGitDir, 'git'), 0o755);

const OBJECTIVE = 9;
function objectiveBody(plan: string): string {
  return ['## Goal', 'Exercise the cross-route lock.', '', '## Success criteria',
    '- A task the other route locked is refused.', '', '## Boundaries', 'Test fixture only.', '',
    '## Permissions', 'publish: yes', 'merge: yes', '', '## Decision makers', '@owner', '',
    '## Plan', plan, '', '## Checkpoints', ''].join('\n');
}
const TASK_BODY = ['## Goal', 'One change.', '', '## Acceptance criteria', '- [ ] it works', '',
  '## Validation', 'npm test', '', '## Dependencies', 'none', ''].join('\n');

function fixture(number: number, body: string): void {
  writeFileSync(join(codexFixtures, `issue-${number}.json`),
    JSON.stringify({ number, title: `Item ${number}`, body, state: 'open', labels: [] }));
}

function codexClaim(task: number, extraPath = '') {
  const log = join(codexGhDir, `log-${lockLogCounter++}.txt`);
  const path = `${extraPath ? `${extraPath}:` : ''}${codexGhDir}:${process.env.PATH ?? ''}`;
  const r = spawnSync(RUNTIME, [codexHelper, 'claim', String(OBJECTIVE), String(task)], {
    cwd: lockRepo,
    encoding: 'utf8',
    env: { ...process.env, PATH: path, GH_LOG: log, CODEX_FIXTURES: codexFixtures },
  });
  let json: any = null;
  try {
    json = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '');
  } catch {
    json = null;
  }
  let logText = '';
  try {
    logText = readFileSync(log, 'utf8');
  } catch {
    logText = '';
  }
  return { status: r.status, out: `${r.stdout}${r.stderr}`, json, log: logText };
}

// The Claude route takes the lock first: `feat/10-x` on the shared remote.
fixture(OBJECTIVE, objectiveBody('- #10'));
fixture(10, TASK_BODY);
git(['push', '-q', 'origin', 'main:refs/heads/feat/10-x'], lockRepo);

const claudeHeld = codexClaim(10);
check(
  'an issue locked by the Claude route is held by the Codex claim, exit 2',
  claudeHeld.status === 2 && claudeHeld.json?.held === 10 && claudeHeld.json?.branch === 'feat/10-x',
  `${JSON.stringify(claudeHeld.json)} (exit ${claudeHeld.status}) ${claudeHeld.out}`,
);
check(
  'a held Codex claim never pushes its own lock branch',
  !remoteBranches().includes('codex/task-10'),
  JSON.stringify(remoteBranches()),
);
check('a held Codex claim writes no label or assignee',
  !/issue edit|pr edit|label create/.test(claudeHeld.log), claudeHeld.log);

// The same read fails closed on this side too.
fixture(OBJECTIVE, objectiveBody('- #12'));
fixture(12, TASK_BODY);
const codexReadFails = codexClaim(12, listingGitDir);
check(
  'a failed remote read refuses the Codex claim, exit 1',
  codexReadFails.status === 1 && typeof codexReadFails.json?.error === 'string'
    && /ls-remote/.test(codexReadFails.json.error),
  `${JSON.stringify(codexReadFails.json)} (exit ${codexReadFails.status}) ${codexReadFails.out}`,
);
check(
  'a failed remote read never creates the Codex lock branch',
  !remoteBranches().includes('codex/task-12'),
  JSON.stringify(remoteBranches()),
);
check('a failed remote read writes no label or assignee',
  !/issue edit|pr edit|label create/.test(codexReadFails.log), codexReadFails.log);

// The refusal is the other route's branch, not every read: an unlocked issue
// still claims.
fixture(OBJECTIVE, objectiveBody('- #11'));
fixture(11, TASK_BODY);
const codexFree = codexClaim(11);
check(
  'an unlocked issue is still claimed by the Codex route',
  codexFree.status === 0 && codexFree.json?.claimed === 11 && remoteBranches().includes('codex/task-11'),
  `${JSON.stringify(codexFree.json)} (exit ${codexFree.status}) ${codexFree.out}`,
);

finish();
