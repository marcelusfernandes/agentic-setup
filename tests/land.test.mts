#!/usr/bin/env node
// Cases for scripts/land.mts: it merges a PR only when the server will
// accept it, and relabels/removes the worktree only once GitHub reports the
// PR as merged. GitHub data comes from a fake `gh` put first on PATH (a
// bash script that dispatches on the subcommand, logs its argv, and prints
// canned/stateful JSON); worktree data comes from a real temporary git
// repository with real linked worktrees.
//
// Negative control: on the base (before this PR), scripts/land.mts does not
// exist, so every case below fails (ENOENT) rather than passing vacuously.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, finish, git, ROOT, RUNTIME, tempRepo } from './lib/harness.mts';

// --- a fake `gh` on PATH ----------------------------------------------------
// State lives in $FAKE_GH_STATE_DIR (per-invocation), so counters and merge
// markers are visible across the several `gh` subprocesses one land.mts run
// spawns, without leaking between separate land.mts invocations.
const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"

case "\${1:-} \${2:-}" in
  "repo view")
    echo '{"defaultBranchRef":{"name":"main"}}'
    ;;
  "api repos/{owner}/{repo}/rulesets")
    if [ "\${FAKE_GH_NO_RULESET:-}" = "1" ]; then
      echo '[]'
    else
      cat <<'JSON'
[
  {
    "conditions": {"ref_name": {"include": ["~DEFAULT_BRANCH"]}},
    "rules": [
      {"type": "required_status_checks", "parameters": {"required_status_checks": [{"context": "test (node)"}, {"context": "test (bun)"}]}}
    ]
  }
]
JSON
    fi
    ;;
  "pr view")
    pr="$3"
    args="$*"
    case "$args" in
      *"state,mergeCommit"*)
        marker="$state/merged-$pr"
        if [ -f "$marker" ]; then
          echo '{"state":"MERGED","mergeCommit":{"oid":"sha-'"$pr"'"}}'
        else
          echo '{"state":"OPEN","mergeCommit":null}'
        fi
        ;;
      *)
        case "$pr" in
          10)
            echo '{"number":10,"state":"OPEN","headRefName":"feat/10-happy","body":"Closes #910","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test (node)","conclusion":"SUCCESS"},{"name":"test (bun)","conclusion":"SUCCESS"}]}'
            ;;
          20)
            count_file="$state/count-20"
            n=0
            [ -f "$count_file" ] && n=$(cat "$count_file")
            n=$((n+1))
            echo "$n" > "$count_file"
            if [ "$n" -lt 3 ]; then
              echo '{"number":20,"state":"OPEN","headRefName":"feat/20-poll","body":"Closes #920","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"test (node)","status":"IN_PROGRESS","conclusion":null},{"name":"test (bun)","conclusion":"SUCCESS"}]}'
            else
              echo '{"number":20,"state":"OPEN","headRefName":"feat/20-poll","body":"Closes #920","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test (node)","conclusion":"SUCCESS"},{"name":"test (bun)","conclusion":"SUCCESS"}]}'
            fi
            ;;
          21)
            echo '{"number":21,"state":"OPEN","headRefName":"feat/21-stuck","body":"Closes #921","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"test (node)","status":"IN_PROGRESS","conclusion":null},{"name":"test (bun)","conclusion":"SUCCESS"}]}'
            ;;
          30)
            echo '{"number":30,"state":"OPEN","headRefName":"feat/30-missing-check","body":"Closes #930","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test (node)","conclusion":"SUCCESS"}]}'
            ;;
          40)
            echo '{"number":40,"state":"OPEN","headRefName":"feat/40-docs","body":"Closes #940","labels":[{"name":"type:docs"}],"reviewDecision":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test (node)","conclusion":"SUCCESS"},{"name":"test (bun)","conclusion":"SUCCESS"}]}'
            ;;
          50)
            echo '{"number":50,"state":"OPEN","headRefName":"feat/50-mergefail","body":"Closes #950","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test (node)","conclusion":"SUCCESS"},{"name":"test (bun)","conclusion":"SUCCESS"}]}'
            ;;
          60)
            echo '{"number":60,"state":"OPEN","headRefName":"feat/60-nevermerged","body":"Closes #960","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"test (node)","conclusion":"SUCCESS"},{"name":"test (bun)","conclusion":"SUCCESS"}]}'
            ;;
          81)
            echo '{"number":81,"state":"OPEN","headRefName":"feat/81-fallback-red","body":"Closes #981","labels":[{"name":"review:approved"}],"reviewDecision":null,"mergeStateStatus":"CLEAN","statusCheckRollup":[{"name":"lint","conclusion":"FAILURE"}]}'
            ;;
          *)
            echo "fake-gh: unknown pr $pr" >&2
            exit 1
            ;;
        esac
        ;;
    esac
    ;;
  "pr merge")
    pr="$3"
    if [ "$pr" = "50" ]; then
      echo "fake-gh: merge blocked by branch protection, add the --admin flag" >&2
      exit 1
    fi
    if [ "$pr" != "60" ]; then
      touch "$state/merged-$pr"
    fi
    echo "https://github.com/org/repo/pull/$pr"
    ;;
  "issue view")
    echo '{"labels":[{"name":"state:in-review"},{"name":"review:approved"},{"name":"type:feature"}]}'
    ;;
  "issue edit")
    echo "ok"
    ;;
  *)
    echo "fake-gh: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-fakegh-land-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a real repo, one branch (+ optional worktree) per scenario -------------
const repo = tempRepo();
git(['commit', '-q', '--allow-empty', '-m', 'init'], repo);

const worktreeDirs: string[] = [];
function addWorktree(branch: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'agentic-land-wt-')), 'wt');
  cleanup(() => rmSync(dir, { recursive: true, force: true }));
  git(['worktree', 'add', '-q', '-b', branch, dir, 'main'], repo);
  worktreeDirs.push(dir);
  return dir;
}

const wt10 = addWorktree('feat/10-happy');
const wt20 = addWorktree('feat/20-poll');
const wt21 = addWorktree('feat/21-stuck');
const wt50 = addWorktree('feat/50-mergefail');
const wt60 = addWorktree('feat/60-nevermerged');
git(['checkout', '-q', 'main'], repo);

function worktreeExists(dir: string): boolean {
  const list = git(['worktree', 'list', '--porcelain'], repo);
  return list.includes(realpathSync(dir)) || list.includes(dir);
}

// --- runner ------------------------------------------------------------------
function land(pr: number, args: string[] = [], env: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentic-land-state-'));
  cleanup(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, 'gh-argv.log'), '');
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'land.mts'), String(pr), ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, ...env },
  });
  const log = existsSync(join(stateDir, 'gh-argv.log')) ? readFileSync(join(stateDir, 'gh-argv.log'), 'utf8') : '';
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, log };
}

function parse(stdout: string): any {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

// --- A: CLEAN + approved -> merges, relabels the linked issue, removes the worktree
const a = land(10);
check('happy path exits 0', a.status === 0, `${a.stdout}\n${a.stderr}`);
const aOut = parse(a.stdout);
check('happy path prints the merge sha, pr and linked issue', aOut?.merged === 'sha-10' && aOut?.pr === 10 && JSON.stringify(aOut?.issues) === '[910]', a.stdout);
check('happy path reports the removed worktree path', typeof aOut?.worktreeRemoved === 'string' && realpathSync(aOut.worktreeRemoved) === realpathSync(wt10), JSON.stringify(aOut));
check('happy path invoked gh pr merge --squash --delete-branch, never --admin/--auto', /pr merge 10 --squash --delete-branch/.test(a.log) && !/--admin/.test(a.log) && !/--auto/.test(a.log), a.log);
check('happy path relabelled the linked issue state:done and removed its other state: label', /issue edit 910 --add-label state:done --remove-label state:in-review/.test(a.log), a.log);
check('happy path removed the worktree', !worktreeExists(wt10));

// --- B: BLOCKED with a pending run, resolves under --wait ------------------
const b = land(20, ['--wait', '5'], { AGENTIC_LAND_POLL_MS: '5' });
check('AC2 poll resolves and exits 0', b.status === 0, `${b.stdout}\n${b.stderr}`);
const bOut = parse(b.stdout);
check('AC2 poll merges once checks turn green', bOut?.merged === 'sha-20' && bOut?.pr === 20, b.stdout);
check('AC2 poll removed its worktree', !worktreeExists(wt20));

// --- C: BLOCKED with a pending run that never resolves -> refused after --wait
const c = land(21, ['--wait', '0.2'], { AGENTIC_LAND_POLL_MS: '5' });
check('AC2 timeout refuses (exit 1)', c.status === 1, `${c.stdout}\n${c.stderr}`);
const cOut = parse(c.stdout);
check('AC2 timeout reports refused with pr and missing', typeof cOut?.refused === 'string' && cOut?.pr === 21 && Array.isArray(cOut?.missing) && cOut.missing.length > 0, c.stdout);
check('AC2 timeout never invoked gh pr merge', !/pr merge 21/.test(c.log), c.log);
check('AC2 timeout left the worktree in place', worktreeExists(wt21));

// --- D: approved, CLEAN, but a required check is missing from the rollup ---
const d = land(30);
check('missing required check refuses (exit 1)', d.status === 1, `${d.stdout}\n${d.stderr}`);
const dOut = parse(d.stdout);
check('missing required check is named in missing[]', (dOut?.missing ?? []).some((m: string) => m.includes('test (bun)')), JSON.stringify(dOut));
check('missing required check never invoked gh pr merge', !/pr merge 30/.test(d.log), d.log);

// --- E: type:docs PR merges without review:approved / an APPROVED review ---
const e = land(40);
check('docs PR merges without approval (exit 0)', e.status === 0, `${e.stdout}\n${e.stderr}`);
const eOut = parse(e.stdout);
check('docs PR reports the merge', eOut?.merged === 'sha-40' && eOut?.pr === 40, e.stdout);
check('docs PR with no worktree reports worktreeRemoved: null', eOut?.worktreeRemoved === null, JSON.stringify(eOut));

// --- F: preconditions pass but the merge command itself fails -------------
const f = land(50);
check('merge command failure exits 1', f.status === 1, `${f.stdout}\n${f.stderr}`);
const fOut = parse(f.stdout);
check('merge command failure reports { error }', typeof fOut?.error === 'string' && fOut.error.length > 0, f.stdout);
check('merge command failure invoked gh pr merge', /pr merge 50/.test(f.log), f.log);
check('merge command failure did not relabel any issue', !/issue edit/.test(f.log), f.log);
check('merge command failure left the worktree in place', worktreeExists(wt50));

// --- G: gh pr merge succeeds but the PR never reaches state MERGED --------
const g = land(60, [], { AGENTIC_LAND_POLL_MS: '5' });
check('never-merged times out with exit 1', g.status === 1, `${g.stdout}\n${g.stderr}`);
const gOut = parse(g.stdout);
check('never-merged reports { error }', typeof gOut?.error === 'string' && gOut.error.length > 0, g.stdout);
check('never-merged did invoke gh pr merge (the command itself succeeded)', /pr merge 60/.test(g.log), g.log);
check('never-merged did not relabel any issue despite the merge command succeeding', !/issue edit/.test(g.log), g.log);
check('never-merged left the worktree in place', worktreeExists(wt60));

// --- H: no ruleset -> fallback to "every check in the rollup is green" ----
const h = land(81, [], { FAKE_GH_NO_RULESET: '1' });
check('fallback (no ruleset) refuses on a red rollup check (exit 1)', h.status === 1, `${h.stdout}\n${h.stderr}`);
const hOut = parse(h.stdout);
check('fallback reports rulesetChecks: null', hOut?.rulesetChecks === null, JSON.stringify(hOut));
check('fallback names the red check in missing[]', (hOut?.missing ?? []).some((m: string) => m.includes('lint')), JSON.stringify(hOut));
check('fallback never invoked gh pr merge', !/pr merge 81/.test(h.log), h.log);

finish();
