#!/usr/bin/env node
// Cases for the one thing `ci/issue-lint.mts` decides by reading more than
// one issue: the disjointness graph. Two issues in flight cannot claim the
// same file, unless a `Blocked by:` relation orders them — then the overlap
// is reported as `sequenced`, not as a failure. Split out of
// tests/issue-lint.test.mts (#352): everything the lint decides from a
// single body — sections, the `Declaration:` line, the glob classification,
// the grant rules, Blocked-by, the output shape — stayed there, and every
// case that compares this issue against the others in the milestone is
// here. The boundary is mechanical: every `milestoneFile(` call and every
// `lint(..., { milestone })` call in the suite is in this file.
//
// The fake `gh`, the throwaway repository whose tracked files the globs are
// classified against and the six-section body builder are shared with
// tests/issue-lint.test.mts through tests/lib/issue-lint-harness.mts, so
// both files spawn the real script against one set of fixtures (#229's
// reason, written in that file's header). The script itself is spawned, not
// imported (invariant 6).
//
// Negative control: there is no red for this file. It moves cases that
// already passed, against a `ci/issue-lint.mts` this pull request does not
// touch, so they pass on the base as well — which is what `test-only`
// means (docs/workflow.md).
import { check, finish } from './lib/harness.mts';
import { issueBody, lint, milestoneFile, parse } from './lib/issue-lint-harness.mts';

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

finish();
