#!/usr/bin/env node
// What a squash merge does to a commit message carrying the six-character
// backslash-u escape for U+0000 — measured on 2026-09-20, and the answer is
// that it does nothing: the message lands on the base byte for byte (#435).
//
// This file is the record of that measurement and a pin of the git-side facts
// it rests on. It is deliberately **not** a gate. #435's second criterion asks
// for `ci/commit-message-bytes.mts` only "if the result is corruption"; the
// result is not corruption, so no such file exists and none is owed.
//
// --- the question, and why it was open --------------------------------------
// This repository's `squash_merge_commit_message` is `COMMIT_MESSAGES` (and its
// `squash_merge_commit_title` is `COMMIT_OR_PR_TITLE`) — repository settings,
// present in no tracked file. `scripts/land.mts` runs `gh pr merge --squash`
// and GitHub applies them. Since GitHub's JSON API was known to hand back that
// escape rewritten, a branch's commit messages were assumed to reach `main`
// through the same corrupting path. Nobody had run it. #427 declined to infer
// the consequence and designed the experiment; #435 ran it.
//
// --- the experiment, as run --------------------------------------------------
// Date 2026-09-20. Scratch repository `marcelusfernandes/agentic-scratch-435-
// squash-bytes` (private, owned by this repository's owner, left in place),
// `squash_merge_commit_title: COMMIT_OR_PR_TITLE` and
// `squash_merge_commit_message: COMMIT_MESSAGES`, read back from the API before
// each merge. `gh` 2.83.1, `git` 2.50.1. Every string below was built from byte
// codes by a node script and written to disk with `writeFileSync`; the commit
// message went in with `git commit -F`, so nothing decoded it on the way in.
// Each merge was `gh pr merge --squash <n>` under `GH_DEBUG=api`: the
// `mergePullRequest` mutation carried `{pullRequestId, mergeMethod: "SQUASH"}`
// and no `commitHeadline` or `commitBody`, so the repository default applied
// and the measurement is of GitHub and not of the CLI.
//
// A — the escape in a **commit message body**, single-commit branch, PR #1.
//     Squashed onto the base as `d1deb2f7afc8246d119bb970674654f5dceacd0e`.
//     `git log -1 --format=%B` on the base gives, between the two markers, the
//     bytes 5c 75 30 30 30 30 — the six ASCII bytes, **intact**. The raw commit
//     object carries them too, inside GitHub's own GPG signature over it.
// B — the escape in a **pull request title**, two-commit branch (so
//     `COMMIT_OR_PR_TITLE` takes the PR title, not a commit subject), PR #2,
//     title POSTed as correctly JSON-encoded bytes through
//     `gh api -X POST --input -`. Squashed as
//     `a350698a72fdce25fa4fd21cfc35e17dbeb1e177`; the subject line on the base
//     carries 5c 75 30 30 30 30 — **intact**.
// C — the escape in a **pull request body**, set at creation, with
//     `squash_merge_commit_message` temporarily `PR_BODY` so that GitHub itself
//     reads the stored body to build the commit. PR #3, squashed as
//     `d48cb14b6348d1a0c52595a21708005af61c572f` — **intact**.
// D — the same through `gh api -X PATCH --input -` on an existing body, the
//     exact path #416 used. PR #4, squashed as
//     `10154d8377414fafaed21eee6807f27a82b833c5` — **intact**.
//
// Of the three outcomes #435 named — the six bytes intact, caret notation, or
// the message truncated at that point — the answer on the base is **intact**,
// in all four placements.
//
// --- the second finding: the rewrite is a read-back, not a corruption --------
// The rewrite is real and it is GitHub's, but it lives only in the JSON the API
// hands back. For all four cases the REST response carries, on the wire,
// 5c 5c 5e 40 where the stored text has 5c 75 30 30 30 30 — that is a
// JSON-escaped backslash followed by caret notation for U+0000, so a client
// parses three characters where six were stored. GraphQL hands back the same
// three (checked for D). The value itself is unharmed: experiments B, C and D
// are exactly the cases where GitHub reads its own stored title or body to
// build a commit, and what it wrote into the commit was the six bytes.
//
// So "GitHub sanitises the escape in a pull request body", recorded in #427's
// and #435's bodies from PR #416, is a fact about the API's representation and
// not about what is stored. The consequence for this repository: anything that
// reads a message, title or body through `gh api` or `gh pr view --json` and
// compares it to git will see a mismatch on this text. Nothing in the loop does
// that today, so nothing changes.
//
// --- what could not be reached ----------------------------------------------
// `scripts/land.mts` queues `gh pr merge --squash --auto` and the server merges
// later; the experiment merged directly, because auto-merge needs a ruleset the
// scratch repository has not got. The mutation and the repository settings are
// the same either way, but the queued path was not the one exercised.
//
// --- what the cases below pin, and what they cannot -------------------------
// The GitHub half needs a network and a repository, so it is recorded above and
// not pinned. What is pinned is the git-side half, which is the part that would
// have decided where a gate went — and which, measured, removes the reason for
// one. Invariant 6 does not apply: there is no script here to spawn, only git
// and the filesystem, the same pure-read exemption `tests/tree-bytes.test.mts`
// and `tests/provenance.test.mts` carry. Invariant 10: every expected byte
// sequence below is written out as its own literal array rather than reused
// from the input side, so the oracle cannot drift with the thing it checks.
//
// --- the escape hazard for files is elsewhere -------------------------------
// Writing that escape through an editing tool writes the raw byte to disk. That
// rule and its evidence live in `tests/tree-bytes.test.mts`'s header and are not
// restated here. One line of that header is now superseded — the paragraph
// beginning "What is still **unmeasured**" describes this experiment as still to
// be run. `tests/tree-bytes.test.mts` is not in #435's `## Files`, so it is not
// edited here; correcting it is the follow-up, and this file is where the answer
// lives until then.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, commit, finish, git, ROOT, tempRepo } from './lib/harness.mts';

/**
 * The six ASCII bytes of the escape — backslash, u, and four zeros — as the
 * **input** to every case: built from codes, never typed, because typing them
 * into this file through an editing tool would put a raw U+0000 byte here.
 */
const ESCAPE_IN = Buffer.from([0x5c, 0x75, 0x30, 0x30, 0x30, 0x30]);

/**
 * The same six bytes as the **oracle**, written out a second time (invariant
 * 10). A pin that compares its input against itself cannot catch its input
 * drifting, and the drift this file exists to notice is one tool silently
 * turning those six bytes into one.
 */
const ESCAPE_EXPECTED = [0x5c, 0x75, 0x30, 0x30, 0x30, 0x30];

/** U+0000 as one character, built rather than written, so this file carries none. */
const NUL_CHAR = String.fromCharCode(0);

/** The markers a message is read back between, so a truncation is visible as an absence. */
const BEFORE = 'BEFOREMARK';
const AFTER = 'AFTERMARK';

/**
 * Runs git without throwing, under a fixed locale.
 *
 * `git` from the harness throws on a non-zero exit, and two cases below are
 * about exactly that exit. `LC_ALL=C` is set because the refusals are pinned by
 * **status**, not by their text — git translates those messages, so a pin on
 * the English string would be a pin on the machine's locale.
 */
function tryGit(args: string[], cwd: string) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** The bytes between the two markers in a message, or null when a marker is gone. */
function between(message: Buffer): number[] | null {
  const text = message.toString('latin1');
  const start = text.indexOf(BEFORE);
  const end = text.indexOf(AFTER);
  if (start < 0 || end < 0) return null;
  return [...message.subarray(start + BEFORE.length, end)];
}

// --- the local half of the experiment, reproduced ----------------------------
// `git commit -F <file>` from a byte-level file, read back with
// `git log --format=%B`: the six bytes survive git untouched. This is the
// message a squash merge is built from, and the text a `ci/` check over
// `git log <base>..<head> --format=%B` would have had to read.
const roundTrip = tempRepo();
commit(roundTrip, { 'seed.txt': 'seed\n' }, 'chore: seed');
writeFileSync(join(roundTrip, 'a.txt'), 'a\n');
git(['add', '-A'], roundTrip);
const messagePath = join(roundTrip, 'message.bin');
writeFileSync(
  messagePath,
  Buffer.concat([
    Buffer.from('test: a subject line\n\n', 'utf8'),
    Buffer.from(BEFORE, 'utf8'),
    ESCAPE_IN,
    Buffer.from(AFTER, 'utf8'),
    Buffer.from('\n', 'utf8'),
  ]),
);
const wrote = tryGit(['commit', '-q', '-F', messagePath], roundTrip);
check('git accepts a commit message file carrying the six ASCII bytes of the escape', wrote.status === 0, wrote.stderr);
const readBack = spawnSync('git', ['log', '-1', '--format=%B'], { cwd: roundTrip });
const survived = between(readBack.stdout ?? Buffer.alloc(0));
check(
  'the six bytes come back from git log --format=%B unchanged',
  survived !== null && survived.join(' ') === ESCAPE_EXPECTED.join(' '),
  survived === null ? '(a marker is missing — the message was truncated)' : survived.join(' '),
);

// --- why truncation was never the failure mode -------------------------------
// #435 reasoned that a raw U+0000 cannot live in a git commit message at all,
// so truncation was the plausible corruption. The first half is true and git
// enforces it at the source: the commit is refused and no object is written, so
// there is nothing for a squash to truncate. Pinned by status and by the absent
// commit rather than by git's message, which is translated.
const refuses = tempRepo();
commit(refuses, { 'seed.txt': 'seed\n' }, 'chore: seed');
const before = git(['rev-parse', 'HEAD'], refuses);
writeFileSync(join(refuses, 'b.txt'), 'b\n');
git(['add', '-A'], refuses);
const rawPath = join(refuses, 'raw.bin');
writeFileSync(
  rawPath,
  Buffer.concat([
    Buffer.from('test: a subject line\n\n', 'utf8'),
    Buffer.from(`${BEFORE}${NUL_CHAR}${AFTER}\n`, 'utf8'),
  ]),
);
const refused = tryGit(['commit', '-q', '-F', rawPath], refuses);
check('git refuses a commit message file carrying a raw U+0000 byte', refused.status !== 0, `exit ${String(refused.status)}`);
check(
  'the refusal writes no commit object — HEAD is where it was',
  git(['rev-parse', 'HEAD'], refuses) === before,
  `${before} became ${git(['rev-parse', 'HEAD'], refuses)}`,
);

// --- the branch-name half of #435's last criterion ---------------------------
// A branch name cannot carry the escape, because a backslash is not a legal
// character in a git reference name. git refuses it before any remote is
// involved, so the name cannot exist locally to be pushed and the question
// cannot arise. Pinned by status, not by the `fatal:` text.
const refs = tempRepo();
commit(refs, { 'seed.txt': 'seed\n' }, 'chore: seed');
const candidate = `exp/${ESCAPE_IN.toString('latin1')}-branch`;
check(
  'git check-ref-format rejects a branch name carrying the escape',
  tryGit(['check-ref-format', '--branch', candidate], refs).status !== 0,
  `exit ${String(tryGit(['check-ref-format', '--branch', candidate], refs).status)}`,
);
const branched = tryGit(['branch', candidate], refs);
check('git branch refuses to create it', branched.status !== 0, `exit ${String(branched.status)}`);
check(
  'and no such branch exists afterwards',
  !tryGit(['branch', '--list'], refs).stdout.includes('-branch'),
  tryGit(['branch', '--list'], refs).stdout,
);

// --- this file carries none of what it is about ------------------------------
// Read as a Buffer, never grepped: `grep` classifies a file holding a U+0000
// byte as binary and suppresses its matches without saying so, which is the
// defect itself.
const ownBytes = readFileSync(join(ROOT, 'tests', 'commit-message-bytes.test.mts'));
check(
  'this file itself holds no U+0000 byte',
  ownBytes.length > 0 && !ownBytes.includes(0x00),
  `${String(ownBytes.length)} bytes read`,
);
check(
  'nor the six ASCII bytes of the escape — every one of them is built from codes',
  ownBytes.length > 0 && !ownBytes.includes(Buffer.from(ESCAPE_EXPECTED)),
  `${String(ownBytes.length)} bytes read`,
);
check(
  'and the read was not vacuous: it found the array the two cases above rest on',
  ownBytes.includes(Buffer.from('ESCAPE_EXPECTED', 'utf8')),
  `${String(ownBytes.length)} bytes read`,
);

finish();
