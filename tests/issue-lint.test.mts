#!/usr/bin/env node
// Cases for ci/issue-lint.mts: it validates an issue's contract (sections,
// globs, the `authorised:` grants of `## Files` held to the same two rules
// as those globs, Blocked-by numbers) against
// a real temporary git repository, with a fake `gh` on PATH for AC5 (the
// only check that always shells out, in both modes). Everything else runs
// through --issue-body-file / --milestone-issues-file, so no other `gh`
// call is needed. There is no entry-point reference check any more (#62) —
// that mechanical form of the #3 guard moved to `scope`'s dangling-reference
// rule at PR time (#51), where a diff exists to check it against.
//
// Every rule here is one the lint decides by reading a single issue body.
// Disjointness against the issues in flight — the one rule that reads more
// than one — is tests/issue-lint-disjointness.test.mts (#352). The fake
// `gh`, the throwaway repository and the body builder both files spawn the
// script with are tests/lib/issue-lint-harness.mts.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, ci, finish, ROOT, RUNTIME } from './lib/harness.mts';
import { bodyFile, issueBody, lint, nextSeq, parse, PATH_WITH_FAKE_GH, repo } from './lib/issue-lint-harness.mts';

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
check('missing ## Goal names the section in failures[]', Array.isArray(missingGoalOut?.failures) && missingGoalOut.failures.some((f: any) => typeof f === 'string' && /## Goal/.test(f)), missingGoal.out);

const missingContext = lint(102, issueBody({ context: null }));
check('missing ## Context fails and names it', missingContext.status === 1 && /## Context/.test(missingContext.out), missingContext.out);

const emptyProof = lint(103, issueBody({ proof: '## Proof\n' }));
check('an empty ## Proof section fails and names it', emptyProof.status === 1 && /## Proof/.test(emptyProof.out), emptyProof.out);

// `## Validation` is the Codex route's name for the same section (#114): a
// task written for that route must lint clean here without a second heading.
const validationOnly = lint(1051, issueBody({ proof: '## Validation\nnode --test answer.test.mts\n' }));
check('## Validation satisfies the proof section in place of ## Proof', validationOnly.status === 0 && parse(validationOnly.out)?.ok === true, validationOnly.out);
const neitherProof = lint(1052, issueBody({ proof: null }));
check('neither ## Proof nor ## Validation fails naming both', neitherProof.status === 1 && /## Proof \(or ## Validation\)/.test(neitherProof.out), neitherProof.out);
const emptyValidation = lint(1053, issueBody({ proof: '## Validation\n' }));
check('an empty ## Validation with no ## Proof fails naming both', emptyValidation.status === 1 && /## Proof \(or ## Validation\)/.test(emptyValidation.out), emptyValidation.out);
const bothProof = lint(1054, issueBody({ proof: '## Proof\nnpm test covers it.\n\n## Validation\nnode --test answer.test.mts\n' }));
check('a body carrying both non-empty headings passes', bothProof.status === 0 && parse(bothProof.out)?.ok === true, bothProof.out);

// --- AC1b: the optional `Declaration: proof/<slug>.json` line (#136) -------
// The line is optional — every case above carries no declaration and passes.
// When it is there it must name a well-formed declaration path; the lint
// never checks the file exists (the branch that carries it need not exist at
// issue time).
const goodDeclaration = lint(1061, issueBody({ proof: '## Proof\nnpm test covers it.\nDeclaration: proof/proof-per-slug.json\n' }));
check('a well-formed Declaration: line passes', goodDeclaration.status === 0 && parse(goodDeclaration.out)?.ok === true, goodDeclaration.out);

const backtickedDeclaration = lint(1062, issueBody({ proof: '## Proof\nnpm test covers it.\nDeclaration: `proof/proof-per-slug.json`\n' }));
check('a backticked Declaration: path passes', backtickedDeclaration.status === 0 && parse(backtickedDeclaration.out)?.ok === true, backtickedDeclaration.out);

const badDeclaration = lint(1063, issueBody({ proof: '## Proof\nnpm test covers it.\nDeclaration: proof/Bad_Slug.json\n' }));
check('a Declaration: path outside proof/<slug>.json fails', badDeclaration.status === 1 && parse(badDeclaration.out)?.ok === false, badDeclaration.out);
check('the bad Declaration: failure names the offending path', /proof\/Bad_Slug\.json/.test(badDeclaration.out), badDeclaration.out);

const outsideProof = lint(1064, issueBody({ proof: '## Proof\nnpm test covers it.\nDeclaration: tests/proof-per-slug.json\n' }));
check('a Declaration: path outside proof/ fails', outsideProof.status === 1 && /Declaration/.test(outsideProof.out), outsideProof.out);

const emptyDeclaration = lint(1065, issueBody({ proof: '## Proof\nnpm test covers it.\nDeclaration:\n' }));
check('an empty Declaration: line fails', emptyDeclaration.status === 1 && /Declaration/.test(emptyDeclaration.out), emptyDeclaration.out);

// The shipped template shows the optional line without arming it: an issue
// opened from it and left unedited must not fail on a declaration it never
// made.
const templateProof = readFileSync(join(ROOT, '.github', 'ISSUE_TEMPLATE', 'task.md'), 'utf8')
  .split(/^## /m)
  .find((section) => section.startsWith('Proof'));
const fromTemplate = lint(1067, issueBody({ proof: `## ${templateProof ?? 'Proof\nMISSING SECTION\n'}` }));
check("the shipped task template's ## Proof section carries no armed Declaration: line", fromTemplate.status === 0 && parse(fromTemplate.out)?.ok === true, fromTemplate.out);

// A `Declaration:` line outside the Proof section is not this line: it must
// not be read, and it must not fail the lint either.
const declarationElsewhere = lint(1066, issueBody({ context: '## Context\nDeclaration: nothing/like-a-path\n' }));
check('a Declaration: line outside ## Proof is ignored', declarationElsewhere.status === 0 && parse(declarationElsewhere.out)?.ok === true, declarationElsewhere.out);

const noCheckbox = lint(104, issueBody({ ac: '## Acceptance criteria\nJust prose, no checkbox.\n' }));
check('## Acceptance criteria with no "- [ ]" item fails', noCheckbox.status === 1 && /Acceptance criteria/.test(noCheckbox.out), noCheckbox.out);

const noFilesBullet = lint(105, issueBody({ files: '## Files\nProse only, no bullet.\n' }));
check('## Files with no bullet glob fails', noFilesBullet.status === 1 && /Files/.test(noFilesBullet.out), noFilesBullet.out);

const noBlockedByLine = lint(106, issueBody({ deps: '## Dependencies\nnothing here\n' }));
check('## Dependencies with no "Blocked by:" line fails', noBlockedByLine.status === 1 && /Blocked by/.test(noBlockedByLine.out), noBlockedByLine.out);
// #258: the failure text quotes both forms it accepts, so a writer who reads
// only the message completes the section instead of deleting it. Asserted on
// the parsed failure string, not on raw stdout: the message carries double
// quotes, which JSON.stringify escapes.
const noBlockedByLineOut = parse(noBlockedByLine.out);
const noBlockedByLineFailure = (noBlockedByLineOut?.failures ?? []).find((f: any) => typeof f === 'string' && f.includes('Blocked by'));
check(
  'the ## Dependencies failure quotes both accepted forms ("Blocked by: #N" and "Blocked by: none")',
  typeof noBlockedByLineFailure === 'string' && noBlockedByLineFailure.includes('Blocked by: #N') && noBlockedByLineFailure.includes('Blocked by: none'),
  noBlockedByLine.out,
);

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
check('a literal path with no existing parent directory passes ("new"), not a failure', literalNewDir.status === 0 && literalNewDirOut?.ok === true, literalNewDir.out);
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
check('the old "no existing parent directory" wording is gone', !/no existing parent directory/.test(wildcardNoMatch.out), wildcardNoMatch.out);

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
check('a wildcard glob with no fixed prefix that matches nothing fails with ok: false', noPrefixWildcard.status === 1 && noPrefixWildcardOut?.ok === false, noPrefixWildcard.out);
check(
  'the no-fixed-prefix failure uses the "wildcard glob matches no tracked file" wording',
  Array.isArray(noPrefixWildcardOut?.failures) &&
    noPrefixWildcardOut.failures.some((f: any) => typeof f === 'string' && f === 'wildcard glob matches no tracked file: **/*.foo'),
  noPrefixWildcard.out,
);

// AC4 (#42): a glob containing `?` is a wildcard, not a literal path —
// `isLiteralPath` must treat `?` the same as `*`. `?abc` matches nothing in
// this repo's tracked files and has no fixed directory prefix (the `?` is
// its first character), so it fails the same way `**/*.foo` does above:
// "wildcard glob matches no tracked file", not "new".
//
// There is no "glob that does not parse" case any more: `?` now translates
// to `[^/]`, a plain wildcard token, so every character `globToRegExp` sees
// is either one of its wildcard tokens (`**`, `*`, `?`) or gets escaped
// before reaching `new RegExp` — no glob string can make it throw.
const questionMarkGlob = lint(1080, issueBody({ files: '## Files\n- `?abc`\n' }));
const questionMarkGlobOut = parse(questionMarkGlob.out);
check('a `?` glob matching no tracked file fails with ok: false', questionMarkGlob.status === 1 && questionMarkGlobOut?.ok === false, questionMarkGlob.out);
check(
  'the `?` glob failure uses the "wildcard glob matches no tracked file" wording and names the glob',
  Array.isArray(questionMarkGlobOut?.failures) &&
    questionMarkGlobOut.failures.some((f: any) => typeof f === 'string' && f === 'wildcard glob matches no tracked file: ?abc'),
  questionMarkGlob.out,
);

// --- `authorised:` grants are checked like the globs (#232) ----------------
// A grant is the one line that widens what the PR may touch, and since #231 no
// grant of either shape reaches `parseIssueGlobs` — so the lint must read it
// with `parseIssueAuthorisedGlobs` and hold it to AC2 (the glob resolves) and
// AC3 (no other in-flight issue claims the file). The dead grant below is a
// wildcard whose fixed prefix (`scripts/`) is tracked: a literal path, or a
// prefix that exists nowhere, is "new" by the same rule the bullet globs get.
const GRANT_FILES = '## Files\n- `tests/**`\n- authorised: `scripts/reconcile.mts`\n';
const deadGrant = lint(240, issueBody({ files: '## Files\n- `tests/**`\nauthorised: scripts/nope-*.mts\n' }));
const deadGrantOut = parse(deadGrant.out);
check('a bare `authorised:` grant whose wildcard matches no tracked file fails', deadGrant.status === 1 && deadGrantOut?.ok === false, deadGrant.out);
check('the dead-grant failure names the line as a grant, not as a bullet glob', (deadGrantOut?.failures ?? []).some((f: any) => typeof f === 'string' && /grant/i.test(f) && f.includes('scripts/nope-*.mts')), deadGrant.out);

const liveGrant = lint(241, issueBody({ files: GRANT_FILES }));
const liveGrantOut = parse(liveGrant.out);
const liveGrantGlobs: any[] = liveGrantOut?.globs ?? [];
check('a grant naming a tracked file passes and is reported in globs[]', liveGrant.status === 0 && liveGrantGlobs.some((g) => g.glob === 'scripts/reconcile.mts' && g.status === 'matched'), liveGrant.out);
check('globs[] marks the grant as a grant and the bullet glob as not one', liveGrantGlobs.some((g) => g.glob === 'scripts/reconcile.mts' && g.grant === true) && liveGrantGlobs.some((g) => g.glob === 'tests/**' && g.grant === false), liveGrant.out);
const liveGrantMd = lint(242, issueBody({ files: GRANT_FILES }), { markdown: true });
// Read the Grants block itself, not the whole page: a rendering that marked
// the bullet glob as the grant would satisfy "says `grant` somewhere".
const liveGrantMdGrants = liveGrantMd.out.split('**Grants**')[1] ?? '';
check('--markdown lists the granted path under Grants, and the bullet glob not', liveGrantMdGrants.includes('scripts/reconcile.mts') && !liveGrantMdGrants.includes('tests/**'), liveGrantMd.out);

// A path that is both a bullet and a grant widens nothing, so it is
// classified once, as the bullet — not reported twice under both markings.
const bothLists = lint(246, issueBody({ files: '## Files\n- `scripts/reconcile.mts`\n- authorised: `scripts/reconcile.mts`\n' }));
const bothListsGlobs: any[] = parse(bothLists.out)?.globs ?? [];
check('a path both declared and granted is reported once, as the bullet glob', bothLists.status === 0 && bothListsGlobs.length === 1 && bothListsGlobs[0]?.glob === 'scripts/reconcile.mts' && bothListsGlobs[0]?.grant === false, bothLists.out);

// --- #316: a grant line carrying more than one backticked span is refused --
// The refusal has to reach the writer where they write, which is the issue at
// dispatch: `scripts/claim.mts` runs this lint before it pushes the lock
// branch, and the `issue-lint` workflow reruns it on every `edited`, so a
// grant added after dispatch is refused too. Four shapes, four outcomes.
const ONE_SPAN = '## Files\n- `tests/**`\n- authorised: `scripts/reconcile.mts`\n';
const TWO_SPANS = '## Files\n- `tests/**`\n- authorised: `scripts/reconcile.mts` (needed alongside `package.json`)\n';
const SPAN_PLUS_PROSE = '## Files\n- `tests/**`\n- authorised: `scripts/reconcile.mts` — see the issue comment\n';
const SPAN_PLUS_CONTINUATION = '## Files\n- `tests/**`\n- authorised: `scripts/reconcile.mts`\n  (orchestrator: AC1 imports it from `package.json`)\n';
const grantsOf = (out: string): string => JSON.stringify((parse(out)?.globs ?? []).filter((g: any) => g.grant === true).map((g: any) => g.glob));
const ONLY_GRANT = JSON.stringify(['scripts/reconcile.mts']);

const shapeOne = lint(3161, issueBody({ files: ONE_SPAN }));
check('shape 1 — one span: the issue passes and the span is the one grant', shapeOne.status === 0 && grantsOf(shapeOne.out) === ONLY_GRANT, shapeOne.out);

const shapeTwo = lint(3162, issueBody({ files: TWO_SPANS }));
const shapeTwoOut = parse(shapeTwo.out);
const shapeTwoRefusal = (shapeTwoOut?.failures ?? []).filter((f: any) => typeof f === 'string' && /authorised:/.test(f) && /more than one/.test(f));
check('shape 2 — two spans: the issue fails at dispatch instead of granting both', shapeTwo.status === 1 && shapeTwoOut?.ok === false, shapeTwo.out);
check('shape 2 — the refusal names the line and both spans', shapeTwoRefusal.length === 1 && shapeTwoRefusal[0].includes('authorised: `scripts/reconcile.mts` (needed alongside `package.json`)') && shapeTwoRefusal[0].includes('scripts/reconcile.mts') && shapeTwoRefusal[0].includes('package.json'), shapeTwo.out);
check('shape 2 — neither span is reported as a grant', grantsOf(shapeTwo.out) === '[]', shapeTwo.out);
const shapeTwoMd = lint(3163, issueBody({ files: TWO_SPANS }), { markdown: true });
check('shape 2 — the --markdown comment carries the refusal too', shapeTwoMd.status === 1 && /FAIL/.test(shapeTwoMd.out) && /needed alongside/.test(shapeTwoMd.out), shapeTwoMd.out);

const shapeThree = lint(3164, issueBody({ files: SPAN_PLUS_PROSE }));
check('shape 3 — a span plus an unbackticked justification on the same line passes, granting the span alone', shapeThree.status === 0 && grantsOf(shapeThree.out) === ONLY_GRANT, shapeThree.out);

const shapeFour = lint(3165, issueBody({ files: SPAN_PLUS_CONTINUATION }));
check('shape 4 — a justification on a continuation line passes, and nothing on that line is granted', shapeFour.status === 0 && grantsOf(shapeFour.out) === ONLY_GRANT, shapeFour.out);

// --- #357: a bare glob with a backticked justification is refused too ------
// The mirror of the shape above, and the one #316's "more than one span"
// scopes out: one bare token, then a backticked justification. The parser
// took the span whenever there was one, so the line granted the path the
// author was pointing at and lost the glob they wrote. Refused rather than
// narrowed to the bare token, for #316's reason, and refused here — at
// dispatch, where the orchestrator writes the line — rather than at `scope`
// on somebody else's pull request, where it would surface only as a file
// outside the globs with no reason given.
const BARE_ALONE = '## Files\n- `tests/**`\n- authorised: scripts/reconcile.mts\n';
const BARE_PLUS_PROSE = '## Files\n- `tests/**`\n- authorised: scripts/reconcile.mts — see the issue comment\n';
const BARE_PLUS_SPAN = '## Files\n- `tests/**`\n- authorised: scripts/reconcile.mts (see `package.json`)\n';
// Every failure the lint raises about a grant line, so a case can assert how
// many there are rather than that at least one matches: a second,
// differently worded refusal of the same line would otherwise pass unseen.
const grantFailures = (out: string): string[] => (parse(out)?.failures ?? []).filter((f: any) => typeof f === 'string' && /`authorised:` line/.test(f));

const shapeFive = lint(3571, issueBody({ files: BARE_ALONE }));
check('shape 5 — a bare glob alone: the issue passes and the bare token is the one grant', shapeFive.status === 0 && grantsOf(shapeFive.out) === ONLY_GRANT, shapeFive.out);

const shapeSix = lint(3572, issueBody({ files: BARE_PLUS_PROSE }));
check('shape 6 — a bare glob plus an unbackticked justification passes, granting the bare token alone', shapeSix.status === 0 && grantsOf(shapeSix.out) === ONLY_GRANT, shapeSix.out);

const shapeSeven = lint(3573, issueBody({ files: BARE_PLUS_SPAN }));
const shapeSevenOut = parse(shapeSeven.out);
const shapeSevenRefusal = grantFailures(shapeSeven.out);
check('shape 7 — a bare glob with a backticked justification fails at dispatch instead of granting the span', shapeSeven.status === 1 && shapeSevenOut?.ok === false, shapeSeven.out);
check('shape 7 — the refusal names the line, the bare glob and the span', shapeSevenRefusal.length === 1 && shapeSevenRefusal[0].includes('authorised: scripts/reconcile.mts (see `package.json`)') && shapeSevenRefusal[0].includes('scripts/reconcile.mts') && shapeSevenRefusal[0].includes('package.json'), shapeSeven.out);
check('shape 7 — neither the bare glob nor the span is reported as a grant', grantsOf(shapeSeven.out) === '[]', shapeSeven.out);
const shapeSevenMd = lint(3574, issueBody({ files: BARE_PLUS_SPAN }), { markdown: true });
check('shape 7 — the --markdown comment carries the refusal too', shapeSevenMd.status === 1 && /FAIL/.test(shapeSevenMd.out) && /see `package.json`/.test(shapeSevenMd.out), shapeSevenMd.out);

// AC3: two different mistakes, two remedies. An author fixing one must not be
// told the other, so each line draws exactly one refusal and never the
// other's wording.
check('shape 7 — the bare-glob refusal is the only one on that line, and never says "more than one"', shapeSevenRefusal.length === 1 && /bare glob/.test(shapeSevenRefusal[0]) && !/more than one/.test(shapeSevenRefusal[0]), JSON.stringify(shapeSevenRefusal));
check('shape 2 — the two-span refusal is the only one on that line, and never says "bare glob"', grantFailures(shapeTwo.out).length === 1 && /more than one/.test(grantFailures(shapeTwo.out)[0]) && !/bare glob/.test(grantFailures(shapeTwo.out)[0]), JSON.stringify(grantFailures(shapeTwo.out)));

// --- AC5: Blocked-by numbers must exist -------------------------------------
const validBlocker = lint(115, issueBody({ deps: '## Dependencies\nBlocked by: #5\n' }));
check('a Blocked-by number that gh can find does not fail', validBlocker.status === 0, validBlocker.out);

const invalidBlocker = lint(116, issueBody({ deps: '## Dependencies\nBlocked by: #999\n' }));
const invalidBlockerOut = parse(invalidBlocker.out);
check('a Blocked-by number that gh cannot find fails with ok: false', invalidBlocker.status === 1 && invalidBlockerOut?.ok === false, invalidBlocker.out);
check('the missing-blocker failure names #999 in failures[]', Array.isArray(invalidBlockerOut?.failures) && invalidBlockerOut.failures.some((f: any) => typeof f === 'string' && f.includes('#999')), invalidBlocker.out);

const noneBlocker = lint(117, issueBody({ deps: '## Dependencies\nBlocked by: none\n' }));
check('"Blocked by: none" needs no gh lookup and passes', noneBlocker.status === 0, noneBlocker.out);

// A bare number ("Blocked by: 32", no `#`) is accepted the same as "#32".
const bareBlocker = lint(1170, issueBody({ deps: '## Dependencies\nBlocked by: 5\n' }));
check('"Blocked by: 5" (no #) is read as a real blocker and passes when gh finds it', bareBlocker.status === 0, bareBlocker.out);
const bareBlockerMissing = lint(1171, issueBody({ deps: '## Dependencies\nBlocked by: 999\n' }));
const bareBlockerMissingOut = parse(bareBlockerMissing.out);
check('"Blocked by: 999" (no #) is still checked against gh and fails when not found', bareBlockerMissing.status === 1 && bareBlockerMissingOut?.ok === false && bareBlockerMissingOut.failures.some((f: any) => typeof f === 'string' && f.includes('999')), bareBlockerMissing.out);

// --- AC6: output shape, --markdown, and the { error } path ------------------
check('a failing issue exits 1 with ok: false', missingGoal.status === 1 && missingGoalOut?.ok === false, missingGoal.out);
check('a passing issue exits 0 with ok: true', valid.status === 0 && validOut?.ok === true, valid.out);
check('the JSON result carries every required key, and no more', typeof validOut?.issue === 'number' && typeof validOut?.ok === 'boolean' && Array.isArray(validOut?.failures) && Array.isArray(validOut?.globs) && Array.isArray(validOut?.sequenced), valid.out);
// AC1 (of #62): the entry-point reference check is gone, and with it the
// `warnings` key — this issue's default `## Files` (`tests/**`) covers
// tests/smoke.mts, which .github/workflows/test.yml references by path, so
// the old lint always put a `warnings` array (non-empty) on this exact
// output. Red against the old lint; green once AC1 lands.
check('the JSON result has no warnings key at all', validOut?.warnings === undefined, valid.out);

const md = lint(118, issueBody({ goal: null }), { markdown: true });
check('--markdown starts with the marker the workflow comment step greps for', md.out.startsWith('<!-- agentic-issue-lint -->'), md.out);
check('--markdown output reports FAIL and names the failing section', /issue-lint for #118: FAIL/.test(md.out) && /## Goal/.test(md.out), md.out);

const mdOk = lint(1180, issueBody(), { markdown: true });
check('--markdown reports PASS for a passing issue', /issue-lint for #1180: PASS/.test(mdOk.out), mdOk.out);
// AC2: the Markdown comment no longer has a Warnings section — same
// reference-triggering body as above (tests/** vs. test.yml), red against
// the old lint (which rendered a **Warnings** section here).
check('--markdown output has no Warnings section', !/\*\*Warnings\*\*/.test(mdOk.out), mdOk.out);

// { error }: no issue number at all (neither positional nor --issue).
const noNumber = ci('issue-lint.mts', [], { cwd: repo, env: { PATH: PATH_WITH_FAKE_GH } });
const noNumberOut = parse(noNumber.out);
check('no issue number given exits 1 with { error }', noNumber.status === 1 && typeof noNumberOut?.error === 'string', noNumber.out);

// { error }: an unparseable --milestone-issues-file.
const badMilestoneFile = join(repo, `bad-milestone-${nextSeq()}.json`);
writeFileSync(badMilestoneFile, 'not valid json');
const badMilestone = lint(119, issueBody(), { milestone: badMilestoneFile });
const badMilestoneOut = parse(badMilestone.out);
check('an unparseable --milestone-issues-file exits 1 with { error }, not a crash', badMilestone.status === 1 && typeof badMilestoneOut?.error === 'string', badMilestone.out);

// { error } + --markdown: the marker still leads, so the workflow's own
// comment is never orphaned without it on this path.
const badMilestoneMd = ci('issue-lint.mts', ['--issue', '120', '--issue-body-file', bodyFile(issueBody()), '--milestone-issues-file', badMilestoneFile, '--markdown'], {
  cwd: repo,
  env: { PATH: PATH_WITH_FAKE_GH },
});
check('the { error } path still starts with the marker under --markdown', badMilestoneMd.status === 1 && badMilestoneMd.out.startsWith('<!-- agentic-issue-lint -->'), badMilestoneMd.out);

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

// --- design note: an old caller (e.g. an unmigrated scripts/claim.mts) may
// still pass --strict. That must not crash the lint or change stdout/exit
// code — an unknown flag is ignored, with a note on stderr instead. Spawned
// directly (not through the `ci()`/`lint()` helpers, which merge
// stdout+stderr) so stdout can be asserted as clean JSON on its own.
const strictArgv = ['--issue', '121', '--issue-body-file', bodyFile(issueBody())];
const strictSpawn = spawnSync(RUNTIME, [join(ROOT, 'ci', 'issue-lint.mts'), ...strictArgv, '--strict'], {
  encoding: 'utf8',
  cwd: repo,
  env: { ...process.env, PATH: PATH_WITH_FAKE_GH, GITHUB_EVENT_PATH: '', GITHUB_STEP_SUMMARY: '' },
});
const strictSpawnOut = parse(strictSpawn.stdout);
check(
  'a legacy --strict flag does not crash the lint; stdout is unaffected',
  strictSpawn.status === 0 && strictSpawnOut?.ok === true && strictSpawnOut?.warnings === undefined,
  `stdout: ${strictSpawn.stdout}\nstderr: ${strictSpawn.stderr}`,
);
check(
  'a legacy --strict flag is noted on stderr, not silently dropped',
  /--strict/.test(strictSpawn.stderr),
  strictSpawn.stderr,
);

finish();
