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

finish();
