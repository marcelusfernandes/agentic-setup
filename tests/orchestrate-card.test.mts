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

// AC5: the label transitions live in the orchestrator's own step, not the reviewer's.
const decideStep = card.slice(card.indexOf('## 5. Decide'));
check('SKILL.md step 5 exists', decideStep.length > 0 && decideStep.length < card.length);
check('SKILL.md step 5 states the approved label transition', /review:approved/.test(decideStep) && /state:qa-failed/.test(decideStep));
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
