#!/usr/bin/env node
// Cases for ci/issue-lint.mts: it validates an issue's contract (sections,
// globs, disjointness against issues in flight, entry-point references,
// Blocked-by numbers) against a real temporary git repository, with a fake
// `gh` on PATH for AC5 (the only check that always shells out, in both
// modes). Everything else runs through --issue-body-file /
// --milestone-issues-file, so no other `gh` call is needed.
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, ci, cleanup, commit, finish, tempRepo } from './lib/harness.mts';

// --- a fake `gh` on PATH, for AC5 only: `gh issue view <n> --json number` -
// succeeds for any number except 999 (simulates "issue does not exist"). --
const FAKE_GH = `#!/usr/bin/env bash
if [ "\${1:-}" = "issue" ] && [ "\${2:-}" = "view" ]; then
  n="\${3:-}"
  if [ "$n" = "999" ]; then
    echo "gh: issue #999 not found" >&2
    exit 1
  fi
  echo "{\\"number\\": $n}"
  exit 0
fi
echo "fake-gh: unexpected args: $*" >&2
exit 1
`;
const fakeGhDir = mkdtempSync(join(tmpdir(), 'agentic-issuelint-fakegh-'));
cleanup(() => rmSync(fakeGhDir, { recursive: true, force: true }));
writeFileSync(join(fakeGhDir, 'gh'), FAKE_GH);
chmodSync(join(fakeGhDir, 'gh'), 0o755);
const PATH_WITH_FAKE_GH = `${fakeGhDir}:${process.env.PATH ?? ''}`;

// --- a real repo with tracked files the globs and the reference check
// exercise for real --------------------------------------------------------
const repo = tempRepo();
commit(repo, {
  'package.json': '{"name":"x"}\n',
  'tests/smoke.mts': 'export {};\n',
  'tests/other.test.mts': 'export {};\n',
  'scripts/reconcile.mts': 'export {};\n',
  '.github/workflows/test.yml': 'name: test\non: push\njobs:\n  test:\n    steps:\n      - run: node tests/smoke.mts\n',
}, 'chore: base');

// --- issue body builder: six valid sections by default, one override at a
// time so each case isolates exactly one failure ---------------------------
type Parts = { context: string; goal: string; ac: string; proof: string; files: string; deps: string };
const DEFAULT_PARTS: Parts = {
  context: '## Context\nSome context.\n',
  goal: '## Goal\nDo the thing.\n',
  ac: '## Acceptance criteria\n- [ ] AC1 does the thing\n',
  proof: '## Proof\nnpm test covers it.\n',
  files: '## Files\n- `tests/**`\n',
  deps: '## Dependencies\nBlocked by: none\n',
};
function issueBody(overrides: Partial<Record<keyof Parts, string | null>> = {}): string {
  const keys: (keyof Parts)[] = ['context', 'goal', 'ac', 'proof', 'files', 'deps'];
  const parts = keys
    .map((k) => (k in overrides ? overrides[k] : DEFAULT_PARTS[k]))
    .filter((v): v is string => v !== null);
  return parts.join('\n');
}

let seq = 0;
function bodyFile(body: string): string {
  const p = join(repo, `issue-body-${seq++}.md`);
  writeFileSync(p, body);
  return p;
}
function milestoneFile(issues: Array<{ number: number; labels: string[]; body: string }>): string {
  const p = join(repo, `milestone-${seq++}.json`);
  writeFileSync(p, JSON.stringify(issues));
  return p;
}

function lint(n: number, body: string, opts: { milestone?: string; strict?: boolean; markdown?: boolean } = {}) {
  const args = ['--issue', String(n), '--issue-body-file', bodyFile(body)];
  if (opts.milestone) args.push('--milestone-issues-file', opts.milestone);
  if (opts.strict) args.push('--strict');
  if (opts.markdown) args.push('--markdown');
  return ci('issue-lint.mts', args, { cwd: repo, env: { PATH: PATH_WITH_FAKE_GH } });
}

function parse(out: string): any {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

// --- happy path -------------------------------------------------------------
const valid = lint(100, issueBody());
const validOut = parse(valid.out);
check('a fully valid issue exits 0', valid.status === 0, valid.out);
check('a fully valid issue reports ok: true', validOut?.ok === true, valid.out);
check('a fully valid issue reports no failures', Array.isArray(validOut?.failures) && validOut.failures.length === 0, valid.out);
check('output carries the issue number', validOut?.issue === 100, valid.out);

// --- negative control: every one of the cases below must fail before this
// script exists (npm test on the base with only this test file overlaid
// spawns `ci/issue-lint.mts`, which does not exist there, so every `ci()`
// call fails with a non-zero status/ENOENT) — nothing further to encode
// here; it is a property of the base commit, not of this file.

// --- AC1: missing sections --------------------------------------------------
const missingGoal = lint(101, issueBody({ goal: null }));
const missingGoalOut = parse(missingGoal.out);
check('missing ## Goal fails with ok: false', missingGoal.status === 1 && missingGoalOut?.ok === false, missingGoal.out);
check(
  'missing ## Goal names the section in failures[]',
  Array.isArray(missingGoalOut?.failures) && missingGoalOut.failures.some((f: any) => typeof f === 'string' && /## Goal/.test(f)),
  missingGoal.out,
);

const missingContext = lint(102, issueBody({ context: null }));
check('missing ## Context fails and names it', missingContext.status === 1 && /## Context/.test(missingContext.out), missingContext.out);

const emptyProof = lint(103, issueBody({ proof: '## Proof\n' }));
check('an empty ## Proof section fails and names it', emptyProof.status === 1 && /## Proof/.test(emptyProof.out), emptyProof.out);

const noCheckbox = lint(104, issueBody({ ac: '## Acceptance criteria\nJust prose, no checkbox.\n' }));
check('## Acceptance criteria with no "- [ ]" item fails', noCheckbox.status === 1 && /Acceptance criteria/.test(noCheckbox.out), noCheckbox.out);

const noFilesBullet = lint(105, issueBody({ files: '## Files\nProse only, no bullet.\n' }));
check('## Files with no bullet glob fails', noFilesBullet.status === 1 && /Files/.test(noFilesBullet.out), noFilesBullet.out);

const noBlockedByLine = lint(106, issueBody({ deps: '## Dependencies\nnothing here\n' }));
check('## Dependencies with no "Blocked by:" line fails', noBlockedByLine.status === 1 && /Blocked by/.test(noBlockedByLine.out), noBlockedByLine.out);

// --- AC2: globs must parse and match something -----------------------------
const newFile = lint(107, issueBody({ files: '## Files\n- `tests/newfile.mts`\n' }));
const newFileOut = parse(newFile.out);
check('a glob matching no tracked file, but whose parent dir exists, passes ("new")', newFile.status === 0, newFile.out);
check(
  'the "new" glob is reported in globs: [{ glob, status: "new" }]',
  Array.isArray(newFileOut?.globs) && newFileOut.globs.some((g: any) => g.glob === 'tests/newfile.mts' && g.status === 'new'),
  newFile.out,
);

const matchedGlob = lint(1070, issueBody());
const matchedGlobOut = parse(matchedGlob.out);
check(
  'a glob matching tracked files is reported in globs: [{ glob, status: "matched", matches }]',
  Array.isArray(matchedGlobOut?.globs) && matchedGlobOut.globs.some((g: any) => g.glob === 'tests/**' && g.status === 'matched' && g.matches >= 1),
  matchedGlob.out,
);

// AC1: a literal path (no `*`/`**`) in a directory that does not exist yet
// on disk is still "new", not a failure — the issue creates the directory.
const literalNewDir = lint(108, issueBody({ files: '## Files\n- `nonexistent-dir/file.ts`\n' }));
const literalNewDirOut = parse(literalNewDir.out);
check(
  'a literal path with no existing parent directory passes ("new"), not a failure',
  literalNewDir.status === 0 && literalNewDirOut?.ok === true,
  literalNewDir.out,
);
check(
  'the literal new path is reported in globs: [{ glob, status: "new" }]',
  Array.isArray(literalNewDirOut?.globs) &&
    literalNewDirOut.globs.some((g: any) => g.glob === 'nonexistent-dir/file.ts' && g.status === 'new'),
  literalNewDir.out,
);

// AC2 (of #41): a wildcard glob whose *fixed prefix directory already
// exists* in the tracked tree, but nothing under it matches, is still a
// failure — `tests/` is tracked (tests/smoke.mts, tests/other.test.mts) but
// nothing under it matches `*.zig`.
const wildcardNoMatch = lint(1081, issueBody({ files: '## Files\n- `tests/*.zig`\n' }));
const wildcardNoMatchOut = parse(wildcardNoMatch.out);
check(
  'a wildcard glob whose prefix directory exists but matches nothing fails with ok: false',
  wildcardNoMatch.status === 1 && wildcardNoMatchOut?.ok === false,
  wildcardNoMatch.out,
);
check(
  'the wildcard failure uses the "wildcard glob matches no tracked file" wording and names the glob',
  Array.isArray(wildcardNoMatchOut?.failures) &&
    wildcardNoMatchOut.failures.some((f: any) => typeof f === 'string' && f === 'wildcard glob matches no tracked file: tests/*.zig'),
  wildcardNoMatch.out,
);
check(
  'the old "no existing parent directory" wording is gone',
  !/no existing parent directory/.test(wildcardNoMatch.out),
  wildcardNoMatch.out,
);

// AC1 (of #41): a wildcard glob whose fixed prefix (the part before the
// first `*`) names a directory that does not exist anywhere in the tracked
// tree is "new", not a failure — the natural way to declare a whole new
// directory with more than one file (unlike a single literal new path,
// already covered above).
const newDirWildcard = lint(1082, issueBody({ files: '## Files\n- `newmod/**`\n' }));
const newDirWildcardOut = parse(newDirWildcard.out);
check(
  'a wildcard glob whose prefix directory does not exist passes ("new"), not a failure',
  newDirWildcard.status === 0 && newDirWildcardOut?.ok === true,
  newDirWildcard.out,
);
check(
  'the new-directory wildcard is reported in globs: [{ glob, status: "new" }]',
  Array.isArray(newDirWildcardOut?.globs) && newDirWildcardOut.globs.some((g: any) => g.glob === 'newmod/**' && g.status === 'new'),
  newDirWildcard.out,
);

// AC1 (of #41), the literal shape from the issue: a wildcard glob naming a
// new subdirectory *under an existing tracked directory* — `tests/` is
// tracked, `tests/newmod/` is not — is still "new", not a failure. This is
// the actual discriminator against AC2 (`tests/*.zig`, where the prefix
// directory `tests/` exists and the wildcard matches within it): here the
// prefix directory `tests/newmod/` itself does not exist anywhere in the
// tracked tree, even though its parent does.
const newSubDirWildcard = lint(1084, issueBody({ files: '## Files\n- `tests/newmod/**`\n' }));
const newSubDirWildcardOut = parse(newSubDirWildcard.out);
check(
  'a wildcard glob naming a new subdirectory under an existing tracked directory passes ("new")',
  newSubDirWildcard.status === 0 && newSubDirWildcardOut?.ok === true,
  newSubDirWildcard.out,
);
check(
  'the new-subdirectory wildcard is reported in globs: [{ glob, status: "new" }]',
  Array.isArray(newSubDirWildcardOut?.globs) &&
    newSubDirWildcardOut.globs.some((g: any) => g.glob === 'tests/newmod/**' && g.status === 'new'),
  newSubDirWildcard.out,
);

// AC3 (of #41): a wildcard glob with no fixed prefix at all (it starts with
// `*`) that matches nothing is still a failure — there is no directory to
// call "new".
const noPrefixWildcard = lint(1083, issueBody({ files: '## Files\n- `**/*.foo`\n' }));
const noPrefixWildcardOut = parse(noPrefixWildcard.out);
check(
  'a wildcard glob with no fixed prefix that matches nothing fails with ok: false',
  noPrefixWildcard.status === 1 && noPrefixWildcardOut?.ok === false,
  noPrefixWildcard.out,
);
check(
  'the no-fixed-prefix failure uses the "wildcard glob matches no tracked file" wording',
  Array.isArray(noPrefixWildcardOut?.failures) &&
    noPrefixWildcardOut.failures.some((f: any) => typeof f === 'string' && f === 'wildcard glob matches no tracked file: **/*.foo'),
  noPrefixWildcard.out,
);

// AC2: a glob that does not parse (a leading unescaped `?` has nothing to
// repeat — `new RegExp` throws) fails, distinctly from "no match".
const badGlob = lint(1080, issueBody({ files: '## Files\n- `?abc`\n' }));
const badGlobOut = parse(badGlob.out);
check('a glob that does not parse fails with ok: false', badGlob.status === 1 && badGlobOut?.ok === false, badGlob.out);
check(
  'the parse failure names the glob in failures[]',
  Array.isArray(badGlobOut?.failures) && badGlobOut.failures.some((f: any) => typeof f === 'string' && f.includes('?abc')),
  badGlob.out,
);

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

// --- AC4: entry-point references (the #3 shape) -----------------------------
// tests/** covers tests/smoke.mts, which .github/workflows/test.yml
// references by path — the check that would have caught #3.
const withReference = lint(113, issueBody());
const withReferenceOut = parse(withReference.out);
check('a covered file referenced by an uncovered file produces a warning, not a failure', withReference.status === 0, withReference.out);
check(
  'the warning carries { file, referencedBy } naming the covered file and the workflow that references it',
  Array.isArray(withReferenceOut?.warnings) &&
    withReferenceOut.warnings.some((w: any) => w.file === 'tests/smoke.mts' && w.referencedBy === '.github/workflows/test.yml'),
  withReference.out,
);

// AC3/AC4 (of #37): a *new* literal path is checked for entry-point
// references too, the same as a matched tracked file — its basename
// ("smoke.mts") is already referenced (as a substring of "tests/smoke.mts")
// by .github/workflows/test.yml, so declaring a new file with that same
// basename still produces a warning, not a failure.
const newPathReference = lint(1130, issueBody({ files: '## Files\n- `other/smoke.mts`\n' }));
const newPathReferenceOut = parse(newPathReference.out);
check(
  'a new literal path referenced (by basename) by an uncovered file passes with ok: true',
  newPathReference.status === 0 && newPathReferenceOut?.ok === true,
  newPathReference.out,
);
check(
  'the warning names the new path and the file that references its basename',
  Array.isArray(newPathReferenceOut?.warnings) &&
    newPathReferenceOut.warnings.some((w: any) => w.file === 'other/smoke.mts' && w.referencedBy === '.github/workflows/test.yml'),
  newPathReference.out,
);

const strictReference = lint(114, issueBody(), { strict: true });
const strictReferenceOut = parse(strictReference.out);
check(
  '--strict turns the AC4 warning into ok: false without moving it into failures[]',
  strictReference.status === 1 &&
    strictReferenceOut?.ok === false &&
    Array.isArray(strictReferenceOut?.warnings) &&
    strictReferenceOut.warnings.length > 0 &&
    Array.isArray(strictReferenceOut?.failures) &&
    strictReferenceOut.failures.length === 0,
  strictReference.out,
);

// --- AC5: Blocked-by numbers must exist -------------------------------------
const validBlocker = lint(115, issueBody({ deps: '## Dependencies\nBlocked by: #5\n' }));
check('a Blocked-by number that gh can find does not fail', validBlocker.status === 0, validBlocker.out);

const invalidBlocker = lint(116, issueBody({ deps: '## Dependencies\nBlocked by: #999\n' }));
const invalidBlockerOut = parse(invalidBlocker.out);
check(
  'a Blocked-by number that gh cannot find fails with ok: false',
  invalidBlocker.status === 1 && invalidBlockerOut?.ok === false,
  invalidBlocker.out,
);
check(
  'the missing-blocker failure names #999 in failures[]',
  Array.isArray(invalidBlockerOut?.failures) && invalidBlockerOut.failures.some((f: any) => typeof f === 'string' && f.includes('#999')),
  invalidBlocker.out,
);

const noneBlocker = lint(117, issueBody({ deps: '## Dependencies\nBlocked by: none\n' }));
check('"Blocked by: none" needs no gh lookup and passes', noneBlocker.status === 0, noneBlocker.out);

// A bare number ("Blocked by: 32", no `#`) is accepted the same as "#32".
const bareBlocker = lint(1170, issueBody({ deps: '## Dependencies\nBlocked by: 5\n' }));
check('"Blocked by: 5" (no #) is read as a real blocker and passes when gh finds it', bareBlocker.status === 0, bareBlocker.out);
const bareBlockerMissing = lint(1171, issueBody({ deps: '## Dependencies\nBlocked by: 999\n' }));
const bareBlockerMissingOut = parse(bareBlockerMissing.out);
check(
  '"Blocked by: 999" (no #) is still checked against gh and fails when not found',
  bareBlockerMissing.status === 1 &&
    bareBlockerMissingOut?.ok === false &&
    bareBlockerMissingOut.failures.some((f: any) => typeof f === 'string' && f.includes('999')),
  bareBlockerMissing.out,
);

// --- AC6: output shape, --markdown, and the { error } path ------------------
check('a failing issue exits 1 with ok: false', missingGoal.status === 1 && missingGoalOut?.ok === false, missingGoal.out);
check('a passing issue exits 0 with ok: true', valid.status === 0 && validOut?.ok === true, valid.out);
check(
  'the JSON result carries every required key',
  typeof validOut?.issue === 'number' &&
    typeof validOut?.ok === 'boolean' &&
    Array.isArray(validOut?.failures) &&
    Array.isArray(validOut?.warnings) &&
    Array.isArray(validOut?.globs) &&
    Array.isArray(validOut?.sequenced),
  valid.out,
);

const md = lint(118, issueBody({ goal: null }), { markdown: true });
check('--markdown starts with the marker the workflow comment step greps for', md.out.startsWith('<!-- agentic-issue-lint -->'), md.out);
check('--markdown output reports FAIL and names the failing section', /issue-lint for #118: FAIL/.test(md.out) && /## Goal/.test(md.out), md.out);

const mdOk = lint(1180, issueBody(), { markdown: true });
check('--markdown reports PASS for a passing issue', /issue-lint for #1180: PASS/.test(mdOk.out), mdOk.out);

// { error }: no issue number at all (neither positional nor --issue).
const noNumber = ci('issue-lint.mts', [], { cwd: repo, env: { PATH: PATH_WITH_FAKE_GH } });
const noNumberOut = parse(noNumber.out);
check('no issue number given exits 1 with { error }', noNumber.status === 1 && typeof noNumberOut?.error === 'string', noNumber.out);

// { error }: an unparseable --milestone-issues-file.
const badMilestoneFile = join(repo, `bad-milestone-${seq++}.json`);
writeFileSync(badMilestoneFile, 'not valid json');
const badMilestone = lint(119, issueBody(), { milestone: badMilestoneFile });
const badMilestoneOut = parse(badMilestone.out);
check(
  'an unparseable --milestone-issues-file exits 1 with { error }, not a crash',
  badMilestone.status === 1 && typeof badMilestoneOut?.error === 'string',
  badMilestone.out,
);

// { error } + --markdown: the marker still leads, so the workflow's own
// comment is never orphaned without it on this path.
const badMilestoneMd = ci('issue-lint.mts', ['--issue', '120', '--issue-body-file', bodyFile(issueBody()), '--milestone-issues-file', badMilestoneFile, '--markdown'], {
  cwd: repo,
  env: { PATH: PATH_WITH_FAKE_GH },
});
check(
  'the { error } path still starts with the marker under --markdown',
  badMilestoneMd.status === 1 && badMilestoneMd.out.startsWith('<!-- agentic-issue-lint -->'),
  badMilestoneMd.out,
);

// AC4 (of #37): the real body of issue #31 (`gh issue view 31 --json body -q
// .body`), pasted verbatim, as it was when this issue was opened — "Blocked
// by: none" needs no `gh` call. Its four globs: scripts/claim.mts (new),
// scripts/lib/issues.mts (new, in a directory that does not exist in this
// temp repo), scripts/reconcile.mts (tracked, added to the base commit
// above), tests/claim.test.mts (new).
const ISSUE_31_BODY = `## Context
Step 3 of \`skills/orchestrate/SKILL.md\` is three commands the orchestrator types by hand for every issue: \`git push origin origin/main:refs/heads/<type>/<n>-<slug>\`, \`gh issue edit --add-assignee\`, \`gh issue edit\` for the labels. In M1 that was done fourteen times without error, but there is no reason to keep relying on that: the order matters (the push is the lock; labels only after it succeeds), the branch type must match the title, and a blocked or non-ready issue must not be claimed at all.

## Goal
\`node scripts/claim.mts <n> --slug <slug>\` is the only way an issue is claimed, and it refuses when the issue is not claimable.

## Acceptance criteria
- [ ] AC1 Reads the issue (\`gh issue view <n> --json number,title,body,labels,state,milestone\`) and refuses — \`{ "refused": "<reason>" }\`, exit 1, nothing changed — when: the issue is closed; it lacks \`state:ready\`; any \`Blocked by: #N\` issue is still open (reuse the parser \`scripts/reconcile.mts\` uses — extract it to \`scripts/lib/issues.mts\` if it is not already shared, and make \`reconcile.mts\` import it from there); it has no \`## Files\` bullet.
- [ ] AC2 \`<type>\` comes from the title prefix (\`feat(ci): …\` → \`feat\`, \`fix: …\` → \`fix\`; the set is \`feat|fix|refactor|chore|docs|test|ci|deps\`) or \`--type\`; \`--slug\` is required and must match \`/^[a-z0-9-]+$/\`. Branch = \`<type>/<n>-<slug>\`.
- [ ] AC3 \`git fetch origin\`, then \`git push origin origin/<default-branch>:refs/heads/<branch>\`. If the push fails because the ref already exists → \`{ "held": "<branch>" }\`, exit 2, no label change (another orchestrator holds it). Any other push failure → \`{ "error": "<git output>" }\`, exit 1.
- [ ] AC4 On success: \`gh issue edit <n> --add-assignee @me --add-label state:in-progress --remove-label state:ready\`; print \`{ "issue": <n>, "branch": "<branch>", "base": "<sha>" }\`, exit 0.
- [ ] AC5 The default branch is read from \`gh repo view --json defaultBranchRef\`, not assumed to be \`main\`.

## Proof
\`npm test\` — \`tests/claim.test.mts\` with a fake \`gh\` and a real temp repository with a bare \`origin\` (ref creation is real: assert the remote branch exists after a successful claim and that a second claim of the same issue exits 2 without touching labels — the fake \`gh\` logs its argv).
Negative control: every case fails on the base (the script does not exist).

## Files
- \`scripts/claim.mts\`
- \`scripts/lib/issues.mts\`
- \`scripts/reconcile.mts\`
- \`tests/claim.test.mts\`

## Dependencies
Blocked by: none
`;
const issue31 = lint(31, ISSUE_31_BODY);
const issue31Out = parse(issue31.out);
check("issue #31's real body lints ok: true", issue31.status === 0 && issue31Out?.ok === true, issue31.out);
check(
  'scripts/lib/issues.mts (new directory, no tracked file) is reported as new',
  Array.isArray(issue31Out?.globs) && issue31Out.globs.some((g: any) => g.glob === 'scripts/lib/issues.mts' && g.status === 'new'),
  issue31.out,
);
check(
  'scripts/reconcile.mts (tracked) is reported as matched',
  Array.isArray(issue31Out?.globs) && issue31Out.globs.some((g: any) => g.glob === 'scripts/reconcile.mts' && g.status === 'matched'),
  issue31.out,
);

finish();
