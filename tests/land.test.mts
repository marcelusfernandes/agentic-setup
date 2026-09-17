#!/usr/bin/env node
// Cases for scripts/land.mts: it asks the server to merge a PR when it can,
// and nothing else (#63). GitHub data comes from a fake `gh` put first on
// PATH (a bash script that dispatches on the subcommand, logs its argv, and
// prints canned JSON keyed by PR number).
//
// The fake `gh` mocks two distinct real endpoints: the legacy ruleset list
// (`rulesets?targets=branch`, summaries only -- no `rules`, no
// `conditions`) and the per-branch effective rules
// (`rules/branches/<branch>`, flattened and enforcement-aware -- the one
// land.mts actually reads). Case H below is the regression case: a branch
// whose only ruleset forbids deletion (no required_status_checks) still
// shows up as a non-empty ruleset *list*, so a script that used the list as
// its gate signal would skip the client-checks fallback and let `--auto`
// merge with nothing gating it. This fixture keeps the legacy endpoint
// mocked (non-empty for exactly that branch) so the bug is reachable, not
// merely absent from the test.
//
// Negative control: on the base (before this PR), scripts/land.mts still
// polls, relabels and removes worktrees -- it does not print { queued } and
// it calls `gh pr merge` without --auto, so every case below that checks
// for `queued` or `--auto` fails against the old script rather than passing
// vacuously. Case J below is the negative control for #66 specifically: the
// base always accepts a `review:approved` label as approval, so it queues a
// label-only PR even with AGENTIC_REVIEWER_TOKEN set -- this test fails on
// that base and passes only once the label alone stops being sufficient.
// Cases M and O are the negative control for #78: the base never retries a
// clean-status failure and always prints { queued } after a successful
// --auto call, so both fail against the old script. Cases P-T are the
// negative control for #144: the base names no commit on either merge call
// and reads no marker comment anywhere, so the --match-head-commit
// assertions find an argv without the flag and the moved-head fixtures get a
// queued merge instead of a refusal.
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
    # Legacy list endpoint (kept only so the regression in case H is
    # reachable against a script that still reads it): non-empty whenever
    # any branch ruleset exists at all, required-checks or not.
    case "\${FAKE_GH_RULES:-}" in
      required|deletion-only) echo '[{"id":1,"name":"main","target":"branch"}]' ;;
      *) echo '[]' ;;
    esac
    ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    # The endpoint land.mts actually reads: flattened, enforcement-aware
    # rules that apply to this branch right now.
    case "\${FAKE_GH_RULES:-}" in
      required) echo '[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"pull_request"},{"type":"required_status_checks","parameters":{}}]' ;;
      deletion-only) echo '[{"type":"deletion"},{"type":"non_fast_forward"}]' ;;
      *) echo '[]' ;;
    esac
    ;;
  "pr view")
    pr="$3"
    fields="$5"
    # Each fixture PR's head oid is its own number repeated to 40 hex
    # characters, so a marker comment can name the head it reviewed without a
    # lookup table; \$stale is an oid no fixture head ever equals.
    oid() { printf "$1%.0s" {1..20}; }
    head=\$(oid "$pr")
    stale=1111111111111111111111111111111111111111
    if [ "$fields" = "state" ]; then
      # The post-merge status probe (land.mts reads only { state } here) --
      # decides merged vs. queued without caring which merge call got there.
      case "$pr" in
        21) echo '{"state":"MERGED"}' ;;
        23) echo '{"state":"MERGED"}' ;;
        *) echo '{"state":"OPEN"}' ;;
      esac
    elif [ "$fields" = "comments" ]; then
      # The review binding: the orchestrator records the head it reviewed as
      # <!-- agentic-reviewed-sha: <oid> --> when it applies review:approved.
      case "$pr" in
        15) echo '{"comments":[{"body":"<!-- agentic-reviewed-sha: '"$stale"' -->"},{"body":"round two, looks good"},{"body":"<!-- agentic-reviewed-sha: '"$head"' -->"}]}' ;;
        24) echo '{"comments":[{"body":"<!-- agentic-reviewed-sha: '"$stale"' -->"}]}' ;;
        25) echo '{"comments":[{"body":"approved in a comment with no marker in it"}]}' ;;
        26) echo "fake-gh: could not read the comments" >&2; exit 1 ;;
        *) echo '{"comments":[{"body":"<!-- agentic-reviewed-sha: '"$head"' -->"}]}' ;;
      esac
    else
      case "$pr" in
        10) echo '{"state":"CLOSED","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        11) echo '{"state":"OPEN","labels":[],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        12) echo '{"state":"OPEN","labels":[{"name":"type:docs"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        13) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        14) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        15) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        16) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        17) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        18) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        19) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        20) echo '{"state":"OPEN","labels":[],"reviewDecision":"APPROVED","baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        21) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        22) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        23) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        24) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        25) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        26) echo '{"state":"OPEN","labels":[{"name":"review:approved"}],"reviewDecision":null,"baseRefName":"main","headRefOid":"'"$head"'"}' ;;
        *) echo "fake-gh: unknown pr $pr" >&2; exit 1 ;;
      esac
    fi
    ;;
  "pr checks")
    pr="$3"
    if [ "$pr" = "13" ] || [ "$pr" = "17" ]; then
      echo "fake-gh: some required checks were not successful" >&2
      exit 1
    fi
    echo "All checks were successful"
    ;;
  "pr merge")
    pr="$3"
    auto="no"
    for a in "$@"; do
      if [ "$a" = "--auto" ]; then auto="yes"; fi
    done
    if [ "$pr" = "16" ]; then
      echo "fake-gh: Auto merge is not allowed for this repository" >&2
      exit 1
    fi
    if [ "$pr" = "21" ] && [ "$auto" = "yes" ]; then
      # The race in #78: gh chose enable-auto-merge off a stale
      # mergeStateStatus, but GitHub already considers the PR clean and
      # refuses the mutation. The plain merge (no --auto) that follows
      # succeeds via the default case below.
      echo "fake-gh: GraphQL: Pull request Pull request is in clean status (enablePullRequestAutoMerge)" >&2
      exit 1
    fi
    if [ "$pr" = "22" ] && [ "$auto" = "yes" ]; then
      echo "fake-gh: some unrelated merge failure" >&2
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
// AGENTIC_REVIEWER_TOKEN is stripped from the inherited environment by
// default: this repository dogfoods itself, so the orchestrator's own shell
// (running this very suite) may have it set for real, and every label-only
// case below (13-19) must see it unset unless a case opts in via `env`.
const { AGENTIC_REVIEWER_TOKEN: _ambientReviewerToken, ...BASE_ENV } = process.env;
function land(pr: number, env: Record<string, string> = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentic-land-state-'));
  cleanup(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, 'gh-argv.log'), '');
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'land.mts'), String(pr)], {
    encoding: 'utf8',
    env: { ...BASE_ENV, PATH: PATH_WITH_FAKE_GH, FAKE_GH_STATE_DIR: stateDir, ...env },
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

// The fake `gh` derives every fixture PR's head oid from its number, so a
// case can name the oid it expects on the merge call without a table.
const headOid = (pr: number): string => String(pr).repeat(20);

// --- A: PR is not OPEN -> refused, never reaches the ruleset check ----------
const a = land(10);
check('not-open refuses (exit 1)', a.status === 1, `${a.stdout}\n${a.stderr}`);
const aOut = parse(a.stdout);
check('not-open reports refused with pr and missing', typeof aOut?.refused === 'string' && aOut?.pr === 10 && (aOut?.missing ?? []).some((m: string) => m === 'state=CLOSED'), a.stdout);
check('not-open never checked rules or merged', !/api repos/.test(a.log) && !/pr merge/.test(a.log), a.log);

// --- B: OPEN, not approved, not docs -> refused -----------------------------
const b = land(11);
check('not-approved refuses (exit 1)', b.status === 1, `${b.stdout}\n${b.stderr}`);
const bOut = parse(b.stdout);
check('not-approved is named in missing[]', (bOut?.missing ?? []).includes('review:not-approved'), JSON.stringify(bOut));
check('not-approved never invoked gh pr merge', !/pr merge/.test(b.log), b.log);

// --- C: type:docs with no approval, required_status_checks in the branch's
// effective rules -> queued straight from the server ------------------------
const c = land(12, { FAKE_GH_RULES: 'required' });
check('docs without approval queues (exit 0)', c.status === 0, `${c.stdout}\n${c.stderr}`);
const cOut = parse(c.stdout);
check('docs queued reports { queued, gate: ruleset }', cOut?.queued === 12 && cOut?.gate === 'ruleset', c.stdout);

// --- D: no rules at all, required checks red -> refused ---------------------
const d = land(13, { FAKE_GH_RULES: '' });
check('no-rules + red checks refuses (exit 1)', d.status === 1, `${d.stdout}\n${d.stderr}`);
const dOut = parse(d.stdout);
check('no-rules + red checks names checks:required in missing[]', (dOut?.missing ?? []).includes('checks:required'), JSON.stringify(dOut));
check('no-rules + red checks never invoked gh pr merge', !/pr merge/.test(d.log), d.log);

// --- E: no rules at all, required checks green -> queued via the
// client-checks gate ---------------------------------------------------------
const e = land(14, { FAKE_GH_RULES: '' });
check('no-rules + green checks queues (exit 0)', e.status === 0, `${e.stdout}\n${e.stderr}`);
const eOut = parse(e.stdout);
check('no-rules + green checks reports { queued, gate: client-checks }', eOut?.queued === 14 && eOut?.gate === 'client-checks', e.stdout);
check('no-rules + green checks invoked gh pr checks --required', /pr checks 14 --required/.test(e.log), e.log);

// --- F: required_status_checks present -> queued straight from the server,
// no client checks call at all; the merge is the last *mutating* call, a
// state read follows it ------------------------------------------------
const f = land(15, { FAKE_GH_RULES: 'required' });
check('required_status_checks present queues (exit 0)', f.status === 0, `${f.stdout}\n${f.stderr}`);
const fOut = parse(f.stdout);
check('required_status_checks present reports { queued, gate: ruleset }', fOut?.queued === 15 && fOut?.gate === 'ruleset', f.stdout);
check('required_status_checks present invoked gh pr merge --squash --auto, never --delete-branch or --admin', /pr merge 15 --squash --auto/.test(f.log) && !/--delete-branch/.test(f.log) && !/--admin/.test(f.log), f.log);
check('required_status_checks present never called gh pr checks', !/pr checks/.test(f.log), f.log);
const fLines = f.log.trim().split('\n').filter(Boolean);
const fMutatingLines = fLines.filter((l) => l.startsWith('pr merge') || l.startsWith('pr checks'));
check('required_status_checks present: gh pr merge --auto is the last mutating call (only a status read follows)', fMutatingLines[fMutatingLines.length - 1] === `pr merge 15 --squash --auto --match-head-commit ${headOid(15)}`, f.log);
check('required_status_checks present: the merge is followed by a fresh gh pr view --json state read', fLines[fLines.length - 1] === 'pr view 15 --json state', f.log);

// --- G: preconditions and gate pass, but auto-merge is disabled on the repo -
const g = land(16, { FAKE_GH_RULES: 'required' });
check('auto-merge disabled exits 1', g.status === 1, `${g.stdout}\n${g.stderr}`);
const gOut = parse(g.stdout);
check('auto-merge disabled reports { error } with gh\'s own message', typeof gOut?.error === 'string' && /auto merge/i.test(gOut.error), g.stdout);

// --- H: a branch ruleset exists but only forbids deletion/force-push (no
// required_status_checks) -> the client-checks fallback still runs, and a
// red required check still refuses. A gate that trusted "any ruleset in the
// list endpoint exists" would skip the fallback here and let --auto merge
// ungated -- this is the regression case. --------------------------------
const h = land(17, { FAKE_GH_RULES: 'deletion-only' });
check('deletion-only ruleset still falls back to client-checks and refuses on red (exit 1)', h.status === 1, `${h.stdout}\n${h.stderr}`);
const hOut = parse(h.stdout);
check('deletion-only ruleset names checks:required and gate: client-checks', (hOut?.missing ?? []).includes('checks:required') && hOut?.gate === 'client-checks', JSON.stringify(hOut));
check('deletion-only ruleset actually called gh pr checks --required', /pr checks 17 --required/.test(h.log), h.log);
check('deletion-only ruleset never invoked gh pr merge', !/pr merge/.test(h.log), h.log);

// --- I: same deletion-only ruleset, but required checks are green -> the
// client-checks gate queues it normally --------------------------------
const i = land(18, { FAKE_GH_RULES: 'deletion-only' });
check('deletion-only ruleset + green checks queues via client-checks (exit 0)', i.status === 0, `${i.stdout}\n${i.stderr}`);
const iOut = parse(i.stdout);
check('deletion-only ruleset + green checks reports { queued, gate: client-checks }', iOut?.queued === 18 && iOut?.gate === 'client-checks', i.stdout);

// --- J: AGENTIC_REVIEWER_TOKEN is set in the orchestrator's environment ->
// the review:approved label alone no longer satisfies approval; a real
// review (reviewDecision) is required. This is #66's negative control: the
// base queues PR 19 regardless of the env var. ------------------------------
const j = land(19, { FAKE_GH_RULES: 'required', AGENTIC_REVIEWER_TOKEN: 'fake-reviewer-token' });
check('reviewer identity configured: label-only refuses (exit 1)', j.status === 1, `${j.stdout}\n${j.stderr}`);
const jOut = parse(j.stdout);
check('reviewer identity configured: label-only names review:not-approved in missing[]', (jOut?.missing ?? []).includes('review:not-approved'), JSON.stringify(jOut));
check('reviewer identity configured: label-only never invoked gh pr merge', !/pr merge/.test(j.log), j.log);

// --- K: AGENTIC_REVIEWER_TOKEN is set and the PR carries a real APPROVED
// review (no label needed) -> queued as usual --------------------------------
const k = land(20, { FAKE_GH_RULES: 'required', AGENTIC_REVIEWER_TOKEN: 'fake-reviewer-token' });
check('reviewer identity configured: reviewDecision APPROVED queues (exit 0)', k.status === 0, `${k.stdout}\n${k.stderr}`);
const kOut = parse(k.stdout);
check('reviewer identity configured: reviewDecision APPROVED reports { queued, gate: ruleset }', kOut?.queued === 20 && kOut?.gate === 'ruleset', k.stdout);

// --- L: without AGENTIC_REVIEWER_TOKEN, the label alone still queues as
// today (AC4: nothing changes for adopters that never set it) --------------
const l = land(15, { FAKE_GH_RULES: 'required' });
check('no reviewer identity: label-only still queues (exit 0)', l.status === 0, `${l.stdout}\n${l.stderr}`);
const lOut = parse(l.stdout);
check('no reviewer identity: label-only reports { queued, gate: ruleset }', lOut?.queued === 15 && lOut?.gate === 'ruleset', l.stdout);

// --- M: `--auto` loses the clean-status race (#78) -> land.mts retries
// once with a plain `gh pr merge --squash` (no --auto), which succeeds; the
// post-merge state read reports MERGED -> { merged }, not { queued } ------
const m = land(21, { FAKE_GH_RULES: 'required' });
check('clean-status race: retries once and merges (exit 0)', m.status === 0, `${m.stdout}\n${m.stderr}`);
const mOut = parse(m.stdout);
check('clean-status race: reports { merged, gate: ruleset }', mOut?.merged === 21 && mOut?.gate === 'ruleset', m.stdout);
const mLines = m.log.trim().split('\n').filter(Boolean);
const mMerges = mLines.filter((l) => l.startsWith('pr merge'));
check('clean-status race: exactly two merge calls, --auto then plain --squash, both pinned to the head oid', mMerges.length === 2 && mMerges[0] === `pr merge 21 --squash --auto --match-head-commit ${headOid(21)}` && mMerges[1] === `pr merge 21 --squash --match-head-commit ${headOid(21)}`, m.log);
check('clean-status race: reads state back with gh pr view --json state after merging', mLines[mLines.length - 1] === 'pr view 21 --json state', m.log);

// --- N: `--auto` fails with an unrelated message -> reported as today,
// with no retry attempted -----------------------------------------------
const n = land(22, { FAKE_GH_RULES: 'required' });
check('unrelated merge failure refuses (exit 1)', n.status === 1, `${n.stdout}\n${n.stderr}`);
const nOut = parse(n.stdout);
check('unrelated merge failure reports { error } with gh\'s own message', typeof nOut?.error === 'string' && /unrelated merge failure/.test(nOut.error), n.stdout);
const nLines = n.log.trim().split('\n').filter(Boolean);
const nMerges = nLines.filter((l) => l.startsWith('pr merge'));
check('unrelated merge failure: only the one --auto call, never a second merge call', nMerges.length === 1 && nMerges[0] === `pr merge 22 --squash --auto --match-head-commit ${headOid(22)}`, n.log);
check('unrelated merge failure never read PR state back', !nLines.includes('pr view 22 --json state'), n.log);

// --- O: `--auto` succeeds outright and the PR is already MERGED by the
// time land.mts reads it back -> { merged }, not { queued } ---------------
const o = land(23, { FAKE_GH_RULES: 'required' });
check('auto-merge succeeded and already merged (exit 0)', o.status === 0, `${o.stdout}\n${o.stderr}`);
const oOut = parse(o.stdout);
check('already-merged reports { merged, gate: ruleset }', oOut?.merged === 23 && oOut?.gate === 'ruleset', o.stdout);
const oMerges = o.log.trim().split('\n').filter((l) => l.startsWith('pr merge'));
check('already-merged: exactly one merge call (--auto), no retry needed', oMerges.length === 1 && oMerges[0] === `pr merge 23 --squash --auto --match-head-commit ${headOid(23)}`, o.log);

// --- P: the head moved after the review -> the newest
// <!-- agentic-reviewed-sha: <oid> --> marker names an older commit than
// headRefOid, so the merge is refused instead of landing a head nobody read
// (#191: approved at one commit, a merge commit landed by --auto after it) --
const p = land(24, { FAKE_GH_RULES: 'required' });
check('moved head refuses (exit 1)', p.status === 1, `${p.stdout}\n${p.stderr}`);
const pOut = parse(p.stdout);
check('moved head reports { refused, pr, missing: [head:changed] }', typeof pOut?.refused === 'string' && pOut?.pr === 24 && JSON.stringify(pOut?.missing) === JSON.stringify(['head:changed']), p.stdout);
check('moved head never invoked gh pr merge', !/pr merge/.test(p.log), p.log);
check('moved head read the PR comments', /pr view 24 --json comments/.test(p.log), p.log);

// --- Q: review:approved with no marker comment at all -> the same refusal:
// the label alone records no commit, so it merges nothing ------------------
const q = land(25, { FAKE_GH_RULES: 'required' });
check('label with no marker refuses (exit 1)', q.status === 1, `${q.stdout}\n${q.stderr}`);
const qOut = parse(q.stdout);
check('label with no marker reports missing: [head:changed]', JSON.stringify(qOut?.missing) === JSON.stringify(['head:changed']), q.stdout);
check('label with no marker never invoked gh pr merge', !/pr merge/.test(q.log), q.log);

// --- R: the comments read itself cannot answer -> fail closed (invariant 3),
// no merge attempted ---------------------------------------------------------
const r = land(26, { FAKE_GH_RULES: 'required' });
check('unreadable comments refuses (exit 1)', r.status === 1, `${r.stdout}\n${r.stderr}`);
const rOut = parse(r.stdout);
check('unreadable comments reports missing: [gh-pr-comments]', JSON.stringify(rOut?.missing) === JSON.stringify(['gh-pr-comments']), r.stdout);
check('unreadable comments never invoked gh pr merge', !/pr merge/.test(r.log), r.log);

// --- S: the applied review mode is named on the merge/queue output and on
// every refusal, so agent / approved / docs are told apart ------------------
check('mode: agent on the label-plus-marker path (queued)', fOut?.mode === 'agent', f.stdout);
check('mode: approved when a server-verified review satisfied approval', kOut?.mode === 'approved', k.stdout);
check('mode: docs on the type:docs exemption', cOut?.mode === 'docs', c.stdout);
check('mode: agent on a head:changed refusal', pOut?.mode === 'agent', p.stdout);
check('mode: agent on a review:not-approved refusal', bOut?.mode === 'agent', b.stdout);
check('mode: docs is exempt from the marker read as well (no comments call)', !/--json comments/.test(c.log), c.log);

// --- T: the newest marker wins: PR 15 carries an older, stale marker before
// the one naming its current head, and still queues ------------------------
check('newest marker wins over an older, stale one', fOut?.queued === 15, f.stdout);
check('the marker read happens, and before any merge call', f.log.includes('pr view 15 --json comments') && f.log.indexOf('pr view 15 --json comments') < f.log.indexOf('pr merge 15'), f.log);

finish();
