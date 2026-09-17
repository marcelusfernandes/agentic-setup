#!/usr/bin/env node
// Pin test for skills/init/SKILL.md's account of the bootstrap pull request (issue #263,
// origin: dogfood 2026-09-06 finding F3). On the first third-party run the bootstrap PR
// came back with two reds by design — `scope` because a bootstrap PR links no issue, and
// `negative-control` as `no-tests` because it carries none — and the run stopped to debug
// a correct install because the card said nothing about them. The card is the consumer of
// that paragraph; this file is the consumer of the card. Pure-read: a pin over Markdown,
// there is no script to spawn.
//
// Notes on the comparison, in the shape tests/orchestrate-card.test.mts uses:
//  - Markdown wraps the card at ~90 columns, so the note is compared with whitespace
//    collapsed to single spaces before any assertion runs.
//  - Every assertion reads a bounded slice — the note's own block — and never the whole
//    card, at BOTH ends. Bounding matters twice over, and the first version of this file
//    (PR #279, round 1) only got one end right:
//      * The card already says `scope`, `negative-control` and `test` in step 7, the
//        required status checks it writes into the ruleset. A card-wide match for those
//        three names holds on a base checkout carrying no note at all, so the negative
//        control would come back `vacuous`.
//      * The card ALSO says `scope` and `negative-control` two bullets below the note
//        ("make ... **required checks** on `main` by hand"). The by-hand list has no
//        blank lines between its items, so ending the slice at the next blank line finds
//        none, and a slice that then falls back to the end of the file swallows that
//        bullet: dropping `negative-control` from the note still passed. The block ends
//        at the next blank line OR the next list item OR the next heading, whichever
//        comes first, and when none is found the slice is refused rather than widened.
//    `sliceExcludesTheByHandBullet` below is the standing guard on the second end; the
//    mutation that proves it (remove a check name from the note, watch the case red) is
//    in the pull request body.
//  - The anchor is guarded with an explicit `=== -1`: `String.slice(-1)` on a missing
//    anchor returns the last character, which is a non-empty string and would sail past
//    a length-only guard.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

const card = readFileSync(join(ROOT, 'skills', 'init', 'SKILL.md'), 'utf8');

/** Markdown wrapping is not content: one space for any run of whitespace. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The phrase that opens the note. Absent from the card before this issue. */
const ANCHOR = 'two reds by design';

/** Where a Markdown block may begin or end around `at`: a blank line, a top-level list
 *  item, or a heading. Returns the nearest boundary before `at` and the nearest after. */
const BOUNDARIES = ['\n\n', '\n- ', '\n#'];

/** The offset just past the nearest boundary before `at`, or -1 when there is none. */
function blockStart(text: string, at: number): number {
  const starts = BOUNDARIES
    .map((b) => {
      const i = text.lastIndexOf(b, at);
      return i === -1 ? -1 : i + (b === '\n\n' ? 2 : 1);
    })
    .filter((i) => i !== -1 && i <= at);
  return starts.length === 0 ? -1 : Math.max(...starts);
}

/** The offset of the nearest boundary after `at`, or -1 when there is none. -1 is a
 *  refusal, never "take the rest of the file": widening here is what stopped the first
 *  version of this test from discriminating. */
function blockEnd(text: string, at: number): number {
  const ends = BOUNDARIES.map((b) => text.indexOf(b, at)).filter((i) => i !== -1);
  return ends.length === 0 ? -1 : Math.min(...ends);
}

const anchorAt = card.indexOf(ANCHOR);
check(
  `skills/init/SKILL.md carries a bootstrap pull request note (anchor: "${ANCHOR}")`,
  anchorAt !== -1,
  card.slice(0, 200),
);

const start = anchorAt === -1 ? -1 : blockStart(card, anchorAt);
const end = anchorAt === -1 ? -1 : blockEnd(card, anchorAt);
check(
  'the note is bounded at both ends (a blank line, a list item or a heading on each side)',
  anchorAt === -1 || (start !== -1 && end !== -1),
  `anchor ${anchorAt}, start ${start}, end ${end}`,
);

/** The note's own block. Empty when it could not be bounded, which fails every assertion
 *  below on content rather than silently widening to the rest of the card. */
const note = anchorAt === -1 || start === -1 || end === -1 ? '' : flat(card.slice(start, end));

// The standing guard on the far end: the by-hand bullet two items below the note also
// names `scope` and `negative-control`, and a slice that reaches it stops discriminating.
check(
  'the note slice stops before the by-hand "required checks" bullet',
  note !== '' && !/\*\*required checks\*\*/.test(note),
  `${note.length} chars`,
);

// AC1: the note names both expected reds, with the reason for each, and says which check
// must be green.
check('the note names `scope` as an expected red', /`scope`/.test(note), note);
check(
  'the note gives `scope`\'s reason — a bootstrap pull request links no issue',
  /`scope`[^.]*links no issue/i.test(note) || /links no issue[^.]*`scope`/i.test(note),
  note,
);
check('the note names `negative-control` as an expected red', /`negative-control`/.test(note), note);
check(
  'the note gives `negative-control`\'s outcome by name — `no-tests`',
  /`no-tests`/.test(note),
  note,
);
check(
  'the note says `test` is the check that is expected green',
  /`test`[^.]*\bgreen\b/i.test(note),
  note,
);
check(
  'the note ties that green check to the repository\'s own test workflow job, which step 7 may have named otherwise',
  /own test workflow's job/i.test(note),
  note,
);
check(
  'the note says the two reds are expected on the bootstrap pull request alone, not a broken install',
  /bootstrap pull request/i.test(note) && /(that one pull request|on that one|alone)/i.test(note),
  note,
);
check(
  'the note tells the reader not to debug the install over them',
  /(do not debug|nothing is wrong with the install|not a broken install)/i.test(note),
  note,
);
check(
  'the note does not leave the reader stopped when `--rules` already made the two required',
  /`--rules`/.test(note) && /(bypass_actors|cannot merge on its own)/i.test(note),
  note,
);

// AC2: the note says what makes the reds stop.
check(
  'the note says the reds stop at the first ordinary issue-linked pull request',
  /first ordinary issue-linked pull request/i.test(note),
  note,
);
check(
  'the note names `Closes #N` as what that pull request carries',
  /`Closes #N`/.test(note),
  note,
);
check(
  'the note names test files as the other thing that pull request carries',
  /test files/i.test(note),
  note,
);

// Placement: AC1 wants the note where it is read before the bootstrap pull request is
// opened — inside the by-hand list, alongside the bullet that opens it.
const byHandAt = card.indexOf('Then, by hand');
check('skills/init/SKILL.md still has its by-hand list', byHandAt !== -1);
check(
  'the note sits inside the by-hand list, where it is read before the pull request is opened',
  anchorAt !== -1 && byHandAt !== -1 && anchorAt > byHandAt,
  `anchor at ${anchorAt}, by-hand list at ${byHandAt}`,
);

finish();
