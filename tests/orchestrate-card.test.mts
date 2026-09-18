#!/usr/bin/env node
// Cases for skills/orchestrate/SKILL.md and agents/reviewer.md: the orchestrator runs a
// continuous loop over open milestones instead of one pass per invocation, stops only for
// a closed list of reasons, and is the one that comments verdicts and applies review
// labels — not the reviewer (decision carried by this issue, #132). Reads the real files;
// no process spawned, there is nothing to run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { check, finish, ROOT } from './lib/harness.mts';

const card = readFileSync(join(ROOT, 'skills', 'orchestrate', 'SKILL.md'), 'utf8');
const reviewer = readFileSync(join(ROOT, 'agents', 'reviewer.md'), 'utf8');

// AC1/AC2: the one-pass sentence is gone.
check('SKILL.md no longer tells the orchestrator to run one pass', !/run\s+\*{0,2}one pass\*{0,2}/i.test(card), card.slice(0, 400));
check(
  'SKILL.md no longer says the person decides whether to run another',
  !/the person decides whether to run another/i.test(card),
);
check(
  "SKILL.md's frontmatter description no longer promises one pass",
  !/description:.*run one pass/i.test(card),
);

// AC2: the closed list of stop reasons is present, and only these three.
check('SKILL.md names "no open milestone" as a stop reason', /no open milestone/i.test(card));
check(
  'SKILL.md names every open issue blocked/human-pending/waiting-on-a-person as a stop reason',
  /every open issue.*(state:blocked.*human:pending|human:pending.*state:blocked).*waiting on a person/is.test(card),
);
check(
  'SKILL.md names an explicit turn or time budget on the command line as a stop reason',
  /explicit turn or time budget given on the command line/i.test(card),
);
check('SKILL.md says the stop comments a summary on the milestone\'s parent issue', /comment.*summary.*(parent issue|milestone)/is.test(card));

// AC1: step 6 continues the loop rather than only reporting and stopping.
check(
  'SKILL.md step 6 opens the next milestone and continues, rather than only reporting',
  /next (open )?milestone/i.test(card) && /continu/i.test(card),
);
const closeStep = card.slice(card.indexOf('## 6. Close the milestone'));
check('SKILL.md step 6 exists', closeStep.length > 0 && closeStep.length < card.length);
// #227: step 6 actually closes the milestone, and closes it the one way a
// milestone closes — `scripts/close-milestone.mts` against the phase's
// evidence (#172). This case used to require the card to carry the
// hand-typed `gh api -X PATCH … milestones/<n> -f state=closed` that the
// script replaced; once #199 rewrote the step, the old regex went on passing
// only because it matched the sentence **forbidding** that PATCH. The pin
// now reads the step the way an orchestrator would: the runnable blocks
// carry the script, and no runnable block anywhere in the card types the
// state=closed PATCH by hand. The prohibition is prose and stays prose.
check(
  'SKILL.md step 6 closes the milestone through scripts/close-milestone.mts with --evidence',
  /close-milestone\.mts/.test(closeStep) && /--evidence\s+docs\/closeout\/M<n>\.md/.test(closeStep),
  closeStep.slice(0, 400),
);
const runnable = [...card.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) => m[1]);
const handTypedClose = runnable.filter((block) => /-X\s+PATCH/.test(block) && /state=closed/.test(block));
check(
  'no runnable block in SKILL.md types the milestone state=closed PATCH by hand',
  handTypedClose.length === 0,
  handTypedClose.join('\n---\n'),
);
check(
  'SKILL.md step 6 still forbids the hand-typed state=closed PATCH in prose',
  /Never run[\s\S]{0,160}state=closed/.test(closeStep),
  closeStep.slice(0, 400),
);

// AC5: the label transitions live in the orchestrator's own step, not the reviewer's.
const decideStep = card.slice(card.indexOf('## 5. Decide'));
check('SKILL.md step 5 exists', decideStep.length > 0 && decideStep.length < card.length);
check('SKILL.md step 5 states the approved label transition', /review:approved/.test(decideStep) && /state:qa-failed/.test(decideStep));
check(
  'SKILL.md step 5 restores state:in-review on approval, symmetric with the rejected bullet removing it',
  /--add-label review:approved --add-label state:in-review/.test(decideStep),
);
check('SKILL.md step 5 states the rejected label transition', /state:qa-failed/.test(decideStep));
check(
  'SKILL.md step 5 states the second-rejection label transition',
  /state:blocked/.test(decideStep) && /human:pending/.test(decideStep),
);
check(
  'SKILL.md step 4 says the reviewer returns its verdict rather than labelling or commenting itself',
  /reviewer[^.]*(does not|no longer)[^.]*(label|comment)/is.test(card) || /commenting and label(l)?ing[^.]*(this step|orchestrator)/is.test(card),
);

// AC4: agents/reviewer.md no longer applies labels itself — that command moved to the
// orchestrator's card above.
check(
  "reviewer.md no longer runs gh pr edit to add or remove a label itself",
  !/gh pr edit\s+<n>\s+--add-label/.test(reviewer),
);
check('reviewer.md still returns the verdict JSON', /"verdict":\s*"approved"\s*\|\s*"rejected"/.test(reviewer));
check(
  'reviewer.md says who applies the labels now',
  /orchestrator/i.test(reviewer) && /label/i.test(reviewer),
);
check(
  'reviewer.md keeps casting a real GitHub review under AGENTIC_REVIEWER_TOKEN',
  /AGENTIC_REVIEWER_TOKEN/.test(reviewer) && /gh pr review/.test(reviewer),
);

// --- #265: the card carries the three costs the 2026-09-10/11 pass paid more than once
// (docs/dogfood/2026-09-10.md, findings L5, L6 and L22). Each case reads the one section
// that owns the sentence, sliced from its `##` heading to the next one — never to the end
// of the file, which would let a sentence anywhere else in the card satisfy the assertion.

/** The card's section starting at `heading`, bounded by the next `## ` heading. */
function section(heading: string): string {
  const start = card.indexOf(heading);
  if (start === -1) return '';
  const next = card.indexOf('\n## ', start + heading.length);
  return next === -1 ? card.slice(start) : card.slice(start, next);
}

const reconcileStep = section('## 0. Reconcile from GitHub');
const decide = section('## 5. Decide');
// These two pin the bound itself: the slice starts at its own `## ` heading and stops
// before the next one, so no sentence from a later step can satisfy a case below. A
// length comparison would not catch a widened slice — a slice running to the end of the
// file is still shorter than the card — so each case names the heading that must not
// appear in it. A missing heading returns '' and fails `startsWith` here as well as every
// content case below.
check(
  'SKILL.md step 0 stops before the next `## ` heading — `## 1. Candidates` is not in the slice',
  reconcileStep.startsWith('## 0. Reconcile from GitHub') &&
    !reconcileStep.includes('\n## ') &&
    !reconcileStep.includes('## 1. Candidates'),
  reconcileStep.slice(-300),
);
check(
  'SKILL.md step 5 stops before the next `## ` heading — `## 6. Close the milestone` is not in the slice',
  decide.startsWith('## 5. Decide') &&
    !decide.includes('\n## ') &&
    !decide.includes('## 6. Close the milestone'),
  decide.slice(-300),
);

// AC1 (L5): a label edit re-triggers agentic-checks, so the labels go on before the push
// that starts the round, not after it.
check(
  'SKILL.md step 5 says a label edit re-triggers agentic-checks',
  /agentic-checks/.test(decide) && /(re-?triggers?|cancels?)/i.test(decide),
  decide.slice(0, 600),
);
check(
  'SKILL.md step 5 applies the labels before the push that starts the round, not after it',
  /before the push/i.test(decide) && /not after it/i.test(decide),
  decide.slice(0, 600),
);

// AC2 (L6): a listing taken right after a write may lag, and the step re-reads once
// before acting on an empty or stale result.
check(
  'SKILL.md step 0 says a listing taken right after a write may lag',
  /listing[^.]*(right|immediately) after[^.]*write[^.]*lag/is.test(reconcileStep),
  reconcileStep.slice(0, 600),
);
check(
  'SKILL.md step 0 re-reads once before acting on an empty or stale result',
  /re-reads?[^.]*once/i.test(reconcileStep) && /empty or stale/i.test(reconcileStep),
  reconcileStep.slice(0, 600),
);

// AC3 (L22): the post-merge step names the exact command, and the condition under which a
// `--ff-only` pull refuses — more than one merge head. Reproduced on git 2.50.1 against a
// bare origin with two branches: `git pull --ff-only origin main other` and a bare
// `git pull --ff-only` whose `branch.main.merge` held two refs both exit 128 with
// `Cannot fast-forward to multiple branches`, while `git pull -q --ff-only origin main`
// exits 0 and fast-forwards with or without a preceding fetch.
check(
  'SKILL.md step 5 names the exact post-merge pull command',
  decide.includes('git fetch origin && git pull --ff-only origin main'),
  decide.slice(0, 600),
);
check(
  'SKILL.md step 5 says when a --ff-only pull refuses, with the message git prints',
  /Cannot fast-forward to multiple branches/.test(decide) && /more than one branch/i.test(decide),
  decide.slice(0, 600),
);
check(
  'SKILL.md step 5 names more than one merge head as the trigger, not a checkout tracking more than one branch',
  /merge head/i.test(decide) && !/checkout that tracks more than one branch/i.test(decide),
  decide.slice(0, 600),
);

finish();
