#!/usr/bin/env node
// Tree-wide byte pin: no tracked file under the directories named below holds
// a NUL byte (U+0000). Moved here from tests/adopt-workflows.test.mts, where
// #350 left it for want of a declared home (#427).
//
// --- why here and not in tests/doctrine.test.mts ----------------------------
// That file is this repository's home for tree-wide prose and data pins, and
// the burden is on choosing otherwise. The reason is scheduling, not subject:
// on 2026-09-20 issues #417, #419 and #420 are all open and all three declare
// `tests/doctrine.test.mts` in their own `## Files` — read from the three
// issues themselves, not taken from #427's body (invariant 9). Queueing a
// twenty-line move behind three sweeps is the worse trade, and the subject of
// this file is narrower and exactly true: the bytes of the tracked tree.
// The former home was wrong for a plainer reason — its subject is adopting
// workflow files into a repository — and `tests/adopt-pr.test.mts`, the other
// candidate #350 left, stands at 795 lines against the 800-line `scope` limit,
// so anything added there fails the check.
//
// --- what the pin is for ----------------------------------------------------
// A literal NUL byte makes `grep` classify an otherwise textual file as binary
// and suppress its matches with no message at all — `grep -c` on such a file
// prints nothing, not even a count, while `git grep -c` prints one. A sweep of
// this tree that uses `grep` therefore skips those files and reports a smaller
// number without warning. This pin is what keeps the tree readable by either
// tool (#350).
//
// Invariant 10: the directory list, the offender format and every expected
// string below are written out here rather than imported from anything — a pin
// that reuses the list it pins cannot catch that list drifting.
//
// Invariant 6: pure-read, so it does not apply here. There is no script that
// implements this, only `git ls-files` and the filesystem — the same shape
// `tests/doctrine.test.mts` and `tests/provenance.test.mts` use, and this file
// goes further than either, building throwaway git repositories for its
// controls because the scan has to be proved to *find* something and not
// merely to stay quiet.
//
// --- the hazard an implementer meets before writing a line ------------------
// Spelling U+0000 — or U+001F, or U+007F — as the six-character backslash-u
// escape through an editing tool writes the **raw byte** to disk: the escape is
// decoded on the way in. It happened inside PR #416, the pull request that
// removed the last four such bytes: its red commit `d401d1f` carries two NUL
// bytes in the pin's own file, one pre-existing at offset 9933 and one planted
// at 23420 by a constant written that way. `String.fromCharCode(0)` and a
// byte-level node script do not do this; the Bash tool refuses the same text
// outright, so two tools an implementer uses in the same minute disagree about
// what it is. That warning belongs on the card an implementer reads before
// writing — `agents/implementer.md`, under `## Before writing a line`, and
// `.agents/skills/autonomous-loop/SKILL.md` for the Codex route. Neither file
// is in #427's `## Files`, so neither is edited here; the pull request says so
// rather than widening the grant.
//
// --- one layer up: GitHub, and whether a gate is owed -----------------------
// GitHub sanitises that escape in a pull request body (measured twice in #416,
// including through `gh api -X PATCH --input` with a correctly JSON-encoded
// body, so it is GitHub and not the CLI), and this repository's
// `squash_merge_commit_message` is `COMMIT_MESSAGES` — read from the repository
// API on 2026-09-20, not from a literal in `scripts/land.mts`, which merely
// runs `gh pr merge --squash` and lets the repository default apply. What is
// still **unmeasured** is whether a branch commit message carrying that escape
// actually lands corrupted on `main`. What would measure it: a scratch
// repository with the same setting, one commit whose message body carries the
// escape (written with `git commit -F` from a file a byte-level script
// produced), `gh pr merge --squash`, then `git log -1 --format=%B` on the base
// compared byte for byte — the three outcomes to tell apart are the six ASCII
// bytes intact, caret notation, and truncation, since a raw NUL cannot live in
// a git commit message at all. If it shows corruption the gate is a `ci/` check
// over `git log <base>..<head> --format=%B`, not a refusal in
// `scripts/land.mts`: that file belongs to two open sweeps and #427's grant
// does not cover it.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, commit, finish, tempRepo, ROOT } from './lib/harness.mts';

/**
 * The directories scanned, each with its reason, written out rather than
 * imported (invariant 10).
 *
 * The first four are #350's list, moved unchanged: every line of code this
 * repository runs. The last two are added under #427's coverage criterion —
 * `.agents/` holds the Codex route's live runtime (`npm run loop` runs
 * `.agents/skills/autonomous-loop/scripts/run.mts`) and `templates/` ships
 * verbatim into every adopting repository, so a NUL byte there travels.
 *
 * What is out, and why it is a boundary that stays true rather than a snapshot:
 * all six hold text by contract — code, workflows, JSON schema — while `docs/`
 * (55 files) may legitimately acquire an image one day, `plugins/` (7) is a
 * byte-identical mirror already held by `npm run check:codex-plugin`, and
 * `.github/` (8), `skills/` (4), `proof/` (3), `agents/` (3),
 * `.claude-plugin/` (2), `.claude/` (1) and the 10 root files are prose,
 * configuration and generated records that no sweep of this tree greps for
 * code. That is 106 of 199 tracked files scanned and 93 out by choice.
 *
 * The measurement, so a later reader knows the 93 are unscanned and were clean
 * once rather than covered: all 199 tracked blobs were read as Buffers in node
 * at `1ab0b26` on 2026-09-20 and **none** holds a NUL byte. Reading them as
 * Buffers is the only honest way — `grep` and `git grep` skip what they cannot
 * read, which is the defect itself.
 */
const NUL_FREE_DIRS = ['tests', 'ci', 'scripts', 'hooks', '.agents', 'templates'];

/** The NUL byte as a one-character string, built rather than written so this file carries none. */
const NUL_CHAR = String.fromCharCode(0);

/**
 * One `path:offset (line N)` entry per tracked file under `dirs` that holds a
 * NUL byte, sorted, relative to `root`; empty when the tree is clean.
 *
 * The offset is the point. A check that reports only "a file has a NUL byte"
 * reproduces the silence it exists to break: the next author would have to run
 * the very sweep this defect makes unreliable in order to find the file.
 */
function nulOffenders(root: string, dirs: string[]): string[] {
  const listed = spawnSync('git', ['ls-files', '-z', '--'].concat(dirs), { cwd: root });
  if (listed.status !== 0) throw new Error(`git ls-files: ${String(listed.stderr)}`);
  const offenders: string[] = [];
  for (const path of listed.stdout.toString('utf8').split(NUL_CHAR).filter(Boolean)) {
    const content = readFileSync(join(root, path));
    const at = content.indexOf(0);
    if (at < 0) continue;
    const line = content.subarray(0, at).toString('utf8').split('\n').length;
    offenders.push(`${path}:${at} (line ${line})`);
  }
  return offenders.sort();
}

/**
 * What one scan answers: the offenders, and how many files each named
 * directory actually listed.
 *
 * `counts` is not decoration. `git ls-files -z -- nosuchdir anotherone` exits
 * **0 with empty output** — pinned below — so renaming one of the scanned
 * directories empties its share of the scan silently and this pin goes green
 * for precisely the reason its own comment says it exists to prevent: a
 * detector that quietly finds nothing, passing for the wrong reason.
 */
type Scan = { offenders: string[]; counts: Record<string, number> };

function scanTree(root: string, dirs: string[]): Scan {
  return { offenders: nulOffenders(root, dirs), counts: {} };
}

// --- the real tree ----------------------------------------------------------
const tree = scanTree(ROOT, NUL_FREE_DIRS);
check(
  `no tracked file under ${NUL_FREE_DIRS.join('/, ')}/ holds a NUL byte (#350)`,
  tree.offenders.length === 0,
  tree.offenders.join('\n'),
);

// The scan is proved to have read something, per directory: an empty list of
// paths would satisfy the check above for the wrong reason (#427).
for (const dir of NUL_FREE_DIRS) {
  check(
    `the real-tree scan listed at least one tracked file under ${dir}/`,
    tree.counts[dir] > 0,
    `${dir}: ${String(tree.counts[dir])}`,
  );
}

// The hazard itself, pinned as a measurement rather than as prose: git answers
// a directory that does not exist with success and silence.
const missing = spawnSync('git', ['ls-files', '-z', '--', 'nosuchdir', 'anotherone'], { cwd: ROOT });
check(
  'git ls-files over directories that do not exist exits 0 with empty output',
  missing.status === 0 && missing.stdout.length === 0,
  `status ${String(missing.status)}, ${String(missing.stdout.length)} bytes`,
);

// --- positive control: a planted NUL ----------------------------------------
// The detector proved against a planted NUL rather than only against a clean
// tree: a scan that quietly found nothing would pass the case above for the
// wrong reason, which is exactly the failure mode #350 is about.
const PLANTED_PREFIX = 'const sentinel = ';
const planted = tempRepo();
commit(planted, { 'tests/planted.test.mts': `${PLANTED_PREFIX}${NUL_CHAR}\n` }, 'plant a NUL byte');
const plantedFound = scanTree(planted, NUL_FREE_DIRS).offenders;
check(
  'the scan names the planted file and the offset of its NUL byte',
  plantedFound.join('|') === `tests/planted.test.mts:${PLANTED_PREFIX.length} (line 1)`,
  plantedFound.join('|') || '(the scan found nothing)',
);

// --- every offset, not only the first ---------------------------------------
// #350's criterion asked for "the offset", singular, and PR #416 satisfied it
// with `indexOf`; a second NUL at byte 23420 in the pin's own file was
// invisible behind the one at 9933 and was found only on the re-run. The
// decision (#427) is to report every offset in a file, one entry each, in the
// same `path:offset (line N)` shape — so a single-NUL file reads exactly as it
// did before and nothing hides behind anything.
//
// The two expected entries are written out (invariant 10): the prefix is 17
// characters, so the first byte sits at offset 17 on line 1, and a newline plus
// the same prefix again puts the second at offset 36 on line 2.
const TWICE_EXPECTED = 'tests/twice.test.mts:17 (line 1)|tests/twice.test.mts:36 (line 2)';
const twice = tempRepo();
commit(
  twice,
  { 'tests/twice.test.mts': `${PLANTED_PREFIX}${NUL_CHAR}\n${PLANTED_PREFIX}${NUL_CHAR}\n` },
  'plant two NUL bytes',
);
const twiceFound = scanTree(twice, NUL_FREE_DIRS).offenders;
check(
  'both NUL bytes of one file are reported, each with its own offset and line',
  twiceFound.join('|') === TWICE_EXPECTED,
  twiceFound.join('|') || '(the scan found nothing)',
);

// --- negative control: a clean tree, and a directory that is not there ------
const cleanTree = tempRepo();
commit(cleanTree, { 'tests/clean.test.mts': `${PLANTED_PREFIX}'x';\n` }, 'no NUL byte');
const clean = scanTree(cleanTree, ['tests', 'ci']);
check('a tracked tree without a NUL byte produces no offender', clean.offenders.length === 0, clean.offenders.join('\n'));
check(
  'a directory with no tracked file is counted as zero, not skipped',
  clean.counts['tests'] === 1 && clean.counts['ci'] === 0,
  `tests: ${String(clean.counts['tests'])}, ci: ${String(clean.counts['ci'])}`,
);

finish();
