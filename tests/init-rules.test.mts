#!/usr/bin/env node
// Cases for `scripts/init.mts --rules`: the branch ruleset over the default
// branch, and every read on the way to it. Split out of tests/init.test.mts
// (#229), which had reached 808 lines — past the 800-line invariant — so the
// cases below could not be added to it. They run against the same fake `gh`
// as the rest of the installer's cases: `tests/lib/init-gh.mts`.
//
// The rule this file exists to hold: a read that fails on this path refuses,
// naming what could not be read, and makes no POST and no PUT. A read that
// cannot see the current state must never go on to change it — a run that
// does creates a second ruleset over a branch one already governs, which is
// the defect #143 removed and #229 closed the remaining entrances to.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, cleanup, commit, finish, tempRepo } from './lib/harness.mts';
import { ghLog, ghState, initNoGh, initWithGh, initWithGhEnv, rulesState } from './lib/init-gh.mts';

const ghRepo = tempRepo();
commit(ghRepo, { 'README.md': '# gh\n' }, 'init');

// The offline runner the two "--require-review ignored" cases below use, on a
// repository of their own: `--no-gh` consults no fake gh at all.
const repo = tempRepo();
commit(repo, { 'README.md': '# x\n' }, 'init');
const init = (...extra: string[]) => initNoGh(repo, ...extra);

// --- --rules: creates, or updates, the branch ruleset that governs the
// default branch — matched by what it governs, never by its name (#143) —
// with the checks the merge model depends on (docs/decisions.md item 9(a))
// and the review gate left off unless `--require-review` asks for it (#143).
// `ghRepo` carries no workflow files of its own, so the third required check
// falls back to its default, "test".

/** The body the fake gh recorded for a POST or a PUT, or null when none was sent. */
function ruleBody(stateDir: string, kind: 'post' | 'put'): any {
  const p = join(stateDir, `ruleset-${kind}-body.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}
/** One rule of a recorded payload by type, or null. */
const ruleOfType = (body: any, type: string): any => body?.rules?.find((r: { type: string }) => r.type === type) ?? null;
/** The `pull_request` rule's parameters of a recorded payload, or null. */
const prParameters = (body: any): any => ruleOfType(body, 'pull_request')?.parameters ?? null;
/**
 * The default `--rules` writes (#143 AC2): the review gate stays off — count
 * 0, and the two stale-approval fields exactly as the fetched ruleset carried
 * them (`false` when there was nothing to fetch) — with squash as the only
 * merge method.
 */
function leavesReviewGateOff(body: any, fetched = { dismiss: false, lastPush: false }): boolean {
  const p = prParameters(body);
  return (
    !!p &&
    p.required_approving_review_count === 0 &&
    p.dismiss_stale_reviews_on_push === fetched.dismiss &&
    p.require_last_push_approval === fetched.lastPush &&
    JSON.stringify(p.allowed_merge_methods) === JSON.stringify(['squash'])
  );
}
/** What `--require-review` adds on top (#143 AC3): the three fields raised together. */
function requiresOneApprovingReview(body: any): boolean {
  const p = prParameters(body);
  return (
    !!p &&
    p.required_approving_review_count === 1 &&
    p.dismiss_stale_reviews_on_push === true &&
    p.require_last_push_approval === true &&
    JSON.stringify(p.allowed_merge_methods) === JSON.stringify(['squash'])
  );
}

const stateRulesEmpty = mkdtempSync(join(tmpdir(), 'agentic-init-rules-empty-'));
cleanup(() => rmSync(stateRulesEmpty, { recursive: true, force: true }));
const rulesEmpty = initWithGh(ghRepo, stateRulesEmpty, '--rules');
check('init --rules (no existing ruleset) exits 0', rulesEmpty.status === 0, `${rulesEmpty.stdout}${rulesEmpty.stderr}`);
check('init --rules creates a ruleset when none governs the default branch', /\+ ruleset created/.test(rulesEmpty.stdout), rulesEmpty.stdout);
check('init --rules POSTs to the rulesets collection', ghLog(stateRulesEmpty).includes('rulesets -X POST'), ghLog(stateRulesEmpty));
const postBody = ruleBody(stateRulesEmpty, 'post');
check('the created ruleset targets the default branch', postBody.conditions.ref_name.include.includes('refs/heads/main'), JSON.stringify(postBody));
check(
  'the created ruleset requires scope, negative-control and the default test check',
  JSON.stringify(ruleOfType(postBody, 'required_status_checks').parameters.required_status_checks) ===
    JSON.stringify([{ context: 'scope' }, { context: 'negative-control' }, { context: 'test' }]),
  JSON.stringify(postBody),
);
check(
  'the created ruleset requires a pull request and blocks force-push and deletion',
  ['pull_request', 'non_fast_forward', 'deletion'].every((t) => postBody.rules.some((r: { type: string }) => r.type === t)),
  JSON.stringify(postBody),
);
check(
  'the created ruleset leaves the review gate off by default and allows squash only',
  leavesReviewGateOff(postBody),
  JSON.stringify(postBody),
);

// The shape this repository's own ruleset really has, read from the live
// API: named after the branch ("main", not "agentic-setup"), its condition
// the ~DEFAULT_BRANCH placeholder rather than refs/heads/main, and carrying
// rules, parameters and bypass actors the installer does not manage. A
// name-based lookup takes the create path here and POSTs a second ruleset
// over the same branch — that is the defect #143 fixes.
const LIVE_ID = 22358260;
const stateRulesLive = rulesState('live', [
  {
    id: LIVE_ID,
    name: 'main',
    target: 'branch',
    source_type: 'Repository',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_last_push_approval: false,
          require_extra_approval_for_unattributed_changes: true,
          allowed_merge_methods: ['squash'],
        },
      },
      { type: 'required_signatures' },
    ],
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    node_id: 'RRS_fixture',
    created_at: '2026-09-05T19:58:40.311-03:00',
    _links: { self: { href: 'https://api.github.invalid/x' } },
  },
]);
const rulesLive = initWithGh(ghRepo, stateRulesLive, '--rules');
check('init --rules against a ruleset named after the branch exits 0', rulesLive.status === 0, `${rulesLive.stdout}${rulesLive.stderr}`);
check(
  'init --rules updates the ruleset that governs the default branch whatever its name',
  ghLog(stateRulesLive).includes(`rulesets/${LIVE_ID} -X PUT`),
  ghLog(stateRulesLive),
);
check(
  'init --rules never POSTs a second ruleset over a branch one already governs',
  !ghLog(stateRulesLive).includes('-X POST') && ruleBody(stateRulesLive, 'post') === null,
  ghLog(stateRulesLive),
);
const liveBody = ruleBody(stateRulesLive, 'put');
check(
  'the update keeps the review gate off: count 0 and the fetched dismiss_stale_reviews_on_push: false left alone',
  leavesReviewGateOff(liveBody),
  JSON.stringify(liveBody),
);
check(
  'the update keeps a pull_request parameter the installer does not set',
  ruleOfType(liveBody, 'pull_request')?.parameters?.require_extra_approval_for_unattributed_changes === true,
  JSON.stringify(liveBody),
);
check('the update carries an unmanaged rule type through unchanged', ruleOfType(liveBody, 'required_signatures') !== null, JSON.stringify(liveBody));
check(
  'the update carries the fetched bypass actors through unchanged',
  JSON.stringify(liveBody?.bypass_actors) === JSON.stringify([{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }]),
  JSON.stringify(liveBody),
);
check(
  'the update keeps the ruleset own name and condition instead of renaming it',
  liveBody?.name === 'main' && JSON.stringify(liveBody?.conditions?.ref_name?.include) === JSON.stringify(['~DEFAULT_BRANCH']),
  JSON.stringify(liveBody),
);
check(
  'the update sends back none of the read-only fields the detail fetch carries',
  !!liveBody && !('node_id' in liveBody) && !('_links' in liveBody) && !('created_at' in liveBody) && !('source_type' in liveBody),
  JSON.stringify(liveBody),
);

// --- --require-review: the only way --rules raises the review gate (#143
// AC3). Both cases run against the live-shaped fixture, whose fetched
// pull_request rule carries the three fields at 0/false/false — so the flag
// is shown overriding fetched values, not just the installer's own default.
const REVIEW_OPT_IN_RULES = [
  { type: 'deletion' },
  {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 0,
      dismiss_stale_reviews_on_push: false,
      require_last_push_approval: false,
      require_extra_approval_for_unattributed_changes: true,
      allowed_merge_methods: ['squash'],
    },
  },
];
const FREEZE_WARNING = /! --require-review: AGENTIC_REVIEWER_TOKEN is unset/;

const stateRequireReview = rulesState('require-review', [
  { id: 51, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: REVIEW_OPT_IN_RULES, bypass_actors: [] },
]);
const requireReview = initWithGhEnv(ghRepo, stateRequireReview, {}, '--rules', '--require-review');
check('init --rules --require-review exits 0', requireReview.status === 0, `${requireReview.stdout}${requireReview.stderr}`);
const requireReviewBody = ruleBody(stateRequireReview, 'put');
check(
  'init --rules --require-review raises the count to 1, dismisses stale approvals and requires last-push approval',
  requiresOneApprovingReview(requireReviewBody),
  JSON.stringify(requireReviewBody),
);
check(
  'init --rules --require-review still carries the unmanaged pull_request parameters through',
  prParameters(requireReviewBody)?.require_extra_approval_for_unattributed_changes === true,
  JSON.stringify(requireReviewBody),
);
check(
  'init --rules --require-review with AGENTIC_REVIEWER_TOKEN unset warns that a single identity freezes every merge',
  FREEZE_WARNING.test(requireReview.stdout) && /freez/.test(requireReview.stdout),
  requireReview.stdout,
);

const stateRequireReviewToken = rulesState('require-review-token', [
  { id: 52, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: REVIEW_OPT_IN_RULES, bypass_actors: [] },
]);
const requireReviewToken = initWithGhEnv(ghRepo, stateRequireReviewToken, { AGENTIC_REVIEWER_TOKEN: 'ghp_fixture' }, '--rules', '--require-review');
check('init --rules --require-review (token set) exits 0', requireReviewToken.status === 0, `${requireReviewToken.stdout}${requireReviewToken.stderr}`);
const requireReviewTokenBody = ruleBody(stateRequireReviewToken, 'put');
check(
  'init --rules --require-review writes the same three fields whether or not the token is set',
  requiresOneApprovingReview(requireReviewTokenBody),
  JSON.stringify(requireReviewTokenBody),
);
check(
  'init --rules --require-review with AGENTIC_REVIEWER_TOKEN set prints no freeze warning',
  !FREEZE_WARNING.test(requireReviewToken.stdout),
  requireReviewToken.stdout,
);
check(
  'init --rules --require-review never calls itself ignored',
  !/--require-review ignored/.test(requireReview.stdout) && !/--require-review ignored/.test(requireReviewToken.stdout),
  requireReview.stdout,
);

// Without --rules there is no ruleset call for --require-review to change,
// and --no-gh skips that call entirely: say so rather than accept the flag
// silently and write nothing.
const ignoredNoRules = init('--require-review');
check('init --require-review without --rules exits 0', ignoredNoRules.status === 0, `${ignoredNoRules.stdout}${ignoredNoRules.stderr}`);
check(
  'init --require-review without --rules reports the flag as ignored',
  /! --require-review ignored: it raises the ruleset review gate, which only --rules writes/.test(ignoredNoRules.stdout),
  ignoredNoRules.stdout,
);
const ignoredNoGh = init('--rules', '--require-review');
check('init --no-gh --rules --require-review exits 0', ignoredNoGh.status === 0, `${ignoredNoGh.stdout}${ignoredNoGh.stderr}`);
check(
  'init --rules --require-review under --no-gh reports the flag as ignored',
  /! --require-review ignored: --no-gh skips the ruleset call it would change/.test(ignoredNoGh.stdout),
  ignoredNoGh.stdout,
);

// The default carries the fetched stale-approval fields through as they are:
// a ruleset already dismissing stale approvals keeps doing so, even though
// --require-review was not passed and the count is reset to 0.
const stateRulesCarry = rulesState('carry', [
  {
    id: 71,
    name: 'main',
    target: 'branch',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      {
        type: 'pull_request',
        parameters: { required_approving_review_count: 2, dismiss_stale_reviews_on_push: true, require_last_push_approval: true },
      },
    ],
    bypass_actors: [],
  },
]);
const rulesCarry = initWithGh(ghRepo, stateRulesCarry, '--rules');
check('init --rules against a ruleset that dismisses stale approvals exits 0', rulesCarry.status === 0, `${rulesCarry.stdout}${rulesCarry.stderr}`);
const carryBody = ruleBody(stateRulesCarry, 'put');
check(
  'init --rules resets the count to 0 but carries a fetched dismiss_stale_reviews_on_push / require_last_push_approval: true through',
  leavesReviewGateOff(carryBody, { dismiss: true, lastPush: true }),
  JSON.stringify(carryBody),
);

// --- the refusal path of the lookup: a ruleset detail that cannot be read.
// `GET .../rulesets` answers with summaries only, so a failed or unparsable
// `GET .../rulesets/<id>` leaves a ruleset with no conditions — which reads
// exactly like a ruleset governing nothing and would send the run down the
// create path, POSTing a second ruleset over the branch the unreadable one
// already governs (#143 B1 all over again). The run has to refuse instead.
const UNREADABLE = (id: number) => new RegExp(`! ruleset: could not read ruleset #${id}: `);

const stateDetail500 = rulesState('detail-500', [
  { id: 61, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateDetail500, 'ruleset-61-fail'), '');
const detail500 = initWithGh(ghRepo, stateDetail500, '--rules');
check('init --rules exits 0 when a ruleset detail cannot be read', detail500.status === 0, `${detail500.stdout}${detail500.stderr}`);
check(
  'init --rules reports the ruleset whose detail it could not read, with gh first error line',
  UNREADABLE(61).test(detail500.stdout) && /HTTP 500/.test(detail500.stdout),
  detail500.stdout,
);
check(
  'init --rules never reports a ruleset created when a detail fetch failed',
  !/\+ ruleset created/.test(detail500.stdout) && !/= ruleset updated/.test(detail500.stdout),
  detail500.stdout,
);
check(
  'init --rules makes no mutating call when a detail fetch failed',
  !ghLog(stateDetail500).includes('-X POST') &&
    !ghLog(stateDetail500).includes('-X PUT') &&
    ruleBody(stateDetail500, 'post') === null &&
    ruleBody(stateDetail500, 'put') === null,
  ghLog(stateDetail500),
);

// The same refusal when the detail GET succeeds but answers with something
// that is not a ruleset object.
const stateDetailJunk = rulesState('detail-junk', [
  { id: 62, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateDetailJunk, 'ruleset-62.json'), 'not json at all');
const detailJunk = initWithGh(ghRepo, stateDetailJunk, '--rules');
check('init --rules exits 0 when a ruleset detail does not parse', detailJunk.status === 0, `${detailJunk.stdout}${detailJunk.stderr}`);
check(
  'init --rules reports a ruleset detail that is not a ruleset object and creates nothing',
  UNREADABLE(62).test(detailJunk.stdout) && !/\+ ruleset created/.test(detailJunk.stdout),
  detailJunk.stdout,
);
check(
  'init --rules makes no mutating call when a ruleset detail does not parse',
  !ghLog(stateDetailJunk).includes('-X POST') && !ghLog(stateDetailJunk).includes('-X PUT'),
  ghLog(stateDetailJunk),
);

// --dry-run previews the same refusal: no payload, no outcome line.
const stateDetailDry = rulesState('detail-dry', [
  { id: 63, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateDetailDry, 'ruleset-63-fail'), '');
const detailDry = initWithGh(ghRepo, stateDetailDry, '--rules', '--dry-run');
check('init --rules --dry-run exits 0 when a ruleset detail cannot be read', detailDry.status === 0, `${detailDry.stdout}${detailDry.stderr}`);
check(
  'init --rules --dry-run previews the same refusal and no payload',
  UNREADABLE(63).test(detailDry.stdout) && !/payload for /.test(detailDry.stdout) && !/\+ ruleset created/.test(detailDry.stdout),
  detailDry.stdout,
);

// The other spelling of the same condition: a ruleset whose include list
// names refs/heads/<default branch> literally is matched too.
const stateRulesExisting = rulesState('existing', [
  {
    id: 42,
    name: 'agentic-setup',
    target: 'branch',
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [],
    bypass_actors: [],
  },
]);
const rulesExisting = initWithGh(ghRepo, stateRulesExisting, '--rules');
check('init --rules (existing ruleset on refs/heads/main) exits 0', rulesExisting.status === 0, `${rulesExisting.stdout}${rulesExisting.stderr}`);
check('init --rules updates the existing ruleset instead of creating one', /= ruleset updated/.test(rulesExisting.stdout), rulesExisting.stdout);
check('init --rules PUTs to the existing ruleset by id', ghLog(stateRulesExisting).includes('rulesets/42 -X PUT'), ghLog(stateRulesExisting));
check('init --rules does not also create a second ruleset', !existsSync(join(stateRulesExisting, 'ruleset-post-body.json')));

// A ruleset that governs some other branch is not ours, whatever it is
// called: only the one over the default branch is updated.
const stateRulesOther = rulesState('other', [
  { id: 8, name: 'agentic-setup', target: 'branch', conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } }, rules: [] },
]);
const rulesOther = initWithGh(ghRepo, stateRulesOther, '--rules');
check('init --rules exits 0 when no ruleset governs the default branch', rulesOther.status === 0, `${rulesOther.stdout}${rulesOther.stderr}`);
check(
  'init --rules leaves a ruleset over another branch alone and creates one',
  !ghLog(stateRulesOther).includes('rulesets/8 -X PUT') && ghLog(stateRulesOther).includes('rulesets -X POST'),
  ghLog(stateRulesOther),
);

// --ruleset-name overrides the choice: the named ruleset is updated even
// though another one governs the default branch.
const stateRulesNamed = rulesState('named', [
  { id: 11, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [] },
  { id: 12, name: 'chosen', target: 'branch', conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } }, rules: [] },
]);
const rulesNamed = initWithGh(ghRepo, stateRulesNamed, '--rules', '--ruleset-name', 'chosen');
check('init --rules --ruleset-name exits 0', rulesNamed.status === 0, `${rulesNamed.stdout}${rulesNamed.stderr}`);
check(
  'init --rules --ruleset-name updates the ruleset it names, not the one matched by condition',
  ghLog(stateRulesNamed).includes('rulesets/12 -X PUT') && !ghLog(stateRulesNamed).includes('rulesets/11 -X PUT'),
  ghLog(stateRulesNamed),
);

// Several rulesets over the same branch: the first is updated, the rest are
// reported and left exactly as they are — never created over.
const stateRulesMany = rulesState('many', [
  { id: 21, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [] },
  { id: 22, name: 'legacy', target: 'branch', conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } }, rules: [] },
]);
const rulesMany = initWithGh(ghRepo, stateRulesMany, '--rules');
check('init --rules with several matching rulesets exits 0', rulesMany.status === 0, `${rulesMany.stdout}${rulesMany.stderr}`);
check('init --rules updates the first matching ruleset', ghLog(stateRulesMany).includes('rulesets/21 -X PUT'), ghLog(stateRulesMany));
check(
  'init --rules reports the other matching rulesets and neither updates nor creates over them',
  /! ruleset: 2 rulesets govern main/.test(rulesMany.stdout) && /"legacy" \(#22\)/.test(rulesMany.stdout) && !ghLog(stateRulesMany).includes('-X POST'),
  `${rulesMany.stdout}\n${ghLog(stateRulesMany)}`,
);

// A tag ruleset shares the endpoint and must never be matched or updated.
const stateRulesTag = rulesState('tag', [
  { id: 31, name: 'tags', target: 'tag', conditions: { ref_name: { include: ['~ALL'], exclude: [] } }, rules: [] },
]);
const rulesTag = initWithGh(ghRepo, stateRulesTag, '--rules');
check(
  'init --rules ignores a ruleset that does not target branches',
  rulesTag.status === 0 && !ghLog(stateRulesTag).includes('rulesets/31 -X PUT') && ghLog(stateRulesTag).includes('rulesets -X POST'),
  ghLog(stateRulesTag),
);

const stateRules403 = mkdtempSync(join(tmpdir(), 'agentic-init-rules-403-'));
cleanup(() => rmSync(stateRules403, { recursive: true, force: true }));
writeFileSync(join(stateRules403, 'rulesets-403'), '');
const rules403 = initWithGh(ghRepo, stateRules403, '--rules');
check('init --rules still exits 0 when the plan forbids rulesets', rules403.status === 0, `${rules403.stdout}${rules403.stderr}`);
check(
  'init --rules reports the free-plan private-repository limit on a 403',
  rules403.stdout.includes('! ruleset: not available on this plan for a private repository'),
  rules403.stdout,
);

const stateRulesDry = mkdtempSync(join(tmpdir(), 'agentic-init-rules-dry-'));
cleanup(() => rmSync(stateRulesDry, { recursive: true, force: true }));
const rulesDry = initWithGh(ghRepo, stateRulesDry, '--rules', '--dry-run');
check('init --rules --dry-run exits 0', rulesDry.status === 0, `${rulesDry.stdout}${rulesDry.stderr}`);
check('init --rules --dry-run reports the same outcome a real run would', /\+ ruleset created/.test(rulesDry.stdout), rulesDry.stdout);
check(
  'init --rules --dry-run reads the rulesets list but never writes one',
  ghLog(stateRulesDry).includes('rulesets') && !ghLog(stateRulesDry).includes('-X POST') && !ghLog(stateRulesDry).includes('-X PUT'),
  ghLog(stateRulesDry),
);
check(
  'init --rules --dry-run prints the payload it would POST',
  /"required_approving_review_count": 0/.test(rulesDry.stdout) && /POST repos\/\{owner\}\/\{repo\}\/rulesets/.test(rulesDry.stdout),
  rulesDry.stdout,
);

// The same preview against a repository that already has the ruleset: the
// payload is the update body, and nothing mutating leaves the process.
const stateRulesDryLive = rulesState('dry-live', [
  {
    id: LIVE_ID,
    name: 'main',
    target: 'branch',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 0, dismiss_stale_reviews_on_push: false } }],
    bypass_actors: [],
  },
]);
const rulesDryLive = initWithGh(ghRepo, stateRulesDryLive, '--rules', '--dry-run');
check('init --rules --dry-run against an existing ruleset exits 0', rulesDryLive.status === 0, `${rulesDryLive.stdout}${rulesDryLive.stderr}`);
check('init --rules --dry-run against an existing ruleset reports the update', /= ruleset updated/.test(rulesDryLive.stdout), rulesDryLive.stdout);
check(
  'init --rules --dry-run prints the payload it would PUT and sends nothing',
  new RegExp(`PUT repos/\\{owner\\}/\\{repo\\}/rulesets/${LIVE_ID}`).test(rulesDryLive.stdout) &&
    /"required_approving_review_count": 0/.test(rulesDryLive.stdout) &&
    /"dismiss_stale_reviews_on_push": false/.test(rulesDryLive.stdout),
  rulesDryLive.stdout,
);
check(
  'init --rules --dry-run records zero mutating calls',
  !ghLog(stateRulesDryLive).includes('-X POST') &&
    !ghLog(stateRulesDryLive).includes('-X PUT') &&
    ruleBody(stateRulesDryLive, 'post') === null &&
    ruleBody(stateRulesDryLive, 'put') === null,
  ghLog(stateRulesDryLive),
);
// --- #229: every remaining read on this path that could fail quietly. Each
// case asserts the refusal by name *and* that nothing mutating left the
// process: a report line alone would not prove the run stopped short of the
// create path, which is the whole defect.

/** Nothing was POSTed and nothing was PUT — the run refused before mutating. */
function madeNoMutatingCall(stateDir: string): boolean {
  return (
    !ghLog(stateDir).includes('-X POST') &&
    !ghLog(stateDir).includes('-X PUT') &&
    ruleBody(stateDir, 'post') === null &&
    ruleBody(stateDir, 'put') === null
  );
}
/** No outcome line was printed: neither "+ ruleset created" nor "= ruleset updated". */
const claimedNoOutcome = (out: string): boolean => !/\+ ruleset created/.test(out) && !/= ruleset updated/.test(out);

// AC1: the rulesets *list* is the one read on this path that answered
// "there is no ruleset" for a failure that was not that. `parseJson(..., [])`
// turned an error body into an empty list, `unreadable` stayed null, and the
// run took the create path — POSTing exactly the second ruleset #143 exists
// to prevent, over a branch an existing ruleset may well govern.
const stateListObject = ghState('rules-list-object');
writeFileSync(join(stateListObject, 'rulesets-list.json'), '{"message":"Not Found","status":"404"}');
const listObject = initWithGh(ghRepo, stateListObject, '--rules');
check('init --rules exits 0 when the rulesets list is not an array', listObject.status === 0, `${listObject.stdout}${listObject.stderr}`);
check(
  'init --rules refuses a rulesets list that is not a JSON array, naming what it could not read',
  /! ruleset: the rulesets list is not a JSON array/.test(listObject.stdout) && claimedNoOutcome(listObject.stdout),
  listObject.stdout,
);
check('init --rules creates no ruleset when the rulesets list is not an array', madeNoMutatingCall(stateListObject), ghLog(stateListObject));

// The same read, second entrance, found while verifying #229 and not listed
// in it: a list that is not valid JSON at all was swallowed into the `[]`
// fallback, passed `Array.isArray`, and reached the create path just as
// quietly as the object above.
const stateListJunk = ghState('rules-list-junk');
writeFileSync(join(stateListJunk, 'rulesets-list.json'), '<html>502 Bad Gateway</html>');
const listJunk = initWithGh(ghRepo, stateListJunk, '--rules');
check('init --rules exits 0 when the rulesets list does not parse', listJunk.status === 0, `${listJunk.stdout}${listJunk.stderr}`);
check(
  'init --rules refuses a rulesets list that is not valid JSON instead of reading it as an empty list',
  /! ruleset: the rulesets list is not valid JSON/.test(listJunk.stdout) && claimedNoOutcome(listJunk.stdout),
  listJunk.stdout,
);
check('init --rules creates no ruleset when the rulesets list does not parse', madeNoMutatingCall(stateListJunk), ghLog(stateListJunk));

// AC2: `gh repo view` failing used to fall back to "main" and say nothing.
// On a repository whose default branch is not main that guess is wrong, so
// every governsDefaultBranch test compares against the wrong ref, nothing
// matches, and the run creates a ruleset over a branch the ruleset in this
// fixture already governs. The fixture is exactly that shape: the read fails
// and a ruleset governs refs/heads/trunk.
const stateBranchUnread = rulesState('branch-unread', [
  { id: 81, name: 'trunk', target: 'branch', conditions: { ref_name: { include: ['refs/heads/trunk'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateBranchUnread, 'repo-view-fail'), '');
const branchUnread = initWithGh(ghRepo, stateBranchUnread, '--rules');
check('init --rules exits 0 when the default branch cannot be read', branchUnread.status === 0, `${branchUnread.stdout}${branchUnread.stderr}`);
check(
  'init --rules refuses when gh repo view fails, naming the default-branch read and gh first error line',
  /! ruleset: could not read the default branch: /.test(branchUnread.stdout) && /HTTP 502/.test(branchUnread.stdout),
  branchUnread.stdout,
);
check(
  'init --rules never guesses main and creates a ruleset over a branch another one governs',
  madeNoMutatingCall(stateBranchUnread) && claimedNoOutcome(branchUnread.stdout),
  `${branchUnread.stdout}\n${ghLog(stateBranchUnread)}`,
);
check(
  'init names the unreadable default branch rather than printing nothing about its guess',
  /! could not read the default branch: /.test(branchUnread.stdout),
  branchUnread.stdout,
);

// AC3, first half: `--ruleset-name` as the last argument on the command line
// became "no override" and the run fell back to matching by conditions, with
// nothing in the report to say the flag had been dropped.
const stateNameMissing = rulesState('name-missing', [
  { id: 91, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
const nameMissing = initWithGh(ghRepo, stateNameMissing, '--rules', '--ruleset-name');
check('init --rules --ruleset-name with no value exits 0', nameMissing.status === 0, `${nameMissing.stdout}${nameMissing.stderr}`);
check(
  'init reports --ruleset-name with no value as a usage error instead of dropping it silently',
  /! --ruleset-name: no name follows it/.test(nameMissing.stdout),
  nameMissing.stdout,
);
check(
  'init --rules --ruleset-name with no value does not fall back to matching by conditions',
  madeNoMutatingCall(stateNameMissing) && claimedNoOutcome(nameMissing.stdout),
  `${nameMissing.stdout}\n${ghLog(stateNameMissing)}`,
);

// The same failure class one argument over: the next token is another flag,
// which used to be taken as the ruleset's name.
const stateNameFlag = rulesState('name-flag', [
  { id: 92, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
const nameFlag = initWithGh(ghRepo, stateNameFlag, '--ruleset-name', '--rules');
check('init --ruleset-name followed by another flag exits 0', nameFlag.status === 0, `${nameFlag.stdout}${nameFlag.stderr}`);
check(
  'init does not take the next flag as the ruleset name',
  /! --ruleset-name: no name follows it/.test(nameFlag.stdout) && madeNoMutatingCall(stateNameFlag),
  `${nameFlag.stdout}\n${ghLog(stateNameFlag)}`,
);

// AC3, second half: a --ruleset-name that matches nothing used to POST a new
// ruleset under that name, over a default branch another ruleset governs.
// The operator asked to update one specific ruleset; creating a second one is
// not a smaller version of that request, it is the opposite of it. The
// refusal names the rulesets that do exist so the operator can pick one.
const stateNameNoMatch = rulesState('name-nomatch', [
  { id: 93, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
  { id: 94, name: 'release', target: 'branch', conditions: { ref_name: { include: ['refs/heads/release'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
const nameNoMatch = initWithGh(ghRepo, stateNameNoMatch, '--rules', '--ruleset-name', 'typo');
check('init --rules --ruleset-name with no match exits 0', nameNoMatch.status === 0, `${nameNoMatch.stdout}${nameNoMatch.stderr}`);
check(
  'init --rules refuses a --ruleset-name that matches nothing and names the rulesets that do exist',
  /! ruleset: no branch ruleset is named "typo"/.test(nameNoMatch.stdout) &&
    /"main" \(#93\)/.test(nameNoMatch.stdout) &&
    /"release" \(#94\)/.test(nameNoMatch.stdout),
  nameNoMatch.stdout,
);
check(
  'init --rules POSTs no ruleset named after an override that matched nothing',
  madeNoMutatingCall(stateNameNoMatch) && claimedNoOutcome(nameNoMatch.stdout),
  `${nameNoMatch.stdout}\n${ghLog(stateNameNoMatch)}`,
);

// AC4: the plan diagnosis used to be produced by matching `403` anywhere in
// a message, and the same function is handed the `unreadable` refusal text.
// A ruleset whose id merely contains those digits was therefore reported as
// "not available on this plan" — a different, non-actionable diagnosis that
// sends the operator to their billing page over an HTTP 500.
const stateId403 = rulesState('id-403', [
  { id: 4031, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
]);
writeFileSync(join(stateId403, 'ruleset-4031-fail'), '');
const id403 = initWithGh(ghRepo, stateId403, '--rules');
check('init --rules exits 0 when an unreadable ruleset id contains 403', id403.status === 0, `${id403.stdout}${id403.stderr}`);
check(
  'init --rules reports the unreadable ruleset by its own text, not as the free-plan limit',
  /! ruleset: could not read ruleset #4031: /.test(id403.stdout) &&
    /HTTP 500/.test(id403.stdout) &&
    !/not available on this plan/.test(id403.stdout),
  id403.stdout,
);
check('init --rules makes no mutating call when an unreadable ruleset id contains 403', madeNoMutatingCall(stateId403), ghLog(stateId403));

// The genuine 403 still reads as the plan limit — the case above must not be
// bought by making the diagnosis disappear. (`rulesets-403` makes the fake
// gh fail the call itself, which is where a real 403 comes from.)
const state403Still = ghState('rules-403-still');
writeFileSync(join(state403Still, 'rulesets-403'), '');
const still403 = initWithGh(ghRepo, state403Still, '--rules');
check(
  'init --rules still reports a genuine 403 from the gh call as the free-plan limit',
  still403.status === 0 && still403.stdout.includes('! ruleset: not available on this plan for a private repository'),
  still403.stdout,
);

// AC5: a detail whose shape is not a ruleset's used to reach
// buildRulesetPayload, where `.find` and the spread of `rules` throw a
// TypeError out of the process. `bypass_actors` and `conditions` are quieter
// still: they are assigned, not spread, so a malformed one is shipped to the
// API in the request body rather than throwing. Both are unreadable details,
// and the refusal is the one the lookup already has.
for (const [label, id, field, detail] of [
  ['rules that is not an array', 95, 'rules', { rules: { pull_request: {} } }],
  ['bypass_actors that is not an array', 96, 'bypass_actors', { rules: [], bypass_actors: { 0: 'everyone' } }],
  ['conditions that is not an object', 97, 'conditions', { rules: [], bypass_actors: [], conditions: 'refs/heads/main' }],
  ['a ref_name.include that is not an array', 98, 'conditions.ref_name.include', { rules: [], bypass_actors: [], conditions: { ref_name: { include: 'refs/heads/main' } } }],
] as Array<[string, number, string, Record<string, unknown>]>) {
  const st = rulesState(`detail-shape-${id}`, [
    { id, name: 'main', target: 'branch', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } }, rules: [], bypass_actors: [] },
  ]);
  writeFileSync(join(st, `ruleset-${id}.json`), JSON.stringify({ id, name: 'main', target: 'branch', ...detail }));
  const r = initWithGh(ghRepo, st, '--rules');
  check(`init --rules exits 0 on a detail with ${label}`, r.status === 0, `${r.stdout}${r.stderr}`);
  check(
    `init --rules treats a detail with ${label} as unreadable and names the field`,
    new RegExp(`! ruleset: could not read ruleset #${id}: `).test(r.stdout) && r.stdout.includes(`"${field}"`),
    r.stdout,
  );
  check(
    `init --rules neither throws nor mutates on a detail with ${label}`,
    madeNoMutatingCall(st) && claimedNoOutcome(r.stdout) && !/TypeError/.test(`${r.stdout}${r.stderr}`),
    `${r.stdout}${r.stderr}`,
  );
}

finish();
