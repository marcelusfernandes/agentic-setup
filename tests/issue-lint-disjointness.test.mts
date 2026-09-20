#!/usr/bin/env node
// Cases for the one thing `ci/issue-lint.mts` decides by reading more than
// one issue: the disjointness graph. Two issues in flight cannot claim the
// same file, unless a `Blocked by:` relation orders them — then the overlap
// is reported as `sequenced`, not as a failure. Split out of
// tests/issue-lint.test.mts (#352): everything the lint decides from a
// single body — sections, the `Declaration:` line, the glob classification,
// the grant rules, Blocked-by, the output shape — stayed there, and every
// case that compares this issue against the others in flight is here.
//
// The boundary is mechanical, and #338 restored it rather than restating it:
// every `milestoneFile(` call, every `lint(..., { milestone })` call and
// every `ghLint(` call — the third way a case reaches more than one issue,
// added at the foot of this file — is in this file. #299 had written three
// blocks needing `milestoneFile(` into tests/issue-lint.test.mts, under a
// grant that did not name this file, and recorded the exception in that
// file's header; those blocks are below and that paragraph is gone, so the
// sentence is true again instead of merely written down.
//
// The fake `gh` for AC5, the throwaway repository whose tracked files the
// globs are classified against and the six-section body builder are shared
// with tests/issue-lint.test.mts through tests/lib/issue-lint-harness.mts,
// so both files spawn the real script against one set of fixtures (#229's
// reason, written in that file's header). The second fake `gh` — the one
// answering the two calls a run *without* `--issue-body-file` makes — is
// local to this file, because #338's `## Files` does not name the shared
// harness. The script itself is spawned, not imported (invariant 6).
//
// Negative control: the #338 block at the foot of this file is the red. On
// the base an overlap between two issues of different milestones is reported
// as no overlap at all, so those cases fail there. Everything above it moved
// from tests/issue-lint.test.mts unchanged and passes on the base too.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, finish, RUNTIME } from './lib/harness.mts';
import { issueBody, lint, milestoneFile, parse, repo } from './lib/issue-lint-harness.mts';

// --- AC3: disjointness -------------------------------------------------------
const overlapMilestone = milestoneFile([{ number: 200, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n' }]);
const overlap = lint(109, issueBody(), { milestone: overlapMilestone });
const overlapOut = parse(overlap.out);
check('overlapping globs with another ready issue fails with ok: false', overlap.status === 1 && overlapOut?.ok === false, overlap.out);
check(
  'the overlap failure carries { issue, files } naming the other issue and the shared file',
  Array.isArray(overlapOut?.failures) && overlapOut.failures.some((f: any) => f?.issue === 200 && Array.isArray(f?.files) && f.files.includes('tests/smoke.mts')),
  overlap.out,
);

// AC3: the same overlap against an issue labelled state:in-progress (not
// just state:ready) is also a failure — the code path covers all three
// RELEVANT_STATES, not only "ready".
const inProgressMilestone = milestoneFile([{ number: 204, labels: ['state:in-progress'], body: '## Files\n- `tests/smoke.mts`\n' }]);
const inProgressOverlap = lint(1090, issueBody(), { milestone: inProgressMilestone });
const inProgressOverlapOut = parse(inProgressOverlap.out);
check(
  'overlapping globs with a state:in-progress issue also fails',
  inProgressOverlap.status === 1 &&
    inProgressOverlapOut?.ok === false &&
    Array.isArray(inProgressOverlapOut?.failures) &&
    inProgressOverlapOut.failures.some((f: any) => f?.issue === 204 && f?.files?.includes('tests/smoke.mts')),
  inProgressOverlap.out,
);

const sequencedMilestone = milestoneFile([{ number: 201, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n' }]);
const sequenced = lint(110, issueBody({ deps: '## Dependencies\nBlocked by: #201\n' }), { milestone: sequencedMilestone });
const sequencedOut = parse(sequenced.out);
check(
  'two ready issues that overlap are not a failure when one is blocked by the other (sequenced)',
  sequenced.status === 0 && !(sequencedOut?.failures ?? []).some((f: any) => f?.issue === 201),
  sequenced.out,
);
check(
  'the sequenced overlap is reported in sequenced: [{ issue, files }] instead of failures',
  Array.isArray(sequencedOut?.sequenced) && sequencedOut.sequenced.some((s: any) => s?.issue === 201 && s?.files?.includes('tests/smoke.mts')),
  sequenced.out,
);

// #258: the Blocked-by relation that accepts an overlap is transitive. A
// chain A -> B -> C is strictly ordered, so A and C may share a file without
// C restating B's predecessor — before this, only a direct `Blocked by:`
// counted and every sub-issue of a chain had to list all of them by hand.
// B's globs are disjoint from A's on purpose: the only thing that can make
// this pass is the closure, not a direct relation.
const chainMilestone = milestoneFile([
  { number: 220, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n\n## Dependencies\nBlocked by: #221\n' },
  { number: 221, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n\n## Dependencies\nBlocked by: none\n' },
]);
const chain = lint(1130, issueBody({ deps: '## Dependencies\nBlocked by: #220\n' }), { milestone: chainMilestone });
const chainOut = parse(chain.out);
check(
  'a three-issue chain A -> B -> C: the A/C overlap is not a failure (transitive Blocked by)',
  chain.status === 0 && chainOut?.ok === true && !(chainOut?.failures ?? []).some((f: any) => f?.issue === 221),
  chain.out,
);
check(
  'the transitive A/C overlap is reported in sequenced: [{ issue, files }]',
  Array.isArray(chainOut?.sequenced) && chainOut.sequenced.some((s: any) => s?.issue === 221 && s?.files?.includes('tests/smoke.mts')),
  chain.out,
);

// The closure is read in both directions, exactly as the direct check was:
// here the *other* issue reaches this one (222 -> 223 -> 1131).
const reverseChainMilestone = milestoneFile([
  { number: 222, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n\n## Dependencies\nBlocked by: #223\n' },
  { number: 223, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n\n## Dependencies\nBlocked by: #1131\n' },
]);
const reverseChain = lint(1131, issueBody(), { milestone: reverseChainMilestone });
const reverseChainOut = parse(reverseChain.out);
check(
  'a chain that reaches this issue (other -> B -> self) is sequenced too',
  reverseChain.status === 0 &&
    reverseChainOut?.ok === true &&
    Array.isArray(reverseChainOut?.sequenced) &&
    reverseChainOut.sequenced.some((s: any) => s?.issue === 222 && s?.files?.includes('tests/smoke.mts')),
  reverseChain.out,
);

// A cycle in the graph must terminate on a visited set and be named, not
// hang. The two issues here do not overlap at all: the cycle itself is the
// failure.
const cycleMilestone = milestoneFile([
  { number: 224, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n\n## Dependencies\nBlocked by: #1132\n' },
]);
const cycle = lint(1132, issueBody({ deps: '## Dependencies\nBlocked by: #224\n' }), { milestone: cycleMilestone });
const cycleOut = parse(cycle.out);
check('a Blocked-by cycle fails with ok: false instead of hanging', cycle.status === 1 && cycleOut?.ok === false, cycle.out);
check(
  'the cycle failure names every issue in it',
  (cycleOut?.failures ?? []).some((f: any) => typeof f === 'string' && /cycle/i.test(f) && f.includes('#1132') && f.includes('#224')),
  cycle.out,
);

// The closure follows the direction of `Blocked by:`, so a shared blocker is
// not an ordering: two issues both blocked by the same third one still
// overlap and still fail.
const sharedBlockerMilestone = milestoneFile([
  { number: 225, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n\n## Dependencies\nBlocked by: none\n' },
  { number: 226, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n\n## Dependencies\nBlocked by: #225\n' },
]);
const sharedBlocker = lint(1133, issueBody({ deps: '## Dependencies\nBlocked by: #225\n' }), { milestone: sharedBlockerMilestone });
const sharedBlockerOut = parse(sharedBlocker.out);
check(
  'two issues that share a blocker but do not order each other still fail on the overlap',
  sharedBlocker.status === 1 && sharedBlockerOut?.failures.some((f: any) => f?.issue === 226 && f?.files?.includes('tests/smoke.mts')),
  sharedBlocker.out,
);

const nonOverlapping = milestoneFile([{ number: 202, labels: ['state:ready'], body: '## Files\n- `docs/**`\n' }]);
const disjoint = lint(111, issueBody(), { milestone: nonOverlapping });
check('non-overlapping globs with another ready issue does not fail', disjoint.status === 0, disjoint.out);

const otherLabelIrrelevant = milestoneFile([{ number: 203, labels: ['state:done'], body: '## Files\n- `tests/smoke.mts`\n' }]);
const doneOverlap = lint(112, issueBody(), { milestone: otherLabelIrrelevant });
check('an overlapping issue labelled state:done (not in flight) is ignored', doneOverlap.status === 0, doneOverlap.out);

// AC3: two issues that both declare the same *new* literal path (neither
// matches a tracked file) still overlap — comparing only matched tracked
// files would miss this, since the path is not tracked by either.
const sameNewPathMilestone = milestoneFile([{ number: 205, labels: ['state:ready'], body: '## Files\n- `scripts/lib/issues.mts`\n' }]);
const sameNewPathOverlap = lint(1120, issueBody({ files: '## Files\n- `scripts/lib/issues.mts`\n' }), { milestone: sameNewPathMilestone });
const sameNewPathOverlapOut = parse(sameNewPathOverlap.out);
check(
  'two issues declaring the same new literal path overlap, with ok: false',
  sameNewPathOverlap.status === 1 && sameNewPathOverlapOut?.ok === false,
  sameNewPathOverlap.out,
);
check(
  'the same-new-path overlap carries { issue, files } naming the other issue and the shared new path',
  Array.isArray(sameNewPathOverlapOut?.failures) &&
    sameNewPathOverlapOut.failures.some((f: any) => f?.issue === 205 && Array.isArray(f?.files) && f.files.includes('scripts/lib/issues.mts')),
  sameNewPathOverlap.out,
);

// AC4 (of #41): a "new" directory wildcard (`newmod/**`) is treated as
// covering any path under it for disjointness — another issue declaring a
// literal new file inside that same new directory overlaps.
const newDirOverlapMilestone = milestoneFile([{ number: 206, labels: ['state:ready'], body: '## Files\n- `newmod/index.ts`\n' }]);
const newDirOverlap = lint(1121, issueBody({ files: '## Files\n- `newmod/**`\n' }), { milestone: newDirOverlapMilestone });
const newDirOverlapOut = parse(newDirOverlap.out);
check(
  'a new directory wildcard overlaps another issue declaring a new file inside it, with ok: false',
  newDirOverlap.status === 1 && newDirOverlapOut?.ok === false,
  newDirOverlap.out,
);
check(
  'the new-directory overlap carries { issue, files } naming the other issue and the shared new path',
  Array.isArray(newDirOverlapOut?.failures) &&
    newDirOverlapOut.failures.some((f: any) => f?.issue === 206 && Array.isArray(f?.files) && f.files.includes('newmod/index.ts')),
  newDirOverlap.out,
);

// AC4 (round 2 of #41): two issues each declaring a wildcard under the same
// brand-new directory — neither glob matches a tracked file, and neither
// declares a literal path, so comparing only matched tracked files and new
// literal paths (as above) misses this entirely: both lint ok: true on the
// unfixed branch. The fix compares each new wildcard's fixed directory
// prefix too; two issues both declaring `newmod/**` share the same prefix
// (`newmod/`), reported here (not the raw glob) as the overlapping path.
const wildcardVsWildcardMilestone = milestoneFile([{ number: 207, labels: ['state:ready'], body: '## Files\n- `newmod/**`\n' }]);
const wildcardVsWildcardOverlap = lint(1122, issueBody({ files: '## Files\n- `newmod/**`\n' }), { milestone: wildcardVsWildcardMilestone });
const wildcardVsWildcardOverlapOut = parse(wildcardVsWildcardOverlap.out);
check(
  'two issues both declaring a wildcard over the same new directory overlap, with ok: false',
  wildcardVsWildcardOverlap.status === 1 && wildcardVsWildcardOverlapOut?.ok === false,
  wildcardVsWildcardOverlap.out,
);
check(
  'the wildcard-vs-wildcard overlap carries { issue, files } naming the other issue and the shared new-directory prefix',
  Array.isArray(wildcardVsWildcardOverlapOut?.failures) &&
    wildcardVsWildcardOverlapOut.failures.some((f: any) => f?.issue === 207 && Array.isArray(f?.files) && f.files.includes('newmod/')),
  wildcardVsWildcardOverlap.out,
);

// AC4 (round 2 of #41): the same hole, one directory level down — `newmod/**`
// vs `newmod/sub/*.ts`. Neither glob matches a tracked file (both prefixes
// are new), so this also lints ok: true on the unfixed branch. The narrower
// prefix (`newmod/sub/`) is a subdirectory of the wider one (`newmod/`); the
// fix's overlap rule is "one prefix startsWith the other", reporting both
// prefixes.
const wildcardVsNestedWildcardMilestone = milestoneFile([{ number: 208, labels: ['state:ready'], body: '## Files\n- `newmod/sub/*.ts`\n' }]);
const wildcardVsNestedWildcardOverlap = lint(1123, issueBody({ files: '## Files\n- `newmod/**`\n' }), { milestone: wildcardVsNestedWildcardMilestone });
const wildcardVsNestedWildcardOverlapOut = parse(wildcardVsNestedWildcardOverlap.out);
check(
  'a new-directory wildcard and a wildcard under one of its new subdirectories overlap, with ok: false',
  wildcardVsNestedWildcardOverlap.status === 1 && wildcardVsNestedWildcardOverlapOut?.ok === false,
  wildcardVsNestedWildcardOverlap.out,
);
check(
  'the nested wildcard-vs-wildcard overlap carries { issue, files } naming the other issue and both new-directory prefixes',
  Array.isArray(wildcardVsNestedWildcardOverlapOut?.failures) &&
    wildcardVsNestedWildcardOverlapOut.failures.some(
      (f: any) => f?.issue === 208 && Array.isArray(f?.files) && f.files.includes('newmod/') && f.files.includes('newmod/sub/'),
    ),
  wildcardVsNestedWildcardOverlap.out,
);

// AC3 (round 2 of #41): the same wildcard-vs-wildcard pair is not a failure
// when one issue is blocked by the other — `sequenced` still applies to a
// new-directory-prefix overlap, not just a matched-file or new-literal-path
// one.
const sequencedWildcardMilestone = milestoneFile([{ number: 209, labels: ['state:ready'], body: '## Files\n- `newmod/**`\n' }]);
const sequencedWildcardOverlap = lint(
  1124,
  issueBody({ files: '## Files\n- `newmod/**`\n', deps: '## Dependencies\nBlocked by: #209\n' }),
  { milestone: sequencedWildcardMilestone },
);
const sequencedWildcardOverlapOut = parse(sequencedWildcardOverlap.out);
check(
  'two wildcards over the same new directory are not a failure when one is blocked by the other (sequenced)',
  sequencedWildcardOverlap.status === 0 && !(sequencedWildcardOverlapOut?.failures ?? []).some((f: any) => f?.issue === 209),
  sequencedWildcardOverlap.out,
);
check(
  'the sequenced wildcard-vs-wildcard overlap is reported in sequenced: [{ issue, files }] instead of failures',
  Array.isArray(sequencedWildcardOverlapOut?.sequenced) &&
    sequencedWildcardOverlapOut.sequenced.some((s: any) => s?.issue === 209 && s?.files?.includes('newmod/')),
  sequencedWildcardOverlap.out,
);

// AC4 (round 3 of #41): a new-directory wildcard under an *existing* tracked
// directory still has to overlap the existing directory's own wildcard —
// round 2 wired `selfNewPrefixes`/`otherNewPrefixes` only to the
// prefix-vs-prefix (`newPathsOverlap`) comparison, not to the
// prefix-vs-full-glob-list (`matchesAny`) comparison `newLiteralPaths`
// already gets. `tests/**` (matched: `tests/smoke.mts` etc. are tracked) is
// not itself "new", so it never lands in `otherNewPrefixes`/`selfNewPrefixes`
// — but `tests/newsub/**` (new: `tests/newsub/` is untracked) still falls
// entirely under it. Direction A: self is the matched `tests/**`, the other
// issue is the new `tests/newsub/**`.
const matchedVsNewSubMilestone = milestoneFile([{ number: 210, labels: ['state:ready'], body: '## Files\n- `tests/newsub/**`\n' }]);
const matchedVsNewSubOverlap = lint(1125, issueBody(), { milestone: matchedVsNewSubMilestone });
const matchedVsNewSubOverlapOut = parse(matchedVsNewSubOverlap.out);
check(
  'a matched wildcard overlaps another issue\'s new-directory wildcard nested under it, with ok: false',
  matchedVsNewSubOverlap.status === 1 && matchedVsNewSubOverlapOut?.ok === false,
  matchedVsNewSubOverlap.out,
);
check(
  'the matched-vs-new-subdirectory overlap carries { issue, files } naming the other issue and its new-directory prefix',
  Array.isArray(matchedVsNewSubOverlapOut?.failures) &&
    matchedVsNewSubOverlapOut.failures.some((f: any) => f?.issue === 210 && Array.isArray(f?.files) && f.files.includes('tests/newsub/')),
  matchedVsNewSubOverlap.out,
);

// Direction B: self is the new `tests/newsub/**`, the other issue is the
// matched `tests/**` — the parallel leg (`selfNewPrefixes` vs `otherGlobs`).
const newSubVsMatchedMilestone = milestoneFile([{ number: 211, labels: ['state:ready'], body: '## Files\n- `tests/**`\n' }]);
const newSubVsMatchedOverlap = lint(1126, issueBody({ files: '## Files\n- `tests/newsub/**`\n' }), { milestone: newSubVsMatchedMilestone });
const newSubVsMatchedOverlapOut = parse(newSubVsMatchedOverlap.out);
check(
  'a new-directory wildcard overlaps another issue\'s matched wildcard covering it, with ok: false',
  newSubVsMatchedOverlap.status === 1 && newSubVsMatchedOverlapOut?.ok === false,
  newSubVsMatchedOverlap.out,
);
check(
  'the new-subdirectory-vs-matched overlap carries { issue, files } naming the other issue and the new-directory prefix',
  Array.isArray(newSubVsMatchedOverlapOut?.failures) &&
    newSubVsMatchedOverlapOut.failures.some((f: any) => f?.issue === 211 && Array.isArray(f?.files) && f.files.includes('tests/newsub/')),
  newSubVsMatchedOverlap.out,
);

// AC3 (round 3 of #41): the matched-vs-new-subdirectory pair is not a
// failure when one issue is blocked by the other.
const sequencedMatchedVsNewSubMilestone = milestoneFile([{ number: 212, labels: ['state:ready'], body: '## Files\n- `tests/newsub/**`\n' }]);
const sequencedMatchedVsNewSubOverlap = lint(1127, issueBody({ deps: '## Dependencies\nBlocked by: #212\n' }), {
  milestone: sequencedMatchedVsNewSubMilestone,
});
const sequencedMatchedVsNewSubOverlapOut = parse(sequencedMatchedVsNewSubOverlap.out);
check(
  'a matched wildcard and a new-directory wildcard nested under it are not a failure when one is blocked by the other (sequenced)',
  sequencedMatchedVsNewSubOverlap.status === 0 && !(sequencedMatchedVsNewSubOverlapOut?.failures ?? []).some((f: any) => f?.issue === 212),
  sequencedMatchedVsNewSubOverlap.out,
);
check(
  'the sequenced matched-vs-new-subdirectory overlap is reported in sequenced: [{ issue, files }] instead of failures',
  Array.isArray(sequencedMatchedVsNewSubOverlapOut?.sequenced) &&
    sequencedMatchedVsNewSubOverlapOut.sequenced.some((s: any) => s?.issue === 212 && s?.files?.includes('tests/newsub/')),
  sequencedMatchedVsNewSubOverlap.out,
);

// --- `authorised:` grants on both sides of the graph (#232) ----------------
// The rest of #232 — how a grant is classified, and how it is rendered — is
// in tests/issue-lint.test.mts with the other single-body rules. These three
// are that block's own AC3: they assert on `failures[].issue` and
// `sequenced[].issue`, which is this file's subject. `GRANT_FILES` is one
// line of fixture, repeated rather than shared, because it is the input each
// half names for itself.
const GRANT_FILES = '## Files\n- `tests/**`\n- authorised: `scripts/reconcile.mts`\n';

// AC3: a granted file that another in-flight issue's bullet glob also covers
// is an overlap, and so is the reverse — this issue's glob against the other
// issue's grant. Both sides of the comparison read grants.
const grantVsGlobMilestone = milestoneFile([{ number: 243, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n' }]);
const grantVsGlob = lint(1240, issueBody({ files: GRANT_FILES }), { milestone: grantVsGlobMilestone });
const grantVsGlobOut = parse(grantVsGlob.out);
check("this issue's grant against another issue's glob is an overlap failure", grantVsGlob.status === 1 && (grantVsGlobOut?.failures ?? []).some((f: any) => f?.issue === 243 && f?.files?.includes('scripts/reconcile.mts')), grantVsGlob.out);

const globVsGrantMilestone = milestoneFile([{ number: 244, labels: ['state:in-progress'], body: '## Files\n- `tests/other.test.mts`\n- authorised: `scripts/reconcile.mts`\n' }]);
const globVsGrant = lint(1241, issueBody({ files: '## Files\n- `scripts/reconcile.mts`\n' }), { milestone: globVsGrantMilestone });
const globVsGrantOut = parse(globVsGrant.out);
check("another issue's grant against this issue's glob is an overlap failure too", globVsGrant.status === 1 && (globVsGrantOut?.failures ?? []).some((f: any) => f?.issue === 244 && f?.files?.includes('scripts/reconcile.mts')), globVsGrant.out);

const sequencedGrantMilestone = milestoneFile([{ number: 245, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n' }]);
const sequencedGrant = lint(1242, issueBody({ files: GRANT_FILES, deps: '## Dependencies\nBlocked by: #245\n' }), { milestone: sequencedGrantMilestone });
const sequencedGrantOut = parse(sequencedGrant.out);
check('a grant overlap is sequenced, not a failure, when a Blocked by: orders the two', sequencedGrant.status === 0 && sequencedGrantOut?.ok === true && (sequencedGrantOut?.sequenced ?? []).some((s: any) => s?.issue === 245 && s?.files?.includes('scripts/reconcile.mts')), sequencedGrant.out);

// --- #299: what a run that could not look reports, and how far the
// `Blocked by:` graph is scanned ---------------------------------------------
// Written for #299 into tests/issue-lint.test.mts, whose `## Files` named
// that file and `ci/issue-lint.mts` alone, and moved here unchanged by #338.
// What a run *without* that list cannot do, and how far the graph is scanned
// when it has one, are both decided by reading more than one issue, so they
// belong on this side of the boundary the two headers draw.

// AC1: the same issue body, run twice. With the list, the overlap against
// the sibling in flight is a failure. Without it, the run never sees the
// sibling — and says so, instead of reporting the disjointness check as
// passed. On the base the second run prints `ok: true` and no
// `disjointness` key at all, so these cases are red there on behaviour.
const unseenSiblingMilestone = milestoneFile([{ number: 2991, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n' }]);
const overlapSeen = lint(2990, issueBody(), { milestone: unseenSiblingMilestone });
const overlapSeenOut = parse(overlapSeen.out);
check(
  'with --milestone-issues-file the overlap against the sibling in flight is a failure',
  overlapSeen.status === 1 && overlapSeenOut?.ok === false && (overlapSeenOut?.failures ?? []).some((f: any) => f?.issue === 2991),
  overlapSeen.out,
);
check('a run that had the list reports the disjointness check as run', overlapSeenOut?.disjointness?.checked === true, overlapSeen.out);
check('a run that had the list reports how many issues in flight it compared against', overlapSeenOut?.disjointness?.compared === 1, overlapSeen.out);
check('a run that had the list carries no not-run reason', overlapSeenOut?.disjointness?.reason === null, overlapSeen.out);

const overlapUnseen = lint(2990, issueBody());
const overlapUnseenOut = parse(overlapUnseen.out);
check(
  'the same body with no --milestone-issues-file reports the disjointness check as not run',
  overlapUnseenOut?.disjointness?.checked === false,
  overlapUnseen.out,
);
check(
  'the not-run report names the missing --milestone-issues-file as the reason',
  typeof overlapUnseenOut?.disjointness?.reason === 'string' && overlapUnseenOut.disjointness.reason.includes('--milestone-issues-file'),
  overlapUnseen.out,
);
check('a run that could not check disjointness compared against nothing', overlapUnseenOut?.disjointness?.compared === 0, overlapUnseen.out);
// The verdict itself is deliberately left alone: a run that could not look
// found nothing, and `ok: false` here would refuse a caller over a check
// that never ran. Since #338 this is the only way to reach that branch — a
// run that fetches the issues itself gathers every open one and always
// checks, whether or not the issue carries a milestone — so what it refuses
// is a caller passing `--issue-body-file` without the list, which is the
// workflow's own shape. The reader is told in the report instead, which is
// what this case pins.
check(
  'a run that could not check disjointness still exits 0 with ok: true — it found nothing, it only could not look',
  overlapUnseen.status === 0 && overlapUnseenOut?.ok === true,
  overlapUnseen.out,
);

const notRunMd = lint(2990, issueBody(), { markdown: true });
check(
  '--markdown does not report a run that could not check disjointness as a plain PASS',
  /issue-lint for #2990: PASS \(disjointness not checked\)/.test(notRunMd.out),
  notRunMd.out,
);
check('--markdown carries a Disjointness not checked section naming the reason', /\*\*Disjointness not checked\*\*/.test(notRunMd.out) && /--milestone-issues-file/.test(notRunMd.out), notRunMd.out);
// The missing list takes two checks away, not one: the `Blocked by:` graph
// such a run builds holds the linted issue alone, so the cycle scan is as
// blind as the glob comparison. The key is named for the check an
// orchestrator acts on; the section says the rest.
check(
  '--markdown says the Blocked-by cycle scan was equally blind, not just the glob comparison',
  /cycle scan/i.test(notRunMd.out),
  notRunMd.out,
);

// `checked: true, compared: 0` is an answer, not a blind spot — the list was
// read and held no issue in flight with a scope of its own. A plain PASS
// renders it identically to a run that compared against a dozen, which is
// the distinction `compared` exists to make, so the Markdown makes it too.
const nothingToCompareMd = lint(2992, issueBody(), { markdown: true, milestone: milestoneFile([]) });
const nothingToCompareOut = parse(lint(2992, issueBody(), { milestone: milestoneFile([]) }).out);
check('an empty list is still a check that ran, against nothing', nothingToCompareOut?.disjointness?.checked === true && nothingToCompareOut?.disjointness?.compared === 0, JSON.stringify(nothingToCompareOut));
check(
  '--markdown does not render "held against nothing" as a plain PASS',
  /issue-lint for #2992: PASS$/m.test(nothingToCompareMd.out) &&
    !/Disjointness not checked/.test(nothingToCompareMd.out) &&
    /\*\*Disjointness: nothing to compare\*\*/.test(nothingToCompareMd.out),
  nothingToCompareMd.out,
);

// A run that did compare against an issue in flight says nothing extra: the
// plain PASS is the whole report, as it was before #299.
const comparedMd = lint(2999, issueBody(), { markdown: true, milestone: milestoneFile([{ number: 29990, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n' }]) });
check(
  '--markdown reports a plain PASS, with no disjointness section, when the globs were held against an issue in flight',
  /issue-lint for #2999: PASS$/m.test(comparedMd.out) && !/Disjointness/.test(comparedMd.out),
  comparedMd.out,
);

// AC2: the chain's intermediate carries no `state:ready` label and no
// `## Files` section at all — it is in flight in no sense and declares no
// scope, and it is still the only thing that orders #2994 and #2995. An
// implementation that built the graph from the issues in flight, or from
// the ones with globs, would drop #2993 and report the overlap as a
// failure. Green on the base: the graph already spans every open issue the
// run was given. It is a pin on that span, not a fix — nothing in the
// suite held it before (#299).
const unlabelledIntermediateMilestone = milestoneFile([
  { number: 2993, labels: [], body: '## Dependencies\nBlocked by: #2995\n' },
  { number: 2995, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n\n## Dependencies\nBlocked by: none\n' },
]);
const throughUnlabelled = lint(2994, issueBody({ deps: '## Dependencies\nBlocked by: #2993\n' }), { milestone: unlabelledIntermediateMilestone });
const throughUnlabelledOut = parse(throughUnlabelled.out);
check(
  'a chain through an intermediate with no state: label and no ## Files still sequences the two ends',
  throughUnlabelled.status === 0 && throughUnlabelledOut?.ok === true,
  throughUnlabelled.out,
);
check(
  'the overlap ordered by that intermediate is reported in sequenced: [{ issue, files }]',
  (throughUnlabelledOut?.sequenced ?? []).some((s: any) => s?.issue === 2995 && s?.files?.includes('tests/smoke.mts')),
  throughUnlabelled.out,
);

// AC3: a cycle between two siblings this issue does not reach. Nothing
// overlaps here — #2996 and #2997 declare globs of their own and neither
// is reachable from #2998 — so the cycle is the only thing to report. On
// the base the walk starts at the linted issue and never touches them:
// `ok: true`, no mention of a cycle. Red there on behaviour.
const unreachableCycleMilestone = milestoneFile([
  { number: 2996, labels: ['state:ready'], body: '## Files\n- `scripts/reconcile.mts`\n\n## Dependencies\nBlocked by: #2997\n' },
  { number: 2997, labels: ['state:ready'], body: '## Files\n- `docs/**`\n\n## Dependencies\nBlocked by: #2996\n' },
]);
const unreachableCycle = lint(2998, issueBody(), { milestone: unreachableCycleMilestone });
const unreachableCycleOut = parse(unreachableCycle.out);
check(
  'a cycle among issues this one does not reach fails the lint with ok: false',
  unreachableCycle.status === 1 && unreachableCycleOut?.ok === false,
  unreachableCycle.out,
);
check(
  'the unreachable cycle names every issue in it',
  (unreachableCycleOut?.failures ?? []).some((f: any) => typeof f === 'string' && /cycle/i.test(f) && f.includes('#2996') && f.includes('#2997')),
  unreachableCycle.out,
);
check(
  'the unreachable cycle is worded as one this issue is not part of',
  (unreachableCycleOut?.failures ?? []).some((f: any) => typeof f === 'string' && /cycle/i.test(f) && /not in it|not part of/.test(f)),
  unreachableCycle.out,
);
check(
  'the unreachable cycle is reported once, not once per issue that reaches it',
  (unreachableCycleOut?.failures ?? []).filter((f: any) => typeof f === 'string' && /cycle/i.test(f)).length === 1,
  unreachableCycle.out,
);

// --- #338: the candidate set is every open issue, whatever its milestone ----
// The defect these cases close: the comparison was made against
// `gh issue list --milestone <title> --state open`, so two issues editing one
// file collided in silence whenever they were filed under different
// milestones, and an issue carrying no milestone was invisible on both sides
// of it. A merge conflict does not read the milestone field.
//
// They are the only cases in the suite that let the script gather the other
// issues itself, and they have to be: a `--milestone-issues-file` fixture is
// a list of `{ number, labels, body }` with no milestone in it, so nothing
// passed through that flag can tell the old scope from the new one. The fake
// `gh` below honours `--milestone` the way the real one does — filtering the
// list when the flag is present — so the base and this change diverge on
// exactly the call the script makes. It is written here rather than added to
// tests/lib/issue-lint-harness.mts (whose fake answers AC5's
// `issue view <n> --json number` and nothing else) because #338's `## Files`
// does not include that file.
const GH_MODE_FAKE = `import { appendFileSync, readFileSync } from 'node:fs';
const argv = process.argv.slice(2);
const log = process.env.FAKE_GH_ARGV_LOG;
if (log) appendFileSync(log, JSON.stringify(argv) + '\\n');
const issues = JSON.parse(readFileSync(process.env.FAKE_GH_ISSUES, 'utf8'));
const flag = (name) => {
  const i = argv.indexOf('--' + name);
  return i === -1 ? null : argv[i + 1];
};
if (argv[0] === 'issue' && argv[1] === 'view') {
  const found = issues.find((issue) => issue.number === Number(argv[2]));
  if (!found) {
    console.error('fake-gh: no issue #' + argv[2]);
    process.exit(1);
  }
  const out = {};
  for (const field of (flag('json') || '').split(',')) {
    if (field === 'number') out.number = found.number;
    if (field === 'body') out.body = found.body || '';
    if (field === 'milestone') out.milestone = found.milestone || null;
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}
if (argv[0] === 'issue' && argv[1] === 'list') {
  const milestone = flag('milestone');
  const listed = issues.filter((issue) => milestone === null || (issue.milestone && issue.milestone.title) === milestone);
  console.log(JSON.stringify(listed.map((issue) => ({ number: issue.number, labels: issue.labels || [], body: issue.body || '' }))));
  process.exit(0);
}
console.error('fake-gh: unexpected args: ' + argv.join(' '));
process.exit(1);
`;

const ghModeDir = mkdtempSync(join(tmpdir(), 'agentic-issuelint-ghmode-'));
cleanup(() => rmSync(ghModeDir, { recursive: true, force: true }));
const ghModeFake = join(ghModeDir, 'fake-gh.mjs');
writeFileSync(ghModeFake, GH_MODE_FAKE);
// A `gh` on PATH that is a shell wrapper around the module above: the file
// has to be called `gh`, and an extensionless Node file is read as CommonJS.
writeFileSync(join(ghModeDir, 'gh'), `#!/usr/bin/env bash\nexec "${RUNTIME}" "${ghModeFake}" "$@"\n`);
chmodSync(join(ghModeDir, 'gh'), 0o755);

type GhIssue = { number: number; labels?: Array<{ name: string }>; body?: string; milestone?: { title: string } | null };

/** Spawns the lint in its `gh` mode — positional `<n>`, no `--issue-body-file`
 * — against `issues` as the repository's open issues, and returns the run plus
 * every argv the fake `gh` was called with. */
function ghLint(n: number, issues: GhIssue[], opts: { markdown?: boolean } = {}) {
  const fixture = join(ghModeDir, `issues-${n}.json`);
  const argvLog = join(ghModeDir, `argv-${n}.log`);
  writeFileSync(fixture, JSON.stringify(issues));
  writeFileSync(argvLog, '');
  const run = ci('issue-lint.mts', opts.markdown ? [String(n), '--markdown'] : [String(n)], {
    cwd: repo,
    env: { PATH: `${ghModeDir}:${process.env.PATH ?? ''}`, FAKE_GH_ISSUES: fixture, FAKE_GH_ARGV_LOG: argvLog },
  });
  const argv = readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { ...run, argv };
}

// AC1: the overlap the dogfood run of 2026-09-18 did not see. #5002 is
// `state:ready`, declares a file this issue's `tests/**` covers, and is filed
// under another milestone — which is the whole of what hid it. On the base
// the list call carries `--milestone M-A`, #5002 is not in the answer, and
// the run reports `ok: true`.
const crossMilestone = ghLint(5001, [
  { number: 5001, labels: [{ name: 'state:in-progress' }], body: issueBody(), milestone: { title: 'M-A' } },
  { number: 5002, labels: [{ name: 'state:ready' }], body: '## Files\n- `tests/smoke.mts`\n', milestone: { title: 'M-B' } },
]);
const crossMilestoneOut = parse(crossMilestone.out);
check(
  'an overlap with an in-flight issue of another milestone is a failure',
  crossMilestone.status === 1 &&
    crossMilestoneOut?.ok === false &&
    (crossMilestoneOut?.failures ?? []).some((f: any) => f?.issue === 5002 && f?.files?.includes('tests/smoke.mts')),
  crossMilestone.out,
);
check(
  'the cross-milestone sibling is counted among the issues compared against',
  crossMilestoneOut?.disjointness?.checked === true && crossMilestoneOut?.disjointness?.compared === 1,
  crossMilestone.out,
);
// The candidate set itself, as the call that gathers it: `--state open` with
// no `--milestone` narrowing it. Written out here rather than read back from
// the script, which is the whole point of a pin (invariant 10).
const listCalls = crossMilestone.argv.filter((a) => a[0] === 'issue' && a[1] === 'list');
check(
  'the run lists every open issue, with no --milestone narrowing the candidate set',
  listCalls.length === 1 && listCalls[0].includes('--state') && listCalls[0].includes('open') && !listCalls[0].includes('--milestone'),
  JSON.stringify(crossMilestone.argv),
);

// AC3: the sequencing exception reaches across milestones too. Same pair as
// above, plus the `Blocked by:` edge — the overlap is accepted and reported
// as `sequenced`. On the base the pair is invisible, so `sequenced` is empty
// and this is red on the entry, not on the verdict.
const crossSequenced = ghLint(5003, [
  {
    number: 5003,
    labels: [{ name: 'state:in-progress' }],
    body: issueBody({ deps: '## Dependencies\nBlocked by: #5004\n' }),
    milestone: { title: 'M-A' },
  },
  { number: 5004, labels: [{ name: 'state:ready' }], body: '## Files\n- `tests/smoke.mts`\n\n## Dependencies\nBlocked by: none\n', milestone: { title: 'M-B' } },
]);
const crossSequencedOut = parse(crossSequenced.out);
check(
  'a cross-milestone overlap ordered by Blocked by: is sequenced, not a failure',
  crossSequenced.status === 0 &&
    crossSequencedOut?.ok === true &&
    (crossSequencedOut?.sequenced ?? []).some((s: any) => s?.issue === 5004 && s?.files?.includes('tests/smoke.mts')),
  crossSequenced.out,
);

// AC2, the linted side: an issue carrying no milestone. On the base there was
// no list to fetch at all — `others` stayed empty and the run reported
// `checked: false` — so the overlap with #5006 went unseen.
const noMilestoneSelf = ghLint(5005, [
  { number: 5005, labels: [{ name: 'state:in-progress' }], body: issueBody(), milestone: null },
  { number: 5006, labels: [{ name: 'state:ready' }], body: '## Files\n- `tests/smoke.mts`\n', milestone: { title: 'M-A' } },
]);
const noMilestoneSelfOut = parse(noMilestoneSelf.out);
check(
  'an issue carrying no milestone is compared against the issues in flight',
  noMilestoneSelfOut?.disjointness?.checked === true && noMilestoneSelfOut?.disjointness?.compared === 1,
  noMilestoneSelf.out,
);
check(
  "a milestone-less issue's overlap is a failure like any other",
  noMilestoneSelf.status === 1 &&
    noMilestoneSelfOut?.ok === false &&
    (noMilestoneSelfOut?.failures ?? []).some((f: any) => f?.issue === 5006 && f?.files?.includes('tests/smoke.mts')),
  noMilestoneSelf.out,
);

// The same issue with no milestone and no overlap: a plain PASS. The base
// renders "PASS (disjointness not checked)" here, because carrying no
// milestone was one of the two ways to reach that heading; since #338 the
// only way left is `--issue-body-file` without `--milestone-issues-file`.
const noMilestoneMd = ghLint(
  5007,
  [
    { number: 5007, labels: [{ name: 'state:in-progress' }], body: issueBody({ files: '## Files\n- `scripts/reconcile.mts`\n' }), milestone: null },
    { number: 5008, labels: [{ name: 'state:ready' }], body: '## Files\n- `tests/smoke.mts`\n', milestone: { title: 'M-A' } },
  ],
  { markdown: true },
);
check(
  'a milestone-less issue with no overlap renders a plain PASS, not "disjointness not checked"',
  /issue-lint for #5007: PASS$/m.test(noMilestoneMd.out) && !/Disjointness not checked/.test(noMilestoneMd.out),
  noMilestoneMd.out,
);

// AC2, the other side: a sibling in flight that carries no milestone. On the
// base `gh issue list --milestone M-A` never returns it, whatever it claims.
const noMilestoneSibling = ghLint(5009, [
  { number: 5009, labels: [{ name: 'state:in-progress' }], body: issueBody(), milestone: { title: 'M-A' } },
  { number: 5010, labels: [{ name: 'state:ready' }], body: '## Files\n- `tests/smoke.mts`\n', milestone: null },
]);
const noMilestoneSiblingOut = parse(noMilestoneSibling.out);
check(
  'an in-flight issue carrying no milestone is compared too',
  noMilestoneSibling.status === 1 &&
    noMilestoneSiblingOut?.ok === false &&
    (noMilestoneSiblingOut?.failures ?? []).some((f: any) => f?.issue === 5010 && f?.files?.includes('tests/smoke.mts')),
  noMilestoneSibling.out,
);

// The `Blocked by:` graph widens with the candidate set — it has to, or the
// sequencing exception above could not reach across a milestone — and the
// cycle scan reads that same graph. So a cycle between two issues of another
// milestone is reported now, worded as one this issue is not part of. Stated
// as a consequence of the widening rather than as a goal of it, and pinned
// here so it is a decision rather than a surprise.
const crossMilestoneCycle = ghLint(5013, [
  { number: 5013, labels: [{ name: 'state:in-progress' }], body: issueBody(), milestone: { title: 'M-A' } },
  { number: 5014, labels: [{ name: 'state:ready' }], body: '## Files\n- `scripts/reconcile.mts`\n\n## Dependencies\nBlocked by: #5015\n', milestone: { title: 'M-B' } },
  { number: 5015, labels: [{ name: 'state:ready' }], body: '## Files\n- `docs/**`\n\n## Dependencies\nBlocked by: #5014\n', milestone: { title: 'M-B' } },
]);
const crossMilestoneCycleOut = parse(crossMilestoneCycle.out);
check(
  'a Blocked by: cycle among issues of another milestone is reported',
  crossMilestoneCycle.status === 1 &&
    crossMilestoneCycleOut?.ok === false &&
    (crossMilestoneCycleOut?.failures ?? []).some((f: any) => typeof f === 'string' && /cycle/i.test(f) && f.includes('#5014') && f.includes('#5015')),
  crossMilestoneCycle.out,
);

// A guard, not a red: widening the candidate set must not widen the label
// filter with it. #5012 shares the file and the repository, and is
// `state:done` — not in flight — so it is still no overlap, and the run has
// nothing to compare. Green on the base as well (there it is not even in the
// list), which is what makes it a guard on this change rather than a pin of
// it.
const doneSibling = ghLint(5011, [
  { number: 5011, labels: [{ name: 'state:in-progress' }], body: issueBody(), milestone: { title: 'M-A' } },
  { number: 5012, labels: [{ name: 'state:done' }], body: '## Files\n- `tests/smoke.mts`\n', milestone: { title: 'M-B' } },
]);
const doneSiblingOut = parse(doneSibling.out);
check(
  'an issue of another milestone that is not in flight is still not compared',
  doneSibling.status === 0 && doneSiblingOut?.ok === true && doneSiblingOut?.disjointness?.compared === 0,
  doneSibling.out,
);

finish();
