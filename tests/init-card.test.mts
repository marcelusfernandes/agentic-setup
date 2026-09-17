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
//  - Every assertion reads a bounded slice — the note's own paragraph — not the whole
//    card. The card already says `scope`, `negative-control` and `test` in step 7 (the
//    required status checks it writes into the ruleset), so a card-wide match for those
//    three names would hold on a base checkout that carries no note at all and the
//    negative control would come back `vacuous`. The anchor below appears nowhere else.
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

const anchorAt = card.indexOf(ANCHOR);
check(
  `skills/init/SKILL.md carries a bootstrap pull request note (anchor: "${ANCHOR}")`,
  anchorAt !== -1,
  card.slice(0, 200),
);

// The note's own paragraph: from the start of the line the anchor sits on to the next
// blank line. Empty when there is no note, which fails every assertion below on content.
const paragraphStart = anchorAt === -1 ? -1 : card.lastIndexOf('\n\n', anchorAt) + 2;
const paragraphEnd = anchorAt === -1 ? -1 : card.indexOf('\n\n', anchorAt);
const note = anchorAt === -1 ? '' : flat(card.slice(paragraphStart, paragraphEnd === -1 ? undefined : paragraphEnd));

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
  'the note says `test` is the check that must be green',
  /`test`[^.]*\bgreen\b/i.test(note),
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
