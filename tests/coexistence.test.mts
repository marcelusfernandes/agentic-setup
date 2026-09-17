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

finish();
