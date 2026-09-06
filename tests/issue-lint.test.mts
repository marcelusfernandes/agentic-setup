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
check('missing ## Goal fails', missingGoal.status === 1, missingGoal.out);
check('missing ## Goal names the section', /## Goal/.test(missingGoal.out), missingGoal.out);

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

const noParent = lint(108, issueBody({ files: '## Files\n- `nonexistent-dir/file.ts`\n' }));
check('a glob matching no tracked file and with no existing parent dir fails', noParent.status === 1, noParent.out);
check('the no-parent failure names the glob', /nonexistent-dir\/file\.ts/.test(noParent.out), noParent.out);

// --- AC3: disjointness -------------------------------------------------------
const overlapMilestone = milestoneFile([{ number: 200, labels: ['state:ready'], body: '## Files\n- `tests/smoke.mts`\n' }]);
const overlap = lint(109, issueBody(), { milestone: overlapMilestone });
const overlapOut = parse(overlap.out);
check('overlapping globs with another ready issue fails', overlap.status === 1, overlap.out);
check(
  'the overlap failure carries { issue, files } naming the other issue and the shared file',
  Array.isArray(overlapOut?.failures) && overlapOut.failures.some((f: any) => f?.issue === 200 && Array.isArray(f?.files) && f.files.includes('tests/smoke.mts')),
  overlap.out,
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

const strictReference = lint(114, issueBody(), { strict: true });
check('--strict turns the AC4 warning into a failure', strictReference.status === 1, strictReference.out);

// --- AC5: Blocked-by numbers must exist -------------------------------------
const validBlocker = lint(115, issueBody({ deps: '## Dependencies\nBlocked by: #5\n' }));
check('a Blocked-by number that gh can find does not fail', validBlocker.status === 0, validBlocker.out);

const invalidBlocker = lint(116, issueBody({ deps: '## Dependencies\nBlocked by: #999\n' }));
check('a Blocked-by number that gh cannot find fails', invalidBlocker.status === 1, invalidBlocker.out);
check('the missing-blocker failure names #999', /#999/.test(invalidBlocker.out), invalidBlocker.out);

const noneBlocker = lint(117, issueBody({ deps: '## Dependencies\nBlocked by: none\n' }));
check('"Blocked by: none" needs no gh lookup and passes', noneBlocker.status === 0, noneBlocker.out);

// --- AC6: output shape and --markdown ---------------------------------------
check('a failing issue exits 1', missingGoal.status === 1);
check('a passing issue exits 0', valid.status === 0);
const md = lint(118, issueBody({ goal: null }), { markdown: true });
check('--markdown starts with the marker the workflow comment step greps for', md.out.startsWith('<!-- agentic-issue-lint -->'), md.out);
check('--markdown output is not JSON', parse(md.out) === null, md.out);
check('--markdown output names the failing section', /## Goal/.test(md.out), md.out);

finish();
