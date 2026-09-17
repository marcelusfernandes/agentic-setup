#!/usr/bin/env node
// Cases for scripts/land.mts: it asks the server to merge a PR when it can,
// and nothing else (#63), under a review mode it declares on every output
// (#156). GitHub data comes from a fake `gh` put first on PATH (a bash script
// that dispatches on the subcommand, logs its argv, and prints canned JSON
// keyed by PR number).
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
// Negative control -- what fails on the base (before this PR), case by case:
//
//   * every case that asserts `pr checks <n> --required --json name,bucket`
//     in the argv log: the base asks `gh pr checks --required` with no
//     `--json` and reads only its exit code, and asks it *only* under the
//     `client-checks` gate -- so the pending-bucket cases (Z1, Z2), the
//     empty-list case (AA), the unreadable-checks case (AB) and the docs
//     case (C) all queue a merge there instead of refusing.
//   * every `--require-review` case (U, V, X, Y, Y2): the flag does not
//     exist on the base, which ignores the extra argv and prints
//     `mode: 'agent'` (selected by the absence of AGENTIC_REVIEWER_TOKEN),
//     never `mode: 'approved'`.
//   * case W: the base selects mode `approved` from AGENTIC_REVIEWER_TOKEN
//     alone and refuses a label-only PR; this suite requires the token to
//     change nothing at all.
//   * case AC: the base never reads `mergeable`, so a CONFLICTING pull
//     request is queued rather than refused.
//   * case AD: the base leaves `--auto` armed whenever the merge did not
//     happen at once (#191, #241), so `pr merge 30 --disable-auto` never
//     appears in its argv log.
//   * case AE: the base falls back to `[]` when the rules endpoint cannot be
//     read and silently lands in mode `agent`.
//   * every `--wait` case (AG-AL) and every `--timeout` case (AM): neither
//     flag exists on the base, whose argv check refuses any flag that is not
//     `--require-review` — so each of those runs prints `{ error: usage }`
//     and exits 1 there, and the assertions on `{ merged }`, `{ queued,
//     timeout }` and the poll counts fail as assertions, not as a crash.
//
// Cases M and O remain the negative control for #78, and P-T for #144: the
// base named no commit on either merge call before those landed.
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
      required|deletion-only|required-review) echo '[{"id":1,"name":"main","target":"branch"}]' ;;
      *) echo '[]' ;;
    esac
    ;;
  "api repos/{owner}/{repo}/rules/branches/main")
    # The endpoint land.mts actually reads: flattened, enforcement-aware
    # rules that apply to this branch right now. 'required' carries a
    # pull_request rule with no parameters at all -- the shape this
    # repository's own base branch has, which requires no approving review
    # and so must leave land.mts in mode 'agent'. 'required-review' is the
    # same branch with required_approving_review_count raised to 1.
    case "\${FAKE_GH_RULES:-}" in
      required) echo '[{"type":"deletion"},{"type":"non_fast_forward"},{"type":"pull_request"},{"type":"required_status_checks","parameters":{}}]' ;;
      required-review) echo '[{"type":"deletion"},{"type":"pull_request","parameters":{"required_approving_review_count":1}},{"type":"required_status_checks","parameters":{}}]' ;;
      deletion-only) echo '[{"type":"deletion"},{"type":"non_fast_forward"}]' ;;
      unreadable) echo "fake-gh: rules endpoint is unavailable" >&2; exit 1 ;;
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
      # MERGED by default: with every required check in bucket pass and the
      # head pinned, GitHub merges at once. The two exceptions are the ones
      # that exercise a still-open PR after the merge call.
      # 40-43 are the --wait fixtures: the answer depends on how many state
      # reads this run has already made, counted off the argv log (whose line
      # for *this* call is appended before the dispatch above, so the
      # post-merge read is already number 1). -x so the wider
      # 'state,labels,...' read is not counted as a state read.
      reads() { grep -cx "pr view $1 --json state" "$state/gh-argv.log"; }
      case "$pr" in
        12|30) echo '{"state":"OPEN"}' ;;
        40) if [ "\$(reads 40)" -ge 4 ]; then echo '{"state":"MERGED"}'; else echo '{"state":"OPEN"}'; fi ;;
        41) echo '{"state":"OPEN"}' ;;
        42) if [ "\$(reads 42)" -ge 2 ]; then echo '{"state":"CLOSED"}'; else echo '{"state":"OPEN"}'; fi ;;
        43) if [ "\$(reads 43)" -ge 2 ]; then echo "fake-gh: could not read the state" >&2; exit 1; else echo '{"state":"OPEN"}'; fi ;;
        *) echo '{"state":"MERGED"}' ;;
      esac
    elif [ "$fields" = "comments" ]; then
      # The review binding: the orchestrator records the head it reviewed as
      # <!-- agentic-reviewed-sha: <oid> --> when it applies review:approved.
      case "$pr" in
        15) echo '{"comments":[{"body":"<!-- agentic-reviewed-sha: '"$stale"' -->"},{"body":"round two, looks good"},{"body":"<!-- agentic-reviewed-sha: '"$head"' -->"}]}' ;;
        24|28) echo '{"comments":[{"body":"<!-- agentic-reviewed-sha: '"$stale"' -->"}]}' ;;
        25) echo '{"comments":[{"body":"approved in a comment with no marker in it"}]}' ;;
        26) echo "fake-gh: could not read the comments" >&2; exit 1 ;;
        *) echo '{"comments":[{"body":"<!-- agentic-reviewed-sha: '"$head"' -->"}]}' ;;
      esac
    else
      merge_state='"mergeable":"MERGEABLE"'
      if [ "$pr" = "32" ]; then merge_state='"mergeable":"CONFLICTING"'; fi
      if [ "$pr" = "35" ]; then merge_state='"mergeable":"UNKNOWN"'; fi
      label='[{"name":"review:approved"}]'
      decision='null'
      case "$pr" in
        11|20) label='[]' ;;
        12|33|4[0-3]) label='[{"name":"type:docs"}]' ;;
      esac
      case "$pr" in
        20|27|28) decision='"APPROVED"' ;;
      esac
      state='"state":"OPEN"'
      if [ "$pr" = "10" ]; then state='"state":"CLOSED"'; fi
      case "$pr" in
        1[0-9]|2[0-9]|3[0-5]|4[0-3]) echo '{'"$state"',"labels":'"$label"',"reviewDecision":'"$decision"',"baseRefName":"main","headRefOid":"'"$head"'",'"$merge_state"'}' ;;
        *) echo "fake-gh: unknown pr $pr" >&2; exit 1 ;;
      esac
    fi
    ;;
  "pr checks")
    pr="$3"
    json="no"
    for a in "$@"; do
      if [ "$a" = "--json" ]; then json="yes"; fi
    done
    # The bucket every required check of this fixture reports.
    case "$pr" in
      13|17) bucket="fail" ;;
      29|33) bucket="pending" ;;
      31) bucket="none" ;;
      34) bucket="unreadable" ;;
      *) bucket="pass" ;;
    esac
    if [ "$json" = "no" ]; then
      # A caller that does not ask for buckets sees only the exit code --
      # which is what the base script reads, and why a pending check passed
      # for it (gh exits 8 there, but nothing distinguishes it from red).
      if [ "$bucket" = "pass" ]; then echo "All checks were successful"; exit 0; fi
      echo "fake-gh: some required checks were not successful" >&2
      exit 1
    fi
    # Real gh prints the JSON *and* exits non-zero when anything is not
    # green (1 red, 8 pending), so the bucket read must not gate on status.
    case "$bucket" in
      pass) echo '[{"name":"test","bucket":"pass"},{"name":"scope","bucket":"pass"}]' ;;
      fail) echo '[{"name":"test","bucket":"fail"},{"name":"scope","bucket":"pass"}]'; exit 1 ;;
      pending) echo '[{"name":"test","bucket":"pending"},{"name":"scope","bucket":"pass"}]'; exit 8 ;;
      none) echo '[]'; exit 1 ;;
      unreadable) echo "fake-gh: could not read the checks" >&2; exit 1 ;;
    esac
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
// (running this very suite) may have it set for real, and no case below may
// see it unless it opts in via `env` (case W, which requires it to change
// nothing).
const { AGENTIC_REVIEWER_TOKEN: _ambientReviewerToken, ...BASE_ENV } = process.env;
function land(pr: number, env: Record<string, string> = {}, flags: string[] = []) {
  const stateDir = mkdtempSync(join(tmpdir(), 'agentic-land-state-'));
  cleanup(() => rmSync(stateDir, { recursive: true, force: true }));
  writeFileSync(join(stateDir, 'gh-argv.log'), '');
  const r = spawnSync(RUNTIME, [join(ROOT, 'scripts', 'land.mts'), String(pr), ...flags], {
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
const CHECKS = (pr: number): string => `pr checks ${pr} --required --json name,bucket`;

// --- A: PR is not OPEN -> refused, never merges -----------------------------
const a = land(10);
check('not-open refuses (exit 1)', a.status === 1, `${a.stdout}\n${a.stderr}`);
const aOut = parse(a.stdout);
check('not-open reports refused with pr and missing', typeof aOut?.refused === 'string' && aOut?.pr === 10 && (aOut?.missing ?? []).some((m: string) => m === 'state=CLOSED'), a.stdout);
check('not-open never read checks or merged', !/pr checks/.test(a.log) && !/pr merge/.test(a.log), a.log);

// --- B: OPEN, not approved, not docs -> refused -----------------------------
const b = land(11);
check('not-approved refuses (exit 1)', b.status === 1, `${b.stdout}\n${b.stderr}`);
const bOut = parse(b.stdout);
check('not-approved is named in missing[]', (bOut?.missing ?? []).includes('review:not-approved'), JSON.stringify(bOut));
check('not-approved never invoked gh pr merge', !/pr merge/.test(b.log), b.log);

// --- C: type:docs with no approval, required_status_checks in the branch's
// effective rules -> merged, and the checks are read there too: the docs
// label exempts a PR from review, never from its required checks ------------
const c = land(12, { FAKE_GH_RULES: 'required' });
check('docs without approval merges (exit 0)', c.status === 0, `${c.stdout}\n${c.stderr}`);
const cOut = parse(c.stdout);
check('docs reports { queued, gate: ruleset } while the PR is still open', cOut?.queued === 12 && cOut?.gate === 'ruleset', c.stdout);
check('docs read the required checks by bucket under the ruleset gate', c.log.includes(CHECKS(12)), c.log);

// --- D: no rules at all, required checks red -> refused ---------------------
const d = land(13, { FAKE_GH_RULES: '' });
check('no-rules + red checks refuses (exit 1)', d.status === 1, `${d.stdout}\n${d.stderr}`);
const dOut = parse(d.stdout);
check('no-rules + red checks names checks:required in missing[]', (dOut?.missing ?? []).includes('checks:required'), JSON.stringify(dOut));
check('no-rules + red checks never invoked gh pr merge', !/pr merge/.test(d.log), d.log);

// --- E: no rules at all, required checks green -> merged via the
// client-checks gate ---------------------------------------------------------
const e = land(14, { FAKE_GH_RULES: '' });
check('no-rules + green checks merges (exit 0)', e.status === 0, `${e.stdout}\n${e.stderr}`);
const eOut = parse(e.stdout);
check('no-rules + green checks reports { merged, gate: client-checks }', eOut?.merged === 14 && eOut?.gate === 'client-checks', e.stdout);
check('no-rules + green checks read the buckets', e.log.includes(CHECKS(14)), e.log);

// --- F: required_status_checks present -> gate 'ruleset', and the buckets are
// still read client-side before any merge call (#156 AC4): "the ruleset holds
// the line" is verified, not assumed ----------------------------------------
const f = land(15, { FAKE_GH_RULES: 'required' });
check('required_status_checks present merges (exit 0)', f.status === 0, `${f.stdout}\n${f.stderr}`);
const fOut = parse(f.stdout);
check('required_status_checks present reports { merged, gate: ruleset }', fOut?.merged === 15 && fOut?.gate === 'ruleset', f.stdout);
check('required_status_checks present invoked gh pr merge --squash --auto, never --delete-branch or --admin', /pr merge 15 --squash --auto/.test(f.log) && !/--delete-branch/.test(f.log) && !/--admin/.test(f.log), f.log);
check('required_status_checks present read the buckets before merging', f.log.includes(CHECKS(15)) && f.log.indexOf(CHECKS(15)) < f.log.indexOf('pr merge 15'), f.log);
const fLines = f.log.trim().split('\n').filter(Boolean);
const fMutatingLines = fLines.filter((l) => l.startsWith('pr merge'));
check('required_status_checks present: gh pr merge --auto is the last mutating call (only a status read follows)', fMutatingLines[fMutatingLines.length - 1] === `pr merge 15 --squash --auto --match-head-commit ${headOid(15)}`, f.log);
check('required_status_checks present: the merge is followed by a fresh gh pr view --json state read', fLines[fLines.length - 1] === 'pr view 15 --json state', f.log);

// --- G: preconditions and gate pass, but auto-merge is disabled on the repo -
const g = land(16, { FAKE_GH_RULES: 'required' });
check('auto-merge disabled exits 1', g.status === 1, `${g.stdout}\n${g.stderr}`);
const gOut = parse(g.stdout);
check('auto-merge disabled reports { error } with gh\'s own message', typeof gOut?.error === 'string' && /auto merge/i.test(gOut.error), g.stdout);

// --- H: a branch ruleset exists but only forbids deletion/force-push (no
// required_status_checks) -> the client-checks gate still refuses on red ----
const h = land(17, { FAKE_GH_RULES: 'deletion-only' });
check('deletion-only ruleset still falls back to client-checks and refuses on red (exit 1)', h.status === 1, `${h.stdout}\n${h.stderr}`);
const hOut = parse(h.stdout);
check('deletion-only ruleset names checks:required and gate: client-checks', (hOut?.missing ?? []).includes('checks:required') && hOut?.gate === 'client-checks', JSON.stringify(hOut));
check('deletion-only ruleset actually read the required checks', h.log.includes(CHECKS(17)), h.log);
check('deletion-only ruleset never invoked gh pr merge', !/pr merge/.test(h.log), h.log);

// --- I: same deletion-only ruleset, but required checks are green ---------
const i = land(18, { FAKE_GH_RULES: 'deletion-only' });
check('deletion-only ruleset + green checks merges via client-checks (exit 0)', i.status === 0, `${i.stdout}\n${i.stderr}`);
const iOut = parse(i.stdout);
check('deletion-only ruleset + green checks reports { merged, gate: client-checks }', iOut?.merged === 18 && iOut?.gate === 'client-checks', i.stdout);

// --- M: `--auto` loses the clean-status race (#78) -> land.mts retries
// once with a plain `gh pr merge --squash` (no --auto), which succeeds ------
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
// time land.mts reads it back -> { merged }, one merge call ---------------
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

// --- S: the applied review mode is named on the merge and on every refusal,
// so agent / approved / docs are told apart --------------------------------
check('mode: agent on the label-plus-marker path (merged)', fOut?.mode === 'agent', f.stdout);
check('mode: docs on the type:docs exemption', cOut?.mode === 'docs', c.stdout);
check('mode: agent on a head:changed refusal', pOut?.mode === 'agent', p.stdout);
check('mode: agent on a review:not-approved refusal', bOut?.mode === 'agent', b.stdout);
check('mode: agent on a checks:required refusal', dOut?.mode === 'agent', d.stdout);
check('mode: agent on a state refusal', aOut?.mode === 'agent', a.stdout);
check('mode: docs is exempt from the marker read as well (no comments call)', !/--json comments/.test(c.log), c.log);

// --- T: the newest marker wins: PR 15 carries an older, stale marker before
// the one naming its current head, and still merges ------------------------
check('newest marker wins over an older, stale one', fOut?.merged === 15, f.stdout);
check('the marker read happens, and before any merge call', f.log.includes('pr view 15 --json comments') && f.log.indexOf('pr view 15 --json comments') < f.log.indexOf('pr merge 15'), f.log);

// --- U: `--require-review` selects mode 'approved' -> the label and the
// marker are no longer enough; the refusal says what the mode costs --------
const u = land(15, { FAKE_GH_RULES: 'required' }, ['--require-review']);
check('--require-review with no server review refuses (exit 1)', u.status === 1, `${u.stdout}\n${u.stderr}`);
const uOut = parse(u.stdout);
check('--require-review reports mode: approved and missing: [review:not-approved]', uOut?.mode === 'approved' && JSON.stringify(uOut?.missing) === JSON.stringify(['review:not-approved']), u.stdout);
check('--require-review never downgrades to agent and never merges', !/pr merge/.test(u.log), u.log);
check('--require-review names the cost of the mode (a second identity)', /second|identity|login/i.test(String(uOut?.refused)), u.stdout);

// --- V: no flag, but the base branch's effective rules already require an
// approving review -> mode 'approved' all the same -------------------------
const v = land(15, { FAKE_GH_RULES: 'required-review' });
check('a base branch that requires reviews selects approved (exit 1 without one)', v.status === 1, `${v.stdout}\n${v.stderr}`);
const vOut = parse(v.stdout);
check('base-branch rules report mode: approved and missing: [review:not-approved]', vOut?.mode === 'approved' && JSON.stringify(vOut?.missing) === JSON.stringify(['review:not-approved']), v.stdout);
check('a pull_request rule with no required_approving_review_count stays mode: agent', fOut?.mode === 'agent', f.stdout);

// --- W: AGENTIC_REVIEWER_TOKEN selects nothing at all: the mode is never
// chosen by whether a variable happens to be set (#156 AC1) ----------------
const w = land(19, { FAKE_GH_RULES: 'required', AGENTIC_REVIEWER_TOKEN: 'fake-reviewer-token' });
check('AGENTIC_REVIEWER_TOKEN set: label plus marker still merges (exit 0)', w.status === 0, `${w.stdout}\n${w.stderr}`);
const wOut = parse(w.stdout);
check('AGENTIC_REVIEWER_TOKEN set: mode is still agent', wOut?.mode === 'agent' && wOut?.merged === 19, w.stdout);

// --- X: mode 'approved' satisfied: the label, the marker matching the head
// *and* a server-verified review ------------------------------------------
const x = land(27, { FAKE_GH_RULES: 'required' }, ['--require-review']);
check('approved mode with label, marker and APPROVED merges (exit 0)', x.status === 0, `${x.stdout}\n${x.stderr}`);
const xOut = parse(x.stdout);
check('approved mode reports { merged, mode: approved }', xOut?.merged === 27 && xOut?.mode === 'approved', x.stdout);
check('approved mode reads the marker too (everything agent requires)', /pr view 27 --json comments/.test(x.log), x.log);

// --- Y: a server-verified review with no review:approved label -> approved
// mode requires everything agent requires, so this refuses -----------------
const y = land(20, { FAKE_GH_RULES: 'required' }, ['--require-review']);
check('approved mode without the label refuses (exit 1)', y.status === 1, `${y.stdout}\n${y.stderr}`);
const yOut = parse(y.stdout);
check('approved mode without the label reports mode: approved, missing: [review:not-approved]', yOut?.mode === 'approved' && JSON.stringify(yOut?.missing) === JSON.stringify(['review:not-approved']), y.stdout);

// --- Y2: a server-verified review whose marker names an older commit ------
const y2 = land(28, { FAKE_GH_RULES: 'required' }, ['--require-review']);
check('approved mode with a stale marker refuses (exit 1)', y2.status === 1, `${y2.stdout}\n${y2.stderr}`);
const y2Out = parse(y2.stdout);
check('approved mode with a stale marker reports mode: approved, missing: [head:changed]', y2Out?.mode === 'approved' && JSON.stringify(y2Out?.missing) === JSON.stringify(['head:changed']), y2.stdout);

// --- Z1/Z2: a pending required check is not green: it refuses under the
// ruleset gate as well as the client-checks one (#156 AC4; #191 queued an
// --auto that merged later, unreviewed commits) ---------------------------
const z1 = land(29, { FAKE_GH_RULES: 'required' });
check('pending check refuses under the ruleset gate (exit 1)', z1.status === 1, `${z1.stdout}\n${z1.stderr}`);
const z1Out = parse(z1.stdout);
check('pending check under ruleset names checks:required and gate: ruleset', JSON.stringify(z1Out?.missing) === JSON.stringify(['checks:required']) && z1Out?.gate === 'ruleset', z1.stdout);
check('pending check under ruleset never invoked gh pr merge', !/pr merge/.test(z1.log), z1.log);

const z2 = land(29, { FAKE_GH_RULES: '' });
check('pending check refuses under the client-checks gate (exit 1)', z2.status === 1, `${z2.stdout}\n${z2.stderr}`);
const z2Out = parse(z2.stdout);
check('pending check under client-checks names checks:required and gate: client-checks', JSON.stringify(z2Out?.missing) === JSON.stringify(['checks:required']) && z2Out?.gate === 'client-checks', z2.stdout);

// --- AA: an empty required-check list is not "nothing is red", it is
// "nothing held the line" --------------------------------------------------
const aa = land(31, { FAKE_GH_RULES: 'required' });
check('empty required-check list refuses (exit 1)', aa.status === 1, `${aa.stdout}\n${aa.stderr}`);
const aaOut = parse(aa.stdout);
check('empty required-check list names checks:required', JSON.stringify(aaOut?.missing) === JSON.stringify(['checks:required']), aa.stdout);
check('empty required-check list never invoked gh pr merge', !/pr merge/.test(aa.log), aa.log);

// --- AB: the bucket read itself cannot answer -> fail closed --------------
const ab = land(34, { FAKE_GH_RULES: 'required' });
check('unreadable checks refuses (exit 1)', ab.status === 1, `${ab.stdout}\n${ab.stderr}`);
const abOut = parse(ab.stdout);
check('unreadable checks names checks:required', JSON.stringify(abOut?.missing) === JSON.stringify(['checks:required']), ab.stdout);
check('unreadable checks never invoked gh pr merge', !/pr merge/.test(ab.log), ab.log);

// --- AC: a CONFLICTING pull request is refused instead of having --auto
// armed on it (#241: a docs-mode land armed auto-merge on a PR that could
// not merge, so the conflict resolution commit would have merged itself) --
const ac = land(32, { FAKE_GH_RULES: 'required' });
check('conflicting PR refuses (exit 1)', ac.status === 1, `${ac.stdout}\n${ac.stderr}`);
const acOut = parse(ac.stdout);
check('conflicting PR names merge:not-mergeable and never merges', JSON.stringify(acOut?.missing) === JSON.stringify(['merge:not-mergeable']) && !/pr merge/.test(ac.log), `${ac.stdout}\n${ac.log}`);

const ac2 = land(35, { FAKE_GH_RULES: 'required' });
check('UNKNOWN mergeability refuses too (fail closed)', ac2.status === 1 && JSON.stringify(parse(ac2.stdout)?.missing) === JSON.stringify(['merge:not-mergeable']), ac2.stdout);

// --- AD: in agent mode land never leaves an auto-merge armed: if the PR is
// not MERGED when the state is read back, the queue is disabled again and
// the run refuses (#191/#241 — a queued --auto merged commits nobody
// reviewed) ---------------------------------------------------------------
const ad = land(30, { FAKE_GH_RULES: 'required' });
check('agent mode: a merge that did not happen refuses (exit 1)', ad.status === 1, `${ad.stdout}\n${ad.stderr}`);
const adOut = parse(ad.stdout);
check('agent mode: names merge:not-clean and mode agent', JSON.stringify(adOut?.missing) === JSON.stringify(['merge:not-clean']) && adOut?.mode === 'agent', ad.stdout);
check('agent mode: disarmed the auto-merge it had just enabled', /pr merge 30 --disable-auto/.test(ad.log), ad.log);
check('docs mode leaves its queued auto-merge alone (nothing was reviewed to outrun)', !/--disable-auto/.test(c.log), c.log);

// --- AE: the effective rules cannot be read -> no mode can be selected and
// nothing merges (the mode is never the one left when a read fails) -------
const ae = land(15, { FAKE_GH_RULES: 'unreadable' });
check('unreadable rules refuses (exit 1)', ae.status === 1, `${ae.stdout}\n${ae.stderr}`);
const aeOut = parse(ae.stdout);
check('unreadable rules names gh-rules, mode null, and never merges', JSON.stringify(aeOut?.missing) === JSON.stringify(['gh-rules']) && aeOut?.mode === null && !/pr merge/.test(ae.log), `${ae.stdout}\n${ae.log}`);

// --- AF: usage --------------------------------------------------------------
const af = land(15, { FAKE_GH_RULES: 'required' }, ['--merge-now']);
check('an unknown flag is a usage error, not a mode', af.status === 1 && typeof parse(af.stdout)?.error === 'string' && !/pr merge/.test(af.log), `${af.stdout}\n${af.log}`);

// --- AG-AL: --wait returns only once the pull request is merged (#260) ------
// The wait is bounded by --timeout and polls every POLL_INTERVAL_SECONDS or a
// quarter of the budget, whichever is shorter — so `--timeout 1` below polls
// four times a second and every case here costs about a second. The default
// (900s, polled every 10s) is not exercised: asserting it would take a quarter
// of an hour per case.
const stateReads = (log: string, pr: number): number =>
  log.trim().split('\n').filter((l) => l === `pr view ${pr} --json state`).length;

// AG: a queued pull request that GitHub merges while land is watching.
const ag = land(40, { FAKE_GH_RULES: 'required' }, ['--wait', '--timeout', '1']);
check('--wait on a queue that becomes MERGED exits 0', ag.status === 0, `${ag.stdout}\n${ag.stderr}`);
const agOut = parse(ag.stdout);
check('--wait reports { merged, gate, mode } — the shape a merge that happened at once prints', agOut?.merged === 40 && agOut?.gate === 'ruleset' && agOut?.mode === 'docs' && agOut?.queued === undefined && agOut?.timeout === undefined, ag.stdout);
check('--wait polled the state until it read MERGED (the post-merge read, then three polls)', stateReads(ag.log, 40) === 4, ag.log);
check('--wait never disarmed the queue it was waiting on', !/--disable-auto/.test(ag.log), ag.log);

// AH: the bound. A queue that is still a queue is not an error.
const ah = land(41, { FAKE_GH_RULES: 'required' }, ['--wait', '--timeout', '1']);
check('--wait that never reads MERGED still exits 0', ah.status === 0, `${ah.stdout}\n${ah.stderr}`);
const ahOut = parse(ah.stdout);
check('the timeout reports { queued, gate, mode, timeout }', ahOut?.queued === 41 && ahOut?.gate === 'ruleset' && ahOut?.mode === 'docs' && ahOut?.timeout === 1, ah.stdout);
check('the wait is bounded: it polled more than once and stopped on its own', stateReads(ah.log, 41) >= 2 && stateReads(ah.log, 41) <= 6, ah.log);
check('the timeout leaves the auto-merge armed — the queue is still the server\'s to fire', !/--disable-auto/.test(ah.log), ah.log);

// AI: CLOSED without merging — the merge will not happen, so nothing is gained
// by polling to the timeout.
const ai = land(42, { FAKE_GH_RULES: 'required' }, ['--wait', '--timeout', '1']);
check('a PR closed without merging stops the wait (exit 1)', ai.status === 1, `${ai.stdout}\n${ai.stderr}`);
const aiOut = parse(ai.stdout);
check('closed-without-merging reports { error } naming the state, with pr and mode', typeof aiOut?.error === 'string' && /CLOSED/.test(String(aiOut?.error)) && aiOut?.pr === 42 && aiOut?.mode === 'docs', ai.stdout);
check('closed-without-merging stopped at the poll that read it, not at the timeout', stateReads(ai.log, 42) === 2, ai.log);

// AJ: a state the poll cannot read — fail closed (invariant 3), do not keep polling.
const aj = land(43, { FAKE_GH_RULES: 'required' }, ['--wait', '--timeout', '1']);
check('an unreadable state stops the wait (exit 1)', aj.status === 1, `${aj.stdout}\n${aj.stderr}`);
const ajOut = parse(aj.stdout);
check('an unreadable state reports { error } with pr and mode', typeof ajOut?.error === 'string' && ajOut?.pr === 43 && ajOut?.mode === 'docs', aj.stdout);
check('an unreadable state stopped at that poll, not at the timeout', stateReads(aj.log, 43) === 2, aj.log);

// AK: mode agent has nothing to wait for — it merged, or it refused.
const ak = land(15, { FAKE_GH_RULES: 'required' }, ['--wait']);
check('--wait in mode agent merges as it does without the flag (exit 0)', ak.status === 0, `${ak.stdout}\n${ak.stderr}`);
check('--wait in mode agent prints byte-identical output to the same run without it', ak.stdout === f.stdout, `${ak.stdout} vs ${f.stdout}`);
check('--wait in mode agent polls nothing: the one post-merge state read and no more', stateReads(ak.log, 15) === 1, ak.log);

const al = land(30, { FAKE_GH_RULES: 'required' }, ['--wait']);
check('--wait never waits on a queue mode agent has just disarmed (exit 1)', al.status === 1, `${al.stdout}\n${al.stderr}`);
const alOut = parse(al.stdout);
check('--wait in mode agent still refuses merge:not-clean and still disarms', JSON.stringify(alOut?.missing) === JSON.stringify(['merge:not-clean']) && /pr merge 30 --disable-auto/.test(al.log) && stateReads(al.log, 30) === 1, `${al.stdout}\n${al.log}`);

// AM: --timeout bounds --wait and means nothing without it; the parser stays strict.
const am = land(15, { FAKE_GH_RULES: 'required' }, ['--timeout', '60']);
check('--timeout without --wait is a usage error', am.status === 1 && typeof parse(am.stdout)?.error === 'string' && !/pr merge/.test(am.log), `${am.stdout}\n${am.log}`);
const an = land(15, { FAKE_GH_RULES: 'required' }, ['--wait', '--timeout=60']);
check('--timeout=<seconds> is a usage error: the parser reads the form it documents', an.status === 1 && typeof parse(an.stdout)?.error === 'string' && !/pr merge/.test(an.log), `${an.stdout}\n${an.log}`);
const ao = land(15, { FAKE_GH_RULES: 'required' }, ['--wait', '--timeout', '0']);
check('--timeout 0 is a usage error: an unbounded wait is not one of the options', ao.status === 1 && typeof parse(ao.stdout)?.error === 'string' && !/pr merge/.test(ao.log), `${ao.stdout}\n${ao.log}`);
const ap = land(15, { FAKE_GH_RULES: 'required' }, ['--wait', '--timeout', 'soon']);
check('a non-numeric --timeout is a usage error', ap.status === 1 && typeof parse(ap.stdout)?.error === 'string' && !/pr merge/.test(ap.log), `${ap.stdout}\n${ap.log}`);
check('the usage line names --wait and --timeout', /--wait/.test(String(parse(am.stdout)?.error)) && /--timeout/.test(String(parse(am.stdout)?.error)), am.stdout);

finish();
