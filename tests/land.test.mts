#!/usr/bin/env node
// Cases for scripts/land.mts: it asks the server to merge a PR when it can,
// and nothing else (#63). GitHub data comes from a fake `gh` put first on
// PATH (a bash script that dispatches on the subcommand, logs its argv, and
// prints canned JSON keyed by PR number).
//
// Negative control: on the base (before this PR), scripts/land.mts still
// polls, relabels and removes worktrees -- it does not print { queued } and
// it calls `gh pr merge` without --auto, so every case below that checks
// for `queued` or `--auto` fails against the old script rather than passing
// vacuously.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, finish, RUNTIME, ROOT } from './lib/harness.mts';

// --- a fake `gh` on PATH ----------------------------------------------------
const FAKE_GH = `#!/usr/bin/env bash
state="$FAKE_GH_STATE_DIR"
printf '%s\\n' "$*" >> "$state/gh-argv.log"

case "\${1:-} \${2:-}" in
  "api repos/{owner}/{repo}/rulesets?targets=branch")
    if [ "\${FAKE_GH_RULESET:-}" = "1" ]; then
      echo '[{"id":1,"name":"main","target":"branch"}]'
    else
      echo '[]'
    fi
    ;;
  "pr view")
    pr="$3"
    case "$pr" in
      10) echo '{"state":"CLOSED","labels":[{"name":"review:approved"}],"reviewDecision":null}' ;;
      11) echo '{"state":"OPEN","labels":[],"reviewDecision":null}' ;;
      12) echo '{"state":"OPEN","labels":[{"name":"type:docs"}],"reviewDecision":null}' ;;
      13) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null}' ;;
      14) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null}' ;;
      15) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null}' ;;
      16) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null}' ;;
      *) echo "fake-gh: unknown pr $pr" >&2; exit 1 ;;
    esac
    ;;
  "pr checks")
    pr="$3"
    if [ "$pr" = "13" ]; then
      echo "fake-gh: some required checks were not successful" >&2
      exit 1
    fi
    echo "All checks were successful"
    ;;
  "pr merge")
    pr="$3"
    if [ "$pr" = "16" ]; then
      echo "fake-gh: Auto merge is not allowed for this repository" >&2
      exit 1
    fi
    echo "https://github.com/org/repo/pull/$pr"
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

// --- runner ------------------------------------------------------------------
function land(pr: number, env: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentic-land-state-'));
  cleanup(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, 'gh-argv.log'), '');
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'land.mts'), String(pr)], {
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

// --- A: PR is not OPEN -> refused, never reaches the ruleset check ----------
const a = land(10);
check('not-open refuses (exit 1)', a.status === 1, `${a.stdout}\n${a.stderr}`);
const aOut = parse(a.stdout);
check('not-open reports refused with pr and missing', typeof aOut?.refused === 'string' && aOut?.pr === 10 && (aOut?.missing ?? []).some((m: string) => m === 'state=CLOSED'), a.stdout);
check('not-open never checked rulesets or merged', !/api repos/.test(a.log) && !/pr merge/.test(a.log), a.log);

// --- B: OPEN, not approved, not docs -> refused -----------------------------
const b = land(11);
check('not-approved refuses (exit 1)', b.status === 1, `${b.stdout}\n${b.stderr}`);
const bOut = parse(b.stdout);
check('not-approved is named in missing[]', (bOut?.missing ?? []).includes('review:not-approved'), JSON.stringify(bOut));
check('not-approved never invoked gh pr merge', !/pr merge/.test(b.log), b.log);

// --- C: type:docs with no approval, a ruleset present -> queued -------------
const c = land(12, { FAKE_GH_RULESET: '1' });
check('docs without approval queues (exit 0)', c.status === 0, `${c.stdout}\n${c.stderr}`);
const cOut = parse(c.stdout);
check('docs queued reports { queued, gate: ruleset }', cOut?.queued === 12 && cOut?.gate === 'ruleset', c.stdout);

// --- D: no ruleset, required checks red -> refused --------------------------
const d = land(13, { FAKE_GH_RULESET: '0' });
check('no-ruleset + red checks refuses (exit 1)', d.status === 1, `${d.stdout}\n${d.stderr}`);
const dOut = parse(d.stdout);
check('no-ruleset + red checks names checks:required in missing[]', (dOut?.missing ?? []).includes('checks:required'), JSON.stringify(dOut));
check('no-ruleset + red checks never invoked gh pr merge', !/pr merge/.test(d.log), d.log);

// --- E: no ruleset, required checks green -> queued via the client-checks gate
const e = land(14, { FAKE_GH_RULESET: '0' });
check('no-ruleset + green checks queues (exit 0)', e.status === 0, `${e.stdout}\n${e.stderr}`);
const eOut = parse(e.stdout);
check('no-ruleset + green checks reports { queued, gate: client-checks }', eOut?.queued === 14 && eOut?.gate === 'client-checks', e.stdout);
check('no-ruleset + green checks invoked gh pr checks --required', /pr checks 14 --required/.test(e.log), e.log);

// --- F: a ruleset exists -> queued straight from the server, no client
// checks call at all; the merge is the last gh call made ---------------------
const f = land(15, { FAKE_GH_RULESET: '1' });
check('ruleset present queues (exit 0)', f.status === 0, `${f.stdout}\n${f.stderr}`);
const fOut = parse(f.stdout);
check('ruleset present reports { queued, gate: ruleset }', fOut?.queued === 15 && fOut?.gate === 'ruleset', f.stdout);
check('ruleset present invoked gh pr merge --squash --delete-branch --auto, never --admin', /pr merge 15 --squash --delete-branch --auto/.test(f.log) && !/--admin/.test(f.log), f.log);
check('ruleset present never called gh pr checks', !/pr checks/.test(f.log), f.log);
const fLines = f.log.trim().split('\n').filter(Boolean);
check('ruleset present did nothing after gh pr merge --auto', fLines[fLines.length - 1] === 'pr merge 15 --squash --delete-branch --auto', f.log);

// --- G: preconditions and gate pass, but auto-merge is disabled on the repo -
const g = land(16, { FAKE_GH_RULESET: '1' });
check('auto-merge disabled exits 1', g.status === 1, `${g.stdout}\n${g.stderr}`);
const gOut = parse(g.stdout);
check('auto-merge disabled reports { error } with gh\'s own message', typeof gOut?.error === 'string' && /auto merge/i.test(gOut.error), g.stdout);

finish();
